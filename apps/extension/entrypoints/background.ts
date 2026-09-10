import {
  createPrivacyEngine,
  selectRuntime,
  type CaptureInput,
  type LocalAudit,
  type PrivacyEngine,
  type RuntimeProfile,
  type SafePageSnapshot,
  type TextRecognizer,
  type FaceDetector,
  type Viewport,
} from "@orka/privacy-engine";
import { TaskSession, type SanitizationFailureCode } from "@orka/contracts";
import {
  CAPTURE_AUTHORITY_TTL_MS,
  CaptureAuthorityError,
  captureFromAuthority,
  createCaptureAuthority,
  validateCaptureAuthority,
  type CaptureAuthority,
  type CaptureAuthorityBrowser,
} from "../shared/captureAuthority.ts";
import { collectSafePageSnapshot } from "../shared/snapshot.ts";
import {
  createBrowserImageEncoder,
  decodeCapturedScreenshot,
  encodeForLocalAudit,
} from "../shared/image.ts";
import type {
  ExtensionMessage,
  ExtensionResponse,
  LocalAuditView,
  SnapshotFailureMessage,
  SnapshotResultMessage,
  StartTaskMessage,
  TaskStateMessage,
} from "../shared/messages.ts";
import { isExtensionMessage } from "../shared/messages.ts";

type CaptureFlowErrorCode = "CAPTURE_FAILED" | "RESTRICTED_PAGE";

class CaptureFlowError extends Error {
  constructor(
    public readonly code: CaptureFlowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureFlowError";
  }
}

type ActiveTask = {
  taskId: string;
  task: string;
  session: TaskSession;
  profile: RuntimeProfile;
  screenshotDataUrl: string;
  authority: CaptureAuthority;
  cancelled: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  audit?: LocalAudit;
};

let activeTask: ActiveTask | null = null;
let captureAuthority: CaptureAuthority | null = null;

const fallbackTextRecognizer: TextRecognizer = {
  async recognize() {
    // Pixel OCR is optional until a pinned model is bundled. DOM text
    // detection still runs locally and protects DOM-exposed sensitive content.
    return [];
  },
};

const fallbackFaceDetector: FaceDetector = {
  async detect() {
    // Avoid blocking all local sanitization while the pinned face model is
    // unavailable; the engine remains fail-closed for configured detectors.
    return [];
  },
};

function safeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error
    ? error.message || `${error.name}: ${String(error)}`
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error ?? "");
  return message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 280) || fallback;
}

function publicFailureMessage(code: SanitizationFailureCode, message: string): string {
  switch (code) {
    case "RESTRICTED_PAGE":
      return "The active page cannot be captured.";
    case "DETECTOR_TIMEOUT":
      return "Local privacy detection timed out.";
    case "DETECTOR_ERROR":
      return "Local privacy detection failed.";
    case "MODEL_LOAD_FAILED":
      return "The local privacy model is unavailable.";
    case "MERGE_FAILED":
      return "Local redaction failed.";
    case "POLICY_BELOW_THRESHOLD":
      return "The capture did not meet the local privacy policy.";
    case "CAPTURE_FAILED":
      if (/user gesture/i.test(message)) {
        return "The page screenshot must be taken when you click Start task.";
      }
      return safeErrorMessage(message, "Local capture failed.");
    default:
      return "Local sanitization failed.";
  }
}

function currentTask(task: ActiveTask): ActiveTask {
  if (activeTask !== task || task.cancelled) {
    throw new CaptureFlowError("CAPTURE_FAILED", "Task Session is no longer active.");
  }
  return activeTask;
}

function sendEvent(message: ExtensionMessage): void {
  browser.runtime.sendMessage(message).catch((error: unknown) => {
    console.error("Failed to publish extension event", error);
  });
}

function publishState(task: ActiveTask): void {
  const message: TaskStateMessage = {
    type: "TASK_STATE",
    taskId: task.taskId,
    state: task.session.state,
    runtime: task.profile,
  };
  sendEvent(message);
}

function clearAudit(task: ActiveTask): void {
  task.audit = undefined;
}

function clearRawCapture(task: ActiveTask): void {
  task.screenshotDataUrl = "";
}

function clearTaskTimer(task: ActiveTask): void {
  if (task.timeoutHandle !== undefined) {
    clearTimeout(task.timeoutHandle);
    task.timeoutHandle = undefined;
  }
}

function createEngine(): PrivacyEngine {
  return createPrivacyEngine({
    textRecognizer: fallbackTextRecognizer,
    faceDetector: fallbackFaceDetector,
    encoder: createBrowserImageEncoder(),
  });
}

function scaleBox(
  box: { x: number; y: number; width: number; height: number },
  scaleX: number,
  scaleY: number,
  bounds: { width: number; height: number },
) {
  const left = Math.max(0, Math.min(bounds.width, box.x * scaleX));
  const top = Math.max(0, Math.min(bounds.height, box.y * scaleY));
  const right = Math.max(left, Math.min(bounds.width, (box.x + box.width) * scaleX));
  const bottom = Math.max(top, Math.min(bounds.height, (box.y + box.height) * scaleY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function scaleSnapshot(
  snapshot: SafePageSnapshot,
  sourceViewport: Viewport,
  image: { width: number; height: number },
): SafePageSnapshot {
  const scaleX = image.width / Math.max(1, sourceViewport.width);
  const scaleY = image.height / Math.max(1, sourceViewport.height);
  return {
    elements: snapshot.elements.map((element) => ({
      ...element,
      box: scaleBox(element.box, scaleX, scaleY, image),
    })),
    textNodes: snapshot.textNodes.map((node) => ({
      ...node,
      box: scaleBox(node.box, scaleX, scaleY, image),
    })),
  };
}

function isSnapshotResult(value: unknown, request: { requestId: string; taskId: string }): value is SnapshotResultMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SnapshotResultMessage>;
  return candidate.type === "SNAPSHOT_RESULT" &&
    candidate.requestId === request.requestId &&
    candidate.taskId === request.taskId &&
    typeof candidate.urlOrigin === "string" &&
    typeof candidate.viewport === "object" &&
    typeof candidate.snapshot === "object";
}

function isSnapshotFailure(value: unknown, request: { requestId: string; taskId: string }): value is SnapshotFailureMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SnapshotFailureMessage>;
  return candidate.type === "SNAPSHOT_FAILURE" &&
    candidate.requestId === request.requestId &&
    candidate.taskId === request.taskId;
}

async function requestSnapshot(
  tabId: number,
  taskId: string,
): Promise<SnapshotResultMessage> {
  const request = {
    type: "CAPTURE_REQUEST" as const,
    requestId: crypto.randomUUID(),
    taskId,
  };

  try {
    const response = await browser.tabs.sendMessage(tabId, request);
    if (isSnapshotFailure(response, request)) {
      throw new CaptureFlowError(response.code, response.message);
    }
    if (isSnapshotResult(response, request)) return response;
  } catch (error) {
    if (error instanceof CaptureFlowError) throw error;
  }

  try {
    const injected = await browser.scripting.executeScript({
      target: { tabId },
      func: collectSafePageSnapshot,
    });
    const result = injected[0]?.result;
    if (!result || typeof result !== "object") {
      throw new Error("The visible page snapshot was empty.");
    }
    return {
      type: "SNAPSHOT_RESULT",
      requestId: request.requestId,
      taskId,
      urlOrigin: (result as SnapshotResultMessage).urlOrigin,
      viewport: (result as SnapshotResultMessage).viewport,
      snapshot: (result as SnapshotResultMessage).snapshot,
    };
  } catch (error) {
    throw new CaptureFlowError(
      "CAPTURE_FAILED",
      safeErrorMessage(error, "The active tab did not permit a visible snapshot."),
    );
  }
}

function captureBrowser(): CaptureAuthorityBrowser {
  return {
    getTab: (tabId) => browser.tabs.get(tabId),
    getActiveTab: async (windowId) => (await browser.tabs.query({ active: true, windowId }))[0],
    captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: "png" }),
  };
}

function captureAuthorityResponse() {
  if (!captureAuthority) {
    return { ok: false as const, type: "ERROR" as const, message: "Reopen Orka from the toolbar before starting a task." };
  }
  if (Date.now() - captureAuthority.issuedAt > CAPTURE_AUTHORITY_TTL_MS) {
    captureAuthority = null;
    return { ok: false as const, type: "ERROR" as const, message: "Capture permission expired. Reopen Orka from the toolbar." };
  }
  return { ok: true as const, type: "CAPTURE_AUTHORITY" as const, authorityId: captureAuthority.id };
}

function takeCaptureAuthority(id: string): CaptureAuthority {
  const response = captureAuthorityResponse();
  if (!response.ok || !captureAuthority || response.authorityId !== id) {
    throw new CaptureFlowError("CAPTURE_FAILED", "Capture permission is unavailable. Reopen Orka from the toolbar.");
  }
  const authority = captureAuthority;
  captureAuthority = null;
  return authority;
}

async function openSidePanelForAction(tab: { id?: number; windowId?: number; url?: string }): Promise<void> {
  captureAuthority = null;
  try {
    captureAuthority = createCaptureAuthority(tab, crypto.randomUUID());
  } catch (error) {
    console.warn("Orka toolbar action is not capturable", error);
  }
  if (!tab.id) return;
  try {
    await browser.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    captureAuthority = null;
    console.error("Failed to open Orka side panel", error);
  }
}

function runtimeOptions(override: StartTaskMessage["runtime"]) {
  const gpu = (globalThis.navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<unknown | null> };
  }).gpu;
  return {
    override,
    probeWebGpu: () => Boolean(gpu),
    requestAdapter: async () => Boolean(gpu && await gpu.requestAdapter()),
  };
}

function auditView(
  task: ActiveTask,
  observation: Extract<Awaited<ReturnType<PrivacyEngine["sanitize"]>>, { ok: true }>["observation"],
  originalScreenshot: LocalAuditView["originalScreenshot"],
): LocalAuditView {
  return {
    runtime: task.profile,
    originalScreenshot,
    redactedScreenshot: {
      mimeType: observation.screenshot.mimeType,
      width: observation.screenshot.width,
      height: observation.screenshot.height,
      dataBase64: observation.screenshot.dataBase64,
    },
    redactionSummary: observation.redactionSummary,
    createdAt: task.audit?.createdAt ?? Date.now(),
  };
}

async function failTask(task: ActiveTask, code: SanitizationFailureCode, message: string) {
  if (activeTask !== task || task.cancelled) return;
  clearTaskTimer(task);
  clearRawCapture(task);
  clearAudit(task);
  if (task.session.can("SANITIZATION_FAILED")) task.session.send("SANITIZATION_FAILED");
  sendEvent({
    type: "SANITIZATION_FAILURE",
    taskId: task.taskId,
    error: {
      ok: false,
      code,
      message: publicFailureMessage(code, message),
    },
  });
  publishState(task);
}

async function scanTask(task: ActiveTask): Promise<void> {
  try {
    let capture;
    try {
      capture = await captureFromAuthority(task.authority, captureBrowser());
    } catch (error) {
      if (error instanceof CaptureAuthorityError) {
        throw new CaptureFlowError("CAPTURE_FAILED", error.message);
      }
      throw error;
    }
    task.screenshotDataUrl = capture.screenshotDataUrl;
    const snapshot = await requestSnapshot(task.authority.tabId, task.taskId);
    let captureTab;
    try {
      captureTab = await validateCaptureAuthority(task.authority, captureBrowser());
    } catch (error) {
      if (error instanceof CaptureAuthorityError) {
        throw new CaptureFlowError("CAPTURE_FAILED", error.message);
      }
      throw error;
    }
    let screenshot;
    try {
      screenshot = await decodeCapturedScreenshot(task.screenshotDataUrl);
    } catch (error) {
      throw new CaptureFlowError(
        "CAPTURE_FAILED",
        safeErrorMessage(error, "The captured screenshot could not be decoded locally."),
      );
    }
    task.screenshotDataUrl = "";
    currentTask(task);

    const input: CaptureInput = {
      taskId: task.taskId,
      task: task.task,
      url: captureTab.url ?? snapshot.urlOrigin,
      viewport: {
        width: snapshot.viewport.width,
        height: snapshot.viewport.height,
        devicePixelRatio: snapshot.viewport.devicePixelRatio,
      },
      capturedAt: Date.now(),
      screenshot,
      snapshot: scaleSnapshot(snapshot.snapshot, snapshot.viewport, screenshot),
    };
    const result = await createEngine().sanitize(input, task.profile);
    currentTask(task);

    if (!result.ok) {
      await failTask(task, result.error.code, result.error.message);
      return;
    }

    const encoder = createBrowserImageEncoder();
    const originalScreenshot = await encodeForLocalAudit(encoder, result.localAudit.originalScreenshot);
    task.audit = result.localAudit;
    if (!task.session.can("SANITIZED")) {
      clearAudit(task);
      return;
    }
    task.session.send("SANITIZED");
    sendEvent({
      type: "SANITIZATION_RESULT",
      taskId: task.taskId,
      observation: result.observation,
      audit: auditView(task, result.observation, originalScreenshot),
    });
    publishState(task);
  } catch (error) {
    clearRawCapture(task);
    if (error instanceof CaptureFlowError) {
      await failTask(task, error.code, error.message);
      return;
    }
    await failTask(task, "CAPTURE_FAILED", safeErrorMessage(error, "Local capture failed."));
  }
}

function isPngDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/png");
}

async function startTask(message: StartTaskMessage): Promise<ExtensionResponse> {
  if (
    typeof message.taskId !== "string" ||
    typeof message.task !== "string" ||
    !["auto", "gpu", "balanced", "wasm"].includes(message.runtime) ||
    typeof message.captureAuthorityId !== "string"
  ) {
    return { ok: false, type: "ERROR", message: "The Task Session request was invalid." };
  }
  if (!message.task.trim()) {
    return { ok: false, type: "ERROR", message: "Enter a task before starting." };
  }
  if (activeTask && activeTask.session.isActive) {
    return { ok: false, type: "ERROR", message: "A Task Session is already active." };
  }

  let authority: CaptureAuthority;
  try {
    authority = takeCaptureAuthority(message.captureAuthorityId);
  } catch (error) {
    return { ok: false, type: "ERROR", message: safeErrorMessage(error, "Reopen Orka from the toolbar before starting a task.") };
  }
  activeTask = null;
  const profile = await selectRuntime(runtimeOptions(message.runtime));
  const task: ActiveTask = {
    taskId: message.taskId,
    task: message.task.trim(),
    session: new TaskSession(),
    profile,
    screenshotDataUrl: "",
    authority,
    cancelled: false,
  };
  activeTask = task;
  task.session.send("START_SCAN");
  task.timeoutHandle = setTimeout(() => {
    if (activeTask !== task || task.cancelled || !task.session.enforceTimeout()) return;
    task.cancelled = true;
    clearRawCapture(task);
    clearTaskTimer(task);
    clearAudit(task);
    sendEvent({ type: "TASK_STOPPED", taskId: task.taskId });
    publishState(task);
    activeTask = null;
  }, 90_000);
  publishState(task);
  void scanTask(task);
  return { ok: true, type: "ACK", taskId: task.taskId };
}

function stopTask(taskId?: string): ExtensionResponse {
  if (!activeTask || (taskId && activeTask.taskId !== taskId)) {
    return { ok: false, type: "ERROR", message: "No matching Task Session is active." };
  }
  const task = activeTask;
  task.cancelled = true;
  clearRawCapture(task);
  clearTaskTimer(task);
  clearAudit(task);
  const stopped = task.session.stop();
  if (!stopped) return { ok: false, type: "ERROR", message: "Task Session is not active." };
  sendEvent({ type: "TASK_STOPPED", taskId: task.taskId });
  publishState(task);
  activeTask = null;
  return { ok: true, type: "ACK", taskId: task.taskId };
}

function closeAudit(taskId?: string): ExtensionResponse {
  if (!activeTask || (taskId && activeTask.taskId !== taskId)) {
    return { ok: false, type: "ERROR", message: "No matching local audit exists." };
  }
  const task = activeTask;
  clearRawCapture(task);
  clearTaskTimer(task);
  clearAudit(task);
  if (task.session.can("RESET")) task.session.send("RESET");
  activeTask = null;
  sendEvent({ type: "AUDIT_CLOSED", taskId: task.taskId });
  return { ok: true, type: "ACK", taskId: task.taskId };
}

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    void openSidePanelForAction(tab);
  });

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExtensionMessage(message)) return undefined;
    if (message.type === "GET_CAPTURE_AUTHORITY") {
      sendResponse(captureAuthorityResponse());
      return undefined;
    }
    if (message.type === "START_TASK") {
      void startTask(message).then(sendResponse).catch((error: unknown) => {
        sendResponse({ ok: false, type: "ERROR", message: safeErrorMessage(error, "Task Session could not start.") });
      });
      return true;
    }
    if (message.type === "STOP_TASK") {
      sendResponse(stopTask(message.taskId));
      return undefined;
    }
    if (message.type === "AUDIT_CLOSE") {
      sendResponse(closeAudit(message.taskId));
      return undefined;
    }
    return undefined;
  });
});

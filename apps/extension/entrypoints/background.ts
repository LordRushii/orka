import {
  selectRuntime,
  type CaptureInput,
  type LocalAudit,
  type PrivacyEngine,
  type RuntimeProfile,
  type SafePageSnapshot,
  type Viewport,
  createPixelModelManager,
  ModelLoadFailedError,
} from "@orka/privacy-engine";
import {
  SensitiveVariablesSchema,
  TaskSession,
  type ActionPlan,
  type SanitizationFailureCode,
  type SanitizedObservation,
  type SensitiveVariables,
} from "@orka/contracts";
import {
  CaptureAuthorityError,
  captureFromAuthority,
  validateCaptureAuthority,
  type CaptureAuthority,
  type CaptureAuthorityBrowser,
} from "../shared/captureAuthority.ts";
import { createCaptureAuthorityStore } from "../shared/captureAuthorityStore.ts";
import { collectSafePageSnapshot } from "../shared/snapshot.ts";
import {
  createBrowserImageEncoder,
  decodeCapturedScreenshot,
  encodeForLocalAudit,
} from "../shared/image.ts";
import type {
  ApprovePlanMessage,
  ConfirmationDecisionMessage,
  ExtensionMessage,
  ExtensionResponse,
  GatewayCheckResponse,
  LocalAuditView,
  PlannerSettingsResponse,
  SnapshotFailureMessage,
  SnapshotResultMessage,
  StartTaskMessage,
  TaskStateMessage,
} from "../shared/messages.ts";
import {
  MAX_EXECUTION_ACTIONS,
  TAB_LOAD_TIMEOUT_MS,
  TAB_SETTLE_POLL_MS,
  createActionExecutor,
  type ActionExecutor,
  type ApprovalDecision,
  type ApprovalRequest,
  type ExecutorBrowser,
} from "../shared/executor.ts";
import { browserInjectionApi, createPagePort } from "../shared/pagePort.ts";
import { isExtensionMessage } from "../shared/messages.ts";
import {
  checkGateway,
  requestPlan,
  type PlannerFailure,
  type PlannerResult,
} from "../shared/plannerClient.ts";
import {
  GatewayUrlError,
  loadPlannerSettings,
  savePlannerSettings,
  type PlannerSettings,
} from "../shared/settings.ts";
import { createPixelWorkers, type PixelWorkers } from "../shared/pixelWorkers.ts";
import { createEngine, TASK_SESSION_TIMEOUT_MS } from "../shared/engine.ts";
import { releaseTaskResources } from "../shared/taskCleanup.ts";

/** Upper bound on a manual "Check gateway" probe, so the button always settles. */
const GATEWAY_CHECK_TIMEOUT_MS = 5_000;

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

/** A step the executor is waiting on the user to answer. */
type PendingDecision = {
  actionIndex: number;
  kind: "confirm" | "ask_user";
  resolve(decision: ApprovalDecision): void;
};

type ActiveTask = {
  taskId: string;
  task: string;
  session: TaskSession;
  profile: RuntimeProfile;
  screenshotDataUrl: string;
  authority: CaptureAuthority;
  /** Origin the task started on; execution pauses if the page leaves it. */
  origin: string;
  cancelled: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  audit?: LocalAudit;
  plannerAbort?: AbortController;
  /** The approved plan and the observation every target is checked against. */
  plan?: ActionPlan;
  observation?: SanitizedObservation;
  /** Private values for this task; memory only, cleared when the run ends. */
  sensitiveValues: SensitiveVariables;
  executor?: ActionExecutor;
  executorAbort?: AbortController;
  pendingDecision?: PendingDecision;
  modelManager: ReturnType<typeof createPixelModelManager>;
  pixelWorkers: PixelWorkers;
};

let activeTask: ActiveTask | null = null;
const captureAuthorityStore = createCaptureAuthorityStore();

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
      return safeErrorMessage(message, "Local privacy detection failed.");
    case "MODEL_LOAD_FAILED":
      return safeErrorMessage(message, "The local privacy model is unavailable.");
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

/** Drops the raw capture, audit, timer, and model/worker state in one step. */
function releaseTask(task: ActiveTask): void {
  releaseTaskResources(task);
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

/* -------------------------------------------------------------------------- *
 * Safe action execution (Phase 4)                                            *
 * -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a tab to finish loading, or gives up without throwing. */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: { status?: string }) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, TAB_LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(listener);
  });
}

/**
 * The tab half of the executor's world. `settle` is what lets a click that
 * navigates be noticed before the next step is resolved against the page: it
 * waits for the URL to move, then for the new document to finish loading.
 */
function executorBrowser(): ExecutorBrowser {
  return {
    getTab: (tabId) => browser.tabs.get(tabId),
    getActiveTab: async (windowId) => (await browser.tabs.query({ active: true, windowId }))[0],
    updateTab: async (tabId, url) => {
      await browser.tabs.update(tabId, { url });
    },
    settle: async (tabId, beforeUrl, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let changed = false;
      while (Date.now() < deadline) {
        const tab = await browser.tabs.get(tabId).catch(() => undefined);
        if (tab?.url !== undefined && tab.url !== beforeUrl) {
          changed = true;
          break;
        }
        await delay(TAB_SETTLE_POLL_MS);
      }
      if (!changed) {
        return { url: (await browser.tabs.get(tabId).catch(() => undefined))?.url, changed: false };
      }
      await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
      return { url: (await browser.tabs.get(tabId).catch(() => undefined))?.url, changed: true };
    },
  };
}

/**
 * The user's half of the executor's world: one pending prompt at a time.
 *
 * A prompt is settled by the panel's decision, by an abort (Stop, timeout, a
 * closed tab), or by the task being replaced -- and settling it as "declined"
 * is the only safe default when the answer never arrives.
 */
function approvalPort(task: ActiveTask) {
  return (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> => {
    if (activeTask !== task || task.cancelled || signal.aborted) {
      return Promise.resolve({ approved: false });
    }
    return new Promise<ApprovalDecision>((resolve) => {
      let entry: PendingDecision | undefined;
      let settled = false;
      const finish = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (entry && task.pendingDecision === entry) task.pendingDecision = undefined;
        resolve(decision);
      };
      const onAbort = () => finish({ approved: false });
      signal.addEventListener("abort", onAbort, { once: true });
      entry = { actionIndex: request.actionIndex, kind: request.kind, resolve: finish };
      task.pendingDecision = entry;
      // An abort that raced this registration still settles it.
      if (signal.aborted) finish({ approved: false });
    });
  };
}

/**
 * Drops the execution half of a task as soon as the run ends, so a private
 * value or the approved plan outlives neither the run nor the session --
 * including on the paths where the panel is still showing the log.
 */
function clearExecutionState(task: ActiveTask): void {
  task.plan = undefined;
  task.observation = undefined;
  task.executor = undefined;
  task.executorAbort = undefined;
  task.pendingDecision = undefined;
  for (const key of Object.keys(task.sensitiveValues)) delete task.sensitiveValues[key];
}

async function failExecution(task: ActiveTask, message: string): Promise<void> {
  if (activeTask !== task) return;
  clearExecutionState(task);
  releaseTask(task);
  if (task.session.can("EXECUTION_FAILED")) task.session.send("EXECUTION_FAILED");
  else task.session.stop();
  sendEvent({
    type: "EXECUTION_FINISHED",
    taskId: task.taskId,
    status: "failed",
    failure: { code: "UNEXPECTED_ERROR", message },
    summary: message,
  });
  publishState(task);
}

/** Runs the approved plan, then lands the Task Session in its terminal state. */
async function runExecution(task: ActiveTask): Promise<void> {
  const { plan, observation, executor, executorAbort } = task;
  if (!plan || !observation || !executor || !executorAbort) return;

  const run = await executor.execute(plan, {
    taskId: task.taskId,
    observation,
    tabId: task.authority.tabId,
    windowId: task.authority.windowId,
    origin: task.origin,
    session: task.session,
    sensitiveValues: task.sensitiveValues,
    signal: executorAbort.signal,
  });

  clearExecutionState(task);
  // A Stop, a timeout, or a replacement task already published its own ending,
  // and must not be re-published over by this run finishing.
  if (activeTask !== task || task.cancelled) return;

  if (run.status === "stopped") {
    task.cancelled = true;
    releaseTask(task);
    task.session.stop();
    sendEvent({ type: "TASK_STOPPED", taskId: task.taskId });
    publishState(task);
    activeTask = null;
    return;
  }

  // The plan ran to its end, or it failed: either way the user keeps the log,
  // and the session stays dismissable.
  releaseTask(task);
  if (run.status === "completed" && task.session.can("COMPLETE")) task.session.send("COMPLETE");
  if (run.status === "failed" && task.session.can("EXECUTION_FAILED")) {
    task.session.send("EXECUTION_FAILED");
  }
  publishState(task);
}

function approvePlan(message: ApprovePlanMessage): ExtensionResponse {
  if (!activeTask || activeTask.taskId !== message.taskId) {
    return { ok: false, type: "ERROR", message: "No matching Task Session is active." };
  }
  const task = activeTask;
  if (!task.session.can("APPROVE") || !task.plan || !task.observation) {
    return { ok: false, type: "ERROR", message: "There is no plan waiting for approval." };
  }
  // The contract caps a plan too. Re-checking here means a plan cannot reach the
  // executor by any other route with more steps than the policy allows.
  if (task.plan.actions.length > MAX_EXECUTION_ACTIONS) {
    return { ok: false, type: "ERROR", message: "That plan has more steps than Orka will run." };
  }

  task.session.send("APPROVE");
  publishState(task);
  const controller = new AbortController();
  task.executorAbort = controller;
  task.executor = createActionExecutor({
    browser: executorBrowser(),
    page: createPagePort(browserInjectionApi()),
    requestApproval: approvalPort(task),
    report: (event) => sendEvent(event),
  });
  void runExecution(task).catch((error: unknown) => {
    void failExecution(task, safeErrorMessage(error, "The approved plan could not be run."));
  });
  return { ok: true, type: "ACK", taskId: task.taskId };
}

function decideConfirmation(message: ConfirmationDecisionMessage): ExtensionResponse {
  if (!activeTask || activeTask.taskId !== message.taskId) {
    return { ok: false, type: "ERROR", message: "No matching Task Session is active." };
  }
  const pending = activeTask.pendingDecision;
  if (!pending || pending.actionIndex !== message.actionIndex) {
    return { ok: false, type: "ERROR", message: "That step is no longer waiting for you." };
  }
  activeTask.pendingDecision = undefined;
  pending.resolve({
    approved: message.approved === true,
    answer: typeof message.answer === "string" ? message.answer.slice(0, 500) : undefined,
  });
  return { ok: true, type: "ACK", taskId: activeTask.taskId };
}

function captureBrowser(): CaptureAuthorityBrowser {
  return {
    getTab: (tabId) => browser.tabs.get(tabId),
    getActiveTab: async (windowId) => (await browser.tabs.query({ active: true, windowId }))[0],
    captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: "png" }),
  };
}

function captureAuthorityResponse() {
  return captureAuthorityStore.response();
}

function takeCaptureAuthority(id: string): CaptureAuthority {
  try {
    // Reusable within its TTL: the live tab/origin/active-tab checks still run
    // on every capture, so a second task needs no toolbar reopen.
    return captureAuthorityStore.use(id);
  } catch (error) {
    if (error instanceof CaptureAuthorityError) {
      throw new CaptureFlowError("CAPTURE_FAILED", error.message);
    }
    throw error;
  }
}

async function openSidePanelForAction(tab: { id?: number; windowId?: number; url?: string }): Promise<void> {
  captureAuthorityStore.clear();
  try {
    captureAuthorityStore.mint(tab, crypto.randomUUID());
  } catch (error) {
    console.warn("Orka toolbar action is not capturable", error);
  }
  if (!tab.id) return;
  try {
    await browser.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    captureAuthorityStore.clear();
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
  releaseTask(task);
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

function failPlan(task: ActiveTask, error: PlannerFailure): void {
  // The proposal is terminal, so the local audit goes with it. The side panel
  // keeps its own copy of the audit it was already sent, so the user can still
  // inspect what was redacted before dismissing the session.
  releaseTask(task);
  task.session.send("PLAN_FAILED");
  sendEvent({
    type: "PLAN_FAILURE",
    taskId: task.taskId,
    error: { code: error.code, message: error.message },
  });
  publishState(task);
}

/**
 * The planner leg: the sanitized observation goes to the gateway and a
 * proposed plan comes back.
 *
 * Phase 3 ends at `awaiting_approval` -- the plan is shown, never executed.
 * This runs only after `scanTask` has published a successful sanitization, so
 * there is no path from a sanitization failure to a network call.
 */
async function planTask(task: ActiveTask, observation: SanitizedObservation): Promise<void> {
  if (activeTask !== task || task.cancelled || !task.session.can("START_PLANNING")) return;

  const settings = await loadPlannerSettings();
  if (activeTask !== task || task.cancelled || !task.session.can("START_PLANNING")) return;

  task.session.send("START_PLANNING");
  publishState(task);

  const controller = new AbortController();
  task.plannerAbort = controller;
  let result: PlannerResult;
  try {
    result = await requestPlan({ settings, observation, signal: controller.signal });
  } catch (error) {
    result = {
      ok: false,
      code: "INTERNAL_ERROR",
      message: safeErrorMessage(error, "The planner request failed."),
    };
  } finally {
    if (task.plannerAbort === controller) task.plannerAbort = undefined;
  }

  // A Stop, a timeout, or a replacement task can land while the request is in
  // flight. `PLAN_READY` and `PLAN_FAILED` are both only legal from
  // `planning`, so this one guard covers the success and failure paths alike:
  // a late plan for an abandoned session is dropped, never shown.
  if (activeTask !== task || task.cancelled || !task.session.can("PLAN_READY")) return;

  if (!result.ok) {
    failPlan(task, result);
    return;
  }

  // Kept for the execution leg: the plan is what runs, and the observation is
  // what every target in it is checked against before anything happens.
  task.plan = result.plan;
  task.observation = observation;
  task.session.send("PLAN_READY");
  sendEvent({
    type: "PLAN_RESULT",
    taskId: task.taskId,
    plan: result.plan,
    meta: result.meta,
  });
  publishState(task);
}

async function scanTask(task: ActiveTask): Promise<void> {  try {
    const models = await task.modelManager.initialize(task.profile);
    await task.pixelWorkers.initialize(models, task.profile);
    currentTask(task);
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
    const result = await createEngine(task.pixelWorkers).sanitize(input, task.profile);
    currentTask(task);

    if (!result.ok) {
      await failTask(task, result.error.code, result.error.message);
      return;
    }

    const encoder = createBrowserImageEncoder();
    const originalScreenshot = await encodeForLocalAudit(encoder, result.localAudit.originalScreenshot);
    task.audit = result.localAudit;
    if (!task.session.can("SANITIZED")) {
      // The session was stopped, timed out, or replaced while this scan was
      // still running: release everything rather than leaving workers and the
      // audit bitmap alive behind a task nobody can reach.
      releaseTask(task);
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
    await planTask(task, result.observation);
  } catch (error) {
    // `failTask` no-ops once the task is no longer the active one, so release
    // here first: an already-replaced task must not keep its capture, models,
    // or workers alive.
    releaseTask(task);
    if (error instanceof CaptureFlowError) {
      await failTask(task, error.code, error.message);
      return;
    }
    if (error instanceof ModelLoadFailedError) {
      await failTask(task, "MODEL_LOAD_FAILED", error.message);
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
  const privateValues = SensitiveVariablesSchema.safeParse(message.sensitiveValues ?? {});
  if (!privateValues.success) {
    return {
      ok: false,
      type: "ERROR",
      message: "Those private values are not valid. Use names like PHONE_1.",
    };
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
    origin: authority.origin,
    cancelled: false,
    sensitiveValues: { ...privateValues.data },
    modelManager: createPixelModelManager(),
    pixelWorkers: createPixelWorkers(),
  };
  activeTask = task;
  task.session.send("START_SCAN");
  task.timeoutHandle = setTimeout(() => {
    if (activeTask !== task || task.cancelled || !task.session.enforceTimeout()) return;
    task.cancelled = true;
    releaseTask(task);
    sendEvent({ type: "TASK_STOPPED", taskId: task.taskId });
    publishState(task);
    activeTask = null;
  }, TASK_SESSION_TIMEOUT_MS);
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
  releaseTask(task);
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
  task.cancelled = true;
  releaseTask(task);
  // Dismissing the audit dismisses the whole session, including a proposal
  // still awaiting approval: stop it first so RESET is reachable and no
  // in-flight plan can resurface against a session the user has closed.
  task.session.stop();
  if (task.session.can("RESET")) task.session.send("RESET");
  activeTask = null;
  sendEvent({ type: "AUDIT_CLOSED", taskId: task.taskId });
  return { ok: true, type: "ACK", taskId: task.taskId };
}

async function readPlannerSettings(): Promise<PlannerSettingsResponse> {
  return { ok: true, type: "PLANNER_SETTINGS", settings: await loadPlannerSettings() };
}

async function writePlannerSettings(settings: PlannerSettings): Promise<PlannerSettingsResponse> {
  try {
    return { ok: true, type: "PLANNER_SETTINGS", settings: await savePlannerSettings(settings) };
  } catch (error) {
    return {
      ok: false,
      type: "ERROR",
      // GatewayUrlError messages are authored here and safe to show verbatim;
      // anything else is reported generically.
      message: error instanceof GatewayUrlError
        ? error.message
        : "Those planner settings are not valid.",
    };
  }
}

async function probeGateway(): Promise<GatewayCheckResponse> {
  const settings = await loadPlannerSettings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_CHECK_TIMEOUT_MS);
  try {
    const result = await checkGateway(settings, controller.signal);
    return result.ok
      ? { ok: true, type: "GATEWAY_OK", providers: result.providers }
      : { ok: false, type: "ERROR", message: result.message };
  } finally {
    clearTimeout(timer);
  }
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
    if (message.type === "APPROVE_PLAN") {
      sendResponse(approvePlan(message));
      return undefined;
    }
    if (message.type === "CONFIRMATION_DECISION") {
      sendResponse(decideConfirmation(message));
      return undefined;
    }
    if (message.type === "STOP_TASK") {
      sendResponse(stopTask(message.taskId));
      return undefined;
    }
    if (message.type === "AUDIT_CLOSE") {
      sendResponse(closeAudit(message.taskId));
      return undefined;
    }
    if (message.type === "GET_PLANNER_SETTINGS") {
      void readPlannerSettings().then(sendResponse);
      return true;
    }
    if (message.type === "SAVE_PLANNER_SETTINGS") {
      void writePlannerSettings(message.settings).then(sendResponse);
      return true;
    }
    if (message.type === "CHECK_GATEWAY") {
      void probeGateway().then(sendResponse).catch((error: unknown) => {
        sendResponse({
          ok: false,
          type: "ERROR",
          message: safeErrorMessage(error, "The gateway check failed."),
        });
      });
      return true;
    }
    return undefined;
  });
});

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
  type Action,
  type ActionPlan,
  type PriorActionSummary,
  type SanitizationFailureCode,
  type SanitizedObservation,
  type SensitiveVariables,
  type StopReason,
} from "@orka/contracts";
import {
  CaptureAuthorityError,
  captureFromAuthority,
  urlOrigin,
  validateCaptureAuthority,
  type CaptureAuthority,
  type CaptureAuthorityBrowser,
  type CaptureAuthorityTab,
} from "../shared/captureAuthority.ts";
import { createCaptureAuthorityStore, type CaptureAuthorityResponse } from "../shared/captureAuthorityStore.ts";
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
  type ExecutionContext,
  type ExecutorBrowser,
  type StepRun,
} from "../shared/executor.ts";
import { browserInjectionApi, createPagePort } from "../shared/pagePort.ts";
import { isExtensionMessage } from "../shared/messages.ts";
import {
  checkGateway,
  requestPlan,
  type PlannerFailure,
  type PlannerResult,
} from "../shared/plannerClient.ts";
import { NO_OUTBOUND_REQUEST } from "../shared/outboundView.ts";
import { safeErrorName } from "../shared/logging.ts";
import {
  GatewayUrlError,
  loadPlannerSettings,
  savePlannerSettings,
  type PlannerSettings,
} from "../shared/settings.ts";
import { createPixelWorkers, type PixelWorkers } from "../shared/pixelWorkers.ts";
import { createEngine } from "../shared/engine.ts";
import { releaseTaskResources } from "../shared/taskCleanup.ts";
import {
  runTaskLoop,
  type TaskLoopEvent,
  type TaskLoopPorts,
  type TaskLoopRun,
} from "../shared/taskLoop.ts";
import { taskRequiresVision } from "../shared/visionPolicy.ts";
import { describeModelVersions, summarizeConfidenceBands } from "../shared/localReport.ts";
import {
  createMetricsRecorder,
  sampleExtensionMemory,
  type MetricsRecorder,
  type TaskOutcome,
} from "../shared/metrics.ts";

/** Upper bound on a manual "Check gateway" probe, so the button always settles. */
const GATEWAY_CHECK_TIMEOUT_MS = 5_000;

/**
 * How often the per-round watchdog re-checks the session's active-work clock.
 * A round's budget is machine time, and only `enforceRoundTimeout` can tell
 * machine time from time the user spent deciding, so the check has to visit the
 * session rather than rely on a single wall-clock timer.
 */
const ROUND_WATCHDOG_TICK_MS = 1_000;

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
  /** What the user asked for; also the CaptureInput payload the planner sees. */
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
  /**
   * The round's approved step and the observation every target in it is checked
   * against. Replaced each round: a later round's plan is validated against the
   * page as it looks *now*, never against the page an earlier round saw.
   */
  plan?: ActionPlan;
  observation?: SanitizedObservation;
  /**
   * What already happened, in order -- the loop's cross-round memory. Each
   * round's capture folds this into `CaptureInput.priorActions`, so the planner
   * sees what it already tried instead of re-proposing it (Phase 6).
   */
  priorActions: PriorActionSummary[];
  /**
   * Keys of the fields a `type`/`select` step has already filled successfully.
   * The planner never sees the text it typed (values stay on the device), so a
   * page looks unchanged after a fill and a stubborn model re-proposes filling
   * the same field round after round. This lets `planRound` notice that repeat
   * and finish cleanly instead. Memory only, gone when the run ends.
   */
  settledTargets: Set<string>;
  /** Private values for this task; memory only, cleared when the run ends. */
  sensitiveValues: SensitiveVariables;
  executor?: ActionExecutor;
  executorAbort?: AbortController;
  pendingDecision?: PendingDecision;
  /** How the user's round-by-round approval resolves (one pending at a time). */
  pendingRound?: { resolve(decision: ApprovalDecision): void };
  /** Whether the session-level EXECUTION_STARTED has already been published. */
  runStarted?: boolean;
  /** Whether a terminal event for this task has already been published. */
  settled?: boolean;
  /** Local timings for this session; aggregated numbers only (see metrics.ts). */
  metrics: MetricsRecorder;
  /**
   * The execution provider the pixel workers actually bound (Fix 3). Read once
   * after init and echoed into the audit view, so a silent WASM fallback on a
   * machine the user asked to prefer WebGPU is visible instead of claimed.
   */
  boundProvider?: "webgpu" | "wasm";
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
    // The failure's name only: the event itself is what could carry page data
    // or a private value, and this line can end up in a screen recording.
    console.error("Failed to publish extension event:", safeErrorName(error));
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

/**
 * Publishes this session's aggregated timings. Called at each point the run
 * reaches a state worth reporting, so the panel's numbers are the numbers this
 * run actually produced -- never a projection or a placeholder.
 *
 * The resource sample is taken here rather than at start, because the figure
 * worth showing is what the extension was holding once it had done the work.
 */
function publishMetrics(task: ActiveTask, outcome: TaskOutcome): void {
  task.metrics.setResourceSample(sampleExtensionMemory());
  sendEvent({
    type: "METRICS_REPORT",
    taskId: task.taskId,
    metrics: task.metrics.report(outcome),
  });
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
  if (activeTask !== task || task.cancelled || task.settled) return;
  task.settled = true;
  clearExecutionState(task);
  releaseTask(task);
  publishMetrics(task, "failed");
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

/**
 * The loop's `requestApproval` port: one round's step, pending the user.
 *
 * The plan is already with the panel (`PLAN_RESULT`); this waits for the
 * `APPROVE_PLAN` message and settles as "declined" on Stop, the per-round
 * watchdog, or a replacement task -- the only safe default when no answer
 * arrives.
 */
function roundApprovalPort(task: ActiveTask): Promise<ApprovalDecision> {
  if (activeTask !== task || task.cancelled || !task.session.can("APPROVE")) {
    return Promise.resolve({ approved: false });
  }
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    const finish = (decision: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      if (task.pendingRound?.resolve === finish) task.pendingRound = undefined;
      resolve(decision);
    };
    task.pendingRound = { resolve: finish };
  });
}

/**
 * A stable key for the field a `type`/`select` step fills, or null for actions
 * that are legitimately repeatable (a `click` on "Next", a `scroll`). Prefers
 * the element's `evidenceId`, which names one live element; without it, role +
 * accessible name is enough to catch a redraft of the same field. It never
 * carries the typed value -- only which field was touched.
 */
function settledTargetKey(action: Action): string | null {
  if (action.type !== "type" && action.type !== "select") return null;
  const { role, accessibleName, evidenceId } = action.target;
  return evidenceId ? `id:${evidenceId}` : `rn:${role}\u0000${accessibleName}`;
}

/**
 * The loop's `executeStep` port: exactly one approved step, through the same
 * executor as before. Every per-action policy -- live-DOM re-resolution, the
 * confirmation port, origin and active-tab checks, the per-round budget -- is
 * inside that call, unchanged; only the outer plan array is gone.
 */
async function executeRoundStep(task: ActiveTask, action: Action): Promise<StepRun> {
  const observation = task.observation;
  const abort = task.executorAbort;
  if (!observation || !abort || task.cancelled) {
    return {
      status: "failed",
      needsReplan: false,
      failure: { code: "UNEXPECTED_ERROR", message: "The approved step is no longer available." },
      summary: "The approved step is no longer available.",
    };
  }

  const executor = (task.executor ??= createActionExecutor({
    browser: executorBrowser(),
    page: createPagePort(browserInjectionApi()),
    requestApproval: approvalPort(task),
    report: (event) => {
      // How long each step took, into the same local aggregate as the rest of
      // the session's timings. Numbers only: an outcome carries no value.
      if (event.type === "ACTION_OUTCOME" && event.durationMs !== undefined) {
        task.metrics.record("action", event.durationMs);
      }
      // The executor frames each step with EXECUTION_STARTED/FINISHED. In a
      // multi-round session those are per-*step* events, and forwarding every
      // one would read to the panel as the whole task starting and ending each
      // round -- clearing the run log and dropping private values a later round
      // still needs. One session-level start is kept, and `finishTask`
      // publishes the single session-level finish.
      if (event.type === "EXECUTION_STARTED") {
        if (task.runStarted) return;
        task.runStarted = true;
      }
      if (event.type === "EXECUTION_FINISHED") return;
      sendEvent(event);
    },
  }));

  const context: ExecutionContext = {
    taskId: task.taskId,
    observation,
    tabId: task.authority.tabId,
    windowId: task.authority.windowId,
    origin: task.origin,
    session: task.session,
    sensitiveValues: task.sensitiveValues,
    signal: abort.signal,
  };
  const run = await executor.executeStep(action, context);

  // An approved step may have crossed origins: the executor made the user
  // confirm that move before it continued, so the page they agreed to is the
  // page the next round may capture. Without this, round 2 would fail the
  // capture-authority origin check against a move the user already approved.
  if (run.status === "completed") {
    const landed = urlOrigin(
      (await browser.tabs.get(task.authority.tabId).catch(() => undefined))?.url,
    );
    if (landed && landed !== task.origin) {
      task.origin = landed;
      task.authority = { ...task.authority, origin: landed };
    }
  }

  // Remember which field a fill actually settled. The planner never sees the
  // text we typed (values stay on the device), so a filled field looks empty
  // to it and a stubborn model re-proposes the same fill round after round;
  // `planRound` reads this set to rewrite that repeat into a clean `done`.
  const settledKey = settledTargetKey(action);
  if (settledKey && run.status === "completed" && run.outcome?.status === "success") {
    task.settledTargets.add(settledKey);
  }
  return run;
}

/**
 * The loop's `report` port. It carries round boundaries only: each step's own
 * detail already reaches the panel as an `ACTION_OUTCOME`, so there is no
 * second, divergent copy of the run log.
 */
function reportLoopEvent(task: ActiveTask, event: TaskLoopEvent): void {
  if (activeTask !== task || task.cancelled) return;
  sendEvent({
    type: "ROUND_PROGRESS",
    taskId: task.taskId,
    round: event.round,
    phase: event.type === "ROUND_STARTED" ? "started" : "step",
    ...(event.type === "STEP_EXECUTED" ? { action: event.action, summary: event.summary } : {}),
  });
}

/**
 * Replaces the single whole-session timeout with a *per-round* guard.
 *
 * The session already owns the precise clock: `enforceRoundTimeout` stops a
 * round once its active machine time exceeds the budget, and time spent
 * waiting for the user is not machine time. A wall-clock timer cannot make
 * that distinction, so this re-arms itself and asks the session each tick.
 */
function armRoundWatchdog(task: ActiveTask): void {
  task.timeoutHandle = setTimeout(() => {
    if (activeTask !== task || task.cancelled || task.settled) return;
    if (task.session.enforceRoundTimeout()) {
      task.cancelled = true;
      task.settled = true;
      task.pendingRound?.resolve({ approved: false });
      task.pendingRound = undefined;
      releaseTask(task);
      publishMetrics(task, "stopped");
      sendEvent({ type: "TASK_STOPPED", taskId: task.taskId });
      publishState(task);
      activeTask = null;
      return;
    }
    armRoundWatchdog(task);
  }, ROUND_WATCHDOG_TICK_MS);
}

/**
 * Drives the whole Task Session: the module that owns the loop (taskLoop.ts)
 * decides *what happens next*, and everything browser-, planner-, or
 * user-shaped is a port here.
 */
async function runTask(task: ActiveTask): Promise<void> {
  try {
    // Once per session, not once per round: the models and their workers are
    // the expensive part of a scan, and a round is a capture, not a new
    // session (docs2/02-pii-engine-speed.md Fix 4).
    const models = await task.modelManager.initialize(task.profile);
    await task.pixelWorkers.initialize(models, task.profile);
    task.boundProvider = task.pixelWorkers.boundExecutionProvider();
    currentTask(task);
  } catch (error) {
    releaseTask(task);
    if (error instanceof ModelLoadFailedError) {
      await failTask(task, "MODEL_LOAD_FAILED", error.message);
      return;
    }
    await failTask(task, "CAPTURE_FAILED", safeErrorMessage(error, "Local capture failed."));
    return;
  }

  task.executorAbort = new AbortController();
  armRoundWatchdog(task);

  let run: TaskLoopRun;
  try {
    run = await runTaskLoop(
      { session: task.session },
      {
        scan: (priorActions, visionRequired) => scanRound(task, priorActions, visionRequired),
        plan: (observation) => planRound(task, observation),
        requestApproval: () => roundApprovalPort(task),
        executeStep: (action) => executeRoundStep(task, action),
        report: (event) => reportLoopEvent(task, event),
      } satisfies TaskLoopPorts,
      // A request to look at or explain the page is settled before the first
      // capture; the loop turns vision on later for a step that needs it.
      { visionRequired: taskRequiresVision(task.task) },
    );
  } catch (error) {
    await failExecution(task, safeErrorMessage(error, "The task could not be completed."));
    return;
  }

  finishTask(task, run);
}

/** Maps the loop's own stop reasons onto the contract's. */
function loopStopReason(reason: TaskLoopRun["stopReason"]): StopReason {
  switch (reason) {
    case "timeout":
      return "timeout";
    case "denied":
      return "denied";
    case "round_cap":
      // Running out of rounds is the session's own policy ceiling.
      return "policy";
    default:
      return "user";
  }
}

/**
 * Lands the session in its terminal state once the loop is done.
 *
 * Stop, the per-round watchdog, and a scan/plan failure each publish their own
 * ending from their own path -- the `cancelled`/`settled`/terminal guards keep
 * this from writing a second one over them.
 */
function finishTask(task: ActiveTask, run: TaskLoopRun): void {
  if (activeTask !== task || task.cancelled || task.settled) return;
  if (task.session.isTerminal) return;
  task.settled = true;

  clearExecutionState(task);
  releaseTask(task);
  publishMetrics(task, run.status);

  if (run.status === "completed") {
    if (task.session.can("COMPLETE")) task.session.send("COMPLETE");
    sendEvent({
      type: "EXECUTION_FINISHED",
      taskId: task.taskId,
      status: "completed",
      summary: run.summary,
    });
    publishState(task);
    return;
  }

  if (run.status === "failed") {
    if (task.session.can("EXECUTION_FAILED")) task.session.send("EXECUTION_FAILED");
    sendEvent({
      type: "EXECUTION_FINISHED",
      taskId: task.taskId,
      status: "failed",
      failure: { code: "UNEXPECTED_ERROR", message: run.summary },
      summary: run.summary,
    });
    publishState(task);
    return;
  }

  // A denial, the round cap, or a stop the executor reported: the session ends
  // and the user keeps the run log.
  task.cancelled = true;
  task.session.stop();
  sendEvent({
    type: "EXECUTION_FINISHED",
    taskId: task.taskId,
    status: "stopped",
    ...(run.stopReason ? { stopReason: loopStopReason(run.stopReason) } : {}),
    summary: run.summary,
  });
  sendEvent({ type: "TASK_STOPPED", taskId: task.taskId });
  publishState(task);
  activeTask = null;
}

/**
 * The user approved the round's proposed step. This resolves the loop's
 * pending approval; the loop then runs the step and re-plans against the page
 * as it looks afterwards.
 */
function approvePlan(message: ApprovePlanMessage): ExtensionResponse {
  if (!activeTask || activeTask.taskId !== message.taskId) {
    return { ok: false, type: "ERROR", message: "No matching Task Session is active." };
  }
  const task = activeTask;
  const pending = task.pendingRound;
  if (!pending || !task.session.can("APPROVE")) {
    return { ok: false, type: "ERROR", message: "There is no step waiting for approval." };
  }
  // The contract caps a plan too. Re-checking here means a step cannot reach the
  // executor by any other route with more actions than the policy allows.
  if (task.plan && task.plan.actions.length > MAX_EXECUTION_ACTIONS) {
    return { ok: false, type: "ERROR", message: "That step asks for more than Orka will run." };
  }

  task.session.send("APPROVE");
  publishState(task);
  pending.resolve({ approved: true });
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

/**
 * Mints a fresh capture authority against the active tab of `windowId`. The
 * background resolves the tab itself rather than trusting a panel-supplied id,
 * so the panel can start a task on the current page without a toolbar reopen
 * while the "one tab, chosen here" invariant still holds. A non-web active tab
 * (chrome://, the Web Store, a PDF viewer) fails to mint and returns the reason.
 */
async function mintCaptureAuthorityForWindow(windowId: number): Promise<CaptureAuthorityResponse> {
  captureAuthorityStore.clear();
  let tab: CaptureAuthorityTab | undefined;
  try {
    tab = await captureBrowser().getActiveTab(windowId);
  } catch (error) {
    console.warn("Orka could not read the active tab:", safeErrorName(error));
  }
  if (!tab) {
    return { ok: false, type: "ERROR", message: "Open a normal web page in this tab, then start the task." };
  }
  try {
    captureAuthorityStore.mint(tab, crypto.randomUUID());
  } catch (error) {
    if (error instanceof CaptureAuthorityError) {
      // The one reason this mint path fails is a tab whose URL has no http(s)
      // origin -- a chrome:// page, the Web Store, a file://, the PDF viewer.
      // Tag it so the panel can offer to open a real page here instead of
      // showing a dead-end error.
      return { ok: false, type: "ERROR", message: error.message, code: "NON_WEB_PAGE" };
    }
    throw error;
  }
  return captureAuthorityStore.response();
}

/** How long to wait for a rescue navigation to finish loading before giving up. */
const NAVIGATE_LOAD_TIMEOUT_MS = 15_000;

/**
 * The rescue path for a non-web tab: navigate the window's active tab to a
 * user-typed web page, wait for it to load, then mint against the page it
 * landed on. Chrome's own pages stay unreachable (no extension can script
 * them); this only helps when the user gives a real URL to open in their place.
 */
async function navigateActiveTabAndMint(
  windowId: number,
  rawUrl: string,
): Promise<CaptureAuthorityResponse> {
  const url = normalizeNavigableUrl(rawUrl);
  if (!url) {
    return { ok: false, type: "ERROR", message: "Enter a full web address, like https://example.com." };
  }
  captureAuthorityStore.clear();

  let tab: CaptureAuthorityTab | undefined;
  try {
    tab = await captureBrowser().getActiveTab(windowId);
  } catch (error) {
    console.warn("Orka could not read the active tab:", safeErrorName(error));
  }
  if (typeof tab?.id !== "number") {
    return { ok: false, type: "ERROR", message: "Open a normal browser window, then try again." };
  }
  const tabId = tab.id;

  try {
    await browser.tabs.update(tabId, { url });
  } catch (error) {
    console.warn("Orka could not navigate the active tab:", safeErrorName(error));
    return { ok: false, type: "ERROR", message: "That page could not be opened. Check the address and try again." };
  }

  const loaded = await waitForTabLoad(tabId, url);
  if (!loaded) {
    return { ok: false, type: "ERROR", message: "The page did not finish loading. Try again once it settles." };
  }

  try {
    captureAuthorityStore.mint(loaded, crypto.randomUUID());
  } catch (error) {
    if (error instanceof CaptureAuthorityError) {
      return { ok: false, type: "ERROR", message: error.message, code: "NON_WEB_PAGE" };
    }
    throw error;
  }
  return captureAuthorityStore.response();
}

/**
 * Accepts a user-typed address and returns its canonical http(s) form, or null
 * for anything that is not a web URL. A bare `example.com` is treated as https.
 */
function normalizeNavigableUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!urlOrigin(candidate)) return undefined;
  try {
    return new URL(candidate).toString();
  } catch {
    return undefined;
  }
}

/**
 * Polls the tab until it reports a completed load at an http(s) URL, or the
 * timeout elapses. Returns the loaded tab, or undefined on timeout. Polling
 * (rather than an `onUpdated` listener) keeps this self-contained in the
 * service worker and needs no extra listener teardown.
 */
async function waitForTabLoad(
  tabId: number,
  expectedUrl: string,
): Promise<CaptureAuthorityTab | undefined> {
  const deadline = Date.now() + NAVIGATE_LOAD_TIMEOUT_MS;
  const expectedOrigin = urlOrigin(expectedUrl);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    let tab: CaptureAuthorityTab & { status?: string };
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return undefined;
    }
    if (tab.status === "complete" && urlOrigin(tab.url) === expectedOrigin) {
      return tab;
    }
  }
  return undefined;
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
    console.warn("Orka toolbar action is not capturable:", safeErrorName(error));
  }
  if (!tab.id) return;
  try {
    await browser.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    captureAuthorityStore.clear();
    console.error("Failed to open Orka side panel:", safeErrorName(error));
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
  // A snapshot-only round has no pixels on either side of the pair; the panel
  // says so instead of rendering an empty image.
  return {
    runtime: task.profile,
    confidenceBands: summarizeConfidenceBands(task.audit?.detections ?? []),
    models: describeModelVersions(),
    ...(task.audit?.timings ? { timings: task.audit.timings } : {}),
    ...(task.boundProvider ? { boundExecutionProvider: task.boundProvider } : {}),
    ...(originalScreenshot ? { originalScreenshot } : {}),
    ...(observation.screenshot
      ? {
          redactedScreenshot: {
            mimeType: observation.screenshot.mimeType,
            width: observation.screenshot.width,
            height: observation.screenshot.height,
            dataBase64: observation.screenshot.dataBase64,
          },
        }
      : {}),
    redactionSummary: observation.redactionSummary,
    createdAt: task.audit?.createdAt ?? Date.now(),
  };
}

async function failTask(task: ActiveTask, code: SanitizationFailureCode, message: string) {
  if (activeTask !== task || task.cancelled || task.settled) return;
  task.settled = true;
  releaseTask(task);
  // A fail-closed scan still has timings worth showing: "it gave up after 2.1
  // seconds" is information, and `measure` recorded it on the failing path.
  publishMetrics(task, "failed");
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
  task.settled = true;
  releaseTask(task);
  task.session.send("PLAN_FAILED");
  sendEvent({
    type: "PLAN_FAILURE",
    taskId: task.taskId,
    error: { code: error.code, message: error.message },
    outbound: error.outbound,
  });
  publishMetrics(task, "failed");
  publishState(task);
}

/**
 * The loop's `plan` port: one round's observation goes to the gateway, and the
 * single step to propose comes back.
 *
 * Phase 6 plans *one step per round*, so this proposes exactly the first (and,
 * under the prompt's one-action rule, only) action and publishes a single-step
 * plan -- what the panel shows is what the round will run. It runs only after
 * `scanRound` has published a successful sanitization, so there is no path from
 * a sanitization failure to a network call.
 */
async function planRound(task: ActiveTask, observation: SanitizedObservation): Promise<Action> {
  const gone = (): boolean =>
    activeTask !== task || task.cancelled || !task.session.can("START_PLANNING");
  if (gone()) throw new CaptureFlowError("CAPTURE_FAILED", "Task Session is no longer active.");

  const settings = await loadPlannerSettings();
  if (gone()) throw new CaptureFlowError("CAPTURE_FAILED", "Task Session is no longer active.");

  task.session.send("START_PLANNING");
  publishState(task);

  const controller = new AbortController();
  task.plannerAbort = controller;
  // The opt-in rides to the gateway as a boolean on the observation, nothing
  // more: it changes which system prompt the adapter builds, never any content.
  // When off, the observation is sent unchanged so the wire shape is identical
  // to every prior phase.
  const outgoing = settings.allowDraftingMessages
    ? { ...observation, allowDraftingMessages: true }
    : observation;
  let result: PlannerResult;
  try {
    result = await task.metrics.measure("gateway", () =>
      requestPlan({ settings, observation: outgoing, signal: controller.signal }),
    );
  } catch (error) {
    result = {
      ok: false,
      code: "INTERNAL_ERROR",
      message: safeErrorMessage(error, "The planner request failed."),
      // An unexpected throw before the body existed: nothing was described
      // because nothing was built.
      outbound: NO_OUTBOUND_REQUEST,
    };
  } finally {
    if (task.plannerAbort === controller) task.plannerAbort = undefined;
  }

  // A Stop, a timeout, or a replacement task can land while the request is in
  // flight. `PLAN_READY` and `PLAN_FAILED` are both only legal from
  // `planning`, so this one guard covers the success and failure paths alike:
  // a late plan for an abandoned session is dropped, never shown.
  if (activeTask !== task || task.cancelled || !task.session.can("PLAN_READY")) {
    throw new CaptureFlowError("CAPTURE_FAILED", "Task Session is no longer active.");
  }

  if (!result.ok) {
    failPlan(task, result);
    throw new CaptureFlowError("CAPTURE_FAILED", result.message);
  }

  let step = result.plan.actions[0]!;
  // Deterministic repeat-backstop. Because we never send the planner the text
  // it already typed, a filled field looks empty to it, and a stubborn model
  // can re-propose filling the same field to "reword" or "improve" a draft it
  // cannot see -- the repetition the drafter showed. If this step targets a
  // field a prior step already settled, the honest next move is to stop, so we
  // rewrite it to `done`. That reuses the tested approval -> execute -> COMPLETE
  // path (a loop-level short-circuit would strand the session in
  // `awaiting_approval`, where COMPLETE is illegal). The user still approves the
  // `done`, so nothing runs behind their back.
  const repeatKey = settledTargetKey(step);
  if (repeatKey && task.settledTargets.has(repeatKey)) {
    step = {
      type: "done",
      risk: "low",
      reason: "The requested field was already filled in an earlier step.",
      summary:
        step.type === "select"
          ? "The selection was already made, so nothing more was changed."
          : "The field was already filled, so nothing more was typed.",
    };
  }
  task.plan = { ...result.plan, actions: [step] };
  task.observation = observation;
  // The provider's own view of how long the model took, as distinct from the
  // extension's round-trip measurement above: the demo shows both, because a
  // slow gateway and a slow model are different problems.
  task.metrics.record("plan", result.meta.latencyMs);
  task.session.send("PLAN_READY");
  sendEvent({
    type: "PLAN_RESULT",
    taskId: task.taskId,
    plan: task.plan,
    meta: result.meta,
    outbound: result.outbound,
  });
  publishMetrics(task, "planned");
  publishState(task);
  return step;
}

/**
 * The loop's `scan` port: capture the active tab *now*, sanitize it locally,
 * and hand the sanitized observation back. `priorActions` rides in on the
 * capture, so the planner sees what already happened rather than being told
 * separately -- the gateway stays stateless.
 *
 * Runs once per round, against the page as the previous step left it.
 *
 * `visionRequired` is Phase 6.5's fast path. A snapshot-decidable round reads
 * the accessibility tree only and calls neither `captureVisibleTab` nor the
 * local OCR/face scan. A vision round captures exactly as before, and a vision
 * round whose capture fails fails closed -- it is never silently downgraded to
 * a text-only round, because the planner asked to see pixels it did not get.
 */
async function scanRound(
  task: ActiveTask,
  priorActions: PriorActionSummary[],
  visionRequired: boolean,
): Promise<SanitizedObservation> {
  // Capture is one phase of the demo's timeline: everything from the
  // active-tab screenshot to the decoded local bitmap, including the
  // revalidation that has to pass before the page is read at all.
  const { snapshot, captureTab, screenshot } = await task.metrics.measure("capture", async () => {
    if (visionRequired) {
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
    }
    const pageSnapshot = await requestSnapshot(task.authority.tabId, task.taskId);
    // The capture authority is revalidated on every round, with or without
    // pixels: the origin/tab checks are what make the capture safe, not the
    // screenshot itself.
    let tab;
    try {
      tab = await validateCaptureAuthority(task.authority, captureBrowser());
    } catch (error) {
      if (error instanceof CaptureAuthorityError) {
        throw new CaptureFlowError("CAPTURE_FAILED", error.message);
      }
      throw error;
    }
    let decoded;
    if (visionRequired) {
      try {
        decoded = await decodeCapturedScreenshot(task.screenshotDataUrl);
      } catch (error) {
        throw new CaptureFlowError(
          "CAPTURE_FAILED",
          safeErrorMessage(error, "The captured screenshot could not be decoded locally."),
        );
      }
      task.screenshotDataUrl = "";
    }
    currentTask(task);
    return { snapshot: pageSnapshot, captureTab: tab, screenshot: decoded };
  });

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
    // Present only on a vision round; the engine gates its pixel detectors on
    // this field itself, never on a caller-set flag.
    ...(screenshot ? { screenshot } : {}),
    // With no image there is nothing to rescale: element boxes are already in
    // viewport space, so they are handed over unscaled.
    snapshot: screenshot
      ? scaleSnapshot(snapshot.snapshot, snapshot.viewport, screenshot)
      : snapshot.snapshot,
    priorActions,
  };
  const result = await task.metrics.measure("sanitize", () =>
    createEngine(task.pixelWorkers).sanitize(input, task.profile),
  );
  currentTask(task);

  if (!result.ok) {
    // `failTask` publishes the specific code; this throw only unwinds the loop.
    await failTask(task, result.error.code, result.error.message);
    throw new CaptureFlowError("CAPTURE_FAILED", result.error.message);
  }
  // The only category information the demo shows: the same coarse counts the
  // observation carries, never the map they came from.
  task.metrics.setCategoryCounts(result.observation.redactionSummary);

  // Snapshot-only rounds captured no pixels, so there is no original frame to
  // preview; the audit still reports the DOM detections that did run.
  const original = result.localAudit.originalScreenshot;
  const originalScreenshot = original
    ? await encodeForLocalAudit(createBrowserImageEncoder(), original)
    : undefined;
  task.audit = result.localAudit;
  if (!task.session.can("SANITIZED")) {
    // The session was stopped, timed out, or replaced while this scan was still
    // running: release everything rather than leaving workers and the audit
    // bitmap alive behind a task nobody can reach.
    releaseTask(task);
    throw new CaptureFlowError("CAPTURE_FAILED", "Task Session is no longer active.");
  }
  task.session.send("SANITIZED");
  sendEvent({
    type: "SANITIZATION_RESULT",
    taskId: task.taskId,
    observation: result.observation,
    audit: auditView(task, result.observation, originalScreenshot),
  });
  publishState(task);
  task.observation = result.observation;
  return result.observation;
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
    priorActions: [],
    settledTargets: new Set<string>(),
    sensitiveValues: { ...privateValues.data },
    metrics: createMetricsRecorder(),
    modelManager: createPixelModelManager(),
    pixelWorkers: createPixelWorkers(),
  };
  task.metrics.setRuntime(profile.mode);
  activeTask = task;
  task.session.send("START_SCAN");
  publishState(task);
  // The loop drives every round from here: capture, plan one step, wait for the
  // user, run one step, re-capture. Stop, failure, and the per-round budget all
  // end it, and each publishes its own ending exactly once.
  void runTask(task);
  return { ok: true, type: "ACK", taskId: task.taskId };
}

function stopTask(taskId?: string): ExtensionResponse {
  if (!activeTask || (taskId && activeTask.taskId !== taskId)) {
    return { ok: false, type: "ERROR", message: "No matching Task Session is active." };
  }
  const task = activeTask;
  task.cancelled = true;
  // Unblock a round that is waiting on the user: a stopped task settles its
  // pending approval as declined, so the loop unwinds instead of hanging.
  task.pendingRound?.resolve({ approved: false });
  task.pendingRound = undefined;
  releaseTask(task);
  const stopped = task.session.stop();
  if (!stopped) return { ok: false, type: "ERROR", message: "Task Session is not active." };
  publishMetrics(task, "stopped");
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
  task.pendingRound?.resolve({ approved: false });
  task.pendingRound = undefined;
  releaseTask(task);
  // Dismissing the audit dismisses the whole session, including a step
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
    if (message.type === "MINT_CAPTURE_AUTHORITY") {
      void mintCaptureAuthorityForWindow(message.windowId).then(sendResponse);
      return true;
    }
    if (message.type === "NAVIGATE_ACTIVE_TAB") {
      void navigateActiveTabAndMint(message.windowId, message.url).then(sendResponse);
      return true;
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

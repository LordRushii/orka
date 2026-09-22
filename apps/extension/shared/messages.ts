import type {
  RuntimeOverride,
  SafePageSnapshot,
  SanitizationTimings,
  Viewport,
} from "@orka/privacy-engine";
export type { RuntimeOverride } from "@orka/privacy-engine";
import type {
  Action,
  ActionPlan,
  PlanMetadata,
  ProviderDescriptor,
  RedactionSummaryEntry,
  SanitizationFailure,
  SanitizedObservation,
  TaskState,
} from "@orka/contracts";
import type { ExecutionReport } from "./executor.ts";
import type { CategoryBandCount, ModelVersion } from "./localReport.ts";
import type { LocalMetrics } from "./metrics.ts";
import type { OutboundView } from "./outboundView.ts";
import type { PlannerFailureCode } from "./plannerClient.ts";
import type { PlannerSettings } from "./settings.ts";

export const EXTENSION_MESSAGE_TYPES = {
  START_TASK: "START_TASK",
  APPROVE_PLAN: "APPROVE_PLAN",
  CONFIRMATION_DECISION: "CONFIRMATION_DECISION",
  METRICS_REPORT: "METRICS_REPORT",
  GET_CAPTURE_AUTHORITY: "GET_CAPTURE_AUTHORITY",
  CAPTURE_REQUEST: "CAPTURE_REQUEST",
  SNAPSHOT_RESULT: "SNAPSHOT_RESULT",
  SNAPSHOT_FAILURE: "SNAPSHOT_FAILURE",
  SANITIZATION_RESULT: "SANITIZATION_RESULT",
  SANITIZATION_FAILURE: "SANITIZATION_FAILURE",
  PLAN_RESULT: "PLAN_RESULT",
  PLAN_FAILURE: "PLAN_FAILURE",
  GET_PLANNER_SETTINGS: "GET_PLANNER_SETTINGS",
  SAVE_PLANNER_SETTINGS: "SAVE_PLANNER_SETTINGS",
  CHECK_GATEWAY: "CHECK_GATEWAY",
  STOP_TASK: "STOP_TASK",
  AUDIT_CLOSE: "AUDIT_CLOSE",
  TASK_STATE: "TASK_STATE",
  TASK_STOPPED: "TASK_STOPPED",
  AUDIT_CLOSED: "AUDIT_CLOSED",
  ROUND_PROGRESS: "ROUND_PROGRESS",
} as const;

export type StartTaskMessage = {
  type: "START_TASK";
  taskId: string;
  task: string;
  runtime: RuntimeOverride;
  captureAuthorityId: string;
  /**
   * Private values the user typed for this task, keyed by bracket name. They
   * live in extension memory for the session, are never persisted, and never
   * appear in an observation, an outcome, or an event.
   */
  sensitiveValues?: Record<string, string>;
};

/** The user approved the proposed plan: the executor may now run it. */
export type ApprovePlanMessage = {
  type: "APPROVE_PLAN";
  taskId: string;
};

/**
 * The user's answer to one paused step: allow or decline a confirmation, or
 * close a question. `answer` is only meaningful for a question and is never
 * forwarded anywhere.
 */
export type ConfirmationDecisionMessage = {
  type: "CONFIRMATION_DECISION";
  taskId: string;
  actionIndex: number;
  approved: boolean;
  answer?: string;
};

export type GetCaptureAuthorityMessage = {
  type: "GET_CAPTURE_AUTHORITY";
};

export type CaptureRequestMessage = {
  type: "CAPTURE_REQUEST";
  requestId: string;
  taskId: string;
};

export type SnapshotResultMessage = {
  type: "SNAPSHOT_RESULT";
  requestId: string;
  taskId: string;
  urlOrigin: string;
  viewport: Viewport;
  snapshot: SafePageSnapshot;
};

export type SnapshotFailureMessage = {
  type: "SNAPSHOT_FAILURE";
  requestId: string;
  taskId: string;
  code: "RESTRICTED_PAGE" | "CAPTURE_FAILED";
  message: string;
};

export type EncodedScreenshot = {
  mimeType: "image/png" | "image/webp";
  width: number;
  height: number;
  dataBase64: string;
};

export type LocalAuditView = {
  runtime: {
    mode: "webgpu" | "balanced" | "wasm";
    override: RuntimeOverride;
    reason: string;
  };
  /** Present only on a vision round; a snapshot-only round captures nothing. */
  originalScreenshot?: EncodedScreenshot;
  redactedScreenshot?: EncodedScreenshot;
  redactionSummary: RedactionSummaryEntry[];
  /**
   * How sure the detections were, in bands rather than scores: enough for a
   * reviewer to judge the redaction, without rebuilding the Redaction Map on
   * screen (phases/05-demo-and-hardening.md).
   */
  confidenceBands: CategoryBandCount[];
  /** The pinned model versions behind this scan, from the build's manifest. */
  models: ModelVersion[];
  /**
   * Measured local spans for the most recent scan (docs2/02-pii-engine-speed.md
   * Step 0). Millisecond numbers only -- the panel can show where the time went
   * without the spans ever being part of a request.
   */
  timings?: SanitizationTimings;
  /**
   * The execution provider the pixel workers actually bound (Fix 3). A panel
   * that says `webgpu` here is reporting the ORT session's own provider, not
   * the mode the user asked for.
   */
  boundExecutionProvider?: "webgpu" | "wasm";
  createdAt: number;
};

export type SanitizationResultMessage = {
  type: "SANITIZATION_RESULT";
  taskId: string;
  observation: SanitizedObservation;
  audit: LocalAuditView;
};

export type SanitizationFailureMessage = {
  type: "SANITIZATION_FAILURE";
  taskId: string;
  error: SanitizationFailure;
};

/** The proposed plan, awaiting approval. Phase 3 stops here: nothing runs. */
export type PlanResultMessage = {
  type: "PLAN_RESULT";
  taskId: string;
  plan: ActionPlan;
  meta: PlanMetadata;
  /** The request body, described by shape: what left this device. */
  outbound: OutboundView;
};

export type PlanFailureMessage = {
  type: "PLAN_FAILURE";
  taskId: string;
  error: { code: PlannerFailureCode; message: string };
  /** Present on the failing path too: the request that was attempted. */
  outbound: OutboundView;
};

/**
 * Aggregated local metrics for one Task Session (phases/05-demo-and-hardening.md).
 * Plain numbers about this extension and this run: no page text, no URL, no
 * detection location, no private value, and nothing persisted anywhere.
 */
export type MetricsReportMessage = {
  type: "METRICS_REPORT";
  taskId: string;
  metrics: LocalMetrics;
};

export type GetPlannerSettingsMessage = {
  type: "GET_PLANNER_SETTINGS";
};

export type SavePlannerSettingsMessage = {
  type: "SAVE_PLANNER_SETTINGS";
  settings: PlannerSettings;
};

export type CheckGatewayMessage = {
  type: "CHECK_GATEWAY";
};

export type StopTaskMessage = {
  type: "STOP_TASK";
  taskId?: string;
};

export type AuditCloseMessage = {
  type: "AUDIT_CLOSE";
  taskId?: string;
};

export type TaskStateMessage = {
  type: "TASK_STATE";
  taskId: string;
  state: TaskState;
  runtime?: LocalAuditView["runtime"];
};

export type TaskStoppedMessage = {
  type: "TASK_STOPPED";
  taskId: string;
};

/**
 * Multi-round progress (Phase 6). A round is one capture -> one plan -> one
 * human decision -> (if approved) one executed step. The panel shows which
 * round is in flight; the action and summary describe a step that just ran.
 */
export type RoundProgressMessage = {
  type: "ROUND_PROGRESS";
  taskId: string;
  round: number;
  phase: "started" | "step";
  action?: Action;
  summary?: string;
};

export type AuditClosedMessage = {
  type: "AUDIT_CLOSED";
  taskId: string;
};

export type ExtensionMessage =
  | StartTaskMessage
  | ApprovePlanMessage
  | ConfirmationDecisionMessage
  | GetCaptureAuthorityMessage
  | CaptureRequestMessage
  | SnapshotResultMessage
  | SnapshotFailureMessage
  | SanitizationResultMessage
  | SanitizationFailureMessage
  | PlanResultMessage
  | PlanFailureMessage
  | GetPlannerSettingsMessage
  | SavePlannerSettingsMessage
  | CheckGatewayMessage
  | StopTaskMessage
  | AuditCloseMessage
  | TaskStateMessage
  | TaskStoppedMessage
  | AuditClosedMessage
  | RoundProgressMessage
  | MetricsReportMessage
  /** Progress the executor publishes while it runs an approved plan. */
  | ExecutionReport;

export type ExtensionResponse =
  | { ok: true; type: "ACK"; taskId?: string }
  | { ok: false; type: "ERROR"; message: string };

export type PlannerSettingsResponse =
  | { ok: true; type: "PLANNER_SETTINGS"; settings: PlannerSettings }
  | { ok: false; type: "ERROR"; message: string };

export type GatewayCheckResponse =
  | { ok: true; type: "GATEWAY_OK"; providers: ProviderDescriptor[] }
  | { ok: false; type: "ERROR"; message: string };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" &&
    (Object.values(EXTENSION_MESSAGE_TYPES) as readonly string[]).includes(type);
}

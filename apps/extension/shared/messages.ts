import type {
  RuntimeOverride,
  SafePageSnapshot,
  Viewport,
} from "@orka/privacy-engine";
export type { RuntimeOverride } from "@orka/privacy-engine";
import type {
  RedactionSummaryEntry,
  SanitizationFailure,
  SanitizedObservation,
  TaskState,
} from "@orka/contracts";

export const EXTENSION_MESSAGE_TYPES = {
  START_TASK: "START_TASK",
  GET_CAPTURE_AUTHORITY: "GET_CAPTURE_AUTHORITY",
  CAPTURE_REQUEST: "CAPTURE_REQUEST",
  SNAPSHOT_RESULT: "SNAPSHOT_RESULT",
  SNAPSHOT_FAILURE: "SNAPSHOT_FAILURE",
  SANITIZATION_RESULT: "SANITIZATION_RESULT",
  SANITIZATION_FAILURE: "SANITIZATION_FAILURE",
  STOP_TASK: "STOP_TASK",
  AUDIT_CLOSE: "AUDIT_CLOSE",
  TASK_STATE: "TASK_STATE",
  TASK_STOPPED: "TASK_STOPPED",
  AUDIT_CLOSED: "AUDIT_CLOSED",
} as const;

export type StartTaskMessage = {
  type: "START_TASK";
  taskId: string;
  task: string;
  runtime: RuntimeOverride;
  captureAuthorityId: string;
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
  originalScreenshot: EncodedScreenshot;
  redactedScreenshot: EncodedScreenshot;
  redactionSummary: RedactionSummaryEntry[];
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

export type AuditClosedMessage = {
  type: "AUDIT_CLOSED";
  taskId: string;
};

export type ExtensionMessage =
  | StartTaskMessage
  | GetCaptureAuthorityMessage
  | CaptureRequestMessage
  | SnapshotResultMessage
  | SnapshotFailureMessage
  | SanitizationResultMessage
  | SanitizationFailureMessage
  | StopTaskMessage
  | AuditCloseMessage
  | TaskStateMessage
  | TaskStoppedMessage
  | AuditClosedMessage;

export type ExtensionResponse =
  | { ok: true; type: "ACK"; taskId?: string }
  | { ok: false; type: "ERROR"; message: string };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" &&
    (Object.values(EXTENSION_MESSAGE_TYPES) as readonly string[]).includes(type);
}

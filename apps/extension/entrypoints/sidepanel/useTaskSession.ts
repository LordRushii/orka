import { useCallback, useEffect, useMemo, useState } from "react";
import type { SanitizationFailure, SanitizedObservation, TaskState } from "@orka/contracts";
import type {
  AuditClosedMessage,
  ExtensionMessage,
  LocalAuditView,
  SanitizationFailureMessage,
  SanitizationResultMessage,
  RuntimeOverride,
  TaskStateMessage,
} from "../../shared/messages.ts";

const ACTIVE_STATES: readonly TaskState[] = [
  "scanning",
  "sanitized",
  "planning",
  "awaiting_approval",
  "executing",
];

function isTaskStateMessage(message: ExtensionMessage): message is TaskStateMessage {
  return message.type === "TASK_STATE";
}

function isSanitizationResult(message: ExtensionMessage): message is SanitizationResultMessage {
  return message.type === "SANITIZATION_RESULT";
}

function isSanitizationFailure(message: ExtensionMessage): message is SanitizationFailureMessage {
  return message.type === "SANITIZATION_FAILURE";
}

function isAuditClosed(message: ExtensionMessage): message is AuditClosedMessage {
  return message.type === "AUDIT_CLOSED";
}

export function useTaskSession() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [state, setState] = useState<TaskState>("idle");
  const [runtime, setRuntime] = useState<TaskStateMessage["runtime"]>();
  const [audit, setAudit] = useState<LocalAuditView>();
  const [observation, setObservation] = useState<SanitizedObservation>();
  const [failure, setFailure] = useState<SanitizationFailure>();
  const [requestError, setRequestError] = useState<string>();

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      const event = message as ExtensionMessage;
      if (isTaskStateMessage(event)) {
        setTaskId(event.taskId);
        setState(event.state);
        if (event.runtime) setRuntime(event.runtime);
      } else if (isSanitizationResult(event)) {
        setTaskId(event.taskId);
        setState("sanitized");
        setAudit(event.audit);
        setObservation(event.observation);
        setFailure(undefined);
      } else if (isSanitizationFailure(event)) {
        setTaskId(event.taskId);
        setState("failed");
        setAudit(undefined);
        setObservation(undefined);
        setFailure(event.error);
      } else if (event.type === "TASK_STOPPED") {
        setState("stopped");
        setAudit(undefined);
        setObservation(undefined);
      } else if (isAuditClosed(event)) {
        setTaskId(null);
        setState("idle");
        setAudit(undefined);
        setObservation(undefined);
        setFailure(undefined);
      }
    };

    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const start = useCallback(async (task: string, runtimeOverride: RuntimeOverride) => {
    const nextTaskId = crypto.randomUUID();
    setRequestError(undefined);
    setFailure(undefined);
    const authority = await browser.runtime.sendMessage({ type: "GET_CAPTURE_AUTHORITY" });
    if (!authority?.ok || typeof authority.authorityId !== "string") {
      setRequestError(authority?.message ?? "Reopen Orka from the toolbar before starting a task.");
      return false;
    }
    const response = await browser.runtime.sendMessage({
      type: "START_TASK",
      taskId: nextTaskId,
      task,
      runtime: runtimeOverride,
      captureAuthorityId: authority.authorityId,
    });
    if (!response?.ok) {
      setRequestError(response?.message ?? "Task Session could not start.");
      return false;
    }
    setTaskId(nextTaskId);
    return true;
  }, []);

  const stop = useCallback(async () => {
    if (!taskId) return false;
    const response = await browser.runtime.sendMessage({ type: "STOP_TASK", taskId });
    if (!response?.ok) {
      setRequestError(response?.message ?? "Task Session could not stop.");
      return false;
    }
    return true;
  }, [taskId]);

  const closeAudit = useCallback(async () => {
    if (!taskId) return false;
    const response = await browser.runtime.sendMessage({ type: "AUDIT_CLOSE", taskId });
    if (!response?.ok) {
      setRequestError(response?.message ?? "Local audit could not close.");
      return false;
    }
    return true;
  }, [taskId]);

  const canStop = ACTIVE_STATES.includes(state);

  return useMemo(
    () => ({
      taskId,
      state,
      runtime,
      audit,
      observation,
      failure,
      requestError,
      canStop,
      start,
      stop,
      closeAudit,
    }),
    [taskId, state, runtime, audit, observation, failure, requestError, canStop, start, stop, closeAudit],
  );
}

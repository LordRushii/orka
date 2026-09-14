import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActionPlan,
  PlanMetadata,
  ProviderDescriptor,
  SanitizationFailure,
  SanitizedObservation,
  TaskState,
} from "@orka/contracts";
import type {
  AuditClosedMessage,
  ExtensionMessage,
  GatewayCheckResponse,
  LocalAuditView,
  PlanFailureMessage,
  PlanResultMessage,
  PlannerSettingsResponse,
  SanitizationFailureMessage,
  SanitizationResultMessage,
  RuntimeOverride,
  TaskStateMessage,
} from "../../shared/messages.ts";
import { DEFAULT_PLANNER_SETTINGS, type PlannerSettings } from "../../shared/settings.ts";

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

function isPlanResult(message: ExtensionMessage): message is PlanResultMessage {
  return message.type === "PLAN_RESULT";
}

function isPlanFailure(message: ExtensionMessage): message is PlanFailureMessage {
  return message.type === "PLAN_FAILURE";
}

function isAuditClosed(message: ExtensionMessage): message is AuditClosedMessage {
  return message.type === "AUDIT_CLOSED";
}

/**
 * A gateway outside the manifest's loopback grant needs an optional host
 * permission, and Chrome only grants one from a user gesture -- which is why
 * this runs in the panel on click rather than in the background worker.
 *
 * `request` comes first and deliberately runs before any other `await`: a
 * prior awaited API call can spend the click's gesture and make Chrome reject
 * the prompt. It throws for an origin that is already a static
 * `host_permission` (those cannot be "requested"), so the containment check is
 * the fallback that covers the default loopback gateway.
 */
async function ensureGatewayPermission(gatewayUrl: string): Promise<boolean> {
  const origins = [`${gatewayUrl}/*`];
  try {
    if (await browser.permissions.request({ origins })) return true;
  } catch {
    // Not an optional origin: fall through and check the static grant.
  }
  try {
    return await browser.permissions.contains({ origins });
  } catch {
    return false;
  }
}

export function useTaskSession() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [state, setState] = useState<TaskState>("idle");
  const [runtime, setRuntime] = useState<TaskStateMessage["runtime"]>();
  const [audit, setAudit] = useState<LocalAuditView>();
  const [observation, setObservation] = useState<SanitizedObservation>();
  const [failure, setFailure] = useState<SanitizationFailure>();
  const [requestError, setRequestError] = useState<string>();
  const [plan, setPlan] = useState<ActionPlan>();
  const [planMeta, setPlanMeta] = useState<PlanMetadata>();
  const [planError, setPlanError] = useState<PlanFailureMessage["error"]>();
  const [settings, setSettings] = useState<PlannerSettings>(DEFAULT_PLANNER_SETTINGS);
  const [providers, setProviders] = useState<ProviderDescriptor[]>();
  const [gatewayStatus, setGatewayStatus] = useState<string>();

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
      } else if (isPlanResult(event)) {
        setTaskId(event.taskId);
        setState("awaiting_approval");
        setPlan(event.plan);
        setPlanMeta(event.meta);
        setPlanError(undefined);
      } else if (isPlanFailure(event)) {
        setTaskId(event.taskId);
        setState("failed");
        setPlan(undefined);
        setPlanMeta(undefined);
        setPlanError(event.error);
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
        setPlan(undefined);
        setPlanMeta(undefined);
        setPlanError(undefined);
      }
    };

    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    void browser.runtime
      .sendMessage({ type: "GET_PLANNER_SETTINGS" })
      .then((response: PlannerSettingsResponse | undefined) => {
        if (response?.ok) setSettings(response.settings);
      })
      .catch(() => {
        // Falls back to DEFAULT_PLANNER_SETTINGS; the form stays usable.
      });
  }, []);

  const start = useCallback(async (task: string, runtimeOverride: RuntimeOverride) => {
    const nextTaskId = crypto.randomUUID();
    setRequestError(undefined);
    setFailure(undefined);
    setPlan(undefined);
    setPlanMeta(undefined);
    setPlanError(undefined);
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

  const saveSettings = useCallback(async (next: PlannerSettings) => {
    setGatewayStatus(undefined);
    setRequestError(undefined);
    if (!(await ensureGatewayPermission(next.gatewayUrl))) {
      setRequestError(`Orka needs permission to contact ${next.gatewayUrl}.`);
      return false;
    }
    const response: PlannerSettingsResponse | undefined = await browser.runtime.sendMessage({
      type: "SAVE_PLANNER_SETTINGS",
      settings: next,
    });
    if (!response?.ok) {
      setRequestError(response?.message ?? "Planner settings could not be saved.");
      return false;
    }
    setSettings(response.settings);
    setGatewayStatus("Settings saved.");
    return true;
  }, []);

  const checkGateway = useCallback(async () => {
    setGatewayStatus("Checking…");
    const response: GatewayCheckResponse | undefined = await browser.runtime.sendMessage({
      type: "CHECK_GATEWAY",
    });
    if (!response?.ok) {
      setProviders(undefined);
      setGatewayStatus(response?.message ?? "The gateway check failed.");
      return false;
    }
    setProviders(response.providers);
    setGatewayStatus(
      response.providers.length === 0
        ? "Gateway reachable, but no providers are enabled."
        : `Gateway reachable. Providers: ${response.providers.map((entry) => entry.id).join(", ")}.`,
    );
    return true;
  }, []);

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
      plan,
      planMeta,
      planError,
      settings,
      providers,
      gatewayStatus,
      canStop,
      start,
      stop,
      closeAudit,
      saveSettings,
      checkGateway,
    }),
    [
      taskId,
      state,
      runtime,
      audit,
      observation,
      failure,
      requestError,
      plan,
      planMeta,
      planError,
      settings,
      providers,
      gatewayStatus,
      canStop,
      start,
      stop,
      closeAudit,
      saveSettings,
      checkGateway,
    ],
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Action,
  type ActionOutcome,
  type ActionPlan,
  type ConfirmationKind,
  type ExecutionRunStatus,
  type PlanMetadata,
  type ProviderDescriptor,
  type Risk,
  type SanitizationFailure,
  type SanitizedObservation,
  type StopReason,
  type TaskState,
} from "@orka/contracts";
import type {
  AuditClosedMessage,
  ConfirmationDecisionMessage,
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
import {
  collectPrivateValues,
  emptyPrivateValueRow,
  type PrivateValueRow,
} from "../../shared/privateValues.ts";
import {
  appendUserAnswer,
  appendUserDecision,
  appendUserTask,
  reduceTranscript,
  type ChatTurn,
} from "../../shared/chatTranscript.ts";
import type { LocalMetrics } from "../../shared/metrics.ts";
import type { OutboundView } from "../../shared/outboundView.ts";
import { DEFAULT_PLANNER_SETTINGS, type PlannerSettings } from "../../shared/settings.ts";

export type { PrivateValueRow } from "../../shared/privateValues.ts";

const ACTIVE_STATES: readonly TaskState[] = [
  "scanning",
  "sanitized",
  "planning",
  "awaiting_approval",
  "executing",
];

/** One line of the run log: what the plan proposed and what came of it. */
export type ActionOutcomeView = {
  actionIndex: number;
  action: Action;
  detail: string;
  outcome: ActionOutcome;
};

/** A step the executor is waiting on the user to answer. */
export type PendingPrompt =
  | {
      kind: "confirm";
      actionIndex: number;
      confirmation: ConfirmationKind;
      detail: string;
      risk: Risk;
    }
  | {
      kind: "ask_user";
      actionIndex: number;
      prompt: string;
      detail: string;
      risk: Risk;
    };

export type RunSummary = {
  status: ExecutionRunStatus;
  summary: string;
  stopReason?: StopReason;
  failure?: { code: string; message: string };
};



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
  /** Which multi-round round is in flight, for the panel's progress copy. */
  const [round, setRound] = useState(0);
  /**
   * The conversation, as a view over the same events the state machine handles
   * (Phase 8). `TaskSession` still decides what may happen; this only records
   * what was said, and it is dropped with the session so a drafted private
   * value cannot outlive the run it belonged to.
   */
  const [transcript, setTranscript] = useState<ChatTurn[]>([]);
  /**
   * The round the next event belongs to. `PLAN_RESULT` carries no round, and
   * this listener is attached once so it can never read fresh React state --
   * a ref is the one place the round can be read reliably here.
   */
  const roundRef = useRef(1);
  const [runtime, setRuntime] = useState<TaskStateMessage["runtime"]>();
  const [audit, setAudit] = useState<LocalAuditView>();
  const [observation, setObservation] = useState<SanitizedObservation>();
  const [failure, setFailure] = useState<SanitizationFailure>();
  const [requestError, setRequestError] = useState<string>();
  // True after a start attempt fell on a page no extension can read (a
  // chrome:// page, the Web Store, file://): the panel offers the URL rescue.
  const [needsNavigation, setNeedsNavigation] = useState(false);
  const [plan, setPlan] = useState<ActionPlan>();
  const [planMeta, setPlanMeta] = useState<PlanMetadata>();
  const [planError, setPlanError] = useState<PlanFailureMessage["error"]>();
  const [settings, setSettings] = useState<PlannerSettings>(DEFAULT_PLANNER_SETTINGS);
  const [providers, setProviders] = useState<ProviderDescriptor[]>();
  const [gatewayStatus, setGatewayStatus] = useState<string>();
  const [outcomes, setOutcomes] = useState<ActionOutcomeView[]>([]);
  const [pending, setPending] = useState<PendingPrompt>();
  const [run, setRun] = useState<RunSummary>();
  const [privateValues, setPrivateValues] = useState<PrivateValueRow[]>([emptyPrivateValueRow()]);
  /**
   * The names (never the values) this task was started with, so the panel can
   * say whether a plan's `[PHONE_1]` reference will resolve.
   */
  const [declaredValueNames, setDeclaredValueNames] = useState<string[]>([]);

  /**
   * This run's aggregated timings, and the request body described by shape.
   * Both are local to this session and cleared when it closes.
   */
  const [metrics, setMetrics] = useState<LocalMetrics>();
  const [outbound, setOutbound] = useState<OutboundView>();

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      const event = message as ExtensionMessage;
      if (event.type === "ROUND_PROGRESS") roundRef.current = event.round;
      // Read the round now, not when React processes the update: the ref may
      // have moved on by then and the turn would carry the wrong round.
      const context = { round: roundRef.current };
      setTranscript((previous) => reduceTranscript(previous, event, context));
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
        setRequestError(undefined);
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
        setOutbound(event.outbound);
        setPlanError(undefined);
      } else if (isPlanFailure(event)) {
        setTaskId(event.taskId);
        setState("failed");
        setPlan(undefined);
        setPlanMeta(undefined);
        setOutbound(event.outbound);
        setPlanError(event.error);
      } else if (event.type === "METRICS_REPORT") {
        setTaskId(event.taskId);
        setMetrics(event.metrics);
      } else if (event.type === "EXECUTION_STARTED") {
        setTaskId(event.taskId);
        setState("executing");
        setOutcomes([]);
        setRun(undefined);
        setPending(undefined);
      } else if (event.type === "ACTION_OUTCOME") {
        setOutcomes((previous) => [
          ...previous,
          {
            actionIndex: event.actionIndex,
            action: event.action,
            detail: event.detail,
            outcome: event.outcome,
          },
        ]);
      } else if (event.type === "CONFIRMATION_REQUEST") {
        setPending({
          kind: "confirm",
          actionIndex: event.actionIndex,
          confirmation: event.confirmation,
          detail: event.detail,
          risk: event.risk,
        });
      } else if (event.type === "ASK_USER") {
        setPending({
          kind: "ask_user",
          actionIndex: event.actionIndex,
          prompt: event.prompt,
          detail: event.detail,
          risk: event.risk,
        });
      } else if (event.type === "EXECUTION_FINISHED") {
        setPending(undefined);
        setDeclaredValueNames([]);
        setRun({
          status: event.status,
          summary: event.summary,
          stopReason: event.stopReason,
          failure: event.failure,
        });
        // A finished run has no private values left in the background; the
        // form does not keep a second copy.
        setPrivateValues([emptyPrivateValueRow()]);
      } else if (event.type === "ROUND_PROGRESS") {
        setTaskId(event.taskId);
        setRound(event.round);
      } else if (event.type === "TASK_STOPPED") {
        setState("stopped");
        setAudit(undefined);
        setObservation(undefined);
        setPending(undefined);
        setOutbound(undefined);
        setRound(0);
        roundRef.current = 1;
        setPrivateValues([emptyPrivateValueRow()]);
        setDeclaredValueNames([]);
      } else if (isAuditClosed(event)) {
        setTaskId(null);
        setState("idle");
        setRound(0);
        roundRef.current = 1;
        setTranscript([]);
        setAudit(undefined);
        setObservation(undefined);
        setFailure(undefined);
        setPlan(undefined);
        setPlanMeta(undefined);
        setPlanError(undefined);
        setOutcomes([]);
        setPending(undefined);
        setRun(undefined);
        // The metrics and the outbound view describe a session that has closed:
        // they go with it, rather than lingering as a record of a past task.
        setMetrics(undefined);
        setOutbound(undefined);
        setPrivateValues([emptyPrivateValueRow()]);
        setDeclaredValueNames([]);
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

  /**
   * The shared tail of both start paths: hand the task to the background with a
   * minted authority, then adopt the new session locally. The values live in
   * the background for this session; this form keeps no second copy -- only
   * their names, so it can explain the plan.
   */
  const dispatchStart = useCallback(
    async (
      authorityId: string,
      nextTaskId: string,
      task: string,
      runtimeOverride: RuntimeOverride,
      values: Record<string, string>,
    ) => {
      const response = await browser.runtime.sendMessage({
        type: "START_TASK",
        taskId: nextTaskId,
        task,
        runtime: runtimeOverride,
        captureAuthorityId: authorityId,
        sensitiveValues: values,
      });
      if (!response?.ok) {
        setRequestError(response?.message ?? "Task Session could not start.");
        return false;
      }
      setDeclaredValueNames(Object.keys(values));
      setPrivateValues([emptyPrivateValueRow()]);
      // A new task is a new conversation: the previous session's turns go with
      // its audit, so a drafted value cannot linger in a closed run's thread.
      roundRef.current = 1;
      setTranscript(appendUserTask([], task));
      setTaskId(nextTaskId);
      return true;
    },
    [],
  );

  const start = useCallback(
    async (task: string, runtimeOverride: RuntimeOverride) => {
      const collected = collectPrivateValues(privateValues);
      if (!collected.ok) {
        setRequestError(collected.message);
        return false;
      }
      const nextTaskId = crypto.randomUUID();
      setRequestError(undefined);
      setFailure(undefined);
      setPlan(undefined);
      setPlanMeta(undefined);
      setPlanError(undefined);
      setOutcomes([]);
      setPending(undefined);
      setRun(undefined);
      setMetrics(undefined);
      setOutbound(undefined);
      setRound(0);
      // Host access is a static grant now (see wxt.config), so a task starts on
      // the current tab with no prompt: resolve the panel's window and mint the
      // authority against its active tab.
      const win = await browser.windows.getCurrent();
      if (typeof win.id !== "number") {
        setRequestError("Open a normal browser window, then start the task.");
        return false;
      }
      const authority = await browser.runtime.sendMessage({ type: "MINT_CAPTURE_AUTHORITY", windowId: win.id });
      if (!authority?.ok || typeof authority.authorityId !== "string") {
        // Chrome's own pages (new tab, settings, Web Store, file://) can't be
        // read by any extension. Rather than dead-end, surface the URL rescue:
        // the panel can offer to open a real page in this tab first.
        if (authority?.code === "NON_WEB_PAGE") setNeedsNavigation(true);
        setRequestError(authority?.message ?? "Open a normal HTTP(S) page in this tab, then start the task.");
        return false;
      }
      return dispatchStart(authority.authorityId, nextTaskId, task, runtimeOverride, collected.values);
    },
    [privateValues, dispatchStart],
  );

  /**
   * The URL rescue for a non-web tab: ask the background to open `url` in this
   * window's active tab, wait for the load, and start the task on the page it
   * lands on. Chrome's built-in pages stay unreachable; this only works because
   * the user named a real web address to open in their place.
   */
  const startAtUrl = useCallback(
    async (url: string, task: string, runtimeOverride: RuntimeOverride) => {
      const collected = collectPrivateValues(privateValues);
      if (!collected.ok) {
        setRequestError(collected.message);
        return false;
      }
      const nextTaskId = crypto.randomUUID();
      setRequestError(undefined);
      const win = await browser.windows.getCurrent();
      if (typeof win.id !== "number") {
        setRequestError("Open a normal browser window, then start the task.");
        return false;
      }
      const authority = await browser.runtime.sendMessage({
        type: "NAVIGATE_ACTIVE_TAB",
        windowId: win.id,
        url,
      });
      if (!authority?.ok || typeof authority.authorityId !== "string") {
        setRequestError(authority?.message ?? "That page could not be opened.");
        return false;
      }
      setNeedsNavigation(false);
      return dispatchStart(authority.authorityId, nextTaskId, task, runtimeOverride, collected.values);
    },
    [privateValues, dispatchStart],
  );

  const stop = useCallback(async () => {
    if (!taskId) return false;
    const response = await browser.runtime.sendMessage({ type: "STOP_TASK", taskId });
    if (!response?.ok) {
      setRequestError(response?.message ?? "Task Session could not stop.");
      return false;
    }
    setPending(undefined);
    return true;
  }, [taskId]);

  const closeAudit = useCallback(async () => {
    if (!taskId) return false;
    const response = await browser.runtime.sendMessage({ type: "AUDIT_CLOSE", taskId });
    if (!response?.ok) {
      setRequestError(response?.message ?? "Local audit could not close.");
      return false;
    }
    setOutcomes([]);
    setPending(undefined);
    setRun(undefined);
    return true;
  }, [taskId]);

  /** The user approved the proposed plan: hand it to the executor. */
  const approve = useCallback(async () => {
    if (!taskId) return false;
    const response = await browser.runtime.sendMessage({ type: "APPROVE_PLAN", taskId });
    if (!response?.ok) {
      setRequestError(response?.message ?? "That plan could not be started.");
      return false;
    }
    setTranscript((previous) => appendUserDecision(previous, true));
    return true;
  }, [taskId]);

  /** Answers the step the executor is paused on. */
  const decide = useCallback(
    async (approved: boolean, answer?: string) => {
      if (!taskId || !pending) return false;
      const message: ConfirmationDecisionMessage = {
        type: "CONFIRMATION_DECISION",
        taskId,
        actionIndex: pending.actionIndex,
        approved,
        ...(answer === undefined ? {} : { answer }),
      };
      const deciding = pending;
      setPending(undefined);
      const response = await browser.runtime.sendMessage(message);
      if (!response?.ok) {
        setRequestError(response?.message ?? "That decision could not be delivered.");
        return false;
      }
      // The user's own words for what they just decided, written into the
      // thread they are reading -- a decision belongs next to the prompt it
      // answered, not only in the run log.
      setTranscript((previous) => {
        if (deciding.kind === "confirm") {
          return appendUserDecision(previous, approved, approved ? "Allowed once." : "Denied and stopped.");
        }
        return approved
          ? appendUserAnswer(previous, answer ?? "")
          : appendUserDecision(previous, false, "Stopped here.");
      });
      return true;
    },
    [pending, taskId],
  );

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
      round,
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
      transcript,
      outcomes,
      pending,
      run,
      metrics,
      outbound,
      privateValues,
      setPrivateValues,
      declaredValueNames,
      canStop,
      start,
      startAtUrl,
      needsNavigation,
      stop,
      closeAudit,
      approve,
      decide,
      saveSettings,
      checkGateway,
    }),
    [
      taskId,
      state,
      round,
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
      transcript,
      outcomes,
      pending,
      run,
      metrics,
      outbound,
      privateValues,
      declaredValueNames,
      canStop,
      start,
      startAtUrl,
      needsNavigation,
      stop,
      closeAudit,
      approve,
      decide,
      saveSettings,
      checkGateway,
    ],
  );
}

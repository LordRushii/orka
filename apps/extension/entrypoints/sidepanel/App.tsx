import { useEffect, useMemo, useState } from "react";
import {
  CLOUD_PROVIDER_IDS,
  PROVIDER_IDS,
  type Action,
  type ActionOutcome,
  type ConfirmationKind,
  type ExecutionRunStatus,
  type ProviderId,
  type StopReason,
  type TaskState,
} from "@orka/contracts";
import { destinationWasNamed, planPlaceholders } from "../../shared/executorPolicy.ts";
import { useTaskSession, type PrivateValueRow } from "./useTaskSession.ts";
import type { RuntimeOverride } from "../../shared/messages.ts";
import "./App.css";

const RUNTIMES: readonly { id: RuntimeOverride; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "gpu", label: "GPU preferred" },
  { id: "balanced", label: "Balanced" },
  { id: "wasm", label: "CPU / WASM" },
];

const PROVIDER_LABEL: Record<ProviderId, string> = {
  mock: "Mock (offline, deterministic)",
  lmstudio: "LM Studio (local)",
  deepseek: "DeepSeek (cloud)",
  "openai-compatible": "OpenAI-compatible (cloud)",
  anthropic: "Anthropic (cloud)",
};

const STATE_LABEL: Record<TaskState, string> = {
  idle: "Idle",
  scanning: "Scanning locally",
  sanitized: "Sanitized context ready",
  planning: "Waiting on planner",
  awaiting_approval: "Awaiting your approval",
  executing: "Executing",
  stopped: "Stopped",
  completed: "Completed",
  failed: "Failed",
};

const RISK_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;

/**
 * Every confirmation the executor can raise, in the user's words. The executor
 * sends the stable `kind`; the panel owns the copy.
 */
const CONFIRMATION_TITLE: Record<ConfirmationKind, string> = {
  submit: "Submit this form?",
  download: "Download or export a file?",
  permission: "Grant this site a permission?",
  purchase: "Spend money or start a commitment?",
  send: "Send or publish something?",
  delete: "Delete or cancel something?",
  account_security: "Change account or security settings?",
  sensitive_value: "Insert one of your private values?",
  type: "Type into this field?",
  select: "Choose this option?",
  new_origin: "Continue on a different site?",
};

const OUTCOME_LABEL: Record<ActionOutcome["status"], string> = {
  success: "Done",
  failure: "Refused",
  skipped: "Not run",
};

const RUN_STATUS_LABEL: Record<ExecutionRunStatus, string> = {
  completed: "Finished",
  stopped: "Stopped",
  failed: "Failed",
};

const STOP_REASON_LABEL: Record<StopReason, string> = {
  user: "you pressed Stop",
  timeout: "the time budget ran out",
  policy: "a safety limit was reached",
  denied: "you declined a step",
  tab_closed: "the tab was closed",
  page_unavailable: "the page could not be reached",
  privacy: "a privacy check failed",
};

function screenshotUrl(screenshot: { mimeType: string; dataBase64: string }): string {
  return `data:${screenshot.mimeType};base64,${screenshot.dataBase64}`;
}

/** One-line description of what an action would do, if it were approved. */
function actionDetail(action: Action): string {
  switch (action.type) {
    case "navigate":
      return action.url;
    case "click":
      return `${action.target.role} "${action.target.accessibleName}"`;
    case "scroll":
      return action.target
        ? `${action.direction} on ${action.target.role} "${action.target.accessibleName}"`
        : action.direction;
    case "type":
      return `"${action.value}" into ${action.target.role} "${action.target.accessibleName}"`;
    case "select":
      return `"${action.value}" in ${action.target.role} "${action.target.accessibleName}"`;
    case "ask_user":
      return action.prompt;
    case "done":
      return action.summary;
  }
}

function EmptyValueRow(): PrivateValueRow {
  return { name: "", value: "" };
}

function App() {
  const {
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
    outcomes,
    pending,
    run,
    privateValues,
    setPrivateValues,
    declaredValueNames,
    canStop,
    start,
    stop,
    closeAudit,
    approve,
    decide,
    saveSettings,
    checkGateway,
  } = useTaskSession();
  const [task, setTask] = useState("");
  const [runtimeOverride, setRuntimeOverride] = useState<RuntimeOverride>("auto");
  const [showSettings, setShowSettings] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [form, setForm] = useState(settings);
  const [answer, setAnswer] = useState("");

  // The stored settings arrive asynchronously; adopt them until the user
  // starts editing, after which the form is theirs.
  useEffect(() => setForm(settings), [settings]);

  // Each new prompt gets a fresh answer box.
  useEffect(() => setAnswer(""), [pending?.actionIndex, pending?.kind]);

  const started = state === "scanning" || state === "sanitized" || state === "planning" ||
    state === "awaiting_approval" || state === "executing";
  const canStart = (state === "idle" || state === "stopped" || state === "failed" || state === "completed") &&
    task.trim().length > 0;
  const badgeClass = useMemo(() => `badge badge--${state}`, [state]);
  // Before a gateway check, fall back to the contract's allowlist so the panel
  // is usable offline; after one, show exactly what that gateway enabled.
  const providerOptions = useMemo(
    () => providers?.map((entry) => entry.id) ?? [...PROVIDER_IDS],
    [providers],
  );
  const isCloud = CLOUD_PROVIDER_IDS.includes(form.providerId);

  // What the plan would need from the private-values store, and whether it is
  // there. Anything missing will be refused at run time, so it is worth saying
  // before the user approves.
  const planValues = useMemo(() => (plan ? planPlaceholders(plan) : []), [plan]);
  const destinationWarnings = useMemo(
    () =>
      new Set(
        (plan?.actions ?? [])
          .filter((action) => action.type === "navigate" && !destinationWasNamed(task, action.url))
          .map((action) => (action.type === "navigate" ? action.url : "")),
      ),
    [plan, task],
  );

  function updateRow(index: number, patch: Partial<PrivateValueRow>) {
    setPrivateValues((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  }

  async function startTask() {
    await start(task, runtimeOverride);
  }

  return (
    <main className="panel">
      <header className="panel__header">
        <h1>Orka</h1>
        <p className="panel__subtitle">On-device privacy browser agent</p>
      </header>

      <section className="card">
        <div className="status-row">
          <span className={badgeClass}>{STATE_LABEL[state]}</span>
          {runtime && <span className="meta">{runtime.mode}</span>}
        </div>
        {requestError && <p className="error-text">{requestError}</p>}
        {failure && <p className="error-text">{failure.message}</p>}
        {planError && <p className="error-text">{planError.message}</p>}
      </section>

      <section className="card">
        <label className="field">
          <span className="field__label">Provider</span>
          <select
            value={form.providerId}
            disabled={started}
            onChange={(event) => {
              const next = { ...form, providerId: event.target.value as ProviderId };
              setForm(next);
              void saveSettings(next);
            }}
          >
            {providerOptions.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        {isCloud && (
          <p className="notice">
            The redacted screenshot and element list leave this machine for this provider. The
            original capture and detection map never do.
          </p>
        )}

        <label className="field">
          <span className="field__label">Runtime</span>
          <select
            value={runtimeOverride}
            disabled={started}
            onChange={(event) => setRuntimeOverride(event.target.value as RuntimeOverride)}
          >
            {RUNTIMES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Task</span>
          <textarea
            value={task}
            disabled={started}
            onChange={(event) => setTask(event.target.value)}
            placeholder="e.g. Find the pricing page and summarize the plans."
            rows={3}
          />
        </label>

        <button
          type="button"
          className="button button--link"
          onClick={() => setShowValues((open) => !open)}
        >
          {showValues ? "Hide private values" : "Private values"}
        </button>

        {showValues && (
          <div className="settings">
            {privateValues.map((row, index) => (
              <div className="value-row" key={index}>
                <input
                  type="text"
                  value={row.name}
                  placeholder="PHONE_1"
                  aria-label={`Private value ${index + 1} name`}
                  disabled={started}
                  onChange={(event) => updateRow(index, { name: event.target.value })}
                />
                <input
                  type="text"
                  value={row.value}
                  placeholder="value"
                  aria-label={`Private value ${index + 1}`}
                  autoComplete="off"
                  disabled={started}
                  onChange={(event) => updateRow(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  className="button button--ghost-neutral"
                  disabled={started || privateValues.length === 1}
                  onClick={() => setPrivateValues((rows) => rows.filter((_, position) => position !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="card--actions">
              <button
                type="button"
                className="button button--ghost-neutral"
                disabled={started || privateValues.length >= 10}
                onClick={() => setPrivateValues((rows) => [...rows, EmptyValueRow()])}
              >
                Add value
              </button>
            </div>
            <p className="panel__footnote">
              Mention a value in your task as <code>[PHONE_1]</code>. Orka types it only when the
              plan asks for that name and you allow that step. Values stay in this browser, are
              never sent to the planner, and are dropped when the task ends.
            </p>
          </div>
        )}

        <button
          type="button"
          className="button button--link"
          onClick={() => setShowSettings((open) => !open)}
        >
          {showSettings ? "Hide gateway settings" : "Gateway settings"}
        </button>

        {showSettings && (
          <div className="settings">
            <label className="field">
              <span className="field__label">Gateway URL</span>
              <input
                type="url"
                value={form.gatewayUrl}
                onChange={(event) => setForm({ ...form, gatewayUrl: event.target.value })}
                placeholder="http://127.0.0.1:8787"
              />
            </label>
            <label className="field">
              <span className="field__label">Gateway token</span>
              <input
                type="password"
                value={form.gatewayToken}
                autoComplete="off"
                onChange={(event) => setForm({ ...form, gatewayToken: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Model override (optional)</span>
              <input
                type="text"
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                placeholder="Provider default"
              />
            </label>
            <div className="card--actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void saveSettings(form)}
              >
                Save
              </button>
              <button
                type="button"
                className="button button--ghost-neutral"
                onClick={() => void checkGateway()}
              >
                Check gateway
              </button>
            </div>
            {gatewayStatus && <p className="meta">{gatewayStatus}</p>}
            <p className="panel__footnote">
              Provider API keys live in the gateway's environment, never in this extension. Only the
              gateway token is stored here.
            </p>
          </div>
        )}
      </section>

      <section className="card card--actions">
        {(state === "idle" || state === "stopped" || state === "failed" || state === "completed") && (
          <button type="button" className="button button--primary" disabled={!canStart} onClick={() => void startTask()}>
            {state === "idle" ? "Start task" : "Start new task"}
          </button>
        )}
        {state === "awaiting_approval" && (
          <button type="button" className="button button--primary" onClick={() => void approve()}>
            Approve &amp; run
          </button>
        )}
        {canStop && (
          <button type="button" className="button button--stop" onClick={() => void stop()}>
            Stop
          </button>
        )}
        {(state === "sanitized" || state === "awaiting_approval" || state === "failed" ||
          state === "completed") && (
          <button type="button" className="button button--ghost" onClick={() => void closeAudit()}>
            Dismiss session
          </button>
        )}
      </section>

      {plan && (
        <section className="card">
          <div className="status-row">
            <h2>Proposed plan</h2>
            {planMeta && (
              <span className="meta">
                {planMeta.providerId} · {planMeta.model} · {planMeta.latencyMs} ms
              </span>
            )}
          </div>
          <ol className="plan">
            {plan.actions.map((action, index) => (
              <li key={`${action.type}-${index}`} className="plan__item">
                <div className="plan__head">
                  <span className="plan__type">{action.type}</span>
                  <span className={`chip chip--${action.risk}`}>{RISK_LABEL[action.risk]}</span>
                </div>
                <div className="plan__detail">{actionDetail(action)}</div>
                <div className="meta">{action.reason}</div>
                {action.type === "navigate" && destinationWarnings.has(action.url) && (
                  <div className="notice">
                    This destination was not named in your task. Check it before you approve.
                  </div>
                )}
              </li>
            ))}
          </ol>
          {planValues.length > 0 && (
            <div className="meta">
              Private values this plan uses:{" "}
              {planValues
                .map((name) =>
                  declaredValueNames.includes(name) ? `[${name}] (saved)` : `[${name}] (not saved)`,
                )
                .join(", ")}
            </div>
          )}
          <p className="panel__footnote">
            {state === "awaiting_approval"
              ? "Nothing has run. Approving starts the first step; risky steps are confirmed one at a time."
              : "This plan has been approved. Steps are confirmed one at a time as they come up."}
          </p>
        </section>
      )}

      {pending?.kind === "confirm" && (
        <section className="card card--prompt">
          <div className="status-row">
            <h2>{CONFIRMATION_TITLE[pending.confirmation]}</h2>
            <span className={`chip chip--${pending.risk}`}>{RISK_LABEL[pending.risk]}</span>
          </div>
          <p className="plan__detail">{pending.detail}</p>
          <div className="card--actions">
            <button type="button" className="button button--primary" onClick={() => void decide(true)}>
              Allow once
            </button>
            <button type="button" className="button button--ghost-neutral" onClick={() => void decide(false)}>
              Deny and stop
            </button>
          </div>
        </section>
      )}

      {pending?.kind === "ask_user" && (
        <section className="card card--prompt">
          <h2>Orka needs to ask</h2>
          <p className="plan__detail">{pending.prompt}</p>
          <div className="meta">{pending.detail}</div>
          <textarea
            value={answer}
            rows={2}
            placeholder="Your answer"
            aria-label="Answer to the planner's question"
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="card--actions">
            <button type="button" className="button button--primary" onClick={() => void decide(true, answer)}>
              Continue
            </button>
            <button type="button" className="button button--ghost-neutral" onClick={() => void decide(false)}>
              Stop here
            </button>
          </div>
          <p className="panel__footnote">
            Your answer stays in this panel. It is never sent to the planner, and it is not kept
            after the session.
          </p>
        </section>
      )}

      {outcomes.length > 0 && (
        <section className="card">
          <div className="status-row">
            <h2>Run log</h2>
            {run && (
              <span className="meta">
                {RUN_STATUS_LABEL[run.status]}
                {run.stopReason ? ` · ${STOP_REASON_LABEL[run.stopReason]}` : ""}
              </span>
            )}
          </div>
          {run?.summary && <p className="plan__detail">{run.summary}</p>}
          {run?.failure && <p className="error-text">{run.failure.message}</p>}
          <ol className="plan">
            {outcomes.map((entry) => (
              <li key={entry.actionIndex} className="plan__item">
                <div className="plan__head">
                  <span className="plan__type">{entry.action.type}</span>
                  <span
                    className={
                      entry.outcome.status === "success"
                        ? "chip chip--low"
                        : entry.outcome.status === "skipped"
                          ? "chip chip--medium"
                          : "chip chip--high"
                    }
                  >
                    {OUTCOME_LABEL[entry.outcome.status]}
                  </span>
                  {entry.outcome.code && <span className="meta">{entry.outcome.code}</span>}
                </div>
                <div className="plan__detail">{entry.detail}</div>
              </li>
            ))}
          </ol>
          <p className="panel__footnote">
            Only names of private values appear here, never their contents.
          </p>
        </section>
      )}

      {audit && observation && (
        <section className="card audit">
          <div className="status-row">
            <h2>Local audit</h2>
            <span className="meta">Original never leaves this device</span>
          </div>
          <div className="audit__images">
            <figure>
              <figcaption>Original (local only)</figcaption>
              <img src={screenshotUrl(audit.originalScreenshot)} alt="Original active-tab capture" />
            </figure>
            <figure>
              <figcaption>Redacted observation</figcaption>
              <img src={screenshotUrl(audit.redactedScreenshot)} alt="Opaque redacted active-tab capture" />
            </figure>
          </div>
          <p className="meta">
            Sanitized origin: {observation.urlOrigin}. Runtime: {audit.runtime.mode}.
          </p>
          <div className="audit__summary">
            {audit.redactionSummary.length === 0
              ? "No sensitive regions detected."
              : audit.redactionSummary.map((entry) => `${entry.category}: ${entry.count}`).join(" · ")}
          </div>
          <p className="panel__footnote">
            The exact detection map and original pixels remain in extension memory and are released when this session closes.
          </p>
        </section>
      )}

      <p className="panel__footnote">
        Orka only acts on the tab you are looking at, for up to 10 actions or 90 seconds. Stop ends
        the task at any point.
      </p>
    </main>
  );
}

export default App;

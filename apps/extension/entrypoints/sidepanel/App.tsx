import { useEffect, useMemo, useState } from "react";
import {
  CLOUD_PROVIDER_IDS,
  PROVIDER_IDS,
  type Action,
  type ProviderId,
  type TaskState,
} from "@orka/contracts";
import { useTaskSession } from "./useTaskSession.ts";
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
    canStop,
    start,
    stop,
    closeAudit,
    saveSettings,
    checkGateway,
  } = useTaskSession();
  const [task, setTask] = useState("");
  const [runtimeOverride, setRuntimeOverride] = useState<RuntimeOverride>("auto");
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(settings);

  // The stored settings arrive asynchronously; adopt them until the user
  // starts editing, after which the form is theirs.
  useEffect(() => setForm(settings), [settings]);

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
        {canStop && (
          <button type="button" className="button button--stop" onClick={() => void stop()}>
            Stop
          </button>
        )}
        {(state === "sanitized" || state === "awaiting_approval" || state === "failed") && (
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
              </li>
            ))}
          </ol>
          <p className="panel__footnote">
            Nothing has run. Approval and execution arrive in Phase 4.
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
        Phase 3 stops at a proposed plan. Approval and browser actions are not enabled until Phase 4.
      </p>
    </main>
  );
}

export default App;

import { useMemo, useState } from "react";
import type { TaskState } from "@orka/contracts";
import { useTaskSession } from "./useTaskSession.ts";
import type { RuntimeOverride } from "../../shared/messages.ts";
import "./App.css";

const PROVIDERS = [
  { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek (cloud, default)" },
  { id: "lmstudio-local", label: "LM Studio (local)" },
] as const;

const RUNTIMES: readonly { id: RuntimeOverride; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "gpu", label: "GPU preferred" },
  { id: "balanced", label: "Balanced" },
  { id: "wasm", label: "CPU / WASM" },
];

const STATE_LABEL: Record<TaskState, string> = {
  idle: "Idle",
  scanning: "Scanning locally",
  sanitized: "Sanitized context ready",
  planning: "Waiting on planner",
  awaiting_approval: "Awaiting your approval",
  executing: "Executing",
  stopped: "Stopped",
  completed: "Completed",
  failed: "Sanitization failed",
};

function screenshotUrl(screenshot: { mimeType: string; dataBase64: string }): string {
  return `data:${screenshot.mimeType};base64,${screenshot.dataBase64}`;
}

function App() {
  const {
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
  } = useTaskSession();
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
  const [runtimeOverride, setRuntimeOverride] = useState<RuntimeOverride>("auto");

  const started = state === "scanning" || state === "sanitized" || state === "planning" ||
    state === "awaiting_approval" || state === "executing";
  const canStart = (state === "idle" || state === "stopped" || state === "failed" || state === "completed") &&
    task.trim().length > 0;
  const badgeClass = useMemo(() => `badge badge--${state}`, [state]);

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
      </section>

      <section className="card">
        <label className="field">
          <span className="field__label">Provider</span>
          <select
            value={provider}
            disabled={started}
            onChange={(event) => setProvider(event.target.value)}
          >
            {PROVIDERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

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
        {state === "sanitized" && (
          <button type="button" className="button button--ghost" onClick={() => void closeAudit()}>
            Close local audit
          </button>
        )}
      </section>

      {audit && observation && (
        <section className="card audit">
          <div className="status-row">
            <h2>Local audit</h2>
            <span className="meta">Not sent to a planner</span>
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
            The exact detection map and original pixels remain in extension memory and are released when this audit closes.
          </p>
        </section>
      )}

      <p className="panel__footnote">
        Phase 2 stops after local sanitization. Planner transport and browser actions are not enabled until Phase 3.
      </p>
    </main>
  );
}

export default App;

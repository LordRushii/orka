import { useEffect, useMemo, useState } from "react";
import {
  CLOUD_PROVIDER_IDS,
  MAX_ROUNDS_PER_SESSION,
  PROVIDER_IDS,
  type ProviderId,
  type TaskState,
} from "@orka/contracts";
import { destinationWasNamed, planPlaceholders } from "../../shared/executorPolicy.ts";
import { METRIC_PHASE_LABEL, SIH_WEIGHTS, type MetricPhase } from "../../shared/metrics.ts";
import { useTaskSession, type PrivateValueRow } from "./useTaskSession.ts";
import { ChatThread } from "./ChatThread.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { formatMs } from "./panelFormat.ts";
import type { RuntimeOverride } from "../../shared/messages.ts";
import "./App.css";

/** The session's round ceiling, so the panel's copy cannot drift from policy. */
const MAX_ROUNDS = MAX_ROUNDS_PER_SESSION;

const RUNTIMES: readonly { id: RuntimeOverride; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "gpu", label: "GPU preferred" },
  { id: "balanced", label: "Balanced" },
  { id: "wasm", label: "CPU / WASM" },
];

const PROVIDER_LABEL: Record<ProviderId, string> = {
  mock: "Mock (dev/test only, not enabled by default)",
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

function EmptyValueRow(): PrivateValueRow {
  return { name: "", value: "" };
}

/**
 * The side panel: **a conversation, with the local evidence pinned beside it**
 * (Phase 8, docs2/04-PRODUCT-PRD.md §1).
 *
 * Layout is the privacy story as much as the UX one. The thread scrolls; the
 * Local audit and the outbound view do not. A person deciding on a step can
 * always look down and see what was redacted and what left the machine, at the
 * moment they are deciding -- which is exactly when it matters.
 *
 * The settings and the private-value rows that used to be the panel's whole
 * body are now a drawer and a composer control: still here, no longer the
 * first thing between a user and their task.
 */
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
    round,
    transcript,
    pending,
    metrics,
    outbound,
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

  const started =
    state === "scanning" || state === "sanitized" || state === "planning" ||
    state === "awaiting_approval" || state === "executing";
  const canStart =
    (state === "idle" || state === "stopped" || state === "failed" || state === "completed") &&
    task.trim().length > 0;
  const badgeClass = useMemo(() => `badge badge--${state}`, [state]);
  // Before a gateway check, fall back to the contract's allowlist so the panel
  // is usable offline; after one, show exactly what that gateway enabled.
  const providerOptions = useMemo(
    () => providers?.map((entry) => entry.id) ?? [...PROVIDER_IDS],
    [providers],
  );
  const isCloud = CLOUD_PROVIDER_IDS.includes(form.providerId);

  // What the step would need from the private-values store, and whether it is
  // there. Anything missing is refused at run time, so it is worth saying
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

  function submitTask() {
    if (canStart) void startTask();
  }

  return (
    <main className="panel">
      <header className="panel__header">
        <div>
          <h1>Orka</h1>
          <p className="panel__subtitle">On-device privacy browser agent</p>
        </div>
        <button
          type="button"
          className="button button--link"
          onClick={() => setShowSettings((open) => !open)}
        >
          {showSettings ? "Hide settings" : "Settings"}
        </button>
      </header>

      <section className="panel__status">
        <div className="status-row">
          <span className={badgeClass}>{STATE_LABEL[state]}</span>
          <span className="panel__status-meta">
            {round > 0 && <span className="meta">Round {round} of {MAX_ROUNDS}</span>}
            {runtime && <span className="meta">{runtime.mode}</span>}
            {planMeta && <span className="meta">{planMeta.providerId} · {planMeta.model}</span>}
          </span>
          {canStop && (
            <button type="button" className="button button--stop" onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>
        {requestError && <p className="error-text">{requestError}</p>}
        {failure && <p className="error-text">{failure.message}</p>}
        {planError && <p className="error-text">{planError.message}</p>}
        {destinationWarnings.size > 0 && (
          <p className="notice">
            This step leaves for a destination you did not name in your task. Check it before you
            approve.
          </p>
        )}
        {planValues.length > 0 && (
          <p className="meta">
            Private values this step uses:{" "}
            {planValues
              .map((name) =>
                declaredValueNames.includes(name) ? `[${name}] (saved)` : `[${name}] (not saved)`,
              )
              .join(", ")}
          </p>
        )}
      </section>

      {showSettings && (
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
            <button type="button" className="button button--primary" onClick={() => void saveSettings(form)}>
              Save
            </button>
            <button type="button" className="button button--ghost-neutral" onClick={() => void checkGateway()}>
              Check gateway
            </button>
          </div>
          {gatewayStatus && <p className="meta">{gatewayStatus}</p>}
          <p className="panel__footnote">
            Provider API keys live in the gateway's environment, never in this extension. Only the
            gateway token is stored here.
          </p>
        </section>
      )}

      <ChatThread
        transcript={transcript}
        answer={answer}
        onAnswerChange={setAnswer}
        onApprove={() => void approve()}
        onDecide={(approved, given) => void decide(approved, given)}
        onStop={() => void stop()}
        footer={
          metrics ? (
            <section className="card">
              <div className="status-row">
                <h2>This run, measured locally</h2>
                <span className="meta">
                  {METRIC_PHASE_LABEL["capture"]} to {formatMs(metrics.totalMs)} in total
                </span>
              </div>
              <ul className="plan metrics__list">
                {metrics.samples.map((sample) => (
                  <li key={sample.phase} className="plan__item">
                    <div className="plan__head">
                      <span className="plan__type">
                        {METRIC_PHASE_LABEL[sample.phase as MetricPhase]}
                      </span>
                      <span className="meta">
                        {sample.count > 1 ? `${sample.count} × ` : ""}
                        {formatMs(sample.ms)}
                      </span>
                    </div>
                  </li>
                ))}
                {metrics.samples.length === 0 && (
                  <li className="plan__item">
                    <div className="plan__detail">No phase has finished yet.</div>
                  </li>
                )}
              </ul>
              <p className="meta">
                Runtime {metrics.runtime}
                {metrics.resource ? ` · Local JS heap ${metrics.resource.heapUsedMb} MB` : ""}
                {` · ${metrics.categoryCounts.length} categories redacted`}
              </p>
              <div className="audit__summary">
                <strong>SIH weights, as the score is defined</strong>
                <ul className="metrics__weights">
                  {SIH_WEIGHTS.map((entry) => (
                    <li key={entry.id}>
                      <span className="meta">
                        {Math.round(entry.weight * 100)}% · {entry.label}
                      </span>
                      <span className={`chip chip--${entry.measurableLocally ? "low" : "medium"}`}>
                        {entry.measurableLocally ? "measured here" : "not measurable locally"}
                      </span>
                      {!entry.measurableLocally && <span className="meta"> {entry.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="panel__footnote">
                Timings are this device's own numbers, and two of the five weights are all a browser
                can honestly score without labelled data. The rest are gated by the checked-in
                benchmark corpus; nothing here is an estimate dressed as a measurement.
              </p>
            </section>
          ) : undefined
        }
      />

      <section className="panel__composer">
        <label className="field">
          <span className="field__label">Your task</span>
          <textarea
            value={task}
            disabled={started}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              // Enter starts the task; Shift+Enter keeps the newline, because a
              // task can be a sentence or two.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitTask();
              }
            }}
            placeholder="e.g. Reply to this email: we'll do the meeting Monday."
            rows={2}
          />
        </label>
        <div className="card--actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!canStart}
            onClick={() => void startTask()}
          >
            {state === "idle" ? "Start task" : "Start new task"}
          </button>
          <button
            type="button"
            className="button button--link"
            onClick={() => setShowValues((open) => !open)}
          >
            {showValues ? "Hide private values" : "Private values"}
          </button>
        </div>

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
      </section>

      <EvidencePanel
        audit={audit}
        observation={observation}
        outbound={outbound}
        onDismiss={() => void closeAudit()}
      />

      <p className="panel__footnote">
        Orka only acts on the tab you are looking at, for at most {MAX_ROUNDS} rounds with 90 seconds
        of active work each. Time spent waiting for your approval does not count. Stop ends the task
        at any point. Step details name a private value by its placeholder, never by its contents.
      </p>
    </main>
  );
}

export default App;

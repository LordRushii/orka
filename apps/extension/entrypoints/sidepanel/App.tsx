import { useEffect, useMemo, useState } from "react";
import {
  CLOUD_PROVIDER_IDS,
  MAX_ROUNDS_PER_SESSION,
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
import {
  CONFIDENCE_BAND_LABEL,
  type CategoryBandCount,
  type ModelVersion,
} from "../../shared/localReport.ts";
import {
  METRIC_PHASE_LABEL,
  SIH_WEIGHTS,
  type LocalMetrics,
  type MetricPhase,
} from "../../shared/metrics.ts";
import { formatBytes, type OutboundView } from "../../shared/outboundView.ts";
import { useTaskSession, type PrivateValueRow } from "./useTaskSession.ts";
import type { LocalAuditView, RuntimeOverride } from "../../shared/messages.ts";
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

/** `1.2 s`, `840 ms` -- a duration a person can read without counting zeros. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  return ms >= 1000 ? `${Math.round((ms / 1000) * 10) / 10} s` : `${Math.round(ms)} ms`;
}

/**
 * Confidence bands for one capture, in the order the detections were counted.
 * Bands, not scores: enough to judge the redaction, without printing the map.
 */
function bandSummary(bands: readonly CategoryBandCount[]): string {
  if (bands.length === 0) return "No detections.";
  return bands
    .map((entry) => `${entry.category} ${CONFIDENCE_BAND_LABEL[entry.band].toLowerCase()} ×${entry.count}`)
    .join(" · ");
}

function modelSummary(models: readonly ModelVersion[]): string {
  return models.map((model) => `${model.role} ${model.version}`).join(" · ");
}

/**
 * Where a scan's time actually went (docs2/02-pii-engine-speed.md Step 0).
 * OCR and face run concurrently, so this reports each stage's own span rather
 * than pretending they add up to the total.
 */
function scanTimingSummary(timings: LocalAuditView["timings"]): string | undefined {
  if (!timings) return undefined;
  const ocr = timings.tileOcrMs.length > 0
    ? `OCR ${formatMs(timings.ocrMs)} (full ${formatMs(timings.fullImageOcrMs)} + ${timings.tileOcrMs.length} tile${timings.tileOcrMs.length === 1 ? "" : "s"} ${formatMs(timings.tileOcrMs.reduce((total, ms) => total + ms, 0))})`
    : `OCR ${formatMs(timings.ocrMs)}`;
  return `${ocr} · face ${formatMs(timings.faceMs)} · encode ${formatMs(timings.encodeMs)}`;
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
    round,
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
          {round > 0 && <span className="meta">Round {round} of {MAX_ROUNDS}</span>}
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
            Approve step
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
              ? "Nothing has run yet. Approving runs this one step; Orka then re-reads the page and proposes the next."
              : "This step has been approved. Risky steps are confirmed one at a time as they come up."}
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
            {outcomes.map((entry, position) => (
              <li key={`${position}-${entry.action.type}`} className="plan__item">
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
          {audit.originalScreenshot && audit.redactedScreenshot ? (
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
          ) : (
            <p className="meta">
              Snapshot-only round: this step was decided from the page's accessibility tree, so no
              pixels were captured at all.
            </p>
          )}
          <p className="meta">
            Sanitized origin: {observation.urlOrigin}. Runtime: {audit.runtime.mode}.
          </p>
          <div className="audit__summary">
            {audit.redactionSummary.length === 0
              ? "No sensitive regions detected."
              : audit.redactionSummary.map((entry) => `${entry.category}: ${entry.count}`).join(" · ")}
          </div>
          <p className="meta">Detection confidence: {bandSummary(audit.confidenceBands)}</p>
          <p className="meta">Models: {modelSummary(audit.models)}</p>
          {scanTimingSummary(audit.timings) && (
            <p className="meta">Local scan cost: {scanTimingSummary(audit.timings)}</p>
          )}
          <p className="panel__footnote">
            Bands, not boxes: the exact detection map and the original pixels stay in extension
            memory and are released when this session closes.
          </p>
        </section>
      )}

      {metrics && (
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
            can honestly score without labelled data. The rest wait on the benchmark corpus Phase 5
            defers; nothing here is an estimate dressed as a measurement.
          </p>
        </section>
      )}

      {outbound && (
        <section className="card">
          <div className="status-row">
            <h2>What left this device</h2>
            <span className="meta">
              {outbound.forbiddenKey === null
                ? `no forbidden field · ${formatBytes(outbound.bytes)}`
                : `unexpected field: ${outbound.forbiddenKey}`}
            </span>
          </div>
          <div className="audit__summary">
            <ul className="metrics__weights">
              {outbound.fields.map((field) => (
                <li key={field.path}>
                  <span className="plan__type">{field.path}</span>
                  <span className="meta">
                    {" "}
                    {field.kind}
                    {field.kind === "array" || field.kind === "object"
                      ? ` (${field.size})`
                      : field.kind === "string"
                        ? ` (${field.size} chars)`
                        : ""}
                    {field.note ? ` · ${field.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="meta">
            Field names and sizes only. The values are not shown here because they are not the
            point: what matters is that these are the only fields the contract has.
          </p>
          <div className="audit__summary">
            <strong>Never in the request</strong>
            <ul className="metrics__weights">
              {outbound.absent.map((group) => (
                <li key={group.label}>
                  <span className="plan__type">{group.label}</span>
                  <span className="meta"> {group.detail}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="panel__footnote">
            Described from the request body itself, so this list cannot drift away from what is
            actually sent.
          </p>
        </section>
      )}

      <p className="panel__footnote">
        Orka only acts on the tab you are looking at, for at most {MAX_ROUNDS} rounds with 90 seconds
        of active work each. Time spent waiting for your approval does not count. Stop ends the task
        at any point.
      </p>
    </main>
  );
}

export default App;

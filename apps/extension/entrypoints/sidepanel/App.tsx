import { useMemo, useState } from 'react';
import type { TaskEventType, TaskState } from '@orka/contracts';
import { useTaskSession } from './useTaskSession.ts';
import './App.css';

const PROVIDERS = [
  { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek (cloud, default)' },
  { id: 'lmstudio-local', label: 'LM Studio (local)' },
] as const;

const RUNTIMES = [
  { id: 'auto', label: 'Auto' },
  { id: 'gpu', label: 'GPU preferred' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'wasm', label: 'CPU / WASM' },
] as const;

const STATE_LABEL: Record<TaskState, string> = {
  idle: 'Idle',
  scanning: 'Scanning locally',
  sanitized: 'Sanitized context ready',
  planning: 'Waiting on planner',
  awaiting_approval: 'Awaiting your approval',
  executing: 'Executing',
  stopped: 'Stopped',
  completed: 'Completed',
  failed: 'Failed',
};

/** Happy-path event for the primary action button, per state. */
const NEXT_EVENT: Partial<Record<TaskState, { event: TaskEventType; label: string }>> = {
  idle: { event: 'START_SCAN', label: 'Start task' },
  scanning: { event: 'SANITIZED', label: 'Mark sanitized (mock)' },
  sanitized: { event: 'START_PLANNING', label: 'Send to planner' },
  planning: { event: 'PLAN_READY', label: 'Plan ready (mock)' },
  awaiting_approval: { event: 'APPROVE', label: 'Approve & execute' },
  executing: { event: 'COMPLETE', label: 'Mark complete (mock)' },
  stopped: { event: 'RESET', label: 'Start new task' },
  completed: { event: 'RESET', label: 'Start new task' },
  failed: { event: 'RESET', label: 'Start new task' },
};

/** Failure event exposed as a secondary control, per state. */
const FAILURE_EVENT: Partial<Record<TaskState, { event: TaskEventType; label: string }>> = {
  scanning: { event: 'SANITIZATION_FAILED', label: 'Report sanitization failure' },
  planning: { event: 'PLAN_FAILED', label: 'Report planner failure' },
  executing: { event: 'EXECUTION_FAILED', label: 'Report execution failure' },
};

function App() {
  const { state, actionCount, can, send, stop } = useTaskSession();
  const [task, setTask] = useState('');
  const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
  const [runtime, setRuntime] = useState<string>(RUNTIMES[0].id);

  const started = state !== 'idle';
  const canStop = can('STOP');
  const primary = NEXT_EVENT[state];
  const failure = FAILURE_EVENT[state];
  const primaryDisabled = state === 'idle' && task.trim().length === 0;

  const badgeClass = useMemo(() => `badge badge--${state}`, [state]);

  return (
    <main className="panel">
      <header className="panel__header">
        <h1>Orka</h1>
        <p className="panel__subtitle">On-device privacy browser agent</p>
      </header>

      <section className="card">
        <div className="status-row">
          <span className={badgeClass}>{STATE_LABEL[state]}</span>
          {state === 'executing' && (
            <span className="meta">{actionCount} / 10 actions</span>
          )}
        </div>
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
            value={runtime}
            disabled={started}
            onChange={(event) => setRuntime(event.target.value)}
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
        {primary && (
          <button
            type="button"
            className="button button--primary"
            disabled={primaryDisabled}
            onClick={() => send(primary.event)}
          >
            {primary.label}
          </button>
        )}
        {failure && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => send(failure.event)}
          >
            {failure.label}
          </button>
        )}
        <button
          type="button"
          className="button button--stop"
          disabled={!canStop}
          onClick={() => stop()}
        >
          Stop
        </button>
      </section>

      <p className="panel__footnote">
        Phase 1 scaffold: capture, redaction, planning, and execution are
        mocked here to exercise the Task Session state machine end to end.
        Real behavior ships in later phases.
      </p>
    </main>
  );
}

export default App;

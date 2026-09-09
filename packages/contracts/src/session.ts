/**
 * TaskSession is the deep module that owns Task Session ordering, the
 * 10-action/90-second policy limits, and Stop behavior. UI code (the side
 * panel) only reads `state` and calls these methods; it must never encode
 * transition rules itself.
 */

export const TASK_STATES = [
  "idle",
  "scanning",
  "sanitized",
  "planning",
  "awaiting_approval",
  "executing",
  "stopped",
  "completed",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States where a task is actively in flight and Stop is meaningful. */
export const ACTIVE_STATES: readonly TaskState[] = [
  "scanning",
  "sanitized",
  "planning",
  "awaiting_approval",
  "executing",
];

/** States a session cannot leave once entered. */
export const TERMINAL_STATES: readonly TaskState[] = [
  "stopped",
  "completed",
  "failed",
];

export type TaskEventType =
  | "START_SCAN"
  | "SANITIZED"
  | "SANITIZATION_FAILED"
  | "START_PLANNING"
  | "PLAN_READY"
  | "PLAN_FAILED"
  | "APPROVE"
  | "COMPLETE"
  | "EXECUTION_FAILED"
  | "STOP"
  | "RESET";

/** Explicit allow-list of edges. Any pair not listed here is rejected. */
const TRANSITIONS: Record<TaskState, Partial<Record<TaskEventType, TaskState>>> = {
  idle: {
    START_SCAN: "scanning",
  },
  scanning: {
    SANITIZED: "sanitized",
    SANITIZATION_FAILED: "failed",
    STOP: "stopped",
  },
  sanitized: {
    START_PLANNING: "planning",
    STOP: "stopped",
  },
  planning: {
    PLAN_READY: "awaiting_approval",
    PLAN_FAILED: "failed",
    STOP: "stopped",
  },
  awaiting_approval: {
    APPROVE: "executing",
    STOP: "stopped",
  },
  executing: {
    COMPLETE: "completed",
    EXECUTION_FAILED: "failed",
    STOP: "stopped",
  },
  stopped: {
    RESET: "idle",
  },
  completed: {
    RESET: "idle",
  },
  failed: {
    RESET: "idle",
  },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly event: TaskEventType,
  ) {
    super(`Cannot apply event "${event}" from state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

export type TaskSessionOptions = {
  maxActions?: number;
  maxDurationMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_ACTIONS = 10;
const DEFAULT_MAX_DURATION_MS = 90_000;

/**
 * A single Task Session. Construct one per user-initiated task; discard it
 * (or `RESET`) when the task reaches a terminal state.
 */
export class TaskSession {
  private _state: TaskState = "idle";
  private _actionCount = 0;
  private _startedAt: number | null = null;
  private readonly maxActions: number;
  private readonly maxDurationMs: number;
  private readonly now: () => number;

  constructor(options: TaskSessionOptions = {}) {
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.now = options.now ?? Date.now;
  }

  get state(): TaskState {
    return this._state;
  }

  get actionCount(): number {
    return this._actionCount;
  }

  get isActive(): boolean {
    return ACTIVE_STATES.includes(this._state);
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.includes(this._state);
  }

  /** Milliseconds elapsed since the session left `idle`, or null if not started. */
  elapsedMs(): number | null {
    if (this._startedAt === null) return null;
    return this.now() - this._startedAt;
  }

  /** Whether `event` is legal from the current state, without applying it. */
  can(event: TaskEventType): boolean {
    return TRANSITIONS[this._state]?.[event] !== undefined;
  }

  /** Applies `event`, throwing InvalidTransitionError on an illegal edge. */
  send(event: TaskEventType): TaskState {
    const next = TRANSITIONS[this._state]?.[event];
    if (next === undefined) {
      throw new InvalidTransitionError(this._state, event);
    }
    if (this._state === "idle" && event === "START_SCAN") {
      this._startedAt = this.now();
      this._actionCount = 0;
    }
    if (event === "RESET") {
      this._startedAt = null;
      this._actionCount = 0;
    }
    this._state = next;
    return this._state;
  }

  /**
   * Stops the session from any active state. Returns false (without
   * throwing) when called from idle or a terminal state, since Stop is a
   * no-op rather than an error in those cases.
   */
  stop(): boolean {
    if (!this.can("STOP")) return false;
    this.send("STOP");
    return true;
  }

  /**
   * Records one executed action, auto-stopping the session when the policy
   * cap (default 10 actions / SECURITY-PRIVACY.md) is exceeded. Call this
   * only while `state === "executing"`.
   */
  recordAction(): { stopped: boolean } {
    if (this._state !== "executing") {
      throw new Error(
        `Cannot record an action while state is "${this._state}"; expected "executing"`,
      );
    }
    this._actionCount += 1;
    if (this._actionCount >= this.maxActions) {
      this.send("STOP");
      return { stopped: true };
    }
    return { stopped: false };
  }

  /**
   * Stops the session if the 90-second policy window (SECURITY-PRIVACY.md)
   * has elapsed. Safe to call from any state; it is a no-op when idle,
   * terminal, or still within budget.
   */
  enforceTimeout(): boolean {
    const elapsed = this.elapsedMs();
    if (elapsed === null || elapsed < this.maxDurationMs) return false;
    return this.stop();
  }
}

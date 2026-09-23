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
  | "NEXT_ROUND"
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
    // Multi-round loop: after one approved step runs, re-capture and re-plan
    // against the page as it now looks, instead of running a pre-baked plan.
    NEXT_ROUND: "scanning",
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
  maxRounds?: number;
  now?: () => number;
};

const DEFAULT_MAX_ACTIONS = 10;
const DEFAULT_MAX_DURATION_MS = 90_000;

/**
 * A Task Session has no fixed round ceiling: it runs a round at a time until the
 * planner emits `done`, the user Stops, a step is denied, or a single round
 * busts its own 90-second active budget. Every round is user-approved, so the
 * session is bounded by the person driving it rather than by a round counter. A
 * finite `maxRounds` can still be passed (tests use one), but the default is
 * unlimited. A "round" is one capture -> one plan -> one human decision ->
 * (if approved) one executed step. See docs2/04-PRODUCT-PRD.md §4.
 */

/**
 * A single Task Session. Construct one per user-initiated task; discard it
 * (or `RESET`) when the task reaches a terminal state.
 */
export class TaskSession {
  private _state: TaskState = "idle";
  private _actionCount = 0;
  private _startedAt: number | null = null;
  private _roundCount = 0;
  /** Machine time already banked in the current round (approval time excluded). */
  private _roundActiveMs = 0;
  /** Start of the current active segment, or null while paused (awaiting_approval/idle). */
  private _segmentStartedAt: number | null = null;
  private readonly maxActions: number;
  private readonly maxDurationMs: number;
  private readonly maxRounds: number;
  private readonly now: () => number;

  constructor(options: TaskSessionOptions = {}) {
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.maxRounds = options.maxRounds ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
  }

  get state(): TaskState {
    return this._state;
  }

  get actionCount(): number {
    return this._actionCount;
  }

  /** How many rounds `startRound()` has begun in this session. */
  get roundCount(): number {
    return this._roundCount;
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
    // Per-round active clock: banks machine time (capture+scan+plan+act) and
    // freezes while a step waits on the human, so the per-round budget never
    // counts confirmation time. See docs2/04-PRODUCT-PRD.md §4.
    if (next === "scanning") {
      // START_SCAN (round 1) or NEXT_ROUND (a later round): start fresh.
      this._roundActiveMs = 0;
      this._segmentStartedAt = this.now();
      this._actionCount = 0;
    } else if (next === "awaiting_approval") {
      // Pause: stop banking time while the user decides.
      if (this._segmentStartedAt !== null) {
        this._roundActiveMs += this.now() - this._segmentStartedAt;
        this._segmentStartedAt = null;
      }
    } else if (next === "executing" && event === "APPROVE") {
      // Resume: the human approved, machine work continues.
      this._segmentStartedAt = this.now();
    }
    if (event === "RESET") {
      this._startedAt = null;
      this._actionCount = 0;
      this._roundCount = 0;
      this._roundActiveMs = 0;
      this._segmentStartedAt = null;
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

  /**
   * Milliseconds of *machine* work banked in the current round -- the
   * capture+scan+plan+act segments, with any `awaiting_approval` pause
   * excluded. Zero before the first round begins.
   */
  roundActiveMs(): number {
    if (this._segmentStartedAt === null) return this._roundActiveMs;
    return this._roundActiveMs + (this.now() - this._segmentStartedAt);
  }

  /**
   * Begins a new round. With the default unlimited `maxRounds` this only counts
   * the round (for the panel's progress copy) and never stops. When a finite
   * `maxRounds` is set, it auto-stops the session once the cap is hit and
   * returns `{ stopped: true }` so the caller does not start another round.
   */
  startRound(): { stopped: boolean } {
    this._roundCount += 1;
    if (this._roundCount > this.maxRounds) {
      this.stop();
      return { stopped: true };
    }
    return { stopped: false };
  }

  /**
   * Per-round wall-clock guard: stops the session once this round's *active*
   * machine time exceeds the budget, ignoring time spent awaiting the human.
   * Safe to call from any state; a no-op before a round has started or when
   * still within budget.
   */
  enforceRoundTimeout(): boolean {
    if (this.roundActiveMs() < this.maxDurationMs) return false;
    return this.stop();
  }
}

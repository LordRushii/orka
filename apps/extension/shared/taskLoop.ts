import {
  type Action,
  type PriorActionSummary,
  type SanitizedObservation,
  type TaskSession,
} from "@orka/contracts";
import type { ApprovalDecision, StepRun } from "./executor.ts";

/**
 * The Phase 6 multi-round loop, in one injectable place (docs2/05-BUILD-ORDER.md
 * §6.3). `entrypoints/background.ts` binds this to the real browser, planner,
 * capture, and approval ports; a test binds it to fakes and drives the whole
 * observe → propose → confirm → act → re-observe cycle without a live network.
 *
 * The gateway stays stateless: every piece of cross-round memory lives here, in
 * the loop's `priorActions` list, and is handed to each round's `scan` so the
 * next observation carries it to the planner (`CaptureInput.priorActions`).
 */

/** How many prior steps the observation contract allows the loop to remember. */
const MAX_PRIOR_ACTIONS = 10;

export type TaskLoopPorts = {
  /**
   * Capture + sanitize what the page looks like *now*, with `priorActions`
   * (what already happened) folded into the observation. Fails closed.
   *
   * `visionRequired` (Phase 6.5) says whether this round must capture pixels.
   * The default round is snapshot-only; the port decides *how* to capture, but
   * never downgrades a required vision round to text-only.
   */
  scan(
    priorActions: PriorActionSummary[],
    visionRequired: boolean,
  ): Promise<SanitizedObservation>;
  /** Ask the planner for one step against the (redacted) observation. */
  plan(observation: SanitizedObservation): Promise<Action>;
  /** The user's decision on the round's proposed step. */
  requestApproval(action: Action): Promise<ApprovalDecision>;
  /** Execute the approved step; every per-action policy lives in the executor. */
  executeStep(action: Action): Promise<StepRun>;
  /** Publishes loop progress the side panel can render; numbers and prose only. */
  report(event: TaskLoopEvent): void;
};

export type TaskLoopEvent =
  | { type: "ROUND_STARTED"; round: number }
  | { type: "STEP_EXECUTED"; round: number; action: Action; summary: string };

/** What one executed step handed back to the loop: see executor.ts. */
export type { StepRun };

export type TaskLoopOptions = {
  /**
   * Whether the first round needs a screenshot. Set from the task itself: a
   * request to explain or look at the page is settled before the loop starts.
   * A later round can still switch vision on (see `StepRun.needsVision`).
   */
  visionRequired?: boolean;
};

export type TaskLoopRun = {
  status: "completed" | "stopped" | "failed";
  stopReason?: "user" | "denied" | "round_cap" | "timeout";
  summary: string;
  /** The step summaries the planner was shown, in the order they executed. */
  priorActions: PriorActionSummary[];
  /** How many plan calls the loop made -- one per round, asserted in tests. */
  rounds: number;
};

function summarize(run: StepRun): string {
  if (run.outcome?.reason) return run.outcome.reason.slice(0, 280);
  return run.summary.slice(0, 280);
}

/**
 * Runs the observe → plan-one-step → approve → execute-one-step → re-observe
 * loop until `done`, a denial, Stop, or a limit.
 *
 * Every round begins with `session.startRound()` (the round-cap guard) and
 * ends, when the step succeeded and was not terminal, with `NEXT_ROUND` -- the
 * `executing → scanning` edge -- so the session's per-round active clock resets
 * and approval time is never counted (docs2/04-PRODUCT-PRD.md §4).
 */
export async function runTaskLoop(
  task: { session: TaskSession },
  ports: TaskLoopPorts,
  options: TaskLoopOptions = {},
): Promise<TaskLoopRun> {
  const { session } = task;
  const priorActions: PriorActionSummary[] = [];
  let rounds = 0;
  let lastSummary = "Nothing to run.";
  // Snapshot-only until something demands pixels. Once a round needs vision it
  // stays on for the rest of the session: the page is the same page, and a
  // planner that needed to see it once will need to see it again.
  let visionRequired = options.visionRequired ?? false;

  while (true) {
    // Round guard before each capture: increments the count and auto-stops the
    // session once MAX_ROUNDS_PER_SESSION is hit.
    const round = session.startRound();
    if (round.stopped) {
      return {
        status: "stopped",
        stopReason: "round_cap",
        summary: `Orka stopped after ${rounds} round${rounds === 1 ? "" : "s"}: the round budget was reached.`,
        priorActions,
        rounds,
      };
    }
    rounds += 1;
    ports.report({ type: "ROUND_STARTED", round: session.roundCount });

    let observation: SanitizedObservation;
    try {
      observation = await ports.scan(priorActions, visionRequired);
    } catch {
      // Fail closed: a scan that cannot complete never reaches the planner. A
      // session that was stopped while the scan ran is a stop, not a failure.
      if (activeTaskGone(session)) {
        return { status: "stopped", stopReason: "user", summary: lastSummary, priorActions, rounds };
      }
      return { status: "failed", summary: lastSummary, priorActions, rounds };
    }
    if (activeTaskGone(session)) {
      return { status: "stopped", stopReason: "user", summary: lastSummary, priorActions, rounds };
    }

    let action: Action;
    try {
      action = await ports.plan(observation);
    } catch {
      if (activeTaskGone(session)) {
        return { status: "stopped", stopReason: "user", summary: lastSummary, priorActions, rounds };
      }
      return { status: "failed", summary: lastSummary, priorActions, rounds };
    }
    if (activeTaskGone(session)) {
      return { status: "stopped", stopReason: "user", summary: lastSummary, priorActions, rounds };
    }

    // The plan is a proposal: the user decides, every round, on the page as it
    // is now. A refusal is a stop, never a skip.
    const decision = await ports.requestApproval(action);
    if (!decision.approved) {
      session.stop();
      return {
        status: "stopped",
        stopReason: "denied",
        summary: "You declined a step, so Orka stopped.",
        priorActions,
        rounds,
      };
    }
    if (activeTaskGone(session)) {
      return { status: "stopped", stopReason: "user", summary: lastSummary, priorActions, rounds };
    }

    const run = await ports.executeStep(action);
    lastSummary = run.summary;
    ports.report({ type: "STEP_EXECUTED", round: session.roundCount, action, summary: run.summary });

    if (run.status === "completed") {
      if (action.type === "done") {
        return { status: "completed", summary: run.summary, priorActions, rounds };
      }
      // A successful non-terminal step: remember it for the planner, then
      // re-observe. `NEXT_ROUND` is only legal from `executing`, which is
      // exactly where a completed step leaves the session.
      if (session.can("NEXT_ROUND")) session.send("NEXT_ROUND");
      priorActions.push({
        type: action.type,
        outcome: run.outcome?.status === "success" ? "success" : "skipped",
        summary: summarize(run),
      });
      if (priorActions.length > MAX_PRIOR_ACTIONS) priorActions.shift();
      continue;
    }

    if (run.status === "stopped") {
      session.stop();
      return {
        status: "stopped",
        stopReason: run.stopReason === "timeout" ? "timeout" : "user",
        summary: run.summary,
        priorActions,
        rounds,
      };
    }

    // The step failed only because this round had no pixels to resolve its
    // target: re-observe with a screenshot and plan again. The failed attempt
    // is remembered, so the fresh plan sees what did not work. At most one such
    // switch per session, so a page that genuinely cannot be acted on still
    // fails instead of looping; the round cap bounds the retry either way.
    if (run.needsVision === true && !visionRequired) {
      priorActions.push({ type: action.type, outcome: "failure", summary: summarize(run) });
      if (priorActions.length > MAX_PRIOR_ACTIONS) priorActions.shift();
      visionRequired = true;
      if (session.can("NEXT_ROUND")) {
        session.send("NEXT_ROUND");
        continue;
      }
      if (activeTaskGone(session)) {
        return { status: "stopped", stopReason: "user", summary: run.summary, priorActions, rounds };
      }
    }

    return { status: "failed", summary: run.summary, priorActions, rounds };
  }
}

/**
 * The session's own state is the authority on "should this keep running": a
 * Stop from the panel, a timeout, or a replaced task all land here as a
 * terminal state, and the loop reads it instead of keeping its own flag.
 */
function activeTaskGone(session: TaskSession): boolean {
  return !session.isActive;
}

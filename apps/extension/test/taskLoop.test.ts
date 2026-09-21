import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  TaskSession,
  type Action,
  type PriorActionSummary,
  type SanitizedObservation,
} from "@orka/contracts";
import { runTaskLoop, type TaskLoopEvent, type TaskLoopPorts } from "../shared/taskLoop.ts";
import type { ApprovalDecision, StepRun } from "../shared/executor.ts";

/**
 * The Phase 6 multi-round loop, driven with fakes.
 *
 * `runTaskLoop` is the loop in one injectable place: these bind its ports to a
 * scripted page (what each round's capture returns), a scripted planner (one
 * action per round), and a scripted user, and assert the property the whole
 * phase exists for -- later rounds are planned against the page the previous
 * step produced, with `priorActions` carried forward.
 */

const TASK_ID = "task-loop";
const ORIGIN = "https://example.com";

/* --------------------------------- fixture -------------------------------- */

/** A synthetic observation carrying whatever the round's capture "saw". */
function observation(
  priorActions: PriorActionSummary[],
  label: string,
): SanitizedObservation {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK_ID,
    task: "Choose the Business plan, then enter 12 seats.",
    urlOrigin: ORIGIN,
    screenshot: { mimeType: "image/png", width: 1280, height: 800, dataBase64: "AAAA" },
    // The element the planner may cite changes per round: round 1 only sees the
    // plan select; round 2 sees the seat field the select revealed. A plan that
    // ran against round 1's element list could not cite round 2's field at all.
    accessibilitySnapshot: [
      {
        id: `e-${label}`,
        role: "combobox",
        accessibleName: label,
        box: { x: 40, y: 60, width: 220, height: 32 },
        capabilities: ["select", "type"],
      },
    ],
    redactionSummary: [],
    priorActions,
  };
}

const box = { x: 40, y: 60, width: 220, height: 32 };

const SELECT_BUSINESS: Action = {
  type: "select",
  reason: "Choose the Business plan.",
  risk: "medium",
  target: { role: "combobox", accessibleName: "round-1", box },
  value: "business",
};

const TYPE_SEATS: Action = {
  type: "type",
  reason: "Enter the seat count.",
  risk: "medium",
  target: { role: "combobox", accessibleName: "round-2", box },
  value: "12",
};

const DONE: Action = {
  type: "done",
  reason: "Both steps are done.",
  risk: "low",
  summary: "Chose Business with 12 seats.",
};

const SCROLL: Action = {
  type: "scroll",
  reason: "Look further down.",
  risk: "low",
  direction: "down",
  amount: 400,
};

/* --------------------------------- harness -------------------------------- */

type HarnessOptions = {
  /** One action per round, in order. The loop takes one per plan call. */
  plans: Action[];
  decisions?: ApprovalDecision[];
  maxRounds?: number;
  /** Called with each round's number just before that round's capture. */
  onScan?: (round: number, session: TaskSession) => void;
  executeStep?: (action: Action, session: TaskSession) => StepRun;
};

function harness(options: HarnessOptions) {
  const session = new TaskSession(
    options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds },
  );
  session.send("START_SCAN");

  const scans: PriorActionSummary[][] = [];
  const plannedAgainst: PriorActionSummary[][] = [];
  const executed: Action[] = [];
  const reports: TaskLoopEvent[] = [];
  const decisions = options.decisions ?? [];
  let decisionIndex = 0;

  const ports: TaskLoopPorts = {
    async scan(priorActions) {
      const round = scans.length + 1;
      // Snapshotted: the loop reuses one growing array, and the test wants to
      // see what each round's capture actually carried.
      scans.push([...priorActions]);
      options.onScan?.(round, session);
      // A capture that lands after the session ended can never be planned on.
      if (!session.can("SANITIZED")) throw new Error("session ended during the round");
      session.send("SANITIZED");
      return observation(priorActions, `round-${round}`);
    },

    async plan(observation) {
      plannedAgainst.push([...observation.priorActions]);
      if (!session.can("START_PLANNING")) throw new Error("session ended before planning");
      session.send("START_PLANNING");
      session.send("PLAN_READY");
      const action = options.plans[plannedAgainst.length - 1];
      if (!action) throw new Error("no scripted plan for this round");
      return action;
    },

    async requestApproval() {
      const decision = decisions[decisionIndex++] ?? { approved: true };
      // The background's APPROVE_PLAN handler does exactly this.
      if (decision.approved && session.can("APPROVE")) session.send("APPROVE");
      return decision;
    },

    async executeStep(action) {
      executed.push(action);
      if (options.executeStep) return options.executeStep(action, session);
      return {
        status: "completed",
        needsReplan: action.type !== "done",
        outcome: { taskId: TASK_ID, actionIndex: 0, status: "success" },
        summary:
          action.type === "done" ? action.summary : `Ran the ${action.type} step.`,
      };
    },

    report(event) {
      reports.push(event);
    },
  };

  return { session, ports, scans, plannedAgainst, executed, reports };
}

/* ---------------------------------- tests --------------------------------- */

describe("task loop: re-planning against the re-captured page", () => {
  test("completes the two-round scenario, planning each step against what the last one left", async () => {
    const h = harness({ plans: [SELECT_BUSINESS, TYPE_SEATS, DONE] });

    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("completed");
    expect(run.summary).toBe("Chose Business with 12 seats.");
    // One plan call and one capture per round: three rounds, not one pre-baked
    // multi-action plan.
    expect(h.plannedAgainst).toHaveLength(3);
    expect(h.scans).toHaveLength(3);
    expect(h.executed).toEqual([SELECT_BUSINESS, TYPE_SEATS, DONE]);
    expect(run.rounds).toBe(3);
  });

  test("carries prior actions forward, and they are empty only on round 1", async () => {
    const h = harness({ plans: [SELECT_BUSINESS, TYPE_SEATS, DONE] });

    const run = await runTaskLoop({ session: h.session }, h.ports);

    // The capture of round 1 knows nothing yet; every later capture knows what
    // ran before it.
    expect(h.scans[0]).toEqual([]);
    expect(h.scans[1]).toHaveLength(1);
    expect(h.scans[2]).toHaveLength(2);
    expect(h.scans[1]![0]).toMatchObject({ type: "select", outcome: "success" });
    expect(h.scans[2]!.map((entry) => entry.type)).toEqual(["select", "type"]);

    // And the planner saw the same history: that is what makes it a memory.
    expect(h.plannedAgainst[0]).toEqual([]);
    expect(h.plannedAgainst[1]).toHaveLength(1);
    expect(h.plannedAgainst[2]).toHaveLength(2);

    // The step summaries the planner was shown are reported back too.
    expect(run.priorActions.map((entry) => entry.type)).toEqual(["select", "type"]);
  });

  test("reports one round boundary and one step per round", async () => {
    const h = harness({ plans: [SELECT_BUSINESS, DONE] });
    await runTaskLoop({ session: h.session }, h.ports);

    const started = h.reports.filter((event) => event.type === "ROUND_STARTED");
    const steps = h.reports.filter((event) => event.type === "STEP_EXECUTED");
    expect(started.map((event) => event.round)).toEqual([1, 2]);
    expect(steps.map((event) => event.round)).toEqual([1, 2]);
  });

  test("a single-step task still completes in one round", async () => {
    const h = harness({ plans: [DONE] });
    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("completed");
    expect(run.rounds).toBe(1);
    expect(h.scans).toHaveLength(1);
    expect(h.executed).toEqual([DONE]);
  });
});

describe("task loop: limits and stopping", () => {
  test("stops at the round cap instead of looping forever", async () => {
    const h = harness({ plans: [SCROLL, SCROLL, SCROLL], maxRounds: 2 });
    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("round_cap");
    expect(run.rounds).toBe(2);
    expect(h.scans).toHaveLength(2);
    expect(h.executed).toHaveLength(2);
    expect(h.session.state).toBe("stopped");
  });

  test("a declined step stops the session instead of running a different one", async () => {
    const h = harness({
      plans: [SELECT_BUSINESS, TYPE_SEATS],
      decisions: [{ approved: false }],
    });
    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("denied");
    expect(h.executed).toEqual([]);
    expect(h.session.state).toBe("stopped");
  });

  test("a Stop part-way through a round unwinds cleanly", async () => {
    const h = harness({
      plans: [SELECT_BUSINESS, TYPE_SEATS, DONE],
      onScan: (round, session) => {
        // The panel's Stop lands while round 2's capture is in flight.
        if (round === 2) session.stop();
      },
    });
    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("user");
    // Only round 1's step ran; nothing after the Stop did.
    expect(h.executed).toEqual([SELECT_BUSINESS]);
  });

  test("surfaces a step that stopped on the per-round budget", async () => {
    const h = harness({
      plans: [SCROLL, DONE],
      executeStep: () => ({
        status: "stopped",
        needsReplan: false,
        stopReason: "timeout",
        summary: "This round's 90-second active-work budget ran out.",
      }),
    });
    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("timeout");
  });

  test("a step failure ends the loop as failed", async () => {
    const h = harness({
      plans: [SELECT_BUSINESS, DONE],
      executeStep: () => ({
        status: "failed",
        needsReplan: false,
        failure: { code: "TARGET_NOT_FOUND", message: "The control is gone." },
        summary: "The control is gone.",
      }),
    });
    const run = await runTaskLoop({ session: h.session }, h.ports);

    expect(run.status).toBe("failed");
    expect(h.scans).toHaveLength(1);
  });
});

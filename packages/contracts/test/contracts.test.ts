import { describe, expect, test } from "bun:test";
import {
  ACTIVE_STATES,
  ActionPlanSchema,
  CONTRACT_VERSION,
  InvalidTransitionError,
  SanitizationFailureSchema,
  SanitizedObservationSchema,
  TASK_STATES,
  TaskSession,
  type TaskEventType,
  type TaskState,
} from "../src/index";

function validObservation() {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: "task-1",
    task: "Find the pricing page and summarize the plans.",
    urlOrigin: "https://example.com",
    screenshot: {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      dataBase64: "AAAA",
    },
    accessibilitySnapshot: [
      {
        id: "el-1",
        role: "button",
        accessibleName: "Pricing",
        box: { x: 10, y: 20, width: 80, height: 24 },
        capabilities: ["click"],
      },
    ],
    redactionSummary: [{ category: "EMAIL", count: 2 }],
    priorActions: [],
  };
}

function validActionPlan() {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: "task-1",
    actions: [
      {
        type: "click",
        reason: "Open the pricing page",
        risk: "low",
        target: {
          role: "link",
          accessibleName: "Pricing",
          box: { x: 10, y: 20, width: 80, height: 24 },
        },
      },
    ],
  };
}

describe("SanitizedObservation schema", () => {
  test("accepts a valid fixture", () => {
    const result = SanitizedObservationSchema.safeParse(validObservation());
    expect(result.success).toBe(true);
  });

  test("rejects unknown top-level fields", () => {
    const withRawDom = { ...validObservation(), rawDom: "<html></html>" };
    const result = SanitizedObservationSchema.safeParse(withRawDom);
    expect(result.success).toBe(false);
  });

  test("rejects forbidden sensitive-looking fields such as cookies or apiKey", () => {
    for (const field of ["cookies", "storage", "apiKey", "ocrText"]) {
      const withField = { ...validObservation(), [field]: "leak" };
      const result = SanitizedObservationSchema.safeParse(withField);
      expect(result.success).toBe(false);
    }
  });

  test("rejects a urlOrigin containing a path or query string", () => {
    const withPath = {
      ...validObservation(),
      urlOrigin: "https://example.com/account?token=abc",
    };
    const result = SanitizedObservationSchema.safeParse(withPath);
    expect(result.success).toBe(false);
  });

  test("rejects an unknown contract version", () => {
    const withVersion = { ...validObservation(), contractVersion: "v2" };
    const result = SanitizedObservationSchema.safeParse(withVersion);
    expect(result.success).toBe(false);
  });

  test("rejects an oversized screenshot payload", () => {
    const withHugeScreenshot = validObservation();
    withHugeScreenshot.screenshot.dataBase64 = "A".repeat(2_000_001);
    const result = SanitizedObservationSchema.safeParse(withHugeScreenshot);
    expect(result.success).toBe(false);
  });

  test("rejects an accessibility node with unknown fields", () => {
    const withRawValue = validObservation();
    (withRawValue.accessibilitySnapshot[0] as Record<string, unknown>).rawValue =
      "hunter2";
    const result = SanitizedObservationSchema.safeParse(withRawValue);
    expect(result.success).toBe(false);
  });
});

describe("ActionPlan schema", () => {
  test("accepts a valid fixture for every action type", () => {
    const fixtures = [
      { type: "navigate", reason: "go", risk: "low", url: "https://example.com" },
      {
        type: "click",
        reason: "click",
        risk: "low",
        target: { role: "button", accessibleName: "Go", box: { x: 0, y: 0, width: 1, height: 1 } },
      },
      { type: "scroll", reason: "scroll", risk: "low", direction: "down" },
      {
        type: "type",
        reason: "fill",
        risk: "medium",
        target: { role: "textbox", accessibleName: "Search", box: { x: 0, y: 0, width: 1, height: 1 } },
        value: "hello",
      },
      {
        type: "select",
        reason: "choose",
        risk: "medium",
        target: { role: "combobox", accessibleName: "Country", box: { x: 0, y: 0, width: 1, height: 1 } },
        value: "US",
      },
      { type: "ask_user", reason: "ambiguous", risk: "low", prompt: "Which account?" },
      { type: "done", reason: "finished", risk: "low", summary: "Task complete" },
    ];
    for (const action of fixtures) {
      const plan = { ...validActionPlan(), actions: [action] };
      const result = ActionPlanSchema.safeParse(plan);
      expect(result.success).toBe(true);
    }
  });

  test("rejects an unknown action type", () => {
    const plan = {
      ...validActionPlan(),
      actions: [{ type: "eval", reason: "x", risk: "low" }],
    };
    const result = ActionPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("rejects a click action missing target evidence", () => {
    const plan = {
      ...validActionPlan(),
      actions: [{ type: "click", reason: "x", risk: "low" }],
    };
    const result = ActionPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("rejects more than 10 actions in one plan", () => {
    const plan = {
      ...validActionPlan(),
      actions: Array.from({ length: 11 }, () => validActionPlan().actions[0]),
    };
    const result = ActionPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("rejects prose-only output shaped as an unknown top-level field", () => {
    const plan = { ...validActionPlan(), text: "I would click the button." };
    const result = ActionPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe("SanitizationFailure schema", () => {
  test("accepts a valid fail-closed fixture", () => {
    const result = SanitizationFailureSchema.safeParse({
      ok: false,
      code: "DETECTOR_TIMEOUT",
      message: "Face detector timed out.",
    });
    expect(result.success).toBe(true);
  });

  test("rejects an unknown failure code", () => {
    const result = SanitizationFailureSchema.safeParse({
      ok: false,
      code: "SOMETHING_ELSE",
      message: "oops",
    });
    expect(result.success).toBe(false);
  });
});

describe("TaskSession transitions", () => {
  test("walks the full happy path from idle to completed", () => {
    const session = new TaskSession();
    expect(session.state).toBe("idle");
    session.send("START_SCAN");
    expect(session.state).toBe("scanning");
    session.send("SANITIZED");
    expect(session.state).toBe("sanitized");
    session.send("START_PLANNING");
    expect(session.state).toBe("planning");
    session.send("PLAN_READY");
    expect(session.state).toBe("awaiting_approval");
    session.send("APPROVE");
    expect(session.state).toBe("executing");
    session.send("COMPLETE");
    expect(session.state).toBe("completed");
  });

  test("rejects impossible transitions such as idle -> executing", () => {
    const session = new TaskSession();
    expect(session.can("APPROVE")).toBe(false);
    expect(() => session.send("APPROVE")).toThrow(InvalidTransitionError);
    expect(session.state).toBe("idle");
  });

  const deniedEdges: Array<[TaskState, TaskEventType]> = [
    ["idle", "SANITIZED"],
    ["idle", "APPROVE"],
    ["idle", "COMPLETE"],
    ["scanning", "START_PLANNING"],
    ["scanning", "APPROVE"],
    ["sanitized", "SANITIZED"],
    ["sanitized", "APPROVE"],
    ["planning", "START_SCAN"],
    ["awaiting_approval", "PLAN_READY"],
    ["executing", "START_SCAN"],
    ["executing", "APPROVE"],
    ["completed", "STOP"],
    ["stopped", "STOP"],
    ["failed", "APPROVE"],
  ];

  for (const [from, event] of deniedEdges) {
    test(`denies ${event} from ${from}`, () => {
      const session = new TaskSession();
      driveTo(session, from);
      expect(session.can(event)).toBe(false);
      expect(() => session.send(event)).toThrow(InvalidTransitionError);
    });
  }

  test("every state is reachable and declared in TASK_STATES", () => {
    expect(TASK_STATES).toContain("idle");
    expect(TASK_STATES.length).toBe(9);
  });

  test("Stop is accepted from every active state", () => {
    for (const state of ACTIVE_STATES) {
      const session = new TaskSession();
      driveTo(session, state);
      expect(session.state).toBe(state);
      expect(session.stop()).toBe(true);
      expect(session.state).toBe("stopped");
    }
  });

  test("Stop is a no-op from idle and from terminal states", () => {
    for (const state of ["idle", "completed", "failed", "stopped"] as const) {
      const session = new TaskSession();
      driveTo(session, state);
      expect(session.stop()).toBe(false);
      expect(session.state).toBe(state);
    }
  });

  test("recordAction auto-stops the session once the action cap is reached", () => {
    const session = new TaskSession({ maxActions: 2 });
    driveTo(session, "executing");
    expect(session.recordAction()).toEqual({ stopped: false });
    expect(session.state).toBe("executing");
    expect(session.recordAction()).toEqual({ stopped: true });
    expect(session.state).toBe("stopped");
  });

  test("enforceTimeout stops the session once the duration budget elapses", () => {
    let now = 0;
    const session = new TaskSession({ maxDurationMs: 1000, now: () => now });
    session.send("START_SCAN");
    now = 500;
    expect(session.enforceTimeout()).toBe(false);
    expect(session.state).toBe("scanning");
    now = 1500;
    expect(session.enforceTimeout()).toBe(true);
    expect(session.state).toBe("stopped");
  });
});

/** Drives a fresh session from idle to `target` using only legal edges. */
function driveTo(session: TaskSession, target: TaskState) {
  const path: TaskEventType[] = [];
  switch (target) {
    case "idle":
      return;
    case "scanning":
      path.push("START_SCAN");
      break;
    case "sanitized":
      path.push("START_SCAN", "SANITIZED");
      break;
    case "planning":
      path.push("START_SCAN", "SANITIZED", "START_PLANNING");
      break;
    case "awaiting_approval":
      path.push("START_SCAN", "SANITIZED", "START_PLANNING", "PLAN_READY");
      break;
    case "executing":
      path.push(
        "START_SCAN",
        "SANITIZED",
        "START_PLANNING",
        "PLAN_READY",
        "APPROVE",
      );
      break;
    case "completed":
      path.push(
        "START_SCAN",
        "SANITIZED",
        "START_PLANNING",
        "PLAN_READY",
        "APPROVE",
        "COMPLETE",
      );
      break;
    case "failed":
      path.push("START_SCAN", "SANITIZATION_FAILED");
      break;
    case "stopped":
      path.push("START_SCAN", "STOP");
      break;
  }
  for (const event of path) session.send(event);
}

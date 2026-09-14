import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, MAX_ACTIONS_PER_PLAN } from "@orka/contracts";
import { MOCK_FIXTURES, parseActionPlan } from "../src/index";

const TASK_ID = "task-parse";

function parse(fixture: keyof typeof MOCK_FIXTURES) {
  return parseActionPlan(MOCK_FIXTURES[fixture], TASK_ID);
}

describe("parseActionPlan: accepted responses", () => {
  test("a clean JSON plan validates and is stamped with the local task id", () => {
    const result = parse("valid-plan");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.contractVersion).toBe(CONTRACT_VERSION);
    expect(result.plan.taskId).toBe(TASK_ID);
    expect(result.plan.actions.map((action) => action.type)).toEqual(["click", "done"]);
  });

  test("a plan wrapped in a markdown fence and prose still parses", () => {
    const result = parse("valid-plan-fenced");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.actions).toHaveLength(1);
    expect(result.plan.actions[0]?.type).toBe("scroll");
  });

  test("a <think> block from a local reasoning model is ignored", () => {
    const text = `<think>The user wants pricing. I should click the nav link.</think>${MOCK_FIXTURES["valid-plan"]}`;
    const result = parseActionPlan(text, TASK_ID);
    expect(result.ok).toBe(true);
  });

  test("braces inside a reason string do not truncate the object", () => {
    const text = JSON.stringify({
      actions: [
        {
          type: "done",
          reason: 'The page shows {"plan":"pro"} already, so nothing is needed.',
          risk: "low",
          summary: "Pricing was already visible.",
        },
      ],
    });
    const result = parseActionPlan(text, TASK_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.actions).toHaveLength(1);
  });

  test("a model-supplied taskId cannot override the session it answers", () => {
    const text = JSON.stringify({
      contractVersion: "v99",
      taskId: "someone-elses-task",
      actions: [
        { type: "done", reason: "Finished.", risk: "low", summary: "Done." },
      ],
    });
    const result = parseActionPlan(text, TASK_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.taskId).toBe(TASK_ID);
    expect(result.plan.contractVersion).toBe(CONTRACT_VERSION);
  });
});

describe("parseActionPlan: rejected responses", () => {
  const cases: { fixture: keyof typeof MOCK_FIXTURES; because: string }[] = [
    { fixture: "prose-only", because: "the model answered in prose" },
    { fixture: "malformed-json", because: "the JSON never closes" },
    { fixture: "unknown-action", because: "the action type is not implemented" },
    { fixture: "missing-target", because: "a click carries no target evidence" },
    { fixture: "javascript-url", because: "navigate must be http(s)" },
    { fixture: "too-many-actions", because: "the plan exceeds the action cap" },
  ];

  for (const { fixture, because } of cases) {
    test(`rejects "${fixture}" because ${because}`, () => {
      const result = parse(fixture);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INVALID_ACTION_PLAN");
      expect(result.message.length).toBeGreaterThan(0);
    });
  }

  test("an empty response is refused rather than treated as an empty plan", () => {
    const result = parseActionPlan("   ", TASK_ID);
    expect(result.ok).toBe(false);
  });

  test("a JSON array is not a plan", () => {
    const result = parseActionPlan("[{\"type\":\"done\"}]", TASK_ID);
    expect(result.ok).toBe(false);
  });

  test("exactly the cap is allowed; one more is not", () => {
    const action = { type: "scroll", reason: "Scroll down.", risk: "low", direction: "down" };
    const atCap = JSON.stringify({ actions: Array.from({ length: MAX_ACTIONS_PER_PLAN }, () => action) });
    const overCap = JSON.stringify({ actions: Array.from({ length: MAX_ACTIONS_PER_PLAN + 1 }, () => action) });
    expect(parseActionPlan(atCap, TASK_ID).ok).toBe(true);
    expect(parseActionPlan(overCap, TASK_ID).ok).toBe(false);
  });

  test("a rejection message names the offending field but never its value", () => {
    const text = JSON.stringify({
      actions: [
        {
          type: "navigate",
          reason: "Go to the helper.",
          risk: "low",
          url: "javascript:alert(document.cookie)",
        },
      ],
    });
    const result = parseActionPlan(text, TASK_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("url");
    expect(result.message).not.toContain("javascript:");
    expect(result.message).not.toContain("document.cookie");
  });
});

describe("parseActionPlan: policy-unsafe but schema-valid", () => {
  test("an irreversible high-risk action parses and is surfaced, not silently dropped", () => {
    // The contract's job is shape, not judgement. Hiding this here would hide
    // that the executor's confirmation policy (Phase 4) is what stops it.
    const result = parse("unsafe-action");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.actions[0]?.risk).toBe("high");
  });

  test("a refusal to obey injected page text is a valid ask_user plan", () => {
    const result = parse("injection-refusal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.actions[0]?.type).toBe("ask_user");
  });
});

import { describe, expect, test } from "bun:test";
import {
  ActionOutcomeSchema,
  ActionPlanSchema,
  CONFIRMATION_KINDS,
  CONTRACT_VERSION,
  EXECUTION_OUTCOME_CODES,
  STOP_REASONS,
  SensitiveVariablesSchema,
  findSensitivePlaceholders,
  hasSensitivePlaceholder,
  isSensitivePlaceholderToken,
  normalizeSensitiveVariableName,
  sensitivePlaceholderRegex,
  type ActionPlan,
} from "../src/index";

/**
 * Phase 4 vocabulary: the executor's outcome codes, and the `[NAME]`
 * placeholder syntax for values the user keeps locally. These are contract
 * surface because the side panel renders them and the executor reports them;
 * a silent change here changes what the user is told happened.
 */

function planWith(action: unknown): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: "task-4",
    actions: [action],
  };
}

const CLICK_TARGET = {
  role: "button",
  accessibleName: "Continue",
  box: { x: 10, y: 20, width: 80, height: 24 },
};

describe("target evidence", () => {
  test("accepts an evidence id copied from the observation", () => {
    const plan = planWith({
      type: "click",
      reason: "Continue the form",
      risk: "medium",
      target: { ...CLICK_TARGET, evidenceId: "e-12" },
    });
    const parsed = ActionPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });

  test("still accepts evidence without an id, so older plans stay valid", () => {
    const plan = planWith({
      type: "click",
      reason: "Continue the form",
      risk: "medium",
      target: CLICK_TARGET,
    });
    expect(ActionPlanSchema.safeParse(plan).success).toBe(true);
  });

  test("rejects an unknown field alongside the evidence", () => {
    const plan = planWith({
      type: "click",
      reason: "Continue the form",
      risk: "medium",
      target: { ...CLICK_TARGET, selector: "#continue" },
    });
    expect(ActionPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe("action outcomes", () => {
  test("carries a stable code next to the human reason", () => {
    const parsed = ActionOutcomeSchema.safeParse({
      taskId: "task-4",
      actionIndex: 2,
      status: "failure",
      code: "TARGET_AMBIGUOUS",
      reason: "Two buttons match that name.",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown outcome code", () => {
    const parsed = ActionOutcomeSchema.safeParse({
      taskId: "task-4",
      actionIndex: 0,
      status: "failure",
      code: "SOMETHING_WENT_WRONG",
    });
    expect(parsed.success).toBe(false);
  });

  test("every refusal and stop the executor can report is declared", () => {
    // A code that exists in the executor but not here would be dropped by the
    // schema and reach the panel as an unexplained failure.
    expect(EXECUTION_OUTCOME_CODES).toContain("TARGET_DRIFTED");
    expect(EXECUTION_OUTCOME_CODES).toContain("TARGET_EVIDENCE_SENSITIVE");
    expect(EXECUTION_OUTCOME_CODES).toContain("VARIABLE_MISSING");
    expect(EXECUTION_OUTCOME_CODES).toContain("TAB_NOT_ACTIVE");
    expect(EXECUTION_OUTCOME_CODES).toContain("BUDGET_EXHAUSTED");
    expect(EXECUTION_OUTCOME_CODES).toContain("SKIPPED_AFTER_TERMINAL");
    expect(STOP_REASONS).toContain("denied");
    expect(STOP_REASONS).toContain("tab_closed");
    expect(CONFIRMATION_KINDS).toContain("new_origin");
    expect(CONFIRMATION_KINDS).toContain("sensitive_value");
  });

  test("a plan whose action never ran can be described without a code", () => {
    const parsed = ActionOutcomeSchema.safeParse({
      taskId: "task-4",
      actionIndex: 0,
      status: "success",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("sensitive local variables", () => {
  test("normalizes a user-typed name into bracket syntax", () => {
    expect(normalizeSensitiveVariableName("phone number")).toBe("PHONE_NUMBER");
    expect(normalizeSensitiveVariableName("  card_1 ")).toBe("CARD_1");
    expect(normalizeSensitiveVariableName("2nd-phone")).toBeNull();
    expect(normalizeSensitiveVariableName("")).toBeNull();
  });

  test("finds distinct placeholders in order", () => {
    expect(findSensitivePlaceholders("type [PHONE_1] then [EMAIL] and [PHONE_1]")).toEqual([
      "PHONE_1",
      "EMAIL",
    ]);
    expect(findSensitivePlaceholders("no placeholders here")).toEqual([]);
    expect(hasSensitivePlaceholder("call [PHONE_1]")).toBe(true);
    expect(hasSensitivePlaceholder("call 555 0100")).toBe(false);
  });

  test("recognizes a value that is exactly one placeholder token", () => {
    // This is the predicate that lets a plan cite a redacted element by its
    // placeholder name: the live page still carries the real name.
    expect(isSensitivePlaceholderToken("[PHONE]")).toBe(true);
    expect(isSensitivePlaceholderToken(" [PHONE_1] ")).toBe(true);
    expect(isSensitivePlaceholderToken("[PHONE] and [EMAIL]")).toBe(false);
    expect(isSensitivePlaceholderToken("Phone number")).toBe(false);
    expect(isSensitivePlaceholderToken("[phone]")).toBe(false);
    expect(isSensitivePlaceholderToken("[]")).toBe(false);
  });

  test("recognizes the redaction placeholder vocabulary too", () => {
    // The planner may echo a redaction placeholder; it is the same syntax, and
    // the executor must treat it as a reference rather than literal text.
    expect(findSensitivePlaceholders("[PASSWORD_FIELD]")).toEqual(["PASSWORD_FIELD"]);
    expect(findSensitivePlaceholders("[REDACTED]")).toEqual(["REDACTED"]);
  });

  test("does not leak regex state between calls", () => {
    const first = sensitivePlaceholderRegex();
    const second = sensitivePlaceholderRegex();
    expect(first.test("[A]")).toBe(true);
    expect(second.test("[A]")).toBe(true);
  });

  test("accepts a bounded set of named values", () => {
    const parsed = SensitiveVariablesSchema.safeParse({
      PHONE_1: "555 0100",
      EMAIL: "jane@example.com",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects a lowercase name, an empty value, and too many values", () => {
    expect(SensitiveVariablesSchema.safeParse({ phone: "555" }).success).toBe(false);
    expect(SensitiveVariablesSchema.safeParse({ PHONE: "" }).success).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`V${index}`, "value"]),
    );
    expect(SensitiveVariablesSchema.safeParse(many).success).toBe(false);
  });
});

describe("a plan that references a local value", () => {
  test("is valid with the placeholder as its value, never the real one", () => {
    const plan: ActionPlan = {
      contractVersion: CONTRACT_VERSION,
      taskId: "task-4",
      actions: [
        {
          type: "type",
          reason: "Fill in the phone field",
          risk: "medium",
          target: {
            role: "textbox",
            accessibleName: "Phone",
            evidenceId: "e-3",
            box: { x: 10, y: 60, width: 200, height: 24 },
          },
          value: "[PHONE_1]",
        },
      ],
    };
    expect(ActionPlanSchema.safeParse(plan).success).toBe(true);
  });
});

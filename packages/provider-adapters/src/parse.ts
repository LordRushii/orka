import {
  ActionPlanSchema,
  CONTRACT_VERSION,
  MAX_ACTIONS_PER_PLAN,
  type ActionPlan,
} from "@orka/contracts";

export type ParsedPlan =
  | { ok: true; plan: ActionPlan }
  | { ok: false; code: "INVALID_ACTION_PLAN"; message: string };

/**
 * Local reasoning models (Qwen3-VL and friends, loaded through LM Studio)
 * routinely prefix their answer with a `<think>` block. Dropping it is
 * cosmetic, not a trust decision: whatever survives still has to satisfy the
 * ActionPlan schema.
 */
function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, " ");
}

/** Unwraps ```json fences without assuming the model closed them. */
function stripCodeFences(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1];
  return text.replace(/```(?:json|JSON)?/g, " ");
}

/**
 * Extracts the first balanced JSON object. A brace counter (string- and
 * escape-aware) beats a regex here because plans legitimately contain nested
 * objects and braces inside `reason` strings.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Turns raw provider text into a validated `ActionPlan v1`, or a typed
 * refusal. Shared by every adapter so provider-specific prose habits cannot
 * change what counts as a valid plan.
 *
 * `contractVersion` and `taskId` are stamped here rather than read from the
 * model: the planner has no authority to name the session it is answering,
 * and an echoed-back id would let a confused or hostile response attach
 * itself to a different Task Session.
 */
export function parseActionPlan(text: string, taskId: string): ParsedPlan {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, code: "INVALID_ACTION_PLAN", message: "The planner returned an empty response." };
  }

  const candidate = firstJsonObject(stripCodeFences(stripReasoning(text)));
  if (!candidate) {
    return {
      ok: false,
      code: "INVALID_ACTION_PLAN",
      message: "The planner returned prose instead of an ActionPlan JSON object.",
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return {
      ok: false,
      code: "INVALID_ACTION_PLAN",
      message: "The planner returned malformed JSON.",
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "INVALID_ACTION_PLAN", message: "The planner response was not a JSON object." };
  }

  const { actions } = raw as { actions?: unknown };
  if (!Array.isArray(actions)) {
    return {
      ok: false,
      code: "INVALID_ACTION_PLAN",
      message: "The planner response had no actions array.",
    };
  }
  if (actions.length > MAX_ACTIONS_PER_PLAN) {
    return {
      ok: false,
      code: "INVALID_ACTION_PLAN",
      message: `The planner proposed more than ${MAX_ACTIONS_PER_PLAN} actions.`,
    };
  }

  const parsed = ActionPlanSchema.safeParse({
    contractVersion: CONTRACT_VERSION,
    taskId,
    actions,
  });
  if (!parsed.success) {
    // The issue path names the offending field but never echoes its value, so
    // page-derived content cannot ride out through an error message.
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "actions";
    return {
      ok: false,
      code: "INVALID_ACTION_PLAN",
      message: `The planner proposed an action Orka cannot validate (${where}).`,
    };
  }

  return { ok: true, plan: parsed.data };
}

import { z } from "zod";

/**
 * Vocabulary for the Safe Action Executor (phases/04-safe-execution.md).
 *
 * These are shared because both halves of the extension need them: the
 * background service worker decides, and the side panel has to explain a
 * decision to the user. The codes are stable identifiers precisely so the UI
 * never has to parse a human sentence to know what happened.
 */

/**
 * Why a single proposed action did or did not happen. `TARGET_*` codes are
 * revalidation refusals -- the live page no longer matched the evidence the
 * plan was built from, so the action never ran.
 */
export const EXECUTION_OUTCOME_CODES = [
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "TARGET_DRIFTED",
  "TARGET_NOT_VISIBLE",
  "TARGET_NOT_INTERACTABLE",
  "TARGET_EVIDENCE_INVALID",
  "TARGET_EVIDENCE_SENSITIVE",
  "VARIABLE_MISSING",
  "BLOCKED_BY_POLICY",
  "NOT_CONFIRMED",
  "NAVIGATION_FAILED",
  "PAGE_UNAVAILABLE",
  "TAB_NOT_ACTIVE",
  "BUDGET_EXHAUSTED",
  "STOPPED_BY_USER",
  "SKIPPED_AFTER_TERMINAL",
  "UNEXPECTED_ERROR",
] as const;
export const ExecutionOutcomeCodeSchema = z.enum(EXECUTION_OUTCOME_CODES);
export type ExecutionOutcomeCode = z.infer<typeof ExecutionOutcomeCodeSchema>;

/**
 * Why a run ended without finishing its plan. `denied` means the user
 * declined a confirmation -- a stop, not a failure; the executor never
 * converts a refusal into a different action.
 */
export const STOP_REASONS = [
  "user",
  "timeout",
  "policy",
  "denied",
  "tab_closed",
  "page_unavailable",
  "privacy",
] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Terminal status of one `execute()` run. */
export const EXECUTION_RUN_STATUSES = ["completed", "stopped", "failed"] as const;
export const ExecutionRunStatusSchema = z.enum(EXECUTION_RUN_STATUSES);
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatusSchema>;

/** Kinds of per-action approval the executor can ask the user for. */
export const CONFIRMATION_KINDS = [
  "submit",
  "download",
  "permission",
  "purchase",
  "send",
  "delete",
  "account_security",
  "sensitive_value",
  "type",
  "select",
  "new_origin",
] as const;
export const ConfirmationKindSchema = z.enum(CONFIRMATION_KINDS);
export type ConfirmationKind = z.infer<typeof ConfirmationKindSchema>;

/* -------------------------------------------------------------------------- *
 * Sensitive local variables                                                  *
 * -------------------------------------------------------------------------- */

/**
 * A Sensitive Value the user keeps locally and refers to by bracket name
 * (`[PHONE_1]`). The planner never sees the value -- it sees the task text,
 * which may name the variable -- and the executor resolves it inside the
 * browser, after an explicit approval, immediately before typing.
 *
 * The bracket vocabulary is deliberately the same shape as the redaction
 * placeholders in `packages/privacy-engine` (`[EMAIL]`, `[CARD]`, ...): a
 * value that is only ever a placeholder is never typed literally, and a plan
 * that echoes a redaction placeholder has to name a variable the user
 * actually stored.
 */
export const MAX_SENSITIVE_VARIABLES = 10;
export const MAX_SENSITIVE_VALUE_LENGTH = 500;

/** Uppercase, starts with a letter, digits/underscore allowed after that. */
export const SENSITIVE_VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
export const SensitiveVariableNameSchema = z
  .string()
  .regex(
    SENSITIVE_VARIABLE_NAME_PATTERN,
    "A private value name must start with a letter and use only A-Z, 0-9, or _",
  );

/** One `[NAME]` token. Compiled fresh at each use so no `lastIndex` leaks. */
export function sensitivePlaceholderRegex(): RegExp {
  return /\[([A-Z][A-Z0-9_]{0,31})\]/g;
}

/** `"  phone number "` -> `"PHONE_NUMBER"`, or null when unusable. */
export function normalizeSensitiveVariableName(raw: string): string | null {
  const name = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SENSITIVE_VARIABLE_NAME_PATTERN.test(name) ? name : null;
}

/** Distinct placeholder names referenced by `text`, in order of appearance. */
export function findSensitivePlaceholders(text: string): string[] {
  const names: string[] = [];
  const regex = sensitivePlaceholderRegex();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function hasSensitivePlaceholder(text: string): boolean {
  return sensitivePlaceholderRegex().test(text);
}

/**
 * Whether `value` is *exactly* one placeholder token and nothing else.
 *
 * This is the predicate behind the one case where a plan may not quote the live
 * accessible name: the privacy engine replaces the name of a redacted element
 * with a placeholder, so the planner can only cite `[PHONE]` while the page
 * still says "Phone number". Targets whose evidence is a placeholder are
 * matched by role and box instead, and the executor only fills them from a
 * value the user saved.
 */
export function isSensitivePlaceholderToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || !trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  return /^\[[A-Z][A-Z0-9_]{0,31}\]$/.test(trimmed);
}

/**
 * The user's in-memory private values for one Task Session. Never persisted,
 * never sent to the gateway, and cleared when the session ends.
 */
export const SensitiveVariablesSchema = z
  .record(SensitiveVariableNameSchema, z.string().min(1).max(MAX_SENSITIVE_VALUE_LENGTH))
  .refine(
    (value) => Object.keys(value).length <= MAX_SENSITIVE_VARIABLES,
    { message: `At most ${MAX_SENSITIVE_VARIABLES} private values per task` },
  );
export type SensitiveVariables = z.infer<typeof SensitiveVariablesSchema>;

import {
  MAX_SENSITIVE_VARIABLES,
  SensitiveVariablesSchema,
  normalizeSensitiveVariableName,
} from "@orka/contracts";

/**
 * The private values a user types before starting a task.
 *
 * This module is the boundary where a person's input becomes the extension's
 * in-memory `SensitiveVariables`. It is deliberately separate from the React
 * form so that boundary can be tested on its own: what gets accepted, what
 * gets normalised, and what gets refused.
 */

/** One editable row of the private-values form. */
export type PrivateValueRow = { name: string; value: string };

export function emptyPrivateValueRow(): PrivateValueRow {
  return { name: "", value: "" };
}

/**
 * Turns form rows into the record the background keeps.
 *
 * Anything unusable is *reported* rather than dropped: silently losing a value
 * would surface later as a step that refuses for no visible reason. Blank rows
 * are ignored, because the form starts with one.
 */
export function collectPrivateValues(
  rows: PrivateValueRow[],
): { ok: true; values: Record<string, string> } | { ok: false; message: string } {
  const values: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value;
    if (!name && !value) continue;
    const normalized = normalizeSensitiveVariableName(name);
    if (!normalized || value.length === 0) {
      return {
        ok: false,
        message: "Each private value needs a name like PHONE_1 and a value.",
      };
    }
    values[normalized] = value;
  }
  const parsed = SensitiveVariablesSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Use up to ${MAX_SENSITIVE_VARIABLES} private values, with names like PHONE_1.`,
    };
  }
  return { ok: true, values: parsed.data };
}

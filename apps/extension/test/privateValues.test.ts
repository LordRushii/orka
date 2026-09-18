import { describe, expect, test } from "bun:test";
import { collectPrivateValues, emptyPrivateValueRow } from "../shared/privateValues.ts";

/**
 * The boundary where a person's typing becomes the extension's in-memory
 * `SensitiveVariables`. It is the last place a mistake is cheap to notice, so
 * what is accepted and what is refused is worth pinning down.
 */

describe("collectPrivateValues", () => {
  test("normalizes a name into the bracket vocabulary and keeps the value as typed", () => {
    const result = collectPrivateValues([{ name: " phone number ", value: "+1 555 0100" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({ PHONE_NUMBER: "+1 555 0100" });
  });

  test("ignores the blank row the form starts with", () => {
    const result = collectPrivateValues([emptyPrivateValueRow()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({});
  });

  test("reports a name it cannot use rather than dropping it", () => {
    for (const name of ["", "2nd", "-", "!!!"]) {
      const result = collectPrivateValues([{ name, value: "555" }]);
      expect(result.ok).toBe(false);
    }
  });

  test("refuses a name with no value", () => {
    const result = collectPrivateValues([{ name: "PHONE_1", value: "" }]);
    expect(result.ok).toBe(false);
  });

  test("refuses more values than the contract allows", () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      name: `V${index}`,
      value: "value",
    }));
    const result = collectPrivateValues(rows);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("10");
  });

  test("keeps the last value for a repeated name", () => {
    const result = collectPrivateValues([
      { name: "PHONE", value: "first" },
      { name: "phone", value: "second" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({ PHONE: "second" });
  });

  test("accepts a value that looks like a placeholder, because the user typed it", () => {
    // Deliberately allowed: refusing it here would make the extension decide
    // what a private value may contain. The executor is what refuses to type
    // an unresolved token.
    const result = collectPrivateValues([{ name: "TOKEN", value: "[NOT_A_VARIABLE]" }]);
    expect(result.ok).toBe(true);
  });
});

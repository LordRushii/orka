import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeErrorName } from "../shared/logging.ts";

/**
 * phases/05-demo-and-hardening.md: "Remove development logging and placeholder
 * keys before recording."
 *
 * Deleting today's console lines would not keep tomorrow's out of the demo, so
 * this is a rule rather than a cleanup: shipped code contains no debug logging,
 * and the two lines that remain on error paths can only ever print a name.
 * The test reads the source, which is the only way to assert something about
 * every file rather than about the three that happened to exist today.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SHIPPED_DIRS = [
  join(REPO_ROOT, "apps", "extension", "entrypoints"),
  join(REPO_ROOT, "apps", "extension", "shared"),
  join(REPO_ROOT, "apps", "extension", "workers"),
  join(REPO_ROOT, "apps", "gateway", "src"),
  join(REPO_ROOT, "packages"),
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "test" || entry === ".output") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

const files = SHIPPED_DIRS.flatMap((dir) => {
  try {
    return sourceFiles(dir);
  } catch {
    return [];
  }
});

describe("logging: what shipped code may print", () => {
  test("there is source to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("no debug logging survives anywhere", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/console\.(log|debug|info|trace|dir|table)\s*\(/g)) {
        offenders.push(`${file.replace(REPO_ROOT, ".")}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every remaining log line prints a literal or an error name", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/console\.(warn|error)\s*\(([^;]*?)\);/gs)) {
        const args = match[2]!;
        // Split on top-level commas: a call's own arguments, not a nested call's.
        let depth = 0;
        const parts: string[] = [];
        let current = "";
        for (const char of args) {
          if ("([{".includes(char)) depth += 1;
          if (")]}".includes(char)) depth -= 1;
          if (char === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
          }
          current += char;
        }
        parts.push(current);

        for (const part of parts) {
          const argument = part.trim();
          if (argument.length === 0) continue;
          const isLiteral = /^(["'`]).*\1$/s.test(argument);
          const isSafeName = /^safeErrorName\([a-zA-Z_$][\w$]*\)$/.test(argument);
          if (!isLiteral && !isSafeName) {
            offenders.push(`${file.replace(REPO_ROOT, ".")}: ${argument.slice(0, 60)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("logging: safeErrorName", () => {
  test("reports a real error's name", () => {
    expect(safeErrorName(new TypeError("payload fragment the user never saw"))).toBe("TypeError");
  });

  test("reports a custom name only when it looks like an identifier", () => {
    class CaptureFlowError extends Error {}
    Object.defineProperty(CaptureFlowError.prototype, "name", { value: "CaptureFlowError" });
    expect(safeErrorName(new CaptureFlowError("boom"))).toBe("CaptureFlowError");

    const sneaky = new Error("x");
    // A name is data too: one carrying spaces or punctuation is not an
    // identifier from this codebase, so it is not repeated back.
    Object.defineProperty(sneaky, "name", { value: "Error: email@example.test" });
    expect(safeErrorName(sneaky)).toBe("Error");
  });

  test("never repeats a message", () => {
    const secret = "5550100";
    const rendered = safeErrorName(new Error(`failed to send ${secret}`));
    expect(rendered).toBe("Error");
    expect(rendered).not.toContain(secret);
  });

  test("degrades to 'unknown' for a non-error throw", () => {
    expect(safeErrorName("a string was thrown")).toBe("unknown");
    expect(safeErrorName(undefined)).toBe("unknown");
    expect(safeErrorName({ message: "an object was thrown" })).toBe("unknown");
  });
});

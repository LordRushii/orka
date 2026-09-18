import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, FORBIDDEN_REQUEST_KEYS } from "@orka/contracts";
import {
  ABSENT_FIELD_GROUPS,
  MAX_OUTBOUND_FIELDS,
  describeOutboundRequest,
  formatBytes,
} from "../shared/outboundView.ts";

/**
 * The "what left this device" panel.
 *
 * The point of these tests is the negative: the view must prove the raw
 * capture is absent without becoming a copy of anything it is describing.
 */

const SECRET = "SECRET-VALUE-9f3a";
const ORIGIN = "https://synthetic.example.test";

/** A request shaped like the one `requestPlan` actually sends. */
function planRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    provider: { providerId: "mock", model: "valid-plan" },
    observation: {
      contractVersion: CONTRACT_VERSION,
      taskId: "task-1",
      task: `Summarize the results on ${ORIGIN}`,
      urlOrigin: ORIGIN,
      screenshot: {
        mimeType: "image/png",
        width: 1280,
        height: 800,
        dataBase64: `${SECRET}${"A".repeat(64)}`,
      },
      accessibilitySnapshot: [
        {
          id: "e-1",
          role: "link",
          accessibleName: "Pricing",
          box: { x: 120, y: 40, width: 64, height: 20 },
          capabilities: ["click"],
        },
      ],
      redactionSummary: [{ category: "PHONE", count: 1 }],
      priorActions: [],
    },
    ...overrides,
  };
}

describe("outboundView: describing the request by shape", () => {
  test("lists the request's own fields, with sizes and kinds", () => {
    const view = describeOutboundRequest(planRequest());
    const byPath = new Map(view.fields.map((field) => [field.path, field]));

    expect(byPath.get("contractVersion")).toMatchObject({
      kind: "string",
      size: CONTRACT_VERSION.length,
    });
    expect(byPath.get("provider")).toMatchObject({ kind: "object", size: 2 });
    expect(byPath.get("provider.providerId")).toMatchObject({ kind: "string", size: 4 });
    expect(byPath.get("observation.screenshot.dataBase64")?.size).toBe(SECRET.length + 64);
  });

  test("summarises an element array from one entry instead of walking all of them", () => {
    const view = describeOutboundRequest(planRequest());
    const snapshot = view.fields.find((field) => field.path === "observation.accessibilitySnapshot");

    expect(snapshot).toMatchObject({ kind: "array", size: 1 });
    expect(snapshot?.note).toContain("each entry: id, role, accessibleName, box, capabilities");
    // One entry's keys, not its values.
    expect(JSON.stringify(view)).not.toContain("Pricing");
  });

  test("never copies a value at any depth, including the screenshot and the task", () => {
    const serialized = JSON.stringify(describeOutboundRequest(planRequest()));

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(ORIGIN);
    expect(serialized).not.toContain("synthetic.example.test");
    expect(serialized).not.toContain("Summarize the results");
  });

  test("is derived from the body it is given, so a new field cannot hide", () => {
    const view = describeOutboundRequest(
      planRequest({ telemetryHint: "not-in-the-contract" }),
    );

    expect(view.fields.map((field) => field.path)).toContain("telemetryHint");
  });

  test("stays small on a large page: a 500-element snapshot is one field, not 500", () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ id: `e-${index}` }));
    const body = planRequest({
      observation: { ...(planRequest().observation as object), accessibilitySnapshot: many },
    });
    const view = describeOutboundRequest(body);

    expect(view.fields.length).toBeLessThanOrEqual(MAX_OUTBOUND_FIELDS);
    expect(view.truncated).toBe(false);
    expect(view.fields.find((field) => field.path === "observation.accessibilitySnapshot")?.size).toBe(
      500,
    );
  });

  test("says so when the field list itself had to be cut short", () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_OUTBOUND_FIELDS + 10 }, (_, index) => [`field${index}`, "value"]),
    );
    const view = describeOutboundRequest(wide);

    expect(view.truncated).toBe(true);
    expect(view.fields.length).toBeLessThanOrEqual(MAX_OUTBOUND_FIELDS + 1);
  });

  test("reports that it checked for forbidden keys rather than assuming", () => {
    expect(describeOutboundRequest(planRequest()).forbiddenKey).toBeNull();
    expect(
      describeOutboundRequest({ observation: { screenshot: { rawScreenshot: "data:image/png" } } })
        .forbiddenKey,
    ).toBe("rawScreenshot");
  });

  test("reports the size of the body it described", () => {
    const view = describeOutboundRequest(planRequest());
    expect(view.bytes).toBeGreaterThan(0);
    expect(formatBytes(view.bytes)).toMatch(/B|KB|MB/);
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("outboundView: the absent-data families", () => {
  test("cover the gateway's forbidden-key list exactly", () => {
    const grouped = ABSENT_FIELD_GROUPS.flatMap((group) => [...group.keys]).sort();

    // Exact set equality, both ways: a forbidden key with no family (a new gate
    // the demo would fail to mention) and a family entry the gateway does not
    // actually forbid (a claim with nothing behind it) both fail here.
    expect(grouped).toEqual([...FORBIDDEN_REQUEST_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("each family says why that data is not in the request", () => {
    for (const group of ABSENT_FIELD_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.detail.length).toBeGreaterThan(0);
      expect(group.keys.length).toBeGreaterThan(0);
    }
  });
});

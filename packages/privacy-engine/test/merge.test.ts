import { describe, expect, test } from "bun:test";
import { mergeDetections } from "../src/merge";
import { paddingForConfidence } from "../src/policy";
import type { Detection } from "../src/types";

const BOUNDS = { width: 1000, height: 1000 };

function detection(overrides: Partial<Detection>): Detection {
  return {
    category: "EMAIL",
    confidence: 0.9,
    source: "dom",
    box: { x: 100, y: 100, width: 50, height: 20 },
    reason: "test",
    ...overrides,
  };
}

describe("mergeDetections", () => {
  test("drops detections below their category threshold", () => {
    const result = mergeDetections([detection({ category: "FACE", confidence: 0.1 })], BOUNDS);
    expect(result).toHaveLength(0);
  });

  test("keeps non-overlapping detections as separate entries", () => {
    const result = mergeDetections(
      [
        detection({ box: { x: 0, y: 0, width: 20, height: 20 } }),
        detection({ box: { x: 500, y: 500, width: 20, height: 20 } }),
      ],
      BOUNDS,
    );
    expect(result).toHaveLength(2);
  });

  test("merges overlapping detections into one entry", () => {
    const result = mergeDetections(
      [
        detection({ box: { x: 100, y: 100, width: 50, height: 20 } }),
        detection({ box: { x: 105, y: 102, width: 50, height: 20 }, source: "ocr" }),
      ],
      BOUNDS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.sources.sort()).toEqual(["dom", "ocr"]);
  });

  test("an overlapping higher-priority category wins over a lower-priority one", () => {
    const result = mergeDetections(
      [
        detection({ category: "OTHER", confidence: 0.6, box: { x: 100, y: 100, width: 50, height: 20 } }),
        detection({
          category: "PASSWORD_FIELD",
          confidence: 1,
          box: { x: 100, y: 100, width: 50, height: 20 },
        }),
      ],
      BOUNDS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("PASSWORD_FIELD");
  });

  test("pads low-confidence detections more than high-confidence ones", () => {
    const box = { x: 200, y: 200, width: 40, height: 20 };
    const [confident] = mergeDetections([detection({ confidence: 0.95, box })], BOUNDS);
    const [uncertain] = mergeDetections([detection({ confidence: 0.61, box })], BOUNDS);

    expect(confident).toBeDefined();
    expect(uncertain).toBeDefined();
    const confidentShift = box.x - confident!.box.x;
    const uncertainShift = box.x - uncertain!.box.x;
    expect(uncertainShift).toBeGreaterThan(confidentShift);
    expect(confidentShift).toBeCloseTo(paddingForConfidence(0.95), 5);
  });

  test("clamps padded boxes to image bounds", () => {
    const result = mergeDetections(
      [detection({ box: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.7 })],
      BOUNDS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.box.x).toBeGreaterThanOrEqual(0);
    expect(result[0]?.box.y).toBeGreaterThanOrEqual(0);
  });
});

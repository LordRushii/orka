import { describe, expect, test } from "bun:test";
import type { Detection } from "../types";
import { scoreDetections, MATCH_IOU, type GroundTruthRegion } from "../src/benchmark/score";

/**
 * The scoring harness's own tests: the corpus regression gate is only as good
 * as the matcher behind it, so its matching rules are pinned here.
 */

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const detection = (category: Detection["category"], b: ReturnType<typeof box>, confidence = 0.9): Detection => ({
  category,
  confidence,
  source: "dom",
  box: b,
  reason: "test",
});
const label = (category: GroundTruthRegion["category"], b: ReturnType<typeof box>): GroundTruthRegion => ({
  category,
  box: b,
});

describe("benchmark scoring: matching rules", () => {
  test("a same-category detection at or above the merge IoU is a true positive", () => {
    const scores = scoreDetections(
      [detection("EMAIL", box(120, 210, 262, 22))],
      [label("EMAIL", box(120, 210, 262, 22))],
    );
    expect(MATCH_IOU).toBe(0.2);
    expect(scores.overall.truePositives).toBe(1);
    expect(scores.overall.recall).toBe(1);
    expect(scores.overall.precision).toBe(1);
  });

  test("a detection in the wrong place is a false positive, and the label is a miss", () => {
    const scores = scoreDetections(
      [detection("EMAIL", box(900, 500, 262, 22))],
      [label("EMAIL", box(120, 210, 262, 22))],
    );
    expect(scores.overall.falsePositives).toBe(1);
    expect(scores.overall.falseNegatives).toBe(1);
    expect(scores.overall.recall).toBe(0);
    expect(scores.overall.precision).toBe(0);
  });

  test("category mismatches never match, even with identical boxes", () => {
    const scores = scoreDetections(
      [detection("PHONE", box(120, 210, 262, 22))],
      [label("EMAIL", box(120, 210, 262, 22))],
    );
    expect(scores.overall.falsePositives).toBe(1);
    expect(scores.overall.falseNegatives).toBe(1);
  });

  test("two detections cannot both claim one label (greedy one-to-one)", () => {
    const region = box(120, 210, 262, 22);
    const scores = scoreDetections(
      [detection("EMAIL", region, 0.99), detection("EMAIL", box(121, 211, 262, 22), 0.98)],
      [label("EMAIL", region)],
    );
    expect(scores.overall.truePositives).toBe(1);
    expect(scores.overall.falsePositives).toBe(1);
  });

  test("redaction coverage measures painted area, not detection count", () => {
    // One detection, drawn but shifted: it covers only half the label.
    const scores = scoreDetections(
      [detection("EMAIL", box(120, 210, 131, 22))],
      [label("EMAIL", box(120, 210, 262, 22))],
      [{ box: box(120, 210, 131, 22) }],
    );
    expect(scores.overall.redactionCoverage).toBeCloseTo(0.5, 5);
  });

  test("overlapping redaction entries are clamped, never double-counted", () => {
    const scores = scoreDetections(
      [detection("EMAIL", box(120, 210, 262, 22))],
      [label("EMAIL", box(120, 210, 262, 22))],
      [ { box: box(120, 210, 262, 22) }, { box: box(120, 210, 262, 22) } ],
    );
    expect(scores.overall.redactionCoverage).toBe(1);
  });

  test("per-category scores are kept separate", () => {
    const scores = scoreDetections(
      [detection("EMAIL", box(120, 210, 262, 22))],
      [label("EMAIL", box(120, 210, 262, 22)), label("PHONE", box(120, 280, 148, 22))],
    );
    expect(scores.byCategory.EMAIL?.recall).toBe(1);
    expect(scores.byCategory.PHONE?.recall).toBe(0);
    expect(scores.overall.recall).toBeCloseTo(0.5, 5);
  });
});

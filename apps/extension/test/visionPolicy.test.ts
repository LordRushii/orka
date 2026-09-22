import { describe, expect, test } from "bun:test";
import { taskRequiresVision } from "../shared/visionPolicy.ts";

/**
 * Phase 6.5's fast path hinges on this one decision: the default round captures
 * no pixels, and only a task that asks the page to be *seen* flips that. The
 * heuristic is deliberately conservative -- a false negative costs one retry
 * (`StepRun.needsVision`), a false positive costs seconds on every round.
 */
describe("vision policy: when does a round need pixels?", () => {
  test("a task that must be looked at is a vision round", () => {
    for (const task of [
      "Explain this page",
      "Look at the chart and tell me the trend",
      "Describe what is on screen",
      "Summarize the dashboard",
      "What is visible in the image?",
    ]) {
      expect(taskRequiresVision(task)).toBe(true);
    }
  });

  test("an operate-the-page task is decided from the snapshot alone", () => {
    for (const task of [
      "Click the pricing link",
      "Fill the phone field with [PHONE_1]",
      "Choose the Business plan, then enter 12 seats",
      "Select California in the state dropdown",
      "Navigate to the settings page",
    ]) {
      expect(taskRequiresVision(task)).toBe(false);
    }
  });

  test("matching is whole-word, so a snapshot job is not dragged into a scan", () => {
    // "describe"/"explain"/"review" only count as words, and an unrelated word
    // that merely contains one must not turn the fast path off.
    expect(taskRequiresVision("Undescribed territory: click Continue")).toBe(false);
    expect(taskRequiresVision("Open the preview pane")).toBe(false);
  });
});

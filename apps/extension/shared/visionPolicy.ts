/**
 * When does a round need a screenshot at all? (Phase 6.5)
 *
 * Most steps -- navigate, click a named control, type into a named field,
 * select -- are decidable from the accessibility snapshot alone. On those
 * rounds Orka captures no pixels and runs no OCR or face detection, which
 * removes the single largest cost from a multi-round task.
 *
 * Vision is deliberately *not* the default. It is turned on only when the task
 * itself asks the page to be looked at, or when a snapshot-only round already
 * failed to place a target (see `StepRun.needsVision`). The decision is a pure
 * function of the task text so it can be asserted directly, and it fails
 * toward text-only: a missed visual clue costs a retry, while a screenshot
 * costs seconds on every round.
 */

/**
 * Requests that ask the page to be *seen* rather than operated. Wording is
 * matched as whole words so "describe the button" (a snapshot job) does not
 * drag pixels in, while "explain this page" does.
 */
const VISION_TASK_PATTERN =
  /\b(explain|summar(?:y|ise|ize)|describe|look at|look over|review|screenshot|visually|visual|what(?:'s| is| are) (?:on|visible)|image|picture|photo|diagram|chart)\b/i;

/** Whether the user's task can only be answered by looking at the pixels. */
export function taskRequiresVision(task: string): boolean {
  return VISION_TASK_PATTERN.test(task);
}

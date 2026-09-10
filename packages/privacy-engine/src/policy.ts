import type { RedactionCategory } from "@orka/contracts";

/**
 * Single source of truth for detector confidence thresholds, redaction
 * padding, and category merge priority. Keeping all of this in one object
 * (per phases/02-local-privacy-engine.md, "Keep thresholds in one policy
 * object") means a reviewer can audit every privacy-affecting number in one
 * place instead of hunting through each detector.
 */
export const DETECTION_POLICY = {
  /** A Detection below its category threshold is dropped before merge. */
  thresholds: {
    EMAIL: 0.6,
    PASSWORD_FIELD: 0.5,
    PHONE: 0.6,
    GOVT_ID: 0.65,
    CARD: 0.7,
    FACE: 0.5,
    OTHER: 0.5,
  } satisfies Record<RedactionCategory, number>,

  /**
   * Redaction padding in CSS pixels. Every box gets `basePx`; boxes get up
   * to an additional `uncertainMaxPx` as confidence approaches 0, per the
   * fail-closed rule "Uncertain detections enlarge the redaction region."
   */
  padding: {
    basePx: 4,
    uncertainMaxPx: 24,
  },

  /**
   * Highest-priority category wins when two detections overlap heavily.
   * Order matters: earlier entries are more sensitive and take precedence.
   */
  priority: [
    "PASSWORD_FIELD",
    "GOVT_ID",
    "CARD",
    "FACE",
    "EMAIL",
    "PHONE",
    "OTHER",
  ] as const satisfies readonly RedactionCategory[],

  /** Boxes whose intersection-over-union meets this are considered "the same". */
  overlapMergeIou: 0.2,
} as const;

export function paddingForConfidence(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return (
    DETECTION_POLICY.padding.basePx +
    (1 - clamped) * DETECTION_POLICY.padding.uncertainMaxPx
  );
}

export function meetsThreshold(category: RedactionCategory, confidence: number): boolean {
  return confidence >= DETECTION_POLICY.thresholds[category];
}

export function categoryPriorityRank(category: RedactionCategory): number {
  const index = DETECTION_POLICY.priority.indexOf(category);
  return index === -1 ? DETECTION_POLICY.priority.length : index;
}

import type { RedactionCategory } from "@orka/contracts";
import type { RuntimeMode } from "./types";

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

export type PixelScanBudget = {
  nativeSideLength: number;
  overlap: number;
  maxTiles: number;
};

/**
 * Longest side the OCR text detector accepts per runtime, in pixels.
 *
 * This is the number the worker passes as `maxSideLength` with
 * `limitType: "max"`, so an input longer than this on either side is
 * downsampled by the detector before any text is found. `balanced` runs a
 * smaller input per docs/ARCHITECTURE.md ("Balanced reduces input resolution
 * and scan frequency").
 *
 * The tile planner and the worker MUST read the same value. When they
 * disagree, tiles are planned at one size and then silently rescaled to
 * another, which reintroduces exactly the small-text resolution loss that the
 * tiled pass exists to prevent.
 */
export const DETECTOR_INPUT_BUDGET = {
  webgpu: 960,
  balanced: 736,
  wasm: 960,
} as const satisfies Record<RuntimeMode, number>;

export function detectorInputBudget(mode: RuntimeMode): number {
  return DETECTOR_INPUT_BUDGET[mode] ?? DETECTOR_INPUT_BUDGET.wasm;
}

/**
 * Per-runtime budget for the tiled OCR pass (see `pixel/tiles.ts`).
 *
 * `nativeSideLength` is `DETECTOR_INPUT_BUDGET`, so a planned tile reaches the
 * model unscaled. `maxTiles` caps what one scan may cost; when it binds, tiles
 * grow rather than regions being skipped, so coverage is never traded away.
 *
 * The modes differ in how many tiles they will pay for. `balanced` takes both
 * the smallest detector input and the smallest tile count, so on a capture
 * large enough to exceed its cap it degrades to lower-resolution tiles sooner
 * than the other two -- docs/ARCHITECTURE.md's reduced resolution and scan
 * frequency, expressed as latency traded against small-text recall.
 */
export const PIXEL_SCAN_POLICY = {
  webgpu: { nativeSideLength: DETECTOR_INPUT_BUDGET.webgpu, overlap: 0.15, maxTiles: 12 },
  balanced: { nativeSideLength: DETECTOR_INPUT_BUDGET.balanced, overlap: 0.15, maxTiles: 6 },
  wasm: { nativeSideLength: DETECTOR_INPUT_BUDGET.wasm, overlap: 0.15, maxTiles: 8 },
} as const satisfies Record<RuntimeMode, PixelScanBudget>;

export function pixelScanBudget(mode: RuntimeMode): PixelScanBudget {
  return PIXEL_SCAN_POLICY[mode] ?? PIXEL_SCAN_POLICY.wasm;
}

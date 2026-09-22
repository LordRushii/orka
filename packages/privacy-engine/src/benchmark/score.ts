import { boxArea, intersectionArea, iou } from "../box";
import { DETECTION_POLICY } from "../policy";
import type { Box, Detection, RedactionCategory } from "../types";

/**
 * The Phase 7 accuracy harness (docs2/03-pii-engine-accuracy.md Step 2).
 *
 * Matches produced redactions against hand-labelled ground truth by IoU at
 * the same threshold the merger considers "the same region", so scoring and
 * merge behaviour cannot drift apart.
 *
 * The scored unit is the **redaction-map entry**, not the raw detection: the
 * full-image pass and the overlapping tile passes read the same pixels by
 * design, and `mergeDetections` exists to collapse that redundancy into the
 * boxes that actually get painted. Scoring raw detections would count the
 * pipeline's own overlap as false positives; scoring the map scores what the
 * user is protected by. Precision is "are the redactions we drew real PII",
 * recall is "did we paint over every labelled region", and redaction coverage
 * is the area-level figure: what fraction of the ground-truth PII *area* the
 * map actually covers.
 */

/** IoU at which a redaction entry and a ground-truth region are the same. */
export const MATCH_IOU = DETECTION_POLICY.overlapMergeIou;

/** The scored unit: one box the pipeline actually painted, with its category. */
export type ScoredRedaction = {
  category: RedactionCategory;
  box: Box;
};

export type CategoryScores = {
  /** Labelled regions covered by a same-category redaction at or above MATCH_IOU. */
  truePositives: number;
  /** Labelled regions no same-category redaction covered. */
  falseNegatives: number;
  /** Redaction entries that matched no same-category ground-truth region. */
  falsePositives: number;
  precision: number;
  recall: number;
};

export type CorpusScores = {
  overall: CategoryScores & { redactionCoverage: number };
  byCategory: Partial<Record<RedactionCategory, CategoryScores>>;
};

export type GroundTruthRegion = {
  category: RedactionCategory;
  box: Box;
};

/**
 * Scores one fixture's redaction map against its labels. Greedy one-to-one
 * matching, highest IoU first: a redaction can only cover the region it best
 * matches, so two overlapping entries cannot both claim one label. `detections`
 * is accepted for API clarity but the scored unit is `redactionMap` -- pass the
 * merged map; when it is omitted, raw detections are used as their own map
 * (useful for scoring a detector in isolation).
 */
export function scoreDetections(
  detections: Detection[],
  groundTruth: GroundTruthRegion[],
  redactionMap: Array<ScoredRedaction> = detections.map((detection) => ({
    category: detection.category,
    box: detection.box,
  })),
): CorpusScores {
  const unmatched = [...groundTruth];
  const byCategory: CorpusScores["byCategory"] = {};
  let tp = 0;
  let fp = 0;

  const candidates = redactionMap
    .map((entry) => ({
      entry,
      match: groundTruth.reduce(
        (best, region) => {
          if (region.category !== entry.category) return best;
          const score = iou(entry.box, region.box);
          return score > best.score ? { region, score } : best;
        },
        { region: undefined as GroundTruthRegion | undefined, score: 0 },
      ),
    }))
    .sort((a, b) => b.match.score - a.match.score);

  for (const { entry, match } of candidates) {
    // `match` was computed before any claims; an entry whose best region was
    // already claimed falls back to being a false positive rather than
    // double-covering one label.
    const claimable = match.region !== undefined && match.score >= MATCH_IOU && unmatched.includes(match.region);
    const scores = (byCategory[entry.category] ??= {
      truePositives: 0,
      falseNegatives: 0,
      falsePositives: 0,
      precision: 0,
      recall: 0,
    });
    if (claimable && match.region) {
      tp += 1;
      scores.truePositives += 1;
      unmatched.splice(unmatched.indexOf(match.region), 1);
    } else {
      fp += 1;
      scores.falsePositives += 1;
    }
  }

  for (const region of unmatched) {
    const scores = (byCategory[region.category] ??= {
      truePositives: 0,
      falseNegatives: 0,
      falsePositives: 0,
      precision: 0,
      recall: 0,
    });
    scores.falseNegatives += 1;
  }

  const finalize = (
    entry: { truePositives: number; falsePositives: number; falseNegatives: number; precision: number; recall: number },
  ): void => {
    entry.precision =
      entry.truePositives + entry.falsePositives > 0
        ? entry.truePositives / (entry.truePositives + entry.falsePositives)
        : 1;
    entry.recall =
      entry.truePositives + entry.falseNegatives > 0
        ? entry.truePositives / (entry.truePositives + entry.falseNegatives)
        : 1;
  };
  for (const entry of Object.values(byCategory)) finalize(entry);

  // Redaction coverage: how much of the labelled PII area the map actually
  // paints. This is "redaction precision" in SIH terms -- a redaction that
  // misses by a pixel still fails to protect that pixel. Overlapping entries
  // are unioned per region by clamping, never double-counted.
  let covered = 0;
  let total = 0;
  for (const region of groundTruth) {
    total += boxArea(region.box);
    let regionCovered = 0;
    for (const entry of redactionMap) {
      regionCovered += intersectionArea(entry.box, region.box);
    }
    covered += Math.min(regionCovered, boxArea(region.box));
  }

  finalize({ truePositives: tp, falsePositives: fp, falseNegatives: unmatched.length, precision: 0, recall: 0 });
  return {
    overall: {
      truePositives: tp,
      falseNegatives: unmatched.length,
      falsePositives: fp,
      precision: tp + fp > 0 ? tp / (tp + fp) : 1,
      recall: tp + unmatched.length > 0 ? tp / (tp + unmatched.length) : 1,
      redactionCoverage: total > 0 ? covered / total : 1,
    },
    byCategory,
  };
}

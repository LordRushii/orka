import { iou, padBox, unionBox } from "./box";
import { categoryPriorityRank, meetsThreshold, paddingForConfidence } from "./policy";
import { DETECTION_POLICY } from "./policy";
import type { Detection, RedactionMap, RedactionMapEntry } from "./types";

type Bounds = { width: number; height: number };

/**
 * Merges raw detections from every detector (DOM, OCR, face) into the final
 * local Redaction Map: overlapping detections collapse into one entry using
 * the higher-priority category (per DETECTION_POLICY.priority), and every
 * entry is padded outward by an amount that grows as confidence falls,
 * satisfying "Uncertain detections enlarge the redaction region."
 */
export function mergeDetections(detections: Detection[], bounds: Bounds): RedactionMap {
  const valid = detections.filter((detection) => meetsThreshold(detection.category, detection.confidence));

  // Highest-priority, highest-confidence detections are placed first so
  // later, lower-priority overlaps merge into them rather than the reverse.
  const ordered = [...valid].sort((a, b) => {
    const rankDiff = categoryPriorityRank(a.category) - categoryPriorityRank(b.category);
    if (rankDiff !== 0) return rankDiff;
    return b.confidence - a.confidence;
  });

  const clusters: Array<{
    category: Detection["category"];
    box: Detection["box"];
    confidence: number;
    sources: Set<Detection["source"]>;
    reasons: Set<string>;
  }> = [];

  for (const detection of ordered) {
    const target = clusters.find((cluster) => iou(cluster.box, detection.box) >= DETECTION_POLICY.overlapMergeIou);
    if (!target) {
      clusters.push({
        category: detection.category,
        box: detection.box,
        confidence: detection.confidence,
        sources: new Set([detection.source]),
        reasons: new Set([detection.reason]),
      });
      continue;
    }
    target.box = unionBox(target.box, detection.box);
    target.confidence = Math.max(target.confidence, detection.confidence);
    target.sources.add(detection.source);
    target.reasons.add(detection.reason);
    // The cluster keeps whichever category ranks higher (lower rank number).
    if (categoryPriorityRank(detection.category) < categoryPriorityRank(target.category)) {
      target.category = detection.category;
    }
  }

  const entries: RedactionMapEntry[] = clusters.map((cluster) => ({
    category: cluster.category,
    box: padBox(cluster.box, paddingForConfidence(cluster.confidence), bounds),
    confidence: cluster.confidence,
    sources: [...cluster.sources],
    reason: [...cluster.reasons].join(" "),
  }));

  return entries;
}

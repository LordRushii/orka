import type { RedactionCategory } from "@orka/contracts";
import { MODEL_MANIFEST, type Detection } from "@orka/privacy-engine";

/**
 * The two facts the local audit view derives rather than receives: how
 * confident the detections were, and which model versions did the detecting.
 *
 * Both are pure functions of local data -- the Redaction Map's own detections
 * and the pinned manifest -- so they can be reasoned about (and tested) without
 * a browser, a model, or a capture.
 *
 * Confidence is reported in **bands, never raw scores or positions**. A band
 * count per category says "four phone detections, all high confidence", which
 * is what a demo audience needs to judge the redaction; a list of exact
 * confidences and boxes would rebuild the Redaction Map that Phase 5 says must
 * never leave extension memory.
 */

export const CONFIDENCE_BANDS = ["high", "medium", "low"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_BAND_LABEL: Record<ConfidenceBand, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * Band edges, in one place because the whole point of a band is that the
 * boundary is a stated policy rather than whatever a detector happened to
 * return. A detection at exactly 0.9 is high; the merge step already pads
 * lower-confidence regions further, so the split tracks how much doubt the
 * pipeline itself assumed.
 */
export const HIGH_CONFIDENCE_AT = 0.9;
export const MEDIUM_CONFIDENCE_AT = 0.7;

export type CategoryBandCount = {
  category: RedactionCategory;
  band: ConfidenceBand;
  count: number;
};

export function confidenceBand(confidence: number): ConfidenceBand {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence >= HIGH_CONFIDENCE_AT) return "high";
  if (confidence >= MEDIUM_CONFIDENCE_AT) return "medium";
  return "low";
}

/**
 * Counts `detections` into category/band cells. A pre-merge detection rather
 * than a Redaction Map entry on purpose: the map has already merged overlapping
 * regions, so it under-counts the *evidence*, and evidence is what the band
 * describes.
 */
export function summarizeConfidenceBands(
  detections: readonly Detection[],
): CategoryBandCount[] {
  const counts = new Map<string, CategoryBandCount>();
  for (const detection of detections) {
    const band = confidenceBand(detection.confidence);
    const key = `${detection.category}/${band}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { category: detection.category, band, count: 1 });
  }
  // Sorted so the same capture always renders the same way, and by band
  // severity within a category: high confidence first, because that is the
  // order a person reads them in.
  const bandOrder = CONFIDENCE_BANDS as readonly string[];
  return [...counts.values()].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      bandOrder.indexOf(a.band) - bandOrder.indexOf(b.band),
  );
}

/** One pinned model, as the audit view reports it. */
export type ModelVersion = {
  role: string;
  name: string;
  version: string;
};

const MODEL_ROLES: Record<string, string> = {
  "ort-wasm": "Runtime",
  "paddleocr-detector": "Text detector",
  "paddleocr-recognizer": "Text recognizer",
  "ultraface": "Face detector",
  "paddleocr-dictionary": "Text lexicon",
};

/**
 * The model versions behind a scan, read from the pinned manifest so the audit
 * view cannot claim a version the build does not load. `MODEL_MANIFEST` is the
 * same object the loader verifies hashes against.
 */
export function describeModelVersions(
  manifest: typeof MODEL_MANIFEST = MODEL_MANIFEST,
): ModelVersion[] {
  return Object.entries(manifest).map(([key, entry]) => ({
    role: MODEL_ROLES[key] ?? key,
    name: entry.name,
    version: entry.version,
  }));
}

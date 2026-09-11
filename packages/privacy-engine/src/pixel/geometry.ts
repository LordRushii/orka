import type { Box } from "../types";

export type OcrPolygon = Array<{ x: number; y: number }>;

/** Converts an OCR quadrilateral into a clamped image-space box. */
export function polygonToBox(
  polygon: OcrPolygon,
  bounds: { width: number; height: number },
): Box | null {
  if (polygon.length < 4 || bounds.width <= 0 || bounds.height <= 0) return null;
  const points = polygon.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 4) return null;
  const left = Math.max(0, Math.min(bounds.width, Math.min(...points.map((point) => point.x))));
  const top = Math.max(0, Math.min(bounds.height, Math.min(...points.map((point) => point.y))));
  const right = Math.max(left, Math.min(bounds.width, Math.max(...points.map((point) => point.x))));
  const bottom = Math.max(top, Math.min(bounds.height, Math.max(...points.map((point) => point.y))));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function clampBox(box: Box, bounds: { width: number; height: number }): Box {
  const x = Math.max(0, Math.min(bounds.width, box.x));
  const y = Math.max(0, Math.min(bounds.height, box.y));
  const right = Math.max(x, Math.min(bounds.width, box.x + box.width));
  const bottom = Math.max(y, Math.min(bounds.height, box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

export type FaceCandidate = { box: Box; confidence: number };

export function nonMaximumSuppression(
  candidates: FaceCandidate[],
  iouThreshold = 0.3,
): FaceCandidate[] {
  const ordered = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const kept: FaceCandidate[] = [];
  while (ordered.length) {
    const candidate = ordered.shift()!;
    kept.push(candidate);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const other = ordered[index]!;
      const interLeft = Math.max(candidate.box.x, other.box.x);
      const interTop = Math.max(candidate.box.y, other.box.y);
      const interRight = Math.min(candidate.box.x + candidate.box.width, other.box.x + other.box.width);
      const interBottom = Math.min(candidate.box.y + candidate.box.height, other.box.y + other.box.height);
      const intersection = Math.max(0, interRight - interLeft) * Math.max(0, interBottom - interTop);
      const union = candidate.box.width * candidate.box.height + other.box.width * other.box.height - intersection;
      if (union > 0 && intersection / union > iouThreshold) ordered.splice(index, 1);
    }
  }
  return kept;
}

import { clampBox, nonMaximumSuppression, type FaceCandidate } from "./geometry";
import type { FaceBox, RasterImage } from "./types";

/** UltraFace's fixed input geometry (RGB version-slim 320x240). */
export const ULTRAFACE_INPUT = { width: 320, height: 240 } as const;

/** Mean/scale used by the UltraFace reference preprocessing. */
const PIXEL_MEAN = 127;
const PIXEL_SCALE = 128;

export const ULTRAFACE_DEFAULTS = {
  /** Below this, a candidate is not treated as a face at all. */
  confidenceThreshold: 0.65,
  /** Overlapping candidates above this IoU collapse to the strongest one. */
  iouThreshold: 0.3,
} as const;

/**
 * Resizes a capture to UltraFace's input size and normalizes it into a
 * planar CHW `Float32Array`.
 *
 * Nearest-neighbour sampling is deliberate: it is exactly reproducible
 * across the WebGPU and WASM execution providers, so a face either passes
 * threshold on both runtimes or neither. A smoothing resample would make
 * detections runtime-dependent, and a face found on one runtime but not the
 * other is a face left unredacted on the other.
 */
export function preprocessUltraFace(image: RasterImage): Float32Array {
  const { width: targetWidth, height: targetHeight } = ULTRAFACE_INPUT;
  const plane = targetWidth * targetHeight;
  const input = new Float32Array(3 * plane);
  if (image.width <= 0 || image.height <= 0) return input;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / targetWidth));
      const source = (sourceY * image.width + sourceX) * 4;
      const offset = y * targetWidth + x;
      input[offset] = ((image.data[source] ?? 0) - PIXEL_MEAN) / PIXEL_SCALE;
      input[plane + offset] = ((image.data[source + 1] ?? 0) - PIXEL_MEAN) / PIXEL_SCALE;
      input[2 * plane + offset] = ((image.data[source + 2] ?? 0) - PIXEL_MEAN) / PIXEL_SCALE;
    }
  }
  return input;
}

export type UltraFaceDecodeOptions = {
  confidenceThreshold?: number;
  iouThreshold?: number;
};

/**
 * Converts UltraFace's raw graph outputs into image-space face boxes.
 *
 * `confidences` is `[N, 2]` (background, face) and `locations` is `[N, 4]`
 * holding normalized `x1, y1, x2, y2`. Boxes are scaled to `bounds`,
 * clamped inside it, and reduced by confidence-ordered NMS.
 */
export function decodeUltraFaceOutputs(
  confidences: ArrayLike<number>,
  locations: ArrayLike<number>,
  bounds: { width: number; height: number },
  options: UltraFaceDecodeOptions = {},
): FaceBox[] {
  const confidenceThreshold = options.confidenceThreshold ?? ULTRAFACE_DEFAULTS.confidenceThreshold;
  const iouThreshold = options.iouThreshold ?? ULTRAFACE_DEFAULTS.iouThreshold;

  const candidates: FaceCandidate[] = [];
  const count = Math.min(Math.floor(locations.length / 4), Math.floor(confidences.length / 2));
  for (let index = 0; index < count; index += 1) {
    const confidence = Number(confidences[index * 2 + 1] ?? 0);
    if (!Number.isFinite(confidence) || confidence < confidenceThreshold) continue;

    const base = index * 4;
    const x1 = Number(locations[base] ?? 0) * bounds.width;
    const y1 = Number(locations[base + 1] ?? 0) * bounds.height;
    const x2 = Number(locations[base + 2] ?? 0) * bounds.width;
    const y2 = Number(locations[base + 3] ?? 0) * bounds.height;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;

    const box = clampBox({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, bounds);
    if (box.width > 0 && box.height > 0) candidates.push({ box, confidence });
  }

  return nonMaximumSuppression(candidates, iouThreshold).map(({ box, confidence }) => ({ box, confidence }));
}

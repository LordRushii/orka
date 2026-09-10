import { meetsThreshold } from "../policy";
import type { Detection, RasterImage } from "../types";
import type { FaceDetector } from "./types";

/** Runs the local face detector and converts its results into `Detection`s. */
export async function runFaceDetection(detector: FaceDetector, image: RasterImage): Promise<Detection[]> {
  const faces = await detector.detect(image);
  return faces
    .map((face) => ({
      category: "FACE" as const,
      confidence: face.confidence,
      source: "face" as const,
      box: face.box,
      reason: "Local face detector matched a face-shaped region.",
    }))
    .filter((detection) => meetsThreshold(detection.category, detection.confidence));
}

import {
  createPrivacyEngine,
  type ImageEncoder,
  type PrivacyEngine,
} from "@orka/privacy-engine";
import { createBrowserImageEncoder } from "./image.ts";
import type { PixelWorkers } from "./pixelWorkers.ts";

/**
 * One scan runs a full-viewport OCR pass plus a native-resolution tiled pass,
 * and the tiled pass is what catches PII baked into small embedded images. On
 * the WASM runtime that is several seconds per tile, so the budget covers
 * every pass together while staying inside the Task Session timeout alongside
 * model load, face detection, and encoding.
 */
export const OCR_TIMEOUT_MS = 45_000;
export const FACE_TIMEOUT_MS = 10_000;

/** Task Session budget the two detector budgets above must fit inside. */
export const TASK_SESSION_TIMEOUT_MS = 90_000;

/**
 * Binds the local detectors to the engine. This is the only composition the
 * background uses, so it is also the thing a test has to exercise to prove no
 * transport runs before sanitization succeeds.
 *
 * `encoder` is injectable purely so that proof is reachable: the browser
 * encoder needs `OffscreenCanvas`, which a test runner has no reason to
 * provide. Production always takes the default.
 */
export function createEngine(
  pixelWorkers: PixelWorkers,
  encoder: ImageEncoder = createBrowserImageEncoder(),
): PrivacyEngine {
  return createPrivacyEngine({
    textRecognizer: pixelWorkers.textRecognizer,
    faceDetector: pixelWorkers.faceDetector,
    encoder,
    ocrTimeoutMs: OCR_TIMEOUT_MS,
    faceTimeoutMs: FACE_TIMEOUT_MS,
  });
}

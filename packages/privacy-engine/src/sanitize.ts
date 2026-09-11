import type { SanitizationFailure, SanitizationFailureCode } from "@orka/contracts";
import { CONTRACT_VERSION, SanitizedObservationSchema } from "@orka/contracts";
import { runDomDetectors } from "./detectors";
import type { ImageEncoder } from "./encoder";
import { mergeDetections } from "./merge";
import { ModelIntegrityError } from "./manifest";
import { runFaceDetection } from "./pixel/face";
import { runOcrDetection } from "./pixel/ocr";
import type { FaceDetector, TextRecognizer } from "./pixel/types";
import { redactAccessibilitySnapshot, redactScreenshot, summarizeRedactions } from "./redact";
import { redactTaskText } from "./taskText";
import type {
  CaptureInput,
  Detection,
  LocalAudit,
  PrivacyEngine,
  RuntimeProfile,
  SanitizationResult,
} from "./types";
import { sanitizeUrlToOrigin, UnsafeUrlError } from "./url";

export type SanitizeDependencies = {
  textRecognizer: TextRecognizer;
  faceDetector: FaceDetector;
  encoder: ImageEncoder;
  ocrTimeoutMs?: number;
  faceTimeoutMs?: number;
  now?: () => number;
};

const DEFAULT_OCR_TIMEOUT_MS = 6000;
const DEFAULT_FACE_TIMEOUT_MS = 6000;

class SanitizationStageError extends Error {
  constructor(
    public readonly code: SanitizationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SanitizationStageError";
  }
}

export class ModelLoadFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelLoadFailedError";
  }
}

function failure(code: SanitizationFailureCode, message: string): SanitizationFailure {
  return { ok: false, code, message };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SanitizationStageError("DETECTOR_TIMEOUT", `${label} timed out.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function classifyDetectorError(label: string, error: unknown): SanitizationStageError {
  if (error instanceof SanitizationStageError) return error;
  if (error instanceof ModelIntegrityError) {
    return new SanitizationStageError("MODEL_LOAD_FAILED", error.message);
  }
  if (error instanceof ModelLoadFailedError) {
    return new SanitizationStageError("MODEL_LOAD_FAILED", error.message);
  }
  const message = error instanceof Error ? error.message : `${label} failed.`;
  return new SanitizationStageError("DETECTOR_ERROR", message);
}

function isValidScreenshot(input: CaptureInput): boolean {
  const { screenshot } = input;
  if (!screenshot || screenshot.width <= 0 || screenshot.height <= 0) return false;
  const expectedLength = screenshot.width * screenshot.height * 4;
  return screenshot.data.length === expectedLength;
}

/**
 * The Privacy Engine's single entry point. Produces a `SanitizedObservation`
 * plus a local-only `LocalAudit`, or fails closed with a `SanitizationFailure`.
 * No network call is made anywhere in this function -- callers must not call
 * the gateway unless `result.ok === true`.
 */
export async function sanitize(
  input: CaptureInput,
  profile: RuntimeProfile,
  deps: SanitizeDependencies,
): Promise<SanitizationResult> {
  try {
    if (!isValidScreenshot(input)) {
      return { ok: false, error: failure("CAPTURE_FAILED", "Captured screenshot is missing or malformed.") };
    }

    let urlOrigin: string;
    try {
      urlOrigin = sanitizeUrlToOrigin(input.url);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        return { ok: false, error: failure("RESTRICTED_PAGE", error.message) };
      }
      throw error;
    }

    const domDetections = runDomDetectors(input.snapshot);

    let ocrDetections: Detection[];
    try {
      ocrDetections = await withTimeout(
        runOcrDetection(deps.textRecognizer, input.screenshot),
        deps.ocrTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
        "OCR detection",
      );
    } catch (error) {
      const stageError = classifyDetectorError("OCR detection", error);
      return { ok: false, error: failure(stageError.code, stageError.message) };
    }

    let faceDetections: Detection[];
    try {
      faceDetections = await withTimeout(
        runFaceDetection(deps.faceDetector, input.screenshot),
        deps.faceTimeoutMs ?? DEFAULT_FACE_TIMEOUT_MS,
        "Face detection",
      );
    } catch (error) {
      const stageError = classifyDetectorError("Face detection", error);
      return { ok: false, error: failure(stageError.code, stageError.message) };
    }

    const allDetections = [...domDetections, ...ocrDetections, ...faceDetections];

    let redactionMap;
    let redactedRaster;
    let redactedAccessibility;
    try {
      redactionMap = mergeDetections(allDetections, {
        width: input.screenshot.width,
        height: input.screenshot.height,
      });
      redactedRaster = redactScreenshot(input.screenshot, redactionMap);
      redactedAccessibility = redactAccessibilitySnapshot(input.snapshot.elements, redactionMap);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Merging detections failed.";
      return { ok: false, error: failure("MERGE_FAILED", message) };
    }

    let encoded;
    try {
      encoded = await deps.encoder.encode(redactedRaster);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Encoding the redacted screenshot failed.";
      return { ok: false, error: failure("MERGE_FAILED", message) };
    }

    const now = deps.now ?? Date.now;
    const candidateObservation = {
      contractVersion: CONTRACT_VERSION,
      taskId: input.taskId,
      task: redactTaskText(input.task),
      urlOrigin,
      screenshot: {
        mimeType: encoded.mimeType,
        width: redactedRaster.width,
        height: redactedRaster.height,
        dataBase64: encoded.dataBase64,
      },
      accessibilitySnapshot: redactedAccessibility,
      redactionSummary: summarizeRedactions(redactionMap),
      priorActions: input.priorActions ?? [],
    };

    // Defense in depth: even though this module builds the observation by
    // hand, it must still satisfy the exact wire contract before anything
    // downstream is allowed to treat it as safe to send.
    const parsed = SanitizedObservationSchema.safeParse(candidateObservation);
    if (!parsed.success) {
      return {
        ok: false,
        error: failure("UNKNOWN", "Sanitized observation failed contract validation."),
      };
    }
    const observation = parsed.data;

    const localAudit: LocalAudit = {
      taskId: input.taskId,
      originalScreenshot: input.screenshot,
      redactionMap,
      detections: allDetections,
      createdAt: now(),
    };

    void profile; // Runtime choice affects how detectors run upstream, not the observation shape.

    return { ok: true, observation, localAudit };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected sanitization failure.";
    return { ok: false, error: failure("UNKNOWN", message) };
  }
}

/**
 * Binds a `PrivacyEngine` (see phases/02-local-privacy-engine.md's exact
 * `{ sanitize(input, profile) }` interface) to one set of dependencies, so
 * callers such as the extension background script depend only on the
 * interface, not on dependency injection plumbing.
 */
export function createPrivacyEngine(deps: SanitizeDependencies): PrivacyEngine {
  return {
    sanitize: (input, profile) => sanitize(input, profile, deps),
  };
}

import type {
  SanitizationFailure,
  SanitizationFailureCode,
  SanitizedScreenshot,
} from "@orka/contracts";
import { CONTRACT_VERSION, SanitizedObservationSchema } from "@orka/contracts";
import { runDomDetectors } from "./detectors";
import type { ImageEncoder } from "./encoder";
import { mergeDetections } from "./merge";
import { ModelIntegrityError } from "./manifest";
import { runFaceDetection } from "./pixel/face";
import { runOcrDetection } from "./pixel/ocr";
import type { TilePlanOptions } from "./pixel/tiles";
import { pixelScanBudget } from "./policy";
import type { FaceDetector, TextRecognizer } from "./pixel/types";
import { redactAccessibilitySnapshot, redactScreenshot, summarizeRedactions } from "./redact";
import { redactTaskText } from "./taskText";
import type {
  CaptureInput,
  Detection,
  LocalAudit,
  PrivacyEngine,
  RasterImage,
  RuntimeProfile,
  SanitizationResult,
  SanitizationTimings,
} from "./types";
import { sanitizeUrlToOrigin, UnsafeUrlError } from "./url";

export type SanitizeDependencies = {
  textRecognizer: TextRecognizer;
  faceDetector: FaceDetector;
  encoder: ImageEncoder;
  ocrTimeoutMs?: number;
  faceTimeoutMs?: number;
  /**
   * Overrides the runtime-derived tiled OCR budget. `false` restricts OCR to
   * a single full-image pass; tests use it to isolate the full-image path.
   */
  ocrTiling?: TilePlanOptions | false;
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

function isValidScreenshot(screenshot: RasterImage): boolean {
  if (screenshot.width <= 0 || screenshot.height <= 0) return false;
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
    // The presence of the capture itself is the gate (Phase 6.5). A round that
    // captured no pixels is a snapshot-only round, not a failure; a round that
    // *did* capture is still validated, so a present-but-malformed capture is
    // refused rather than silently skipped. No caller-set flag can downgrade a
    // vision round into a text-only one.
    const screenshot = input.screenshot;
    if (screenshot && !isValidScreenshot(screenshot)) {
      return { ok: false, error: failure("CAPTURE_FAILED", "Captured screenshot is missing or malformed.") };
    }

    // Step 0 of docs2/02-pii-engine-speed.md: measure the scan before trying to
    // make it faster. The spans land on the local-only `LocalAudit`, so a speed
    // claim can be re-checked rather than believed.
    const now = deps.now ?? Date.now;
    const scanStartedAt = now();
    const timings: SanitizationTimings = {
      ocrMs: 0,
      fullImageOcrMs: 0,
      tileOcrMs: [],
      faceMs: 0,
      mergeMs: 0,
      encodeMs: 0,
      totalMs: 0,
    };

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

    // OCR and face detection read captured pixels; a snapshot-only round has
    // none, so it never invokes them. The deterministic DOM detectors above
    // still run, so dropping the capture removes work, not redaction.
    let ocrDetections: Detection[] = [];
    let faceDetections: Detection[] = [];
    if (screenshot) {
      // Fix 1 of docs2/02-pii-engine-speed.md: OCR and face use separate
      // workers and neither reads the other's output, so running them one after
      // the other pays `t(OCR) + t(face)` for what is really `max(...)`. Both
      // start together and are awaited together. Fail-closed is unchanged: if
      // either rejects or times out, `Promise.all` rejects and the whole scan
      // fails closed exactly as before -- a partial result is never a scan.
      const timed = <T>(label: string, span: "ocrMs" | "faceMs", run: () => Promise<T>): Promise<T> => {
        const startedAt = now();
        return run().finally(() => {
          timings[span] = Math.max(0, now() - startedAt);
        }).catch((error) => {
          throw classifyDetectorError(label, error);
        });
      };

      const ocrPromise = timed("OCR detection", "ocrMs", () =>
        withTimeout(
          runOcrDetection(deps.textRecognizer, screenshot, {
            // The runtime profile decides how much of the capture is re-read at
            // native resolution; see PIXEL_SCAN_POLICY.
            tiling: deps.ocrTiling ?? pixelScanBudget(profile.mode),
            now,
            onSpan: (span) => {
              if (span.kind === "full") timings.fullImageOcrMs = span.ms;
              else timings.tileOcrMs.push(span.ms);
            },
          }),
          deps.ocrTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
          "OCR detection",
        ),
      );
      const facePromise = timed("Face detection", "faceMs", () =>
        withTimeout(
          runFaceDetection(deps.faceDetector, screenshot),
          deps.faceTimeoutMs ?? DEFAULT_FACE_TIMEOUT_MS,
          "Face detection",
        ),
      );

      try {
        [ocrDetections, faceDetections] = await Promise.all([ocrPromise, facePromise]);
      } catch (error) {
        const stageError = classifyDetectorError("detection", error);
        return { ok: false, error: failure(stageError.code, stageError.message) };
      }
    }

    const allDetections = [...domDetections, ...ocrDetections, ...faceDetections];

    // Snapshot boxes are already in viewport space when there is no image to
    // scale them into, so a snapshot-only round merges against viewport bounds.
    const bounds = screenshot
      ? { width: screenshot.width, height: screenshot.height }
      : { width: input.viewport.width, height: input.viewport.height };

    let redactionMap;
    let redactedAccessibility;
    let redactedScreenshot: SanitizedScreenshot | undefined;
    try {
      const mergeStartedAt = now();
      redactionMap = mergeDetections(allDetections, bounds);
      redactedAccessibility = redactAccessibilitySnapshot(input.snapshot.elements, redactionMap);
      timings.mergeMs = Math.max(0, now() - mergeStartedAt);
      if (screenshot) {
        const encodeStartedAt = now();
        const encoded = await deps.encoder.encode(redactScreenshot(screenshot, redactionMap));
        timings.encodeMs = Math.max(0, now() - encodeStartedAt);
        redactedScreenshot = {
          mimeType: encoded.mimeType,
          width: screenshot.width,
          height: screenshot.height,
          dataBase64: encoded.dataBase64,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Merging detections failed.";
      return { ok: false, error: failure("MERGE_FAILED", message) };
    }

    timings.totalMs = Math.max(0, now() - scanStartedAt);
    const candidateObservation = {
      contractVersion: CONTRACT_VERSION,
      taskId: input.taskId,
      task: redactTaskText(input.task),
      urlOrigin,
      ...(redactedScreenshot ? { screenshot: redactedScreenshot } : {}),
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
      ...(screenshot ? { originalScreenshot: screenshot } : {}),
      redactionMap,
      detections: allDetections,
      timings,
      createdAt: now(),
    };

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

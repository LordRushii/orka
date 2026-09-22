import { describe, expect, test } from "bun:test";
import { sanitize, type SanitizeDependencies } from "../src/sanitize";
import type { CaptureInput, RasterImage, RuntimeProfile } from "../src/types";

/**
 * Step 0 + Fix 1 of docs2/02-pii-engine-speed.md.
 *
 * Step 0 says measure before optimizing, so every claim here is a measured span
 * rather than an estimate. Fix 1 says OCR and face detection use separate
 * workers and are independent, so the scan should pay `max(t(OCR), t(face))`
 * instead of `t(OCR) + t(face)` -- which is only provable by wall clock.
 */

const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "test" };

function blankImage(width = 40, height = 40): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
}

function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    taskId: "timings-1",
    task: "Find the pricing page.",
    url: "https://example.com/pricing",
    viewport: { width: 40, height: 40 },
    capturedAt: 0,
    screenshot: blankImage(),
    snapshot: { elements: [], textNodes: [] },
    ...overrides,
  };
}

function deps(overrides: Partial<SanitizeDependencies> = {}): SanitizeDependencies {
  return {
    textRecognizer: { recognize: async () => [] },
    faceDetector: { detect: async () => [] },
    encoder: {
      encode: async (image) => ({
        mimeType: "image/png",
        dataBase64: Buffer.from(image.data).toString("base64").slice(0, 64) || "AAAA",
      }),
    },
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sanitize timings: Step 0 instrumentation", () => {
  test("records a span for the full pass, each tile, face, and encode", async () => {
    const result = await sanitize(
      input({ snapshot: { elements: [], textNodes: [] } }),
      PROFILE,
      deps({
        // Force the tiled second pass on a tiny capture: 40px long side against
        // a 10px native budget.
        ocrTiling: { nativeSideLength: 10, overlap: 0, maxTiles: 4 },
        textRecognizer: {
          recognize: async () => {
            await sleep(2);
            return [];
          },
        },
        faceDetector: {
          detect: async () => {
            await sleep(2);
            return [];
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { timings } = result.localAudit;
    expect(timings.fullImageOcrMs).toBeGreaterThan(0);
    expect(timings.tileOcrMs.length).toBeGreaterThan(0);
    expect(timings.tileOcrMs.every((ms) => ms >= 0)).toBe(true);
    expect(timings.faceMs).toBeGreaterThan(0);
    expect(timings.encodeMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThan(0);
    // The spans are local evidence about this device, so they must not be part
    // of what leaves the extension.
    expect("timings" in result.observation).toBe(false);
  });

  test("a snapshot-only round records no pixel spans, only DOM work", async () => {
    const result = await sanitize(
      input({ screenshot: undefined }),
      PROFILE,
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { timings } = result.localAudit;
    expect(timings.ocrMs).toBe(0);
    expect(timings.faceMs).toBe(0);
    expect(timings.fullImageOcrMs).toBe(0);
    expect(timings.tileOcrMs).toEqual([]);
  });
});

describe("sanitize: OCR and face detection run concurrently (Fix 1)", () => {
  const STAGE_MS = 90;

  test("pays max(t(ocr), t(face)), not their sum", async () => {
    const depsForRun = deps({
      textRecognizer: {
        recognize: async () => {
          await sleep(STAGE_MS);
          return [];
        },
      },
      faceDetector: {
        detect: async () => {
          await sleep(STAGE_MS);
          return [];
        },
      },
    });

    const startedAt = Date.now();
    const result = await sanitize(input(), PROFILE, depsForRun);
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both stages really did run, and each took about a full stage.
    expect(result.localAudit.timings.ocrMs).toBeGreaterThanOrEqual(STAGE_MS - 20);
    expect(result.localAudit.timings.faceMs).toBeGreaterThanOrEqual(STAGE_MS - 20);
    // Sequential execution would cost ~2 x STAGE_MS. Allow generous slack for
    // a loaded CI box, but stay well under the sequential floor.
    expect(elapsed).toBeLessThan(STAGE_MS * 2 - 40);
  });

  test("either stage failing still fails the whole scan closed", async () => {
    let ocrRan = false;
    const result = await sanitize(
      input(),
      PROFILE,
      deps({
        textRecognizer: {
          recognize: async () => {
            ocrRan = true;
            await sleep(STAGE_MS);
            return [];
          },
        },
        faceDetector: {
          detect: async () => {
            throw new Error("face model crashed");
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_ERROR");
    // The OCR promise had already started; the run must not leave it dangling
    // as an unhandled rejection.
    await sleep(10);
    expect(ocrRan).toBe(true);
  });

  test("a per-stage timeout is reported with its own stage code", async () => {
    const result = await sanitize(
      input(),
      PROFILE,
      deps({
        faceDetector: { detect: () => new Promise(() => {}) },
        faceTimeoutMs: 20,
        textRecognizer: {
          recognize: async () => {
            await sleep(STAGE_MS);
            return [];
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_TIMEOUT");
    expect(result.error.message).toContain("Face detection");
  });
});

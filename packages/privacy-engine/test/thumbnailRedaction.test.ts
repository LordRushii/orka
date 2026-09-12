import { describe, expect, test } from "bun:test";
import { sanitize, type SanitizeDependencies } from "../src/sanitize";
import { redactScreenshot } from "../src/redact";
import { DETECTOR_INPUT_BUDGET, PIXEL_SCAN_POLICY } from "../src/policy";
import { planOcrTiles } from "../src/pixel/tiles";
import type { Box, CaptureInput, RasterImage, RuntimeProfile } from "../src/types";
import type { OcrToken, TextRecognizer } from "../src/pixel/types";

/**
 * Regression cover for "OCR misses PII text inside small/nested thumbnail
 * images": a full-page capture is downsampled to the detector's input budget
 * before detection runs, so text baked into a small embedded image drops
 * below the size the detector resolves and reaches the observation legible.
 */

/** Text shorter than this after the detector's own resize is not resolved. */
const MIN_RESOLVABLE_TEXT_PX = 8;

const CAPTURE = { width: 1920, height: 1080 };
const SAMPLE_EMAIL = ["jane.doe", "example.com"].join("@");

/** A block of flat colour standing in for one run of rendered text. */
type SyntheticText = { text: string; colour: [number, number, number]; box: Box };

/** Large heading text in the main page body -- resolvable even downsampled. */
const HEADING: SyntheticText = {
  text: `Contact ${SAMPLE_EMAIL}`,
  colour: [255, 0, 0],
  box: { x: 120, y: 140, width: 460, height: 32 },
};

/** Tutorial-thumbnail text -- the case the original bug left unredacted. */
const THUMBNAIL: SyntheticText = {
  text: `Login ${SAMPLE_EMAIL}`,
  colour: [0, 255, 0],
  box: { x: 1430, y: 815, width: 180, height: 10 },
};

function paint(image: RasterImage, entry: SyntheticText): void {
  const [r, g, b] = entry.colour;
  for (let y = entry.box.y; y < entry.box.y + entry.box.height; y += 1) {
    for (let x = entry.box.x; x < entry.box.x + entry.box.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }
}

function pageCapture(): RasterImage {
  const image: RasterImage = {
    width: CAPTURE.width,
    height: CAPTURE.height,
    data: new Uint8ClampedArray(CAPTURE.width * CAPTURE.height * 4).fill(255),
  };
  paint(image, HEADING);
  paint(image, THUMBNAIL);
  return image;
}

/** Bounding box of a colour block inside whatever image the caller was handed. */
function findColourBounds(image: RasterImage, colour: [number, number, number]): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] !== colour[0]) continue;
      if (image.data[offset + 1] !== colour[1]) continue;
      if (image.data[offset + 2] !== colour[2]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Stands in for the real OCR worker, reproducing the one behaviour that
 * caused the bug: the detector resizes its input so the long side fits its
 * budget for the active runtime, and text that ends up shorter than
 * `MIN_RESOLVABLE_TEXT_PX` after that resize is never reported.
 *
 * Boxes are returned in the coordinate space of the image passed in, so a
 * tile pass returns tile-local boxes exactly as the real worker does.
 */
function resolutionLimitedRecognizer(
  entries: SyntheticText[],
  nativeSideLength = DETECTOR_INPUT_BUDGET.wasm,
): TextRecognizer & { calls: RasterImage[] } {
  const calls: RasterImage[] = [];
  return {
    calls,
    async recognize(image: RasterImage): Promise<OcrToken[]> {
      calls.push(image);
      const scale = Math.min(1, nativeSideLength / Math.max(image.width, image.height));
      const tokens: OcrToken[] = [];
      for (const entry of entries) {
        const bounds = findColourBounds(image, entry.colour);
        if (!bounds) continue;
        if (bounds.height * scale < MIN_RESOLVABLE_TEXT_PX) continue;
        tokens.push({ text: entry.text, box: bounds, confidence: 0.95 });
      }
      return tokens;
    },
  };
}

function deps(overrides: Partial<SanitizeDependencies> = {}): SanitizeDependencies {
  return {
    textRecognizer: resolutionLimitedRecognizer([HEADING, THUMBNAIL]),
    faceDetector: { detect: async () => [] },
    encoder: {
      encode: async () => ({ mimeType: "image/png", dataBase64: "AAAA" }),
    },
    ...overrides,
  };
}

function input(screenshot: RasterImage): CaptureInput {
  return {
    taskId: "task-thumbnail",
    task: "Summarize this tutorial.",
    url: "https://example.com/how-to",
    viewport: { width: CAPTURE.width, height: CAPTURE.height },
    capturedAt: 0,
    screenshot,
    snapshot: { elements: [], textNodes: [] },
  };
}

const PROFILE = (mode: RuntimeProfile["mode"]): RuntimeProfile => ({
  mode,
  override: "auto",
  reason: "test",
});

/** True when every pixel of `box` is a single opaque colour (a redaction bar). */
function isOpaquelyFilled(image: RasterImage, box: Box): boolean {
  const first = ((box.y | 0) * image.width + (box.x | 0)) * 4;
  const expected = [image.data[first], image.data[first + 1], image.data[first + 2], image.data[first + 3]];
  if (expected[3] !== 255) return false;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] !== expected[0]) return false;
      if (image.data[offset + 1] !== expected[1]) return false;
      if (image.data[offset + 2] !== expected[2]) return false;
      if (image.data[offset + 3] !== expected[3]) return false;
    }
  }
  return true;
}

function pixelAt(image: RasterImage, x: number, y: number): [number, number, number, number] {
  const offset = ((y | 0) * image.width + (x | 0)) * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function coversBox(map: Array<{ box: Box }>, target: Box): boolean {
  return map.some((entry) =>
    entry.box.x <= target.x &&
    entry.box.y <= target.y &&
    entry.box.x + entry.box.width >= target.x + target.width &&
    entry.box.y + entry.box.height >= target.y + target.height);
}

describe("pixel scan policy", () => {
  test("plans tiles at exactly the detector's input budget for every runtime", () => {
    // The reported bug's root cause: these were two independent numbers, and
    // `balanced` had them at 1280 (planner) against 736 (detector).
    for (const mode of ["webgpu", "balanced", "wasm"] as const) {
      expect(PIXEL_SCAN_POLICY[mode].nativeSideLength).toBe(DETECTOR_INPUT_BUDGET[mode]);
    }
  });

  test("affords enough tiles to cover a 1080p capture without growing them", () => {
    // If maxTiles is too small for a common viewport, tiles grow past the
    // detector budget and get downsampled -- the failure this test guards.
    for (const mode of ["webgpu", "balanced", "wasm"] as const) {
      for (const tile of planOcrTiles(CAPTURE, PIXEL_SCAN_POLICY[mode])) {
        expect(Math.max(tile.width, tile.height)).toBeLessThanOrEqual(DETECTOR_INPUT_BUDGET[mode]);
      }
    }
  });
});

describe("thumbnail PII redaction", () => {
  test("a single full-page pass misses PII inside a small embedded image", async () => {
    // Documents the reported failure: without the native-resolution pass the
    // thumbnail text is never detected, so it survives into the observation.
    const result = await sanitize(input(pageCapture()), PROFILE("wasm"), deps({ ocrTiling: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(coversBox(result.localAudit.redactionMap, HEADING.box)).toBe(true);
    expect(coversBox(result.localAudit.redactionMap, THUMBNAIL.box)).toBe(false);
  });

  test("the tiled native-resolution pass opaquely redacts small thumbnail PII", async () => {
    const screenshot = pageCapture();
    const result = await sanitize(input(screenshot), PROFILE("wasm"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(coversBox(result.localAudit.redactionMap, THUMBNAIL.box)).toBe(true);
    expect(coversBox(result.localAudit.redactionMap, HEADING.box)).toBe(true);

    // Golden-image check: the reported bug was that these pixels were
    // identical in the original and redacted panes.
    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expect(isOpaquelyFilled(redacted, THUMBNAIL.box)).toBe(true);
    expect(isOpaquelyFilled(redacted, HEADING.box)).toBe(true);
    expect(redacted.data).not.toEqual(screenshot.data);
  });

  test("reports the thumbnail detection in the coarse observation summary", async () => {
    const result = await sanitize(input(pageCapture()), PROFILE("wasm"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.observation.redactionSummary).toEqual([{ category: "EMAIL", count: 2 }]);
    // Raw OCR text never leaves the engine, even though it was classified locally.
    expect(JSON.stringify(result.observation)).not.toContain(SAMPLE_EMAIL);
  });

  test("leaves the original capture untouched for the local audit", async () => {
    const screenshot = pageCapture();
    const before = Uint8ClampedArray.from(screenshot.data);
    const result = await sanitize(input(screenshot), PROFILE("wasm"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.localAudit.originalScreenshot).toBe(screenshot);
    expect(screenshot.data).toEqual(before);
  });

  test("scans tiles at the detector's native resolution on every runtime mode", async () => {
    for (const mode of ["webgpu", "balanced", "wasm"] as const) {
      const budget = DETECTOR_INPUT_BUDGET[mode];
      const recognizer = resolutionLimitedRecognizer([HEADING, THUMBNAIL], budget);
      const result = await sanitize(input(pageCapture()), PROFILE(mode), deps({ textRecognizer: recognizer }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // One full-image pass plus at least one tile, bounded by the mode budget.
      expect(recognizer.calls.length).toBeGreaterThan(1);
      expect(recognizer.calls.length).toBeLessThanOrEqual(PIXEL_SCAN_POLICY[mode].maxTiles + 1);

      // Every tile must reach the detector unscaled. `balanced` previously
      // planned 1280px tiles for a detector that only accepts 736, so its
      // tiles were downsampled and small text was lost anyway.
      for (const call of recognizer.calls.slice(1)) {
        expect(Math.max(call.width, call.height)).toBeLessThanOrEqual(budget);
      }

      expect(coversBox(result.localAudit.redactionMap, THUMBNAIL.box)).toBe(true);
    }
  });

  test("fails closed when a tile pass throws, rather than reporting a partial scan", async () => {
    let call = 0;
    const result = await sanitize(
      input(pageCapture()),
      PROFILE("wasm"),
      deps({
        textRecognizer: {
          async recognize() {
            call += 1;
            if (call === 1) return [];
            throw new Error("tile inference crashed");
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_ERROR");
  });
});

describe("120x80 embedded thumbnail (issue fixture)", () => {
  /**
   * The fixture size named in the bug report: a 120x80px embedded image
   * carrying recognizable PII text, of the kind an article thumbnail holds.
   * The text inside it is 9px tall -- legible at native resolution, and below
   * what the detector resolves once a 1920px-wide capture is downsampled.
   */
  const IMAGE = { x: 1550, y: 900, width: 120, height: 80 };
  const TEXT: SyntheticText = {
    text: `Reset password for ${SAMPLE_EMAIL}`,
    colour: [0, 0, 255],
    box: { x: IMAGE.x + 8, y: IMAGE.y + 34, width: 104, height: 9 },
  };

  /** A page whose only PII is baked into one small embedded image. */
  function captureWithThumbnail(): RasterImage {
    const image: RasterImage = {
      width: CAPTURE.width,
      height: CAPTURE.height,
      data: new Uint8ClampedArray(CAPTURE.width * CAPTURE.height * 4).fill(255),
    };
    // The thumbnail's own frame, then the PII text rendered inside it.
    paint(image, { text: "", colour: [235, 235, 235], box: IMAGE });
    paint(image, TEXT);
    return image;
  }

  function thumbnailDeps(overrides: Partial<SanitizeDependencies> = {}) {
    return deps({ textRecognizer: resolutionLimitedRecognizer([TEXT]), ...overrides });
  }

  test("is missed by a single full-page pass (the reported bug)", async () => {
    const result = await sanitize(
      input(captureWithThumbnail()),
      PROFILE("wasm"),
      thumbnailDeps({ ocrTiling: false }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.redactionSummary).toEqual([]);
    expect(result.localAudit.redactionMap).toHaveLength(0);
  });

  test("is opaquely redacted once the native-resolution pass runs", async () => {
    const screenshot = captureWithThumbnail();
    const result = await sanitize(input(screenshot), PROFILE("wasm"), thumbnailDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.observation.redactionSummary).toEqual([{ category: "EMAIL", count: 1 }]);
    expect(coversBox(result.localAudit.redactionMap, TEXT.box)).toBe(true);

    // The bug was that these pixels matched the original exactly.
    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expect(isOpaquelyFilled(redacted, TEXT.box)).toBe(true);

    const before = pixelAt(screenshot, TEXT.box.x + 2, TEXT.box.y + 2);
    const after = pixelAt(redacted, TEXT.box.x + 2, TEXT.box.y + 2);
    expect(after).not.toEqual(before);
  });

  test("is redacted on every runtime mode, not just the fastest one", async () => {
    for (const mode of ["webgpu", "balanced", "wasm"] as const) {
      const screenshot = captureWithThumbnail();
      const result = await sanitize(
        input(screenshot),
        PROFILE(mode),
        deps({ textRecognizer: resolutionLimitedRecognizer([TEXT], DETECTOR_INPUT_BUDGET[mode]) }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
      expect(isOpaquelyFilled(redacted, TEXT.box)).toBe(true);
    }
  });

  test("keeps the thumbnail's text out of the observation entirely", async () => {
    const result = await sanitize(input(captureWithThumbnail()), PROFILE("wasm"), thumbnailDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.observation);
    expect(serialized).not.toContain(SAMPLE_EMAIL);
    expect(serialized).not.toContain("Reset password");
  });

  test("redacts a thumbnail sitting on a tile seam", async () => {
    // A thumbnail straddling two tiles must not fall between them; tiles
    // overlap precisely so the text is whole inside at least one of them.
    const tiles = planOcrTiles(CAPTURE, PIXEL_SCAN_POLICY.wasm);
    const seamX = tiles.find((tile) => tile.x > 0)?.x ?? 0;
    expect(seamX).toBeGreaterThan(0);

    const seamText: SyntheticText = {
      text: `Support ${SAMPLE_EMAIL}`,
      colour: [255, 0, 255],
      box: { x: seamX - 40, y: 500, width: 100, height: 9 },
    };
    const screenshot: RasterImage = {
      width: CAPTURE.width,
      height: CAPTURE.height,
      data: new Uint8ClampedArray(CAPTURE.width * CAPTURE.height * 4).fill(255),
    };
    paint(screenshot, seamText);

    const result = await sanitize(
      input(screenshot),
      PROFILE("wasm"),
      deps({ textRecognizer: resolutionLimitedRecognizer([seamText]) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expect(isOpaquelyFilled(redacted, seamText.box)).toBe(true);
  });
});

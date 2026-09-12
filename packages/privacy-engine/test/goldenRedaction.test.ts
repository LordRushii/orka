import { describe, expect, test } from "bun:test";
import { sanitize, type SanitizeDependencies } from "../src/sanitize";
import { redactScreenshot } from "../src/redact";
import { MODEL_MANIFEST } from "../src/manifest";
import type { Box, CaptureInput, RasterImage, RuntimeProfile } from "../src/types";

/**
 * Golden redaction fixtures for the two pixel detectors, exercised in
 * isolation: an OCR-only capture (no faces, no DOM PII) and a face-only
 * capture (no text at all). Asserting on the painted pixels -- not just the
 * redaction map -- is what proves a detection actually became an opaque fill.
 */

const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "test" };
const CANVAS = { width: 320, height: 240 };
const BACKGROUND = 200;

/** Exact opaque fills from redact.ts, asserted as goldens. */
const GOLDEN_FILL = {
  GOVT_ID: [120, 53, 15, 255],
  CARD: [88, 28, 135, 255],
  FACE: [30, 64, 175, 255],
  EMAIL: [7, 89, 133, 255],
  PHONE: [21, 94, 117, 255],
} as const;

const SAMPLE_AADHAAR = "2345 6789 0123";
const SAMPLE_CARD = "4111 1111 1111 1111";

function canvas(): RasterImage {
  return {
    width: CANVAS.width,
    height: CANVAS.height,
    data: new Uint8ClampedArray(CANVAS.width * CANVAS.height * 4).fill(BACKGROUND),
  };
}

function baseDeps(overrides: Partial<SanitizeDependencies> = {}): SanitizeDependencies {
  return {
    textRecognizer: { recognize: async () => [] },
    faceDetector: { detect: async () => [] },
    encoder: { encode: async () => ({ mimeType: "image/png", dataBase64: "AAAA" }) },
    ...overrides,
  };
}

function baseInput(screenshot: RasterImage): CaptureInput {
  return {
    taskId: "task-golden",
    task: "Describe what is on screen.",
    url: "https://example.com/profile",
    viewport: CANVAS,
    capturedAt: 0,
    screenshot,
    // No DOM PII: whatever gets redacted came from the pixel detectors alone.
    snapshot: { elements: [], textNodes: [] },
  };
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

/** Asserts every pixel of `box` equals `fill` exactly. */
function expectFilled(image: RasterImage, box: Box, fill: readonly number[]): void {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  expect(x1).toBeGreaterThan(x0);
  expect(y1).toBeGreaterThan(y0);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (pixelAt(image, x, y).join() !== fill.join()) {
        throw new Error(`pixel (${x}, ${y}) is ${pixelAt(image, x, y).join()}, expected ${fill.join()}`);
      }
    }
  }
}

function boxFor(map: Array<{ category: string; box: Box }>, category: string): Box {
  const entry = map.find((item) => item.category === category);
  if (!entry) throw new Error(`no ${category} entry in the redaction map`);
  return entry.box;
}

describe("golden fixture: OCR-only capture", () => {
  const AADHAAR_BOX = { x: 20, y: 30, width: 180, height: 18 };
  const CARD_BOX = { x: 20, y: 120, width: 200, height: 18 };

  function ocrOnlyDeps() {
    return baseDeps({
      textRecognizer: {
        recognize: async () => [
          { text: `Aadhaar ${SAMPLE_AADHAAR}`, box: AADHAAR_BOX, confidence: 0.97 },
          { text: `Card ${SAMPLE_CARD}`, box: CARD_BOX, confidence: 0.96 },
          // Ordinary page copy: must not produce a redaction.
          { text: "Welcome back to your dashboard", box: { x: 20, y: 200, width: 220, height: 14 }, confidence: 0.98 },
        ],
      },
    });
  }

  test("redacts every OCR-detected identifier and nothing else", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, ocrOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const categories = result.observation.redactionSummary.map((e) => e.category).sort();
    expect(categories).toEqual(["CARD", "GOVT_ID"]);
    expect(result.localAudit.redactionMap).toHaveLength(2);
  });

  test("paints each identifier with its exact opaque category fill", async () => {
    const screenshot = canvas();
    const result = await sanitize(baseInput(screenshot), PROFILE, ocrOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expectFilled(redacted, boxFor(result.localAudit.redactionMap, "GOVT_ID"), GOLDEN_FILL.GOVT_ID);
    expectFilled(redacted, boxFor(result.localAudit.redactionMap, "CARD"), GOLDEN_FILL.CARD);
  });

  test("covers the full detected text box, padded outward", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, ocrOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Fail-closed padding: the redaction must never be smaller than the text.
    const govt = boxFor(result.localAudit.redactionMap, "GOVT_ID");
    expect(govt.x).toBeLessThanOrEqual(AADHAAR_BOX.x);
    expect(govt.y).toBeLessThanOrEqual(AADHAAR_BOX.y);
    expect(govt.x + govt.width).toBeGreaterThanOrEqual(AADHAAR_BOX.x + AADHAAR_BOX.width);
    expect(govt.y + govt.height).toBeGreaterThanOrEqual(AADHAAR_BOX.y + AADHAAR_BOX.height);
  });

  test("leaves non-PII page copy untouched", async () => {
    const screenshot = canvas();
    const result = await sanitize(baseInput(screenshot), PROFILE, ocrOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expect(pixelAt(redacted, 25, 205)).toEqual([BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND]);
    expect(pixelAt(redacted, 300, 230)).toEqual([BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND]);
  });

  test("keeps the recognized identifier out of the observation", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, ocrOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.observation);
    expect(serialized).not.toContain(SAMPLE_AADHAAR);
    expect(serialized).not.toContain(SAMPLE_CARD);
    expect(serialized).not.toContain("Welcome back");
  });

  test("reports no face regions when the capture has none", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, ocrOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.redactionSummary.find((e) => e.category === "FACE")).toBeUndefined();
  });
});

describe("golden fixture: face-only capture", () => {
  const LEFT_FACE = { x: 30, y: 40, width: 60, height: 70 };
  const RIGHT_FACE = { x: 200, y: 40, width: 58, height: 68 };

  function faceOnlyDeps() {
    return baseDeps({
      faceDetector: {
        detect: async () => [
          { box: LEFT_FACE, confidence: 0.93 },
          { box: RIGHT_FACE, confidence: 0.88 },
        ],
      },
    });
  }

  test("redacts every detected face region", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, faceOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.observation.redactionSummary).toEqual([{ category: "FACE", count: 2 }]);
    expect(result.localAudit.redactionMap).toHaveLength(2);
  });

  test("paints both faces with the exact opaque face fill", async () => {
    const screenshot = canvas();
    const result = await sanitize(baseInput(screenshot), PROFILE, faceOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    for (const entry of result.localAudit.redactionMap) {
      expectFilled(redacted, entry.box, GOLDEN_FILL.FACE);
    }
  });

  test("covers each detected face box, padded outward", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, faceOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const face of [LEFT_FACE, RIGHT_FACE]) {
      const covering = result.localAudit.redactionMap.filter((entry) =>
        entry.box.x <= face.x &&
        entry.box.y <= face.y &&
        entry.box.x + entry.box.width >= face.x + face.width &&
        entry.box.y + entry.box.height >= face.y + face.height);
      expect(covering).toHaveLength(1);
    }
  });

  test("gives a less confident face a larger redaction margin", async () => {
    // Fail-closed rule: uncertain detections enlarge the redaction region.
    const screenshot = canvas();
    const result = await sanitize(
      baseInput(screenshot),
      PROFILE,
      baseDeps({
        faceDetector: {
          detect: async () => [
            { box: { x: 30, y: 40, width: 60, height: 60 }, confidence: 0.99 },
            { box: { x: 200, y: 40, width: 60, height: 60 }, confidence: 0.55 },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [confident, uncertain] = result.localAudit.redactionMap
      .slice()
      .sort((a, b) => a.box.x - b.box.x);
    expect(uncertain!.box.width).toBeGreaterThan(confident!.box.width);
    expect(uncertain!.box.height).toBeGreaterThan(confident!.box.height);
  });

  test("reports no text categories when the capture has no text", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, faceOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.redactionSummary.map((e) => e.category)).toEqual(["FACE"]);
  });

  test("leaves background pixels between the faces untouched", async () => {
    const screenshot = canvas();
    const result = await sanitize(baseInput(screenshot), PROFILE, faceOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expect(pixelAt(redacted, 150, 200)).toEqual([BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND]);
  });

  test("never exposes face coordinates in the observation", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, faceOnlyDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only a coarse count leaves the engine; exact boxes stay in the audit.
    expect(result.observation.redactionSummary).toEqual([{ category: "FACE", count: 2 }]);
    expect(JSON.stringify(result.observation)).not.toContain('"box"');
  });
});

describe("golden fixture: all PII categories in one image", () => {
  // Acceptance criterion: "A synthetic image containing email, phone,
  // Aadhaar/PAN, and card text produces opaque redaction boxes in the output
  // screenshot." Every value here exists only in the pixels -- the DOM
  // snapshot is empty, so OCR is the sole source of these detections.
  const REGIONS = {
    EMAIL: { text: `Email ${["jane.doe", "example.com"].join("@")}`, box: { x: 16, y: 16, width: 200, height: 16 } },
    PHONE: { text: "Phone +91 98765 43210", box: { x: 16, y: 56, width: 200, height: 16 } },
    GOVT_ID: { text: `Aadhaar ${SAMPLE_AADHAAR}`, box: { x: 16, y: 96, width: 200, height: 16 } },
    CARD: { text: `Card ${SAMPLE_CARD}`, box: { x: 16, y: 136, width: 210, height: 16 } },
  } as const;

  function allPiiDeps() {
    return baseDeps({
      textRecognizer: {
        recognize: async () =>
          Object.values(REGIONS).map((region) => ({
            text: region.text,
            box: region.box,
            confidence: 0.97,
          })),
      },
    });
  }

  test("produces an opaque redaction box for every category", async () => {
    const screenshot = canvas();
    const result = await sanitize(baseInput(screenshot), PROFILE, allPiiDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const categories = result.observation.redactionSummary.map((e) => e.category).sort();
    expect(categories).toEqual(["CARD", "EMAIL", "GOVT_ID", "PHONE"]);

    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    for (const category of ["EMAIL", "PHONE", "GOVT_ID", "CARD"] as const) {
      expectFilled(redacted, boxFor(result.localAudit.redactionMap, category), GOLDEN_FILL[category]);
    }
  });

  test("covers each source text region completely", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, allPiiDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const [category, region] of Object.entries(REGIONS)) {
      const box = boxFor(result.localAudit.redactionMap, category);
      expect(box.x).toBeLessThanOrEqual(region.box.x);
      expect(box.y).toBeLessThanOrEqual(region.box.y);
      expect(box.x + box.width).toBeGreaterThanOrEqual(region.box.x + region.box.width);
      expect(box.y + box.height).toBeGreaterThanOrEqual(region.box.y + region.box.height);
    }
  });

  test("leaks none of the recognized values into the observation", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, allPiiDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.observation);
    for (const region of Object.values(REGIONS)) {
      expect(serialized).not.toContain(region.text);
    }
    expect(serialized).not.toContain("98765");
    expect(serialized).not.toContain(SAMPLE_AADHAAR);
    expect(serialized).not.toContain(SAMPLE_CARD);
  });

  test("never exposes model URLs or pinned hashes in the observation", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, allPiiDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.observation);
    for (const entry of Object.values(MODEL_MANIFEST)) {
      expect(serialized).not.toContain(entry.url);
      expect(serialized).not.toContain(entry.sha256);
      expect(serialized).not.toContain(entry.name);
    }
    expect(serialized).not.toContain(".onnx");
    expect(serialized).not.toContain("sha256");
  });

  test("keeps exact boxes in the local audit only, not the observation", async () => {
    const result = await sanitize(baseInput(canvas()), PROFILE, allPiiDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.localAudit.redactionMap).toHaveLength(4);
    expect(result.localAudit.redactionMap[0]!.box).toBeDefined();
    // The observation carries counts per category and nothing more.
    for (const entry of result.observation.redactionSummary) {
      expect(Object.keys(entry).sort()).toEqual(["category", "count"]);
    }
  });
});

describe("golden fixture: combined capture", () => {
  test("redacts text and faces together without either suppressing the other", async () => {
    const screenshot = canvas();
    const result = await sanitize(
      baseInput(screenshot),
      PROFILE,
      baseDeps({
        textRecognizer: {
          recognize: async () => [
            { text: `Aadhaar ${SAMPLE_AADHAAR}`, box: { x: 20, y: 30, width: 180, height: 18 }, confidence: 0.97 },
          ],
        },
        faceDetector: {
          detect: async () => [{ box: { x: 40, y: 150, width: 60, height: 70 }, confidence: 0.92 }],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.observation.redactionSummary.map((e) => e.category).sort()).toEqual(["FACE", "GOVT_ID"]);
    const redacted = redactScreenshot(screenshot, result.localAudit.redactionMap);
    expectFilled(redacted, boxFor(result.localAudit.redactionMap, "GOVT_ID"), GOLDEN_FILL.GOVT_ID);
    expectFilled(redacted, boxFor(result.localAudit.redactionMap, "FACE"), GOLDEN_FILL.FACE);
  });

  test("an email in a face region resolves to the higher-priority category", async () => {
    const overlap = { x: 50, y: 50, width: 60, height: 60 };
    const result = await sanitize(
      baseInput(canvas()),
      PROFILE,
      baseDeps({
        textRecognizer: {
          recognize: async () => [
            { text: ["jane.doe", "example.com"].join("@"), box: overlap, confidence: 0.95 },
          ],
        },
        faceDetector: { detect: async () => [{ box: overlap, confidence: 0.95 }] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // FACE outranks EMAIL in DETECTION_POLICY.priority, and the region is
    // covered exactly once rather than double-painted.
    expect(result.localAudit.redactionMap).toHaveLength(1);
    expect(result.localAudit.redactionMap[0]!.category).toBe("FACE");
  });
});

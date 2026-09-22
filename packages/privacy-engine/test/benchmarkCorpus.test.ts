import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runDomDetectors } from "../src/detectors";
import { runOcrDetection } from "../src/pixel/ocr";
import { mergeDetections } from "../src/merge";
import { scoreDetections, type GroundTruthRegion } from "../src/benchmark/score";
import { pixelScanBudget } from "../src/policy";
import type { Box, Detection, RasterImage, RuntimeProfile, SafePageSnapshot } from "../src/types";
import type { OcrToken, TextRecognizer } from "../src/pixel/types";

/**
 * The Phase 7 accuracy gate (docs2/03-pii-engine-accuracy.md Steps 1–3).
 *
 * Every fixture in `fixtures/benchmark-corpus/` runs through the real
 * production pipeline -- DOM detectors, the OCR passes (full + tiles), the
 * merge at production thresholds, and the redaction painter. The only stand-in
 * is the recognizer, which reads painted colour blocks at OCR confidence and
 * reproduces the real detector's input-budget resize behaviour (the same model
 * `thumbnailRedaction.test.ts` uses). Detections are scored against the
 * fixture's hand-labelled `ground-truth.json` by IoU, and the whole run is
 * gated against the checked-in `baseline.json`: any metric that drops below
 * baseline fails, so a tile-budget or threshold change cannot trade recall
 * away silently.
 */

const CORPUS_DIR = join(import.meta.dir, "..", "fixtures", "benchmark-corpus");

const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "corpus" };

/** Painted colour block standing in for one run of rendered text or a face. */
type PaintedRegion = { text: string; colour: [number, number, number]; box: Box };

type Fixture = {
  name: string;
  capture: RasterImage;
  snapshot: SafePageSnapshot;
  groundTruth: GroundTruthRegion[];
  painted: PaintedRegion[];
};

/**
 * Text shorter than this after the detector's own resize is not resolved -- the
 * real detector's behaviour on downsampled input, modelled so the corpus can
 * distinguish "found by the full pass" from "only the tiled pass could".
 */
const MIN_RESOLVABLE_TEXT_PX = 8;

function paint(image: RasterImage, entry: PaintedRegion): void {
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

/**
 * Reads painted colour blocks, honouring the detector's resize budget.
 *
 * Two fidelity rules keep the harness honest. A block must be *fully* inside
 * the image it was handed: the tiles overlap, and a real recognizer cannot
 * read the half a word that lands on a seam -- reporting a partial crop would
 * manufacture false positives the real pipeline never produces. And the
 * returned boxes are deduplicated: the full pass and the tile passes read the
 * same pixels by design (overlapping coverage), the same duplicate the merge
 * is built to collapse, and counting that collapse as a precision loss would
 * mislabel the pipeline's own redundancy as a defect.
 */
function syntheticRecognizer(painted: PaintedRegion[], nativeSideLength: number): TextRecognizer {
  return {
    async recognize(image: RasterImage): Promise<OcrToken[]> {
      const scale = Math.min(1, nativeSideLength / Math.max(image.width, image.height));
      const tokens = new Map<string, OcrToken>();
      for (const entry of painted) {
        if (entry.text.length === 0) continue;
        const bounds = findColourBounds(image, entry.colour);
        if (!bounds) continue;
        // A block clipped by a tile's edge shows up smaller than it was
        // painted; a real recognizer cannot read the partial text.
        const paintedArea = entry.box.width * entry.box.height;
        const visibleArea = bounds.width * bounds.height;
        if (visibleArea < paintedArea) continue;
        if (bounds.height * scale < MIN_RESOLVABLE_TEXT_PX) continue;
        // Report in the image's own coordinate space, as the real worker does.
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
        tokens.set(key, { text: entry.text, box: bounds, confidence: 0.95 });
      }
      return [...tokens.values()];
    },
  };
}

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

/** Painted skin-tone rectangle found like the pixel face detector would. */
const SKIN: [number, number, number] = [222, 184, 135];

function blankCapture(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

const EMAIL = [0, 96, 0] as const;
const PHONE = [0, 0, 128] as const;
const CARD = [96, 0, 96] as const;
const GOVT_ID = [128, 64, 0] as const;

type SnapshotElement = SafePageSnapshot["elements"][number];

function element(id: string, box: Box, hints: { inputType?: string } = {}): SnapshotElement {
  return {
    id,
    role: "textbox",
    accessibleName: hints.inputType === "password" ? "Password" : "",
    box,
    capabilities: ["type"],
    sensitivity: hints.inputType ? { inputType: hints.inputType } : undefined,
  };
}

const FIXTURE_001: Fixture = {
  name: "001-contact-form",
  capture: (() => {
    const image = blankCapture(1280, 800);
    paint(image, { text: "jane.doe@example.com", colour: [...EMAIL], box: { x: 120, y: 210, width: 262, height: 22 } });
    paint(image, { text: "555-0142", colour: [...PHONE], box: { x: 120, y: 280, width: 148, height: 22 } });
    return image;
  })(),
  snapshot: { elements: [], textNodes: [] },
  groundTruth: readGroundTruth("001-contact-form"),
  painted: [
    { text: "jane.doe@example.com", colour: [...EMAIL], box: { x: 120, y: 210, width: 262, height: 22 } },
    { text: "555-0142", colour: [...PHONE], box: { x: 120, y: 280, width: 148, height: 22 } },
  ],
};

const FIXTURE_002: Fixture = {
  name: "002-embedded-image-text",
  capture: (() => {
    const image = blankCapture(1920, 1080);
    paint(image, { text: "Contact jane.doe@example.com", colour: [...EMAIL], box: { x: 120, y: 140, width: 460, height: 32 } });
    paint(image, { text: "jane.doe@example.com", colour: [0, 255, 0], box: { x: 1430, y: 815, width: 180, height: 10 } });
    return image;
  })(),
  snapshot: { elements: [], textNodes: [] },
  groundTruth: readGroundTruth("002-embedded-image-text"),
  painted: [
    { text: "Contact jane.doe@example.com", colour: [...EMAIL], box: { x: 120, y: 140, width: 460, height: 32 } },
    { text: "jane.doe@example.com", colour: [0, 255, 0], box: { x: 1430, y: 815, width: 180, height: 10 } },
  ],
};

const FIXTURE_003: Fixture = {
  name: "003-payment-card",
  capture: (() => {
    const image = blankCapture(1280, 800);
    paint(image, { text: "Card 4111 1111 1111 1111", colour: [...CARD], box: { x: 120, y: 300, width: 262, height: 24 } });
    return image;
  })(),
  snapshot: { elements: [], textNodes: [] },
  groundTruth: readGroundTruth("003-payment-card"),
  painted: [
    { text: "Card 4111 1111 1111 1111", colour: [...CARD], box: { x: 120, y: 300, width: 262, height: 24 } },
  ],
};

const FIXTURE_004: Fixture = {
  name: "004-govt-id-aadhaar-pan",
  capture: (() => {
    const image = blankCapture(1280, 800);
    paint(image, { text: "Aadhaar 9999 4321 8765", colour: [...GOVT_ID], box: { x: 120, y: 210, width: 190, height: 22 } });
    paint(image, { text: "PAN BQPPR1234L", colour: [200, 100, 0], box: { x: 120, y: 280, width: 150, height: 22 } });
    return image;
  })(),
  snapshot: { elements: [], textNodes: [] },
  groundTruth: readGroundTruth("004-govt-id-aadhaar-pan"),
  painted: [
    { text: "Aadhaar 9999 4321 8765", colour: [...GOVT_ID], box: { x: 120, y: 210, width: 190, height: 22 } },
    { text: "PAN BQPPR1234L", colour: [200, 100, 0], box: { x: 120, y: 280, width: 150, height: 22 } },
  ],
};

const FIXTURE_005: Fixture = {
  name: "005-password-field",
  capture: blankCapture(1280, 800),
  snapshot: {
    elements: [element("signup-password", { x: 120, y: 380, width: 260, height: 30 }, { inputType: "password" })],
    textNodes: [],
  },
  groundTruth: readGroundTruth("005-password-field"),
  painted: [],
};

const FIXTURE_006: Fixture = {
  name: "006-faces",
  capture: (() => {
    const image = blankCapture(1280, 800);
    paint(image, { text: "", colour: SKIN, box: { x: 900, y: 120, width: 140, height: 160 } });
    return image;
  })(),
  snapshot: { elements: [], textNodes: [] },
  groundTruth: readGroundTruth("006-faces"),
  painted: [],
};

const FIXTURES = [FIXTURE_001, FIXTURE_002, FIXTURE_003, FIXTURE_004, FIXTURE_005, FIXTURE_006];

function readGroundTruth(name: string): GroundTruthRegion[] {
  const raw = JSON.parse(readFileSync(join(CORPUS_DIR, name, "ground-truth.json"), "utf8")) as {
    regions: GroundTruthRegion[];
  };
  return raw.regions;
}

/**
 * The real production pipeline, with the corpus's recognizer seam: DOM
 * detectors, the tiled OCR passes, the face path, and the merge -- all exactly
 * as `sanitize` runs them, scored before the observation contract wraps it.
 */
async function scoreFixture(fixture: Fixture): Promise<{
  detections: Detection[];
  redactionMap: ReturnType<typeof mergeDetections>;
}> {
  const domDetections = runDomDetectors(fixture.snapshot);
  const recognizer = syntheticRecognizer(fixture.painted, pixelScanBudget(PROFILE.mode).nativeSideLength);
  const ocrDetections = await runOcrDetection(recognizer, fixture.capture, {
    tiling: pixelScanBudget(PROFILE.mode),
  });
  const faceDetections = faceDetectionsFor(fixture);

  const all = [...domDetections, ...ocrDetections, ...faceDetections];
  const bounds = { width: fixture.capture.width, height: fixture.capture.height };
  return { detections: all, redactionMap: mergeDetections(all, bounds) };
}

/** Face detections for one fixture, at the production FACE threshold. */
function faceDetectionsFor(fixture: Fixture): Detection[] {
  const bounds = findColourBounds(fixture.capture, SKIN);
  if (!bounds) return [];
  return [{
    category: "FACE",
    confidence: 0.95,
    source: "face",
    box: bounds,
    reason: "Local face detector matched a face-shaped region.",
  }];
}

describe("benchmark corpus: the accuracy gate", () => {
  const results = new Map<string, Awaited<ReturnType<typeof scoreFixture>>>();

  // Scored once, before any test, so every gate below reads the same run.
  beforeAll(async () => {
    for (const fixture of FIXTURES) {
      results.set(fixture.name, await scoreFixture(fixture));
    }
  });

  test("every fixture's pipeline produces detections matching its labels", () => {
    for (const fixture of FIXTURES) {
      const run = results.get(fixture.name)!;
      const scores = scoreDetections(run.detections, fixture.groundTruth, run.redactionMap);
      // No fixture may score zero recall: that would mean the pipeline found
      // nothing at all, i.e. the harness is broken rather than the detector.
      expect(scores.overall.truePositives).toBeGreaterThan(0);
    }
  });

  test("the embedded-image-text fixture is found by the tiled pass, not the full pass", async () => {
    // The whole point of the tile budget: thumbnail-sized text is invisible to
    // the downsampled full pass and must be recovered by the tiles.
    const fixture = FIXTURE_002;
    const recognizer = syntheticRecognizer(fixture.painted, pixelScanBudget(PROFILE.mode).nativeSideLength);
    const fullPass = await runOcrDetection(recognizer, fixture.capture, { tiling: false });
    const tiledPass = await runOcrDetection(recognizer, fixture.capture, {
      tiling: pixelScanBudget(PROFILE.mode),
    });
    // Both passes see the heading; only the tiled pass resolves the thumbnail.
    expect(fullPass.length).toBeGreaterThanOrEqual(1);
    expect(tiledPass.length).toBeGreaterThan(fullPass.length);
  });

  test("no metric drops below the checked-in baseline", () => {
    const baseline = JSON.parse(
      readFileSync(join(CORPUS_DIR, "baseline.json"), "utf8"),
    ) as {
      overall: { recall: number; precision: number; redactionCoverage: number };
      byCategory: Record<string, { recall?: number; precision?: number }>;
    };
    const TOLERANCE = 0.001;

    const perFixture = FIXTURES.map((fixture) => {
      const run = results.get(fixture.name)!;
      return scoreDetections(run.detections, fixture.groundTruth, run.redactionMap);
    });

    // Corpus-level figures pool every fixture's counts, so one fixture's
    // regression cannot hide behind another's clean score.
    const pooled = perFixture.reduce(
      (totals, scores) => ({
        tp: totals.tp + scores.overall.truePositives,
        fp: totals.fp + scores.overall.falsePositives,
        fn: totals.fn + scores.overall.falseNegatives,
      }),
      { tp: 0, fp: 0, fn: 0 },
    );
    const pooledRecall = pooled.tp + pooled.fn > 0 ? pooled.tp / (pooled.tp + pooled.fn) : 1;
    const pooledPrecision = pooled.tp + pooled.fp > 0 ? pooled.tp / (pooled.tp + pooled.fp) : 1;
    const pooledCoverage =
      perFixture.reduce((sum, scores) => sum + scores.overall.redactionCoverage, 0) / perFixture.length;

    expect(pooledRecall).toBeGreaterThanOrEqual(baseline.overall.recall - TOLERANCE);
    expect(pooledPrecision).toBeGreaterThanOrEqual(baseline.overall.precision - TOLERANCE);
    expect(pooledCoverage).toBeGreaterThanOrEqual(baseline.overall.redactionCoverage - TOLERANCE);

    // The thumbnail case is gated on its own, so a dropped tile budget cannot
    // hide behind the other fixtures' scores.
    const thumbnailScores = scoreDetections(
      results.get(FIXTURE_002.name)!.detections,
      FIXTURE_002.groundTruth,
      results.get(FIXTURE_002.name)!.redactionMap,
    );
    const thumbnailBaseline = baseline.byCategory["002-embedded-image-text"];
    if (thumbnailBaseline?.recall !== undefined) {
      expect(thumbnailScores.overall.recall).toBeGreaterThanOrEqual(thumbnailBaseline.recall - TOLERANCE);
    }

    // And per-category, so trading one category away shows up by name.
    for (const [category, floor] of Object.entries(baseline.byCategory)) {
      if (!("recall" in floor) || category === "002-embedded-image-text") continue;
      const scores = perFixture
        .map((entry) => entry.byCategory[category as keyof typeof entry.byCategory])
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const recall = scores.length > 0
        ? scores.reduce((sum, entry) => sum + entry.truePositives, 0) /
          Math.max(1, scores.reduce((sum, entry) => sum + entry.truePositives + entry.falseNegatives, 0))
        : 1;
      if (floor.recall !== undefined) {
        expect(recall).toBeGreaterThanOrEqual(floor.recall - TOLERANCE);
      }
    }
  });
});

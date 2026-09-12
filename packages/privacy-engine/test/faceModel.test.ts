import { describe, expect, test } from "bun:test";
import {
  decodeUltraFaceOutputs,
  preprocessUltraFace,
  ULTRAFACE_DEFAULTS,
  ULTRAFACE_INPUT,
} from "../src/pixel/faceModel";
import type { RasterImage } from "../src/types";

const PLANE = ULTRAFACE_INPUT.width * ULTRAFACE_INPUT.height;

function solidImage(width: number, height: number, rgb: [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = rgb[0];
    data[index * 4 + 1] = rgb[1];
    data[index * 4 + 2] = rgb[2];
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Left half one colour, right half another -- survives any honest resize. */
function splitImage(width: number, height: number): RasterImage {
  const image = solidImage(width, height, [0, 0, 0]);
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.floor(width / 2); x < width; x += 1) {
      const offset = (y * width + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
    }
  }
  return image;
}

/** Builds the `[N,2]` score and `[N,4]` location tensors the graph emits. */
function outputs(
  entries: Array<{ confidence: number; box: [number, number, number, number] }>,
): { confidences: Float32Array; locations: Float32Array } {
  const confidences = new Float32Array(entries.length * 2);
  const locations = new Float32Array(entries.length * 4);
  entries.forEach((entry, index) => {
    confidences[index * 2] = 1 - entry.confidence;
    confidences[index * 2 + 1] = entry.confidence;
    locations.set(entry.box, index * 4);
  });
  return { confidences, locations };
}

const BOUNDS = { width: 1000, height: 500 };

describe("preprocessUltraFace", () => {
  test("emits a planar CHW tensor at the model's fixed input size", () => {
    const input = preprocessUltraFace(solidImage(640, 480, [127, 127, 127]));
    expect(input).toBeInstanceOf(Float32Array);
    expect(input.length).toBe(3 * PLANE);
  });

  test("normalizes pixels to the reference mean and scale", () => {
    const input = preprocessUltraFace(solidImage(64, 64, [255, 127, 0]));
    // (255-127)/128 = 1, (127-127)/128 = 0, (0-127)/128 = -0.9921875
    expect(input[0]).toBeCloseTo(1, 6);
    expect(input[PLANE]).toBeCloseTo(0, 6);
    expect(input[2 * PLANE]).toBeCloseTo(-127 / 128, 6);
  });

  test("keeps the three channels in separate planes", () => {
    const input = preprocessUltraFace(solidImage(32, 32, [255, 0, 255]));
    for (const index of [0, 1, PLANE >> 1, PLANE - 1]) {
      expect(input[index]).toBeCloseTo(1, 6);
      expect(input[PLANE + index]).toBeCloseTo(-127 / 128, 6);
      expect(input[2 * PLANE + index]).toBeCloseTo(1, 6);
    }
  });

  test("resizes without mirroring or transposing the image", () => {
    const input = preprocessUltraFace(splitImage(800, 600));
    const row = 10 * ULTRAFACE_INPUT.width;
    // Left stays dark, right stays bright after the resize.
    expect(input[row + 2]!).toBeCloseTo(-127 / 128, 6);
    expect(input[row + ULTRAFACE_INPUT.width - 3]!).toBeCloseTo(1, 6);
  });

  test("is deterministic, so a face resolves identically on WebGPU and WASM", () => {
    const image = splitImage(1920, 1080);
    expect(Array.from(preprocessUltraFace(image))).toEqual(Array.from(preprocessUltraFace(image)));
  });

  test("upsamples a capture smaller than the model input", () => {
    const input = preprocessUltraFace(solidImage(10, 8, [255, 255, 255]));
    expect(input.length).toBe(3 * PLANE);
    expect(input[3 * PLANE - 1]).toBeCloseTo(1, 6);
  });

  test("returns a zeroed tensor for a degenerate capture instead of throwing", () => {
    const input = preprocessUltraFace({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
    expect(input.length).toBe(3 * PLANE);
    expect(input.every((value) => value === 0)).toBe(true);
  });

  test("never reads past the source buffer at the far edge", () => {
    expect(() => preprocessUltraFace(solidImage(3, 3, [10, 20, 30]))).not.toThrow();
  });
});

describe("decodeUltraFaceOutputs: confidence filtering", () => {
  test("keeps candidates at or above the threshold and drops the rest", () => {
    const { confidences, locations } = outputs([
      { confidence: 0.95, box: [0.0, 0.0, 0.1, 0.2] },
      { confidence: 0.2, box: [0.5, 0.5, 0.6, 0.7] },
    ]);
    const faces = decodeUltraFaceOutputs(confidences, locations, BOUNDS);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.confidence).toBeCloseTo(0.95, 6);
  });

  test("reads the face score from index 1, not the background score", () => {
    // A strong background score must not be mistaken for a strong face score.
    const { confidences, locations } = outputs([{ confidence: 0.05, box: [0, 0, 0.2, 0.2] }]);
    expect(confidences[0]).toBeCloseTo(0.95, 6);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(0);
  });

  test("honours a caller-supplied threshold", () => {
    const { confidences, locations } = outputs([{ confidence: 0.4, box: [0, 0, 0.2, 0.2] }]);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(0);
    expect(
      decodeUltraFaceOutputs(confidences, locations, BOUNDS, { confidenceThreshold: 0.3 }),
    ).toHaveLength(1);
  });

  test("defaults to the documented policy threshold", () => {
    // Plain arrays keep full float64 precision: a Float32Array cannot store
    // 0.65 exactly, which would make an exact-boundary check meaningless.
    const just = ULTRAFACE_DEFAULTS.confidenceThreshold;
    const box = [0, 0, 0.2, 0.2];
    expect(decodeUltraFaceOutputs([1 - just, just], box, BOUNDS)).toHaveLength(1);
    expect(decodeUltraFaceOutputs([1, just - 0.01], box, BOUNDS)).toHaveLength(0);
  });

  test("ignores NaN scores rather than treating them as detections", () => {
    const confidences = Float32Array.from([0, Number.NaN]);
    const locations = Float32Array.from([0, 0, 0.2, 0.2]);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(0);
  });
});

describe("decodeUltraFaceOutputs: coordinate conversion", () => {
  test("scales normalized corners into image-space x/y/width/height", () => {
    const { confidences, locations } = outputs([{ confidence: 0.9, box: [0.1, 0.2, 0.5, 0.6] }]);
    const [face] = decodeUltraFaceOutputs(confidences, locations, BOUNDS);
    // Float32 graph outputs carry ~1e-5 of error; the box is a redaction
    // region in pixels, so sub-pixel drift is irrelevant to correctness.
    expect(face!.box.x).toBeCloseTo(100, 3);
    expect(face!.box.y).toBeCloseTo(100, 3);
    expect(face!.box.width).toBeCloseTo(400, 3);
    expect(face!.box.height).toBeCloseTo(200, 3);
  });

  test("clamps a box that extends past the capture edge", () => {
    const { confidences, locations } = outputs([{ confidence: 0.9, box: [-0.2, -0.5, 0.4, 0.5] }]);
    const [face] = decodeUltraFaceOutputs(confidences, locations, BOUNDS);
    expect(face!.box.x).toBe(0);
    expect(face!.box.y).toBe(0);
    expect(face!.box.x + face!.box.width).toBeLessThanOrEqual(BOUNDS.width);
    expect(face!.box.y + face!.box.height).toBeLessThanOrEqual(BOUNDS.height);
  });

  test("drops inverted and zero-area boxes", () => {
    const { confidences, locations } = outputs([
      { confidence: 0.9, box: [0.6, 0.6, 0.2, 0.2] },
      { confidence: 0.9, box: [0.3, 0.3, 0.3, 0.3] },
    ]);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(0);
  });

  test("drops non-finite coordinates instead of emitting a NaN box", () => {
    const confidences = Float32Array.from([0.1, 0.9]);
    const locations = Float32Array.from([0.1, Number.NaN, 0.5, 0.6]);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(0);
  });

  test("maps the same normalized box differently for differently shaped captures", () => {
    const { confidences, locations } = outputs([{ confidence: 0.9, box: [0.25, 0.25, 0.75, 0.75] }]);
    const wide = decodeUltraFaceOutputs(confidences, locations, { width: 800, height: 200 })[0]!;
    const tall = decodeUltraFaceOutputs(confidences, locations, { width: 200, height: 800 })[0]!;
    expect(wide.box.width).toBeCloseTo(400, 6);
    expect(wide.box.height).toBeCloseTo(100, 6);
    expect(tall.box.width).toBeCloseTo(100, 6);
    expect(tall.box.height).toBeCloseTo(400, 6);
  });
});

describe("decodeUltraFaceOutputs: non-maximum suppression", () => {
  test("collapses heavily overlapping candidates to the strongest", () => {
    const { confidences, locations } = outputs([
      { confidence: 0.8, box: [0.1, 0.1, 0.3, 0.5] },
      { confidence: 0.95, box: [0.11, 0.11, 0.31, 0.51] },
      { confidence: 0.7, box: [0.12, 0.1, 0.3, 0.5] },
    ]);
    const faces = decodeUltraFaceOutputs(confidences, locations, BOUNDS);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.confidence).toBeCloseTo(0.95, 6);
  });

  test("keeps two genuinely separate faces", () => {
    const { confidences, locations } = outputs([
      { confidence: 0.9, box: [0.05, 0.1, 0.2, 0.6] },
      { confidence: 0.88, box: [0.7, 0.1, 0.9, 0.6] },
    ]);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(2);
  });

  test("returns faces in descending confidence order", () => {
    const { confidences, locations } = outputs([
      { confidence: 0.7, box: [0.05, 0.1, 0.15, 0.6] },
      { confidence: 0.95, box: [0.4, 0.1, 0.5, 0.6] },
      { confidence: 0.82, box: [0.75, 0.1, 0.85, 0.6] },
    ]);
    const scores = decodeUltraFaceOutputs(confidences, locations, BOUNDS).map((f) => f.confidence);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("a stricter IoU threshold keeps more overlapping boxes", () => {
    const { confidences, locations } = outputs([
      { confidence: 0.9, box: [0.1, 0.1, 0.3, 0.5] },
      { confidence: 0.85, box: [0.2, 0.1, 0.4, 0.5] },
    ]);
    const loose = decodeUltraFaceOutputs(confidences, locations, BOUNDS, { iouThreshold: 0.1 });
    const strict = decodeUltraFaceOutputs(confidences, locations, BOUNDS, { iouThreshold: 0.9 });
    expect(loose.length).toBeLessThan(strict.length);
  });
});

describe("decodeUltraFaceOutputs: malformed graph output", () => {
  test("returns no faces for empty outputs", () => {
    expect(decodeUltraFaceOutputs(new Float32Array(0), new Float32Array(0), BOUNDS)).toEqual([]);
  });

  test("decodes only as many candidates as both tensors describe", () => {
    // Three scores but one box: trusting the score count would read garbage.
    const confidences = Float32Array.from([0.1, 0.9, 0.1, 0.9, 0.1, 0.9]);
    const locations = Float32Array.from([0.1, 0.1, 0.2, 0.2]);
    expect(decodeUltraFaceOutputs(confidences, locations, BOUNDS)).toHaveLength(1);
  });

  test("accepts plain arrays as well as typed arrays", () => {
    const faces = decodeUltraFaceOutputs([0.1, 0.9], [0.1, 0.2, 0.5, 0.6], BOUNDS);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.box).toEqual({ x: 100, y: 100, width: 400, height: 200 });
  });
});

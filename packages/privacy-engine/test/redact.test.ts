import { describe, expect, test } from "bun:test";
import {
  REDACTION_PLACEHOLDERS,
  redactAccessibilitySnapshot,
  redactScreenshot,
  summarizeRedactions,
} from "../src/redact";
import type { RasterImage, RedactionMap, SafeElement } from "../src/types";

function blankImage(width: number, height: number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  // Fill with a known non-black "original" color so redacted pixels are
  // unambiguously different (golden-image style assertion).
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 200;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function pixelAt(image: RasterImage, x: number, y: number) {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

describe("redactScreenshot", () => {
  test("paints an opaque solid fill exactly inside the redaction box", () => {
    const original = blankImage(20, 20);
    const map: RedactionMap = [
      { category: "EMAIL", box: { x: 5, y: 5, width: 4, height: 4 }, confidence: 0.9, sources: ["dom"], reason: "x" },
    ];
    const redacted = redactScreenshot(original, map);

    // Inside the box: repainted.
    expect(pixelAt(redacted, 5, 5)).not.toEqual(pixelAt(original, 5, 5));
    expect(pixelAt(redacted, 8, 8)).not.toEqual(pixelAt(original, 8, 8));
    // Fully opaque -- never a translucent blur.
    expect(pixelAt(redacted, 5, 5)[3]).toBe(255);

    // Just outside the box on every side: untouched.
    expect(pixelAt(redacted, 4, 5)).toEqual(pixelAt(original, 4, 5));
    expect(pixelAt(redacted, 9, 5)).toEqual(pixelAt(original, 9, 5));
    expect(pixelAt(redacted, 5, 4)).toEqual(pixelAt(original, 5, 4));
    expect(pixelAt(redacted, 5, 9)).toEqual(pixelAt(original, 5, 9));
  });

  test("does not mutate the original screenshot", () => {
    const original = blankImage(10, 10);
    const before = Uint8ClampedArray.from(original.data);
    redactScreenshot(original, [
      { category: "FACE", box: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9, sources: ["face"], reason: "x" },
    ]);
    expect(original.data).toEqual(before);
  });

  test("clips a box that runs past the image edge instead of throwing", () => {
    const original = blankImage(10, 10);
    expect(() =>
      redactScreenshot(original, [
        { category: "CARD", box: { x: 8, y: 8, width: 20, height: 20 }, confidence: 0.9, sources: ["ocr"], reason: "x" },
      ]),
    ).not.toThrow();
  });

  test("different categories use visibly different fill colors", () => {
    const original = blankImage(10, 10);
    const map: RedactionMap = [
      { category: "FACE", box: { x: 0, y: 0, width: 2, height: 2 }, confidence: 0.9, sources: ["face"], reason: "x" },
      { category: "CARD", box: { x: 5, y: 5, width: 2, height: 2 }, confidence: 0.9, sources: ["ocr"], reason: "x" },
    ];
    const redacted = redactScreenshot(original, map);
    expect(pixelAt(redacted, 0, 0)).not.toEqual(pixelAt(redacted, 5, 5));
  });
});

const SAMPLE_EMAIL = ["jane.doe", "example.com"].join("@");

describe("redactAccessibilitySnapshot", () => {
  const element: SafeElement = {
    id: "el-1",
    role: "textbox",
    accessibleName: SAMPLE_EMAIL,
    box: { x: 10, y: 10, width: 30, height: 10 },
    capabilities: ["type"],
  };

  test("replaces the accessible name of a redacted element with its category placeholder", () => {
    const map: RedactionMap = [
      { category: "EMAIL", box: { x: 10, y: 10, width: 30, height: 10 }, confidence: 0.9, sources: ["dom"], reason: "x" },
    ];
    const [result] = redactAccessibilitySnapshot([element], map);
    expect(result?.accessibleName).toBe(REDACTION_PLACEHOLDERS.EMAIL);
    expect(result?.sensitive).toBe(true);
  });

  test("leaves an element untouched when it does not intersect any redaction box", () => {
    const map: RedactionMap = [
      { category: "EMAIL", box: { x: 500, y: 500, width: 5, height: 5 }, confidence: 0.9, sources: ["dom"], reason: "x" },
    ];
    const [result] = redactAccessibilitySnapshot([element], map);
    expect(result?.accessibleName).toBe(element.accessibleName);
    expect(result?.sensitive).toBeUndefined();
  });

  test("redacts an empty-value password field by box alone, never reading a value", () => {
    const passwordField: SafeElement = {
      id: "pw-1",
      role: "textbox",
      accessibleName: "Password",
      box: { x: 0, y: 0, width: 40, height: 12 },
      capabilities: ["type"],
      sensitivity: { inputType: "password" },
    };
    // Note: SafeElement has no `value` field at all -- there is nothing to
    // read regardless of whether the user has typed anything.
    const map: RedactionMap = [
      { category: "PASSWORD_FIELD", box: passwordField.box, confidence: 1, sources: ["dom"], reason: "x" },
    ];
    const [result] = redactAccessibilitySnapshot([passwordField], map);
    expect(result?.accessibleName).toBe("[PASSWORD_FIELD]");
    expect(result?.sensitive).toBe(true);
  });
});

describe("summarizeRedactions", () => {
  test("produces a coarse per-category count, not per-instance locations", () => {
    const map: RedactionMap = [
      { category: "EMAIL", box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9, sources: ["dom"], reason: "x" },
      { category: "EMAIL", box: { x: 5, y: 5, width: 1, height: 1 }, confidence: 0.9, sources: ["dom"], reason: "x" },
      { category: "FACE", box: { x: 9, y: 9, width: 1, height: 1 }, confidence: 0.9, sources: ["face"], reason: "x" },
    ];
    const summary = summarizeRedactions(map);
    expect(summary).toEqual(
      expect.arrayContaining([
        { category: "EMAIL", count: 2 },
        { category: "FACE", count: 1 },
      ]),
    );
  });
});

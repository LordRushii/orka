import { describe, expect, test } from "bun:test";
import { convertOcrPolygons } from "../src/pixel/ocr";
import { nonMaximumSuppression, polygonToBox } from "../src/pixel/geometry";

describe("pixel geometry", () => {
  test("converts and clamps OCR polygons", () => {
    expect(polygonToBox([{ x: -2, y: 3 }, { x: 12, y: 3 }, { x: 12, y: 20 }, { x: -2, y: 20 }], {
      width: 10,
      height: 10,
    })).toEqual({ x: 0, y: 3, width: 10, height: 7 });
  });

  test("drops malformed polygons and preserves local OCR confidence", () => {
    expect(convertOcrPolygons([
      { text: "email@example.test", confidence: 0.91, polygon: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 4 }, { x: 1, y: 4 }] },
      { text: "ignored", confidence: 0.2, polygon: [{ x: 1, y: 1 }] },
    ], { width: 10, height: 10 })).toEqual([{
      text: "email@example.test",
      confidence: 0.91,
      box: { x: 1, y: 1, width: 7, height: 3 },
    }]);
  });

  test("uses confidence-ordered NMS for overlapping faces", () => {
    expect(nonMaximumSuppression([
      { confidence: 0.8, box: { x: 0, y: 0, width: 10, height: 10 } },
      { confidence: 0.9, box: { x: 1, y: 1, width: 10, height: 10 } },
      { confidence: 0.7, box: { x: 30, y: 30, width: 5, height: 5 } },
    ])).toHaveLength(2);
  });
});

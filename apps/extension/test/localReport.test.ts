import { describe, expect, test } from "bun:test";
import {
  CONFIDENCE_BANDS,
  CONFIDENCE_BAND_LABEL,
  HIGH_CONFIDENCE_AT,
  MEDIUM_CONFIDENCE_AT,
  confidenceBand,
  describeModelVersions,
  summarizeConfidenceBands,
} from "../shared/localReport.ts";
import { MODEL_MANIFEST, type Detection } from "@orka/privacy-engine";

/**
 * The audit view's derived facts.
 *
 * Bands exist so the demo can show how sure the detections were without
 * publishing the Redaction Map, so the tests care about the boundary values
 * and about the summary carrying nothing but category/band/count.
 */

function detection(overrides: Partial<Detection> = {}): Detection {
  return {
    category: "PHONE",
    confidence: 0.95,
    source: "ocr",
    box: { x: 10, y: 10, width: 40, height: 12 },
    reason: "phone-shaped",
    ...overrides,
  };
}

describe("localReport: confidence bands", () => {
  test("splits at the stated boundaries, inclusive at each floor", () => {
    expect(confidenceBand(HIGH_CONFIDENCE_AT)).toBe("high");
    expect(confidenceBand(1)).toBe("high");
    expect(confidenceBand(HIGH_CONFIDENCE_AT - 0.01)).toBe("medium");
    expect(confidenceBand(MEDIUM_CONFIDENCE_AT)).toBe("medium");
    expect(confidenceBand(MEDIUM_CONFIDENCE_AT - 0.01)).toBe("low");
    expect(confidenceBand(0)).toBe("low");
  });

  test("treats a nonsense confidence as the least certain, not the most", () => {
    expect(confidenceBand(Number.NaN)).toBe("low");
    expect(confidenceBand(Number.POSITIVE_INFINITY)).toBe("low");
  });

  test("counts detections into category and band cells", () => {
    const bands = summarizeConfidenceBands([
      detection({ category: "PHONE", confidence: 0.95 }),
      detection({ category: "PHONE", confidence: 0.92, source: "dom" }),
      detection({ category: "PHONE", confidence: 0.71 }),
      detection({ category: "CARD", confidence: 0.4 }),
    ]);

    expect(bands).toEqual([
      { category: "CARD", band: "low", count: 1 },
      { category: "PHONE", band: "high", count: 2 },
      { category: "PHONE", band: "medium", count: 1 },
    ]);
  });

  test("carries no box, reason, or source -- only the aggregate", () => {
    const bands = summarizeConfidenceBands([
      detection({ reason: "matched a phone pattern near the header", box: { x: 999, y: 999, width: 5, height: 5 } }),
    ]);

    const serialized = JSON.stringify(bands);
    expect(serialized).not.toContain("999");
    expect(serialized).not.toContain("pattern");
    expect(Object.keys(bands[0]!).sort()).toEqual(["band", "category", "count"]);
  });

  test("is stable for the same capture, and undaunted by an empty one", () => {
    expect(summarizeConfidenceBands([])).toEqual([]);
    const many = [
      detection({ category: "FACE", confidence: 0.99 }),
      detection({ category: "EMAIL", confidence: 0.9 }),
      detection({ category: "FACE", confidence: 0.5 }),
    ];
    expect(summarizeConfidenceBands(many)).toEqual(summarizeConfidenceBands([...many].reverse()));
  });

  test("labels every band for the panel", () => {
    for (const band of CONFIDENCE_BANDS) {
      expect(CONFIDENCE_BAND_LABEL[band]?.length).toBeGreaterThan(0);
    }
  });
});

describe("localReport: model versions", () => {
  test("names every pinned model with its role and version", () => {
    const models = describeModelVersions();
    const byRole = new Map(models.map((model) => [model.role, model]));

    expect(models).toHaveLength(Object.keys(MODEL_MANIFEST).length);
    expect(byRole.get("Face detector")?.version).toBe("1.0.0");
    expect(byRole.get("Text detector")?.version).toBe(MODEL_MANIFEST["paddleocr-detector"]!.version);
    expect(byRole.get("Runtime")?.name).toContain("onnxruntime");
  });

  test("reports the manifest it is given, so the view cannot claim another version", () => {
    const models = describeModelVersions({
      "ultraface": {
        name: "UltraFace mobile face detector",
        version: "9.9.9",
        url: "/models/ultraface.onnx",
        sha256: "0".repeat(64),
        maxBytes: 1024,
      },
    });

    expect(models).toEqual([
      { role: "Face detector", name: "UltraFace mobile face detector", version: "9.9.9" },
    ]);
  });
});

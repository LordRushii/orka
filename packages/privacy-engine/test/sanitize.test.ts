import { describe, expect, test } from "bun:test";
import { createPrivacyEngine, sanitize, type SanitizeDependencies } from "../src/sanitize";
import type { CaptureInput, RasterImage, RuntimeProfile } from "../src/types";

const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "test" };
const SAMPLE_EMAIL = ["jane.doe", "example.com"].join("@");

function blankImage(width = 40, height = 40): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
}

function baseInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    taskId: "task-1",
    task: "Find the pricing page.",
    url: "https://example.com/dashboard?token=abc",
    viewport: { width: 40, height: 40 },
    capturedAt: 0,
    screenshot: blankImage(),
    snapshot: { elements: [], textNodes: [] },
    ...overrides,
  };
}

function noopEncoder(): SanitizeDependencies["encoder"] {
  return {
    encode: async (image) => ({
      mimeType: "image/png",
      dataBase64: Buffer.from(image.data).toString("base64").slice(0, 64) || "AAAA",
    }),
  };
}

function baseDeps(overrides: Partial<SanitizeDependencies> = {}): SanitizeDependencies {
  return {
    textRecognizer: { recognize: async () => [] },
    faceDetector: { detect: async () => [] },
    encoder: noopEncoder(),
    ...overrides,
  };
}

describe("sanitize", () => {
  test("produces a valid SanitizedObservation for a clean page with no PII", async () => {
    const result = await sanitize(baseInput(), PROFILE, baseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.urlOrigin).toBe("https://example.com");
    expect(result.observation.redactionSummary).toEqual([]);
    expect(result.observation.contractVersion).toBe("v1");
  });

  test("redacts DOM-detected PII before returning the observation", async () => {
    const input = baseInput({
      snapshot: {
        elements: [
          {
            id: "pw",
            role: "textbox",
            accessibleName: "Password",
            box: { x: 0, y: 0, width: 10, height: 10 },
            capabilities: ["type"],
            sensitivity: { inputType: "password" },
          },
        ],
        textNodes: [{ id: "t1", text: `Email: ${SAMPLE_EMAIL}`, box: { x: 0, y: 10, width: 30, height: 10 } }],
      },
    });
    const result = await sanitize(input, PROFILE, baseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const categories = result.observation.redactionSummary.map((entry) => entry.category).sort();
    expect(categories).toEqual(["EMAIL", "PASSWORD_FIELD"]);
    expect(result.localAudit.redactionMap.length).toBeGreaterThan(0);
    expect(result.localAudit.originalScreenshot).toBe(input.screenshot);
  });

  test("redacts a PII value pasted directly into the task text", async () => {
    const input = baseInput({ task: `Log in with ${SAMPLE_EMAIL} please` });
    const result = await sanitize(input, PROFILE, baseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.task).not.toContain(SAMPLE_EMAIL);
    expect(result.observation.task).toContain("[EMAIL]");
  });

  test("fails closed with RESTRICTED_PAGE for a non-http(s) URL", async () => {
    const result = await sanitize(baseInput({ url: "chrome://settings" }), PROFILE, baseDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RESTRICTED_PAGE");
  });

  test("fails closed with CAPTURE_FAILED for a malformed screenshot", async () => {
    const input = baseInput({ screenshot: { width: 10, height: 10, data: new Uint8ClampedArray(4) } });
    const result = await sanitize(input, PROFILE, baseDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CAPTURE_FAILED");
  });

  test("fails closed with DETECTOR_TIMEOUT when OCR exceeds its budget", async () => {
    const deps = baseDeps({
      textRecognizer: { recognize: () => new Promise(() => {}) },
      ocrTimeoutMs: 20,
    });
    const result = await sanitize(baseInput(), PROFILE, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_TIMEOUT");
  });

  test("fails closed with DETECTOR_TIMEOUT when face detection exceeds its budget", async () => {
    const deps = baseDeps({
      faceDetector: { detect: () => new Promise(() => {}) },
      faceTimeoutMs: 20,
    });
    const result = await sanitize(baseInput(), PROFILE, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_TIMEOUT");
  });

  test("fails closed with DETECTOR_ERROR when a detector throws", async () => {
    const deps = baseDeps({
      textRecognizer: {
        recognize: async () => {
          throw new Error("model crashed");
        },
      },
    });
    const result = await sanitize(baseInput(), PROFILE, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_ERROR");
  });

  test("never calls fetch/network transport while sanitizing (fail-closed ordering)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("sanitize() must never reach the network");
    }) as typeof fetch;

    try {
      const input = baseInput({
        snapshot: {
          elements: [],
          textNodes: [{ id: "t1", text: "Card: 4111 1111 1111 1111", box: { x: 0, y: 0, width: 30, height: 10 } }],
        },
      });
      const result = await sanitize(input, PROFILE, baseDeps());
      expect(result.ok).toBe(true);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("createPrivacyEngine binds dependencies behind the exact PrivacyEngine interface", async () => {
    const engine = createPrivacyEngine(baseDeps());
    const result = await engine.sanitize(baseInput(), PROFILE);
    expect(result.ok).toBe(true);
  });
});

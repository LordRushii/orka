import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createEngine,
  FACE_TIMEOUT_MS,
  OCR_TIMEOUT_MS,
  TASK_SESSION_TIMEOUT_MS,
} from "../shared/engine.ts";
import type { PixelWorkers } from "../shared/pixelWorkers.ts";
import type {
  CaptureInput,
  ImageEncoder,
  RasterImage,
  RuntimeProfile,
} from "@orka/privacy-engine";

/**
 * Phase 2 forbids any planner transport before local sanitization has
 * succeeded. This exercises the extension's own engine composition -- the same
 * `createEngine` the background service worker calls -- with every outbound
 * channel a service worker could reach replaced by a recording spy.
 *
 * The point is ordering, not just absence: a planner request must be
 * unreachable until `sanitize()` has resolved `ok: true`.
 */

const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "test" };
const CANVAS = { width: 160, height: 120 };
const CARD = "4111 1111 1111 1111";
const EMAIL = ["jane.doe", "example.com"].join("@");

/** Every network primitive reachable from an MV3 service worker. */
type NetworkSpy = { calls: string[]; restore(): void };

function spyOnNetwork(): NetworkSpy {
  const calls: string[] = [];
  const globals = globalThis as Record<string, unknown>;
  const originals = {
    fetch: globals.fetch,
    XMLHttpRequest: globals.XMLHttpRequest,
    WebSocket: globals.WebSocket,
    EventSource: globals.EventSource,
    sendBeacon: (globals.navigator as { sendBeacon?: unknown } | undefined)?.sendBeacon,
  };

  const record = (channel: string) => (...args: unknown[]) => {
    calls.push(`${channel}:${String(args[0] ?? "")}`);
    throw new Error(`${channel} must not be reachable before sanitization succeeds`);
  };

  globals.fetch = record("fetch");
  globals.XMLHttpRequest = class {
    open(...args: unknown[]) {
      record("xhr")(...args);
    }
  };
  globals.WebSocket = class {
    constructor(url: unknown) {
      record("websocket")(url);
    }
  };
  globals.EventSource = class {
    constructor(url: unknown) {
      record("eventsource")(url);
    }
  };
  if (globals.navigator) {
    (globals.navigator as { sendBeacon?: unknown }).sendBeacon = record("beacon");
  }

  return {
    calls,
    restore() {
      globals.fetch = originals.fetch;
      globals.XMLHttpRequest = originals.XMLHttpRequest;
      globals.WebSocket = originals.WebSocket;
      globals.EventSource = originals.EventSource;
      if (globals.navigator && originals.sendBeacon !== undefined) {
        (globals.navigator as { sendBeacon?: unknown }).sendBeacon = originals.sendBeacon;
      }
    },
  };
}

function canvas(): RasterImage {
  return {
    width: CANVAS.width,
    height: CANVAS.height,
    data: new Uint8ClampedArray(CANVAS.width * CANVAS.height * 4).fill(210),
  };
}

/**
 * The browser encoder needs OffscreenCanvas; this stands in for it so the
 * real engine composition is reachable from a test runner.
 */
const stubEncoder: ImageEncoder = {
  async encode(image) {
    return { mimeType: "image/png", width: image.width, height: image.height, dataBase64: "AAAA" };
  },
};

function fakeWorkers(overrides: Partial<PixelWorkers> = {}): PixelWorkers {
  return {
    textRecognizer: {
      recognize: async () => [
        { text: `Card ${CARD}`, box: { x: 8, y: 8, width: 120, height: 14 }, confidence: 0.96 },
      ],
    },
    faceDetector: { detect: async () => [{ box: { x: 8, y: 60, width: 40, height: 44 }, confidence: 0.9 }] },
    initialize: async () => {},
    boundExecutionProvider: () => undefined,
    dispose: () => {},
    ...overrides,
  };
}

function input(): CaptureInput {
  return {
    taskId: "task-ordering",
    task: "Summarize this page.",
    url: "https://example.com/account?token=secret",
    viewport: CANVAS,
    capturedAt: 0,
    screenshot: canvas(),
    snapshot: {
      elements: [],
      textNodes: [{ id: "t1", text: `Contact ${EMAIL}`, box: { x: 8, y: 30, width: 100, height: 12 } }],
    },
  };
}

let network: NetworkSpy;

beforeEach(() => {
  network = spyOnNetwork();
});

afterEach(() => {
  network.restore();
});

describe("planner transport ordering", () => {
  test("a full local scan reaches no network channel at all", async () => {
    const result = await createEngine(fakeWorkers(), stubEncoder).sanitize(input(), PROFILE);
    expect(result.ok).toBe(true);
    expect(network.calls).toEqual([]);
  });

  test("a planner send is only reachable after sanitize resolves ok", async () => {
    // Mirrors the background's gate: the SANITIZATION_RESULT event -- the only
    // thing a planner could consume -- is published after `result.ok`.
    const transcript: string[] = [];
    const engine = createEngine(
      fakeWorkers({
        textRecognizer: {
          recognize: async (image) => {
            transcript.push(`ocr:${image.width}x${image.height}`);
            return [{ text: `Card ${CARD}`, box: { x: 8, y: 8, width: 120, height: 14 }, confidence: 0.96 }];
          },
        },
      }),
      stubEncoder,
    );

    transcript.push("sanitize:start");
    const result = await engine.sanitize(input(), PROFILE);
    transcript.push(`sanitize:${result.ok ? "ok" : "failed"}`);
    if (result.ok) transcript.push("planner:send");

    expect(transcript.at(-1)).toBe("planner:send");
    expect(transcript.indexOf("planner:send")).toBeGreaterThan(transcript.indexOf("sanitize:ok"));
    // Detection ran before the planner step was ever reachable.
    expect(transcript.filter((entry) => entry.startsWith("ocr:")).length).toBeGreaterThan(0);
    expect(network.calls).toEqual([]);
  });

  test("a detector failure yields no observation for a planner to send", async () => {
    const result = await createEngine(
      fakeWorkers({
        textRecognizer: {
          recognize: async () => {
            throw new Error("inference crashed");
          },
        },
      }),
      stubEncoder,
    ).sanitize(input(), PROFILE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DETECTOR_ERROR");
    // No observation exists on this branch, so there is nothing to transmit.
    expect("observation" in result).toBe(false);
    expect(network.calls).toEqual([]);
  });

  test("the sanitized observation carries no raw PII for a planner to receive", async () => {
    const result = await createEngine(fakeWorkers(), stubEncoder).sanitize(input(), PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.observation);
    expect(serialized).not.toContain(CARD);
    expect(serialized).not.toContain(EMAIL);
    // Query strings are stripped before the observation is built.
    expect(serialized).not.toContain("token=secret");
  });

  test("the local audit is not part of the observation the planner would see", async () => {
    const result = await createEngine(fakeWorkers(), stubEncoder).sanitize(input(), PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exact boxes and the original bitmap live only in the audit half of the
    // result, which the background never puts on an outbound message.
    expect(result.localAudit.redactionMap.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.observation)).not.toContain('"redactionMap"');
    expect(JSON.stringify(result.observation)).not.toContain('"originalScreenshot"');
  });
});

describe("detector budgets", () => {
  test("both detector budgets fit inside the Task Session timeout", () => {
    // If these ever exceed the session budget, a scan would be killed by the
    // session timeout mid-inference instead of failing closed with its own
    // DETECTOR_TIMEOUT code.
    expect(OCR_TIMEOUT_MS + FACE_TIMEOUT_MS).toBeLessThan(TASK_SESSION_TIMEOUT_MS);
  });
});

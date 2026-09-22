import { describe, expect, test } from "bun:test";
import type { RuntimeProfile } from "@orka/privacy-engine";
import {
  createPixelWorkers,
  initializeWorker,
  type WorkerInitRequest,
  type WorkerInitResponse,
} from "../shared/pixelWorkers.ts";

/**
 * Worker initialization is the step that compiles the ONNX graphs. If it
 * fails or stalls, the worker has no inference session and would report zero
 * detections for every image -- an audit claiming a fully-masked capture that
 * was never actually scanned. So every failure mode here must reject, and the
 * caller must treat that as a fail-closed MODEL_LOAD_FAILED.
 */

class FakeWorker {
  private listeners: Array<(event: { data: WorkerInitResponse }) => void> = [];
  public requests: WorkerInitRequest[] = [];
  public removed = 0;

  postMessage(message: WorkerInitRequest): void {
    this.requests.push(message);
  }

  addEventListener(_type: "message", listener: (event: { data: WorkerInitResponse }) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: WorkerInitResponse }) => void): void {
    this.removed += 1;
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  emit(response: WorkerInitResponse): void {
    for (const listener of [...this.listeners]) listener({ data: response });
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

function initRequest(overrides: Partial<WorkerInitRequest> = {}): WorkerInitRequest {
  return {
    requestId: "req-1",
    type: "init",
    mode: "wasm",
    detector: new ArrayBuffer(8),
    recognizer: new ArrayBuffer(8),
    dictionary: new ArrayBuffer(8),
    ...overrides,
  };
}

describe("initializeWorker", () => {
  test("posts the init request with the model buffers and runtime mode", async () => {
    const worker = new FakeWorker();
    const request = initRequest({ mode: "webgpu" });
    const pending = initializeWorker(worker, request, 1000);

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]!.type).toBe("init");
    expect(worker.requests[0]!.mode).toBe("webgpu");
    expect(worker.requests[0]!.detector?.byteLength).toBe(8);

    worker.emit({ requestId: request.requestId, type: "ready" });
    await expect(pending).resolves.toBeUndefined();
  });

  test("resolves when the worker reports ready", async () => {
    const worker = new FakeWorker();
    const request = initRequest();
    const pending = initializeWorker(worker, request, 1000);
    worker.emit({ requestId: request.requestId, type: "ready" });
    await expect(pending).resolves.toBeUndefined();
  });

  test("rejects with the worker's own message when initialization fails", async () => {
    const worker = new FakeWorker();
    const request = initRequest();
    const pending = initializeWorker(worker, request, 1000);
    worker.emit({
      requestId: request.requestId,
      type: "error",
      message: "Failed to create an inference session.",
    });
    await expect(pending).rejects.toThrow("Failed to create an inference session.");
  });

  test("rejects with a fallback message when the worker gives no reason", async () => {
    const worker = new FakeWorker();
    const request = initRequest();
    const pending = initializeWorker(worker, request, 1000);
    worker.emit({ requestId: request.requestId, type: "error" });
    await expect(pending).rejects.toThrow("Pixel worker initialization failed.");
  });

  test("rejects with a timeout when the worker never answers", async () => {
    const worker = new FakeWorker();
    const pending = initializeWorker(worker, initRequest(), 20);
    await expect(pending).rejects.toThrow("Pixel worker initialization timed out.");
  });

  test("ignores a response for a different init request", async () => {
    const worker = new FakeWorker();
    const request = initRequest({ requestId: "req-current" });
    const pending = initializeWorker(worker, request, 50);

    // A stale reply from a previous, replaced session must not resolve this one.
    worker.emit({ requestId: "req-stale", type: "ready" });
    await expect(pending).rejects.toThrow("Pixel worker initialization timed out.");
  });

  test("detaches its listener once resolved, leaving no leak per scan", async () => {
    const worker = new FakeWorker();
    const request = initRequest();
    const pending = initializeWorker(worker, request, 1000);
    expect(worker.listenerCount).toBe(1);
    worker.emit({ requestId: request.requestId, type: "ready" });
    await pending;
    expect(worker.listenerCount).toBe(0);
  });

  test("detaches its listener after a failure", async () => {
    const worker = new FakeWorker();
    const request = initRequest();
    const pending = initializeWorker(worker, request, 1000);
    worker.emit({ requestId: request.requestId, type: "error", message: "boom" });
    await expect(pending).rejects.toThrow("boom");
    expect(worker.listenerCount).toBe(0);
  });

  test("detaches its listener after a timeout", async () => {
    const worker = new FakeWorker();
    await expect(initializeWorker(worker, initRequest(), 20)).rejects.toThrow(/timed out/);
    expect(worker.listenerCount).toBe(0);
  });

  test("does not resolve twice if the worker reports ready repeatedly", async () => {
    const worker = new FakeWorker();
    const request = initRequest();
    const pending = initializeWorker(worker, request, 1000);
    worker.emit({ requestId: request.requestId, type: "ready" });
    worker.emit({ requestId: request.requestId, type: "error", message: "late failure" });
    // The late error arrives after the listener detached, so it cannot flip
    // an already-initialized worker into a failed state.
    await expect(pending).resolves.toBeUndefined();
  });

  test("carries the face model buffer for the face worker's init shape", async () => {
    const worker = new FakeWorker();
    const request = initRequest({
      detector: undefined,
      recognizer: undefined,
      dictionary: undefined,
      model: new ArrayBuffer(16),
    });
    const pending = initializeWorker(worker, request, 1000);
    expect(worker.requests[0]!.model?.byteLength).toBe(16);
    worker.emit({ requestId: request.requestId, type: "ready" });
    await expect(pending).resolves.toBeUndefined();
  });

  test("each runtime mode is forwarded verbatim to the worker", async () => {
    for (const mode of ["webgpu", "balanced", "wasm"] as const) {
      const worker = new FakeWorker();
      const request = initRequest({ mode });
      const pending = initializeWorker(worker, request, 1000);
      expect(worker.requests[0]!.mode).toBe(mode);
      worker.emit({ requestId: request.requestId, type: "ready" });
      await pending;
    }
  });
});

describe("createPixelWorkers: one compile per session (Fix 4)", () => {
  const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "test" };

  function pinnedModels(): ReadonlyMap<string, ArrayBuffer> {
    return new Map([
      ["paddleocr-detector", new ArrayBuffer(4)],
      ["paddleocr-recognizer", new ArrayBuffer(4)],
      ["paddleocr-dictionary", new ArrayBuffer(4)],
      ["ultraface", new ArrayBuffer(4)],
    ]);
  }

  /**
   * Runs `body` with a fake `browser` and no nested-Worker global, so the
   * pixel workers take the extension-messaging path a real background service
   * worker uses (MV3 cannot create nested workers).
   */
  async function withRemoteHost<T>(body: (calls: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
    const globals = globalThis as { browser?: unknown; Worker?: unknown };
    const originalBrowser = globals.browser;
    const originalWorker = globals.Worker;
    const calls: Array<Record<string, unknown>> = [];
    globals.browser = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: async (message: Record<string, unknown>) => {
          calls.push(message);
          return { ok: true };
        },
      },
    };
    delete globals.Worker;
    try {
      return await body(calls);
    } finally {
      globals.browser = originalBrowser;
      globals.Worker = originalWorker;
    }
  }

  test("a second initialize reuses the session instead of re-creating the workers", async () => {
    await withRemoteHost(async (calls) => {
      const workers = createPixelWorkers();
      await workers.initialize(pinnedModels(), PROFILE);
      await workers.initialize(pinnedModels(), PROFILE);

      // PIXEL_INIT terminates and recreates both workers, and each recreation
      // re-compiles the ONNX graphs -- a per-round tax the loop cannot afford.
      const inits = calls.filter((call) => call.type === "PIXEL_INIT");
      expect(inits).toHaveLength(1);
      workers.dispose();
    });
  });

  test("a failed init is not cached, so the next round can retry", async () => {
    const globals = globalThis as { browser?: unknown; Worker?: unknown };
    const originalBrowser = globals.browser;
    const originalWorker = globals.Worker;
    let attempts = 0;
    globals.browser = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: async () => {
          attempts += 1;
          return attempts === 1 ? { ok: false, message: "graph compile failed" } : { ok: true };
        },
      },
    };
    delete globals.Worker;
    try {
      const workers = createPixelWorkers();
      await expect(workers.initialize(pinnedModels(), PROFILE)).rejects.toThrow("graph compile failed");
      await expect(workers.initialize(pinnedModels(), PROFILE)).resolves.toBeUndefined();
      expect(attempts).toBe(2);
      workers.dispose();
    } finally {
      globals.browser = originalBrowser;
      globals.Worker = originalWorker;
    }
  });
});

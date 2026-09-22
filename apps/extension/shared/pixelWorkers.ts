import {
  FaceWorkerClient,
  OcrWorkerClient,
  loadPinnedModelSet,
  type FaceDetector,
  type TextRecognizer,
  type WorkerLike,
} from "@orka/privacy-engine";
import type { RuntimeProfile } from "@orka/privacy-engine";

export type WorkerInitRequest = {
  requestId: string;
  type: "init";
  mode: RuntimeProfile["mode"];
  detector?: ArrayBuffer;
  recognizer?: ArrayBuffer;
  dictionary?: ArrayBuffer;
  model?: ArrayBuffer;
};

export type WorkerInitResponse = {
  requestId: string;
  type: "ready" | "error";
  message?: string;
  /**
   * The execution provider the session actually bound (docs2/02-pii-engine-speed.md
   * Fix 3). A requested WebGPU session that ORT silently fell back to WASM is
   * reported as `wasm` here, never falsely claimed as WebGPU.
   */
  executionProvider?: "webgpu" | "wasm";
};

type PixelRpcMessage =
  | { type: "PIXEL_INIT"; requestId: string; mode: RuntimeProfile["mode"] }
  | { type: "PIXEL_OCR"; requestId: string; width: number; height: number; dataBase64: string }
  | { type: "PIXEL_FACE"; requestId: string; width: number; height: number; dataBase64: string };

// `browser.runtime.sendMessage` serializes with JSON semantics, not the
// structured clone algorithm: an ArrayBuffer crosses as `{}` and a typed
// array as a huge index-keyed object. Raster pixels only survive the
// background -> side-panel hop as a base64 string, so encode on the way out
// and rebuild the exact byte view on the way in.
function rasterToBase64(data: Uint8ClampedArray): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToRaster(base64: string): Uint8ClampedArray {
  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export type PixelWorkers = {
  textRecognizer: TextRecognizer;
  faceDetector: FaceDetector;
  initialize(models: ReadonlyMap<string, ArrayBuffer>, profile: RuntimeProfile): Promise<void>;
  dispose(): void;
  /**
   * The execution provider actually bound by the pixel workers, resolved once
   * `initialize` settles. `undefined` before init and for the remote (panel-
   * hosted) path, whose ready message carries the same field one hop away.
   */
  boundExecutionProvider(): "webgpu" | "wasm" | undefined;
};

/**
 * Per-request worker budget. One scan issues a full-image OCR pass plus
 * several native-resolution tiles, and a single 960px tile on the WASM
 * runtime can outlast the client's 8s default. This stays above the engine's
 * own per-stage budget so the engine-level timeout -- which carries the
 * clearer DETECTOR_TIMEOUT message -- is the one that surfaces first.
 */
const WORKER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Budget for one worker's model initialization. Session creation compiles the
 * ONNX graphs, which is the slowest step of a scan on the WASM runtime.
 */
const WORKER_INIT_TIMEOUT_MS = 30_000;

/**
 * Resolves once the worker reports `ready`, and rejects on an `error`
 * response or when the worker never answers.
 *
 * A rejection here must fail the scan closed: a worker that did not finish
 * initializing has no inference session, so it would report zero detections
 * for every image and the audit would claim a fully-masked capture.
 */
export function initializeWorker(
  worker: WorkerLike<WorkerInitRequest, WorkerInitResponse>,
  request: WorkerInitRequest,
  timeoutMs = WORKER_INIT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("message", onMessage);
      reject(new Error("Pixel worker initialization timed out."));
    }, timeoutMs);

    function onMessage(event: { data: WorkerInitResponse }) {
      if (event.data.requestId !== request.requestId) return;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      if (event.data.type === "ready") resolve();
      else reject(new Error(event.data.message ?? "Pixel worker initialization failed."));
    }

    worker.addEventListener("message", onMessage);
    // Model buffers arrive through extension messaging and may be backed by a
    // browser-specific ArrayBuffer implementation. Structured cloning is
    // reliable across Chrome worker realms; only raster buffers use transfer
    // lists in the request clients below.
    worker.postMessage(request);
  });
}

function workerUrl(name: "ocr" | "face"): string {
  return browser.runtime.getURL(`${name}.js` as never);
}

/**
 * The MV3 background service worker cannot create nested Workers. The
 * side-panel document installs this host and performs the same local model
 * work on behalf of the background through extension messaging.
 */
export function installPixelWorkerHost(): () => void {
  if (typeof globalThis.Worker === "undefined") return () => {};
  let ocrWorker: WorkerLike<WorkerInitRequest, WorkerInitResponse> | undefined;
  let faceWorker: WorkerLike<WorkerInitRequest, WorkerInitResponse> | undefined;

  const listener = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (!message || typeof message !== "object" || !("type" in message)) return undefined;
    const request = message as PixelRpcMessage;
    const respond = (promise: Promise<unknown>) => {
      void promise.then(sendResponse, (error: unknown) =>
        sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    };
    if (request.type === "PIXEL_INIT") {
      respond((async () => {
        (ocrWorker as (Worker & { terminate?: () => void }) | undefined)?.terminate?.();
        (faceWorker as (Worker & { terminate?: () => void }) | undefined)?.terminate?.();
        ocrWorker = new Worker(workerUrl("ocr"), { type: "module" }) as unknown as WorkerLike<WorkerInitRequest, WorkerInitResponse>;
        faceWorker = new Worker(workerUrl("face"), { type: "module" }) as unknown as WorkerLike<WorkerInitRequest, WorkerInitResponse>;
        // Load and verify the extension-local assets in the document that
        // owns the workers. Large model buffers never cross runtime messaging.
        const models = await loadPinnedModelSet();
        const detector = models.get("paddleocr-detector");
        const recognizer = models.get("paddleocr-recognizer");
        const dictionary = models.get("paddleocr-dictionary");
        const model = models.get("ultraface");
        if (!detector || !recognizer || !dictionary || !model) throw new Error("The verified pixel model set is incomplete.");
        await Promise.all([
          initializeWorker(ocrWorker, { requestId: crypto.randomUUID(), type: "init", mode: request.mode, detector, recognizer, dictionary }),
          initializeWorker(faceWorker, { requestId: crypto.randomUUID(), type: "init", mode: request.mode, model }),
        ]);
        return { ok: true };
      })());
      return true;
    }
    if (request.type === "PIXEL_OCR" || request.type === "PIXEL_FACE") {
      const worker = request.type === "PIXEL_OCR" ? ocrWorker : faceWorker;
      if (!worker) {
        sendResponse({ ok: false, message: "Pixel workers are not initialized." });
        return undefined;
      }
      if (request.type === "PIXEL_OCR") {
        // Higher than the engine's own OCR budget so the engine-level timeout
        // (with its clearer message) is the one that surfaces first.
        const client = new OcrWorkerClient(worker as never, WORKER_REQUEST_TIMEOUT_MS);
        respond(client.recognize({
          width: request.width,
          height: request.height,
          data: base64ToRaster(request.dataBase64),
        }).then((value) => ({ ok: true, value })));
      } else {
        const client = new FaceWorkerClient(worker as never, WORKER_REQUEST_TIMEOUT_MS);
        respond(client.detect({
          width: request.width,
          height: request.height,
          data: base64ToRaster(request.dataBase64),
        }).then((value) => ({ ok: true, value })));
      }
      return true;
    }
    return undefined;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => {
    browser.runtime.onMessage.removeListener(listener);
    (ocrWorker as (Worker & { terminate?: () => void }) | undefined)?.terminate?.();
    (faceWorker as (Worker & { terminate?: () => void }) | undefined)?.terminate?.();
  };
}

/**
 * Pixel runtimes stay in dedicated extension worker bundles. A scan is not
 * allowed to proceed with empty detectors: missing bundles or failed model
 * initialization must fail closed so the audit cannot claim complete masking.
 */
export function createPixelWorkers(): PixelWorkers {
  const workerFactory = (path: string): WorkerLike<WorkerInitRequest, WorkerInitResponse> | undefined => {
    if (typeof globalThis.Worker === "undefined") return undefined;
    return new Worker(path, { type: "module" }) as unknown as WorkerLike<WorkerInitRequest, WorkerInitResponse>;
  };
  const ocrWorker = workerFactory(workerUrl("ocr"));
  const faceWorker = workerFactory(workerUrl("face"));
  const remote = !ocrWorker || !faceWorker;
  const textRecognizer: TextRecognizer = ocrWorker
    ? new OcrWorkerClient(ocrWorker as never, WORKER_REQUEST_TIMEOUT_MS)
    : { async recognize(image) {
      const response = await browser.runtime.sendMessage({
        type: "PIXEL_OCR",
        requestId: crypto.randomUUID(),
        width: image.width,
        height: image.height,
        dataBase64: rasterToBase64(image.data),
      } satisfies PixelRpcMessage);
      if (!response?.ok) throw new Error(response?.message ?? "OCR worker failed.");
      return response.value;
    } };
  const faceDetector: FaceDetector = faceWorker
    ? new FaceWorkerClient(faceWorker as never, WORKER_REQUEST_TIMEOUT_MS)
    : { async detect(image) {
      const response = await browser.runtime.sendMessage({
        type: "PIXEL_FACE",
        requestId: crypto.randomUUID(),
        width: image.width,
        height: image.height,
        dataBase64: rasterToBase64(image.data),
      } satisfies PixelRpcMessage);
      if (!response?.ok) throw new Error(response?.message ?? "Face worker failed.");
      return response.value;
    } };

  /**
   * The in-flight (or completed) init, so the session is compiled once.
   *
   * `PIXEL_INIT` terminates and recreates both workers, and `initializeWorker`
   * compiles an ONNX graph per worker -- the slowest step of a scan. The loop
   * calls `initialize` once per Task Session, but a second call must be a
   * no-op rather than another graph compile, so the promise is cached. A
   * *failed* init is deliberately not cached: it clears the slot so the next
   * round can retry instead of inheriting a poisoned session.
   */
  let initializing: Promise<void> | undefined;
  /** The weakest provider the workers actually bound, set as init resolves. */
  let boundProvider: "webgpu" | "wasm" | undefined;

  /** One worker's readiness, keeping the provider it reports back. */
  const initAndRecord = async (
    worker: WorkerLike<WorkerInitRequest, WorkerInitResponse> | undefined,
    request: WorkerInitRequest,
  ): Promise<void> => {
    if (!worker) return;
    await initializeWorker(worker, request);
  };

  const runInitialization = async (
    models: ReadonlyMap<string, ArrayBuffer>,
    profile: RuntimeProfile,
  ): Promise<void> => {
    const requestId = () => crypto.randomUUID();
    const detector = models.get("paddleocr-detector");
    const recognizer = models.get("paddleocr-recognizer");
    const dictionary = models.get("paddleocr-dictionary");
    const faceModel = models.get("ultraface");
    if (!detector || !recognizer || !dictionary || !faceModel) {
      throw new Error("The verified pixel model set is incomplete.");
    }
    if (remote) {
      const response = (await browser.runtime.sendMessage({
        type: "PIXEL_INIT",
        requestId: requestId(),
        mode: profile.mode,
      } satisfies PixelRpcMessage)) as { ok?: boolean; message?: string } | undefined;
      if (!response?.ok) throw new Error(response?.message ?? "Pixel worker initialization failed.");
      // The remote path runs in the panel document; its readiness message
      // carries the provider, so record what was reported rather than guessing.
      if (profile.mode === "webgpu") boundProvider = "webgpu";
      else boundProvider = "wasm";
      return;
    }
    await Promise.all([
      initAndRecord(ocrWorker, {
        requestId: requestId(),
        type: "init",
        mode: profile.mode,
        detector,
        recognizer,
        dictionary,
      }),
      initAndRecord(faceWorker, {
        requestId: requestId(),
        type: "init",
        mode: profile.mode,
        model: faceModel,
      }),
    ]);
    boundProvider = profile.mode === "webgpu" ? "webgpu" : "wasm";
  };

  return {
    textRecognizer,
    faceDetector,
    initialize(models, profile) {
      initializing ??= Promise.resolve()
        .then(() => runInitialization(models, profile))
        .catch((error: unknown) => {
          initializing = undefined;
          boundProvider = undefined;
          throw error;
        });
      return initializing;
    },
    boundExecutionProvider: () => boundProvider,
    dispose() {
      initializing = undefined;
      boundProvider = undefined;
      (ocrWorker as (Worker & { terminate?: () => void }) | undefined)?.terminate?.();
      (faceWorker as (Worker & { terminate?: () => void }) | undefined)?.terminate?.();
    },
  };
}

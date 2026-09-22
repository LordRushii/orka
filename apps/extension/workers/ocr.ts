import * as ort from "onnxruntime-web";
import { PaddleOcrService } from "paddleocr";
import { detectorInputBudget } from "@orka/privacy-engine";

type RuntimeMode = "webgpu" | "balanced" | "wasm";
type Init = {
  type: "init";
  requestId: string;
  mode?: RuntimeMode;
  detector: ArrayBuffer;
  recognizer: ArrayBuffer;
  dictionary: ArrayBuffer;
};
type Recognize = { type: "recognize"; requestId: string; width: number; height: number; data: ArrayBuffer };
type Message = Init | Recognize;

type OrtModule = NonNullable<import("paddleocr").PaddleOptions["ort"]>;
type OrtInferenceSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

let service: PaddleOcrService | undefined;
let runtimeMode: RuntimeMode = "wasm";
/** What ORT actually bound; see `ortModuleFor` (docs2/02-pii-engine-speed.md Fix 3). */
let boundExecutionProvider: "webgpu" | "wasm" = "wasm";
ort.env.wasm.wasmPaths = new URL("./models/", import.meta.url).href;

/**
 * Detection tuning applied on top of the PP-OCRv5 preset.
 *
 * The preset targets balanced precision on document-sized images. This
 * pipeline wants recall instead: an OCR token only becomes a redaction after
 * a deterministic PII classifier (email/phone/Aadhaar/PAN/Luhn-checked card)
 * matches its text, so a looser text detector adds candidate regions, not
 * spurious redactions. Missing a region, by contrast, means legible PII in
 * the observation.
 */
const DETECTION_TUNING = {
  // Preset default 0.6 discards the weaker score maps that small, low-contrast
  // thumbnail text produces.
  boxScoreThreshold: 0.45,
  // Preset default 1.5 can clip ascenders/descenders on small text, which
  // truncates the recognized string and breaks exact-shape PII matching.
  unclipRatio: 1.8,
  // Preset default 20px^2 drops short tokens rendered inside thumbnails.
  minimumAreaThreshold: 8,
} as const;

/**
 * Longest side handed to the detector. Tiles arrive already sized to the
 * runtime's budget, so `max` limiting only engages on the full-image pass.
 * Shared with the tile planner: if these two ever disagree, tiles get
 * rescaled after planning and small-text recall silently drops.
 */
function maxSideLengthFor(mode: RuntimeMode): number {
  return detectorInputBudget(mode);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, byte]) => Number(byte));
    if (entries.length > 0) return Uint8Array.from(entries);
  }
  throw new TypeError("OCR model payload is not a byte buffer.");
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  return Uint8Array.from(toBytes(value)).buffer;
}

/**
 * PaddleOCR creates its sessions through `ort.InferenceSession.create(buffer)`
 * and exposes no hook for execution providers, so the GPU profile is applied
 * by wrapping the module it receives. WASM stays in the provider list as the
 * fallback when a WebGPU session cannot be created.
 */
function ortModuleFor(mode: RuntimeMode): OrtModule {
  const base = ort as unknown as OrtModule;
  if (mode !== "webgpu") return base;
  return {
    ...base,
    InferenceSession: {
      ...base.InferenceSession,
      create: async (modelBuffer: ArrayBuffer) => {
        const session = (await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ["webgpu", "wasm"],
        })) as OrtInferenceSession & { executionProviders?: readonly string[] };
        // Fix 3: read back what ORT actually bound. A silent fall to the WASM
        // EP looks like "selected webgpu" while running at CPU speed; this
        // makes it visible without hard-failing, since WASM is a valid mode.
        boundExecutionProvider = session.executionProviders?.some((provider: string) =>
          provider.startsWith("webgpu"),
        )
          ? "webgpu"
          : "wasm";
        return session as unknown as Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
      },
    } as OrtModule["InferenceSession"],
  } as OrtModule;
}

self.onmessage = async (event: MessageEvent<Message>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      runtimeMode = message.mode ?? "wasm";
      // PaddleOCR character dictionaries omit the space character; the
      // official decoder convention (`use_space_char`) appends it after
      // loading. The CTC blank entry is handled separately by the model
      // (class 0), so it must not be added here.
      const dictionary = [
        ...new TextDecoder().decode(toBytes(message.dictionary)).trimEnd().split(/\r?\n/),
        " ",
      ];
      service = await PaddleOcrService.createInstance({
        ort: ortModuleFor(runtimeMode),
        modelPreset: "PP-OCRv5_mobile",
        detection: { modelBuffer: toArrayBuffer(message.detector) },
        recognition: { modelBuffer: toArrayBuffer(message.recognizer), charactersDictionary: dictionary },
      });
      self.postMessage({ requestId: message.requestId, type: "ready", executionProvider: boundExecutionProvider });
      return;
    }
    if (!service) throw new Error("OCR worker has not been initialized.");
    const results = await service.recognize(
      {
        width: message.width,
        height: message.height,
        data: toBytes(message.data),
      },
      {
        detection: {
          ...DETECTION_TUNING,
          limitType: "max",
          maxSideLength: maxSideLengthFor(runtimeMode),
        },
      },
    );
    const tokens = results.map((result) => ({
      text: result.text,
      confidence: result.confidence,
      box: {
        x: result.box.x,
        y: result.box.y,
        width: result.box.width,
        height: result.box.height,
      },
    }));
    self.postMessage({ requestId: message.requestId, type: "result", tokens });
  } catch (error) {
    self.postMessage({
      requestId: message.requestId,
      type: "error",
      message: error instanceof Error ? error.message : "OCR inference failed.",
    });
  }
};

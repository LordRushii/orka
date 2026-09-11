import * as ort from "onnxruntime-web";
import { PaddleOcrService } from "paddleocr";

type Init = { type: "init"; requestId: string; detector: ArrayBuffer; recognizer: ArrayBuffer; dictionary: ArrayBuffer };
type Recognize = { type: "recognize"; requestId: string; width: number; height: number; data: ArrayBuffer };
type Message = Init | Recognize;

let service: PaddleOcrService | undefined;
ort.env.wasm.wasmPaths = new URL("./models/", import.meta.url).href;

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

self.onmessage = async (event: MessageEvent<Message>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      // PaddleOCR character dictionaries omit the space character; the
      // official decoder convention (`use_space_char`) appends it after
      // loading. The CTC blank entry is handled separately by the model
      // (class 0), so it must not be added here.
      const dictionary = [
        ...new TextDecoder().decode(toBytes(message.dictionary)).trimEnd().split(/\r?\n/),
        " ",
      ];
      service = await PaddleOcrService.createInstance({
        ort: ort as unknown as import("paddleocr").PaddleOptions["ort"],
        modelPreset: "PP-OCRv5_mobile",
        detection: { modelBuffer: toArrayBuffer(message.detector) },
        recognition: { modelBuffer: toArrayBuffer(message.recognizer), charactersDictionary: dictionary },
      });
      self.postMessage({ requestId: message.requestId, type: "ready" });
      return;
    }
    if (!service) throw new Error("OCR worker has not been initialized.");
    const results = await service.recognize({
      width: message.width,
      height: message.height,
      data: toBytes(message.data),
    });
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

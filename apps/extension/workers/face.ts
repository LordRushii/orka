import * as ort from "onnxruntime-web";
import { decodeUltraFaceOutputs, preprocessUltraFace, ULTRAFACE_INPUT } from "@orka/privacy-engine";

type Init = { type: "init"; requestId: string; model: ArrayBuffer; mode?: "webgpu" | "balanced" | "wasm" };
type Detect = { type: "detect"; requestId: string; width: number; height: number; data: ArrayBuffer };
type Message = Init | Detect;

let session: ort.InferenceSession | undefined;
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
  throw new TypeError("Face model payload is not a byte buffer.");
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  return Uint8Array.from(toBytes(value)).buffer;
}

function tensorValues(value: ort.Tensor): ArrayLike<number> {
  return value.data as ArrayLike<number>;
}

self.onmessage = async (event: MessageEvent<Message>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      session = await ort.InferenceSession.create(toArrayBuffer(message.model), {
        executionProviders: message.mode === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
      });
      self.postMessage({ requestId: message.requestId, type: "ready" });
      return;
    }
    if (!session) throw new Error("Face worker has not been initialized.");
    const inputName = session.inputNames[0];
    // UltraFace lists its graph outputs as [scores, boxes]. Bind by name so a
    // fixed index can't silently swap confidences with box coordinates -- a
    // swap would not throw, it would just stop detecting faces.
    const locationName = session.outputNames.find((name) => /box/i.test(name)) ?? session.outputNames[1];
    const confidenceName = session.outputNames.find((name) => /score|conf|prob/i.test(name)) ?? session.outputNames[0];
    if (!inputName || !locationName || !confidenceName) throw new Error("UltraFace model I/O is incomplete.");

    const input = preprocessUltraFace({
      width: message.width,
      height: message.height,
      data: new Uint8ClampedArray(toBytes(message.data)),
    });
    const feeds: Record<string, ort.Tensor> = {
      [inputName]: new ort.Tensor("float32", input, [1, 3, ULTRAFACE_INPUT.height, ULTRAFACE_INPUT.width]),
    };
    const outputs = await session.run(feeds);
    const locationOutput = outputs[locationName];
    const confidenceOutput = outputs[confidenceName];
    if (!locationOutput || !confidenceOutput) throw new Error("UltraFace returned an unexpected output shape.");

    const faces = decodeUltraFaceOutputs(
      tensorValues(confidenceOutput),
      tensorValues(locationOutput),
      { width: message.width, height: message.height },
    );
    self.postMessage({ requestId: message.requestId, type: "result", faces });
  } catch (error) {
    self.postMessage({
      requestId: message.requestId,
      type: "error",
      message: error instanceof Error ? error.message : "Face inference failed.",
    });
  }
};

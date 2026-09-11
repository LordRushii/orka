import * as ort from "onnxruntime-web";
import { nonMaximumSuppression, clampBox, type FaceCandidate } from "@orka/privacy-engine";

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
    const input = new Float32Array(1 * 3 * 240 * 320);
    const pixels = new Uint8ClampedArray(toBytes(message.data));
    for (let y = 0; y < 240; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        const sourceX = Math.min(message.width - 1, Math.floor(x * message.width / 320));
        const sourceY = Math.min(message.height - 1, Math.floor(y * message.height / 240));
        const source = (sourceY * message.width + sourceX) * 4;
        const offset = y * 320 + x;
        input[offset] = ((pixels[source] ?? 0) - 127) / 128;
        input[240 * 320 + offset] = ((pixels[source + 1] ?? 0) - 127) / 128;
        input[2 * 240 * 320 + offset] = ((pixels[source + 2] ?? 0) - 127) / 128;
      }
    }
    const feeds: Record<string, ort.Tensor> = {
      [inputName]: new ort.Tensor("float32", input, [1, 3, 240, 320]),
    };
    const outputs = await session.run(feeds);
    const locationOutput = outputs[locationName];
    const confidenceOutput = outputs[confidenceName];
    if (!locationOutput || !confidenceOutput) throw new Error("UltraFace returned an unexpected output shape.");
    const locations = tensorValues(locationOutput);
    const confidences = tensorValues(confidenceOutput);
    const candidates: FaceCandidate[] = [];
    for (let index = 0; index < Math.floor(locations.length / 4); index += 1) {
      const confidence = Number(confidences[index * 2 + 1] ?? 0);
      if (confidence < 0.65) continue;
      const base = index * 4;
      const x = Number(locations[base] ?? 0) * message.width;
      const y = Number(locations[base + 1] ?? 0) * message.height;
      const width = Number(locations[base + 2] ?? 0) * message.width - x;
      const height = Number(locations[base + 3] ?? 0) * message.height - y;
      const box = clampBox({ x, y, width, height }, message);
      if (box.width > 0 && box.height > 0) candidates.push({ box, confidence });
    }
    const faces = nonMaximumSuppression(candidates).map(({ box, confidence }) => ({ box, confidence }));
    self.postMessage({ requestId: message.requestId, type: "result", faces });
  } catch (error) {
    self.postMessage({
      requestId: message.requestId,
      type: "error",
      message: error instanceof Error ? error.message : "Face inference failed.",
    });
  }
};

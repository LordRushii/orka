import type { RasterImage } from "../types";
import { nextRequestId } from "./requestId";
import type { OcrToken, TextRecognizer } from "./types";
import { callWorker, type WorkerLike } from "./workerClient";

export type OcrWorkerRequest = {
  requestId: string;
  type: "recognize";
  width: number;
  height: number;
  /** Transferred, not copied, when posted to a real Worker. */
  data: ArrayBuffer;
};

export type OcrWorkerResponse =
  | { requestId: string; type: "result"; tokens: OcrToken[] }
  | { requestId: string; type: "error"; message: string };

const DEFAULT_OCR_TIMEOUT_MS = 8000;

/**
 * Converts a `RasterImage` into a transferable Worker request, waits for
 * the correlated response, and converts it back into `OcrToken[]` -- the
 * conversion this class performs is exactly what
 * "Worker tests for OCR conversion" (phases/02-local-privacy-engine.md)
 * exercises, independent of whatever model runs inside the real worker.
 */
export class OcrWorkerClient implements TextRecognizer {
  constructor(
    private readonly worker: WorkerLike<OcrWorkerRequest, OcrWorkerResponse>,
    private readonly timeoutMs: number = DEFAULT_OCR_TIMEOUT_MS,
  ) {}

  async recognize(image: RasterImage): Promise<OcrToken[]> {
    const requestId = nextRequestId();
    const buffer = image.data.buffer.slice(
      image.data.byteOffset,
      image.data.byteOffset + image.data.byteLength,
    ) as ArrayBuffer;

    const response = await callWorker<OcrWorkerRequest, OcrWorkerResponse>(
      this.worker,
      { requestId, type: "recognize", width: image.width, height: image.height, data: buffer },
      this.timeoutMs,
      [buffer],
    );

    if (response.type === "error") {
      throw new Error(response.message);
    }
    return response.tokens;
  }
}

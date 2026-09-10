import type { RasterImage } from "../types";
import { nextRequestId } from "./requestId";
import type { FaceBox, FaceDetector } from "./types";
import { callWorker, type WorkerLike } from "./workerClient";

export type FaceWorkerRequest = {
  requestId: string;
  type: "detect";
  width: number;
  height: number;
  data: ArrayBuffer;
};

export type FaceWorkerResponse =
  | { requestId: string; type: "result"; faces: FaceBox[] }
  | { requestId: string; type: "error"; message: string };

const DEFAULT_FACE_TIMEOUT_MS = 8000;

/** Same request/response conversion pattern as `OcrWorkerClient`, for the local face detector. */
export class FaceWorkerClient implements FaceDetector {
  constructor(
    private readonly worker: WorkerLike<FaceWorkerRequest, FaceWorkerResponse>,
    private readonly timeoutMs: number = DEFAULT_FACE_TIMEOUT_MS,
  ) {}

  async detect(image: RasterImage): Promise<FaceBox[]> {
    const requestId = nextRequestId();
    const buffer = image.data.buffer.slice(
      image.data.byteOffset,
      image.data.byteOffset + image.data.byteLength,
    ) as ArrayBuffer;

    const response = await callWorker<FaceWorkerRequest, FaceWorkerResponse>(
      this.worker,
      { requestId, type: "detect", width: image.width, height: image.height, data: buffer },
      this.timeoutMs,
      [buffer],
    );

    if (response.type === "error") {
      throw new Error(response.message);
    }
    return response.faces;
  }
}

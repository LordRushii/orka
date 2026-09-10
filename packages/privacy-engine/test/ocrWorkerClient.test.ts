import { describe, expect, test } from "bun:test";
import { OcrWorkerClient, type OcrWorkerRequest, type OcrWorkerResponse } from "../src/pixel/ocrWorkerClient";
import type { RasterImage } from "../src/types";

/**
 * An in-memory stand-in for a real Worker: captures the posted request and
 * lets the test script a response (or none, to exercise the timeout path).
 */
class FakeWorker {
  private listeners: Array<(event: { data: OcrWorkerResponse }) => void> = [];
  public lastRequest: OcrWorkerRequest | undefined;

  postMessage(message: OcrWorkerRequest): void {
    this.lastRequest = message;
  }

  addEventListener(_type: "message", listener: (event: { data: OcrWorkerResponse }) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: OcrWorkerResponse }) => void): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  emit(response: OcrWorkerResponse): void {
    for (const listener of this.listeners) listener({ data: response });
  }
}

function fakeImage(): RasterImage {
  return { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
}

describe("OcrWorkerClient", () => {
  test("converts a RasterImage into a transferable width/height/buffer request", async () => {
    const worker = new FakeWorker();
    const client = new OcrWorkerClient(worker, 1000);
    const image = fakeImage();

    const pending = client.recognize(image);
    expect(worker.lastRequest?.type).toBe("recognize");
    expect(worker.lastRequest?.width).toBe(2);
    expect(worker.lastRequest?.height).toBe(2);
    expect(worker.lastRequest?.data.byteLength).toBe(image.data.byteLength);

    worker.emit({ requestId: worker.lastRequest!.requestId, type: "result", tokens: [] });
    await expect(pending).resolves.toEqual([]);
  });

  test("resolves with the tokens from a matching result message", async () => {
    const worker = new FakeWorker();
    const client = new OcrWorkerClient(worker, 1000);

    const pending = client.recognize(fakeImage());
    worker.emit({
      requestId: worker.lastRequest!.requestId,
      type: "result",
      tokens: [{ text: "hello", box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 }],
    });

    await expect(pending).resolves.toEqual([
      { text: "hello", box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 },
    ]);
  });

  test("ignores a response for a different (stale) requestId", async () => {
    const worker = new FakeWorker();
    const client = new OcrWorkerClient(worker, 200);

    const pending = client.recognize(fakeImage());
    worker.emit({ requestId: "some-other-request", type: "result", tokens: [] });

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  test("rejects when the worker reports an error", async () => {
    const worker = new FakeWorker();
    const client = new OcrWorkerClient(worker, 1000);

    const pending = client.recognize(fakeImage());
    worker.emit({ requestId: worker.lastRequest!.requestId, type: "error", message: "model failed to load" });

    await expect(pending).rejects.toThrow("model failed to load");
  });

  test("rejects with a timeout when the worker never responds", async () => {
    const worker = new FakeWorker();
    const client = new OcrWorkerClient(worker, 20);

    await expect(client.recognize(fakeImage())).rejects.toThrow(/timed out/i);
  });
});

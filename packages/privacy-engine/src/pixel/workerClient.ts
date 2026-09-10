/**
 * Minimal stand-in for the DOM `Transferable` type. This package's
 * tsconfig has no `"dom"` lib (it must stay usable from a Worker/service
 * worker/Node test context alike), so the shape is declared locally.
 */
export type TransferableLike = ArrayBuffer | MessagePortLike | object;
export type MessagePortLike = { postMessage: (...args: unknown[]) => void };

/**
 * Minimal shape this module needs from a Web Worker (or a test double).
 * Kept intentionally narrow so unit tests can supply an in-memory fake
 * without touching the real Worker global.
 */
export type WorkerLike<TRequest, TResponse> = {
  postMessage(message: TRequest, transfer?: TransferableLike[]): void;
  addEventListener(type: "message", listener: (event: { data: TResponse }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: TResponse }) => void): void;
};

export type WorkerRequestBase = { requestId: string };
export type WorkerResponseBase = { requestId: string };

/**
 * Sends one request to a worker and resolves with the matching response
 * (`requestId`-correlated so stray/late messages from a prior call are
 * ignored), rejecting on `timeoutMs`. This is the shared plumbing behind
 * both the OCR and face-detection worker clients.
 */
export function callWorker<TRequest extends WorkerRequestBase, TResponse extends WorkerResponseBase>(
  worker: WorkerLike<TRequest, TResponse>,
  request: TRequest,
  timeoutMs: number,
  transfer?: TransferableLike[],
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("message", onMessage);
      reject(new Error("Worker request timed out."));
    }, timeoutMs);

    function onMessage(event: { data: TResponse }) {
      if (event.data.requestId !== request.requestId) return;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      resolve(event.data);
    }

    worker.addEventListener("message", onMessage);
    worker.postMessage(request, transfer);
  });
}

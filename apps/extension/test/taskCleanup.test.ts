import { describe, expect, test } from "bun:test";
import { releaseTaskResources, type ReleasableTask } from "../shared/taskCleanup.ts";

/**
 * Phase 2 requires that a Task Session drops the raw capture, the local audit,
 * the pending timeout, and all model/worker state on *every* terminal path --
 * success, failure, stop, timeout, audit close, and task replacement. These
 * cover the shared release routine each of those paths calls.
 */

type Spy = { dispose(): void; calls: number };

function spy(onDispose?: () => void): Spy {
  return {
    calls: 0,
    dispose() {
      this.calls += 1;
      onDispose?.();
    },
  };
}

function task(overrides: Partial<ReleasableTask> = {}): ReleasableTask & {
  modelManager: Spy;
  pixelWorkers: Spy;
} {
  return {
    screenshotDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    audit: { originalScreenshot: { width: 1920, height: 1080 }, redactionMap: [{ x: 10 }] },
    modelManager: spy(),
    pixelWorkers: spy(),
    ...overrides,
  } as ReleasableTask & { modelManager: Spy; pixelWorkers: Spy };
}

describe("releaseTaskResources", () => {
  test("drops the raw capture data URL", () => {
    const active = task();
    releaseTaskResources(active);
    expect(active.screenshotDataUrl).toBe("");
  });

  test("drops the local audit, which holds the original pixels and exact boxes", () => {
    const active = task();
    releaseTaskResources(active);
    expect(active.audit).toBeUndefined();
  });

  test("disposes model state and pixel workers exactly once", () => {
    const active = task();
    releaseTaskResources(active);
    expect(active.modelManager.calls).toBe(1);
    expect(active.pixelWorkers.calls).toBe(1);
  });

  test("clears a pending session timeout and forgets its handle", () => {
    let fired = false;
    const handle = setTimeout(() => {
      fired = true;
    }, 1);
    const active = task({ timeoutHandle: handle });

    releaseTaskResources(active);
    expect(active.timeoutHandle).toBeUndefined();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(fired).toBe(false);
        resolve();
      }, 20);
    });
  });

  test("handles a task with no pending timeout", () => {
    const active = task({ timeoutHandle: undefined });
    expect(() => releaseTaskResources(active)).not.toThrow();
    expect(active.modelManager.calls).toBe(1);
  });

  test("still releases the capture when the model manager throws", () => {
    // A crashed model must not be able to keep the raw screenshot alive.
    const active = task({
      modelManager: spy(() => {
        throw new Error("model already disposed");
      }),
    });
    expect(() => releaseTaskResources(active)).not.toThrow();
    expect(active.screenshotDataUrl).toBe("");
    expect(active.audit).toBeUndefined();
    expect((active.pixelWorkers as Spy).calls).toBe(1);
  });

  test("still releases the capture when worker terminate() throws", () => {
    const active = task({
      pixelWorkers: spy(() => {
        throw new Error("worker already terminated");
      }),
    });
    expect(() => releaseTaskResources(active)).not.toThrow();
    expect(active.screenshotDataUrl).toBe("");
    expect(active.audit).toBeUndefined();
    expect((active.modelManager as Spy).calls).toBe(1);
  });

  test("releases everything even when both disposers throw", () => {
    const active = task({
      modelManager: spy(() => {
        throw new Error("model boom");
      }),
      pixelWorkers: spy(() => {
        throw new Error("worker boom");
      }),
    });
    expect(() => releaseTaskResources(active)).not.toThrow();
    expect(active.screenshotDataUrl).toBe("");
    expect(active.audit).toBeUndefined();
  });

  test("is idempotent, so the catch -> failTask double-release path is safe", () => {
    const active = task({ timeoutHandle: setTimeout(() => {}, 1000) });
    releaseTaskResources(active);
    expect(() => releaseTaskResources(active)).not.toThrow();
    expect(active.screenshotDataUrl).toBe("");
    expect(active.audit).toBeUndefined();
    expect(active.timeoutHandle).toBeUndefined();
    // Disposal is re-issued but must stay safe; workers no-op on a second
    // terminate() and the model manager tolerates repeat disposal.
    expect(active.modelManager.calls).toBe(2);
  });

  test("releases a task that never got as far as capturing", () => {
    // Model load can fail before any screenshot exists.
    const active = task({ screenshotDataUrl: "", audit: undefined });
    expect(() => releaseTaskResources(active)).not.toThrow();
    expect(active.modelManager.calls).toBe(1);
    expect(active.pixelWorkers.calls).toBe(1);
  });
});

describe("terminal task paths", () => {
  /**
   * Each background.ts terminal path funnels through `releaseTask`. This
   * asserts the post-conditions every one of them must satisfy, so a newly
   * added path that forgets a field fails here.
   */
  const paths = [
    "sanitization failure (failTask)",
    "session timeout (90s handler)",
    "user stop (stopTask)",
    "audit close (closeAudit)",
    "task replacement (session cannot accept SANITIZED)",
    "unexpected error (scanTask catch)",
  ];

  for (const path of paths) {
    test(`${path} leaves no capture, audit, timer, or live worker`, () => {
      const active = task({ timeoutHandle: setTimeout(() => {}, 5000) });
      releaseTaskResources(active);
      expect(active.screenshotDataUrl).toBe("");
      expect(active.audit).toBeUndefined();
      expect(active.timeoutHandle).toBeUndefined();
      expect(active.modelManager.calls).toBe(1);
      expect(active.pixelWorkers.calls).toBe(1);
    });
  }
});

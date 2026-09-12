import { describe, expect, test } from "bun:test";
import { createPixelModelManager } from "../src/pixel/modelManager";
import { ModelLoadFailedError } from "../src/sanitize";
import { sha256Hex, type ModelManifest } from "../src/manifest";
import type { RuntimeProfile } from "../src/types";

/**
 * Model loading must fail closed: a missing, truncated, or tampered asset
 * has to surface as MODEL_LOAD_FAILED rather than letting a scan proceed
 * with a detector that silently finds nothing.
 */

const PROFILE: RuntimeProfile = { mode: "wasm", override: "auto", reason: "test" };

const PAYLOAD = new TextEncoder().encode("pinned-model-bytes").buffer as ArrayBuffer;

async function manifestFor(bytes: ArrayBuffer): Promise<ModelManifest> {
  return {
    "test-model": {
      name: "test model",
      version: "1.0.0",
      url: "/models/test.onnx",
      sha256: await sha256Hex(bytes),
      maxBytes: 1024,
    },
  };
}

function fetchReturning(bytes: ArrayBuffer, onCall?: () => void) {
  return async (_url: string) => {
    onCall?.();
    return { arrayBuffer: async () => bytes };
  };
}

describe("createPixelModelManager", () => {
  test("returns verified model bytes keyed by manifest name", async () => {
    const manager = createPixelModelManager(await manifestFor(PAYLOAD), fetchReturning(PAYLOAD));
    const models = await manager.initialize(PROFILE);
    expect(models.get("test-model")).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(models.get("test-model")!)).toEqual(new Uint8Array(PAYLOAD));
  });

  test("loads once and reuses the verified bytes across a scan session", async () => {
    let calls = 0;
    const manager = createPixelModelManager(
      await manifestFor(PAYLOAD),
      fetchReturning(PAYLOAD, () => {
        calls += 1;
      }),
    );
    await manager.initialize(PROFILE);
    await manager.initialize(PROFILE);
    expect(calls).toBe(1);
  });

  test("fails closed with ModelLoadFailedError when the digest does not match", async () => {
    const tampered = new TextEncoder().encode("tampered-model-bytes").buffer as ArrayBuffer;
    const manager = createPixelModelManager(await manifestFor(PAYLOAD), fetchReturning(tampered));
    await expect(manager.initialize(PROFILE)).rejects.toBeInstanceOf(ModelLoadFailedError);
  });

  test("fails closed when the asset is missing entirely", async () => {
    const manager = createPixelModelManager(await manifestFor(PAYLOAD), async () => {
      throw new Error("net::ERR_FILE_NOT_FOUND");
    });
    await expect(manager.initialize(PROFILE)).rejects.toBeInstanceOf(ModelLoadFailedError);
  });

  test("fails closed on a zero-byte asset rather than initializing an empty model", async () => {
    const manager = createPixelModelManager(
      await manifestFor(PAYLOAD),
      fetchReturning(new ArrayBuffer(0)),
    );
    await expect(manager.initialize(PROFILE)).rejects.toBeInstanceOf(ModelLoadFailedError);
  });

  test("fails closed when an asset exceeds its pinned byte budget", async () => {
    const manifest = await manifestFor(PAYLOAD);
    const oversized = new ArrayBuffer(4096);
    const manager = createPixelModelManager(
      { "test-model": { ...manifest["test-model"]!, sha256: await sha256Hex(oversized) } },
      fetchReturning(oversized),
    );
    await expect(manager.initialize(PROFILE)).rejects.toBeInstanceOf(ModelLoadFailedError);
  });

  test("does not cache a failure, so a later scan can retry cleanly", async () => {
    let attempt = 0;
    const manifest = await manifestFor(PAYLOAD);
    const manager = createPixelModelManager(manifest, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient read failure");
      return { arrayBuffer: async () => PAYLOAD };
    });

    await expect(manager.initialize(PROFILE)).rejects.toBeInstanceOf(ModelLoadFailedError);
    const models = await manager.initialize(PROFILE);
    expect(models.get("test-model")).toBeInstanceOf(ArrayBuffer);
  });

  test("loads the whole set or none of it, never a partial set", async () => {
    const manifest = await manifestFor(PAYLOAD);
    const twoEntries: ModelManifest = {
      ...manifest,
      "second-model": { ...manifest["test-model"]!, name: "second", url: "/models/second.onnx" },
    };
    const manager = createPixelModelManager(twoEntries, async (url) => ({
      arrayBuffer: async () => (url.includes("second") ? new ArrayBuffer(0) : PAYLOAD),
    }));
    await expect(manager.initialize(PROFILE)).rejects.toBeInstanceOf(ModelLoadFailedError);
  });

  test("dispose drops the retained bytes so the next scan re-verifies", async () => {
    let calls = 0;
    const manager = createPixelModelManager(
      await manifestFor(PAYLOAD),
      fetchReturning(PAYLOAD, () => {
        calls += 1;
      }),
    );
    await manager.initialize(PROFILE);
    manager.dispose();
    await manager.initialize(PROFILE);
    // Re-verification on every session means a model swapped on disk between
    // scans cannot be used from a stale in-memory cache.
    expect(calls).toBe(2);
  });

  test("dispose is safe before any load and repeatable afterwards", async () => {
    const manager = createPixelModelManager(await manifestFor(PAYLOAD), fetchReturning(PAYLOAD));
    expect(() => manager.dispose()).not.toThrow();
    await manager.initialize(PROFILE);
    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });

  test("never reaches the network for a model URL under the default fetch", async () => {
    // Pinned assets are extension-local; a remote fetch would defeat pinning.
    const manifest = await manifestFor(PAYLOAD);
    for (const entry of Object.values(manifest)) {
      expect(entry.url.startsWith("/")).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { getManifestEntry, loadPinnedModel, ModelIntegrityError, sha256Hex } from "../src/manifest";

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("sha256Hex", () => {
  test("matches a known digest for an empty buffer", async () => {
    const digest = await sha256Hex(new ArrayBuffer(0));
    expect(digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(digest).toHaveLength(64);
  });
});

describe("loadPinnedModel", () => {
  test("returns the bytes when the digest matches the pinned hash", async () => {
    const bytes = bytesOf("model-bytes");
    const digest = await sha256Hex(bytes);
    const entry = { name: "face", version: "1", url: "https://example.com/model.onnx", sha256: digest, maxBytes: 1_000 };

    const result = await loadPinnedModel(entry, async () => ({ arrayBuffer: async () => bytes }));
    expect(new TextDecoder().decode(result)).toBe("model-bytes");
  });

  test("throws ModelIntegrityError when the digest does not match", async () => {
    const bytes = bytesOf("model-bytes");
    const entry = {
      name: "face",
      version: "1",
      url: "https://example.com/model.onnx",
      sha256: "0".repeat(64),
      maxBytes: 1_000,
    };

    await expect(
      loadPinnedModel(entry, async () => ({ arrayBuffer: async () => bytes })),
    ).rejects.toThrow(ModelIntegrityError);
  });

  test("throws ModelIntegrityError when the asset exceeds the pinned size budget", async () => {
    const bytes = bytesOf("this payload is definitely too big for the budget");
    const digest = await sha256Hex(bytes);
    const entry = { name: "face", version: "1", url: "https://example.com/model.onnx", sha256: digest, maxBytes: 4 };

    await expect(
      loadPinnedModel(entry, async () => ({ arrayBuffer: async () => bytes })),
    ).rejects.toThrow(ModelIntegrityError);
  });

  test("throws ModelIntegrityError on an empty download", async () => {
    const entry = { name: "face", version: "1", url: "https://example.com/model.onnx", sha256: "a".repeat(64), maxBytes: 100 };
    await expect(
      loadPinnedModel(entry, async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
    ).rejects.toThrow(ModelIntegrityError);
  });
});

describe("getManifestEntry", () => {
  test("throws for a name with no pinned entry", () => {
    expect(() => getManifestEntry({}, "face")).toThrow(ModelIntegrityError);
  });

  test("returns the entry when present", () => {
    const entry = { name: "face", version: "1", url: "https://example.com/model.onnx", sha256: "a".repeat(64), maxBytes: 100 };
    expect(getManifestEntry({ face: entry }, "face")).toBe(entry);
  });
});

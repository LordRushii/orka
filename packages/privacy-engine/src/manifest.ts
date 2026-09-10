/**
 * Pinned model asset manifest, per docs/TECH-STACK.md ("Model formats:
 * ONNX/ORT assets with version and SHA-256 manifest") and
 * docs/SECURITY-PRIVACY.md ("pins model assets by version and SHA-256").
 *
 * The actual OCR/face model URLs and hashes are an explicit, reviewable
 * team decision -- this module never guesses or downloads an unpinned
 * asset. `MODEL_MANIFEST` below intentionally ships empty; wiring a real
 * entry here is a required follow-up before pixel detection can run
 * outside of tests (see the Phase 2 handoff notes).
 */
export type ModelManifestEntry = {
  name: string;
  version: string;
  url: string;
  sha256: string;
  maxBytes: number;
};

export type ModelManifest = Record<string, ModelManifestEntry>;

export const MODEL_MANIFEST: ModelManifest = {};

export class ModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelIntegrityError";
  }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Computes a lowercase hex SHA-256 digest using the standard Web Crypto API. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

export type FetchLike = (url: string) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Fetches a manifest-pinned model asset and verifies its size and SHA-256
 * digest before returning the bytes. Throws `ModelIntegrityError` on any
 * mismatch; callers must treat that as a fail-closed `MODEL_LOAD_FAILED`.
 */
export async function loadPinnedModel(
  entry: ModelManifestEntry,
  fetchImpl: FetchLike = fetch,
): Promise<ArrayBuffer> {
  const response = await fetchImpl(entry.url);
  const bytes = await response.arrayBuffer();

  if (bytes.byteLength === 0) {
    throw new ModelIntegrityError(`Model "${entry.name}" downloaded 0 bytes.`);
  }
  if (bytes.byteLength > entry.maxBytes) {
    throw new ModelIntegrityError(
      `Model "${entry.name}" exceeds the pinned size budget (${bytes.byteLength} > ${entry.maxBytes} bytes).`,
    );
  }

  const digest = await sha256Hex(bytes);
  if (digest !== entry.sha256.toLowerCase()) {
    throw new ModelIntegrityError(
      `Model "${entry.name}" failed SHA-256 verification; refusing to load an unpinned asset.`,
    );
  }

  return bytes;
}

export function getManifestEntry(manifest: ModelManifest, name: string): ModelManifestEntry {
  const entry = manifest[name];
  if (!entry) {
    throw new ModelIntegrityError(`No pinned manifest entry for model "${name}".`);
  }
  return entry;
}

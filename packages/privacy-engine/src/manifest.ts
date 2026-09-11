/**
 * Pinned model asset manifest, per docs/TECH-STACK.md ("Model formats:
 * ONNX/ORT assets with version and SHA-256 manifest") and
 * docs/SECURITY-PRIVACY.md ("pins model assets by version and SHA-256").
 *
 * URLs are extension-local. The extension build copies the files named here
 * into its public model directory; a missing or altered file is a hard
 * failure rather than an opportunity to download a replacement.
 */
export type ModelManifestEntry = {
  name: string;
  version: string;
  url: string;
  sha256: string;
  maxBytes: number;
};

export type ModelManifest = Record<string, ModelManifestEntry>;

export const MODEL_MANIFEST: ModelManifest = {
  "ort-wasm": {
    name: "onnxruntime-web wasm runtime",
    version: "1.29.0",
    url: "/models/ort-wasm.wasm",
    sha256: "ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d",
    maxBytes: 16 * 1024 * 1024,
  },
  "paddleocr-detector": {
    name: "PP-OCR mobile detector",
    version: "PP-OCRv5_mobile",
    url: "/models/pp-ocr-mobile-det.onnx",
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
    maxBytes: 6 * 1024 * 1024,
  },
  "paddleocr-recognizer": {
    name: "PP-OCR mobile recognizer",
    version: "PP-OCRv5_mobile",
    url: "/models/pp-ocr-mobile-rec.onnx",
    sha256: "86b1f8bffa31748e0d6364a98af983bbd33b92523141d4a02fa587b4b66b54af",
    maxBytes: 18 * 1024 * 1024,
  },
  "ultraface": {
    name: "UltraFace mobile face detector",
    version: "1.0.0",
    url: "/models/ultraface.onnx",
    sha256: "34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017",
    maxBytes: 2 * 1024 * 1024,
  },
  "paddleocr-dictionary": {
    name: "PP-OCRv5 mobile dictionary",
    version: "PP-OCRv5_mobile",
    url: "/models/ppocrv5_dict.txt",
    sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
    maxBytes: 128 * 1024,
  },
};

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

/** Loads every asset required by the pixel pipeline before either worker starts. */
export async function loadPinnedModelSet(
  manifest: ModelManifest = MODEL_MANIFEST,
  fetchImpl: FetchLike = fetch,
): Promise<ReadonlyMap<string, ArrayBuffer>> {
  const loaded = new Map<string, ArrayBuffer>();
  try {
    for (const [name, entry] of Object.entries(manifest)) {
      loaded.set(name, await loadPinnedModel(entry, fetchImpl));
    }
  } catch (error) {
    if (error instanceof ModelIntegrityError) throw error;
    throw new ModelIntegrityError(`Pinned model set could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return loaded;
}

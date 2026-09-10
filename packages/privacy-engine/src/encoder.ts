import type { RasterImage } from "./types";

/**
 * Encodes a raw RGBA bitmap into a wire-safe screenshot payload. Image
 * encoding is host-specific (the extension has `OffscreenCanvas`; a test
 * environment does not), so `PrivacyEngine.sanitize()` takes this as an
 * injected dependency instead of importing a browser-only API directly.
 */
export interface ImageEncoder {
  encode(image: RasterImage): Promise<{
    mimeType: "image/png" | "image/webp";
    dataBase64: string;
  }>;
}

import type { ImageEncoder, RasterImage } from "@orka/privacy-engine";
import type { EncodedScreenshot } from "./messages";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(output);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("Captured screenshot could not be decoded.");
  const header = dataUrl.slice(0, separator);
  const payload = dataUrl.slice(separator + 1);
  const mimeType = /^data:([^;,]+)/i.exec(header)?.[1] ?? "application/octet-stream";
  if (!/;base64/i.test(header)) {
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

export async function decodeCapturedScreenshot(dataUrl: string): Promise<RasterImage> {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Browser image decoder did not provide a 2D context.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: pixels.data };
  } finally {
    bitmap.close();
  }
}

export function createBrowserImageEncoder(): ImageEncoder {
  return {
    async encode(image: RasterImage): Promise<EncodedScreenshot> {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Browser image encoder did not provide a 2D context.");
      const pixels = new Uint8ClampedArray(new ArrayBuffer(image.data.byteLength));
      pixels.set(image.data);
      const imageData = new ImageData(pixels, image.width, image.height);
      context.putImageData(imageData, 0, 0);
      // PNG only: some vision-capable OpenAI-compatible servers (LM Studio's
      // local runtime among them) reject WebP outright rather than falling
      // back, so a format only some providers can decode is not a safe
      // default here. The observation carries no provider identity at
      // encode time, so the format has to work everywhere.
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return {
        mimeType: "image/png",
        width: image.width,
        height: image.height,
        dataBase64: arrayBufferToBase64(await blob.arrayBuffer()),
      };
    },
  };
}

export async function encodeForLocalAudit(
  encoder: ImageEncoder,
  image: RasterImage,
): Promise<EncodedScreenshot> {
  const encoded = await encoder.encode(image);
  return { ...encoded, width: image.width, height: image.height };
}

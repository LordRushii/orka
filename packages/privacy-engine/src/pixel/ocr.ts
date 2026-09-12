import { detectTextPii } from "../detectors";
import type { TextSource } from "../detectors/textSource";
import { meetsThreshold } from "../policy";
import type { Detection, RasterImage } from "../types";
import type { TextRecognizer } from "./types";
import { polygonToBox } from "./geometry";
import { cropRaster, planOcrTiles, translateBox, type TilePlanOptions } from "./tiles";
import type { OcrPolygonToken, OcrToken } from "./types";

export function convertOcrPolygons(
  tokens: OcrPolygonToken[],
  bounds: { width: number; height: number },
): OcrToken[] {
  return tokens.flatMap((token) => {
    const box = polygonToBox(token.polygon, bounds);
    return box ? [{ text: token.text, box, confidence: token.confidence }] : [];
  });
}

export type OcrDetectionOptions = {
  /**
   * Native-resolution second pass. Pass `false` (or omit) to run only the
   * single full-image pass.
   */
  tiling?: TilePlanOptions | false;
};

function toSources(tokens: OcrToken[], prefix: string, dx = 0, dy = 0): TextSource[] {
  return tokens.map((token, index) => ({
    id: `${prefix}-${index}`,
    text: token.text,
    box: dx === 0 && dy === 0 ? token.box : translateBox(token.box, dx, dy),
    origin: "ocr" as const,
  }));
}

/**
 * Runs local OCR and classifies its tokens with the same deterministic
 * detectors used on DOM text. Only the derived category/box ever leaves
 * this function -- raw OCR text is used for local classification and
 * discarded, per "Use OCR only for local location/classification; never
 * send full OCR text."
 *
 * The full-image pass alone is not sufficient: the detector downsamples a
 * full-page capture to its input budget, which drops text inside small
 * embedded images below the size it can resolve. The tiled pass re-reads
 * those regions at native resolution. Tiles overlap, so the same text is
 * often found twice; the duplicates collapse in `mergeDetections`.
 *
 * Passes run sequentially: one worker owns one inference session, and a
 * partial result must never be treated as a complete scan -- any pass that
 * throws or times out fails the whole sanitization closed.
 */
export async function runOcrDetection(
  recognizer: TextRecognizer,
  image: RasterImage,
  options: OcrDetectionOptions = {},
): Promise<Detection[]> {
  const sources = toSources(await recognizer.recognize(image), "ocr-full");

  const tiles = options.tiling ? planOcrTiles(image, options.tiling) : [];
  for (const [index, tile] of tiles.entries()) {
    const crop = cropRaster(image, tile);
    if (crop.width === 0 || crop.height === 0) continue;
    sources.push(...toSources(await recognizer.recognize(crop), `ocr-tile-${index}`, tile.x, tile.y));
  }

  return detectTextPii(sources).filter((detection) => meetsThreshold(detection.category, detection.confidence));
}

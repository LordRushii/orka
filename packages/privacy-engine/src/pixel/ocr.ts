import { detectTextPii } from "../detectors";
import type { TextSource } from "../detectors/textSource";
import { meetsThreshold } from "../policy";
import type { Detection, RasterImage } from "../types";
import type { TextRecognizer } from "./types";
import { polygonToBox } from "./geometry";
import type { OcrPolygonToken } from "./types";

export function convertOcrPolygons(
  tokens: OcrPolygonToken[],
  bounds: { width: number; height: number },
): Array<import("./types").OcrToken> {
  return tokens.flatMap((token) => {
    const box = polygonToBox(token.polygon, bounds);
    return box ? [{ text: token.text, box, confidence: token.confidence }] : [];
  });
}

/**
 * Runs local OCR and classifies its tokens with the same deterministic
 * detectors used on DOM text. Only the derived category/box ever leaves
 * this function -- raw OCR text is used for local classification and
 * discarded, per "Use OCR only for local location/classification; never
 * send full OCR text."
 */
export async function runOcrDetection(
  recognizer: TextRecognizer,
  image: RasterImage,
): Promise<Detection[]> {
  const tokens = await recognizer.recognize(image);
  const sources: TextSource[] = tokens.map((token, index) => ({
    id: `ocr-${index}`,
    text: token.text,
    box: token.box,
    origin: "ocr" as const,
  }));
  return detectTextPii(sources).filter((detection) => meetsThreshold(detection.category, detection.confidence));
}

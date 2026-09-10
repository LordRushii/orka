import { detectTextPii } from "../detectors";
import type { TextSource } from "../detectors/textSource";
import { meetsThreshold } from "../policy";
import type { Detection, RasterImage } from "../types";
import type { TextRecognizer } from "./types";

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

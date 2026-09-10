import type { Box, RasterImage } from "../types";

export type OcrToken = {
  text: string;
  box: Box;
  confidence: number;
};

/**
 * Runs OCR entirely locally (PaddleOCR.js in a Worker, per
 * phases/02-local-privacy-engine.md). Implementations must never return
 * more than what local classification needs and the engine never forwards
 * `OcrToken.text` to the gateway -- only the derived coarse category.
 */
export interface TextRecognizer {
  recognize(image: RasterImage): Promise<OcrToken[]>;
}

export type FaceBox = {
  box: Box;
  confidence: number;
};

export interface FaceDetector {
  detect(image: RasterImage): Promise<FaceBox[]>;
}

export type { RasterImage };

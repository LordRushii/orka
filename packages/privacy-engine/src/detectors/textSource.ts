import type { Box, DetectionSource } from "../types";

/**
 * One local run of text with a bounding box, either straight from the DOM
 * snapshot (a label, heading, or paragraph) or from an OCR token. Text
 * detectors are source-agnostic: the same regex/threshold logic classifies
 * both, per phases/02-local-privacy-engine.md ("source (dom/ocr)").
 */
export type TextSource = {
  id: string;
  text: string;
  box: Box;
  origin: DetectionSource;
};

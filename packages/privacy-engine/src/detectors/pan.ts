import type { Detection } from "../types";
import type { TextSource } from "./textSource";

// Indian PAN: 5 letters, 4 digits, 1 letter (e.g. "ABCDE1234F").
export const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

/** Flags PAN-shaped government ID values. */
export function detectPan(sources: TextSource[]): Detection[] {
  const detections: Detection[] = [];
  for (const source of sources) {
    PAN_REGEX.lastIndex = 0;
    const match = PAN_REGEX.exec(source.text.toUpperCase());
    if (!match) continue;

    detections.push({
      category: "GOVT_ID",
      confidence: 0.85,
      source: source.origin,
      box: source.box,
      reason: "Text matches a PAN-shaped value.",
    });
  }
  return detections;
}

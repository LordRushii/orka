import type { Detection } from "../types";
import { passesLuhnCheck } from "./luhn";
import type { TextSource } from "./textSource";

// 13-19 digit runs, optionally grouped by spaces or dashes in blocks of 4.
export const CARD_REGEX = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * Flags payment-card-shaped digit runs. A Luhn-valid match is high
 * confidence; a Luhn-invalid match of the right length/shape is still
 * flagged (lower confidence) so a mistyped or partially-OCR'd card number
 * fails closed toward redaction rather than leaking.
 */
export function detectCardNumbers(sources: TextSource[]): Detection[] {
  const detections: Detection[] = [];
  for (const source of sources) {
    CARD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CARD_REGEX.exec(source.text)) !== null) {
      const digits = match[0].replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      const valid = passesLuhnCheck(digits);
      detections.push({
        category: "CARD",
        confidence: valid ? 0.95 : 0.72,
        source: source.origin,
        box: source.box,
        reason: valid
          ? "Text matches a card-number shape and passes the Luhn check."
          : "Text matches a card-number shape.",
      });
    }
  }
  return detections;
}

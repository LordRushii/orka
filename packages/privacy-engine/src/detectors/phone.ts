import type { Detection } from "../types";
import type { TextSource } from "./textSource";

// Matches common international/local phone shapes: optional country code,
// then 6-14 more digits with optional spaces/dots/dashes/parentheses.
export const PHONE_REGEX = /(?:\+\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)[-.\s]?)?\d[\d\-.\s]{5,13}\d/g;

export function countDigits(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

export function isPlausiblePhoneDigitCount(value: string): boolean {
  const digitCount = countDigits(value);
  return digitCount >= 7 && digitCount <= 15;
}

/**
 * Flags text runs that contain a phone-number-shaped value. Confidence
 * rises with digit count and the presence of a `+` country-code prefix or
 * separators, since a bare short digit run is more likely to be a price,
 * ID, or page number than a phone number.
 */
export function detectPhoneNumbers(sources: TextSource[]): Detection[] {
  const detections: Detection[] = [];
  for (const source of sources) {
    PHONE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PHONE_REGEX.exec(source.text)) !== null) {
      const digitCount = countDigits(match[0]);
      if (digitCount < 7 || digitCount > 15) continue;
      let confidence = 0.55;
      if (/\+\d/.test(match[0])) confidence += 0.2;
      if (/[-.\s()]/.test(match[0])) confidence += 0.1;
      if (digitCount >= 10) confidence += 0.05;
      detections.push({
        category: "PHONE",
        confidence: Math.min(0.95, confidence),
        source: source.origin,
        box: source.box,
        reason: "Text matches a phone-number shape.",
      });
    }
  }
  return detections;
}

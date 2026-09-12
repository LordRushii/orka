import type { Detection } from "../types";
import type { TextSource } from "./textSource";

// Aadhaar numbers are 12 digits, conventionally grouped in 4s, and never
// start with 0 or 1.
//
// The lookarounds reject a 12-digit run that is part of a longer one. Without
// them, the first 12 digits of a space-grouped 16-digit card number
// ("4111 1111 1111 1111") match this pattern, and since GOVT_ID outranks CARD
// at merge, ordinary payment cards were being reported to the planner as
// government IDs. A longer run is still redacted -- the card detector claims
// it -- so this narrows the label, never the coverage.
export const AADHAAR_REGEX = /(?<!\d[\s-]?)\b([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})\b(?![\s-]?\d)/g;

export function isRepeatedDigit(value: string): boolean {
  return new Set(value.split("")).size === 1;
}

/**
 * Flags Aadhaar-shaped 12-digit government ID numbers. Rejects the
 * all-same-digit case (e.g. "222222222222") to cut an easy false-positive
 * class without adding a network call or external validation service.
 */
export function detectAadhaar(sources: TextSource[]): Detection[] {
  const detections: Detection[] = [];
  for (const source of sources) {
    AADHAAR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AADHAAR_REGEX.exec(source.text)) !== null) {
      const digits = `${match[1]}${match[2]}${match[3]}`;
      if (isRepeatedDigit(digits)) continue;
      detections.push({
        category: "GOVT_ID",
        confidence: 0.85,
        source: source.origin,
        box: source.box,
        reason: "Text matches an Aadhaar-shaped 12-digit number.",
      });
    }
  }
  return detections;
}

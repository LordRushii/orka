import type { Detection } from "../types";
import type { TextSource } from "./textSource";

// Aadhaar numbers are 12 digits, conventionally grouped in 4s, and never
// start with 0 or 1.
export const AADHAAR_REGEX = /\b([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})\b/g;

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

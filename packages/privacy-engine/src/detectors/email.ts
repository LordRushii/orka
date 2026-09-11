import type { Detection } from "../types";
import type { TextSource } from "./textSource";

export const EMAIL_REGEX =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

/**
 * Flags text runs that contain an email-shaped value. The whole source box
 * is redacted (not just the matched substring's estimated slice) because
 * DOM/OCR sources only carry a box for the full run, and over-redacting a
 * label is safer than under-redacting an address.
 */
export function detectEmails(sources: TextSource[]): Detection[] {
  const detections: Detection[] = [];
  for (const source of sources) {
    EMAIL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EMAIL_REGEX.exec(source.text)) !== null) {
      detections.push({
        category: "EMAIL",
        confidence: 0.9,
        source: source.origin,
        box: source.box,
        reason: "Text matches an email address shape.",
      });
    }
  }
  return detections;
}

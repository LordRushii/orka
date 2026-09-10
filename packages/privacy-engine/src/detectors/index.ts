import type { Detection, SafePageSnapshot } from "../types";
import { meetsThreshold } from "../policy";
import { detectAadhaar } from "./aadhaar";
import { detectCardNumbers } from "./card";
import { detectEmails } from "./email";
import { detectPan } from "./pan";
import { detectPasswordFields } from "./password";
import { detectPhoneNumbers } from "./phone";
import type { TextSource } from "./textSource";

export { detectAadhaar } from "./aadhaar";
export { detectCardNumbers } from "./card";
export { detectEmails } from "./email";
export { detectPan } from "./pan";
export { detectPasswordFields } from "./password";
export { detectPhoneNumbers } from "./phone";
export { passesLuhnCheck } from "./luhn";
export type { TextSource } from "./textSource";

/** Runs every deterministic text detector over one set of text sources. */
export function detectTextPii(sources: TextSource[]): Detection[] {
  return [
    ...detectEmails(sources),
    ...detectPhoneNumbers(sources),
    ...detectAadhaar(sources),
    ...detectPan(sources),
    ...detectCardNumbers(sources),
  ];
}

/**
 * Runs every local text/DOM detector against a safe page snapshot: password
 * fields from the element list, and email/phone/govt-id/card patterns from
 * visible text runs and accessible names. Every result is filtered against
 * the shared `DETECTION_POLICY` thresholds before being returned.
 */
export function runDomDetectors(snapshot: SafePageSnapshot): Detection[] {
  const textSources: TextSource[] = [
    ...snapshot.textNodes.map((node) => ({
      id: node.id,
      text: node.text,
      box: node.box,
      origin: "dom" as const,
    })),
    ...snapshot.elements
      .filter((element) => element.accessibleName.trim().length > 0)
      .map((element) => ({
        id: element.id,
        text: element.accessibleName,
        box: element.box,
        origin: "dom" as const,
      })),
  ];

  const detections = [
    ...detectPasswordFields(snapshot.elements),
    ...detectTextPii(textSources),
  ];

  return detections.filter((detection) => meetsThreshold(detection.category, detection.confidence));
}

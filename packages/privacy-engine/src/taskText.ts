import { AADHAAR_REGEX, isRepeatedDigit } from "./detectors/aadhaar";
import { CARD_REGEX } from "./detectors/card";
import { EMAIL_REGEX } from "./detectors/email";
import { passesLuhnCheck } from "./detectors/luhn";
import { PAN_REGEX } from "./detectors/pan";
import { isPlausiblePhoneDigitCount, PHONE_REGEX } from "./detectors/phone";
import { REDACTION_PLACEHOLDERS } from "./redact";

const PASSWORD_LABEL_REGEX = /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/gi;

/**
 * Redacts a free-text task string in place (no boxes involved -- this is
 * the "redacted task text" field of SanitizedObservation per
 * docs/ARCHITECTURE.md). Uses the same deterministic patterns as the DOM/
 * OCR detectors so a user who pastes a password or card number into the
 * task box never has it forwarded to the planner.
 */
export function redactTaskText(task: string): string {
  let result = task;

  result = result.replace(PASSWORD_LABEL_REGEX, REDACTION_PLACEHOLDERS.PASSWORD_FIELD);
  result = result.replace(EMAIL_REGEX, REDACTION_PLACEHOLDERS.EMAIL);

  result = result.replace(CARD_REGEX, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return REDACTION_PLACEHOLDERS.CARD;
  });

  result = result.replace(AADHAAR_REGEX, (match, g1: string, g2: string, g3: string) => {
    const digits = `${g1}${g2}${g3}`;
    return isRepeatedDigit(digits) ? match : REDACTION_PLACEHOLDERS.GOVT_ID;
  });

  result = result.replace(PAN_REGEX, REDACTION_PLACEHOLDERS.GOVT_ID);

  result = result.replace(PHONE_REGEX, (match) =>
    isPlausiblePhoneDigitCount(match) ? REDACTION_PLACEHOLDERS.PHONE : match,
  );

  return result;
}

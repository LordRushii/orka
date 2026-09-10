import type { Detection, SafeElement } from "../types";

const LABEL_HINT_REGEX = /pass ?word|passwd|pwd/i;

/**
 * Flags password fields/labels for redaction. This detector never reads or
 * receives a field's value -- `SafeElement` has no value property -- so an
 * empty password input is redacted exactly the same as a filled one, per
 * the Phase 2 "Password-field tests with empty values" acceptance test.
 */
export function detectPasswordFields(elements: SafeElement[]): Detection[] {
  const detections: Detection[] = [];
  for (const element of elements) {
    const isPasswordType = element.sensitivity?.inputType === "password";
    const labelSuggests =
      element.sensitivity?.labelSuggestsSensitive ??
      LABEL_HINT_REGEX.test(element.accessibleName);

    if (!isPasswordType && !labelSuggests) continue;

    detections.push({
      category: "PASSWORD_FIELD",
      confidence: isPasswordType ? 1 : 0.7,
      source: "dom",
      box: element.box,
      reason: isPasswordType
        ? "Element has input type=password."
        : "Element's accessible name suggests a password field.",
    });
  }
  return detections;
}

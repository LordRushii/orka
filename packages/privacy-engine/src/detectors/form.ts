import type { Detection, SafeElement } from "../types";

/**
 * Redacts sensitive form controls by metadata alone. The snapshot never
 * includes the control value, so empty and filled fields receive identical
 * protection even when OCR cannot read the rendered value.
 */
export function detectSensitiveFormFields(elements: SafeElement[]): Detection[] {
  return elements.flatMap((element) => {
    const inputType = element.sensitivity?.inputType?.toLowerCase();
    const autocomplete = element.sensitivity?.autocomplete?.toLowerCase();
    const label = element.accessibleName.toLowerCase();
    const isEmail = inputType === "email" || autocomplete?.includes("email") || /\bemail\b/.test(label);
    const isPhone = inputType === "tel" || autocomplete?.includes("tel") || /\b(phone|mobile)\b/.test(label);
    const isCard = autocomplete?.includes("cc-") ||
      ["cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc"].includes(inputType ?? "") ||
      /\b(card number|cvv|security code)\b/.test(label);
    const isGovernmentId = /\b(aadhaar|pan|passport|ssn|national id|government id)\b/.test(label);
    const category = isCard ? "CARD" : isGovernmentId ? "GOVT_ID" : isEmail ? "EMAIL" : isPhone ? "PHONE" : undefined;
    if (!category) return [];
    return [{
      category,
      confidence: 0.8,
      source: "dom" as const,
      box: element.box,
      reason: "Form metadata identifies a sensitive input.",
    }];
  });
}

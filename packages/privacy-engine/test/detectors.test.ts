import { describe, expect, test } from "bun:test";
import {
  detectAadhaar,
  detectCardNumbers,
  detectEmails,
  detectPan,
  detectPasswordFields,
  detectPhoneNumbers,
  detectSensitiveFormFields,
  passesLuhnCheck,
  runDomDetectors,
} from "../src/detectors";
import type { SafeElement, SafePageSnapshot, SafeTextNode } from "../src/types";

const BOX = { x: 0, y: 0, width: 100, height: 20 };
const SAMPLE_EMAIL = ["jane.doe", "example.com"].join("@");

function textSource(text: string) {
  return [{ id: "t1", text, box: BOX, origin: "dom" as const }];
}

describe("detectEmails", () => {
  test("flags an email-shaped value", () => {
    const result = detectEmails(textSource(`Contact us at ${SAMPLE_EMAIL}`));
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("EMAIL");
    expect(result[0]?.confidence).toBeGreaterThan(0.5);
  });

  test("ignores text with no email", () => {
    expect(detectEmails(textSource("No contact info here."))).toHaveLength(0);
  });
});

describe("detectPhoneNumbers", () => {
  test("flags an international-shaped phone number", () => {
    const result = detectPhoneNumbers(textSource("Call +1 415-555-0132 now"));
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("PHONE");
  });

  test("ignores short digit runs such as a price", () => {
    expect(detectPhoneNumbers(textSource("Total: 129"))).toHaveLength(0);
  });
});

describe("detectAadhaar", () => {
  test("flags a well-formed Aadhaar-shaped number", () => {
    const result = detectAadhaar(textSource("Aadhaar: 2345 6789 0123"));
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("GOVT_ID");
  });

  test("rejects an all-repeated-digit false positive", () => {
    expect(detectAadhaar(textSource("2222 2222 2222"))).toHaveLength(0);
  });

  test("rejects a number starting with 0 or 1", () => {
    expect(detectAadhaar(textSource("0123 4567 8901"))).toHaveLength(0);
  });
});

describe("detectPan", () => {
  test("flags a PAN-shaped value", () => {
    const result = detectPan(textSource("PAN: ABCDE1234F"));
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("GOVT_ID");
  });

  test("ignores a value with the wrong shape", () => {
    expect(detectPan(textSource("ABCDE12345"))).toHaveLength(0);
  });
});

describe("passesLuhnCheck", () => {
  test("accepts a known-valid test card number", () => {
    expect(passesLuhnCheck("4111111111111111")).toBe(true);
  });

  test("rejects an invalid checksum", () => {
    expect(passesLuhnCheck("4111111111111112")).toBe(false);
  });
});

describe("detectCardNumbers", () => {
  test("flags a Luhn-valid card number with high confidence", () => {
    const result = detectCardNumbers(textSource("Card: 4111 1111 1111 1111"));
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("CARD");
    expect(result[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("still flags a Luhn-invalid but card-shaped number, at lower confidence", () => {
    const result = detectCardNumbers(textSource("Card: 4111 1111 1111 1112"));
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBeLessThan(0.9);
  });

  test("ignores a short digit run", () => {
    expect(detectCardNumbers(textSource("Order #12345"))).toHaveLength(0);
  });
});

describe("detectPasswordFields", () => {
  function passwordElement(overrides: Partial<SafeElement> = {}): SafeElement {
    return {
      id: "pw-1",
      role: "textbox",
      accessibleName: "Password",
      box: BOX,
      capabilities: ["type"],
      sensitivity: { inputType: "password" },
      ...overrides,
    };
  }

  test("flags a type=password field regardless of value", () => {
    const result = detectPasswordFields([passwordElement()]);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("PASSWORD_FIELD");
    expect(result[0]?.confidence).toBe(1);
  });

  test("flags a field whose label suggests a password even without type=password", () => {
    const element = passwordElement({
      accessibleName: "PIN / passwd",
      sensitivity: undefined,
    });
    const result = detectPasswordFields([element]);
    expect(result).toHaveLength(1);
  });

  test("does not flag an unrelated text field", () => {
    const element = passwordElement({
      accessibleName: "Full name",
      sensitivity: { inputType: "text" },
    });
    expect(detectPasswordFields([element])).toHaveLength(0);
  });
});

describe("runDomDetectors", () => {
  test("combines password, email, and phone detections from one snapshot", () => {
    const elements: SafeElement[] = [
      {
        id: "pw",
        role: "textbox",
        accessibleName: "Password",
        box: BOX,
        capabilities: ["type"],
        sensitivity: { inputType: "password" },
      },
    ];
    const textNodes: SafeTextNode[] = [
      { id: "t1", text: `Email us at ${SAMPLE_EMAIL}`, box: BOX },
      { id: "t2", text: "Call +1 415-555-0100", box: BOX },
    ];
    const snapshot: SafePageSnapshot = { elements, textNodes };

    const detections = runDomDetectors(snapshot);
    const categories = detections.map((d) => d.category).sort();
    expect(categories).toEqual(["EMAIL", "PASSWORD_FIELD", "PHONE"]);
  });

  describe("sensitive form fields", () => {
    test("redacts email, phone, card, and government-id controls without reading values", () => {
      const detections = detectSensitiveFormFields([
        { id: "email", role: "textbox", accessibleName: "", box: { x: 0, y: 0, width: 10, height: 10 }, capabilities: ["type"], sensitivity: { inputType: "email" } },
        { id: "phone", role: "textbox", accessibleName: "", box: { x: 0, y: 10, width: 10, height: 10 }, capabilities: ["type"], sensitivity: { autocomplete: "tel" } },
        { id: "card", role: "textbox", accessibleName: "Card number", box: { x: 0, y: 20, width: 10, height: 10 }, capabilities: ["type"] },
        { id: "id", role: "textbox", accessibleName: "Aadhaar number", box: { x: 0, y: 30, width: 10, height: 10 }, capabilities: ["type"] },
      ]);
      expect(detections.map((detection) => detection.category)).toEqual(["EMAIL", "PHONE", "CARD", "GOVT_ID"]);
    });
  });

  test("drops detections below the category confidence threshold", () => {
    const snapshot: SafePageSnapshot = {
      elements: [],
      textNodes: [{ id: "t1", text: "Total due: 12345", box: BOX }],
    };
    expect(runDomDetectors(snapshot)).toHaveLength(0);
  });
});

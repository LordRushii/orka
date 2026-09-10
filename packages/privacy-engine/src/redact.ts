import { intersectionArea } from "./box";
import type {
  AccessibilityNodeInput,
  RasterImage,
  RedactionCategory,
  RedactionMap,
  SafeElement,
} from "./types";

/**
 * Opaque category placeholders. Per phases/02-local-privacy-engine.md this
 * project "never rel[ies] on blur alone" -- every redacted region becomes a
 * solid, non-reversible fill, and every redacted element's accessible name
 * becomes one of these literal labels.
 */
export const REDACTION_PLACEHOLDERS: Record<RedactionCategory, string> = {
  EMAIL: "[EMAIL]",
  PASSWORD_FIELD: "[PASSWORD_FIELD]",
  PHONE: "[PHONE]",
  GOVT_ID: "[GOVT_ID]",
  CARD: "[CARD]",
  FACE: "[FACE]",
  OTHER: "[REDACTED]",
};

/** Solid opaque RGBA fill per category, chosen only to be visually distinct. */
const REDACTION_COLORS: Record<RedactionCategory, [number, number, number, number]> = {
  PASSWORD_FIELD: [17, 17, 17, 255],
  GOVT_ID: [120, 53, 15, 255],
  CARD: [88, 28, 135, 255],
  FACE: [30, 64, 175, 255],
  EMAIL: [7, 89, 133, 255],
  PHONE: [21, 94, 117, 255],
  OTHER: [55, 65, 81, 255],
};

/**
 * Paints every entry in `redactionMap` as a solid opaque rectangle onto a
 * *copy* of `image`; the original bitmap is left untouched so the caller
 * can still keep it in the in-memory `LocalAudit`.
 */
export function redactScreenshot(image: RasterImage, redactionMap: RedactionMap): RasterImage {
  const data = Uint8ClampedArray.from(image.data);
  const redacted: RasterImage = { width: image.width, height: image.height, data };

  for (const entry of redactionMap) {
    const [r, g, b, a] = REDACTION_COLORS[entry.category];
    const x0 = Math.max(0, Math.floor(entry.box.x));
    const y0 = Math.max(0, Math.floor(entry.box.y));
    const x1 = Math.min(image.width, Math.ceil(entry.box.x + entry.box.width));
    const y1 = Math.min(image.height, Math.ceil(entry.box.y + entry.box.height));

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * image.width + x) * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = a;
      }
    }
  }

  return redacted;
}

/**
 * Produces the sanitized accessibility snapshot: any element whose box
 * intersects a redaction entry gets its accessible name replaced by the
 * category's opaque placeholder and `sensitive: true`; every other element
 * passes through unchanged (capabilities/box/role are never PII).
 */
export function redactAccessibilitySnapshot(
  elements: SafeElement[],
  redactionMap: RedactionMap,
): AccessibilityNodeInput[] {
  return elements.map((element) => {
    const hit = redactionMap.find((entry) => intersectionArea(entry.box, element.box) > 0);
    if (!hit) {
      return {
        id: element.id,
        role: element.role,
        accessibleName: element.accessibleName,
        box: element.box,
        capabilities: element.capabilities,
      };
    }
    return {
      id: element.id,
      role: element.role,
      accessibleName: REDACTION_PLACEHOLDERS[hit.category],
      box: element.box,
      capabilities: element.capabilities,
      sensitive: true,
    };
  });
}

export function summarizeRedactions(
  redactionMap: RedactionMap,
): Array<{ category: RedactionCategory; count: number }> {
  const counts = new Map<RedactionCategory, number>();
  for (const entry of redactionMap) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

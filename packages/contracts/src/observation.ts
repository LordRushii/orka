import { z } from "zod";
import { ContractVersionSchema } from "./errors";

/**
 * Broad, opaque redaction categories. These are the only labels a
 * SanitizedObservation may reference; never a raw value, an OCR fragment, or
 * a stable identifier.
 */
export const RedactionCategorySchema = z.enum([
  "EMAIL",
  "PASSWORD_FIELD",
  "PHONE",
  "GOVT_ID",
  "CARD",
  "FACE",
  "OTHER",
]);
export type RedactionCategory = z.infer<typeof RedactionCategorySchema>;

/** A coarse, aggregate count per category. Never a per-instance location map. */
export const RedactionSummaryEntrySchema = z
  .object({
    category: RedactionCategorySchema,
    count: z.number().int().min(0).max(500),
  })
  .strict();
export type RedactionSummaryEntry = z.infer<typeof RedactionSummaryEntrySchema>;

export const BoxSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(0),
    height: z.number().min(0),
  })
  .strict();
export type Box = z.infer<typeof BoxSchema>;

/** Capabilities the executor may be asked to invoke against this element. */
export const ElementCapabilitySchema = z.enum([
  "click",
  "type",
  "select",
  "scroll",
  "navigate",
]);
export type ElementCapability = z.infer<typeof ElementCapabilitySchema>;

/**
 * One visible/interactable element from the sanitized accessibility
 * snapshot. Never carries raw HTML, source, cookies, storage, or field
 * values -- only role/name/geometry needed to plan and to revalidate a
 * target immediately before acting.
 */
export const AccessibilityNodeSchema = z
  .object({
    id: z.string().min(1).max(64),
    role: z.string().min(1).max(64),
    accessibleName: z.string().max(256),
    box: BoxSchema,
    capabilities: z.array(ElementCapabilitySchema).max(8),
    sensitive: z.boolean().optional(),
  })
  .strict();
export type AccessibilityNode = z.infer<typeof AccessibilityNodeSchema>;

/** Summary of a previously approved+executed action, kept for planner context. */
export const PriorActionSummarySchema = z
  .object({
    type: z.string().min(1).max(32),
    summary: z.string().max(280),
    outcome: z.enum(["success", "failure", "skipped"]),
  })
  .strict();
export type PriorActionSummary = z.infer<typeof PriorActionSummarySchema>;

/** A same-origin-only reference (`https://example.com`), never a full URL. */
export const OriginSchema = z
  .string()
  .max(256)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          url.origin === value &&
          (url.protocol === "https:" || url.protocol === "http:")
        );
      } catch {
        return false;
      }
    },
    { message: "urlOrigin must be a bare http(s) origin with no path, query, or fragment" },
  );

const MAX_SCREENSHOT_BASE64_LENGTH = 2_000_000; // ~1.5MB decoded, generous cap for Phase 1

export const SanitizedScreenshotSchema = z
  .object({
    mimeType: z.enum(["image/png", "image/webp"]),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    dataBase64: z.string().min(1).max(MAX_SCREENSHOT_BASE64_LENGTH),
  })
  .strict();
export type SanitizedScreenshot = z.infer<typeof SanitizedScreenshotSchema>;

/**
 * The only page context ever eligible for planner transmission. This shape
 * is intentionally closed (`.strict()`): raw DOM, cookies, storage, OCR
 * text, API keys, and detailed redaction maps have no field to occupy, and
 * any attempt to add one is rejected rather than silently dropped.
 */
export const SanitizedObservationSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    taskId: z.string().min(1).max(64),
    task: z.string().min(1).max(2000),
    urlOrigin: OriginSchema,
    /**
     * Present on a vision round only (Phase 6.5). A snapshot-decidable round
     * carries no pixels at all: the observation is the redacted accessibility
     * snapshot, and the planner answers from element names alone. No field is
     * weakened by its absence -- there is simply nothing captured to redact.
     */
    screenshot: SanitizedScreenshotSchema.optional(),
    accessibilitySnapshot: z.array(AccessibilityNodeSchema).max(500),
    redactionSummary: z.array(RedactionSummaryEntrySchema).max(50),
    priorActions: z.array(PriorActionSummarySchema).max(10),
  })
  .strict();
export type SanitizedObservation = z.infer<typeof SanitizedObservationSchema>;

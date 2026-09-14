import { z } from "zod";
import { ActionPlanSchema } from "./action-plan";
import { ContractVersionSchema } from "./errors";
import { SanitizedObservationSchema } from "./observation";

/**
 * The gateway's provider allowlist. A request naming anything outside this
 * set is rejected before any adapter is constructed, and the gateway never
 * substitutes a different id than the one the user selected -- that is what
 * keeps a local-provider outage from silently becoming a cloud call
 * (SECURITY-PRIVACY.md, "Do not auto-fallback from local to cloud").
 */
export const PROVIDER_IDS = [
  "mock",
  "lmstudio",
  "deepseek",
  "openai-compatible",
  "anthropic",
] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Provider ids that reach the public internet. */
export const CLOUD_PROVIDER_IDS: readonly ProviderId[] = [
  "deepseek",
  "openai-compatible",
  "anthropic",
];

/**
 * A *reference* to a provider profile, not the profile itself: an allowlisted
 * id plus an optional model name. Endpoints and credentials live in gateway
 * environment configuration and are never accepted over the wire, so a
 * compromised extension page cannot redirect a request or exfiltrate a key.
 */
export const ProviderProfileRefSchema = z
  .object({
    providerId: ProviderIdSchema,
    model: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ProviderProfileRef = z.infer<typeof ProviderProfileRefSchema>;

/** Request body for `POST /v1/plan`. */
export const PlanRequestSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    provider: ProviderProfileRefSchema,
    observation: SanitizedObservationSchema,
  })
  .strict();
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

/**
 * Safe response metadata. Deliberately excludes prompts, provider responses,
 * token counts tied to content, keys, and anything derived from page text.
 */
export const PlanMetadataSchema = z
  .object({
    providerId: ProviderIdSchema,
    model: z.string().min(1).max(128),
    latencyMs: z.number().int().min(0),
  })
  .strict();
export type PlanMetadata = z.infer<typeof PlanMetadataSchema>;

export const PlanResponseSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    plan: ActionPlanSchema,
    meta: PlanMetadataSchema,
  })
  .strict();
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

/**
 * One entry in `GET /v1/providers`. `isCloud` exists so the side panel can
 * label a choice as leaving the machine before the user makes it, rather than
 * after.
 */
export const ProviderDescriptorSchema = z
  .object({
    id: ProviderIdSchema,
    defaultModel: z.string().min(1).max(128),
    isCloud: z.boolean(),
  })
  .strict();
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

export const ProviderListResponseSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    providers: z.array(ProviderDescriptorSchema).max(PROVIDER_IDS.length),
  })
  .strict();
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

/**
 * Field names that must never appear anywhere in a gateway request body, at
 * any depth. `.strict()` schemas already reject unknown keys; this is the
 * second, independent gate required by phases/03-planner-and-providers.md
 * ("rejects raw screenshot fields, raw DOM fields, cookies, storage,
 * credentials..."), and it produces a clear typed refusal rather than a
 * generic validation error.
 *
 * Compared case-insensitively after stripping `_` and `-`.
 */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = [
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "csrftoken",
  "detections",
  "dom",
  "domsnapshot",
  "html",
  "indexeddb",
  "innerhtml",
  "innertext",
  "localstorage",
  "ocrtext",
  "originalscreenshot",
  "outerhtml",
  "password",
  "rawdom",
  "rawscreenshot",
  "redactionmap",
  "secret",
  "sessionstorage",
  "sourcehtml",
  "textcontent",
  "token",
];

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

const MAX_SCAN_DEPTH = 12;

/**
 * Walks a parsed JSON body and returns the first forbidden key found, or
 * `null`. Runs before schema validation so a body carrying a cookie jar is
 * refused even if the rest of it happens to be well formed.
 */
export function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenKey(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_REQUEST_KEYS.includes(normalizeKey(key))) return key;
    const found = findForbiddenKey(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

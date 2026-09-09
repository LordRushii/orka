import { z } from "zod";

/**
 * Stable contract version for the payloads exchanged between the extension
 * and the gateway. Bump this when a breaking schema change ships.
 */
export const CONTRACT_VERSION = "v1" as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export type ContractVersion = z.infer<typeof ContractVersionSchema>;

/**
 * Safe, non-identifying error codes. Messages paired with these codes must
 * never embed request bodies, page content, keys, or stack traces.
 */
export const ErrorCodeSchema = z.enum([
  "INVALID_OBSERVATION",
  "INVALID_ACTION_PLAN",
  "CONTRACT_VERSION_MISMATCH",
  "PAYLOAD_TOO_LARGE",
  "MALFORMED_JSON",
  "NOT_FOUND",
  "SANITIZATION_FAILED",
  "PROVIDER_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * The only error shape any Orka HTTP surface may return. `message` is a
 * short, human-safe description; it must never contain PII or raw payloads.
 */
export const SafeErrorSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string().min(1).max(280),
    }),
  })
  .strict();
export type SafeError = z.infer<typeof SafeErrorSchema>;

export function safeError(code: ErrorCode, message: string): SafeError {
  return { error: { code, message } };
}

/**
 * Reasons the local Privacy Engine (Phase 2) refuses to produce a
 * SanitizedObservation. The extension must fail closed on every one of
 * these: no gateway call happens after a SanitizationFailure.
 */
export const SanitizationFailureCodeSchema = z.enum([
  "CAPTURE_FAILED",
  "RESTRICTED_PAGE",
  "DETECTOR_TIMEOUT",
  "DETECTOR_ERROR",
  "MODEL_LOAD_FAILED",
  "MERGE_FAILED",
  "POLICY_BELOW_THRESHOLD",
  "UNKNOWN",
]);
export type SanitizationFailureCode = z.infer<
  typeof SanitizationFailureCodeSchema
>;

export const SanitizationFailureSchema = z
  .object({
    ok: z.literal(false),
    code: SanitizationFailureCodeSchema,
    message: z.string().min(1).max(280),
  })
  .strict();
export type SanitizationFailure = z.infer<typeof SanitizationFailureSchema>;

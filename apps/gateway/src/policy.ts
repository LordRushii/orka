import {
  CONTRACT_VERSION,
  findForbiddenKey,
  PlanRequestSchema,
  safeError,
  type PlanRequest,
  type SafeError,
} from "@orka/contracts";

/**
 * Gateway-level image ceiling, independent of the contract's own base64 cap.
 * A redacted WebP viewport capture is tens to low hundreds of kilobytes; a
 * megabyte of base64 means something upstream sent a full-resolution or
 * unencoded frame, which is refused rather than forwarded to a provider.
 */
export const MAX_SCREENSHOT_BASE64_CHARS = 1_400_000;

/** Explicit JSON body limit. Comfortably above a valid observation. */
export const JSON_BODY_LIMIT_BYTES = 3 * 1024 * 1024;

export type PolicyResult =
  | { ok: true; request: PlanRequest }
  | { ok: false; status: number; body: SafeError };

function reject(status: number, body: SafeError): PolicyResult {
  return { ok: false, status, body };
}

/**
 * The single gate every `/v1/plan` body passes through before a provider is
 * selected. Order matters and is deliberate:
 *
 * 1. Forbidden field names, at any depth -- catches cookies, storage, raw DOM,
 *    credentials, and audit-only fields even inside an otherwise valid body.
 * 2. Contract version -- a mismatch is reported as itself, not as a generic
 *    validation failure, so a stale extension gets an actionable error.
 * 3. Full schema validation -- closed objects, so unknown keys are rejected
 *    rather than silently dropped.
 * 4. Image size -- checked after parsing, when the field is known to exist.
 *
 * Every rejection is a typed SafeError that echoes no part of the request.
 */
export function applyRequestPolicy(body: unknown): PolicyResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reject(400, safeError("INVALID_OBSERVATION", "Request body must be a JSON object."));
  }

  const forbidden = findForbiddenKey(body);
  if (forbidden) {
    return reject(
      400,
      safeError(
        "FORBIDDEN_FIELD",
        `Request contains a field Orka never accepts: "${forbidden}".`,
      ),
    );
  }

  const version = (body as { contractVersion?: unknown }).contractVersion;
  if (version !== CONTRACT_VERSION) {
    return reject(
      400,
      safeError(
        "CONTRACT_VERSION_MISMATCH",
        `This gateway speaks contract ${CONTRACT_VERSION}.`,
      ),
    );
  }

  const parsed = PlanRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "request";
    return reject(
      400,
      safeError("INVALID_OBSERVATION", `Observation failed contract validation at "${where}".`),
    );
  }

  // A snapshot-only round (Phase 6.5) sends no image, so there is no size to
  // check -- and its absence is a smaller payload, not a rejected one.
  const screenshot = parsed.data.observation.screenshot;
  if (screenshot && screenshot.dataBase64.length > MAX_SCREENSHOT_BASE64_CHARS) {
    return reject(
      413,
      safeError("PAYLOAD_TOO_LARGE", "The sanitized screenshot exceeds the gateway image limit."),
    );
  }

  return { ok: true, request: parsed.data };
}

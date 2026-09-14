import {
  CONTRACT_VERSION,
  PlanRequestSchema,
  PlanResponseSchema,
  ProviderListResponseSchema,
  SafeErrorSchema,
  type ActionPlan,
  type ErrorCode,
  type PlanMetadata,
  type ProviderDescriptor,
  type SanitizedObservation,
} from "@orka/contracts";
import type { PlannerSettings } from "./settings.ts";

/**
 * Transport-level failures the gateway never gets to describe, plus the
 * gateway's own `ErrorCode` set. Kept as one union so the side panel renders a
 * single failure shape whether the request died in the browser or at the
 * gateway.
 */
export type PlannerFailureCode = ErrorCode | "GATEWAY_UNREACHABLE" | "ABORTED";

export type PlannerFailure = {
  ok: false;
  code: PlannerFailureCode;
  message: string;
};

export type PlannerSuccess = {
  ok: true;
  plan: ActionPlan;
  meta: PlanMetadata;
};

export type PlannerResult = PlannerSuccess | PlannerFailure;

function failure(code: PlannerFailureCode, message: string): PlannerFailure {
  return { ok: false, code, message };
}

/**
 * Turns a non-2xx response into a displayable failure. The gateway promises a
 * `SafeError`, but a proxy or a wrong URL can return anything, so an
 * unparseable body degrades to the status code rather than being shown raw --
 * an HTML error page must never reach the side panel as "the reason".
 */
async function readErrorBody(response: Response): Promise<PlannerFailure> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure(
      "PROVIDER_ERROR",
      `The gateway returned HTTP ${response.status}.`,
    );
  }
  const parsed = SafeErrorSchema.safeParse(body);
  if (!parsed.success) {
    return failure(
      "PROVIDER_ERROR",
      `The gateway returned HTTP ${response.status}.`,
    );
  }
  return failure(parsed.data.error.code, parsed.data.error.message);
}

export type PlannerRequestOptions = {
  settings: PlannerSettings;
  observation: SanitizedObservation;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
};

/**
 * The extension's only outbound network call.
 *
 * Everything it sends is built here from the `SanitizedObservation` the
 * Privacy Engine produced -- there is no path from the raw capture, the local
 * audit, or page storage into this request. The request is validated against
 * `PlanRequestSchema` before it leaves the browser so a bug upstream fails
 * locally instead of putting an unexpected field on the wire.
 */
export async function requestPlan(
  options: PlannerRequestOptions,
): Promise<PlannerResult> {
  const { settings, observation, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = {
    contractVersion: CONTRACT_VERSION,
    provider: settings.model
      ? { providerId: settings.providerId, model: settings.model }
      : { providerId: settings.providerId },
    observation,
  };
  const validated = PlanRequestSchema.safeParse(request);
  if (!validated.success) {
    return failure(
      "INVALID_OBSERVATION",
      "The sanitized observation did not match the gateway contract.",
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(`${settings.gatewayUrl}/v1/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.gatewayToken}`,
      },
      body: JSON.stringify(validated.data),
      signal,
      // The gateway is a first-party service reached with a bearer token;
      // browser-managed cookies must never ride along on this request.
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    if (signal.aborted) {
      return failure("ABORTED", "The Task Session ended before the plan arrived.");
    }
    return failure(
      "GATEWAY_UNREACHABLE",
      `Could not reach the Orka gateway at ${settings.gatewayUrl}.`,
    );
  }

  if (!response.ok) return readErrorBody(response);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("PROVIDER_ERROR", "The gateway response was not valid JSON.");
  }

  const parsed = PlanResponseSchema.safeParse(body);
  if (!parsed.success) {
    return failure(
      "INVALID_ACTION_PLAN",
      "The gateway returned a plan that does not match the contract.",
    );
  }
  // The gateway already checks this. Re-checking here means a confused or
  // compromised gateway cannot get a plan bound to one Task Session applied to
  // a different one -- a plan is only ever valid for the page it was made for.
  if (parsed.data.plan.taskId !== observation.taskId) {
    return failure(
      "INVALID_ACTION_PLAN",
      "The plan does not belong to this Task Session.",
    );
  }

  return { ok: true, plan: parsed.data.plan, meta: parsed.data.meta };
}

export type GatewayCheck =
  | { ok: true; providers: ProviderDescriptor[] }
  | { ok: false; message: string };

/**
 * Confirms the gateway is reachable and the token is accepted, and reports
 * which providers it has configured. Used by the side panel's "Check gateway"
 * button so a misconfiguration surfaces before a capture is taken rather than
 * after the page has already been screenshotted.
 */
export async function checkGateway(
  settings: PlannerSettings,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${settings.gatewayUrl}/v1/providers`, {
      method: "GET",
      headers: { authorization: `Bearer ${settings.gatewayToken}` },
      signal,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return {
      ok: false,
      message: `Could not reach the Orka gateway at ${settings.gatewayUrl}.`,
    };
  }

  if (!response.ok) {
    const error = await readErrorBody(response);
    return { ok: false, message: error.message };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: "The gateway response was not valid JSON." };
  }

  const parsed = ProviderListResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: "That endpoint is not an Orka gateway." };
  }
  return { ok: true, providers: [...parsed.data.providers] };
}

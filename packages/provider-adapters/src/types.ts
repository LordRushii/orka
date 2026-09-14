import type {
  ActionPlan,
  ProviderId,
  SanitizedObservation,
} from "@orka/contracts";

/**
 * Everything an adapter is allowed to see. It is exactly one already-sanitized
 * observation plus the user's model selection -- no raw capture, no audit, no
 * gateway policy state, and no way to reach back into the extension.
 */
export type PlannerInput = {
  readonly observation: SanitizedObservation;
  /** User-selected model id; falls back to the adapter's configured default. */
  readonly model?: string;
};

/** Why an adapter could not produce a plan. Maps 1:1 onto gateway ErrorCodes. */
export type ProviderFailureCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_ACTION_PLAN";

export type ProviderSuccess = {
  readonly ok: true;
  readonly plan: ActionPlan;
  readonly model: string;
};

export type ProviderFailure = {
  readonly ok: false;
  readonly code: ProviderFailureCode;
  /** Short, safe text. Never a prompt, response body, key, or page content. */
  readonly message: string;
};

export type ProviderResult = ProviderSuccess | ProviderFailure;

export type ProviderHealth = {
  readonly ok: boolean;
  readonly message: string;
};

/**
 * The provider seam from phases/03-planner-and-providers.md. The adapter owns
 * authentication, request shape, image encoding, tool/schema differences, and
 * response parsing; the gateway owns policy and contract validation.
 */
export type ProviderAdapter = {
  readonly id: ProviderId;
  /** Model used when `PlannerInput.model` is absent. */
  readonly defaultModel: string;
  /** True when calls leave the machine; drives the no-silent-cloud rule. */
  readonly isCloud: boolean;
  plan(input: PlannerInput, signal: AbortSignal): Promise<ProviderResult>;
  health(signal: AbortSignal): Promise<ProviderHealth>;
};

export function providerFailure(
  code: ProviderFailureCode,
  message: string,
): ProviderFailure {
  return { ok: false, code, message };
}

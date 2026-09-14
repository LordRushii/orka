import type { FastifyInstance } from "fastify";
import {
  ActionPlanSchema,
  CONTRACT_VERSION,
  safeError,
  type ErrorCode,
  type PlanResponse,
} from "@orka/contracts";
import type { ProviderFailureCode, ProviderRegistry } from "@orka/provider-adapters";
import { applyRequestPolicy } from "../policy";
import { isAuthorized } from "../auth";

export type PlanRouteOptions = {
  registry: ProviderRegistry;
  token: string;
  planTimeoutMs: number;
};

/** Provider failures are upstream problems, never the caller's fault. */
const PROVIDER_STATUS: Record<ProviderFailureCode, { status: number; code: ErrorCode }> = {
  PROVIDER_UNAVAILABLE: { status: 502, code: "PROVIDER_UNAVAILABLE" },
  PROVIDER_TIMEOUT: { status: 504, code: "PROVIDER_TIMEOUT" },
  PROVIDER_ERROR: { status: 502, code: "PROVIDER_ERROR" },
  INVALID_ACTION_PLAN: { status: 502, code: "INVALID_ACTION_PLAN" },
};

/**
 * `POST /v1/plan` — the gateway's only planning endpoint.
 *
 * The route owns policy and contract validation; the adapter owns everything
 * provider-shaped. It is stateless by construction: nothing here writes a
 * database, a screenshot store, an analytics event, or a prompt log, and the
 * only things that outlive the request are the numbers in `meta`.
 */
export async function registerPlanRoute(app: FastifyInstance, options: PlanRouteOptions) {
  app.post("/v1/plan", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.token)) {
      // No detail: "missing header" and "wrong token" must look identical.
      return reply
        .status(401)
        .send(safeError("UNAUTHORIZED", "A valid gateway session token is required."));
    }

    const policy = applyRequestPolicy(request.body);
    if (!policy.ok) {
      return reply.status(policy.status).send(policy.body);
    }

    let held: typeof policy.request | null = policy.request;
    const { provider, observation } = held;

    const resolved = options.registry.resolve(provider.providerId);
    if (!resolved.ok) {
      // Deliberately terminal. Falling back to another configured provider here
      // would silently move a user's data to an endpoint they did not choose.
      return reply.status(400).send(safeError("UNKNOWN_PROVIDER", resolved.message));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.planTimeoutMs);
    // A client that hangs up should not leave a provider call running.
    //
    // The signal has to be the *reply* stream closing, not `request.raw`:
    // once a POST body has been fully received, `request.raw` emits "close"
    // immediately -- before this handler's first await -- so listening there
    // aborts every request instead of only abandoned ones. `writableEnded`
    // distinguishes "the client went away" from "we finished replying".
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once("close", onClose);

    const startedAt = Date.now();
    try {
      const result = await resolved.adapter.plan(
        { observation, model: provider.model },
        controller.signal,
      );

      if (!result.ok) {
        const mapped = PROVIDER_STATUS[result.code];
        request.log.warn(
          { requestId: request.id, providerId: provider.providerId, code: result.code },
          "provider_failed",
        );
        return reply.status(mapped.status).send(safeError(mapped.code, result.message));
      }

      // Re-validate independently of the adapter. An adapter is the least
      // trusted code in this process -- it parses text a remote model wrote --
      // so its output is re-checked against the contract before the executor
      // is ever allowed to see it.
      const validated = ActionPlanSchema.safeParse(result.plan);
      if (!validated.success) {
        return reply
          .status(502)
          .send(safeError("INVALID_ACTION_PLAN", "The planner returned a plan Orka cannot validate."));
      }
      if (validated.data.taskId !== observation.taskId) {
        return reply
          .status(502)
          .send(safeError("INVALID_ACTION_PLAN", "The planner answered a different Task Session."));
      }

      const response: PlanResponse = {
        contractVersion: CONTRACT_VERSION,
        plan: validated.data,
        meta: {
          providerId: resolved.adapter.id,
          model: result.model,
          latencyMs: Date.now() - startedAt,
        },
      };
      return reply.status(200).send(response);
    } catch (error) {
      request.log.error(
        { requestId: request.id, providerId: provider.providerId, name: (error as Error)?.name },
        "plan_failed",
      );
      return reply
        .status(500)
        .send(safeError("INTERNAL_ERROR", "The gateway could not complete the planning request."));
    } finally {
      clearTimeout(timer);
      reply.raw.removeListener("close", onClose);
      // Releases the route's handle on the parsed body once the reply is
      // serialized. The substantive guarantee is upstream of this line -- no
      // module state, no body logging, no store -- but dropping the reference
      // keeps the screenshot from being pinned by a retained closure.
      held = null;
      void held;
    }
  });
}

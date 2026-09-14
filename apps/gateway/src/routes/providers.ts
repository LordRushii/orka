import type { FastifyInstance } from "fastify";
import {
  CONTRACT_VERSION,
  safeError,
  type ProviderListResponse,
} from "@orka/contracts";
import type { ProviderRegistry } from "@orka/provider-adapters";
import { isAuthorized } from "../auth";

export type ProvidersRouteOptions = {
  registry: ProviderRegistry;
  token: string;
};

/**
 * `GET /v1/providers` — which planner profiles this gateway can actually
 * serve, so the side panel offers real choices instead of a hardcoded list.
 *
 * Authenticated, because the enabled set reveals which credentials the
 * operator configured. It reports ids and default model names only: never an
 * endpoint, never a key, never a key fingerprint.
 */
export async function registerProvidersRoute(
  app: FastifyInstance,
  options: ProvidersRouteOptions,
) {
  app.get("/v1/providers", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.token)) {
      return reply
        .status(401)
        .send(safeError("UNAUTHORIZED", "A valid gateway session token is required."));
    }

    const response: ProviderListResponse = {
      contractVersion: CONTRACT_VERSION,
      providers: options.registry.available().map((id) => {
        const resolved = options.registry.resolve(id);
        // `available()` only lists ids the registry built, so this is total.
        const adapter = resolved.ok ? resolved.adapter : null;
        return {
          id,
          defaultModel: adapter?.defaultModel ?? "unknown",
          isCloud: adapter?.isCloud ?? true,
        };
      }),
    };
    return reply.status(200).send(response);
  });
}

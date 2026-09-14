import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { safeError } from "@orka/contracts";
import { createProviderRegistry } from "@orka/provider-adapters";
import { loadConfig, type GatewayConfig } from "./config";
import { JSON_BODY_LIMIT_BYTES } from "./policy";
import { registerHealthRoute } from "./routes/health";
import { registerPlanRoute } from "./routes/plan";
import { registerProvidersRoute } from "./routes/providers";

export type BuildServerOptions = {
  config?: GatewayConfig;
};

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const registry = createProviderRegistry(config.registry);

  const app = Fastify({
    // Pino's default serializers never include req.body/res.body, so request
    // and response payloads are never written to logs.
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    // A per-request id for correlating log lines. Random rather than
    // incrementing so it carries no traffic-volume signal.
    genReqId: () => crypto.randomUUID(),
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 413) {
      reply
        .status(413)
        .send(safeError("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."));
      return;
    }
    // Fastify tags body/content-type parsing failures with FST_ERR_CTP_*
    // and a 400 statusCode; treat all of them as malformed JSON.
    if (error.statusCode === 400) {
      reply
        .status(400)
        .send(safeError("MALFORMED_JSON", "Request body is not valid JSON."));
      return;
    }
    request.log.error({ code: error.code, statusCode: error.statusCode }, "unhandled_error");
    reply
      .status(500)
      .send(safeError("INTERNAL_ERROR", "Unexpected server error."));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(safeError("NOT_FOUND", "Not found."));
  });

  // `/health` stays unauthenticated and therefore stays contentless: it must
  // not tell an unauthenticated caller which providers or keys this gateway
  // has. The provider list lives behind the bearer token instead.
  app.register(registerHealthRoute);
  app.register(async (instance) => {
    await registerProvidersRoute(instance, { registry, token: config.token });
    await registerPlanRoute(instance, {
      registry,
      token: config.token,
      planTimeoutMs: config.planTimeoutMs,
    });
  });

  return app;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const config = loadConfig();
  const app = buildServer({ config });
  app
    .listen({ port, host })
    .then(() => {
      app.log.info(`Orka gateway listening on http://${host}:${port}`);
      app.log.info(`Providers enabled: ${config.registry.enabled.join(", ")}`);
      if (config.usingDevToken) {
        app.log.warn(
          "ORKA_GATEWAY_TOKEN is unset; using the development token. Set it before exposing this gateway.",
        );
      }
    })
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { safeError } from "@orka/contracts";
import { registerHealthRoute } from "./routes/health";

// Generous now; Phase 3 tightens this once real observation payloads
// (sanitized screenshot + snapshot) are being sent.
const JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

export function buildServer(): FastifyInstance {
  const app = Fastify({
    // Pino's default serializers never include req.body/res.body, so
    // request/response payloads are never written to logs.
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: JSON_BODY_LIMIT_BYTES,
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

  app.register(registerHealthRoute);

  return app;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = buildServer();
  app
    .listen({ port, host })
    .then(() => {
      app.log.info(`Orka gateway listening on http://${host}:${port}`);
    })
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

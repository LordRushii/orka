import type { FastifyInstance } from "fastify";
import { CONTRACT_VERSION } from "@orka/contracts";

/**
 * GET /health — the only endpoint in Phase 1. Returns a fixed, minimal body
 * so it never leaks environment, version skew, or request metadata.
 */
export async function registerHealthRoute(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok", contractVersion: CONTRACT_VERSION };
  });
}

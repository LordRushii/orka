import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, SafeErrorSchema } from "@orka/contracts";
import { buildServer } from "../src/server";

describe("GET /health", () => {
  test("returns only status and contractVersion", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toEqual({
      status: "ok",
      contractVersion: CONTRACT_VERSION,
    });
    await app.close();
  });
});

describe("malformed JSON", () => {
  test("a request body that is not valid JSON never crashes the server", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/health",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    const body = SafeErrorSchema.parse(response.json());
    expect(body.error.message).not.toContain("{not valid json");
    await app.close();
  });

  test("an unknown route returns a safe typed 404", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(response.statusCode).toBe(404);
    const body = SafeErrorSchema.parse(response.json());
    expect(body.error.code).toBe("NOT_FOUND");
    await app.close();
  });
});

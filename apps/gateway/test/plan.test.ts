import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  PlanResponseSchema,
  ProviderListResponseSchema,
  SafeErrorSchema,
  type ErrorCode,
  type PlanRequest,
  type SanitizedObservation,
} from "@orka/contracts";
import { buildServer } from "../src/server";
import type { GatewayConfig } from "../src/config";
import { MAX_SCREENSHOT_BASE64_CHARS } from "../src/policy";

const TOKEN = "test-gateway-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REDACTED_IMAGE_B64 = "UkVEQUNURURfUElYRUxT";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    token: TOKEN,
    usingDevToken: false,
    planTimeoutMs: 30_000,
    registry: { enabled: ["mock"] },
    ...overrides,
  };
}

function observation(overrides: Partial<SanitizedObservation> = {}): SanitizedObservation {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: "task-gateway",
    task: "Find the pricing page and summarize the plans.",
    urlOrigin: "https://example.com",
    screenshot: {
      mimeType: "image/png",
      width: 1280,
      height: 720,
      dataBase64: REDACTED_IMAGE_B64,
    },
    accessibilitySnapshot: [
      {
        id: "n1",
        role: "link",
        accessibleName: "Pricing",
        box: { x: 120, y: 40, width: 64, height: 20 },
        capabilities: ["click"],
      },
    ],
    redactionSummary: [{ category: "CARD", count: 1 }],
    priorActions: [],
    ...overrides,
  };
}

/** `model` names a mock fixture, so a test drives a real planner scenario. */
function planRequest(fixture = "valid-plan", overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    contractVersion: CONTRACT_VERSION,
    provider: { providerId: "mock", model: fixture },
    observation: observation(),
    ...overrides,
  };
}

async function withServer<T>(
  gatewayConfig: GatewayConfig,
  run: (app: ReturnType<typeof buildServer>) => Promise<T>,
): Promise<T> {
  const app = buildServer({ config: gatewayConfig });
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe("POST /v1/plan: authentication", () => {
  test("a missing token is rejected before any body handling", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        payload: planRequest(),
      });
      expect(response.statusCode).toBe(401);
      const body = SafeErrorSchema.parse(response.json());
      expect(body.error.code).toBe("UNAUTHORIZED");
    });
  });

  test("a wrong token is indistinguishable from a missing one", async () => {
    await withServer(config(), async (app) => {
      const missing = await app.inject({ method: "POST", url: "/v1/plan", payload: planRequest() });
      const wrong = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: { authorization: "Bearer not-the-token" },
        payload: planRequest(),
      });
      expect(wrong.statusCode).toBe(missing.statusCode);
      expect(wrong.json()).toEqual(missing.json());
    });
  });

  test("a forbidden body is still rejected as unauthorized without the token", async () => {
    // Auth runs first, so an unauthenticated caller learns nothing about which
    // fields the gateway does or does not accept.
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        payload: { ...planRequest(), cookies: "session=abc" },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  test("the bearer scheme is matched case-insensitively", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: { authorization: `bearer ${TOKEN}` },
        payload: planRequest(),
      });
      expect(response.statusCode).toBe(200);
    });
  });
});

describe("POST /v1/plan: request policy", () => {
  test("a valid request returns a contract-valid plan bound to the same task", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest(),
      });
      expect(response.statusCode).toBe(200);
      const body = PlanResponseSchema.parse(response.json());
      expect(body.plan.taskId).toBe("task-gateway");
      expect(body.meta.providerId).toBe("mock");
      expect(body.meta.model).toBe("valid-plan");
      expect(body.meta.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  test("response metadata carries no prompt, page text, or provider payload", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest(),
      });
      const meta = (response.json() as Record<string, Record<string, unknown>>).meta!;
      expect(Object.keys(meta).sort()).toEqual(["latencyMs", "model", "providerId"]);
      expect(JSON.stringify(response.json())).not.toContain(REDACTED_IMAGE_B64);
    });
  });

  const forbidden: { field: string; payload: Record<string, unknown> }[] = [
    { field: "cookies", payload: { cookies: "session=abc" } },
    { field: "localStorage", payload: { localStorage: { token: "abc" } } },
    { field: "rawScreenshot", payload: { rawScreenshot: "data:image/png;base64,AAAA" } },
    { field: "domSnapshot", payload: { domSnapshot: "<html></html>" } },
    { field: "apiKey", payload: { apiKey: "sk-live-123" } },
    { field: "redactionMap", payload: { redactionMap: [] } },
    { field: "ocrText", payload: { ocrText: "4111 1111 1111 1111" } },
    { field: "originalScreenshot", payload: { originalScreenshot: "AAAA" } },
  ];

  for (const { field, payload } of forbidden) {
    test(`rejects a top-level "${field}" field`, async () => {
      await withServer(config(), async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/plan",
          headers: AUTH,
          payload: { ...planRequest(), ...payload },
        });
        expect(response.statusCode).toBe(400);
        const body = SafeErrorSchema.parse(response.json());
        expect(body.error.code).toBe("FORBIDDEN_FIELD");
        expect(JSON.stringify(body)).not.toContain("4111");
        expect(JSON.stringify(body)).not.toContain("sk-live-123");
      });
    });
  }

  test("a forbidden field nested deep inside the observation is still caught", async () => {
    await withServer(config(), async (app) => {
      const nested = planRequest();
      const payload = {
        ...nested,
        observation: {
          ...nested.observation,
          accessibilitySnapshot: [
            { ...nested.observation.accessibilitySnapshot[0], innerHTML: "<b>hi</b>" },
          ],
        },
      };
      const response = await app.inject({ method: "POST", url: "/v1/plan", headers: AUTH, payload });
      expect(response.statusCode).toBe(400);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("FORBIDDEN_FIELD");
    });
  });

  test("an unknown extra key is rejected by the closed schema", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: { ...planRequest(), extra: "surprise" },
      });
      expect(response.statusCode).toBe(400);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("INVALID_OBSERVATION");
    });
  });

  test("a contract version mismatch is reported as itself", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: { ...planRequest(), contractVersion: "v0" },
      });
      expect(response.statusCode).toBe(400);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("CONTRACT_VERSION_MISMATCH");
    });
  });

  test("a URL with a path instead of a bare origin is refused", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest("valid-plan", {
          observation: observation({ urlOrigin: "https://example.com/account?token=secret" }),
        }),
      });
      expect(response.statusCode).toBe(400);
      const body = SafeErrorSchema.parse(response.json());
      expect(body.error.code).toBe("INVALID_OBSERVATION");
      // The failing path is named; the offending value never is.
      expect(body.error.message).toContain("urlOrigin");
      expect(body.error.message).not.toContain("token=secret");
    });
  });

  test("an oversized screenshot is refused with 413, not forwarded", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest("valid-plan", {
          observation: observation({
            screenshot: {
              mimeType: "image/png",
              width: 1280,
              height: 720,
              dataBase64: "A".repeat(MAX_SCREENSHOT_BASE64_CHARS + 1),
            },
          }),
        }),
      });
      expect(response.statusCode).toBe(413);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  test("a body past the transport limit is refused as 413 without crashing", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: `{"blob":"${"A".repeat(4 * 1024 * 1024)}"}`,
      });
      expect(response.statusCode).toBe(413);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  test("malformed JSON is a safe 400, and the body is not echoed", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: '{"contractVersion": "v1", broken',
      });
      expect(response.statusCode).toBe(400);
      const body = SafeErrorSchema.parse(response.json());
      expect(body.error.code).toBe("MALFORMED_JSON");
      expect(JSON.stringify(body)).not.toContain("broken");
    });
  });
});

describe("POST /v1/plan: provider selection never substitutes", () => {
  test("a provider the gateway does not have is a terminal 400", async () => {
    await withServer(config({ registry: { enabled: ["mock"] } }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest("valid-plan", {
          provider: { providerId: "deepseek" },
        }),
      });
      expect(response.statusCode).toBe(400);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("UNKNOWN_PROVIDER");
    });
  });

  test("a local provider outage is reported as an outage, not served by a cloud provider", async () => {
    // Both are enabled; the local one cannot be reached. A fallback would show
    // up here as a 200 from deepseek.
    const gateway = config({
      registry: {
        enabled: ["lmstudio", "deepseek"],
        deepseek: { apiKey: "ds-key" },
        fetchImpl: async (url: string) => {
          if (url.startsWith("http://127.0.0.1")) throw new TypeError("ECONNREFUSED");
          throw new Error("the cloud provider must not be called");
        },
      },
    });
    await withServer(gateway, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest("valid-plan", { provider: { providerId: "lmstudio" } }),
      });
      expect(response.statusCode).toBe(502);
      const body = SafeErrorSchema.parse(response.json());
      expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(body.error.message).toContain("LM Studio");
    });
  });
});

describe("POST /v1/plan: provider failures map to safe statuses", () => {
  const cases: { fixture: string; status: number; code: ErrorCode }[] = [
    { fixture: "prose-only", status: 502, code: "INVALID_ACTION_PLAN" },
    { fixture: "malformed-json", status: 502, code: "INVALID_ACTION_PLAN" },
    { fixture: "unknown-action", status: 502, code: "INVALID_ACTION_PLAN" },
    { fixture: "missing-target", status: 502, code: "INVALID_ACTION_PLAN" },
    { fixture: "javascript-url", status: 502, code: "INVALID_ACTION_PLAN" },
    { fixture: "too-many-actions", status: 502, code: "INVALID_ACTION_PLAN" },
  ];

  for (const { fixture, status, code } of cases) {
    test(`"${fixture}" yields ${status} ${code}`, async () => {
      await withServer(config(), async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/plan",
          headers: AUTH,
          payload: planRequest(fixture),
        });
        expect(response.statusCode).toBe(status);
        expect(SafeErrorSchema.parse(response.json()).error.code).toBe(code);
      });
    });
  }

  test("a provider that never answers is cut off at the configured timeout", async () => {
    const gateway = config({
      planTimeoutMs: 1_000,
      registry: { enabled: ["mock"], mock: { delayMs: 60_000 } },
    });
    await withServer(gateway, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest(),
      });
      expect(response.statusCode).toBe(504);
      expect(SafeErrorSchema.parse(response.json()).error.code).toBe("PROVIDER_TIMEOUT");
    });
  });

  test("a provider outage is 502 and names no endpoint", async () => {
    const gateway = config({
      registry: {
        enabled: ["mock"],
        mock: { failWith: { code: "PROVIDER_UNAVAILABLE", message: "Planner is offline." } },
      },
    });
    await withServer(gateway, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest(),
      });
      expect(response.statusCode).toBe(502);
      const body = SafeErrorSchema.parse(response.json());
      expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(body.error.message).not.toContain("http");
    });
  });

  test("a schema-valid but policy-unsafe plan is returned for the user to judge", async () => {
    // The gateway is not the approval gate; the user is. Silently dropping a
    // high-risk action would hide it from the person who has to approve it.
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest("unsafe-action"),
      });
      expect(response.statusCode).toBe(200);
      const body = PlanResponseSchema.parse(response.json());
      expect(body.plan.actions[0]?.risk).toBe("high");
    });
  });

  test("a refusal to obey injected page text is returned as an ask_user plan", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plan",
        headers: AUTH,
        payload: planRequest("injection-refusal"),
      });
      expect(response.statusCode).toBe(200);
      const body = PlanResponseSchema.parse(response.json());
      expect(body.plan.actions[0]?.type).toBe("ask_user");
    });
  });
});

describe("POST /v1/plan: over a real socket, not just inject", () => {
  // `app.inject()` never opens a TCP connection, so it cannot reproduce a
  // subtle disconnect-handling bug: on this runtime `request.raw` emits "close"
  // as soon as a POST body is fully received -- before the handler's first
  // await -- so a naive "abort on request close" aborts *every* real request
  // while every injected test still passes. These tests bind a real port.
  async function listen(gatewayConfig: GatewayConfig): Promise<{ app: ReturnType<typeof buildServer>; url: string }> {
    const app = buildServer({ config: gatewayConfig });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no bound port");
    return { app, url: `http://127.0.0.1:${address.port}` };
  }

  test("a normal request whose provider takes real time still returns 200", async () => {
    // The provider takes 150ms, like any network call. The body-close must not
    // be mistaken for a client hang-up.
    const { app, url } = await listen(config({ registry: { enabled: ["mock"], mock: { delayMs: 150 } } }));
    try {
      const response = await fetch(`${url}/v1/plan`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(planRequest()),
      });
      expect(response.status).toBe(200);
      const body = PlanResponseSchema.parse(await response.json());
      expect(body.plan.taskId).toBe("task-gateway");
    } finally {
      await app.close();
    }
  });

  test("a client that hangs up mid-plan still aborts the provider call", async () => {
    // The other half of the same guarantee: dropping the bogus abort must not
    // disable the real one. The provider would take 5s; the client leaves at
    // ~150ms, and the mock reports the abort as a timeout.
    const { app, url } = await listen(config({ registry: { enabled: ["mock"], mock: { delayMs: 5_000 } } }));
    try {
      const controller = new AbortController();
      const pending = fetch(`${url}/v1/plan`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(planRequest()),
        signal: controller.signal,
      }).then(() => "resolved").catch((error: Error) => `aborted:${error.name}`);
      setTimeout(() => controller.abort(), 150);
      expect(await pending).toBe("aborted:AbortError");
      // Let the server observe the socket close and unwind before teardown.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/providers", () => {  test("requires the gateway token", async () => {
    await withServer(config(), async (app) => {
      const response = await app.inject({ method: "GET", url: "/v1/providers" });
      expect(response.statusCode).toBe(401);
    });
  });

  test("lists enabled providers with no endpoint or credential detail", async () => {
    const gateway = config({
      registry: { enabled: ["mock", "deepseek"], deepseek: { apiKey: "ds-secret-key" } },
    });
    await withServer(gateway, async (app) => {
      const response = await app.inject({ method: "GET", url: "/v1/providers", headers: AUTH });
      expect(response.statusCode).toBe(200);
      const body = ProviderListResponseSchema.parse(response.json());
      expect(body.providers.map((entry) => entry.id).sort()).toEqual(["deepseek", "mock"]);
      expect(body.providers.find((entry) => entry.id === "deepseek")?.isCloud).toBe(true);
      expect(body.providers.find((entry) => entry.id === "mock")?.isCloud).toBe(false);

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("ds-secret-key");
      expect(serialized).not.toContain("api.deepseek.com");
      expect(serialized).not.toContain("127.0.0.1");
    });
  });

  test("the unauthenticated health endpoint reveals nothing about providers", async () => {
    await withServer(config({ registry: { enabled: ["mock"] } }), async (app) => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.json() as unknown).toEqual({
        status: "ok",
        contractVersion: CONTRACT_VERSION,
      });
    });
  });
});

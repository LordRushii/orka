import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  findForbiddenKey,
  safeError,
  type PlanResponse,
  type SanitizedObservation,
} from "@orka/contracts";
import { checkGateway, requestPlan } from "../shared/plannerClient.ts";
import { DEFAULT_PLANNER_SETTINGS, type PlannerSettings } from "../shared/settings.ts";

const REDACTED_IMAGE_B64 = "UkVEQUNURURfUElYRUxT";
const TASK_ID = "task-client";
const live = new AbortController().signal;

function settings(overrides: Partial<PlannerSettings> = {}): PlannerSettings {
  return { ...DEFAULT_PLANNER_SETTINGS, gatewayToken: "session-token", ...overrides };
}

function observation(overrides: Partial<SanitizedObservation> = {}): SanitizedObservation {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK_ID,
    task: "Find the pricing page.",
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

function planResponse(taskId = TASK_ID): PlanResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    plan: {
      contractVersion: CONTRACT_VERSION,
      taskId,
      actions: [
        { type: "done", reason: "Pricing is already visible.", risk: "low", summary: "Nothing to do." },
      ],
    },
    meta: { providerId: "mock", model: "valid-plan", latencyMs: 12 },
  };
}

type Recorded = { url: string; init: RequestInit };

function recording(respond: () => Response) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestPlan: what actually goes on the wire", () => {
  test("posts the sanitized observation to /v1/plan with the token in a header", async () => {
    const { calls, fetchImpl } = recording(() => json(planResponse()));
    const result = await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: live,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8787/v1/plan");
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer session-token");
    // Browser-managed cookies must never ride along on the planner request.
    expect(call.init.credentials).toBe("omit");
    expect(call.init.referrerPolicy).toBe("no-referrer");
    expect(call.init.cache).toBe("no-store");
  });

  test("the body carries the redacted image once and no raw artifact of any kind", async () => {
    const { calls, fetchImpl } = recording(() => json(planResponse()));
    await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: live,
      fetchImpl,
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["contractVersion", "observation", "provider"]);
    expect(findForbiddenKey(body)).toBeNull();

    const serialized = JSON.stringify(body);
    expect(serialized.split(REDACTED_IMAGE_B64).length - 1).toBe(1);
    expect(serialized).not.toContain("session-token");
    expect(serialized).not.toContain("redactionMap");
    expect(serialized).not.toContain("originalScreenshot");
  });

  test("an empty model override is omitted so the gateway uses its configured default", async () => {
    const { calls, fetchImpl } = recording(() => json(planResponse()));
    await requestPlan({ settings: settings(), observation: observation(), signal: live, fetchImpl });
    const provider = (JSON.parse(String(calls[0]!.init.body)) as { provider: Record<string, unknown> }).provider;
    expect(provider).toEqual({ providerId: "lmstudio" });

    const withModel = recording(() => json(planResponse()));
    await requestPlan({
      settings: settings({ providerId: "lmstudio", model: "qwen3-vl-4b-instruct" }),
      observation: observation(),
      signal: live,
      fetchImpl: withModel.fetchImpl,
    });
    const chosen = (JSON.parse(String(withModel.calls[0]!.init.body)) as { provider: Record<string, unknown> }).provider;
    expect(chosen).toEqual({ providerId: "lmstudio", model: "qwen3-vl-4b-instruct" });
  });

  test("an observation that fails the contract never reaches the network", async () => {
    const { calls, fetchImpl } = recording(() => json(planResponse()));
    const result = await requestPlan({
      settings: settings(),
      // A full page URL where the contract requires a bare origin: the kind of
      // upstream bug that must fail in the browser, not at the gateway.
      observation: observation({ urlOrigin: "https://example.com/account?token=secret" }),
      signal: live,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_OBSERVATION");
    expect(calls).toHaveLength(0);
  });
});

describe("requestPlan: failures stay typed and quiet", () => {
  test("a gateway SafeError is surfaced with its own code and message", async () => {
    const { fetchImpl } = recording(() =>
      json(safeError("PROVIDER_UNAVAILABLE", "LM Studio is not reachable."), 502),
    );
    const result = await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: live,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    expect(result.message).toBe("LM Studio is not reachable.");
  });

  test("an HTML error page from a proxy is reduced to its status, never rendered", async () => {
    const { fetchImpl } = recording(
      () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    );
    const result = await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: live,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("502");
    expect(result.message).not.toContain("<html>");
  });

  test("an unreachable gateway is distinguishable from a cancelled session", async () => {
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const unreachable = await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: live,
      fetchImpl: down,
    });
    expect(unreachable.ok).toBe(false);
    if (unreachable.ok) return;
    expect(unreachable.code).toBe("GATEWAY_UNREACHABLE");

    const controller = new AbortController();
    controller.abort();
    const aborted = await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: controller.signal,
      fetchImpl: down,
    });
    expect(aborted.ok).toBe(false);
    if (aborted.ok) return;
    expect(aborted.code).toBe("ABORTED");
  });

  test("a plan for a different Task Session is refused", async () => {
    // The gateway checks this too. Re-checking here means a confused gateway
    // cannot get a plan built for one page applied to another.
    const { fetchImpl } = recording(() => json(planResponse("someone-elses-task")));
    const result = await requestPlan({
      settings: settings(),
      observation: observation(),
      signal: live,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_ACTION_PLAN");
  });

  test("a 200 that is not a contract-valid plan is refused", async () => {
    for (const body of [{ plan: { actions: [] } }, "not json at all", { ok: true }]) {
      const { fetchImpl } = recording(() =>
        typeof body === "string"
          ? new Response(body, { status: 200 })
          : json(body),
      );
      const result = await requestPlan({
        settings: settings(),
        observation: observation(),
        signal: live,
        fetchImpl,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe("checkGateway", () => {
  test("reports the providers a reachable gateway has enabled", async () => {
    const { calls, fetchImpl } = recording(() =>
      json({
        contractVersion: CONTRACT_VERSION,
        providers: [{ id: "mock", defaultModel: "valid-plan", isCloud: false }],
      }),
    );
    const result = await checkGateway(settings(), live, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.providers.map((entry) => entry.id)).toEqual(["mock"]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/v1/providers");
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("a rejected token is reported as the gateway described it", async () => {
    const { fetchImpl } = recording(() =>
      json(safeError("UNAUTHORIZED", "Missing or invalid gateway token."), 401),
    );
    const result = await checkGateway(settings(), live, fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("token");
  });

  test("some other JSON service at that URL is not mistaken for a gateway", async () => {
    const { fetchImpl } = recording(() => json({ hello: "world" }));
    const result = await checkGateway(settings(), live, fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("not an Orka gateway");
  });
});

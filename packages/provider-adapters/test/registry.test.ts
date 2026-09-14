import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS } from "@orka/contracts";
import { createProviderRegistry, MOCK_FIXTURES, ProviderConfigError } from "../src/index";
import { chatCompletion, observation, recordingFetch } from "./fixture";

const live = new AbortController().signal;

describe("provider registry: the allowlist is the whole mechanism", () => {
  test("only enabled providers resolve", () => {
    const registry = createProviderRegistry({ enabled: ["mock"] });
    expect(registry.available()).toEqual(["mock"]);
    expect(registry.resolve("mock").ok).toBe(true);
  });

  test("a disabled provider is UNKNOWN_PROVIDER, never a substitute adapter", () => {
    const registry = createProviderRegistry({ enabled: ["mock"] });
    for (const id of PROVIDER_IDS) {
      const result = registry.resolve(id);
      if (id === "mock") {
        expect(result.ok).toBe(true);
        continue;
      }
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("UNKNOWN_PROVIDER");
    }
  });

  test("resolve returns the adapter for exactly the id asked for", () => {
    const registry = createProviderRegistry({
      enabled: ["mock", "lmstudio", "deepseek"],
      deepseek: { apiKey: "ds-key" },
    });
    for (const id of ["mock", "lmstudio", "deepseek"] as const) {
      const result = registry.resolve(id);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.adapter.id).toBe(id);
    }
  });
});

describe("no automatic local-to-cloud fallback", () => {
  test("a local outage surfaces as a local failure even when a cloud provider is enabled", async () => {
    // Both providers are configured and healthy on the cloud side. The local
    // one fails. If any fallback existed, this is where it would fire.
    const cloud = recordingFetch([() => chatCompletion(MOCK_FIXTURES["valid-plan"])]);
    const registry = createProviderRegistry({
      enabled: ["lmstudio", "deepseek"],
      deepseek: { apiKey: "ds-key" },
      fetchImpl: async (url, init) => {
        if (url.startsWith("http://127.0.0.1")) throw new TypeError("ECONNREFUSED");
        return cloud.fetchImpl(url, init);
      },
    });

    const resolved = registry.resolve("lmstudio");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = await resolved.adapter.plan({ observation: observation() }, live);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    expect(result.message).toContain("LM Studio");
    // Nothing was sent to the cloud provider.
    expect(cloud.calls).toHaveLength(0);
  });

  test("a cloud provider that is not enabled cannot be reached at all", () => {
    const registry = createProviderRegistry({ enabled: ["lmstudio"] });
    const result = registry.resolve("deepseek");
    expect(result.ok).toBe(false);
  });
});

describe("misconfiguration fails at boot, not mid-task", () => {
  test("enabling a cloud provider without a key throws while building the registry", () => {
    expect(() => createProviderRegistry({ enabled: ["deepseek"] })).toThrow(ProviderConfigError);
    expect(() => createProviderRegistry({ enabled: ["anthropic"] })).toThrow(ProviderConfigError);
    expect(() => createProviderRegistry({ enabled: ["openai-compatible"] }))
      .toThrow(ProviderConfigError);
  });

  test("enabling LM Studio with a remote base URL throws while building the registry", () => {
    expect(() =>
      createProviderRegistry({
        enabled: ["lmstudio"],
        lmstudio: { baseUrl: "https://not-local.example.com/v1" },
      })
    ).toThrow();
  });
});

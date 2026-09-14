import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLANNER_SETTINGS,
  GatewayUrlError,
  loadPlannerSettings,
  normalizeGatewayUrl,
  parsePlannerSettings,
  PLANNER_SETTINGS_KEY,
  savePlannerSettings,
  validatePlannerSettings,
} from "../shared/settings.ts";

/** A stand-in for `browser.storage.local`, so no WebExtension global is needed. */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  return {
    store,
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
  };
}

describe("gateway URL transport rule", () => {
  test("plain http is accepted only on loopback", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(normalizeGatewayUrl(`http://${host}:8787`)).toBe(`http://${host}:8787`);
    }
  });

  test("plain http to a remote host is refused, so a typo cannot put the image in the clear", () => {
    expect(() => normalizeGatewayUrl("http://gateway.example.com")).toThrow(GatewayUrlError);
    // A host that merely *looks* local is still remote.
    expect(() => normalizeGatewayUrl("http://127.0.0.1.evil.example")).toThrow(GatewayUrlError);
  });

  test("https is accepted for a remote gateway", () => {
    expect(normalizeGatewayUrl("https://gateway.example.com")).toBe("https://gateway.example.com");
  });

  test("only http and https are transports at all", () => {
    for (const value of ["ftp://host/x", "file:///c:/gateway", "javascript:alert(1)", "ws://127.0.0.1:8787"]) {
      expect(() => normalizeGatewayUrl(value)).toThrow(GatewayUrlError);
    }
  });

  test("path, query and fragment are dropped to the bare origin", () => {
    expect(normalizeGatewayUrl("  http://127.0.0.1:8787/v1/plan?token=secret#x  "))
      .toBe("http://127.0.0.1:8787");
  });

  test("an unparseable value is a typed error, not a crash", () => {
    expect(() => normalizeGatewayUrl("127.0.0.1:8787")).toThrow(GatewayUrlError);
    expect(() => normalizeGatewayUrl("")).toThrow(GatewayUrlError);
  });
});

describe("planner settings", () => {
  test("a fresh install defaults to the in-process mock over loopback", () => {
    expect(DEFAULT_PLANNER_SETTINGS.providerId).toBe("mock");
    expect(normalizeGatewayUrl(DEFAULT_PLANNER_SETTINGS.gatewayUrl))
      .toBe(DEFAULT_PLANNER_SETTINGS.gatewayUrl);
  });

  test("corrupt or hostile stored settings fall back to defaults instead of throwing", () => {
    for (const value of [undefined, null, 42, "{}", { providerId: "not-a-provider" }]) {
      expect(parsePlannerSettings(value)).toEqual(DEFAULT_PLANNER_SETTINGS);
    }
    // A stored http:// remote gateway is rejected on read, not only on write.
    expect(
      parsePlannerSettings({
        ...DEFAULT_PLANNER_SETTINGS,
        gatewayUrl: "http://gateway.example.com",
      }),
    ).toEqual(DEFAULT_PLANNER_SETTINGS);
  });

  test("an extra stored key is rejected by the closed schema", () => {
    expect(parsePlannerSettings({ ...DEFAULT_PLANNER_SETTINGS, apiKey: "sk-live-1" }))
      .toEqual(DEFAULT_PLANNER_SETTINGS);
  });

  test("validation normalizes the URL and trims the token and model", () => {
    const settings = validatePlannerSettings({
      gatewayUrl: "https://gateway.example.com/v1/",
      gatewayToken: "  tok  ",
      providerId: "lmstudio",
      model: "  qwen3-vl-4b-instruct  ",
    });
    expect(settings).toEqual({
      gatewayUrl: "https://gateway.example.com",
      gatewayToken: "tok",
      providerId: "lmstudio",
      model: "qwen3-vl-4b-instruct",
    });
  });

  test("a save/load round-trip stores a gateway token and nothing resembling a provider key", async () => {
    const storage = fakeStorage();
    const saved = await savePlannerSettings(
      {
        gatewayUrl: "http://localhost:8787/anything",
        gatewayToken: "session-token",
        providerId: "deepseek",
        model: "",
      },
      storage,
    );
    expect(saved.gatewayUrl).toBe("http://localhost:8787");
    expect(await loadPlannerSettings(storage)).toEqual(saved);

    // Provider credentials live in the gateway environment; the browser holds
    // only the session token, so the stored blob has exactly four fields.
    const stored = storage.store[PLANNER_SETTINGS_KEY] as Record<string, unknown>;
    expect(Object.keys(stored).sort())
      .toEqual(["gatewayToken", "gatewayUrl", "model", "providerId"]);
  });

  test("saving a remote http gateway is refused before anything is written", async () => {
    const storage = fakeStorage();
    await expect(
      savePlannerSettings(
        { ...DEFAULT_PLANNER_SETTINGS, gatewayUrl: "http://gateway.example.com" },
        storage,
      ),
    ).rejects.toThrow(GatewayUrlError);
    expect(storage.store[PLANNER_SETTINGS_KEY]).toBeUndefined();
  });

  test("a storage failure degrades to defaults rather than blocking a task", async () => {
    const broken = {
      async get() {
        throw new Error("storage unavailable");
      },
      async set() {},
    };
    expect(await loadPlannerSettings(broken)).toEqual(DEFAULT_PLANNER_SETTINGS);
  });
});

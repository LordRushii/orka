import { describe, expect, test } from "bun:test";
import { selectRuntime } from "../src/runtime";

describe("selectRuntime", () => {
  test("selects webgpu when the adapter exists and warm-up passes quickly", async () => {
    const profile = await selectRuntime({
      probeWebGpu: () => true,
      requestAdapter: () => true,
      warmUp: async () => {},
    });
    expect(profile.mode).toBe("webgpu");
    expect(profile.override).toBe("auto");
  });

  test("falls back to wasm when WebGPU itself is missing", async () => {
    const profile = await selectRuntime({ probeWebGpu: () => false });
    expect(profile.mode).toBe("wasm");
    expect(profile.reason).toMatch(/not available/i);
  });

  test("falls back to wasm when no adapter can be requested", async () => {
    const profile = await selectRuntime({
      probeWebGpu: () => true,
      requestAdapter: () => false,
    });
    expect(profile.mode).toBe("wasm");
    expect(profile.reason).toMatch(/adapter/i);
  });

  test("falls back to balanced when warm-up exceeds its timeout", async () => {
    const profile = await selectRuntime({
      probeWebGpu: () => true,
      requestAdapter: () => true,
      warmUp: () => new Promise(() => {}), // never resolves
      warmUpTimeoutMs: 20,
    });
    expect(profile.mode).toBe("balanced");
    expect(profile.reason).toMatch(/timed out|failed/i);
  });

  test("falls back to balanced when warm-up throws", async () => {
    const profile = await selectRuntime({
      probeWebGpu: () => true,
      requestAdapter: () => true,
      warmUp: async () => {
        throw new Error("warm-up failed");
      },
    });
    expect(profile.mode).toBe("balanced");
  });

  test("a wasm override always wins, without probing anything", async () => {
    const profile = await selectRuntime({
      override: "wasm",
      probeWebGpu: () => {
        throw new Error("should never be called");
      },
    });
    expect(profile.mode).toBe("wasm");
    expect(profile.override).toBe("wasm");
  });

  test("a balanced override always wins, without probing anything", async () => {
    const profile = await selectRuntime({ override: "balanced" });
    expect(profile.mode).toBe("balanced");
    expect(profile.override).toBe("balanced");
  });

  test("a throwing capability probe is treated as unsupported, not a crash", async () => {
    const profile = await selectRuntime({
      probeWebGpu: () => {
        throw new Error("navigator.gpu is not defined");
      },
    });
    expect(profile.mode).toBe("wasm");
  });
});

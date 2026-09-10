import type { RuntimeOverride, RuntimeProfile } from "./types";

export type SelectRuntimeOptions = {
  /** User-facing override from the side panel: Auto, GPU preferred, Balanced, CPU/WASM. */
  override?: RuntimeOverride;
  /** Resolves true when `navigator.gpu` (or equivalent) exists. */
  probeWebGpu?: () => Promise<boolean> | boolean;
  /** Resolves true when a WebGPU adapter can actually be requested. */
  requestAdapter?: () => Promise<boolean> | boolean;
  /** Runs a tiny local inference to confirm WebGPU is fast enough to use. */
  warmUp?: () => Promise<void>;
  warmUpTimeoutMs?: number;
};

const DEFAULT_WARM_UP_TIMEOUT_MS = 1500;

async function resolveBoolean(
  probe: (() => Promise<boolean> | boolean) | undefined,
): Promise<boolean> {
  if (!probe) return false;
  try {
    return await probe();
  } catch {
    // A throwing probe is treated as "not available" -- never crash startup
    // because of a hardware capability check.
    return false;
  }
}

async function warmUpWithinBudget(
  warmUp: (() => Promise<void>) | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!warmUp) return false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const run = (async () => {
    try {
      await warmUp();
      return true;
    } catch {
      return false;
    }
  })();
  const result = await Promise.race([run, timeout]);
  clearTimeout(timer!);
  return result;
}

/**
 * Chooses `webgpu`, `balanced`, or `wasm` per docs/ARCHITECTURE.md "Hardware
 * adaptivity": Auto/GPU-preferred test WebGPU support and run a local
 * warm-up before ever selecting it; Balanced and CPU/WASM are explicit
 * overrides that skip probing entirely. This function never reads exact
 * VRAM/RAM/vendor data -- only pass/fail capability + timing signals.
 */
export async function selectRuntime(options: SelectRuntimeOptions = {}): Promise<RuntimeProfile> {
  const override = options.override ?? "auto";

  if (override === "wasm") {
    return { mode: "wasm", override, reason: "User override forced CPU/WASM." };
  }
  if (override === "balanced") {
    return { mode: "balanced", override, reason: "User override forced Balanced." };
  }

  const hasWebGpu = await resolveBoolean(options.probeWebGpu);
  if (!hasWebGpu) {
    return { mode: "wasm", override, reason: "WebGPU is not available in this browser." };
  }

  const hasAdapter = await resolveBoolean(options.requestAdapter);
  if (!hasAdapter) {
    return { mode: "wasm", override, reason: "No WebGPU adapter could be requested." };
  }

  const timeoutMs = options.warmUpTimeoutMs ?? DEFAULT_WARM_UP_TIMEOUT_MS;
  const warmUpOk = await warmUpWithinBudget(options.warmUp, timeoutMs);
  if (!warmUpOk) {
    return {
      mode: "balanced",
      override,
      reason: "WebGPU warm-up timed out or failed; falling back to Balanced.",
    };
  }

  return { mode: "webgpu", override, reason: "WebGPU is available and passed warm-up." };
}

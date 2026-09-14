import { ProviderIdSchema, type ProviderId } from "@orka/contracts";
import { z } from "zod";

/**
 * Where the planner leg of a Task Session sends its sanitized observation.
 *
 * The token is a gateway *session* token, not a provider key: provider
 * credentials live in the gateway's environment and never enter the browser,
 * so a compromised extension page cannot leak a DeepSeek or Anthropic key.
 */
export type PlannerSettings = {
  gatewayUrl: string;
  gatewayToken: string;
  providerId: ProviderId;
  /** Empty string means "use the adapter's configured default model". */
  model: string;
};

export const PLANNER_SETTINGS_KEY = "orka.planner.settings";

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  gatewayUrl: "http://127.0.0.1:8787",
  gatewayToken: "orka-dev-token",
  // The deterministic in-process adapter: a fresh install can complete a full
  // task round-trip with no key, no local model, and no outbound request.
  providerId: "mock",
  model: "",
};

export class GatewayUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUrlError";
  }
}

/**
 * Enforces SECURITY-PRIVACY.md's transport rule: HTTPS for any remote gateway,
 * plaintext HTTP only for a loopback development gateway. Without this, a
 * typo'd `http://` host would put the sanitized screenshot on the wire in the
 * clear -- which is precisely the failure the whole redaction pipeline exists
 * to prevent.
 */
export function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new GatewayUrlError("Enter a full gateway URL, for example http://127.0.0.1:8787.");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new GatewayUrlError("A remote gateway must use https://. Plain http:// is only allowed on localhost.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayUrlError("The gateway URL must use http:// or https://.");
  }
  // Path, query, and fragment are dropped: the endpoints are fixed by contract.
  return url.origin;
}

const PlannerSettingsSchema = z
  .object({
    gatewayUrl: z.string().min(1).max(256),
    gatewayToken: z.string().max(512),
    providerId: ProviderIdSchema,
    model: z.string().max(128),
  })
  .strict();

/** Parses stored settings, falling back to defaults rather than throwing. */
export function parsePlannerSettings(value: unknown): PlannerSettings {
  const parsed = PlannerSettingsSchema.safeParse(value);
  if (!parsed.success) return { ...DEFAULT_PLANNER_SETTINGS };
  try {
    return { ...parsed.data, gatewayUrl: normalizeGatewayUrl(parsed.data.gatewayUrl) };
  } catch {
    return { ...DEFAULT_PLANNER_SETTINGS };
  }
}

/** Validates a user-entered settings form, normalizing the URL. */
export function validatePlannerSettings(value: unknown): PlannerSettings {
  const parsed = PlannerSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayUrlError("Planner settings are incomplete.");
  }
  return {
    gatewayUrl: normalizeGatewayUrl(parsed.data.gatewayUrl),
    gatewayToken: parsed.data.gatewayToken.trim(),
    providerId: parsed.data.providerId,
    model: parsed.data.model.trim(),
  };
}

type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

function area(): StorageArea {
  return browser.storage.local as unknown as StorageArea;
}

export async function loadPlannerSettings(storage: StorageArea = area()): Promise<PlannerSettings> {
  try {
    const stored = await storage.get(PLANNER_SETTINGS_KEY);
    return parsePlannerSettings(stored?.[PLANNER_SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_PLANNER_SETTINGS };
  }
}

export async function savePlannerSettings(
  settings: PlannerSettings,
  storage: StorageArea = area(),
): Promise<PlannerSettings> {
  const validated = validatePlannerSettings(settings);
  await storage.set({ [PLANNER_SETTINGS_KEY]: validated });
  return validated;
}

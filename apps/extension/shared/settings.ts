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
  /**
   * Opt-in messaging (Phase 9), off by default. When on, the planner may draft
   * a message and propose sending it; a human still confirms every send on the
   * rendered draft. Purely local intent -- it rides to the gateway as a boolean
   * on the observation, never as message content.
   */
  allowDraftingMessages: boolean;
};

export const PLANNER_SETTINGS_KEY = "orka.planner.settings";

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  gatewayUrl: "http://127.0.0.1:8787",
  gatewayToken: "orka-dev-token",
  // The user's own loopback LM Studio server: no key required, and nothing
  // ever leaves the machine unless the operator switches to a cloud provider.
  providerId: "lmstudio",
  model: "",
  // Drafting a message is a deliberate choice, never a default.
  allowDraftingMessages: false,
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
    // `.default(false)` so settings stored before Phase 9 (no such key) still
    // parse cleanly and simply adopt the off default, rather than being thrown
    // out and losing the user's gateway configuration.
    allowDraftingMessages: z.boolean().default(false),
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
    allowDraftingMessages: parsed.data.allowDraftingMessages,
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
  settings: Omit<PlannerSettings, "allowDraftingMessages"> & { allowDraftingMessages?: boolean },
  storage: StorageArea = area(),
): Promise<PlannerSettings> {
  const validated = validatePlannerSettings(settings);
  await storage.set({ [PLANNER_SETTINGS_KEY]: validated });
  return validated;
}

import { PROVIDER_IDS, type ProviderId } from "@orka/contracts";
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_DEFAULT_MODEL,
  type ProviderRegistryConfig,
} from "@orka/provider-adapters";

/** Dev-only fallback token. Production boot refuses to start without a real one. */
export const DEV_GATEWAY_TOKEN = "orka-dev-token";

export type GatewayConfig = {
  token: string;
  usingDevToken: boolean;
  planTimeoutMs: number;
  registry: ProviderRegistryConfig;
};

type Env = Record<string, string | undefined>;

function trimmed(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseEnabled(env: Env): ProviderId[] {
  const raw = trimmed(env, "ORKA_ENABLED_PROVIDERS");
  if (!raw) {
    // Default to what can run with no credentials at all: the deterministic
    // mock and the user's own loopback LM Studio server. Cloud providers are
    // opt-in, so a fresh gateway cannot make an outbound call by accident.
    return ["mock", "lmstudio"];
  }
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unknown = ids.filter((id) => !(PROVIDER_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new Error(`ORKA_ENABLED_PROVIDERS contains unknown provider(s): ${unknown.join(", ")}`);
  }
  return ids as ProviderId[];
}

function parseTimeout(env: Env): number {
  const raw = trimmed(env, "ORKA_PLAN_TIMEOUT_MS");
  if (!raw) return 30_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1000 || value > 120_000) {
    throw new Error("ORKA_PLAN_TIMEOUT_MS must be a number between 1000 and 120000.");
  }
  return Math.floor(value);
}

function resolveToken(env: Env): { token: string; usingDevToken: boolean } {
  const configured = trimmed(env, "ORKA_GATEWAY_TOKEN");
  if (configured) return { token: configured, usingDevToken: false };
  if (env.NODE_ENV === "production") {
    throw new Error("ORKA_GATEWAY_TOKEN is required when NODE_ENV=production.");
  }
  return { token: DEV_GATEWAY_TOKEN, usingDevToken: true };
}

/**
 * Builds gateway configuration from the environment.
 *
 * Credentials and endpoints are read here and nowhere else; nothing in a
 * request body can name an endpoint or supply a key, so a request can only
 * select among profiles the operator already configured.
 */
export function loadConfig(env: Env = process.env): GatewayConfig {
  const { token, usingDevToken } = resolveToken(env);
  const enabled = parseEnabled(env);

  const registry: ProviderRegistryConfig = {
    enabled,
    mock: {},
    lmstudio: {
      baseUrl: trimmed(env, "ORKA_LMSTUDIO_BASE_URL") ?? LMSTUDIO_DEFAULT_BASE_URL,
      defaultModel: trimmed(env, "ORKA_LMSTUDIO_MODEL") ?? LMSTUDIO_DEFAULT_MODEL,
    },
  };

  const deepseekKey = trimmed(env, "DEEPSEEK_API_KEY");
  if (deepseekKey) {
    registry.deepseek = {
      apiKey: deepseekKey,
      baseUrl: trimmed(env, "DEEPSEEK_BASE_URL") ?? DEEPSEEK_DEFAULT_BASE_URL,
      defaultModel: trimmed(env, "DEEPSEEK_MODEL") ?? DEEPSEEK_DEFAULT_MODEL,
    };
  }

  const openAiKey = trimmed(env, "OPENAI_API_KEY");
  const openAiBase = trimmed(env, "OPENAI_BASE_URL");
  const openAiModel = trimmed(env, "OPENAI_MODEL");
  if (openAiKey && openAiBase && openAiModel) {
    registry.openaiCompatible = {
      apiKey: openAiKey,
      baseUrl: openAiBase,
      defaultModel: openAiModel,
    };
  }

  const anthropicKey = trimmed(env, "ANTHROPIC_API_KEY");
  if (anthropicKey) {
    registry.anthropic = {
      apiKey: anthropicKey,
      baseUrl: trimmed(env, "ANTHROPIC_BASE_URL"),
      defaultModel: trimmed(env, "ANTHROPIC_MODEL"),
    };
  }

  return { token, usingDevToken, planTimeoutMs: parseTimeout(env), registry };
}

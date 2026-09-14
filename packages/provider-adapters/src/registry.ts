import type { ProviderId } from "@orka/contracts";
import { createAnthropicAdapter } from "./anthropic";
import { createDeepSeekAdapter } from "./deepseek";
import type { FetchLike } from "./http";
import { createLmStudioAdapter } from "./lmstudio";
import { createMockAdapter, type MockAdapterOptions } from "./mock";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import type { ProviderAdapter } from "./types";

export type ProviderRegistryConfig = {
  /** Only these ids can ever be resolved. */
  enabled: readonly ProviderId[];
  fetchImpl?: FetchLike;
  mock?: MockAdapterOptions;
  lmstudio?: { baseUrl?: string; defaultModel?: string };
  deepseek?: { apiKey: string; baseUrl?: string; defaultModel?: string };
  openaiCompatible?: { apiKey: string; baseUrl: string; defaultModel: string };
  anthropic?: { apiKey: string; baseUrl?: string; defaultModel?: string };
};

export type ResolveResult =
  | { ok: true; adapter: ProviderAdapter }
  | { ok: false; code: "UNKNOWN_PROVIDER"; message: string };

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

function build(
  id: ProviderId,
  config: ProviderRegistryConfig,
): ProviderAdapter {
  switch (id) {
    case "mock":
      return createMockAdapter(config.mock);
    case "lmstudio":
      return createLmStudioAdapter({ ...config.lmstudio, fetchImpl: config.fetchImpl });
    case "deepseek":
      if (!config.deepseek?.apiKey) {
        throw new ProviderConfigError("deepseek is enabled but has no API key configured.");
      }
      return createDeepSeekAdapter({ ...config.deepseek, fetchImpl: config.fetchImpl });
    case "openai-compatible":
      if (!config.openaiCompatible?.apiKey || !config.openaiCompatible.baseUrl) {
        throw new ProviderConfigError(
          "openai-compatible is enabled but has no base URL or API key configured.",
        );
      }
      return createOpenAiCompatibleAdapter({
        id: "openai-compatible",
        label: "OpenAI-compatible provider",
        baseUrl: config.openaiCompatible.baseUrl,
        defaultModel: config.openaiCompatible.defaultModel,
        apiKey: config.openaiCompatible.apiKey,
        isCloud: true,
        fetchImpl: config.fetchImpl,
        jsonMode: true,
      });
    case "anthropic":
      if (!config.anthropic?.apiKey) {
        throw new ProviderConfigError("anthropic is enabled but has no API key configured.");
      }
      return createAnthropicAdapter({ ...config.anthropic, fetchImpl: config.fetchImpl });
  }
}

/**
 * The gateway's provider allowlist, resolved once at startup.
 *
 * `resolve` is a lookup, never a search: an id that is not enabled returns
 * UNKNOWN_PROVIDER rather than the "closest" configured adapter. That is the
 * mechanism behind "local outage never triggers cloud automatically" -- there
 * is no code path in which one provider id yields another provider's adapter,
 * so an LM Studio failure can only ever surface as an LM Studio failure.
 *
 * Misconfiguration of an enabled provider throws here, at boot, instead of
 * surfacing mid-task.
 */
export function createProviderRegistry(config: ProviderRegistryConfig) {
  const adapters = new Map<ProviderId, ProviderAdapter>();
  for (const id of config.enabled) {
    adapters.set(id, build(id, config));
  }

  return {
    resolve(id: ProviderId): ResolveResult {
      const adapter = adapters.get(id);
      if (!adapter) {
        return {
          ok: false,
          code: "UNKNOWN_PROVIDER",
          message: `Provider "${id}" is not enabled on this gateway.`,
        };
      }
      return { ok: true, adapter };
    },
    available(): ProviderId[] {
      return [...adapters.keys()];
    },
  };
}

export type ProviderRegistry = ReturnType<typeof createProviderRegistry>;

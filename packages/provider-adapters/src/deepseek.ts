import type { FetchLike } from "./http";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import type { ProviderAdapter } from "./types";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/**
 * Cloud demo reference from TECH-STACK.md. It is experimental, so it lives in
 * configuration rather than in the protocol: swapping this string (or the whole
 * adapter) must not require a contract change.
 */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash-vision-exp";

export type DeepSeekOptions = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: FetchLike;
};

/**
 * DeepSeek adapter. DeepSeek speaks the OpenAI chat/vision shape, so this is
 * configuration over the shared adapter; the key is passed in from gateway
 * environment configuration and is never logged or echoed.
 */
export function createDeepSeekAdapter(options: DeepSeekOptions): ProviderAdapter {
  return createOpenAiCompatibleAdapter({
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL,
    defaultModel: options.defaultModel ?? DEEPSEEK_DEFAULT_MODEL,
    apiKey: options.apiKey,
    isCloud: true,
    fetchImpl: options.fetchImpl,
    jsonMode: true,
  });
}

import type { FetchLike } from "./http";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import type { ProviderAdapter } from "./types";

/** LM Studio's default OpenAI-compatible server, bound to loopback. */
export const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

/** Reference local VLM from TECH-STACK.md; the user picks what is loaded. */
export const LMSTUDIO_DEFAULT_MODEL = "qwen3-vl-4b-instruct";

export type LmStudioOptions = {
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: FetchLike;
};

export class LocalEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEndpointError";
  }
}

/**
 * Rejects a "local" endpoint that is not actually local. Without this, a
 * mistyped `ORKA_LMSTUDIO_BASE_URL` would turn the one provider the user chose
 * *because* it stays on-device into an ordinary remote call.
 */
export function assertLoopbackEndpoint(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LocalEndpointError("The LM Studio endpoint is not a valid URL.");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback) {
    throw new LocalEndpointError(
      "The LM Studio endpoint must stay on loopback (127.0.0.1 or localhost).",
    );
  }
}

/**
 * LM Studio adapter. It is the same OpenAI-compatible surface with a loopback
 * guard and no API key; `jsonMode` is off because local builds vary in
 * `response_format` support and the shared parser already tolerates prose.
 */
export function createLmStudioAdapter(options: LmStudioOptions = {}): ProviderAdapter {
  const baseUrl = options.baseUrl ?? LMSTUDIO_DEFAULT_BASE_URL;
  assertLoopbackEndpoint(baseUrl);
  return createOpenAiCompatibleAdapter({
    id: "lmstudio",
    label: "LM Studio",
    baseUrl,
    defaultModel: options.defaultModel ?? LMSTUDIO_DEFAULT_MODEL,
    isCloud: false,
    fetchImpl: options.fetchImpl,
    jsonMode: false,
  });
}

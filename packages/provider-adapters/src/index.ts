// Provider adapter seam (phases/03-planner-and-providers.md). The gateway
// imports through this file only: adapter internals -- auth, request shape,
// image encoding, retries, parsing -- stay local to each implementation.

export * from "./types";
export { parseActionPlan, type ParsedPlan } from "./parse";
export { PLANNER_SYSTEM_PROMPT, buildPlannerUserText } from "./prompt";
export { postJson, probe, type FetchLike, type HttpJsonResult } from "./http";
export {
  createOpenAiCompatibleAdapter,
  type OpenAiCompatibleOptions,
} from "./openaiCompatible";
export {
  createLmStudioAdapter,
  assertLoopbackEndpoint,
  LocalEndpointError,
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_DEFAULT_MODEL,
  type LmStudioOptions,
} from "./lmstudio";
export {
  createDeepSeekAdapter,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  type DeepSeekOptions,
} from "./deepseek";
export {
  createAnthropicAdapter,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  type AnthropicOptions,
} from "./anthropic";
export {
  createMockAdapter,
  MOCK_FIXTURES,
  MOCK_DEFAULT_FIXTURE,
  type MockAdapterOptions,
  type MockFixtureName,
} from "./mock";
export {
  createProviderRegistry,
  ProviderConfigError,
  type ProviderRegistry,
  type ProviderRegistryConfig,
  type ResolveResult,
} from "./registry";

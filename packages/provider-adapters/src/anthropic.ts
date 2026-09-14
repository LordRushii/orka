import { postJson, type FetchLike } from "./http";
import { parseActionPlan } from "./parse";
import { buildPlannerUserText, PLANNER_SYSTEM_PROMPT } from "./prompt";
import {
  providerFailure,
  type PlannerInput,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderResult,
} from "./types";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicOptions = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: FetchLike;
  maxTokens?: number;
};

type MessagesResponse = {
  content?: { type?: unknown; text?: unknown }[];
};

/**
 * Anthropic's Messages API differs from the OpenAI shape in three ways that
 * matter here: the system prompt is a top-level field, images are
 * `{ type: "image", source: { type: "base64", ... } }` with the media type
 * split out of the data URL, and the reply is a content-block array. That is
 * enough divergence to justify a separate adapter behind the same seam.
 */
export function createAnthropicAdapter(options: AnthropicOptions): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    id: "anthropic",
    defaultModel: options.defaultModel ?? ANTHROPIC_DEFAULT_MODEL,
    isCloud: true,

    async plan(input: PlannerInput, signal: AbortSignal): Promise<ProviderResult> {
      const model = input.model ?? options.defaultModel ?? ANTHROPIC_DEFAULT_MODEL;
      const { observation } = input;
      const result = await postJson(
        `${base}/messages`,
        {
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        {
          model,
          max_tokens: options.maxTokens ?? 1200,
          temperature: 0,
          system: PLANNER_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: observation.screenshot.mimeType,
                    data: observation.screenshot.dataBase64,
                  },
                },
                { type: "text", text: buildPlannerUserText(observation) },
              ],
            },
          ],
        },
        signal,
        fetchImpl,
        "Anthropic",
      );
      if (!result.ok) return result.failure;

      const text = ((result.body as MessagesResponse | null)?.content ?? [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      if (text.length === 0) {
        return providerFailure("PROVIDER_ERROR", "Anthropic returned no text content.");
      }

      const parsed = parseActionPlan(text, observation.taskId);
      if (!parsed.ok) return providerFailure(parsed.code, parsed.message);
      return { ok: true, plan: parsed.plan, model };
    },

    async health(): Promise<ProviderHealth> {
      // Anthropic has no unauthenticated health endpoint, and spending a live
      // token on a probe would be worse than reporting configuration state.
      return options.apiKey.length > 0
        ? { ok: true, message: "Anthropic is configured." }
        : { ok: false, message: "Anthropic has no API key configured." };
    },
  };
}

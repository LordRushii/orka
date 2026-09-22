import type { ProviderId } from "@orka/contracts";
import { postJson, probe, type FetchLike } from "./http";
import { parseActionPlan } from "./parse";
import { buildPlannerUserText, PLANNER_SYSTEM_PROMPT } from "./prompt";
import {
  providerFailure,
  type PlannerInput,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderResult,
} from "./types";

export type OpenAiCompatibleOptions = {
  id: ProviderId;
  label: string;
  /** Base URL including `/v1`, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
  isCloud: boolean;
  fetchImpl?: FetchLike;
  maxTokens?: number;
  /**
   * Sends `response_format: { type: "json_object" }`. Every hosted
   * OpenAI-compatible endpoint supports it; some local LM Studio builds 400 on
   * it, which is why it is a per-provider switch rather than a default.
   */
  jsonMode?: boolean;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: unknown } }[];
  model?: unknown;
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Reads the assistant text out of a chat completion. Vision-capable servers
 * sometimes return content as an array of parts rather than a string, so both
 * shapes are handled before the parser sees anything.
 */
function extractContent(body: unknown): string | null {
  const response = body as ChatCompletionResponse | null;
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * The shared OpenAI-compatible chat/vision adapter. DeepSeek, LM Studio, and
 * any other `/v1/chat/completions` server differ only in configuration, so
 * they reuse this implementation instead of forking the request shape.
 */
export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleOptions,
): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = trimBase(options.baseUrl);
  const authHeaders: Record<string, string> = options.apiKey
    ? { authorization: `Bearer ${options.apiKey}` }
    : {};

  return {
    id: options.id,
    defaultModel: options.defaultModel,
    isCloud: options.isCloud,

    async plan(input: PlannerInput, signal: AbortSignal): Promise<ProviderResult> {
      const model = input.model ?? options.defaultModel;
      const { observation } = input;
      // A snapshot-only round carries no image, so the request is text-only:
      // the provider is asked to decide from the element list alone.
      const userContent: Record<string, unknown>[] = [
        { type: "text", text: buildPlannerUserText(observation) },
      ];
      if (observation.screenshot) {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${observation.screenshot.mimeType};base64,${observation.screenshot.dataBase64}`,
          },
        });
      }
      const body: Record<string, unknown> = {
        model,
        temperature: 0,
        max_tokens: options.maxTokens ?? 1200,
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      };
      if (options.jsonMode) body.response_format = { type: "json_object" };

      const result = await postJson(
        `${base}/chat/completions`,
        authHeaders,
        body,
        signal,
        fetchImpl,
        options.label,
      );
      if (!result.ok) return result.failure;

      const content = extractContent(result.body);
      if (content === null) {
        return providerFailure("PROVIDER_ERROR", `${options.label} returned no assistant message.`);
      }

      const parsed = parseActionPlan(content, observation.taskId);
      if (!parsed.ok) return providerFailure(parsed.code, parsed.message);
      return { ok: true, plan: parsed.plan, model };
    },

    async health(signal: AbortSignal): Promise<ProviderHealth> {
      const reachable = await probe(`${base}/models`, authHeaders, signal, fetchImpl);
      return reachable
        ? { ok: true, message: `${options.label} is reachable.` }
        : { ok: false, message: `${options.label} is not reachable.` };
    },
  };
}

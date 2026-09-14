import type { SanitizedObservation } from "@orka/contracts";
import { CONTRACT_VERSION } from "@orka/contracts";

/** A marker that only ever appears in the sanitized (redacted) screenshot. */
export const REDACTED_IMAGE_B64 = "UkVEQUNURURfUElYRUxT";

export function observation(
  overrides: Partial<SanitizedObservation> = {},
): SanitizedObservation {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: "task-fixture",
    task: "Find the pricing page and summarize the plans.",
    urlOrigin: "https://example.com",
    screenshot: {
      mimeType: "image/png",
      width: 1280,
      height: 720,
      dataBase64: REDACTED_IMAGE_B64,
    },
    accessibilitySnapshot: [
      {
        id: "n1",
        role: "link",
        accessibleName: "Pricing",
        box: { x: 120, y: 40, width: 64, height: 20 },
        capabilities: ["click"],
      },
      {
        id: "n2",
        role: "textbox",
        accessibleName: "Card number",
        box: { x: 40, y: 300, width: 240, height: 32 },
        capabilities: ["type"],
        sensitive: true,
      },
    ],
    redactionSummary: [{ category: "CARD", count: 1 }],
    priorActions: [],
    ...overrides,
  };
}

export type RecordedRequest = { url: string; init: RequestInit };

/** A `FetchLike` that records every call and replays scripted responses. */
export function recordingFetch(responses: (() => Response)[]) {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error("no scripted response");
    return next();
  };
  return { calls, fetchImpl };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An OpenAI-compatible chat completion carrying `content` as the answer. */
export function chatCompletion(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
}

export function bodyOf(call: RecordedRequest): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

import { providerFailure, type ProviderFailure } from "./types";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; failure: ProviderFailure };

/**
 * One JSON POST with abort support and deliberately lossy error reporting.
 *
 * Provider error bodies can echo the request back (some OpenAI-compatible
 * servers include the prompt in a 400), so only the status code ever reaches
 * a message. Nothing here logs.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  providerLabel: string,
): Promise<HttpJsonResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted || (error as { name?: string })?.name === "AbortError") {
      return {
        ok: false,
        failure: providerFailure("PROVIDER_TIMEOUT", `${providerLabel} did not respond in time.`),
      };
    }
    return {
      ok: false,
      failure: providerFailure("PROVIDER_UNAVAILABLE", `${providerLabel} could not be reached.`),
    };
  }

  if (!response.ok) {
    const unauthorized = response.status === 401 || response.status === 403;
    return {
      ok: false,
      failure: providerFailure(
        unauthorized ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR",
        unauthorized
          ? `${providerLabel} rejected the configured credentials.`
          : `${providerLabel} returned HTTP ${response.status}.`,
      ),
    };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch {
    return {
      ok: false,
      failure: providerFailure(
        "PROVIDER_ERROR",
        `${providerLabel} returned a response Orka could not read.`,
      ),
    };
  }
}

/** `GET` probe used by `health()`; resolves to false rather than throwing. */
export async function probe(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal });
    return response.ok;
  } catch {
    return false;
  }
}

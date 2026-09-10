/**
 * Reduces a full page URL to a bare origin, per docs/ARCHITECTURE.md:
 * "current URL origin (not query string)". Throws rather than silently
 * truncating so a caller cannot accidentally forward a query string or
 * fragment by mistake.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function sanitizeUrlToOrigin(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("URL could not be parsed.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UnsafeUrlError("Only http(s) URLs may be sanitized to an origin.");
  }
  return parsed.origin;
}

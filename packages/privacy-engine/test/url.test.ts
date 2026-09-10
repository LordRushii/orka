import { describe, expect, test } from "bun:test";
import { sanitizeUrlToOrigin, UnsafeUrlError } from "../src/url";

describe("sanitizeUrlToOrigin", () => {
  test("reduces a URL with a path and query string to a bare origin", () => {
    expect(sanitizeUrlToOrigin("https://example.com/account?token=secret&x=1")).toBe(
      "https://example.com",
    );
  });

  test("reduces a URL with a fragment to a bare origin", () => {
    expect(sanitizeUrlToOrigin("https://example.com/page#section")).toBe("https://example.com");
  });

  test("preserves a non-default port", () => {
    expect(sanitizeUrlToOrigin("http://localhost:1234/v1/chat")).toBe("http://localhost:1234");
  });

  test("rejects a chrome:// restricted page", () => {
    expect(() => sanitizeUrlToOrigin("chrome://settings")).toThrow(UnsafeUrlError);
  });

  test("rejects an unparsable URL", () => {
    expect(() => sanitizeUrlToOrigin("not a url")).toThrow(UnsafeUrlError);
  });

  test("rejects a file:// URL", () => {
    expect(() => sanitizeUrlToOrigin("file:///etc/passwd")).toThrow(UnsafeUrlError);
  });
});

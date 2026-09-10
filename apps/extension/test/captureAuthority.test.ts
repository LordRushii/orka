import { describe, expect, test } from "bun:test";
import {
  CAPTURE_AUTHORITY_TTL_MS,
  CaptureAuthorityError,
  captureFromAuthority,
  createCaptureAuthority,
  validateCaptureAuthority,
} from "../shared/captureAuthority.ts";

const TAB = { id: 7, windowId: 11, url: "https://example.com/account?private=value" };

function browserFor(overrides: Partial<{
  tab: typeof TAB;
  activeTab: typeof TAB | undefined;
  screenshot: string;
}> = {}) {
  let captures = 0;
  const browser = {
    getTab: async () => overrides.tab ?? TAB,
    getActiveTab: async () => overrides.activeTab === undefined ? TAB : overrides.activeTab,
    captureVisibleTab: async () => {
      captures += 1;
      return overrides.screenshot ?? "data:image/png;base64,AAAA";
    },
  };
  return { browser, captures: () => captures };
}

describe("capture authority", () => {
  test("binds capture to the original HTTP(S) tab, window, and origin only", async () => {
    const authority = createCaptureAuthority(TAB, "authority-1", 1_000);
    const fixture = browserFor();

    const capture = await captureFromAuthority(authority, fixture.browser, 1_001);

    expect(capture.tab.id).toBe(TAB.id);
    expect(capture.screenshotDataUrl).toStartWith("data:image/png");
    expect(fixture.captures()).toBe(1);
  });

  test("never captures when the user switched tabs", async () => {
    const authority = createCaptureAuthority(TAB, "authority-1", 1_000);
    const fixture = browserFor({ activeTab: { ...TAB, id: 8 } });

    await expect(captureFromAuthority(authority, fixture.browser, 1_001)).rejects.toBeInstanceOf(CaptureAuthorityError);
    expect(fixture.captures()).toBe(0);
  });

  test("never captures after a cross-origin navigation", async () => {
    const authority = createCaptureAuthority(TAB, "authority-1", 1_000);
    const fixture = browserFor({ tab: { ...TAB, url: "https://other.example/" } });

    await expect(captureFromAuthority(authority, fixture.browser, 1_001)).rejects.toBeInstanceOf(CaptureAuthorityError);
    expect(fixture.captures()).toBe(0);
  });

  test("expires a stale toolbar grant without attempting capture", async () => {
    const authority = createCaptureAuthority(TAB, "authority-1", 1_000);
    const fixture = browserFor();

    await expect(validateCaptureAuthority(authority, fixture.browser, 1_000 + CAPTURE_AUTHORITY_TTL_MS + 1))
      .rejects.toThrow("expired");
    expect(fixture.captures()).toBe(0);
  });

  test("rejects restricted pages while minting the authority", () => {
    expect(() => createCaptureAuthority({ ...TAB, url: "chrome://settings" }, "authority-1"))
      .toThrow("normal HTTP(S) page");
  });
});

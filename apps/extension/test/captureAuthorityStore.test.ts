import { describe, expect, test } from "bun:test";
import { CAPTURE_AUTHORITY_TTL_MS } from "../shared/captureAuthority.ts";
import { createCaptureAuthorityStore } from "../shared/captureAuthorityStore.ts";

const TAB = { id: 7, windowId: 11, url: "https://example.com/page" };

describe("capture authority store (task continuation)", () => {
  test("a second task can start without reopening the extension", () => {
    const store = createCaptureAuthorityStore(() => 1_000);
    store.mint(TAB, "authority-1");

    // Task 1: sidepanel GET + START.
    const first = store.response();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(() => store.use(first.authorityId)).not.toThrow();

    // Task 2 without any toolbar reopen: fresh GET + START must still succeed.
    const second = store.response();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.authorityId).toBe(first.authorityId);
    expect(() => store.use(second.authorityId)).not.toThrow();
  });

  test("rejects an unknown authority id", () => {
    const store = createCaptureAuthorityStore(() => 1_000);
    store.mint(TAB, "authority-1");
    expect(() => store.use("authority-stale")).toThrow(
      "Capture permission is unavailable",
    );
  });

  test("expires the reusable grant after its TTL", () => {
    let now = 1_000;
    const store = createCaptureAuthorityStore(() => now);
    store.mint(TAB, "authority-1");
    expect(store.response().ok).toBe(true);

    now += CAPTURE_AUTHORITY_TTL_MS + 1;
    const expired = store.response();
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.message).toMatch("expired");
    }
    expect(() => store.use("authority-1")).toThrow("unavailable");
  });

  test("a fresh toolbar mint replaces the previous grant", () => {
    const store = createCaptureAuthorityStore(() => 1_000);
    store.mint(TAB, "authority-1");
    store.mint(TAB, "authority-2");

    expect(() => store.use("authority-1")).toThrow("unavailable");
    expect(() => store.use("authority-2")).not.toThrow();
  });

  test("reports reopen guidance when no grant exists", () => {
    const store = createCaptureAuthorityStore(() => 1_000);
    const response = store.response();
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.message).toMatch("Reopen Orka");
    }
  });
});

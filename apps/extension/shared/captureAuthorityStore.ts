import {
  CAPTURE_AUTHORITY_TTL_MS,
  CaptureAuthorityError,
  createCaptureAuthority,
  type CaptureAuthority,
  type CaptureAuthorityTab,
} from "./captureAuthority.ts";

export type CaptureAuthorityResponse =
  | { ok: true; type: "CAPTURE_AUTHORITY"; authorityId: string }
  | { ok: false; type: "ERROR"; message: string; code?: "NON_WEB_PAGE" };

/**
 * Holds the single toolbar-minted capture authority for the background service
 * worker.
 *
 * The authority is deliberately reusable within its TTL so a second task can
 * start without reopening the extension: every capture still revalidates the
 * live tab, window, origin, and active-tab state via `validateCaptureAuthority`
 * before any screenshot is taken, so reuse cannot escape the original page.
 */
export function createCaptureAuthorityStore(now: () => number = Date.now) {
  let authority: CaptureAuthority | null = null;

  function response(): CaptureAuthorityResponse {
    if (!authority) {
      return {
        ok: false as const,
        type: "ERROR" as const,
        message: "Reopen Orka from the toolbar before starting a task.",
      };
    }
    if (now() - authority.issuedAt > CAPTURE_AUTHORITY_TTL_MS) {
      authority = null;
      return {
        ok: false as const,
        type: "ERROR" as const,
        message: "Capture permission expired. Reopen Orka from the toolbar.",
      };
    }
    return { ok: true as const, type: "CAPTURE_AUTHORITY" as const, authorityId: authority.id };
  }

  function mint(tab: CaptureAuthorityTab, id: string): CaptureAuthority {
    authority = createCaptureAuthority(tab, id, now());
    return authority;
  }

  function clear(): void {
    authority = null;
  }

  /**
   * Returns the stored authority for a task without consuming it, so the next
   * task can use the same grant until it expires or is replaced. Throws when
   * the id does not match the stored grant.
   */
  function use(id: string): CaptureAuthority {
    const current = response();
    if (!current.ok || !authority || current.authorityId !== id) {
      throw new CaptureAuthorityError(
        "Capture permission is unavailable. Reopen Orka from the toolbar.",
      );
    }
    return authority;
  }

  return { response, mint, clear, use };
}

export type CaptureAuthorityStore = ReturnType<typeof createCaptureAuthorityStore>;

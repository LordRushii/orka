/**
 * A capability minted exclusively by the toolbar action.  It deliberately
 * identifies a browser tab/window rather than accepting either from the side
 * panel, which is persistent and can outlive the activeTab grant.
 */
export type CaptureAuthority = {
  id: string;
  tabId: number;
  windowId: number;
  origin: string;
  issuedAt: number;
};

export type CaptureAuthorityTab = {
  id?: number;
  windowId?: number;
  url?: string;
};

export type CaptureAuthorityBrowser = {
  getTab(tabId: number): Promise<CaptureAuthorityTab>;
  getActiveTab(windowId: number): Promise<CaptureAuthorityTab | undefined>;
  captureVisibleTab(windowId: number): Promise<string>;
};

export const CAPTURE_AUTHORITY_TTL_MS = 5 * 60_000;

export class CaptureAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureAuthorityError";
  }
}

function httpOrigin(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function createCaptureAuthority(
  tab: CaptureAuthorityTab,
  id: string,
  now = Date.now(),
): CaptureAuthority {
  const origin = httpOrigin(tab.url);
  if (!tab.id || tab.windowId === undefined || tab.windowId < 0 || !origin) {
    throw new CaptureAuthorityError("Open a normal HTTP(S) page, then reopen Orka from the toolbar.");
  }
  return { id, tabId: tab.id, windowId: tab.windowId, origin, issuedAt: now };
}

export async function validateCaptureAuthority(
  authority: CaptureAuthority,
  browser: Pick<CaptureAuthorityBrowser, "getTab" | "getActiveTab">,
  now = Date.now(),
): Promise<CaptureAuthorityTab> {
  if (now - authority.issuedAt > CAPTURE_AUTHORITY_TTL_MS) {
    throw new CaptureAuthorityError("Capture permission expired. Reopen Orka from the toolbar.");
  }

  const tab = await browser.getTab(authority.tabId);
  if (tab.id !== authority.tabId || tab.windowId !== authority.windowId || httpOrigin(tab.url) !== authority.origin) {
    throw new CaptureAuthorityError("The original page changed. Reopen Orka from the toolbar.");
  }

  const activeTab = await browser.getActiveTab(authority.windowId);
  if (activeTab?.id !== authority.tabId || activeTab.windowId !== authority.windowId) {
    throw new CaptureAuthorityError("Return to the original tab, then reopen Orka from the toolbar.");
  }
  return tab;
}

export async function captureFromAuthority(
  authority: CaptureAuthority,
  browser: CaptureAuthorityBrowser,
  now = Date.now(),
): Promise<{ tab: CaptureAuthorityTab; screenshotDataUrl: string }> {
  const tab = await validateCaptureAuthority(authority, browser, now);
  let screenshotDataUrl: string;
  try {
    screenshotDataUrl = await browser.captureVisibleTab(authority.windowId);
  } catch {
    throw new CaptureAuthorityError("Browser denied the capture. Reopen Orka from the toolbar.");
  }
  if (!screenshotDataUrl.startsWith("data:image/png")) {
    throw new CaptureAuthorityError("The active tab screenshot was empty. Reopen Orka from the toolbar.");
  }
  return { tab, screenshotDataUrl };
}

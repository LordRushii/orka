import type { Box, ExecutionOutcomeCode } from "@orka/contracts";
import { MAX_TARGET_CANDIDATES, type PageCandidate } from "./executorPolicy.ts";
import {
  actOnPageElement,
  listPageCandidates,
  readPageLocation,
  scrollPage,
  type PageViewport,
} from "./pageActions.ts";
import { collectSafePageSnapshot } from "./snapshot.ts";

/**
 * The seam between the executor's decisions and the page they act on.
 *
 * The executor talks to this interface, never to `scripting` directly, so a
 * whole run can be driven against a scripted page in a test. Everything that
 * crosses back out of the page is a fact, defensively validated here: the
 * injected functions are ours, but they run inside a page whose DOM the site
 * controls.
 */

/** The slice of `browser.scripting` this module needs. */
export type InjectionApi = {
  executeScript<Args extends unknown[], Result>(injection: {
    target: { tabId: number };
    func: (...args: Args) => Result;
    args?: Args;
  }): Promise<Array<{ result?: Result }>>;
};

export type PageInspection = {
  origin: string;
  viewport: PageViewport;
  candidates: PageCandidate[];
};

/**
 * The part of the evidence a page can be asked about: the semantic pair the
 * plan cited. The box is deliberately absent -- it is compared by the policy
 * module, in the observation's coordinate space, not by the page.
 */
export type TargetQuery = {
  role: string;
  accessibleName: string;
};

export type PagePortFailure = { ok: false; code: ExecutionOutcomeCode; reason: string };

export type PageInspectionResult =
  | { ok: true; inspection: PageInspection }
  | PagePortFailure;

export type PageActionResult = { ok: true } | PagePortFailure;

/** What the executor passes back so the page can prove it is the same element. */
export type ActTarget = Pick<PageCandidate, "ordinal" | "role" | "accessibleName" | "box">;

export type SnapshotRefresh =
  | { ok: true; origin: string; elementCount: number }
  | PagePortFailure;

export type PagePort = {
  /** Live facts for the evidence's role and accessible name. Decides nothing. */
  locate(tabId: number, query: TargetQuery): Promise<PageInspectionResult>;
  click(tabId: number, target: ActTarget): Promise<PageActionResult>;
  type(tabId: number, target: ActTarget, value: string): Promise<PageActionResult>;
  select(tabId: number, target: ActTarget, value: string): Promise<PageActionResult>;
  /** Scrolls and reports the delta actually achieved (`dx`/`dy`). */
  scroll(
    tabId: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<{ ok: true; dx: number; dy: number } | PagePortFailure>;
  /** Local-only viewport refresh; the snapshot itself never leaves the page. */
  refreshSnapshot(tabId: number): Promise<SnapshotRefresh>;
  /** The page's current origin, or undefined when it cannot be read. */
  origin(tabId: number): Promise<string | undefined>;
};

const PAGE_UNAVAILABLE = (reason: string): PagePortFailure => ({
  ok: false,
  code: "PAGE_UNAVAILABLE",
  reason,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBox(value: unknown): value is Box {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    [value.x, value.y, value.width, value.height].every((entry) => Number.isFinite(entry))
  );
}

function isCandidate(value: unknown): value is PageCandidate {
  if (!isRecord(value)) return false;
  return (
    typeof value.ordinal === "number" &&
    typeof value.role === "string" &&
    typeof value.accessibleName === "string" &&
    isBox(value.box) &&
    typeof value.visible === "boolean" &&
    typeof value.enabled === "boolean" &&
    typeof value.tag === "string" &&
    typeof value.editable === "boolean" &&
    typeof value.selectable === "boolean" &&
    typeof value.inForm === "boolean" &&
    (value.inputType === undefined || typeof value.inputType === "string")
  );
}

/**
 * Reads one injected result. An injection that produced nothing (the tab
 * navigated mid-call, the frame went away) is a failure rather than an
 * absent value, so no caller can mistake "unknown" for "nothing here".
 */
async function inject<Args extends unknown[], Result>(
  injections: InjectionApi,
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<{ ok: true; result: Result } | PagePortFailure> {
  try {
    const results = await injections.executeScript({ target: { tabId }, func, args });
    const result = results[0]?.result;
    if (result === undefined || result === null) {
      return PAGE_UNAVAILABLE("The page did not answer while it was being read.");
    }
    return { ok: true, result };
  } catch {
    // No host access (a page opened after the task began), a crashed frame, or
    // a closed tab. Every one of them means "cannot act here".
    return PAGE_UNAVAILABLE("Orka cannot read this page right now.");
  }
}

export function createPagePort(injections: InjectionApi): PagePort {
  async function locate(tabId: number, query: TargetQuery): Promise<PageInspectionResult> {
    const injected = await inject(injections, tabId, listPageCandidates, [
      {
        role: query.role,
        accessibleName: query.accessibleName,
        limit: MAX_TARGET_CANDIDATES,
      },
    ]);
    if (!injected.ok) return injected;

    const listing = injected.result as unknown;
    if (
      !isRecord(listing) ||
      typeof listing.origin !== "string" ||
      !isRecord(listing.viewport) ||
      !Array.isArray(listing.candidates)
    ) {
      return PAGE_UNAVAILABLE("The page description was not readable.");
    }
    const viewport = listing.viewport;
    if (typeof viewport.width !== "number" || typeof viewport.height !== "number") {
      return PAGE_UNAVAILABLE("The page description was not readable.");
    }
    return {
      ok: true,
      inspection: {
        origin: listing.origin,
        viewport: {
          width: viewport.width,
          height: viewport.height,
          devicePixelRatio:
            typeof viewport.devicePixelRatio === "number" ? viewport.devicePixelRatio : 1,
        },
        candidates: listing.candidates.filter(isCandidate),
      },
    };
  }

  function report(outcome: unknown): PageActionResult {
    if (!isRecord(outcome)) return PAGE_UNAVAILABLE("The page did not answer while it was acting.");
    if (outcome.ok === true) return { ok: true };
    const code = typeof outcome.code === "string" ? (outcome.code as ExecutionOutcomeCode) : undefined;
    const message = typeof outcome.message === "string" ? outcome.message : "";
    return {
      ok: false,
      code: code ?? "UNEXPECTED_ERROR",
      reason: message || "The page refused that action.",
    };
  }

  return {
    locate,

    async click(tabId, target) {
      const injected = await inject(injections, tabId, actOnPageElement, [
        {
          kind: "click" as const,
          ordinal: target.ordinal,
          expected: { role: target.role, accessibleName: target.accessibleName, box: target.box },
          limit: MAX_TARGET_CANDIDATES,
        },
      ]);
      return injected.ok ? report(injected.result) : injected;
    },

    async type(tabId, target, value) {
      const injected = await inject(injections, tabId, actOnPageElement, [
        {
          kind: "type" as const,
          ordinal: target.ordinal,
          expected: { role: target.role, accessibleName: target.accessibleName, box: target.box },
          limit: MAX_TARGET_CANDIDATES,
          value,
        },
      ]);
      return injected.ok ? report(injected.result) : injected;
    },

    async select(tabId, target, value) {
      const injected = await inject(injections, tabId, actOnPageElement, [
        {
          kind: "select" as const,
          ordinal: target.ordinal,
          expected: { role: target.role, accessibleName: target.accessibleName, box: target.box },
          limit: MAX_TARGET_CANDIDATES,
          value,
        },
      ]);
      return injected.ok ? report(injected.result) : injected;
    },

    async scroll(tabId, direction, amount) {
      const injected = await inject(injections, tabId, scrollPage, [{ direction, amount }]);
      if (!injected.ok) return injected;
      const outcome = injected.result as unknown;
      if (!isRecord(outcome)) return PAGE_UNAVAILABLE("The page did not confirm the scroll.");
      if (outcome.ok === true && typeof outcome.dx === "number" && typeof outcome.dy === "number") {
        return { ok: true, dx: outcome.dx, dy: outcome.dy };
      }
      const failure = report(outcome);
      return failure.ok ? PAGE_UNAVAILABLE("The page did not confirm the scroll.") : failure;
    },

    async refreshSnapshot(tabId) {
      const injected = await inject(injections, tabId, collectSafePageSnapshot, []);
      if (!injected.ok) return injected;
      const capture = injected.result as unknown;
      if (
        !isRecord(capture) ||
        typeof capture.urlOrigin !== "string" ||
        !isRecord(capture.snapshot) ||
        !Array.isArray(capture.snapshot.elements)
      ) {
        return PAGE_UNAVAILABLE("The page could not be re-read after scrolling.");
      }
      return {
        ok: true,
        origin: capture.urlOrigin,
        elementCount: capture.snapshot.elements.length,
      };
    },

    async origin(tabId) {
      const injected = await inject(injections, tabId, readPageLocation, []);
      if (!injected.ok) return undefined;
      const location = injected.result as unknown;
      return isRecord(location) && typeof location.origin === "string" ? location.origin : undefined;
    },
  };
}

/** The real `browser.scripting`, narrowed to `InjectionApi`. */
export function browserInjectionApi(): InjectionApi {
  return browser.scripting as unknown as InjectionApi;
}

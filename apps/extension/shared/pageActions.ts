import type { Box } from "@orka/contracts";
import type { PageCandidate } from "./executorPolicy.ts";

/**
 * The functions the executor injects into the page it is acting on.
 *
 * Like `collectSafePageSnapshot`, every function here is *self-contained*: it
 * is serialized by `scripting.executeScript`, so it may reference its own body,
 * its arguments, and page globals -- and nothing else. No imports, no module
 * scope, no closures. That constraint is why the small geometry and naming
 * helpers below are duplicated rather than shared with `executorPolicy.ts`.
 *
 * The split of responsibility matters: these functions report *facts* (roles,
 * names, boxes, enabled state) and perform exactly one mechanical action. They
 * decide nothing. Every refusal lives in `executorPolicy.ts`, where it is
 * testable without a browser.
 */

export type PageViewport = {
  width: number;
  height: number;
  devicePixelRatio: number;
};

export type PageLocation = {
  origin: string;
  viewport: PageViewport;
};

export type CandidateQuery = {
  role: string;
  accessibleName: string;
  limit: number;
};

export type CandidateListing = {
  origin: string;
  viewport: PageViewport;
  candidates: PageCandidate[];
};

export type PageActRequest =
  | { kind: "click"; ordinal: number; expected: ExpectedTarget; limit: number }
  | { kind: "type"; ordinal: number; expected: ExpectedTarget; limit: number; value: string }
  | { kind: "select"; ordinal: number; expected: ExpectedTarget; limit: number; value: string };

/** What the inspection reported, restated so the act can prove it is the same element. */
export type ExpectedTarget = {
  role: string;
  accessibleName: string;
  box: Box;
};

export type PageActOutcome =
  | { ok: true; kind: "click" | "type" | "select" }
  | { ok: false; code: PageActFailureCode; message: string };

export type PageActFailureCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_DRIFTED"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_NOT_INTERACTABLE"
  | "UNEXPECTED_ERROR";

export type ScrollRequest = {
  direction: "up" | "down" | "left" | "right";
  amount: number;
};

export type ScrollOutcome =
  | { ok: true; x: number; y: number; dx: number; dy: number }
  | { ok: false; code: PageActFailureCode; message: string };

/* -------------------------------------------------------------------------- *
 * Injected: read-only facts                                                  *
 * -------------------------------------------------------------------------- */

/** Current origin and viewport. Never the full URL, the query, or the referrer. */
export function readPageLocation(): PageLocation {
  return {
    origin: location.origin,
    viewport: {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
    },
  };
}

/**
 * Every live element matching the evidence's role and accessible name, in
 * document order, described by facts only.
 *
 * The traversal order and the role/name rules mirror `collectSafePageSnapshot`
 * on purpose: the plan's evidence was copied from that snapshot, so the same
 * element has to be found the same way. `ordinal` is a position in this list,
 * stable for an unchanged page, and is how the follow-up act addresses the
 * element without ever holding a reference across injections.
 */
export function listPageCandidates(query: CandidateQuery): CandidateListing {
  const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const viewport = {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
    devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
  };

  function visible(element: Element): boolean {
    const htmlElement = element as HTMLElement;
    const style = window.getComputedStyle(htmlElement);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = htmlElement.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    );
  }

  function clippedBox(element: Element): Box {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function roleFor(element: Element): string {
    const explicitRole = element.getAttribute("role")?.trim();
    if (explicitRole) return explicitRole.slice(0, 64);
    switch (element.tagName) {
      case "A":
        return "link";
      case "BUTTON":
        return "button";
      case "INPUT":
      case "TEXTAREA":
        return "textbox";
      case "SELECT":
        return "combobox";
      case "IMG":
        return "img";
      default:
        return "generic";
    }
  }

  function labelText(element: Element): string {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ")
        .slice(0, 256);
    }
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    if (ariaLabel) return ariaLabel.slice(0, 256);
    const id = element.getAttribute("id");
    if (id) {
      const label = Array.from(document.querySelectorAll("label")).find(
        (candidate) => candidate.htmlFor === id,
      );
      if (label?.textContent?.trim()) return label.textContent.trim().slice(0, 256);
    }
    if (element.tagName === "LABEL") return (element.textContent ?? "").trim().slice(0, 256);
    if (["A", "BUTTON", "OPTION"].includes(element.tagName)) {
      return (element.textContent ?? "").trim().slice(0, 256);
    }
    const title = element.getAttribute("title")?.trim();
    return title ? title.slice(0, 256) : "";
  }

  function inputTypeFor(element: Element): string | undefined {
    if (element.tagName !== "INPUT") return undefined;
    const type = (element as HTMLInputElement).type?.toLowerCase();
    return type ? type.slice(0, 32) : undefined;
  }

  function editableFor(element: Element, role: string): boolean {
    if (element.tagName === "TEXTAREA") return true;
    if (element.tagName === "INPUT") {
      const type = inputTypeFor(element) ?? "text";
      const textLike = [
        "text",
        "search",
        "email",
        "tel",
        "url",
        "password",
        "number",
        "date",
        "time",
        "datetime-local",
        "month",
        "week",
      ];
      return textLike.includes(type);
    }
    if ((element as HTMLElement).isContentEditable) return true;
    return role === "textbox" || role === "searchbox";
  }

  function enabledFor(element: Element): boolean {
    const candidate = element as HTMLElement & { disabled?: boolean };
    if (candidate.disabled === true) return false;
    if (element.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function canonicalRole(role: string): string {
    const normalized = role.trim().toLowerCase();
    if (normalized === "searchbox") return "textbox";
    if (normalized === "listbox") return "combobox";
    return normalized;
  }

  const wantedRole = canonicalRole(query.role);
  const wantedName = normalize(query.accessibleName);
  // A redacted element's name was replaced with a placeholder before the
  // planner saw it, so it can never be compared against the live DOM. Such a
  // target is listed by role alone; `executorPolicy.ts` applies the same rule
  // when it resolves one, and the value it may be filled with is restricted
  // there to a local value the user saved.
  const nameIsPlaceholder = /^\[[A-Z][A-Z0-9_]{0,31}\]$/.test(query.accessibleName.trim());
  const candidates: PageCandidate[] = [];

  const elements = Array.from(document.querySelectorAll("*"));
  for (const element of elements) {
    if (candidates.length >= query.limit) break;
    if (excludedTags.has(element.tagName)) continue;

    const role = roleFor(element);
    if (canonicalRole(role) !== wantedRole) continue;
    const accessibleName = labelText(element);
    if (!nameIsPlaceholder && normalize(accessibleName) !== wantedName) continue;

    const box = clippedBox(element);
    const isVisible = visible(element);
    candidates.push({
      ordinal: candidates.length,
      role,
      accessibleName,
      box,
      visible: isVisible,
      enabled: enabledFor(element),
      tag: element.tagName,
      inputType: inputTypeFor(element),
      editable: editableFor(element, canonicalRole(role)),
      selectable: element.tagName === "SELECT" || canonicalRole(role) === "combobox",
      inForm: element.closest("form") !== null,
    });
  }

  return { origin: location.origin, viewport, candidates };
}

/* -------------------------------------------------------------------------- *
 * Injected: one mechanical action                                            *
 * -------------------------------------------------------------------------- */

/**
 * Re-resolves the element and performs exactly one action on it.
 *
 * This runs as its own injection, seconds after the inspection that produced
 * `ordinal` -- long enough for the page to change underneath (the user may
 * have been reading a confirmation prompt in between). So the element is
 * looked up again and has to prove it is still the same one: same role, same
 * accessible name, and a box that has not moved. If it cannot, nothing is
 * clicked or typed and the executor reports why.
 */
export function actOnPageElement(request: PageActRequest): PageActOutcome {
  const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

  function normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function canonicalRole(role: string): string {
    const normalized = role.trim().toLowerCase();
    if (normalized === "searchbox") return "textbox";
    if (normalized === "listbox") return "combobox";
    return normalized;
  }

  function visible(element: Element): boolean {
    const htmlElement = element as HTMLElement;
    const style = window.getComputedStyle(htmlElement);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = htmlElement.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    );
  }

  function liveBox(element: Element): Box {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function intersectionArea(a: Box, b: Box): number {
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return width * height;
  }

  function boxesMatch(expected: Box, actual: Box): boolean {
    const intersection = intersectionArea(expected, actual);
    const union = expected.width * expected.height + actual.width * actual.height - intersection;
    const overlap = union > 0 ? intersection / union : 0;
    if (overlap >= 0.5) return true;
    const distance = Math.hypot(
      expected.x + expected.width / 2 - (actual.x + actual.width / 2),
      expected.y + expected.height / 2 - (actual.y + actual.height / 2),
    );
    if (distance > 24) return false;
    for (const [first, second] of [
      [expected.width, actual.width],
      [expected.height, actual.height],
    ] as const) {
      const largest = Math.max(first, second);
      if (largest > 0 && Math.abs(first - second) / largest > 0.5) return false;
    }
    return true;
  }

  function roleFor(element: Element): string {
    const explicitRole = element.getAttribute("role")?.trim();
    if (explicitRole) return explicitRole.slice(0, 64);
    switch (element.tagName) {
      case "A":
        return "link";
      case "BUTTON":
        return "button";
      case "INPUT":
      case "TEXTAREA":
        return "textbox";
      case "SELECT":
        return "combobox";
      case "IMG":
        return "img";
      default:
        return "generic";
    }
  }

  function labelText(element: Element): string {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ")
        .slice(0, 256);
    }
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    if (ariaLabel) return ariaLabel.slice(0, 256);
    const id = element.getAttribute("id");
    if (id) {
      const label = Array.from(document.querySelectorAll("label")).find(
        (candidate) => candidate.htmlFor === id,
      );
      if (label?.textContent?.trim()) return label.textContent.trim().slice(0, 256);
    }
    if (element.tagName === "LABEL") return (element.textContent ?? "").trim().slice(0, 256);
    if (["A", "BUTTON", "OPTION"].includes(element.tagName)) {
      return (element.textContent ?? "").trim().slice(0, 256);
    }
    const title = element.getAttribute("title")?.trim();
    return title ? title.slice(0, 256) : "";
  }

  /**
   * Writes a value the way a user would, so reactive pages notice the change.
   * Setting through the native prototype setter (rather than assigning
   * `.value`) is what makes controlled React/Vue inputs register the edit;
   * a plain assignment is ignored by their own value tracking.
   */
  function setNativeValue(element: Element, value: string): void {
    const htmlElement = element as HTMLElement & { value?: string };
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const prototype =
        element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) descriptor.set.call(htmlElement, value);
      else htmlElement.value = value;
    } else if (htmlElement.isContentEditable || element.getAttribute("role") === "textbox") {
      htmlElement.textContent = value;
    } else {
      htmlElement.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  try {
    const wantedRole = canonicalRole(request.expected.role);
    const wantedName = normalize(request.expected.accessibleName);
    const nameIsPlaceholder = /^\[[A-Z][A-Z0-9_]{0,31}\]$/.test(
      request.expected.accessibleName.trim(),
    );
    const matches: Element[] = [];

    // The same traversal, filter, and cap as the listing that produced
    // `ordinal`, which is the whole reason the two agree on the element.
    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (matches.length >= request.limit) break;
      if (excludedTags.has(element.tagName)) continue;
      if (canonicalRole(roleFor(element)) !== wantedRole) continue;
      if (!nameIsPlaceholder && normalize(labelText(element)) !== wantedName) continue;
      matches.push(element);
    }

    const element = matches[request.ordinal];
    if (!element) {
      return {
        ok: false,
        code: "TARGET_NOT_FOUND",
        message: "That element is no longer on the page.",
      };
    }
    if (!visible(element)) {
      return {
        ok: false,
        code: "TARGET_NOT_VISIBLE",
        message: "That element is no longer visible.",
      };
    }
    if (!boxesMatch(request.expected.box, liveBox(element))) {
      return {
        ok: false,
        code: "TARGET_DRIFTED",
        message: "That element moved while the step was waiting.",
      };
    }

    const htmlElement = element as HTMLElement & { value?: string; disabled?: boolean };
    if (htmlElement.disabled === true || element.getAttribute("aria-disabled") === "true") {
      return {
        ok: false,
        code: "TARGET_NOT_INTERACTABLE",
        message: "That element is disabled.",
      };
    }
    if (typeof htmlElement.focus === "function") {
      htmlElement.focus({ preventScroll: true });
    }

    if (request.kind === "click") {
      if (typeof htmlElement.click !== "function") {
        return {
          ok: false,
          code: "TARGET_NOT_INTERACTABLE",
          message: "That element cannot be clicked.",
        };
      }
      htmlElement.click();
      return { ok: true, kind: "click" };
    }

    if (request.kind === "type") {
      setNativeValue(element, request.value);
      return { ok: true, kind: "type" };
    }

    const select = element as HTMLSelectElement;
    if (typeof select.options === "undefined") {
      return {
        ok: false,
        code: "TARGET_NOT_INTERACTABLE",
        message: "That element is not a select control.",
      };
    }
    const wanted = request.value.trim();
    const options = Array.from(select.options);
    const option =
      options.find((candidate) => candidate.value === request.value) ??
      options.find((candidate) => candidate.text.trim() === wanted) ??
      options.find((candidate) => candidate.text.trim().toLowerCase() === wanted.toLowerCase());
    if (!option) {
      return {
        ok: false,
        code: "TARGET_NOT_INTERACTABLE",
        message: "That select control has no matching option.",
      };
    }
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, kind: "select" };
  } catch (error) {
    return {
      ok: false,
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message.slice(0, 200) : "The page rejected that action.",
    };
  }
}

/**
 * Scrolls the window by a bounded amount and reports where it landed.
 *
 * The *delta* is what the executor needs: a page clamps a scroll at its own
 * end, so believing we moved by `amount` would be wrong at the bottom of a
 * document. The evidence for the following step is shifted by what actually
 * happened, not by what was requested.
 */
export function scrollPage(request: ScrollRequest): ScrollOutcome {
  const amount = Math.min(Math.max(1, Math.abs(Math.trunc(request.amount))), 10_000);
  try {
    const beforeX = window.scrollX;
    const beforeY = window.scrollY;
    switch (request.direction) {
      case "down":
        window.scrollBy(0, amount);
        break;
      case "up":
        window.scrollBy(0, -amount);
        break;
      case "right":
        window.scrollBy(amount, 0);
        break;
      case "left":
        window.scrollBy(-amount, 0);
        break;
    }
    const x = Math.round(window.scrollX);
    const y = Math.round(window.scrollY);
    return { ok: true, x, y, dx: x - Math.round(beforeX), dy: y - Math.round(beforeY) };
  } catch (error) {
    return {
      ok: false,
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message.slice(0, 200) : "The page refused to scroll.",
    };
  }
}

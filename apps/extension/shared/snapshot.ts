import type { SafePageSnapshot, SensitivityHints, Viewport } from "@orka/privacy-engine";

export type PageCapture = {
  urlOrigin: string;
  viewport: Viewport;
  snapshot: SafePageSnapshot;
};

/**
 * This function is deliberately self-contained because it is passed to
 * `scripting.executeScript`. It reads rendered text for local classification,
 * but never reads input values or serializes page source, storage, cookies, or
 * query strings.
 */
export function collectSafePageSnapshot(): PageCapture {
  const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const sensitiveLabelPattern =
    /\b(password|passcode|secret|otp|one[- ]?time|cvv|security code|card number|account number|aadhaar|pan|ssn|email|phone|mobile)\b/i;
  const elementCapabilities = new Set(["click", "type", "select", "scroll", "navigate"]);

  function visible(element: Element): boolean {
    const htmlElement = element as HTMLElement;
    for (let current: Element | null = htmlElement; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
    }
    const rect = htmlElement.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.left < window.innerWidth && rect.top < window.innerHeight;
  }

  function clippedBox(element: Element): { x: number; y: number; width: number; height: number } | null {
    if (!visible(element)) return null;
    const rect = (element as HTMLElement).getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
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
      const label = Array.from(document.querySelectorAll("label")).find((candidate) => candidate.htmlFor === id);
      if (label?.textContent?.trim()) return label.textContent.trim().slice(0, 256);
    }
    if (element.tagName === "LABEL") {
      return (element.textContent ?? "").trim().slice(0, 256);
    }
    if (["A", "BUTTON", "OPTION"].includes(element.tagName)) {
      return (element.textContent ?? "").trim().slice(0, 256);
    }
    const title = element.getAttribute("title")?.trim();
    return title ? title.slice(0, 256) : "";
  }

  function capabilitiesFor(element: Element, role: string): string[] {
    const capabilities = new Set<string>();
    const tag = element.tagName;
    if (tag === "A" || tag === "BUTTON" || role === "button" || role === "link") {
      capabilities.add("click");
    }
    if (tag === "INPUT" || tag === "TEXTAREA" || role === "textbox") capabilities.add("type");
    if (tag === "SELECT" || role === "combobox") capabilities.add("select");
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
      capabilities.add("scroll");
    }
    if (tag === "A" && element.hasAttribute("href")) capabilities.add("navigate");
    return [...capabilities].filter((capability) => elementCapabilities.has(capability)).slice(0, 8);
  }

  function sensitivityFor(element: Element, accessibleName: string): SensitivityHints | undefined {
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
      return sensitiveLabelPattern.test(accessibleName)
        ? { labelSuggestsSensitive: true }
        : undefined;
    }
    const input = element as HTMLInputElement;
    const inputType = input.type?.toLowerCase();
    const autocomplete = input.getAttribute("autocomplete")?.trim().toLowerCase();
    const labelSuggestsSensitive = sensitiveLabelPattern.test(accessibleName);
    if (!inputType && !autocomplete && !labelSuggestsSensitive) return undefined;
    return {
      ...(inputType ? { inputType: inputType.slice(0, 32) } : {}),
      ...(autocomplete ? { autocomplete: autocomplete.slice(0, 64) } : {}),
      ...(labelSuggestsSensitive ? { labelSuggestsSensitive: true } : {}),
    };
  }

  const elements: SafePageSnapshot["elements"] = [];
  const allElements = [document.documentElement, ...Array.from(document.querySelectorAll("*"))];
  for (const element of allElements) {
    if (elements.length >= 500 || excludedTags.has(element.tagName)) continue;
    const box = clippedBox(element);
    if (!box) continue;
    const role = roleFor(element);
    const accessibleName = labelText(element);
    const capabilities = capabilitiesFor(element, role);
    if (capabilities.length === 0 && !accessibleName && !["IMG", "LABEL"].includes(element.tagName)) continue;
    elements.push({
      id: `e-${elements.length}`,
      role,
      accessibleName,
      box,
      capabilities: capabilities as SafePageSnapshot["elements"][number]["capabilities"],
      sensitivity: sensitivityFor(element, accessibleName),
    });
  }

  const textNodes: SafePageSnapshot["textNodes"] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current && textNodes.length < 1000) {
    const node = current as Text;
    const parent = node.parentElement;
    const text = node.data.replace(/\s+/g, " ").trim();
    if (parent && text && !excludedTags.has(parent.tagName) && visible(parent)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        if (right > left && bottom > top) {
          textNodes.push({
            id: `t-${textNodes.length}`,
            text: text.slice(0, 2000),
            box: { x: left, y: top, width: right - left, height: bottom - top },
          });
        }
      }
    }
    current = walker.nextNode();
  }

  return {
    urlOrigin: location.origin,
    viewport: {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
    },
    snapshot: { elements, textNodes },
  };
}

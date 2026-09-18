import {
  MAX_ACTIONS_PER_PLAN,
  findSensitivePlaceholders,
  hasSensitivePlaceholder,
  isSensitivePlaceholderToken,
  sensitivePlaceholderRegex,
  type Action,
  type ActionPlan,
  type Box,
  type ConfirmationKind,
  type ElementCapability,
  type ExecutionOutcomeCode,
  type SanitizedObservation,
  type SensitiveVariables,
  type TargetEvidence,
} from "@orka/contracts";
import { iou } from "@orka/privacy-engine";

/**
 * The Policy module of the Safe Action Executor (phases/04-safe-execution.md).
 *
 * Everything here is a pure function over facts: the executor collects facts
 * from the live page, this module decides, and the executor acts. Keeping the
 * decisions out of the DOM is what makes the safety rules testable against
 * synthetic pages instead of only against a live browser.
 *
 * Two rules run through the whole file:
 *
 * 1. A plan is a proposal, not authority. Every decision is made against the
 *    live page, never against what the plan claims.
 * 2. Refusals are cheaper than guesses. Anything ambiguous, moved, hidden,
 *    duplicated, or irreversible is refused or confirmed by the user.
 */

/** Mirrors the contract's plan cap: the executor never out-runs it. */
export const MAX_EXECUTION_ACTIONS = MAX_ACTIONS_PER_PLAN;

/** How many role+name matches are worth reporting to the executor at all. */
export const MAX_TARGET_CANDIDATES = 8;

/**
 * Box-drift tolerance. The live box comes from `getBoundingClientRect` in CSS
 * pixels while the plan's box was recorded against the capture, so a small
 * reflow (a late font, a cookie banner closing) must not read as "moved".
 * Beyond this, the element is treated as having moved and the action is
 * refused rather than fired at a stale location.
 */
export const BOX_IOU_THRESHOLD = 0.5;
export const BOX_CENTER_TOLERANCE_PX = 24;
export const BOX_SIZE_TOLERANCE_RATIO = 0.5;

/** Hard cap on one scroll action, mirroring the contract's own bound. */
export const MAX_SCROLL_PX = 10_000;

export type TargetCapability = "click" | "type" | "select";

/**
 * One live-page element as the executor's page port reports it. Deliberately
 * facts only -- no HTML, no value, no selector, no cookie, nothing that came
 * out of page storage. `ordinal` addresses the element for the follow-up act,
 * and never leaves the extension.
 */
export type PageCandidate = {
  ordinal: number;
  role: string;
  accessibleName: string;
  box: Box;
  visible: boolean;
  enabled: boolean;
  tag: string;
  inputType?: string;
  editable: boolean;
  selectable: boolean;
  inForm: boolean;
};

export type TargetRefusalCode = Extract<
  ExecutionOutcomeCode,
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_DRIFTED"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_NOT_INTERACTABLE"
>;

export type TargetResolution =
  | { ok: true; candidate: PageCandidate }
  | { ok: false; code: TargetRefusalCode; reason: string };

export type ActionDecision = {
  decision: "allow" | "confirm" | "deny";
  /** Present when `decision === "confirm"`; drives the side-panel copy. */
  kind?: ConfirmationKind;
  /** Present when `decision === "deny"`. */
  code?: ExecutionOutcomeCode;
  /** Short, human-safe, and shown verbatim to the user. */
  reason: string;
};

/* -------------------------------------------------------------------------- *
 * Roles, names, and geometry                                                 *
 * -------------------------------------------------------------------------- */

/**
 * The snapshot reports roles from `role` attributes and tag names, so the same
 * control can arrive as `searchbox` in one and `textbox` in another. Both
 * sides of a comparison go through this.
 */
const ROLE_ALIASES: Record<string, string> = {
  searchbox: "textbox",
  listbox: "combobox",
  a: "link",
  img: "img",
};

export function canonicalRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  return ROLE_ALIASES[normalized] ?? normalized;
}

/** Collapse whitespace and case so `" Sign  in "` matches `"Sign in"`. */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function centerDistance(a: Box, b: Box): number {
  const left = center(a);
  const right = center(b);
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function sizeWithinTolerance(a: Box, b: Box): boolean {
  for (const [first, second] of [
    [a.width, b.width],
    [a.height, b.height],
  ] as const) {
    const largest = Math.max(first, second);
    if (largest <= 0) return largest === 0 || Math.min(first, second) <= 1;
    if (Math.abs(first - second) / largest > BOX_SIZE_TOLERANCE_RATIO) return false;
  }
  return true;
}

/**
 * Whether the live box is still the box the plan was built from. IoU is the
 * primary test; a center-distance fallback keeps very small controls (a 12px
 * checkbox, an icon button) from failing on a two-pixel shift, where IoU is
 * numerically useless.
 */
export function boxMatches(expected: Box, actual: Box): boolean {
  if (iou(expected, actual) >= BOX_IOU_THRESHOLD) return true;
  return (
    centerDistance(expected, actual) <= BOX_CENTER_TOLERANCE_PX &&
    sizeWithinTolerance(expected, actual)
  );
}

/**
 * Converts a box from the plan's coordinate space into the live viewport's.
 *
 * The observation is built from the capture, so its boxes are in *image*
 * pixels (`scaleSnapshot` in the background scales them up on a retina
 * display). The live DOM reports CSS pixels. On top of that, a scroll the
 * executor performed itself moves everything on the page, so the offset it
 * introduced is subtracted back out. Without both corrections a plan would
 * refuse every target on any scaled display or after its own scroll.
 */
export function toViewportBox(
  box: Box,
  screenshot: { width: number; height: number },
  viewport: { width: number; height: number },
  scroll: { x: number; y: number },
): Box {
  const scaleX = screenshot.width > 0 ? viewport.width / screenshot.width : 1;
  const scaleY = screenshot.height > 0 ? viewport.height / screenshot.height : 1;
  return {
    x: box.x * scaleX - scroll.x,
    y: box.y * scaleY - scroll.y,
    width: box.width * scaleX,
    height: box.height * scaleY,
  };
}

function describeTarget(evidence: { role: string; accessibleName: string }): string {
  const name = evidence.accessibleName.trim();
  return name
    ? `${evidence.role} "${name}"`
    : `${evidence.role} with no accessible name`;
}

/* -------------------------------------------------------------------------- *
 * Live target resolution                                                     *
 * -------------------------------------------------------------------------- */

/** What the executor may do to an element, derived from live DOM facts. */
export function candidateCapabilities(candidate: PageCandidate): ElementCapability[] {
  const capabilities = new Set<ElementCapability>();
  const tag = candidate.tag.toUpperCase();
  const role = canonicalRole(candidate.role);
  const inputType = (candidate.inputType ?? "").toLowerCase();

  const clickableTag = ["A", "BUTTON", "SUMMARY", "LABEL"].includes(tag);
  const clickableRole = [
    "button",
    "link",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "checkbox",
    "radio",
    "switch",
  ].includes(role);
  const clickableInput = ["button", "submit", "reset", "checkbox", "radio", "image"].includes(
    inputType,
  );
  if (clickableTag || clickableRole || clickableInput) capabilities.add("click");
  if (candidate.editable) capabilities.add("type");
  if (candidate.selectable) capabilities.add("select");
  if (tag === "A") capabilities.add("navigate");
  return [...capabilities];
}

/**
 * Resolves the plan's declared target against the live page.
 *
 * `evidence.box` must already be in viewport space (see `toViewportBox`). The
 * order of the checks is deliberate: "which element" first, then "can it be
 * seen", then "can it be used", and only then "is it still where the plan
 * left it". That order is what lets a refusal say *why* -- a hidden duplicate
 * reports as hidden, not as missing.
 *
 * One exception to name matching: when the plan's evidence is a redaction
 * placeholder (`[PHONE]`), the live page necessarily says something else --
 * the privacy engine rewrote the name before the planner ever saw it -- so
 * such a target is matched by role and box, and the value it may be filled
 * with is restricted to a local value the user saved. `pageActions.ts` applies
 * the same exception when it lists candidates, so both sides still agree on
 * which element is which.
 */
export function resolveTarget(
  candidates: PageCandidate[],
  evidence: TargetEvidence,
  capability: TargetCapability,
): TargetResolution {
  const nameIsPlaceholder = isSensitivePlaceholderToken(evidence.accessibleName);
  const roleName = candidates.filter(
    (candidate) =>
      canonicalRole(candidate.role) === canonicalRole(evidence.role) &&
      (nameIsPlaceholder ||
        normalizeName(candidate.accessibleName) === normalizeName(evidence.accessibleName)),
  );
  if (roleName.length === 0) {
    return {
      ok: false,
      code: "TARGET_NOT_FOUND",
      reason: `No element on this page is ${describeTarget(evidence)}.`,
    };
  }

  const visible = roleName.filter((candidate) => candidate.visible);
  if (visible.length === 0) {
    return {
      ok: false,
      code: "TARGET_NOT_VISIBLE",
      reason: `${describeTarget(evidence)} is not visible on the current page.`,
    };
  }

  const usable = visible.filter(
    (candidate) => candidate.enabled && candidateCapabilities(candidate).includes(capability),
  );
  if (usable.length === 0) {
    return {
      ok: false,
      code: "TARGET_NOT_INTERACTABLE",
      reason: `${describeTarget(evidence)} is disabled or cannot accept that action.`,
    };
  }

  const located = usable.filter((candidate) => boxMatches(evidence.box, candidate.box));
  if (located.length === 0) {
    return {
      ok: false,
      code: "TARGET_DRIFTED",
      reason: `${describeTarget(evidence)} has moved since this plan was approved.`,
    };
  }
  if (located.length > 1) {
    return {
      ok: false,
      code: "TARGET_AMBIGUOUS",
      reason: `${located.length} elements on this page match ${describeTarget(evidence)}; Orka will not guess which one.`,
    };
  }
  return { ok: true, candidate: located[0]! };
}

/**
 * Cross-checks a plan's target against the observation the user approved.
 *
 * A planner that invents a target never saw it, and a planner that targets a
 * redacted region is aiming at something the privacy engine deliberately hid.
 * Both are caught here, before the live page is touched at all.
 */
export type EvidenceCheck =
  | { ok: true; sensitive: boolean }
  | { ok: false; code: ExecutionOutcomeCode; reason: string };

export function verifyTargetEvidence(
  observation: SanitizedObservation,
  evidence: TargetEvidence,
): EvidenceCheck {
  if (!evidence.evidenceId) return { ok: true, sensitive: false };

  const node = observation.accessibilitySnapshot.find(
    (candidate) => candidate.id === evidence.evidenceId,
  );
  if (!node) {
    return {
      ok: false,
      code: "TARGET_EVIDENCE_INVALID",
      reason: "This step cites page evidence that is not in the page state you approved.",
    };
  }
  if (
    canonicalRole(node.role) !== canonicalRole(evidence.role) ||
    (!node.sensitive &&
      normalizeName(node.accessibleName) !== normalizeName(evidence.accessibleName)) ||
    !boxMatches(node.box, evidence.box)
  ) {
    return {
      ok: false,
      code: "TARGET_EVIDENCE_INVALID",
      reason: "This step's target does not match the page evidence it cites.",
    };
  }
  // A redacted node is a fact, not a refusal: the executor may still fill such
  // a field, but only from a value the user saved and approved, and never with
  // a value the planner made up.
  return { ok: true, sensitive: node.sensitive === true };
}

/* -------------------------------------------------------------------------- *
 * What needs confirming, and what is refused outright                        *
 * -------------------------------------------------------------------------- */

/**
 * Names that mark a control as credential or identity entry. Matching is
 * deliberately over-inclusive: a false positive costs the user one confirmation
 * prompt, a false negative types a password.
 */
const CREDENTIAL_NAME_PATTERN =
  /\b(password|passwd|passcode|secret|otp|one[- ]?time code|2fa|two[- ]?factor|security code|cvv|cvc|card number|credit card|debit card|account number|routing number|aadhaar|pan|ssn|social security|national id)\b/i;

/** Controls that solve or bypass a human-verification challenge. Never our job. */
const CAPTCHA_PATTERN =
  /\b(captcha|recaptcha|hcaptcha|turnstile|i'?m not a robot|not a robot|human verification|verify (?:you are|that you are) human)\b/i;

/**
 * Installing or running software, and uploading local files, are hard
 * refusals rather than confirmations: there is no version of either that a
 * V1 task needs, so the extension does not offer the user the chance to
 * approve one by habit. The first is the prompt-injection rule for "install
 * software"; the second keeps a local file from leaving the machine.
 */
const INSTALL_PATTERN =
  /\b(install|add extension|add to chrome|run installer|download and run|upload(?: file)?|attach file|choose file)\b/i;

const PURCHASE_PATTERN =
  /\b(buy|buy now|purchase|pay|payment|checkout|place order|order now|subscribe|upgrade|donate|add to cart|bid)\b/i;

const DELETE_PATTERN =
  /\b(delete|remove|erase|destroy|discard|close account|deactivate|unsubscribe|revoke|cancel (?:account|subscription|plan|order|booking|membership)|wipe)\b/i;

const SEND_PATTERN =
  /\b(send|send now|post|publish|share|message|reply|comment|invite|tweet|submit (?:post|comment|message|review))\b/i;

const DOWNLOAD_PATTERN = /\b(download|export|save file)\b/i;

const PERMISSION_PATTERN =
  /\b(allow|grant|permit|authorize|enable (?:notifications|camera|microphone|location|access))\b/i;

const ACCOUNT_SECURITY_PATTERN =
  /\b(sign in|log in|login|sign out|log out|logout|sign up|register|password|2fa|two[- ]?factor|verification code|security settings|account settings|manage account)\b/i;

const SUBMIT_PATTERN =
  /\b(submit|save|save changes|confirm|continue|next|finish|complete|apply|place (?:order|booking)|create account|register)\b/i;

export function describeCandidate(candidate: PageCandidate): string {
  const name = candidate.accessibleName.trim();
  return name ? `${candidate.role} "${name}"` : candidate.role;
}

/**
 * A control that submits the form it sits in. Clicking one is the action most
 * likely to be irreversible, so it is confirmed even when its label says
 * nothing in particular ("Go", "Continue", "→").
 */
function isSubmitControl(candidate: PageCandidate): boolean {
  const tag = candidate.tag.toUpperCase();
  const inputType = (candidate.inputType ?? "").toLowerCase();
  if (tag === "INPUT" && ["submit", "image"].includes(inputType)) return true;
  if (tag !== "BUTTON") return false;
  if (inputType === "submit") return true;
  return candidate.inForm;
}

/**
 * Classifies a click. The user sees `reason` verbatim, so it names what it
 * saw, not a rule id.
 */
export function decideClick(
  candidate: PageCandidate,
  options: { sensitiveTarget?: boolean } = {},
): ActionDecision {
  const name = candidate.accessibleName;

  if (options.sensitiveTarget) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "This step targets a region the privacy engine hid from the planner.",
    };
  }
  if (CAPTCHA_PATTERN.test(name)) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "Orka never solves CAPTCHA or human-verification challenges.",
    };
  }
  if (INSTALL_PATTERN.test(name)) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "Orka never installs or runs software from a page.",
    };
  }
  if (PURCHASE_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "purchase",
      reason: `${describeCandidate(candidate)} spends money or starts a paid commitment.`,
    };
  }
  if (DELETE_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "delete",
      reason: `${describeCandidate(candidate)} deletes or cancels something.`,
    };
  }
  if (SEND_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "send",
      reason: `${describeCandidate(candidate)} sends or publishes something on your behalf.`,
    };
  }
  if (DOWNLOAD_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "download",
      reason: `${describeCandidate(candidate)} downloads or exports data.`,
    };
  }
  if (PERMISSION_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "permission",
      reason: `${describeCandidate(candidate)} grants a permission to the site.`,
    };
  }
  // The labelled categories come before the structural one: "Sign in" is a
  // more useful thing to tell the user than "this submits a form".
  if (ACCOUNT_SECURITY_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "account_security",
      reason: `${describeCandidate(candidate)} changes account or security state.`,
    };
  }
  if (SUBMIT_PATTERN.test(name)) {
    return {
      decision: "confirm",
      kind: "submit",
      reason: `${describeCandidate(candidate)} saves or confirms a change.`,
    };
  }
  if (isSubmitControl(candidate)) {
    return {
      decision: "confirm",
      kind: "submit",
      reason: `${describeCandidate(candidate)} submits a form.`,
    };
  }
  return { decision: "allow", reason: `${describeCandidate(candidate)} is a plain navigation step.` };
}

/**
 * Replaces `[NAME]` references with the user's locally stored values.
 *
 * This is the only place a Sensitive Value becomes a string that could be
 * typed, and it is called immediately before the keystroke. A value that is
 * still a placeholder after substitution is refused rather than typed: the
 * user must never see `[PHONE_1]` appear in a form.
 */
export function resolveTypeValue(
  value: string,
  variables: SensitiveVariables,
): { ok: true; value: string; placeholders: string[] } | { ok: false; code: ExecutionOutcomeCode; reason: string } {
  const placeholders = findSensitivePlaceholders(value);
  if (placeholders.length === 0) return { ok: true, value, placeholders: [] };

  const missing = placeholders.filter((name) => !(name in variables));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "VARIABLE_MISSING",
      reason: `This step needs a private value you have not saved: ${missing
        .map((name) => `[${name}]`)
        .join(", ")}.`,
    };
  }

  const resolved = value.replace(sensitivePlaceholderRegex(), (token, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name]! : token,
  );
  if (hasSensitivePlaceholder(resolved)) {
    return {
      ok: false,
      code: "VARIABLE_MISSING",
      reason: "Orka will not type placeholder text into a page.",
    };
  }
  return { ok: true, value: resolved, placeholders };
}

/**
 * Classifies typing. Typing is always confirmed (SECURITY-PRIVACY.md), and
 * credential fields are refused outright rather than confirmed -- a
 * confirmation prompt must never be the only thing standing between a page
 * and a password.
 */
export function decideType(
  candidate: PageCandidate,
  value: string,
  variables: SensitiveVariables,
  options: { sensitiveTarget?: boolean } = {},
): ActionDecision {
  const inputType = (candidate.inputType ?? "").toLowerCase();
  if (options.sensitiveTarget && findSensitivePlaceholders(value).length === 0) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: `The privacy engine hid this field (${
        candidate.accessibleName.trim() || candidate.role
      }). Orka will only fill it from a value you saved.`,
    };
  }
  if (inputType === "password") {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "Orka never types into a password field.",
    };
  }
  if (inputType === "file") {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "Orka never chooses files to upload.",
    };
  }
  if (CREDENTIAL_NAME_PATTERN.test(candidate.accessibleName)) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: `Orka never fills credential or identity fields (${describeCandidate(candidate)}).`,
    };
  }

  const resolved = resolveTypeValue(value, variables);
  if (!resolved.ok) {
    return { decision: "deny", code: resolved.code, reason: resolved.reason };
  }
  if (resolved.placeholders.length > 0) {
    return {
      decision: "confirm",
      kind: "sensitive_value",
      reason: `Insert your saved ${resolved.placeholders
        .map((name) => `[${name}]`)
        .join(", ")} into ${describeCandidate(candidate)}. The value stays on this device.`,
    };
  }
  return {
    decision: "confirm",
    kind: "type",
    reason: `Type "${truncate(value)}" into ${describeCandidate(candidate)}.`,
  };
}

/**
 * Selection is confirmed (SECURITY-PRIVACY.md) and needs a live `<select>`. A
 * selected value can name a local value just like a typed one, so it goes
 * through the same resolution rules.
 */
export function decideSelect(
  candidate: PageCandidate,
  value: string,
  variables: SensitiveVariables,
  options: { sensitiveTarget?: boolean } = {},
): ActionDecision {
  if (options.sensitiveTarget && findSensitivePlaceholders(value).length === 0) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "This step targets a region the privacy engine hid from the planner.",
    };
  }
  const resolved = resolveTypeValue(value, variables);
  if (!resolved.ok) {
    return { decision: "deny", code: resolved.code, reason: resolved.reason };
  }
  if (resolved.placeholders.length > 0) {
    return {
      decision: "confirm",
      kind: "sensitive_value",
      reason: `Choose your saved ${resolved.placeholders
        .map((name) => `[${name}]`)
        .join(", ")} in ${describeCandidate(candidate)}. The value stays on this device.`,
    };
  }
  return {
    decision: "confirm",
    kind: "select",
    reason: `Choose "${truncate(value)}" in ${describeCandidate(candidate)}.`,
  };
}

/** Scrolling is bounded and carries no risk of its own. */
export function decideScroll(amount: number): ActionDecision {
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      decision: "deny",
      code: "BLOCKED_BY_POLICY",
      reason: "Orka only scrolls by a positive, bounded amount.",
    };
  }
  return { decision: "allow", reason: "Scroll the visible page." };
}

function truncate(value: string, limit = 80): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/* -------------------------------------------------------------------------- *
 * Navigation                                                                 *
 * -------------------------------------------------------------------------- */

/**
 * Query and fragment keys that indicate a URL is carrying a credential. A
 * planner has no business constructing one, and navigating to one would put a
 * token in the address bar and in the page's hands.
 */
const CREDENTIAL_PARAM_PATTERN =
  /^(access_token|id_token|refresh_token|token|api_key|apikey|key|secret|password|passwd|code|session|sessionid|signature|sig|auth)$/i;

export type NavigateDecision =
  | { ok: true; url: string; origin: string; isNewOrigin: boolean; reason: string }
  | { ok: false; code: ExecutionOutcomeCode; reason: string };

export function decideNavigate(rawUrl: string, currentOrigin: string): NavigateDecision {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return {
      ok: false,
      code: "NAVIGATION_FAILED",
      reason: "The plan asked for a destination that is not a valid URL.",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "BLOCKED_BY_POLICY",
      reason: "Orka only opens http or https destinations.",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: "BLOCKED_BY_POLICY",
      reason: "Orka never opens a URL with embedded credentials.",
    };
  }
  const credentialKey = [
    ...[...url.searchParams.keys()],
    ...new URLSearchParams(url.hash.replace(/^#/, "")).keys(),
  ].find((key) => CREDENTIAL_PARAM_PATTERN.test(key));
  if (credentialKey) {
    return {
      ok: false,
      code: "BLOCKED_BY_POLICY",
      reason: "That destination carries what looks like a credential in its URL.",
    };
  }
  return {
    ok: true,
    url: url.toString(),
    origin: url.origin,
    isNewOrigin: url.origin !== currentOrigin,
    reason: `Open ${url.origin}${url.pathname === "/" ? "" : url.pathname}.`,
  };
}

/**
 * Whether the user's own task text names this destination. Used to flag a
 * destination the plan chose by itself, so the panel can show it prominently
 * rather than letting it pass as an obvious step.
 */
export function destinationWasNamed(task: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const haystack = task.toLowerCase();
    return haystack.includes(host) || haystack.includes(url.toLowerCase());
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 * Pre-flight views for the side panel                                        *
 * -------------------------------------------------------------------------- */

/** Every private value a plan would need, in plan order and de-duplicated. */
export function planPlaceholders(plan: ActionPlan): string[] {
  const names: string[] = [];
  for (const action of plan.actions) {
    const value = actionValue(action);
    if (value === undefined) continue;
    for (const name of findSensitivePlaceholders(value)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function actionValue(action: Action): string | undefined {
  return action.type === "type" || action.type === "select" ? action.value : undefined;
}

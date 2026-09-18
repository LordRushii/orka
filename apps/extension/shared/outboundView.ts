import { FORBIDDEN_REQUEST_KEYS } from "@orka/contracts";

/**
 * A description of the one outbound request, for the demo's "what left this
 * device" panel (phases/05-demo-and-hardening.md: "sanitized outbound fields").
 *
 * The view is deliberately **about the payload's shape, never its contents**.
 * A list of field names, types, and counts is proof that the raw capture is
 * absent without becoming a second copy of what it proves -- a panel that
 * showed the payload's values in order to demonstrate that the values are
 * sanitized would have moved the problem, not solved it.
 *
 * It is also derived from the object actually being sent, not from a
 * hand-written list of field names: a hand-written list can only ever drift
 * into being a lie about the request.
 */

export type OutboundFieldKind = "string" | "number" | "boolean" | "array" | "object";

export type OutboundField = {
  /** Dotted path within the request body, e.g. `observation.screenshot`. */
  path: string;
  kind: OutboundFieldKind;
  /**
   * Length for a string, entry count for an array, key count for an object.
   * Never the value itself, at any depth.
   */
  size: number;
  /** What the field carries, in the request's own vocabulary. */
  note?: string;
};

/** One family of data that cannot appear in the request, and why not. */
export type AbsentFieldGroup = {
  label: string;
  detail: string;
  keys: readonly string[];
};

export type OutboundView = {
  fields: OutboundField[];
  /** Approximate size of the JSON body: base64 and JSON are ASCII, so 1 char ~ 1 byte. */
  bytes: number;
  /** True when the field list was cut short by the bounds below. */
  truncated: boolean;
  /**
   * The first forbidden key found anywhere in the body, if any. Always null in
   * a correct build; shown so a demo can state that it was checked rather than
   * assumed.
   */
  forbiddenKey: string | null;
  absent: readonly AbsentFieldGroup[];
};

/**
 * Field families that have no representation in the contract at all. Grouping
 * is presentation; membership is not -- a test asserts these groups cover
 * `FORBIDDEN_REQUEST_KEYS` exactly, so adding a forbidden key without saying
 * where it belongs fails the build.
 */
export const ABSENT_FIELD_GROUPS: readonly AbsentFieldGroup[] = [
  {
    label: "Cookies and browser storage",
    detail: "Not collected, and no field in the contract can hold them.",
    keys: ["cookie", "cookies", "localstorage", "sessionstorage", "indexeddb"],
  },
  {
    label: "Raw page source and DOM",
    detail: "The extension reads rendered, interactable elements only.",
    keys: [
      "dom",
      "domsnapshot",
      "html",
      "innerhtml",
      "innertext",
      "outerhtml",
      "rawdom",
      "sourcehtml",
      "textcontent",
    ],
  },
  {
    label: "OCR text",
    detail: "OCR classifies locally; its text is discarded, never transmitted.",
    keys: ["ocrtext"],
  },
  {
    label: "The redaction map and the original capture",
    detail: "Exact boxes and original pixels stay in extension memory.",
    keys: ["detections", "redactionmap", "originalscreenshot", "rawscreenshot"],
  },
  {
    label: "Credentials, keys, and tokens",
    detail: "Provider credentials live in the gateway's environment, not the browser.",
    keys: [
      "apikey",
      "authorization",
      "bearer",
      "credential",
      "credentials",
      "csrftoken",
      "password",
      "secret",
      "token",
    ],
  },
];

/** Bounds, so a big page cannot make this view expensive or unreadable. */
export const MAX_OUTBOUND_FIELDS = 32;
export const MAX_OUTBOUND_DEPTH = 4;

const MAX_NOTE_KEYS = 8;

function kindOf(value: unknown): OutboundFieldKind {
  if (Array.isArray(value)) return "array";
  if (value === null) return "object";
  return typeof value === "object" ? "object" : (typeof value as OutboundFieldKind);
}

function noteKeys(keys: string[]): string | undefined {
  if (keys.length === 0) return undefined;
  const shown = keys.slice(0, MAX_NOTE_KEYS).join(", ");
  return keys.length > MAX_NOTE_KEYS ? `each entry: ${shown}, ...` : `each entry: ${shown}`;
}

/**
 * Walks the request body. Arrays are summarised from their first entry's keys
 * rather than descended into: an observation carries up to 500 elements, and
 * walking every one of them would turn a summary into an inventory.
 */
function walk(value: unknown, path: string, depth: number, fields: OutboundField[]): boolean {
  if (fields.length >= MAX_OUTBOUND_FIELDS || depth > MAX_OUTBOUND_DEPTH) return true;

  const kind = kindOf(value);
  if (kind === "array") {
    const entries = value as unknown[];
    const first = entries.find((entry) => entry !== null && typeof entry === "object");
    fields.push({
      path,
      kind,
      size: entries.length,
      ...(first ? { note: noteKeys(Object.keys(first)) } : {}),
    });
    return false;
  }
  if (kind === "object") {
    const entries = Object.entries((value ?? {}) as Record<string, unknown>);
    fields.push({ path, kind, size: entries.length });
    for (const [key, entry] of entries) {
      if (walk(entry, path === "" ? key : `${path}.${key}`, depth + 1, fields)) return true;
    }
    return false;
  }

  fields.push({
    path,
    kind,
    size: kind === "string" ? (value as string).length : 1,
    ...(kind === "string" ? { note: "text, not shown" } : {}),
  });
  return false;
}

/** The first forbidden key at any depth, or null. Mirrors the gateway's own gate. */
function firstForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_OUTBOUND_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstForbiddenKey(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_REQUEST_KEYS.includes(key.replace(/[_-]/g, "").toLowerCase())) return key;
    const found = firstForbiddenKey(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

export function describeOutboundRequest(body: unknown): OutboundView {
  const fields: OutboundField[] = [];
  const truncated = walk(body, "", 1, fields);

  let bytes = 0;
  try {
    bytes = JSON.stringify(body)?.length ?? 0;
  } catch {
    // A body that cannot be serialized was never going to be sent; the size
    // figure is the least important thing this function returns.
    bytes = 0;
  }

  return {
    fields,
    bytes,
    truncated,
    forbiddenKey: firstForbiddenKey(body),
    absent: ABSENT_FIELD_GROUPS,
  };
}

/**
 * The description of a request that was never built -- an unexpected throw
 * before a body existed, or the provider-list call, which carries no
 * observation at all. Named rather than inlined as `describeOutboundRequest({})`
 * so the panel can say "nothing left this device" about a specific object
 * instead of rendering an empty list that looks like a bug.
 */
export const NO_OUTBOUND_REQUEST: OutboundView = describeOutboundRequest({});

/** `412 KB`, `1.2 MB` -- a size a person can read at demo speed. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

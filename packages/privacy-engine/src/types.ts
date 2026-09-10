import type {
  AccessibilityNode,
  Box,
  ElementCapability,
  PriorActionSummary,
  RedactionCategory,
  SanitizationFailure,
  SanitizedObservation,
} from "@orka/contracts";

export type { Box, ElementCapability, RedactionCategory };

/** Viewport captured at the moment of the screenshot. */
export type Viewport = {
  width: number;
  height: number;
  devicePixelRatio?: number;
};

/**
 * Sensitivity hints the content script may attach to an element without
 * ever reading or forwarding its value -- e.g. `inputType: "password"`
 * tells detectors "redact this box" without exposing what is typed there.
 */
export type SensitivityHints = {
  inputType?: string;
  autocomplete?: string;
  /** Label/name text suggests a sensitive field even when type isn't set. */
  labelSuggestsSensitive?: boolean;
};

/**
 * One visible/interactable DOM element as collected by the content script.
 * Mirrors `AccessibilityNode` (see packages/contracts) plus local-only
 * sensitivity hints; never carries a raw field value, HTML, or CSS.
 */
export type SafeElement = {
  id: string;
  role: string;
  accessibleName: string;
  box: Box;
  capabilities: ElementCapability[];
  sensitivity?: SensitivityHints;
};

/**
 * One visible rendered text run (e.g. a paragraph, label, or heading).
 * Never derived from hidden nodes, script/style content, or attribute
 * values such as query strings.
 */
export type SafeTextNode = {
  id: string;
  text: string;
  box: Box;
  sourceElementId?: string;
};

export type SafePageSnapshot = {
  elements: SafeElement[];
  textNodes: SafeTextNode[];
};

/** A decoded raw bitmap, kept in memory only -- never serialized as-is. */
export type RasterImage = {
  width: number;
  height: number;
  /** RGBA, length === width * height * 4. */
  data: Uint8ClampedArray;
};

/** Input to `PrivacyEngine.sanitize()`. Never leaves the local process. */
export type CaptureInput = {
  taskId: string;
  task: string;
  /** Full URL; the engine reduces this to a bare origin before it can leave. */
  url: string;
  viewport: Viewport;
  capturedAt: number;
  screenshot: RasterImage;
  snapshot: SafePageSnapshot;
  priorActions?: PriorActionSummary[];
};

export type DetectionSource = "dom" | "ocr" | "face";

/** One piece of local evidence that a region/text is a Sensitive Value. */
export type Detection = {
  category: RedactionCategory;
  confidence: number;
  source: DetectionSource;
  box: Box;
  reason: string;
};

export type RedactionMapEntry = {
  category: RedactionCategory;
  /** Final box after uncertain-detection padding has been applied. */
  box: Box;
  confidence: number;
  sources: DetectionSource[];
  reason: string;
};

/** The local-only Redaction Map (see docs/CONTEXT.md). Never serialized out. */
export type RedactionMap = RedactionMapEntry[];

export type RuntimeMode = "webgpu" | "balanced" | "wasm";
export type RuntimeOverride = "auto" | "gpu" | "balanced" | "wasm";

export type RuntimeProfile = {
  mode: RuntimeMode;
  override: RuntimeOverride;
  reason: string;
};

/**
 * Local-only audit record. May contain exact boxes and detection text, but
 * per phases/02-local-privacy-engine.md it must never be serializable as a
 * gateway request -- nothing in this module ever puts a `LocalAudit` on an
 * HTTP client, and it carries no `contractVersion`/schema tying it to the
 * gateway wire format.
 */
export type LocalAudit = {
  taskId: string;
  originalScreenshot: RasterImage;
  redactionMap: RedactionMap;
  detections: Detection[];
  createdAt: number;
};

export type SanitizationResult =
  | { ok: true; observation: SanitizedObservation; localAudit: LocalAudit }
  | { ok: false; error: SanitizationFailure };

export type AccessibilityNodeInput = AccessibilityNode;

/** The Phase 2 core interface, exactly as specified in phases/02-local-privacy-engine.md. */
export type PrivacyEngine = {
  sanitize(input: CaptureInput, profile: RuntimeProfile): Promise<SanitizationResult>;
};

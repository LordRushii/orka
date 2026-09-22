// Privacy Engine public surface (phases/02-local-privacy-engine.md). This is
// the deep-module seam other packages/apps should import through -- prefer
// these exports over reaching into subpaths directly.

export * from "./types";
export * from "./policy";
export { boxArea, intersectionArea, iou, padBox, unionBox } from "./box";
export { sanitizeUrlToOrigin, UnsafeUrlError } from "./url";
export * from "./detectors";
export { mergeDetections } from "./merge";
export {
  REDACTION_PLACEHOLDERS,
  redactAccessibilitySnapshot,
  redactScreenshot,
  summarizeRedactions,
} from "./redact";
export { redactTaskText } from "./taskText";
export { selectRuntime, type SelectRuntimeOptions } from "./runtime";
export {
  MODEL_MANIFEST,
  ModelIntegrityError,
  getManifestEntry,
  loadPinnedModel,
  loadPinnedModelSet,
  sha256Hex,
  type FetchLike,
  type ModelManifest,
  type ModelManifestEntry,
} from "./manifest";
export type { ImageEncoder } from "./encoder";
export * from "./pixel";
export { sanitize, createPrivacyEngine, type SanitizeDependencies } from "./sanitize";
export { ModelLoadFailedError } from "./sanitize";
export { scoreDetections, MATCH_IOU, type CorpusScores, type GroundTruthRegion } from "./benchmark/score";

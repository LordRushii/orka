import { CONFIDENCE_BAND_LABEL, type CategoryBandCount, type ModelVersion } from "../../shared/localReport.ts";
import type { LocalAuditView } from "../../shared/messages.ts";

/**
 * Formatting for the panel's local evidence: durations, redaction bands, model
 * versions, and the scan's own cost breakdown.
 *
 * These live apart from both the thread and the evidence panel because both
 * render them, and two copies of "how a duration reads" is how one screen ends
 * up saying `1.4 s` while the other says `1400 ms`.
 */

/** `1.2 s`, `840 ms` -- a duration a person can read without counting zeros. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  return ms >= 1000 ? `${Math.round((ms / 1000) * 10) / 10} s` : `${Math.round(ms)} ms`;
}

export function screenshotUrl(screenshot: { mimeType: string; dataBase64: string }): string {
  return `data:${screenshot.mimeType};base64,${screenshot.dataBase64}`;
}

/**
 * Confidence bands for one capture, in the order the detections were counted.
 * Bands, not scores: enough to judge the redaction, without printing the map.
 */
export function bandSummary(bands: readonly CategoryBandCount[]): string {
  if (bands.length === 0) return "No detections.";
  return bands
    .map((entry) => `${entry.category} ${CONFIDENCE_BAND_LABEL[entry.band].toLowerCase()} ×${entry.count}`)
    .join(" · ");
}

export function modelSummary(models: readonly ModelVersion[]): string {
  return models.map((model) => `${model.role} ${model.version}`).join(" · ");
}

/**
 * Where a scan's time actually went (docs2/02-pii-engine-speed.md Step 0).
 * OCR and face run concurrently, so this reports each stage's own span rather
 * than pretending they add up to the total.
 */
export function scanTimingSummary(timings: LocalAuditView["timings"]): string | undefined {
  if (!timings) return undefined;
  const ocr =
    timings.tileOcrMs.length > 0
      ? `OCR ${formatMs(timings.ocrMs)} (full ${formatMs(timings.fullImageOcrMs)} + ${timings.tileOcrMs.length} tile${
          timings.tileOcrMs.length === 1 ? "" : "s"
        } ${formatMs(timings.tileOcrMs.reduce((total, ms) => total + ms, 0))})`
      : `OCR ${formatMs(timings.ocrMs)}`;
  return `${ocr} · face ${formatMs(timings.faceMs)} · encode ${formatMs(timings.encodeMs)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}

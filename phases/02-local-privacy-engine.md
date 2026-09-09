# Phase 2 — Local Capture, Detection, and Redaction

## Purpose

Build the privacy-critical local module. Do not connect the planner until this phase produces a safe `SanitizedObservation` and fails closed on errors.

## Core interface

```typescript
type PrivacyEngine = {
  sanitize(input: CaptureInput, profile: RuntimeProfile): Promise<SanitizationResult>;
};
type SanitizationResult =
  | { ok: true; observation: SanitizedObservation; localAudit: LocalAudit }
  | { ok: false; error: SanitizationFailure };
```

`LocalAudit` may contain exact boxes and detection text only in extension memory. It must never be serializable as a gateway request.

## Build order

### 1. Capture the active tab

- Capture only after a user gesture starts a Task Session.
- Use `tabs.captureVisibleTab` with `activeTab`.
- Capture one active tab, never the desktop or background tabs.
- Record viewport dimensions and timestamp.
- Treat restricted pages and capture errors as fail-closed errors.

### 2. Collect a safe page snapshot

The content script may collect only visible/interactable elements: local ID, role, accessible name, visible box, action capabilities, and sensitivity hints such as `type=password`. Exclude hidden nodes, scripts, source HTML, CSS text, cookies, local storage, query strings, and raw field values.

### 3. Detect text PII locally

Implement deterministic detectors for password fields/labels, emails, phone numbers, Aadhaar-shaped values, PAN-shaped values, and payment-card-shaped values. Each detector returns category, confidence, source (`dom`/`ocr`), local range/box, and reason. Keep thresholds in one policy object.

### 4. Add pixel detection

- Run PaddleOCR.js in a Worker for text rendered in canvas/images.
- Run a small local face detector for faces.
- Load model assets from a pinned manifest and verify SHA-256.
- Use ONNX Runtime Web with WebGPU when selected and WASM when unavailable or too slow.
- Use OCR only for local location/classification; never send full OCR text.

### 5. Merge and redact

Merge detector outputs by category priority, expand uncertain boxes with safety padding, and produce an opaque redacted screenshot, redacted visible-element labels, a coarse category/count summary, and an in-memory exact map. Use `[EMAIL]`, `[PASSWORD_FIELD]`, `[GOVT_ID]`, `[CARD]`, and `[FACE]`; never rely on blur alone.

### 6. Add hardware adaptivity

Implement `selectRuntime()` to check WebGPU, request only required limits, run a local warm-up, select `webgpu`/`balanced`/`wasm`, and expose `Auto`, `GPU preferred`, `Balanced`, and `CPU/WASM` overrides. Do not fingerprint the user or depend on exact VRAM/RAM values.

## Fail-closed rules

- Model loading, OCR, face detection, merge, or redaction timeout returns `SanitizationFailure`.
- No gateway call is allowed after a failure.
- Uncertain detections enlarge the redaction region.
- Release the original screenshot when audit closes or the Task Session ends.

## Acceptance criteria

- Synthetic pages containing all mandatory PII produce a redacted screenshot before any network call.
- Original/redacted views work locally.
- Forced detector failure produces no outbound request.
- WebGPU and WASM produce valid observations.
- Observation fields match the contract exactly.

## Tests

- Unit tests for detectors, thresholds, overlap merge, placeholders, and URL sanitization.
- Worker tests for OCR conversion.
- Golden-image tests for redaction position and padding.
- Password-field tests with empty values: redact the field region without reading/transmitting its value.
- Runtime tests for missing WebGPU, missing adapter, warm-up timeout, and WASM override.
- Network-spy test proving sanitization finishes before planner transport can run.

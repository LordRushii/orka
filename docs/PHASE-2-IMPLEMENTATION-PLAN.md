# Complete Phase 2 Privacy Engine Repair

## Summary

Make Phase 2 fully functional while leaving planner/gateway work disabled. Preserve the current detector, merge, redaction, contract, audit, and runtime-selection work; replace the incomplete browser wiring and placeholder pixel-model dependencies.

Use the toolbar-action `activeTab` grant as the sole capture authority. Chrome requires `activeTab` or `<all_urls>` for `captureVisibleTab`; a per-origin host grant is not a substitute.

## Key Changes

- Remove the optional host-permission request and `ensureHostAccess` flow. Keep only `activeTab`, `scripting`, and `storage` in the manifest.
- Capture from the side panel only after the user opens Orka through its toolbar action. Validate that the current tab is HTTP(S), capture only that tab/window, and fail closed with a recovery message instructing the user to reopen Orka from the toolbar if the temporary grant is absent or the tab navigated.
- Keep dynamic safe-snapshot injection under the same `activeTab` grant; reject restricted pages before capture or injection. Keep raw values, HTML, storage, and query strings excluded.
- Replace the empty manifest and always-failing OCR/face placeholders with a local model manager:
  - Bundle version-pinned PaddleOCR.js `0.4.2`, PP-OCR mobile detection/recognition assets, ONNX Runtime WASM assets, and a compact UltraFace ONNX detector inside the extension.
  - Add a manifest entry for every binary with source/version, extension-local URL, SHA-256, and byte limit. Verify each asset before worker initialization; an integrity, worker, model, or inference failure returns `MODEL_LOAD_FAILED` and prevents output.
  - Run OCR in a dedicated extension Worker and convert OCR polygons to clamped boxes before applying existing deterministic PII classifiers. Run UltraFace inference in a dedicated Worker with preprocessing, confidence filtering, NMS, and coordinate conversion.
  - Configure WebGPU for `webgpu`, reduced-resolution WASM for `balanced`, and normal WASM for `wasm`. Perform real model warm-up before selecting WebGPU; preserve the existing override semantics and fall back safely.
- Wire the model manager into the background privacy engine so a successful capture can actually sanitize. Keep the planner unreachable: no gateway import, request, or transport is added in this phase.
- Explicitly release raw screenshot strings, image buffers, worker state, object URLs, and audit references on failure, Stop, timeout, audit close, and task replacement.

## Tests

- Add capture-flow tests with an injected browser API facade: active-tab success, missing `activeTab`, restricted pages, changed tab/window, capture exception, and proof that no host-permission request occurs.
- Add manifest/worker tests for every bundled hash, OCR polygon-to-box conversion, face preprocessing/NMS, worker timeout/error, WebGPU warm-up failure, Balanced scaling, and forced WASM.
- Add synthetic DOM and image fixtures containing password fields, email, phone, Aadhaar, PAN, cards, OCR-only text, and faces; assert opaque redaction boxes, padding, summaries, and no raw values in the observation.
- Add Chromium extension integration coverage for toolbar-granted capture, local original/redacted audit display, no outbound planner request before sanitization, and terminal-path memory cleanup. Keep a manual Chrome/Edge/Brave smoke checklist for the real toolbar gesture, which automated browser APIs cannot faithfully synthesize.
- Require `bun test`, `bun run typecheck`, extension production build, and the browser suite to pass before handoff.

## Assumptions

- Chrome, Edge, and Brave are the supported Phase 2 targets; Firefox remains deferred.
- OCR assets are bundled with the extension, so first scan works offline and sends no image/model request over the network.
- UltraFace is used only for local face-region detection, never recognition or identity inference.
- Phase 3 planner transport, provider selection behavior, and action execution remain unchanged and disabled.

# Phase 5 — Demo, Observability, and Hardening

## Purpose

Turn the working pipeline into a repeatable SIH demonstration and gather evidence for privacy, visual accuracy, resource use, and latency without creating sensitive telemetry.

## Demo environment

- Windows laptop with 16 GB RAM and integrated or discrete GPU.
- Latest stable Chrome, Edge, and Brave.
- One cloud provider profile and one LM Studio local profile.
- Synthetic pages only; no real credentials, Aadhaar, PAN, cards, or personal accounts.
- Gateway run directly with Bun; no Docker.

## Five scenario scripts

1. **Open a site:** “Open Instagram.” Navigate only; do not log in or use social features.
2. **Explain a new app:** Explain visible controls from the sanitized screenshot and safe accessibility snapshot.
3. **Find and summarize:** Search a public synthetic knowledge page and summarize specified results.
4. **Search/filter:** Navigate filters and sorting controls with semantic targets and confirmation.
5. **Synthetic form:** Fill non-sensitive fields and request sensitive values locally; prove they never reach the gateway.

## Local audit view

Display the original/redacted screenshot pair, detected category counts and confidence bands, runtime and model versions, selected provider, timing, sanitized outbound fields, proposed action/risk/approval/outcome, and fail-closed reason. Never persist the original, exact map, raw task, page snapshot, provider response, or sensitive variables.

## Metrics

Record only aggregated local events: capture time, scan/redaction time, runtime, gateway round trip, planner time, action time, safe resource sample, category counts, and pass/fail outcome. Present SIH weights as visual context 25%, PII recall/precision 20%, redaction precision 20%, client resources 20%, and latency 15%. Defer a formal benchmark corpus until after the first demonstration.

## Hardening checklist

- Test clean-browser install and first model-download flow.
- Verify model hashes and model-load failures.
- Inspect gateway traffic: no raw PII leaves the extension.
- Test WebGPU, Balanced, and WASM modes.
- Test cloud and LM Studio with explicit provider switching.
- Test gateway outage, provider timeout, malformed output, OCR failure, face-model failure, and capture failure.
- Test Stop, timeout, action limit, tab close, navigation, and cross-origin pause.
- Test prompt injection and malicious hidden DOM.
- Remove development logging and placeholder keys before recording.

## Final acceptance

A new evaluator can follow a short script, see local redaction before the request, observe a valid planner action, approve safe execution, and reproduce privacy failure behavior without access to raw user data.

## Test report template

For each scenario record: browser/version, runtime mode, provider/model, detection categories, scan time, planner time, total time, action result, redaction result, and any failure. Attach only sanitized screenshots and sanitized request examples.

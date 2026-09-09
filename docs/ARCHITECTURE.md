# Architecture

## System flow

```text
User task + active tab
        │
        ▼
Extension: Capture Module ──► Privacy Engine ──► Sanitized Observation
                                  │                         │
                         local audit map                    │ HTTPS only
                                  │                         ▼
                                  │                 Planner Gateway
                                  │                         │
                                  │        ┌────────────────┼───────────────┐
                                  │        ▼                ▼               ▼
                                  │    DeepSeek          OpenAI/         LM Studio
                                  │     cloud           Anthropic      localhost:1234
                                  │                         │
                                  └──── validated ActionPlan ◄┘
                                                    │
                                                    ▼
                                  Extension: Safe Action Executor
                                                    │
                                                    ▼
                                           Live DOM + user approval
```

## Modules and their interfaces

The project uses deep modules: callers use small, stable interfaces while the complicated model, browser, and provider details remain local to the implementation.

| Module | Interface | Responsibility |
| --- | --- | --- |
| Capture Module | `captureActiveTab(): CapturedTab` | Captures only the user-approved active tab and emits a visible-element snapshot. |
| Privacy Engine | `sanitize(input): SanitizationResult` | Finds PII, produces redacted pixels and text, builds the local map, or returns a fail-closed error. |
| Hardware Profile | `selectRuntime(): RuntimeProfile` | Chooses WebGPU, balanced, or WASM based on availability and a local warm-up. |
| Planner Gateway | `plan(observation): ActionPlan` | Routes safe context to one provider adapter, validates output, retains nothing. |
| Provider Adapter | `plan(observation, config): ProviderResult` | Hides OpenAI-compatible, Anthropic, DeepSeek, and LM Studio differences. |
| Safe Action Executor | `proposeAndExecute(plan): ActionOutcome` | Revalidates targets, enforces policy/confirmation, and performs browser actions. |

## On-device privacy pipeline

1. Capture a screenshot with `activeTab` permission and collect only rendered/interactable accessibility data.
2. Scan text/attributes locally: form semantics, regexes, and local classifiers identify password, email, phone, Aadhaar, PAN, and card values.
3. Run local OCR in a Worker for text rendered as pixels/canvas; run local face detection for images/video.
4. Merge overlapping detections into a `RedactionMap`; increase padding around uncertain regions.
5. Replace detected pixels with opaque category placeholders and redact corresponding textual values.
6. Create the size-capped `SanitizedObservation`; keep the detailed local map only in memory.
7. If a required detector errors, times out, or is below its confidence policy, fail closed and do not call the gateway.

## Planner protocol

`SanitizedObservation` contains: redacted task text, sanitized screenshot, sanitized visible accessibility snapshot, coarse redaction categories/locations when needed, current URL origin (not query string), and prior approved action summaries.

`ActionPlan v1` contains: `navigate`, `click`, `scroll`, `type`, `select`, `ask_user`, or `done`; every action includes a reason, risk, and semantic target evidence. The gateway rejects prose-only or invalid output. The extension rejects actions whose live DOM target does not match the claimed role, accessible name, and bounding box.

## Hardware adaptivity

- `Auto` is the default: test WebGPU support and run a tiny local warm-up; select it only when it meets configured latency/memory thresholds.
- `GPU preferred` requests hardware acceleration when available.
- `Balanced` reduces input resolution and scan frequency.
- `CPU/WASM` is always available and is the expected Firefox fallback.
- Do not depend on exact RAM, VRAM, vendor, or fingerprinting data. Display the chosen runtime and allow a user override.

## Deployment

Run the gateway directly as a Bun/TypeScript process during development and the demo; no Docker is required. It can later be deployed behind HTTPS without changing its contract. LM Studio remains localhost-only and is never silently replaced by a cloud provider.

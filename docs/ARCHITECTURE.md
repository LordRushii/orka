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
| Safe Action Executor | `execute(plan, context): ExecutionRun`, `stop(reason): void` | Revalidates each target on the live page, enforces policy and confirmation, performs bounded actions, and reports safe outcomes. `ExecutionRun` carries the per-action outcomes *and* the terminal status, so no caller has to infer why a run ended. |

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

## Safe action execution

An approved `ActionPlan` is a proposal the local executor has to satisfy, one action at a time. The
side panel sends only user decisions through `execute(plan, context)` and `stop(reason)`; everything
else stays inside the extension, in three parts:

- **Policy** (`apps/extension/shared/executorPolicy.ts`) is pure: given the facts about a live
element, it decides allow, confirm, or refuse. Refused outright: credentials, file inputs and
uploads, CAPTCHA and human-verification controls, install prompts, targets that cite evidence the
user never approved, and anything aimed at a region the privacy engine redacted. Confirmed
individually: submission, downloads, permission prompts, purchases, sends, deletions,
account/security changes, every typing and selection, every local-value insertion, and every
continuation onto a new origin. The phase brief's "no purchases, deletes, messaging, or
permission expansion" rule is enforced as *never without an explicit per-step decision* rather
than as a flat refusal -- the same reading as `SECURITY-PRIVACY.md`'s action policy, and the
stricter one where the two overlap: the executor never takes such a step on its own.
- **Live revalidation** happens immediately before each action, not at approval time. The target is
re-resolved against the DOM and must still match role, accessible name, visible and enabled state,
and a bounding box within tolerance. That visible/enabled/interactable state is read from the live
element rather than carried by the plan: a plan's claim about itself is not evidence, and hidden
elements never enter the observation at capture, so the citation is role, name, evidence ID, and box
only. Missing, hidden, disabled, moved, or duplicated targets are
refused, and the run stops rather than trying the next step against a page it no longer understands.
A target cited by a redaction placeholder (`[PHONE]`) is matched by role and box, because the live
page necessarily still carries the real name.
- **Bounded scope**: one active tab, no hidden or background-tab action, at most 10 browser actions,
at most 90 seconds, and no automatic cross-origin continuation.

Sensitive Values stay local throughout. A plan may name one by bracket (`[PHONE_1]`); the executor
resolves it in memory right before the keystroke, only after the user confirms that variable by name,
and never writes the resolved value into an outcome, an event, an audit, or a request. `done` ends
the Task Session and clears them; a plan that ran to its end still reaches `completed` rather than
being cut off by the session's own action cap.

Page text, OCR output, labels, and visual instructions remain untrusted data: the executor never
takes an instruction from the page, so injected text can raise a confirmation but never lower one.

## Hardware adaptivity

- `Auto` is the default: test WebGPU support and run a tiny local warm-up; select it only when it meets configured latency/memory thresholds.
- `GPU preferred` requests hardware acceleration when available.
- `Balanced` reduces input resolution and scan frequency.
- `CPU/WASM` is always available and is the expected Firefox fallback.
- Do not depend on exact RAM, VRAM, vendor, or fingerprinting data. Display the chosen runtime and allow a user override.

## Deployment

Run the gateway directly as a Bun/TypeScript process during development and the demo; no Docker is required. It can later be deployed behind HTTPS without changing its contract. LM Studio remains localhost-only and is never silently replaced by a cloud provider.

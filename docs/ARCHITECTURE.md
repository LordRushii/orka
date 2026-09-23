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
| Local Reporting | `measure(phase, work): Promise<T>`, `describeOutboundRequest(body): OutboundView`, `summarizeConfidenceBands(detections)` | Produces the demo's local evidence: aggregated phase timings, the request described by shape, and the audit view's confidence bands and model versions. Numbers and field names only -- no module here has a field for page content. |
| Chat Transcript | `reduceTranscript(turns, event, { round }): ChatTurn[]` | Pure view over the session events the panel already receives: one turn per proposed step, prompt, outcome, and ending. Extension-local -- it has no path to the gateway, and it never decides anything. |

## On-device privacy pipeline

1. Collect rendered/interactable accessibility data with `activeTab` permission. A round captures a
   screenshot only when it needs one (an "explain / describe / what is visible" task, or a step whose
   target the snapshot could not resolve); the default round reads the accessibility tree alone.
2. Scan text/attributes locally: form semantics, regexes, and local classifiers identify password, email, phone, Aadhaar, PAN, and card values. These DOM detectors run on every round.
3. Only when a screenshot was captured: run local OCR in a Worker for text rendered as pixels/canvas, and local face detection for images/video.
4. Merge overlapping detections into a `RedactionMap`; increase padding around uncertain regions. A snapshot-only round merges against the viewport bounds, since its boxes are already in viewport space.
5. Replace detected pixels with opaque category placeholders and redact corresponding textual values. With no capture there are no pixels to replace, and the textual redaction is unchanged.
6. Create the size-capped `SanitizedObservation`; keep the detailed local map only in memory.
7. If a required detector errors, times out, or is below its confidence policy, fail closed and do not call the gateway. A screenshot-bearing round that cannot be captured fails closed too, rather than silently proceeding without the pixels it asked for.

Speed notes (docs2/02-pii-engine-speed.md): OCR and face detection run **concurrently** on their separate workers, so a scan pays `max(t(OCR), t(face))` rather than their sum; the pixel workers compile their ONNX graphs **once per session**, not per round; and each worker reports the execution provider it actually bound, so a silent WebGPU→WASM fallback is visible in the audit panel instead of being claimed away. Every scan records measured spans (`SanitizationTimings`) on the local-only audit, and the corpus regression gate bounds any tile-budget change: recall cannot be traded for latency without the test going red. That bound is asserted rather than assumed -- the harness runs its small-text fixture again at a cut budget and fails if recall *stops* falling (`maxTiles` 8 keeps its 8px text; 2 costs it). Captures are **device-pixel** (`tabs.captureVisibleTab`), so a hi-DPI page's tiled pass is load-bearing detail rather than redundancy, and downscaling the capture to the detector budget is not a safe way to remove it.

## Planner protocol

`SanitizedObservation` contains: redacted task text, a sanitized visible accessibility snapshot, a sanitized screenshot **on vision rounds only**, coarse redaction categories/locations when needed, current URL origin (not query string), and prior approved action summaries. A snapshot-only observation simply carries no screenshot field; every adapter sends it as a text-only planner request, and the gateway's image-size check is skipped because there is no image.

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
- **Bounded scope**: one active tab, no hidden or background-tab action, no fixed round ceiling but
at most 90 seconds of active work each round (approval time excluded, every round user-approved),
and no automatic cross-origin
continuation. Each round reads the page (snapshot only by default; see the vision-free fast path
below), plans exactly one step, waits for approval, and runs that one step; the next round
re-reads the page before it plans.
- **Vision-free fast path**: a round is snapshot-only unless the task asks the page to be seen or a
snapshot-only step could not resolve its target. Skipping the capture removes the local OCR and
face scan for that round. One such failure may switch the rest of the session to vision rounds
(`StepRun.needsVision`), which the loop answers by re-observing with pixels and re-planning once;
a vision round that fails is not retried on that basis, so an unresolvable target still fails.

Sensitive Values stay local throughout. A plan may name one by bracket (`[PHONE_1]`); the executor
resolves it in memory right before the keystroke, only after the user confirms that variable by name,
and never writes the resolved value into an outcome, an event, an audit, or a request. `done` ends
the Task Session and clears them; a plan that ran to its end still reaches `completed` rather than
being cut off by the session's own action cap.

Page text, OCR output, labels, and visual instructions remain untrusted data: the executor never
takes an instruction from the page, so injected text can raise a confirmation but never lower one.

## Local reporting and the demo

Phase 5 turns the working pipeline into something a person can watch and check. Three modules carry
that, and all three are shaped by the same rule: **show the shape of what happened, never a copy of
it.**

- **Local metrics** (`apps/extension/shared/metrics.ts`) times each phase -- capture, scan and
  redact, gateway round trip, planner, execution -- into one aggregate per Task Session, alongside the
  runtime mode, the category counts the observation already carries, a local JS heap sample when the
  browser reports one, and the outcome. A sample is a phase name, a duration, and a count; there is no
  field for text, a URL, or a detection location. It lives for one session and is never persisted.
  The scan phase reports its own breakdown next to the audit images -- the full-image OCR pass, each
  native-resolution tile, face detection, and encode, as measured spans (`SanitizationTimings`). OCR
  and face run concurrently, so those spans are each stage's own cost, not parts of a sum.
- **The outbound view** (`apps/extension/shared/outboundView.ts`) describes the actual gateway request
  by field path, kind, and size. It is derived from the request body, so it cannot drift into a
  flattering description of a payload that changed, and it refuses to print a value at any depth --
  a panel that showed the payload in order to prove the payload is sanitized would have moved the
  problem rather than solved it.
- **Confidence bands** (`apps/extension/shared/localReport.ts`) reduce the Redaction Map to high,
  medium, and low counts per category. Enough to judge a redaction; not enough to rebuild the map.

**The honest limit.** The SIH weights include three figures -- visual context, PII recall/precision,
and redaction precision -- that need labelled ground truth, which a browser does not have. V2 adds a
checked-in synthetic corpus (`packages/privacy-engine/fixtures/benchmark-corpus/`) with hand-labelled
ground truth and an IoU scoring harness, so PII recall/precision and redaction coverage are now
**measured, regression-gated numbers** (`benchmarkCorpus.test.ts` fails if any metric drops below the
checked-in baseline). The panel still marks them conservatively; the corpus is a local benchmark over
synthetic pages, not a live measurement. It also proves its own sensitivity: the tile budget is only
"bounded" if cutting it moves a metric, so the harness asserts that cutting `maxTiles` to 2 costs its
8px small-text run. Speed changes measured on real hardware still come from `SanitizationTimings` in
the audit panel, because a synthetic recognizer cannot produce an honest wall clock. Visual context remains not measurable locally, and
`SIH_WEIGHTS` carries a `measurableLocally` flag for exactly this reason.

`docs/PHASE-5-DEMO.md` is the runbook; `docs/PHASE-5-HARDENING.md` maps each hardening item to the
test that verifies it, and says plainly which ones need a person.

## Side panel

The panel is **a conversation, not a form**. A user turn states a task in plain language; each Orka
turn is one event -- a proposed step, a prompt, an outcome, or the ending -- appended in the order
it happened. The controls that gate a run are embedded **in the turn that needs them** (approve the
step; allow once / deny and stop on a confirmation; continue / stop here on a planner question),
because a prompt detached from the step it belongs to is a prompt people answer without knowing
what they are answering.

Two things are load-bearing here:

- **The transcript is a view, not a second state machine.** `reduceTranscript`
  (`apps/extension/shared/chatTranscript.ts`) is a pure reducer over the same `ExtensionMessage`
  union the panel already handles, so `TaskSession` stays the only thing that decides what may
  happen. `ChatTurn` is extension-local and never crosses the gateway: `PlanRequest`/`PlanResponse`
  are unchanged, called once per round. The thread is released with the session (dismiss, or a new
  task), so a drafted value cannot outlive the run it belonged to.
- **A step's review turn shows the drafted value in full.** The executor's `reason` clips it at 80
  characters (`executorPolicy.ts` `truncate`), which is right for a log line and useless for a
  decision; the turn carries `action.value` whole, in its own block, untruncated and without a line
  clamp. A rendering test asserts the printed value equals the drafted string.

**The local evidence stays outside the conversation.** Local audit and What left this device are a
persistent section with its own bounded height: the thread is the flexible region that scrolls, and
the evidence does not scroll away with it. A person deciding on a step can always look down and see
what was redacted and what left the machine, at the moment they are deciding. Both sections render
even when empty, so "nothing yet" is never mistaken for a missing panel.

## Hardware adaptivity

- `Auto` is the default: test WebGPU support and run a tiny local warm-up; select it only when it meets configured latency/memory thresholds.
- `GPU preferred` requests hardware acceleration when available.
- `Balanced` reduces input resolution and scan frequency.
- `CPU/WASM` is always available and is the expected Firefox fallback.
- Do not depend on exact RAM, VRAM, vendor, or fingerprinting data. Display the chosen runtime and allow a user override.

## Deployment

Run the gateway directly as a Bun/TypeScript process during development and the demo; no Docker is required. It can later be deployed behind HTTPS without changing its contract. LM Studio remains localhost-only and is never silently replaced by a cloud provider.

# Plan — V2: Multi-Step Agent, Redaction Quality, Conversational Panel

Status: **draft, not started**. This is a planning document, not a spec that has been reviewed
against every edge case the way `PRD.md` / `ARCHITECTURE.md` / `SECURITY-PRIVACY.md` were for V1.
Treat every "requirement" below as a proposal to confirm before a phase begins, especially the two
items marked as open scope decisions in §7.

## 0. Where V1 actually stands today

All five V1 phases are built, tested, and merged (`phases/01` through `phases/05`). Concretely, right
now:

- 565 automated tests pass (`bun test`), typecheck is clean, the extension builds.
- The gateway defaults to `lmstudio` (no key needed); `mock` still exists for tests/demo but is no
  longer enabled by default — an operator opts it in via `ORKA_ENABLED_PROVIDERS`.
- Screenshots are encoded as PNG only (WebP was silently undecodable by some local vision runtimes,
  including LM Studio's).
- The planner prompt spells out the full `{role, accessibleName, box}` target shape for every action
  type, not just `click` — smaller local models were omitting `box` on `type`/`select` targets.
- `ORKA_PLAN_TIMEOUT_MS` is configurable up to a hard 120 s cap; it defaults to 30 s in code.
- Verified end-to-end against a real local model (Qwen3-VL-4B-Instruct via LM Studio, GPU-offloaded)
  on the Phase 5 synthetic fixtures.

**The one-shot planning limit that matters for this document:** a Task Session captures exactly one
screenshot, sends exactly one `/v1/plan` request, and the model must return its entire action sequence
(up to `MAX_ACTIONS_PER_PLAN = 10`) against that single, now-stale-the-moment-page-changes observation.
The executor re-validates each target against the live DOM immediately before acting, but it never
re-captures or re-plans mid-run. `SanitizedObservation.priorActions` and the prompt's "PRIOR APPROVED
ACTIONS" section already exist in the contract for a multi-round future — nothing populates them today.

Everything in this document is about closing that gap, plus two things the user asked for alongside
it: better redaction, and a side panel that feels like a conversation rather than a form.

## 1. Problem

V1 proves the privacy pipeline and a single supervised action. It cannot do the thing users actually
want from an "agent": *read something on the page, understand a short instruction, draft a
multi-step response, show it, and act only once approved* — e.g. "reply to this email: we'll do the
meeting Monday" should read the open email, draft a reply in Gmail's compose box, and stop for an
explicit send decision, none of which fits into one blind multi-action plan.

## 2. Goals

1. Replace the single blind plan with an **iterative observe → propose → confirm → act → re-observe
   loop**, so each step is planned against what the page actually looks like *after* the previous one.
2. Raise the **privacy engine's redaction speed and accuracy**, and make both measurable rather than
   asserted (Phase 5 explicitly deferred a benchmark corpus — V2 is where that debt gets paid).
3. Replace the side panel's single-task form with a **conversational interface**: free-form chat
   turns, inline drafts/summaries, and an explicit hand-off from "talking" to "acting."
4. Do all of the above **without weakening any V1 non-negotiable**: sanitize-before-network,
   fail-closed, live-DOM re-validation, per-step confirmation for consequential actions, no persistent
   storage of raw content, and no key ever touching the browser.

## 3. Non-goals (for now)

- Multi-tab or background-tab orchestration. Still one active tab, one Task Session.
- Autonomous send/message/purchase/delete without an explicit, freshly-rendered confirmation. §7
  covers exactly what does and doesn't change here.
- A hosted, multi-user gateway. Still a local Bun process per `TECH-STACK.md`.
- Perfect PII recall. Goal 2 is "measured and improved," not "solved."

## 4. The reference scenario

This is the worked example the rest of the document is designed against — not because email is a
launch target (see §7), but because it's the smallest scenario that forces every architectural
question:

> User opens Gmail, has an email open, and tells Orka: *"Reply: we'll do the meeting Monday."*

Walked through the proposed loop:

1. **Capture + sanitize** the current screenshot (the open email). Same pipeline as today.
2. **Plan, round 1**: the model sees the email body (not itself a redacted category — see §5.2 on why
   that's a deliberate, existing behavior, not a new hole) and the task. It proposes a **small** step,
   not a whole plan: `click` the "Reply" control. Confirmed under the existing `send`-pattern kind
   (today's policy already treats "Reply" as a confirm, since the label matches `SEND_PATTERN`).
3. User approves. Executor performs the click, **then the loop re-captures** the page instead of
   moving to a queued next action.
4. **Plan, round 2**: model sees the now-open compose box, drafts reply text from the task and the
   email content, proposes a `type` action with the drafted body as `value`. This is a real behavior
   change from V1: composing prose from page content, not just following an instruction literally.
5. User sees the **exact text about to be typed** in the confirmation (already true today —
   `decideType` always confirms — but the panel now needs to show it as a draft, not a one-line
   dialog; see §5.3).
6. Executor types it, **re-captures again**.
7. **Plan, round 3**: model proposes `click` on "Send." Confirmed under the existing `send` kind —
   this is the one and only place sending actually happens, and it is never reached without a human
   clicking "Allow once" on a freshly re-rendered page showing the exact drafted text.
8. `done`.

Nothing about step 7 is new policy — `send` is already a `confirm`, not an `allow`. What's new is
steps 1–6: the model gets to *see* the result of its own action before proposing the next one, and the
prompt needs explicit permission to draft prose from page content, which it doesn't have today (see §7).

## 5. Technical requirements

### 5.1 The planning loop (extension + gateway + contracts)

This is the core change. Today: one `PLAN_READY` → one `APPROVE_PLAN` → executor runs the whole
`ActionPlan`. Proposed:

- **Contracts** (`packages/contracts`): introduce a bounded **step count** per Task Session,
  independent from `MAX_ACTIONS_PER_PLAN`. A plan response becomes 1–2 actions at a time (typically
  one action plus an optional trailing `done`/`ask_user`), not up to 10 blind ones. Reuse
  `PriorActionSummarySchema` (already defined, already capped at 10, currently always empty) as the
  loop's memory: each new `/v1/plan` call includes the outcome of every prior step in *this* session.
- **Gateway stays stateless.** No new server-side session state — the extension already holds
  everything needed (the running list of prior action summaries) and resends it each round. This
  matches `ARCHITECTURE.md`'s "retains nothing" rule for the gateway and keeps the provider adapters
  unchanged in shape; only the request cadence changes.
- **Executor** (`apps/extension/shared/executor.ts`): change from "run the whole approved plan" to
  "run the approved step, then signal the background task to re-capture and re-plan" instead of
  advancing to the plan's next queued action. `runExecution`/`planTask` in `background.ts` need a real
  loop: `scan → plan → approve → execute-one-step → scan → plan → ...` until `done`, `ask_user`,
  denial, or a limit is hit.
- **Session budget.** `TaskSession`'s existing 10-action / 90-second cap (`packages/contracts/src/
  session.ts`) was sized for one blind plan run to completion, not N round trips each including a
  human confirmation pause and a fresh model call. Multi-round realistically needs either a larger
  wall-clock budget, or a budget that excludes time spent waiting on the user (i.e., only clocks
  capture+scan+plan+act, not "awaiting_approval"). **This is an open decision, not a default I'll
  quietly pick — flag it for review before Phase 6 starts** (see §7).
- **Cost/latency**: N round trips means N images sent, N OCR/face scans, N model calls. This is the
  direct trade-off for reacting to real page state instead of guessing ahead — acceptable for a
  five-step email reply, expensive for anything approaching the 10-action cap. Worth capping *steps*
  more tightly than 10 for the multi-round mode specifically (e.g., a lower `MAX_STEPS_PER_SESSION`
  distinct from `MAX_ACTIONS_PER_PLAN`), rather than reusing the same constant for both meanings.

### 5.2 Privacy engine: speed and accuracy

Today's numbers from real usage this session: local scan (`Scan and redact`) ran around 6.3 s on a
real page; PRD's target was "typically under two seconds." Two independent tracks:

**Speed:**
- Profile where the 6.3 s actually goes — OCR (`OCR_TIMEOUT_MS = 45s` budget, PaddleOCR mobile model)
  vs. face detection (`FACE_TIMEOUT_MS = 10s`, UltraFace) vs. encode. Likely the OCR pass on a full
  1280×800+ capture dominates; tiling or downscaling the OCR input (separately from the vision-model
  screenshot) is the first thing to measure, not guess at.
- Revisit runtime selection (`Auto`/`GPU preferred`/`Balanced`/`WASM` in `packages/privacy-engine`):
  confirm WebGPU is actually being selected on capable hardware and not falling back silently.
  `plannerOrdering.test.ts` already asserts ordering holds across modes; it does not assert *speed*
  across modes, which is the actual gap.
- Model warm-up/caching: confirm the ONNX sessions are created once per Task Session's model manager
  lifetime, not re-initialized per scan (`WORKER_INIT_TIMEOUT_MS = 30s` suggests init itself is not
  cheap; verify it isn't repeated).

**Accuracy:**
- Phase 5's hardening doc explicitly deferred a labelled benchmark corpus — three of five SIH weights
  (visual context, PII recall/precision, redaction precision) are reported as "not measurable
  locally" for exactly this reason. V2 should build that corpus: a small, synthetic (never real-PII)
  set of pages with hand-labelled ground truth for email/phone/card/govt-id/password-field/face
  regions, so precision/recall become real numbers instead of permanently blank.
- Widen category coverage if the corpus shows gaps — e.g. postal addresses, full names next to a
  known-sensitive field, or additional govt-id formats beyond what `CREDENTIAL_NAME_PATTERN`/OCR regex
  currently catch.
- Confidence-band calibration: today bands are high/medium/low (`localReport.ts`); once there's a
  labelled corpus, check whether the band thresholds actually correlate with real precision, and
  retune if not.
- **Note on email body text specifically** (relevant to §4): Orka's redaction targets *categories*
  (`EMAIL`, `PASSWORD_FIELD`, `PHONE`, `GOVT_ID`, `CARD`, `FACE`), not "this is personal correspondence
  therefore hide it." An email's prose body is not itself in a redacted category today, by design —
  the model already can read visible page text to summarize/explain pages (Scenario 2 in the Phase 5
  demo). Drafting a reply from that same visible text is not a new privacy hole; it is using an
  existing, deliberate allowance for a new purpose. If a labelled sender address or signature block
  contains an email/phone, that part is already redacted as it is today.

### 5.3 Conversational side panel

Current UI (`apps/extension/entrypoints/sidepanel/App.tsx`) is single-task: one task string, one
settings form, one running state. Proposed shape:

- **A message thread**, not a form: user turns (free text) and Orka turns (a proposed step with its
  draft/preview, a question, a summary, or a terminal result), rendered in order.
- **Two turn kinds from the user**, distinguished by intent rather than by a separate UI mode:
  a *question* ("what does this page do?") stays in the existing no-action `done` shape (Phase 5
  Scenario 2); a *task* ("reply: ...") enters the planning loop from §5.1. The model already
  disambiguates this today (`ask_user` vs `done` vs an action plan) — the UI needs to render whichever
  it gets as a chat turn instead of a fixed set of cards.
- **Inline step review**: each proposed step (§4 steps 2, 4, 7) renders as an Orka turn showing the
  target, the drafted value in full (not truncated the way `describeCandidate`'s reason string is
  today), and the same Allow-once / Deny-and-stop controls that exist now — just embedded in a chat
  bubble instead of a modal-style confirmation card.
- **Local audit stays a side panel, not a chat turn** — the existing "Local audit" / "What left this
  device" cards (`localReport.ts`, `outboundView.ts`) remain a persistent, always-visible panel
  section per session; folding them into the scrolling chat thread would bury the one part of the UI
  whose entire purpose is to always be checkable.
- **State plumbing**: `useTaskSession.ts` currently models one `TaskState` per session; a chat needs a
  transcript (ordered turns) alongside it. This is additive — `TaskSession`'s state machine
  (`packages/contracts/src/session.ts`) doesn't need to change, since it already governs one Task
  Session's lifecycle; the transcript is a new view over the same session events, not a replacement
  state machine.

### 5.4 Provider-adapters and prompt

- `buildPlannerUserText` (`packages/provider-adapters/src/prompt.ts`) needs the "PRIOR APPROVED
  ACTIONS" section to actually receive non-empty `priorActions` once §5.1 wires it up — the prompt
  text already exists and was written for this.
  Every adapter (`lmstudio`, `deepseek`, `openai-compatible`, `anthropic`) is unaffected in shape; the
  same `plan(observation, model)` contract just gets called more often per Task Session.
- The system prompt's explicit instruction to draft prose (not just cite/click) needs to be added
  deliberately for the reply-drafting behavior in §4 — today's prompt says nothing about composing
  new text into a `type` action's `value`; it only covers citing bracketed local-value names. This is
  a real, additive prompt change, not implied by the existing rules.

## 6. Contract sketch (not final — for review)

```text
SanitizedObservation.priorActions   -- already exists; starts actually being populated
StepBudget                          -- new: separate cap from MAX_ACTIONS_PER_PLAN for round-trip count
ChatTurn                            -- new, side-panel-only, not sent to the gateway:
  { role: "user" | "orka", kind: "message" | "step" | "question" | "result", ... }
```

`ChatTurn` is deliberately extension-local. The gateway's request/response contract
(`PlanRequest`/`PlanResponse`) does not need a chat concept — it stays exactly what it is today, called
more often.

## 7. Open scope decisions — do not start Phase 6/9 until these are answered

1. **Session budget shape for multi-round.** Keep one wall-clock 90 s budget across N rounds (tight,
   may make 3+ round tasks fail routinely), or split into a per-round budget plus a round count cap,
   or exclude `awaiting_approval` time from the clock. Recommendation to discuss, not decided: cap
   *rounds* (e.g. 6) independently from the existing 90 s wall clock, and keep the wall clock but
   reset it per round rather than per session — but this changes a documented `SECURITY-PRIVACY.md`
   invariant and needs a conscious sign-off, the same way the earlier `TASK_SESSION_TIMEOUT_MS`
   question did.
2. **Messaging-class actions.** `README.md`/`PRD.md` currently list messaging as explicitly out of
   scope, and the planner prompt is told to refuse it outright. The email scenario in §4 requires
   lifting that refusal for `send`/`reply`/`post`-labelled controls specifically. Proposed guardrail if
   this is approved: gate it behind an explicit, off-by-default setting (e.g. "Allow drafting messages
   for my review" in the side panel), separate from the provider/runtime settings, so a fresh install
   still refuses messaging by default exactly as today. The executor's per-step `confirm` (never
   `allow`) on `send`-pattern controls stays regardless — this setting only changes whether the
   *planner* is permitted to propose the step at all, not whether it runs without a human clicking
   "Allow once" on the freshly rendered draft.

Both are product/security decisions, not implementation details, which is why they're called out
separately from §5 rather than folded into a phase's task list.

## 8. Proposed phase breakdown

Mirrors the `phases/` numbering already in the repo.

- **Phase 6 — Multi-round planning loop.** §5.1 end to end, using the existing single-action `click`/
  `type`/`select` actions with no new action types. Exit criteria: the Phase 5 fixtures extended with
  a two-round scenario (e.g. select-then-type) complete via re-planning, not a pre-baked multi-action
  plan; `priorActions` is populated and asserted non-empty in a test; session-budget decision from §7
  item 1 is implemented as decided, not left as today's single-shot 90 s.
- **Phase 7 — Privacy engine speed and accuracy.** §5.2. Exit criteria: a checked-in synthetic
  labelled corpus, a measured precision/recall number replacing "not measurable locally" for at least
  one SIH weight, and a measured scan-time improvement on the same baseline hardware used for the V1
  demo.
- **Phase 8 — Conversational side panel.** §5.3. Exit criteria: the Phase 5 five scenarios all still
  pass when driven through the chat transcript UI instead of the current single-task form, and the
  Local Audit / Outbound View cards remain intact and un-buried.
- **Phase 9 — Drafting and messaging, behind opt-in.** §7 item 2, once decided. Exit criteria: the
  reference scenario in §4 runs end to end against a real Gmail-like fixture (synthetic, per the
  existing Phase 5 policy against real third-party sites) with the setting off by default, on by
  explicit opt-in, and a send never executing without a fresh, visible draft and an explicit
  confirmation on that exact rendered text.
- **Phase 10 — V2 demo and hardening.** Same shape as Phase 5's runbook/hardening pair, covering the
  new loop, the new UI, and the new opt-in setting specifically — not a re-run of Phase 5's own
  checklist.

## 9. Non-negotiables carried forward, unchanged

Every one of these from `README.md`/`SECURITY-PRIVACY.md` still applies, and nothing in this document
proposes touching them:

- Sanitization completes before any network request; a sanitization failure fails closed.
- Page/email text is untrusted data, never agent instruction — drafting *from* it (§5.2) is not the
  same as obeying instructions embedded *in* it; the trust-boundary rule in the prompt is unchanged.
- The executor accepts only schema-validated plans and rechecks a live DOM target immediately before
  every action, every round.
- A user can see current state and Stop at any time, in every round, not just the first.
- No provider credential ever reaches the browser; no raw screenshot, DOM, or OCR text ever leaves it.

## 10. Success criteria for V2

- The reference scenario in §4 completes end to end on a synthetic fixture, with a visible draft and
  an explicit send confirmation, and it is impossible in code (not just by convention) for a send to
  fire without that confirmation on the freshly re-rendered page.
- Redaction speed and at least one accuracy figure are measured against a checked-in labelled corpus,
  not asserted.
- The side panel is a chat transcript that still exposes the same Local Audit / Outbound View evidence
  V1 has, just not as the only interface shape.
- All existing V1 tests still pass; the multi-round loop and chat UI are additive, not replacements
  that regress what Phase 5 already hardened.

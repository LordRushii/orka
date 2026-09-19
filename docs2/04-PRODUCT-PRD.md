# 04 — Product PRD: Orka as a usable multi-step agent

This is the product spine. `docs/PRD.md` describes V1 (single supervised action).
[01](01-agent-loop-speed.md)/[02](02-pii-engine-speed.md)/[03](03-pii-engine-accuracy.md) are the
speed/accuracy levers. This doc says **what the finished product does for a user**, and turns it
into phases precise enough to code from. Coding starts against this doc (see
[05-BUILD-ORDER.md](05-BUILD-ORDER.md)).

---

## 1. The product, from the user's seat

1. User clicks the Orka toolbar icon. A **chat panel** opens on the right (side panel).
2. The panel is a conversation, not a form. The user types a task in plain language:
   *"Reply to this email: we'll do the meeting Monday."*
3. Orka works the task **one step at a time**, showing each step as a chat turn:
   - "I'll click **Reply**." → user taps **Approve** in the bubble → Orka clicks it.
   - Orka re-reads the page, drafts the reply, and shows the **full drafted text** in a bubble:
     "Here's the draft — ready to send?" → user taps **Approve** → Orka clicks **Send**.
   - "Done — the reply was sent." The session ends and the panel is **ready for the next task**.
4. At every step the user can read exactly what Orka is about to do and tap **Stop**.
5. A persistent, non-scrolling **Local Audit / What left this device** section stays visible the
   whole time, so the user can always check what was redacted and what was sent.

The same shape covers non-messaging work: "summarize this page" (one `done` turn, no actions),
"find the cheapest flight and filter to nonstop" (several click/select rounds), "fill this form with
my saved values" (type rounds with per-step confirmation).

## 2. The privacy contract, unchanged in spirit

Every round, before anything leaves the browser:

- The screenshot is captured locally, and **both visual and textual PII are redacted on-device** —
  faces and on-screen text (OCR) via the pixel pipeline, DOM/accessibility text via the deterministic
  detectors. Redaction completes **before** any network call; a failure **fails closed**.
- Only the **redacted** screenshot + **redacted** accessibility snapshot + **redacted** task text go
  to the gateway. Raw pixels, raw DOM, raw OCR text never leave.
- The **gateway is model-agnostic and stateless**: it forwards the sanitized observation to whatever
  model the operator configured — a local LM Studio model (default, no key) or a cloud model behind
  an API key that lives only in the gateway env. It plans, returns a **1–2 action step**, and retains
  nothing. All cross-round memory (prior approved actions) lives in the extension and is **resent**
  each round.
- The returned plan is a **proposal, not authority**: the executor re-resolves every target against
  the live DOM immediately before acting, and consequential steps (send/reply/post/submit) always
  stop for a human tap on the freshly-rendered page.

## 3. What changes from V1 (architecture deltas)

| Area | V1 today | V2 product |
|---|---|---|
| Flow | `scanTask → planTask → awaiting_approval → runExecution` runs the **whole** plan | **Loop**: scan → plan one step → approve → execute one step → scan → … until `done`/`ask_user`/deny/limit |
| State machine (`packages/contracts/src/session.ts`) | no edge from `executing` back to `scanning` | new `NEXT_ROUND: executing → scanning`; round + per-round-time budgets |
| Executor (`apps/extension/shared/executor.ts`) | runs `plan.actions[0..n]` in a for-loop | runs **exactly one** approved step, hands control back to the loop |
| Memory | `priorActions` always empty | populated each round with what was **approved + executed** |
| Panel (`sidepanel/App.tsx`, `useTaskSession.ts`) | single-task form + cards | **chat transcript** of user/Orka turns; Local Audit stays a fixed panel |
| Messaging | planner refuses outright | opt-in `allowDraftingMessages`; send still always confirmed |
| Gateway | stateless, one call per task | **stays stateless**; called once per round |

Nothing above adds a new action type — the seven (`navigate`, `click`, `scroll`, `type`, `select`,
`ask_user`, `done`) are unchanged. What changes is cadence + memory + UI + the messaging opt-in.

## 4. Budgets (Decision 1, from the execution prompt)

- `MAX_ROUNDS_PER_SESSION = 6` — hard stop on round-trips, independent of `MAX_ACTIONS_PER_PLAN = 10`.
- Per-round machine budget = the existing 90 s value, but **reset each round** and clocking only
  capture+scan+plan+act — **not** time spent in `awaiting_approval` waiting on the human.
- Session ends on: `done`, `ask_user`, a denial, 6 rounds, or a single round busting its own budget.
- This is a documented `SECURITY-PRIVACY.md` invariant: the copy changes from "10 actions / 90 s
  total" to "≤6 rounds, ≤90 s active work per round, human time excluded," updated in the **same
  commit** as the code across `SECURITY-PRIVACY.md`, `PRD.md`, `ARCHITECTURE.md`, and panel copy.

## 5. Messaging (Decision 2, from the execution prompt)

- New extension setting `allowDraftingMessages`, **off by default**, label "Allow drafting messages
  for my review."
- Off → planner keeps today's refusal verbatim. On → planner may propose `type` composing new prose
  into a compose field and `click` on send-labelled controls.
- The executor's `confirm` on send/reply/post labels (`executorPolicy.ts`) **never** downgrades to
  `allow`. Two separate human confirmations for the reference scenario: one to open the reply, one to
  send, each on the freshly re-rendered page showing the exact text.

## 6. Phases (precise, code-anchored)

> Full task-by-task steps, files, and acceptance live in [05-BUILD-ORDER.md](05-BUILD-ORDER.md).
> This is the shape and the exit gate.

- **Phase 6 — Multi-round loop.** State machine gains the round edge + budgets; executor runs one
  step; `background.ts` drives scan→plan→approve→execute→scan; `priorActions` populated.
  *Exit:* a two-round fixture (select → field appears → type) completes via re-planning, `priorActions`
  asserted non-empty on round 2, round cap + per-round timeout enforced, every V1 single-round test
  still green.
- **Phase 6.5 — Vision-free fast path** ([01](01-agent-loop-speed.md) §A). Rounds decidable from the
  snapshot skip the screenshot and the whole pixel scan. *Exit:* a click/type-by-name task completes
  with zero OCR/face calls; explain-page still scans; privacy docs updated same commit.
- **Phase 7 — Privacy speed + accuracy.** [02](02-pii-engine-speed.md) + [03](03-pii-engine-accuracy.md)
  in full. *Exit:* concurrent OCR+face, measured before/after scan time, WebGPU-bind check, a
  checked-in synthetic corpus with a regression-gated precision/recall number.
- **Phase 8 — Conversational panel.** Transcript view in `useTaskSession.ts`; `ChatTurn`
  extension-local; per-turn Allow-once/Deny-and-stop; Local Audit stays fixed; full drafted value
  shown. *Exit:* all five Phase 5 scenarios work through the chat UI, audit un-buried.
- **Phase 9 — Drafting + messaging behind opt-in.** `allowDraftingMessages`; conditional prompt;
  synthetic Gmail-like fixture; in-code proof a send can't fire without a fresh confirm. *Exit:* the
  §1 reference scenario passes off-by-default (refuses) and on (drafts, shows, two confirms, sends).
- **Phase 10 — V2 demo + hardening.** Runbook + hardening for the loop, budgets, messaging toggle,
  denial/stop at every round. *Exit:* matches `docs/V2-PLAN.md` §10; V2-PLAN status → "implemented."

## 7. Validation gate (every phase)

```
bun test
bun run typecheck
bun run --cwd apps/extension build
```

All green before moving on or pushing. Measured numbers (Phase 7) must be reproducible by re-running
the test/script, not asserted in prose.

## 8. Definition of done (the product)

- Tap icon → chat panel → type task → Orka works it step by step, each consequential step approved in
  the chat, sending only after an explicit confirm on the rendered draft → "done" → ready for next.
- Both visual (face/OCR) and textual (DOM) PII redacted on-device before any network call; gateway
  stays model-agnostic and stateless.
- Redaction speed + at least one accuracy figure measured against a checked-in corpus.
- All V1 tests still pass; the loop, chat, fast path, and messaging are additive.

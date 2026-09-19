# Phase 8 — Conversational side panel

## Goal

Turn the single-task form into a chat transcript: user turns (free text) and Orka turns (a proposed
step with its full draft/preview, a question, a summary, or a terminal result), rendered in order, with
Allow-once / Deny-and-stop controls embedded per turn. The "Local audit" / "What left this device"
sections stay a persistent, non-scrolling panel — never folded into the chat.

## Docs to read first

- [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) §1 (the UX) and §3 (panel delta)
- [docs/V2-PLAN.md](../docs/V2-PLAN.md) §5.3 and §6 (the `ChatTurn` sketch)
- Current UI: `apps/extension/entrypoints/sidepanel/App.tsx`, `sidepanel/useTaskSession.ts`,
  `apps/extension/shared/localReport.ts`, `apps/extension/shared/outboundView.ts`

## Current state

- `useTaskSession.ts` models one `TaskState` per session; `App.tsx` is a single task string + settings
  form + a fixed set of cards.
- Local Audit / Outbound View already exist as cards and must remain intact.
- Depends on Phase 6 (loop) and reads best after Phase 8-adjacent work; can proceed once the loop emits
  per-round events.

## Tasks

1. `sidepanel/useTaskSession.ts`: add a `transcript: ChatTurn[]` view **alongside** the existing
   `TaskState` (do not fork or replace the `TaskSession` state machine — the transcript is a new view
   over the same session events). Append a turn as each event arrives (user task, proposed step,
   ask_user, outcome, terminal result).
2. Define `ChatTurn` as **extension-local only** (never crosses the gateway):
   `{ role: "user" | "orka", kind: "message" | "step" | "question" | "result", ... }`.
   `PlanRequest`/`PlanResponse` stay unchanged.
3. `sidepanel/App.tsx`: render the thread. User turns as free text; Orka turns as a bubble showing the
   target, the drafted value **in full** (not truncated the way `describeCandidate`'s reason is today),
   and the existing Allow-once / Deny-and-stop controls embedded per turn instead of a modal-style card.
4. Keep "Local audit" and "What left this device" as a persistent, always-visible panel section (hard
   requirement — do not fold into the scrolling transcript).
5. On session end, the panel is ready for the next task (a new user turn starts a new session).

## Acceptance

- All five Phase 5 demo scenarios complete correctly when driven through the chat transcript UI.
- The Local Audit / Outbound View sections remain visible and un-buried in every one of them.
- A `type` step's review turn shows the exact drafted value in full.
- Validation gate green; push.

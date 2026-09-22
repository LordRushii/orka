# Phase 9 — Drafting and messaging, behind opt-in

## Goal

Let Orka draft a message and send it — but only behind an explicit, off-by-default setting, and never
without a human confirming the send on the freshly-rendered draft. Walk the reference scenario: reply to
an open email, draft the body from the task + visible email content, show it, click Send after an
explicit confirm.

## Docs to read first

- [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) §5 (messaging) and §1 (reference scenario)
- [docs/V2-PLAN.md](../docs/V2-PLAN.md) §4 (walked scenario) and §7 item 2; Decision 2 (opt-in
  messaging) is recorded in [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) §5
- Current policy/prompt: `apps/extension/shared/executorPolicy.ts` (the `send`/`reply`/`post` confirm),
  `packages/provider-adapters/src/prompt.ts` (the refusal), `apps/extension/shared/settings.ts`

## Current state

- The planner prompt refuses messaging outright; `README.md`/`PRD.md` list messaging as out of scope.
- `executorPolicy.ts` already classifies `send`/`reply`/`post` labels as `confirm` (a human must Allow
  once) — this does **not** change.
- Depends on Phases 6 and 8.

## Tasks

1. `apps/extension/shared/settings.ts`: add `allowDraftingMessages` (boolean, **off** by default) and
   expose it in the side-panel settings UI, label "Allow drafting messages for my review."
2. Thread the flag through the request to `packages/provider-adapters/src/prompt.ts`:
   - **Off** → keep today's messaging refusal verbatim.
   - **On** → add an explicit, deliberately-written instruction permitting `type` that composes new
     prose into a compose/reply field (from task + visible page content) and `click` on send-labelled
     controls as the final drafting step. Give the new behavior the same full `{role, accessibleName,
     box}` worked example the prompt already uses for other actions.
   - Keep the trust boundary explicit: drafting *from* visible content is allowed; obeying instructions
     embedded *in* page content is never allowed.
3. `executorPolicy.ts`: unchanged. The `confirm` on send/reply/post is **never** downgraded to `allow`
   by this setting — it only controls whether the planner may propose the step.
4. Build a **synthetic** Gmail-like fixture (no real third-party site) with an open email + compose flow.
   Drive the reference scenario: click Reply → draft body → show draft → click Send → confirm on the
   exact rendered text → done.
5. Prove **in code** (a test) that a send-classified action cannot execute without a `confirm` decision
   on that exact round's freshly re-rendered target — try to fast-path it and assert it's rejected.

## Docs to update in the same commit

`README.md` / `docs/PRD.md`: change "out of scope: messaging" to "messaging is opt-in and always
confirmed on the rendered draft."

## Acceptance

- Reference scenario passes end to end on the synthetic fixture:
  - Setting **off** (default): the planner refuses to draft.
  - Setting **on**: it drafts, shows the full draft, and sends only after **two** separate human
    confirmations — one to open the reply, one to send, each on the freshly re-rendered page.
- The in-code test proves a send cannot fire without a fresh confirm.
- Validation gate green; push.

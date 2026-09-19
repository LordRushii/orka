# Phase 10 — V2 demo and hardening

## Goal

Mirror Phase 5's runbook/hardening pair, scoped to what V2 added: the multi-round loop, the vision-free
fast path, the measured privacy numbers, the chat UI, and the messaging opt-in. Then mark the V2 docs as
implemented, not proposed.

## Docs to read first

- [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) §8 (definition of done)
- [docs/V2-PLAN.md](../docs/V2-PLAN.md) §10 (success criteria); [phases/05-demo-and-hardening.md](../phases/05-demo-and-hardening.md) (the format to mirror)
- [docs/PHASE-5-DEMO.md](../docs/PHASE-5-DEMO.md), [docs/PHASE-5-HARDENING.md](../docs/PHASE-5-HARDENING.md)

## Current state

- Depends on Phases 6, 6.5, 7, 8, 9 all landed and validated.

## Tasks

1. **Demo runbook** (same format as `docs/PHASE-5-DEMO.md`), covering:
   - the multi-round loop on the two-round fixture,
   - the measured privacy-engine before/after numbers from Phase 7,
   - the chat transcript UI,
   - the messaging opt-in flow end to end (off → refuses; on → two confirms → send).
2. **Hardening pass** on what V2 added:
   - round-budget edge cases: round cap hit mid-draft, per-round timeout mid-round,
   - the messaging setting toggled **off mid-session**,
   - the transcript UI's behavior on denial/Stop at **every** round, not just the first,
   - the vision-free fast path: a vision-required capture failing must fail closed.
3. **Docs → implemented.** Update `README.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`,
   `docs/SECURITY-PRIVACY.md` to describe V2 behavior as current. Move `docs/V2-PLAN.md`'s status line
   from "draft, not started" to "implemented," and note where each requirement landed (link the phase's
   tests/files). Update `README.md`'s "Workspace plan" to describe V2 as complete, same phase-by-phase
   link style it uses for V1.

## Acceptance (matches docs/V2-PLAN.md §10)

- Reference scenario works end to end with an **in-code-guaranteed** send confirmation.
- Redaction speed and at least one accuracy figure are measured against the checked-in corpus.
- The side panel is a chat transcript that still exposes Local Audit / Outbound View.
- All V1 tests still pass unchanged in behavior.
- Re-running the demo runbook reproduces the reference scenario live against LM Studio (or the
  configured provider), not just against fixtures in CI.
- Validation gate green; push.

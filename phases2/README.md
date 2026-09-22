# Phases 2 — Build order for the V2 product

Continues the `phases/` numbering (V1 was `phases/01`–`phases/05`). Each file here is a **complete,
hand-off-able brief** for one phase of building Orka into a usable multi-step agent: goal, the docs to
read first, the current state of the code, the concrete tasks with file paths, and the acceptance
gate. Hand any one file to an implementer and it stands alone.

## How to use

Give an agent a single phase file (e.g. `phases2/06-multi-round-loop.md`) and say "implement this."
The file's **Docs to read** section links everything it needs; the **Tasks** section names every file
to touch; the **Acceptance** section is how it knows it's done.

## The source-of-truth docs (read once, referenced by every phase)

- [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) — what the product does end to end
- [docs2/05-BUILD-ORDER.md](../docs2/05-BUILD-ORDER.md) — task-by-task order (these phase files expand it)
- [docs/V2-PLAN.md](../docs/V2-PLAN.md) — the "why"; [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) — the resolved scope decisions (per-round budget, opt-in messaging)
- [docs/SECURITY-PRIVACY.md](../docs/SECURITY-PRIVACY.md), [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), [docs/PRD.md](../docs/PRD.md) — the invariants no phase may break

## The phases

| Phase | File | Goal |
|---|---|---|
| 6 | [06-multi-round-loop.md](06-multi-round-loop.md) | Observe → plan one step → approve → act → re-observe loop |
| 6.5 | [06.5-vision-free-fast-path.md](06.5-vision-free-fast-path.md) | Skip the pixel scan on rounds that don't need vision |
| 7 | [07-privacy-speed-accuracy.md](07-privacy-speed-accuracy.md) | Faster scan + a measured accuracy number |
| 8 | [08-conversational-panel.md](08-conversational-panel.md) | Chat-transcript side panel with per-turn approval |
| 9 | [09-drafting-and-messaging.md](09-drafting-and-messaging.md) | Opt-in message drafting; send always confirmed |
| 10 | [10-v2-demo-and-hardening.md](10-v2-demo-and-hardening.md) | Runbook, hardening, docs marked "implemented" |

## Current state (2026-09-19)

- V1 (`phases/01`–`05`) complete: 572 tests pass, typecheck clean, extension builds.
- **Phase 6.1 (contracts) is already done**: `packages/contracts/src/session.ts` has
  `MAX_ROUNDS_PER_SESSION`, a `NEXT_ROUND` edge, `startRound()`, and a per-round active clock
  (`roundActiveMs`/`enforceRoundTimeout`) that excludes approval time. It is additive — nothing wires
  it yet. Phase 6 below starts at task 6.2 (executor) and 6.3 (background loop).

## Validation gate (end of every phase)

```
bun test
bun run typecheck
bun run --cwd apps/extension build
```

All green before the phase is considered done. Any change to a documented safety invariant updates the
relevant doc in the **same commit** as the code.

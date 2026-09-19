# Phase 6 — Multi-round planning loop

## Goal

Replace the single blind plan with an iterative loop: capture → sanitize → plan **one step** →
present for approval → execute **one step** → re-capture → plan again, until `done`, `ask_user`, a
denial, or a limit. Each step is planned against what the page actually looks like *after* the
previous one. A single-step task must still complete in one round, indistinguishable from V1.

## Docs to read first

- [docs2/05-BUILD-ORDER.md](../docs2/05-BUILD-ORDER.md) §"Phase 6" — the task list this expands
- [docs2/04-PRODUCT-PRD.md](../docs2/04-PRODUCT-PRD.md) §3 (deltas) and §4 (budgets)
- [docs/V2-PLAN.md](../docs/V2-PLAN.md) §5.1 (the loop) and [docs/V2-EXECUTION-PROMPT.md](../docs/V2-EXECUTION-PROMPT.md) §1 Decision 1
- [docs/SECURITY-PRIVACY.md](../docs/SECURITY-PRIVACY.md) — the budget invariant you will change

## Current state

- **6.1 done** — `packages/contracts/src/session.ts` already has `MAX_ROUNDS_PER_SESSION = 6`, the
  `NEXT_ROUND` edge (`executing → scanning`), `startRound()`, and per-round `roundActiveMs()` /
  `enforceRoundTimeout()` (approval time excluded). Tests in `packages/contracts/test/contracts.test.ts`.
- Not done — the executor still runs the whole plan array; `background.ts` is still single-shot;
  `priorActions` is always empty.

## Tasks

### 6.2 — Executor runs exactly one step
`apps/extension/shared/executor.ts` (`createActionExecutor`): today `execute(plan)` loops
`plan.actions`. Add a single-step entry (`executeStep(action, index, context)`, or keep `execute` and
feed it a one-action plan) that runs one action and returns
`{ status, needsReplan, outcome, summary }`:
- success and not `done`/`ask_user` → `needsReplan: true`
- `done` → completed; `ask_user` answered → the loop asks the user, then continues or stops per the answer; denial → terminal; failure → failed
- Keep **all** existing per-action policy: live-DOM re-resolution (`locate`), `decideClick/Type/Select`,
  origin-change confirm, sensitive-value handling, confirm-on-send. Only the outer `for` over the array
  is removed. Keep `execute(plan)` working for the single-action path so V1 executor tests are
  behavior-identical.

### 6.3 — Background drives the real loop
`apps/extension/entrypoints/background.ts`:
- Refactor `startTask`/`scanTask`/`planTask`/`approvePlan`/`runExecution` into a `runRound(task)` that
  does scan → plan-one-step → publish for approval → on APPROVE execute-one-step → decide.
- Before each new capture call `session.startRound()`; if `{ stopped: true }`, end the session. After a
  successful non-terminal step call `session.send("NEXT_ROUND")` and loop.
- Replace the single 90 s watchdog with a **per-round** guard using `enforceRoundTimeout()`.
- Maintain `task.priorActions: PriorActionSummary[]` — after each executed round push a summary of the
  **approved+executed** step (type + one-line outcome), and pass it into the next round's
  `CaptureInput.priorActions`.
- Initialize the pixel workers **once** at session start and reuse across rounds (do not re-init per
  round — see [docs2/02-pii-engine-speed.md](../docs2/02-pii-engine-speed.md) Fix 4). Dispose only at
  session end.
- Preserve every existing guard: `activeTask !== task`, `cancelled`, Stop from any round, origin change.

### 6.4 — Prompt renders prior actions
`packages/provider-adapters/src/prompt.ts`: confirm `buildPlannerUserText`'s "PRIOR APPROVED ACTIONS"
section renders real content when `priorActions` is non-empty.

### 6.5 — Two-round fixture
Extend the Phase 5 fixture set with a genuine two-round page (e.g. select an option → a field appears →
type into it) that only completes via re-planning against the re-captured page.

## Docs to update in the same commit as the behavior change (6.3)

`docs/SECURITY-PRIVACY.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, and the side-panel budget copy:
"10 actions / 90 s total" → "≤6 rounds, ≤90 s of active work per round, human confirmation time
excluded."

## Acceptance

- A fixture-driven test (no live network; mock planner + scripted page) exercises the full loop on the
  two-round scenario and completes via re-planning, **not** a pre-baked multi-action plan.
- The planner is called once per round; `priorActions` is asserted **non-empty on round 2+**.
- The round cap stops a runaway plan at 6; the per-round timeout resets each round and excludes
  approval time; Stop mid-round is clean.
- Every V1 single-round test still passes unchanged in behavior.
- Validation gate green; push.

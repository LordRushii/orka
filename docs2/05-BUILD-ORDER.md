# 05 — Build order (start coding here)

Task-by-task implementation for [04-PRODUCT-PRD.md](04-PRODUCT-PRD.md). Each task names the file, the
change, and the test that proves it. Work top to bottom. Run the gate (`bun test`, `bun run
typecheck`, `bun run --cwd apps/extension build`) at each checkpoint; commit small.

Anchors read from the current tree:
- State machine: `packages/contracts/src/session.ts` — single-shot, no `executing → scanning` edge,
  budgets `DEFAULT_MAX_ACTIONS = 10` / `DEFAULT_MAX_DURATION_MS = 90_000`.
- Loop driver: `apps/extension/entrypoints/background.ts` — `startTask → scanTask → planTask →`
  `awaiting_approval`, then `approvePlan → runExecution` runs the **whole** plan once.
- Executor: `apps/extension/shared/executor.ts` — `execute(plan)` iterates `plan.actions`.

---

## Phase 6 — Multi-round loop

### 6.1 Contracts: round budget + loop edge  *(commit 1, docs same commit)*
`packages/contracts/src/session.ts`:
- Add `export const MAX_ROUNDS_PER_SESSION = 6;`
- Add event `NEXT_ROUND` with edge `executing → scanning`. Keep all existing edges.
- Add `TaskSessionOptions.maxRounds` (default `MAX_ROUNDS_PER_SESSION`) and a `_roundCount`.
- Per-round timer: on entering `scanning` (START_SCAN and NEXT_ROUND), reset `_startedAt`. Keep
  `enforceTimeout()` as the per-round ceiling (`maxDurationMs` unchanged in value).
- New `startRound(): { stopped: boolean }` — increments `_roundCount`, auto-stops when
  `_roundCount >= maxRounds`. Called by the loop before each new scan.
- `recordAction()` keeps the per-plan action cap but no longer the primary limit; the round cap is.

Docs (same commit): `SECURITY-PRIVACY.md`, `PRD.md`, `ARCHITECTURE.md`, side-panel copy → "≤6 rounds,
≤90 s active work per round, human confirmation time excluded."

*Tests:* `session.test.ts` — `NEXT_ROUND` legal only from `executing`; round cap stops at 6;
per-round timer resets on re-scan; `awaiting_approval` time excluded (advance the injected clock while
in `awaiting_approval`, assert no timeout).

### 6.2 Executor: run exactly one step  *(commit 2)*
`apps/extension/shared/executor.ts`:
- Add `executeStep(action, index, context)` (or `execute` with a single-action plan) that runs one
  action and returns `{ status, needsReplan, outcome, ... }` instead of looping the array.
- `needsReplan = true` when the action succeeded and is not `done`/`ask_user`. `done` → completed;
  `ask_user`/deny → terminal; failure → failed. Preserve all existing per-action policy, live-DOM
  re-resolution, origin-change, and confirm logic — only the outer loop over the array is removed.
- Keep `execute(plan)` working for the single-action path so V1 tests are behavior-identical.

*Tests:* existing executor tests green; new test: a successful `click` returns `needsReplan: true`; a
`done` returns completed; a denied confirm returns terminal.

### 6.3 Background: the real loop  *(commit 3)*
`apps/extension/entrypoints/background.ts`:
- Refactor into `runRound(task)`: `scanTask` (capture+sanitize) → `planTask` (one step) →
  publish for approval → on APPROVE, `executeStep` → if `needsReplan` and
  `session.startRound()` not stopped, `session.send("NEXT_ROUND")` and loop; else finish.
- Accumulate `task.priorActions: PriorActionSummary[]` — push a summary of the **approved+executed**
  step after each round; pass it into the next round's `CaptureInput.priorActions`.
- Init pixel workers **once** at session start, reuse across rounds (see
  [02](02-pii-engine-speed.md) Fix 4); dispose only at session end.
- Preserve every existing guard (`activeTask !== task`, `cancelled`, Stop, timeout, origin).

*Tests:* fixture-driven loop test (no live network, mock planner + scripted page): two-round scenario
(select → new field appears → type into it) completes via re-plan; assert planner was called twice and
`priorActions` non-empty on call 2; round cap stops a runaway plan at 6; Stop mid-round is clean.

### 6.4 Prompt: prior actions render  *(commit 4)*
`packages/provider-adapters/src/prompt.ts`: confirm "PRIOR APPROVED ACTIONS" renders real content
when `priorActions` is non-empty. *Test:* `prompt` test asserts an approved step appears in the built
user text, not just the placeholder.

### 6.5 Fixture  *(commit 5)*
Extend the Phase 5 fixture set with the genuine two-round page used by 6.3's test.

**Phase 6 exit gate:** loop test green end-to-end; `priorActions` non-empty round 2+; round cap + per-
round timeout verified; all V1 single-round tests unchanged in behavior; full validation gate green;
push.

---

## Phase 6.5 — Vision-free fast path
Per [01](01-agent-loop-speed.md) §A. Make `CaptureInput.screenshot` optional in `packages/contracts`;
`sanitize()` skips OCR/face when absent (DOM detectors + a11y redaction still run, still fail-closed);
`background.ts` captures a screenshot only on vision-required rounds. Privacy docs updated same commit.
*Exit:* click/type-by-name task → zero OCR/face calls, no screenshot in the observation; explain-page
still scans.

## Phase 7 — Privacy speed + accuracy
[02-pii-engine-speed.md](02-pii-engine-speed.md) (instrument → concurrent OCR+face → tile cost →
WebGPU-bind → one-time init) and [03-pii-engine-accuracy.md](03-pii-engine-accuracy.md) (corpus →
scorer → regression gate → calibration). *Exit:* measured before/after + one checked-in accuracy
number.

## Phase 8 — Conversational panel
`sidepanel/useTaskSession.ts`: `ChatTurn[]` transcript alongside `TaskState` (extension-local, never
crosses the gateway). `sidepanel/App.tsx`: render user/Orka turns; per-turn Allow-once/Deny-and-stop;
Local Audit / Outbound View stay a fixed section; show full drafted `type` value. *Exit:* five Phase 5
scenarios via chat UI; audit un-buried.

## Phase 9 — Drafting + messaging opt-in
`shared/settings.ts`: `allowDraftingMessages` (off). Thread it through `PlanRequest` to
`prompt.ts`: refusal when off, explicit draft-prose permission when on. Synthetic Gmail-like fixture;
reference scenario. Test that a send cannot execute without a `confirm` on that round's target. *Exit:*
§1 reference scenario passes off (refuses) and on (two confirms, then send).

## Phase 10 — Demo + hardening
Runbook (loop, Phase 7 numbers, chat, messaging). Hardening: round-cap mid-draft, timeout mid-round,
messaging toggled off mid-session, denial/stop at every round. Docs → "implemented." *Exit:*
`docs/V2-PLAN.md` §10 in full.

---

## Guardrails to recheck after every phase
Sanitize-before-network + fail-closed; page text is data not instruction (drafting *from* it is fine,
obeying instructions *in* it is not); live-DOM re-resolve before every action every round; Stop
available every round; no credential in the browser, no un-redacted raw data out.

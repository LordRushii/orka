# Phase 4 — Safe Browser Action Execution

## Purpose

Turn a validated plan into bounded browser actions. A plan is a proposal, not authority; the extension rechecks the current page immediately before every action.

## Target evidence

Every target includes semantic role, accessible name/label, local evidence ID, expected bounding box with tolerance, and visible/enabled/interactable state. Never execute from an unverified coordinate alone.

## Executor interface

```typescript
type ActionExecutor = {
  execute(plan: ActionPlan, context: ExecutionContext): Promise<ActionOutcome[]>;
  stop(reason: StopReason): void;
};
```

The implementation owns lookup, DOM revalidation, confirmation, action limits, origin changes, and safe errors. The side panel sends only user decisions through this interface.

## Implement actions in this order

### `navigate`

Normalize and validate URLs; allow only `http`/`https`; show destinations when not explicitly named; pause after a new origin and request continuation approval.

### `scroll`

Accept only a direction and bounded amount. Reject scripts/arbitrary JavaScript. Take a fresh local snapshot after scrolling.

### `click`

Resolve the semantic target in the live DOM and check visibility, enabled state, role/name match, and box drift. Confirm submit, download, permission, purchase, send, delete, and account/security controls.

### `type` and `select`

Require a live editable/select target. Never accept a raw sensitive value from the planner. Resolve `[PHONE_1]`-style local variables only inside the executor, require approval before inserting them, and exclude them from logs/audits/action plans.

### `ask_user` and `done`

Render a clear question/reason and pause. `done` ends the Task Session and clears sensitive in-memory variables.

## Policy module

Enforce one active tab, maximum 10 actions, maximum 90 seconds, no hidden/background-tab action, no automatic cross-origin continuation, and no credentials, payments, purchases, deletes, messaging, posting, CAPTCHA, bulk extraction, or permission expansion. Stop on policy violation or privacy failure.

## Prompt injection

Page text, OCR, labels, and visual instructions are untrusted data. The executor must deny requests to reveal local values, change policy, install software, grant permissions, or conflict with the user task.

## Acceptance criteria

- Stale or ambiguous targets are rejected.
- Unsafe actions require confirmation or are denied.
- Sensitive local variables never appear in gateway payloads/audits.
- Stop works during planning, approval, and execution.
- Timeout, count, origin, and tab-close conditions terminate safely.

## Tests

- Use a synthetic page with stable, moved, hidden, disabled, duplicate, and malicious elements.
- Test every action with valid, stale, ambiguous, and missing targets.
- Test confirmation for submit, download, permission, sensitive typing, and new origin.
- Test prompt injection in visible text, hidden DOM, OCR text, and labels.
- Run Chromium browser E2E tests before adding Firefox coverage.

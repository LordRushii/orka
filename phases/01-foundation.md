# Phase 1 — Foundation and Contracts

## Purpose

Create a runnable Orka workspace with two independently testable applications and one shared contract package. Do not implement real PII detection or provider calls in this phase.

## Prerequisites

- Install Bun and verify `bun --version`.
- Have Chrome or Edge ready for loading an unpacked extension.
- Read `README.md`, `ARCHITECTURE.md`, and `TECH-STACK.md`.

## Target tree

```text
Orka/
  apps/extension/entrypoints/
    background.ts  content.ts  sidepanel/
  apps/gateway/src/
    server.ts  routes/health.ts
  packages/contracts/src/
    observation.ts  action-plan.ts  errors.ts
  packages/privacy-engine/
  packages/provider-adapters/
```

## Build steps

### Scaffold the extension

From `D:\Projects\Orka`:

```powershell
bunx wxt@latest init apps/extension
```

Select React and TypeScript. Confirm the generated project has a development script and Manifest V3 output.

### Create the workspace

```powershell
New-Item -ItemType Directory -Force apps/gateway, packages/contracts, packages/privacy-engine, packages/provider-adapters
```

Create a root `package.json` with Bun workspaces and scripts named `dev:extension`, `dev:gateway`, `test`, and `typecheck`. Use workspace imports; do not copy contract types between apps.

### Initialize the gateway

```powershell
cd apps/gateway
bun init -y
bun add fastify zod
bun add -d typescript @types/node
```

Implement `GET /health` returning only `{ status: "ok", contractVersion: "v1" }`.

### Define contracts

Create Zod schemas for `SanitizedObservation`, `ActionPlan`, the action union (`navigate`, `click`, `scroll`, `type`, `select`, `ask_user`, `done`), `ActionOutcome`, and `SanitizationFailure`. Reject unknown sensitive fields. Never include raw DOM values, cookies, storage, OCR text, API keys, or detailed redaction maps in `SanitizedObservation`.

### Build the side-panel state machine

Use `idle`, `scanning`, `sanitized`, `planning`, `awaiting_approval`, `executing`, `stopped`, `completed`, and `failed`. The side panel shows state, provider, runtime, task, and Stop. Impossible transitions such as `idle -> executing` must be rejected.

## Deep-module seams

- `contracts` is the shared seam between extension and gateway.
- `TaskSession` owns ordering, timeout, and stop behavior; UI code does not own those rules.
- `ProviderAdapter` is a deterministic mock in this phase.

## Acceptance criteria

- `bun run dev:extension` creates a loadable unpacked extension.
- `bun run dev:gateway` serves `/health`.
- Both apps import the same contract package.
- Invalid observations and action plans return safe error codes.
- No request body, API key, page content, or image is logged.

## Tests

1. Unit-test valid and invalid schema fixtures.
2. Test all allowed and denied TaskSession transitions.
3. Test Stop from every active state.
4. Test gateway health and malformed JSON.
5. Run `bun run typecheck` and `bun test` before Phase 2.

# On-Device Privacy Browser Agent

A cross-browser assistant that understands the active webpage, removes sensitive visual and text data on-device, asks a configurable VLM/LLM to plan, and executes only validated, user-authorized browser actions.

## V1 promise

Raw screenshots, DOM values, credentials, and sensitive user inputs do not leave the browser. The planner receives only a sanitized screenshot, a minimized sanitized accessibility snapshot, and a redacted task. A cloud model, local LM Studio model, or future provider adapter can use that safe context.

## V1 scope

- Chrome, Edge, and Brave first; Firefox follows after the core pipeline is stable.
- Active tab only, during an explicit task session.
- Safe tasks: open a site, explain a page, find/summarize public information, search/filter/navigate, and fill synthetic or non-sensitive forms.
- Cloud default: `deepseek-v4-flash-vision-exp`; local reference: Qwen3-VL-4B-Instruct through LM Studio.
- Never autonomous for irreversible actions. Messages, purchases, deletes, login/credential entry, payments, CAPTCHAs, and social posting are out of scope.

## Workspace plan

```text
apps/
  extension/       WXT + React browser extension
  gateway/         Bun + Fastify planner gateway (no Docker required)
packages/
  contracts/       versioned Observation and ActionPlan schemas
  privacy-engine/  local capture, PII scan, map, and redaction
  provider-adapters/ cloud and LM Studio adapters
```

Read [PRD.md](docs/PRD.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [TECH-STACK.md](docs/TECH-STACK.md), and [SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md) before implementation. The build order is in [phases](phases/).

## Running it locally

```bash
bun install
cp apps/gateway/.env.example apps/gateway/.env   # optional; defaults work without it
bun run dev:gateway                              # http://127.0.0.1:8787, loopback only
bun run dev:extension                            # WXT dev build in .output/chrome-mv3
```

Load `apps/extension/.output/chrome-mv3` as an unpacked extension, then open the side panel and pick a planner. With no configuration at all the gateway serves `mock` (deterministic, in-process) and `lmstudio` (your own loopback server). Cloud providers require both a key in `apps/gateway/.env` and an entry in `ORKA_ENABLED_PROVIDERS`, so a fresh checkout cannot make an outbound call by accident.

Provider API keys live only in the gateway environment. The browser stores a gateway session token and nothing else.

```bash
bun test        # unit and contract tests
bun run typecheck
```

## Running the demo

```bash
bun run dev:gateway      # planner gateway
bun run dev:fixtures     # synthetic demo site on http://127.0.0.1:8788 and :8789
bun run --cwd apps/extension build
```

Open **http://127.0.0.1:8788/phase5-demo.html** with the unpacked extension loaded, and follow
[docs/PHASE-5-DEMO.md](docs/PHASE-5-DEMO.md): five scenarios, each with the exact fixture, the
confirmations to expect, and what the page should have seen. Everything runs on the deterministic
`mock` provider, so the demo needs no key, no local model, and no outbound request.

Hardening status -- which items a test verifies and which need a person -- is in
[docs/PHASE-5-HARDENING.md](docs/PHASE-5-HARDENING.md).

## Non-negotiables

- Sanitization completes before any network request to the planner gateway.
- A sanitization failure fails closed: nothing is uploaded.
- Page text is untrusted data, never agent instruction.
- The executor accepts only schema-validated plans and rechecks a live DOM target immediately before action.
- A user can see the current state and stop the task at any time.

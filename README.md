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

## Non-negotiables

- Sanitization completes before any network request to the planner gateway.
- A sanitization failure fails closed: nothing is uploaded.
- Page text is untrusted data, never agent instruction.
- The executor accepts only schema-validated plans and rechecks a live DOM target immediately before action.
- A user can see the current state and stop the task at any time.

# Phase 5 — Hardening Checklist

The checklist from `phases/05-demo-and-hardening.md`, with each item pointed at what actually verifies
it. Items marked **automated** are covered by a test that fails if the property regresses; the rest
need a person, a real browser, or real credentials, and saying so is part of the record.

Run the automated half first: `bun run typecheck && bun test` from the repository root. Everything in
the automated column below is asserted there.

<!-- prettier-ignore -->
| # | Item | How it is verified |
|---|------|--------------------|
| 1 | Clean-browser install and first model-download flow | **Manual.** Load the unpacked build in a fresh profile per § Install below. |
| 2 | Model hashes and model-load failures | **Automated.** `packages/privacy-engine/test/manifest.test.ts`, `modelManager.test.ts`; `apps/extension/test/pixelWorkers.test.ts` (a worker that fails to initialise is a fail-closed `MODEL_LOAD_FAILED`, never a scan that proceeds without a model). |
| 3 | Gateway traffic: no raw PII leaves the extension | **Automated + manual.** `apps/extension/test/outboundView.test.ts` (the described request carries no forbidden field, and the description cannot carry a value), `packages/contracts/test/contracts.test.ts` (the observation schema has no field for cookies, storage, DOM, or OCR text), `apps/gateway/test/plan.test.ts` (`FORBIDDEN_REQUEST_KEYS` is refused before a provider is constructed). **Manual:** the network panel pass in § Traffic. |
| 4 | WebGPU, Balanced, and WASM modes | **Automated.** `packages/privacy-engine/test/runtime.test.ts`; `apps/extension/test/plannerOrdering.test.ts` (ordering holds in every mode). **Manual:** run Scenario 3 once per mode and compare the Local audit's runtime line. |
| 5 | Cloud and LM Studio with explicit provider switching | **Automated.** `packages/provider-adapters/test/registry.test.ts` (the allowlist is the whole mechanism; a disabled provider is `UNKNOWN_PROVIDER`, never a substitute; no automatic local→cloud fallback). **Manual:** `PHASE-5-DEMO.md` § 9 with a real key and a real local model. |
| 6 | Gateway outage, provider timeout, malformed output, OCR failure, face-model failure, capture failure | **Automated.** See § Failure modes — each has a named test and a typed reason. |
| 7 | Stop, timeout, action limit, tab close, navigation, cross-origin pause | **Automated.** `apps/extension/test/executor.test.ts` (limits, stop, tab close, page unavailable, origin changes) and `taskCleanup.test.ts` (every terminal path releases the capture, plan, and private values). |
| 8 | Prompt injection and malicious hidden DOM | **Automated.** `apps/extension/test/executorPolicy.test.ts` and `executor.test.ts` (page text, hidden DOM, and labels cannot add, skip, or soften a step; a hidden duplicate is never the control that gets clicked). `packages/provider-adapters/test/prompt.test.ts` (page-derived strings are fenced as untrusted data). |
| 9 | Remove development logging and placeholder keys | **Automated.** `apps/extension/test/logging.test.ts` — see § Logging. |

---

## Failure modes

Each of these ends the Task Session with a typed reason. None of them continues with a partial result,
and none of them calls the gateway after a privacy failure.

| Failure | Typed reason | Test |
|---------|--------------|------|
| Gateway unreachable | `GATEWAY_UNREACHABLE` | `apps/extension/test/plannerClient.test.ts` |
| Provider timeout | `PROVIDER_TIMEOUT` | `apps/gateway/test/plan.test.ts`, `packages/provider-adapters/test/adapters.test.ts` |
| Malformed provider output | `INVALID_ACTION_PLAN` | `packages/provider-adapters/test/parse.test.ts` (prose, truncated JSON, unknown action, missing target, `javascript:` URL, over the action cap) |
| Observation fails the contract | `INVALID_OBSERVATION` | `apps/extension/test/plannerClient.test.ts` |
| OCR failure or timeout | `DETECTOR_TIMEOUT` | `packages/privacy-engine/test/sanitize.test.ts` |
| Face-model failure or timeout | `DETECTOR_TIMEOUT` | `packages/privacy-engine/test/sanitize.test.ts` |
| Model assets missing or altered | `MODEL_LOAD_FAILED` | `packages/privacy-engine/test/modelManager.test.ts` |
| Capture refused or the grant lapsed | `CAPTURE_FAILED`, `RESTRICTED_PAGE` | `apps/extension/test/captureAuthority.test.ts`, `captureAuthorityStore.test.ts` |

**To reproduce one by hand:** stop the gateway process, then run Scenario 3. The session goes
**Failed** with *Could not reach the Orka gateway at …*, the run log stays empty, and **What left this
device** still describes the request that was attempted — which is the point: the failure is visible
without the observation being reprinted.

---

## Install

1. Delete the previous build: `rm -rf apps/extension/.output`.
2. `bun run --cwd apps/extension build`.
3. In a fresh Chrome profile: `chrome://extensions` → Developer mode → **Load unpacked** →
   `apps/extension/.output/chrome-mv3`.
4. Open a normal `http(s)` page, click the Orka toolbar icon, and confirm the side panel opens.
5. Start a task and watch the first scan: the pinned models load locally and their hashes are verified
   against `MODEL_MANIFEST`. A hash mismatch fails the scan rather than downloading a replacement.

**Expected permissions:** `activeTab`, `scripting`, `storage`, and the `sidePanel` API. No host
permissions up front, and none requested during the scenarios.

---

## Traffic

1. On `chrome://extensions`, open the service worker's DevTools → **Network**, and clear it.
2. Run Scenario 5 with `EMAIL_1` saved.
3. Inspect every request. There should be exactly one: `POST http://127.0.0.1:8787/v1/plan`.

**Expected:** the body's top-level keys are `contractVersion`, `provider`, and `observation`.
Searching it for the saved address, the string `EMAIL_1`, `cookie`, `redactionMap`, `ocrText`, or the
gateway token finds **nothing**. The screenshot under `observation.screenshot.dataBase64` is the
redacted one, and the element list marks the email field as sensitive with its name rewritten to
`[EMAIL]`.

The in-extension version of this check is the **What left this device** card, which is built from the
request body itself rather than from a hand-written list.

---

## Logging

`apps/extension/test/logging.test.ts` reads the shipped source and asserts:

- no `console.log`, `console.debug`, `console.info`, `console.trace`, `console.dir`, or
  `console.table` anywhere in `apps/extension/{entrypoints,shared,workers}`, `apps/gateway/src`, or
  `packages/**`;
- every remaining `console.warn` / `console.error` argument is either a string literal or a call to
  `safeErrorName(...)`.

The three lines that remain are on error paths — a failed event publish, an uncapturable toolbar
action, and a side panel that would not open — and each prints a *name*, never the error object. The
reasoning is in `apps/extension/shared/logging.ts`: an error can carry a request body, an observation,
or a private value on its way out, and a console line is exactly what ends up in a screen recording.

**Placeholder keys:** no key, token, or credential is checked into the repository. The extension's
default gateway token (`orka-dev-token`) is a loopback development value, provider credentials live in
the gateway's environment, and `.env` is not tracked. Verify before recording with:

```bash
git grep -nIE "(sk-|api[_-]?key|secret|token)\s*[:=]\s*[\"'][^\"']{12,}" -- . ':!*.md'
```

---

## What is deliberately not done yet

- **Firefox.** Chromium first, per `docs/TECH-STACK.md`; the page-side injection code is
  browser-neutral, and the Firefox pass is a post-demo item.
- **A benchmark corpus.** Phase 5 defers it, so three of the five SIH weights cannot be scored. The
  panel reports them as *not measurable locally* rather than estimating them — see
  `PHASE-5-DEMO.md` § 7.
- **Automated end-to-end browser tests.** The manual pass in `PHASE-4-BROWSER-CHECK.md` and this
  document is the substitute for now; automating it needs a headless harness that can load an unpacked
  MV3 extension, which is its own piece of work.

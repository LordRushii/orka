# Phase 3 — Browser Verification Checklist

This is the hands-on pass for **Phase 3 (Planner Gateway + Provider Adapters)**.
Automated coverage is already green (`bun test` → 355 pass, `bun run typecheck`
clean). What can't be asserted in a test runner is the real browser: MV3
permissions, the side-panel flow, and what actually crosses the wire. That's
what this document walks through.

> **Scope reminder.** Phase 3 stops at a **proposed plan**. Nothing clicks,
> types, or navigates yet — approval and execution are Phase 4. Every check
> below ends at the "Awaiting your approval" state with a plan on screen.

---

## 0. What to have ready

| Need | For which checks | Notes |
|------|------------------|-------|
| Chrome / Edge / Brave | all | MV3 + side panel |
| Bun | all | gateway + build |
| LM Studio (optional) | Check C | a vision model, e.g. Qwen3-VL-4B-Instruct |
| A cloud API key (optional) | Check D | DeepSeek or Anthropic; only if you want the cloud hop |

Checks **A, B, E, F, G work with zero keys and zero local models** — the `mock`
provider is deterministic and in-process. Do those first.

---

## 1. Build & start

From the repo root:

```bash
bun install
```

**Start the gateway** (loopback only, `127.0.0.1:8787`):

```bash
bun run dev:gateway
```

You should see `Orka gateway listening on http://127.0.0.1:8787` and
`Providers enabled: mock, lmstudio`. It will also warn that it's using the dev
token — expected for local work.

**Build the extension:**

```bash
bun run --cwd apps/extension build
```

This writes an unpacked extension to `apps/extension/.output/chrome-mv3`.
(For live-reload during iteration you can use `bun run dev:extension` instead,
which launches a browser with the extension auto-loaded.)

---

## 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `apps/extension/.output/chrome-mv3`.
4. Confirm the manifest looks right — click **Details** and check
   **Permissions**: it should list `activeTab`, `scripting`, `storage`, and
   the host `http://127.0.0.1:8787/*` (plus `http://localhost:8787/*`). It must
   **not** request `<all_urls>`, `tabs`, `cookies`, or the debugger.
5. Pin Orka to the toolbar.

---

## 3. Check A — Mock provider, fully offline round-trip

The baseline: a complete Task Session with no key, no model, no outbound call.

1. Navigate to any ordinary page (e.g. `https://example.com`).
2. Click the Orka toolbar icon to open the **side panel**.
3. Leave **Provider = "Mock (offline, deterministic)"**.
4. Type a task, e.g. *"Find the pricing page and summarize the plans."*
5. Click **Start task**.

**Expected sequence** (the badge at the top of the panel):

`Scanning locally` → `Sanitized context ready` → `Waiting on planner` →
**`Awaiting your approval`**

Then a **Proposed plan** card appears:

- A metadata line reading roughly `mock · valid-plan · <N> ms`.
- Two steps: a **click** on link *"Pricing"* (Low risk chip) and a **done**.
- A footnote: *"Nothing has run. Approval and execution arrive in Phase 4."*

You should also see the **Local audit** card: the original capture (left) and
the redacted capture (right), the sanitized origin, and a redaction summary.

✅ **Pass:** you reach "Awaiting your approval" with a two-step plan and never
touched a key or a model.

---

## 4. Check B — Gateway settings & the "Check gateway" button

1. In the panel, click **Gateway settings**.
2. Confirm the fields: **Gateway URL** (`http://127.0.0.1:8787`), **Gateway
   token** (masked), **Model override**. Note the footnote: *provider API keys
   live in the gateway's environment, never in this extension.*
3. Click **Check gateway**.

✅ **Pass:** status reads *"Gateway reachable. Providers: mock, lmstudio."*

Now the negative paths — these prove the transport rule is enforced in the UI,
not just the gateway:

- Set the URL to `http://example.com` (remote + plaintext) and **Save**.
  ✅ It's rejected: *"A remote gateway must use https://…"* — nothing is saved.
- Set the token to a wrong value and **Check gateway**.
  ✅ Status reports the token was rejected (a 401 surfaced as a message, not a
  crash).
- Stop the gateway (Ctrl-C) and **Check gateway**.
  ✅ Status reads *"Could not reach the Orka gateway at …"* — not a hang.

Restart the gateway before continuing.

---

## 5. Check C — LM Studio (local VLM) — optional

1. In LM Studio, load a vision model and **Start Server**. Confirm it's bound
   to `127.0.0.1:1234` (loopback), not `0.0.0.0`.
2. In the panel: **Provider = "LM Studio (local)"**. Optionally set **Model
   override** to the model id LM Studio shows.
3. **Check gateway** should now list `lmstudio`.
4. Start the same task.

✅ **Pass:** you reach "Awaiting your approval" with a plan whose metadata line
reads `lmstudio · <model> · <N> ms`. The plan content will differ from the mock
— it's a real model reading the redacted screenshot.

If the model returns prose instead of JSON, you'll see a **Failed** state with a
typed message rather than a broken plan — that's the gateway rejecting invalid
planner output, which is correct.

> If LM Studio isn't running, selecting it and starting a task ends in
> **Failed** with *"LM Studio could not be reached"* (a `502`), **not** a
> silent switch to another provider. That "no auto-fallback" behavior is the
> point — verify it if you like by starting a task with LM Studio selected and
> its server stopped.

---

## 6. Check D — Cloud provider — optional, needs a key

This is the only check that puts data on the public internet, and only the
**redacted** observation.

1. Stop the gateway. Create `apps/gateway/.env` from the example:
   ```bash
   cp apps/gateway/.env.example apps/gateway/.env
   ```
2. In `.env`, uncomment and fill **one** provider, and add it to the enabled
   list. For DeepSeek:
   ```
   ORKA_ENABLED_PROVIDERS=mock,lmstudio,deepseek
   DEEPSEEK_API_KEY=sk-...your key...
   ```
3. Restart `bun run dev:gateway`. It should log `Providers enabled: mock,
   lmstudio, deepseek`.
4. In the panel: **Provider = "DeepSeek (cloud)"**. A **notice** appears:
   *"The redacted screenshot and element list leave this machine for this
   provider. The original capture and detection map never do."*
5. **Check gateway** now lists `deepseek`. Start the task.

✅ **Pass:** "Awaiting your approval" with metadata `deepseek · <model> · <N> ms`.

The API key is only ever in the gateway's environment — it is **not** in the
extension, not in `storage`, and not on any request the browser makes. Check G
proves that.

---

## 7. Check E — Stop mid-planning

1. Use a provider with a bit of latency (LM Studio or cloud; the mock is near
   instant).
2. Start a task and, while the badge reads **"Waiting on planner"**, click
   **Stop**.

✅ **Pass:** the badge goes to **Stopped**. No plan card appears afterward even
though a request was in flight — the in-flight `/v1/plan` request is aborted
(you can confirm in the gateway log: it logs the request completing without a
plan being delivered to the panel).

---

## 8. Check F — Dismiss session & audit lifecycle

1. Complete a mock round-trip so you're at "Awaiting your approval" with the
   Local audit card showing.
2. Click **Dismiss session**.

✅ **Pass:** the panel returns to **Idle**. The audit card and the plan card
both disappear — the original screenshot and detection map are released from
extension memory (they were never persisted anywhere).

---

## 9. Check G — The network proof (the important one)

This is the check that matters most: confirm that **only sanitized data leaves
the browser**, and it goes only to the loopback gateway.

1. On `chrome://extensions`, find Orka and click **service worker** (under
   "Inspect views") to open DevTools for the background worker.
2. Go to the **Network** tab. Clear it.
3. Run a mock task (Check A).
4. Find the single request: **`POST http://127.0.0.1:8787/v1/plan`**.

Inspect it:

- **Headers →** the token rides in `Authorization: Bearer …`. It is **not** in
  the body.
- **Request payload →** the JSON has exactly three top-level keys:
  `contractVersion`, `provider`, `observation`.
- Search the payload (Ctrl-F in the payload view) for each of these — **all
  should be absent**: `cookie`, `originalScreenshot`, `redactionMap`,
  `domSnapshot`, `token=`, and your gateway token string.
- The screenshot under `observation.screenshot.dataBase64` is the **redacted**
  image — the same opaque one shown on the right in the Local audit card, not
  the original.

✅ **Pass:** one request, to loopback, carrying only the sanitized observation;
no raw capture, no cookies, no storage, no key in the body.

> **Where the cloud hop lives.** The browser only ever talks to the gateway.
> When you use a cloud provider (Check D), the gateway — a separate Node
> process — makes the outbound call to the provider. So the browser's Network
> tab will still show only `127.0.0.1:8787`. That the *gateway's* outbound
> request also carries only the redacted image is covered by the
> request-capture tests in `packages/provider-adapters/test/adapters.test.ts`
> ("only sanitized data leaves the gateway"). If you want to see it live, watch
> the gateway process's traffic — it is never the browser's.

---

## Appendix — a real bug this pass caught

Worth calling out because it explains a change in `apps/gateway/src/routes/plan.ts`:

The route aborts the provider call if the client hangs up. It originally
listened on `request.raw`'s `close` event. On this runtime (Bun + Fastify),
`request.raw` fires `close` the instant a POST **body is fully received** —
which for a normal request is *before* the handler even calls the provider. The
effect: **every real browser request aborted itself and returned `504
PROVIDER_TIMEOUT` in ~2 ms.**

The entire `app.inject()`-based test suite passed the whole time, because
`inject()` never opens a real socket and so never triggers that event ordering.
The bug only appears over a real TCP connection — exactly what a browser uses.

Fix: listen on `reply.raw`'s `close` and abort only when `reply.raw.writableEnded`
is false (i.e. the client left before we finished replying). Two regression
tests now bind a **real port** and exercise both halves — a slow request
completing with `200`, and a genuine client hang-up still aborting the provider
— so this can't silently return.

If you skipped every optional check, **do at least Check A and Check G.**
Those two prove the round-trip works and that the privacy boundary holds.

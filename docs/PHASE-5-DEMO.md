# Phase 5 — Demo Runbook

The repeatable demonstration for **Phase 5 (Demo, Observability, and Hardening)**: five scenarios, run
against a synthetic site, showing local redaction before any request, a validated plan, per-step
consent, and a local record of what happened.

Everything here runs offline. The `mock` provider is deterministic and in-process, so the run is the
same every time and no page on the internet is ever loaded — which is what makes it safe to record.

> **Synthetic only.** The demo site is `apps/extension/test/fixtures/phase5-demo.html`. No real
> account, page, or personal data is involved. The scenarios mirror the ones in
> `phases/05-demo-and-hardening.md`; where that document names a real site (Instagram), this runbook
> uses the synthetic stand-in, because a demo that needs a live third-party site is neither
> repeatable nor safe to record.

---

## 0. Environment

| Need | Notes |
|------|-------|
| Windows laptop, 16 GB RAM, integrated or discrete GPU | as specified in the phase document |
| Chrome or Edge (Chromium) | the primary target; Firefox is deferred to post-demo |
| Bun | gateway and fixture server |
| A window ≥ 1280x800 at 100% zoom | the fixtures cite fixed boxes; a scrolled or zoomed page is *correctly* refused |
| One cloud provider profile and LM Studio | stored in the gateway's environment, not the browser; used for the provider-switching check in `PHASE-5-HARDENING.md` |

---

## 1. Start everything

```bash
bun install
bun run dev:gateway      # http://127.0.0.1:8787, loopback only
bun run dev:fixtures     # demo site on http://127.0.0.1:8788 and http://127.0.0.1:8789
bun run --cwd apps/extension build
```

Load `apps/extension/.output/chrome-mv3` as an unpacked extension, pin Orka to the toolbar, and open
**http://127.0.0.1:8788/phase5-demo.html**.

In the side panel's settings: provider **Mock**, gateway `http://127.0.0.1:8787`, then **Check
gateway**. Leave **Model override** empty between scenarios; each scenario sets it to the fixture
named below.

For scenarios 5's private value, open **Private values** and add `EMAIL_1` = `demo@example.test`
(any invented address). The value is held in extension memory for that task only.

---

## 2. Scenario 1 — Open a site

**Script:** *"Open the site and tell me nothing else needs doing."*
**Fixture:** `phase5-open-site`

1. **Start task** → the local audit appears (original and redacted capture side by side).
2. **Approve & run**.

**Expected:** one `navigate` step, no confirmation (a plain navigation is low risk), then `done`.
The state reaches **Completed**. The demo's point is the scope, not the click: Orka opened the page
and stopped — no sign-in, no account, no social feature.

**Say:** the plan was allowed to navigate because navigating is reversible and carries no credential.
The `done` summary states what was *not* done, so the boundary is part of the output rather than an
unstated assumption.

---

## 3. Scenario 2 — Explain a new app

**Script:** *"Explain the controls on this page."*
**Fixture:** `phase5-explain-app`

**Expected:** no browser action at all — a single `done` whose summary describes the controls the
sanitized observation actually contained: the search field, the result links, the sort dropdown, the
apply button, the request form. It reaches **Completed** with an empty run log apart from the summary.

**Say:** this is the case that shows what the planner could and could not see. The email field appears
as redacted — the planner knows a field exists there and nothing else about it, which is why the
explanation describes its existence rather than its content.

---

## 4. Scenario 3 — Find and summarize

**Script:** *"Search the knowledge base for redaction and summarize the result."*
**Fixture:** `phase5-find-summarize`

**Expected sequence:**

- **Type into this field?** — names the search field and the proposed text — *Allow once*.
- A `click` on the result link: no prompt, because a link click is a plain navigation step.
- `done` with the summary.

**Say:** the typing was gated because typing into a form is a change to the page. The link was not,
because following a link is what a browser does. The distinction is the action's effect, not its count.

---

## 5. Scenario 4 — Search and filter

**Script:** *"Sort the results by newest and apply the filters."*
**Fixture:** `phase5-filter-sort`

**Expected sequence:**

- **Choose this option?** — the `select` on **Sort results**, value `Newest` — *Allow once*.
- **Submit this form?** — the `click` on **Apply filters**; the policy reads "apply" as a submit — *Allow once*.
- `done`.

**Say:** the selection and the apply are separate decisions because they are separate effects: one
changes a control, the other sends the change. Both are addressed by role, name, and box — neither by
coordinate.

---

## 6. Scenario 5 — Synthetic form and a private value

**Script:** *"Fill in the city and submit the request form."*
**Fixture:** `phase5-form`

**Expected sequence:**

- **Type into this field?** — City, `Berlin` — *Allow once*.
- **Insert one of your private values?** — naming `[EMAIL_1]`, **not** the address — *Allow once*.
- **Submit this form?** — *Allow once*.
- `done`.

**Then open the network panel** (see `PHASE-5-HARDENING.md` § Traffic) and confirm the request body
contains no address, no `EMAIL_1`, no cookies, no DOM, and no OCR text. The side panel's **What left
this device** card makes the same point without leaving the extension: field names, kinds, and sizes,
and the families that have no field in the contract at all.

**Say:** the address was never in the observation, never in the request, and never in an audit. It was
resolved in the browser, after the confirmation, immediately before the keystroke. The email field
could only ever be filled this way, because the privacy engine had already replaced its name with
`[EMAIL]` before the planner saw it.

**Variation worth showing:** run `phase5-purchase` on the same page. The **Upgrade to paid plan**
button raises **Spend money or start a commitment?** — and *Deny and stop* ends the run with the page
untouched. That is the other half of the policy: a consequential step is never taken on Orka's own
initiative.

---

## 7. What the panel shows, and what it refuses to claim

Three cards carry the evidence:

- **Local audit** — the original and redacted captures side by side, the runtime mode, the pinned model
  versions, category counts, and detection confidence as bands (high/medium/low), never as boxes or
  scores. The exact map and the original pixels stay in extension memory and are released when the
  session closes.
- **This run, measured locally** — one row per phase (capture, scan and redact, gateway round trip,
  planner, execution), the wall-clock total, the runtime, a local JS heap sample when the browser
  reports one, and the five SIH weights.
- **What left this device** — the request described by field path, kind, and size only.

**Say this plainly, because it is the honest part:** two of the five SIH weights (client resources,
latency) are measured here and now; the other three need labelled ground truth the browser does not
have. The panel labels them *not measurable locally* instead of estimating them, and the formal
benchmark corpus is deferred until after the first demonstration, exactly as the phase document says.
A demo that produced a recall figure out of thin air would be worse than one that reported a blank.

---

## 8. Test report template

One row per scenario, per run. Attach only sanitized screenshots and sanitized request examples.

| Field | Example |
|-------|---------|
| Scenario | 5 — Synthetic form and a private value |
| Browser / version | Chrome 140.0.7339.80 |
| Runtime mode | `balanced` (auto-selected) |
| Provider / model | `mock` / `phase5-form` |
| Detection categories | `PHONE: 0`, `EMAIL: 1` |
| Confidence bands | `EMAIL high ×1` |
| Capture | 310 ms |
| Scan and redact | 1.9 s |
| Gateway round trip | 24 ms |
| Planner (reported) | 12 ms |
| Execution | 3 steps, 640 ms |
| Total | 3.1 s |
| Action result | 3 confirmed, all succeeded |
| Redaction result | email field redacted; no raw value on the wire |
| Fail-closed reason | — (none) |

---

## 9. Acceptance

A new evaluator can follow this runbook and, without access to any raw user data:

1. see the redaction **before** the request is made, in the Local audit card;
2. observe a schema-valid plan and its risk per step, and *why* each step is what it is;
3. approve safe execution one step at a time, and stop it at any point;
4. reproduce a privacy failure (`PHASE-5-HARDENING.md` § Failure modes) with a typed reason and no
   partial result.

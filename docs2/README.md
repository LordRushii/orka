# Orka Scaling Plan (docs2)

This folder is the **actionable** plan for pulling Orka from its V1-complete state up to a fast,
measurably-accurate, multi-round agent. `docs/V2-PLAN.md` describes *why* V2 exists; the docs here
describe *exactly what to change, in what file, and how to prove it worked* so implementation can
start without re-deriving anything.

These docs are grounded in the code as it stands today (paths and line numbers are from the current
tree). Where a claim needs confirmation against a file I have not fully read (e.g. the OCR worker
internals), the item is marked **[verify first]** — do that measurement before writing the change.

## What "that level" means — the target

| Axis | V1 today | Target |
|---|---|---|
| Scan latency (`Scan and redact`) | ~6.3 s | < 2 s on WebGPU, < 4 s on WASM |
| Agent step latency (capture→plan→ready) | one blind plan, ~15–35 s model | multi-round, each round bounded; vision-free rounds sub-second local work |
| PII accuracy | asserted, "not measurable locally" | real precision/recall vs a checked-in corpus, regression-gated |
| Interaction | single-shot plan | observe→propose→confirm→act→re-observe loop |

## The three levers

1. **Agent-loop speed** — [01-agent-loop-speed.md](01-agent-loop-speed.md). Ideas from
   [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) applied to Orka. The
   single highest-leverage change: a **vision-free fast path** that skips the whole pixel scan on
   rounds that don't need the screenshot. This also makes V2's multi-round loop affordable (V2-PLAN
   §5.1 flags "N round trips = N OCR/face scans" as the cost concern — this removes most of them).
2. **PII engine speed** — [02-pii-engine-speed.md](02-pii-engine-speed.md). Parallelize OCR+face,
   fix the sequential-tile cost, prove WebGPU actually binds, confirm one-time session init.
3. **PII engine accuracy** — [03-pii-engine-accuracy.md](03-pii-engine-accuracy.md). Build the
   synthetic labelled corpus V1 deferred, compute real precision/recall, gate regressions.

## How this maps onto the existing phase numbering

The `docs/V2-PLAN.md` phase breakdown (6–10) stays valid. These docs slot in as:

- **Phase 6 (multi-round loop)** — pulls in [01](01-agent-loop-speed.md) §A (fast-path) and §D
  (bounded re-capture waits), because the loop and its cost control are the same change.
- **Phase 7 (privacy speed + accuracy)** — is [02](02-pii-engine-speed.md) and
  [03](03-pii-engine-accuracy.md) in full.
- **Phases 8–10** — unchanged from `docs/V2-PLAN.md`; no new plan needed here.

## Non-negotiables these plans must not break

Carried from `README.md` / `docs/SECURITY-PRIVACY.md` — every change below is designed to preserve
all of them, and each doc calls out where it touches one:

- Sanitization completes before any network request; a sanitization failure fails **closed**.
- No raw screenshot, DOM, or OCR text leaves the extension un-redacted.
- Page text is untrusted data, never agent instruction.
- The executor rechecks the live DOM target immediately before every action, every round.
- No provider credential ever reaches the browser.

> The fast path in [01](01-agent-loop-speed.md) is the one item that touches a privacy invariant
> (it changes *when* a screenshot exists, not *whether* redaction runs). Read its "Privacy proof"
> section before implementing — it must land with the `docs/SECURITY-PRIVACY.md` update in the same
> commit.

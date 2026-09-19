# Phase 7 — Privacy engine speed and accuracy

## Goal

Two tracks. **Speed:** cut `Scan and redact` from ~6.3 s toward < 2 s (WebGPU) / < 4 s (WASM), measured
before and after. **Accuracy:** build the synthetic labelled corpus V1 deferred, so at least one of the
"not measurable locally" SIH weights (PII recall/precision, redaction precision) becomes a real,
checked-in, regression-gated number.

## Docs to read first

- [docs2/02-pii-engine-speed.md](../docs2/02-pii-engine-speed.md) — the speed plan, fix by fix
- [docs2/03-pii-engine-accuracy.md](../docs2/03-pii-engine-accuracy.md) — the corpus + scoring plan
- [docs/V2-PLAN.md](../docs/V2-PLAN.md) §5.2; [phases/05-demo-and-hardening.md](../phases/05-demo-and-hardening.md) (the deferred corpus + SIH weights)

## Current state

- `sanitize.ts` awaits OCR then face **sequentially** (`sanitize.ts:123` then `:139`) though they are
  separate workers → free `Promise.all` win.
- OCR runs a full-image pass + up to `maxTiles` (12/6/8) native tiles **sequentially** in one worker
  (`pixel/ocr.ts`, `policy.ts` `PIXEL_SCAN_POLICY`) — the dominant cost.
- `runtime.ts` selects webgpu/balanced/wasm but nothing asserts ORT actually bound WebGPU.
- `pixelWorkers.ts` `PIXEL_INIT` terminates+recreates workers on every init — confirm it fires once per
  session, not per scan.
- No labelled corpus exists.

## Tasks

### Speed
0. **Instrument first.** Add measured spans around full-image OCR, each tile, face, and encode
   (`sanitize.ts` lines 123/139/168, tile loop `pixel/ocr.ts:62`). Record the breakdown for one 1280×800+
   capture. Do this before changing anything.
1. **Concurrent OCR + face** — start both promises, `Promise.all`; either rejecting still fails closed.
   Add a test asserting wall-clock ≈ max, not sum.
2. **Cut the tile cost** (pick per the Step 0 numbers): early-return when the capture already fits the
   budget; or detection-once + recognition-on-crops **[verify the worker's per-tile pipeline first]**; or
   a lower loop-mode tile budget bounded by the accuracy gate below; or a second OCR worker last.
3. **Prove WebGPU binds** — read back the ORT session's execution provider; log/record on mismatch so a
   silent WASM fallback is visible. Don't hard-fail (WASM is valid), just never falsely claim WebGPU.
4. **One-time init** — ensure workers init once per session and are reused across rounds; assert a
   multi-round fixture triggers exactly one `PIXEL_INIT`.

### Accuracy
5. Build `packages/privacy-engine/fixtures/benchmark-corpus/` — synthetic pages (no real PII) with
   `capture.png` + `snapshot.json` + hand-labelled `ground-truth.json` covering EMAIL, PHONE, CARD,
   GOVT_ID, PASSWORD_FIELD, FACE, including an embedded-image-text fixture. README documents each label.
6. Add a scoring harness (IoU-matched against ground truth, using `DETECTION_POLICY.overlapMergeIou` and
   production thresholds) computing precision/recall + redaction coverage.
7. Wire a regression test against a checked-in `baseline.json` that fails if any metric drops. Record the
   before/after speed numbers from Step 0 in the corpus README.

## Acceptance

- At least one previously-"not measurable" weight is now a checked-in, reproducible number, and the
  tile-budget change is bounded by the regression gate (can't trade away recall silently).
- A measured scan-time improvement is recorded against the same baseline fixture/hardware as the V1
  demo — actual before/after, reproducible by re-running the test/script.
- Validation gate green; push.

# 02 — PII engine speed

Target: get `Scan and redact` from ~6.3 s to **< 2 s on WebGPU / < 4 s on WASM**, measured, on the
same fixture/hardware used for the V1 demo. Do the measurement in step 0 *before* changing anything.

All work is in `packages/privacy-engine` and `apps/extension/shared`. This doc is Phase 7's speed
half; the accuracy half is [03-pii-engine-accuracy.md](03-pii-engine-accuracy.md).

---

## Step 0 — Instrument, then measure (do this first)

Add measured spans (not estimates) around: full-image OCR pass, each OCR tile pass, face detection,
and encode. Emit them into the `LocalAudit` (local-only, never sent) or a debug channel.

- Where: wrap the calls in `sanitize.ts` (`runOcrDetection` line 123, `runFaceDetection` line 139,
  `deps.encoder.encode` line 168) and the per-tile loop in `pixel/ocr.ts:62-66`.
- Record the breakdown for one representative capture (1280×800+). Put the numbers in the corpus
  README from [03](03-pii-engine-accuracy.md) so before/after is reproducible, per the exit criteria.

Expected shape of the finding (to confirm, not assume): OCR dominates because it runs a full-image
pass **plus up to `maxTiles` native-resolution tiles** (`PIXEL_SCAN_POLICY`: 12 webgpu / 6 balanced
/ 8 wasm, `policy.ts:111-115`), and those passes run **sequentially in one worker**
(`pixel/ocr.ts` header comment: "one worker owns one inference session").

---

## Fix 1 — Run OCR and face concurrently *(free win, do first)*

**Found:** in `sanitize.ts` OCR is `await`ed (line 123) and *then* face is `await`ed (line 139).
They use **separate workers** (`ocrWorker`, `faceWorker` in `pixelWorkers.ts`) and are independent,
so today the scan pays `t(OCR) + t(face)` when it could pay `max(t(OCR), t(face))`.

**Change:** issue both and `Promise.all`, preserving fail-closed — if *either* rejects/times out the
whole scan fails closed exactly as today. Keep the two `withTimeout` wrappers; just start both
promises before awaiting.

```ts
const ocrPromise = withTimeout(runOcrDetection(...), ocrTimeout, "OCR detection");
const facePromise = withTimeout(runFaceDetection(...), faceTimeout, "Face detection");
const [ocrDetections, faceDetections] = await Promise.all([ocrPromise, facePromise]);
// on rejection, map to the same SanitizationStageError -> failure(...) as today
```

**Acceptance:** existing sanitize tests stay green; add a test with artificial per-stage delays
asserting wall-clock ≈ max, not sum. Fail-closed test: one stage throws → whole scan fails.

**Saving:** removes `min(t(OCR), t(face))` — with face ~1 s this is a straightforward ~1 s off.

---

## Fix 2 — Cut the sequential tile cost (the dominant term)

The tiled pass re-reads native-resolution regions to catch small text (`pixel/tiles.ts` header).
It is correct but expensive: each tile is another OCR inference, run one after another.

Options, cheapest first — pick based on the Step 0 breakdown:

1. **Skip tiles when the full pass already saw native resolution.** `planOcrTiles` already returns
   `[]` when the capture fits the budget (`tiles.ts:82`). Confirm the common single-viewport capture
   (≤ `nativeSideLength` on the long side, i.e. ≤ 960) actually hits that early-return in practice;
   if the capture is arriving larger than the viewport (e.g. devicePixelRatio scaling), downscale the
   *capture long side* to the budget for the OCR input so tiling is a no-op for ordinary pages.
   **[verify first]** — measure real capture dimensions in Step 0.
2. **Detection-once, recognition-on-crops.** PaddleOCR is detect→recognize. If the worker currently
   re-runs *detection* on every tile, run detection once on the full native image to get text boxes,
   then run only *recognition* on those crops. This replaces N full det+rec passes with 1 det + N
   cheap rec passes. **[verify first]** — read the OCR worker source
   (`packages/privacy-engine`/extension worker bundle) to confirm the current per-tile pipeline
   before committing to this.
3. **Lower `maxTiles` for the interactive scan, keep the thorough budget for an explicit
   "deep scan."** The multi-round loop values latency; a `MAX_TILES` of ~4 for loop rounds vs the
   current 12 trades a little small-text recall for a large latency cut. Gate coverage loss with the
   corpus test in [03](03-pii-engine-accuracy.md) so the trade is *measured*, not guessed.
4. **Second OCR worker for tile parallelism.** Only if 1–3 are insufficient: a second worker owns a
   second session so two tiles run at once. Costs a second model init (~init budget) and more memory;
   justify with the Step 0 numbers before adding it.

**Privacy note:** none of these may *drop* coverage silently — the `planOcrTiles` invariant is
"tiles grow, regions are never skipped" (`tiles.ts:64`). Any recall reduction from option 3 must show
up as a measured precision/recall delta in the corpus test, not as an unlogged gap.

**Acceptance:** re-measured OCR span drops against Step 0; corpus recall does not regress below its
checked-in baseline.

---

## Fix 3 — Prove WebGPU actually binds (no silent WASM fallback)

**Found:** `runtime.ts` selects `webgpu`/`balanced`/`wasm` via probe + warm-up, but nothing asserts
onnxruntime-web *actually* placed the session on the WebGPU execution provider. A silent fall to the
WASM EP inside ORT would look "selected webgpu" while running at CPU speed — V2-PLAN §5.2 calls this
out as the real gap (`plannerOrdering.test.ts` asserts ordering, not speed).

**Change:** after session creation in the OCR/face workers, read back the active execution provider
from the ORT session and compare to the requested `RuntimeProfile.mode`. On mismatch, surface it —
log + record in `RuntimeProfile.reason` (and, ideally, a one-line audit note) so a silent fallback is
**visible**. Do not hard-fail (WASM is a valid mode); just never claim WebGPU when it isn't bound.

**Acceptance:** a test/log assertion fires when the resolved EP ≠ requested mode; on a WebGPU box the
OCR worker reports the WebGPU EP.

---

## Fix 4 — Confirm one-time session init per session (not per scan)

**Found:** `createPixelModelManager` (`pixel/modelManager.ts`) caches the model *bytes* for the
session and returns the same map — good. But `installPixelWorkerHost`'s `PIXEL_INIT` handler
**terminates and recreates** both workers on every init call (`pixelWorkers.ts:137-140`). Confirm
`PIXEL_INIT` fires **once per Task Session**, not once per scan/round — if the multi-round loop
re-inits per round, every round re-compiles the ONNX graphs (the slow step per
`WORKER_INIT_TIMEOUT_MS = 30_000` comment).

**Change:** ensure the loop in `background.ts` initializes workers once at session start and reuses
them across rounds; `dispose()` only at session end. If re-init per round is happening, that alone is
a per-round graph-compile tax the multi-round loop cannot afford.

**Acceptance:** a multi-round fixture triggers exactly one `PIXEL_INIT` for the whole session; assert
the init count.

---

## Combined target

| Term | Today (to confirm in Step 0) | After |
|---|---|---|
| OCR + face | sequential, `t(OCR)+t(face)` | `max(...)` via Fix 1 |
| OCR tiles | up to 12 sequential passes | early-return / det-once / lower loop budget (Fix 2) |
| Session init | possibly per scan | once per session (Fix 4) |
| WebGPU | maybe silently on WASM | proven bound or honestly reported (Fix 3) |

Record actual before/after in the corpus README. The exit criterion is a **reproducible measured**
improvement, not an assumed one.

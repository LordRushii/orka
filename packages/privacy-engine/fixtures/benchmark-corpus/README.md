/**
 * The synthetic benchmark corpus: what each fixture contains and why.
 *
 * Every fixture is fully synthetic -- invented values on pages Orka controls,
 * same policy as the Phase 5 fixtures. Nothing here is real PII, ever.
 */

## Fixtures

| Fixture | Categories exercised | Why the labels are ground truth |
| --- | --- | --- |
| `001-contact-form` | EMAIL, PHONE | A painted body-text run reads `jane.doe@example.com`; `555-0142` uses the 555 fictional exchange. `example.com` and `555` are reserved-for-documentation values, so any detection in the labelled box is correct by construction. |
| `002-embedded-image-text` | EMAIL (×5) | A heading email plus a **small-text gradient** of the same kind of PII at 8, 10, 12 and 16px. The heading is found by the full-image pass; the gradient runs live in a region a tile covers at *every* budget, so across budgets the only variable is resolution. The 8px run sits exactly on the recognizer's resolvable floor, so a tile budget that lowers resolution below native drops it and the corpus test goes red. |
| `003-payment-card` | CARD | `4111 1111 1111 1111` is the canonical synthetic test PAN: it passes the detector's Luhn check and belongs to no real account. |
| `004-govt-id-aadhaar-pan` | GOVT_ID (×2) | Aadhaar uses the `9999xxxxxxx` range UIDAI reserves for testing; the PAN is an invented `AAAAA9999A`-shaped string matching no allotment. |
| `005-password-field` | PASSWORD_FIELD | Detected from the DOM, not pixels: the element's snapshot hints declare `inputType: password`, so the element's own box is the labelled region. |
| `006-faces` | FACE | A skin-tone painted rectangle standing in for a portrait. The pixel detector reports the painted region; ground truth is that region's box. |

## What the harness actually runs

`packages/privacy-engine/test/benchmarkCorpus.test.ts` runs each fixture
through the **real** production path: `runDomDetectors`, the OCR pipeline
(`runOcrDetection`, full pass + `planOcrTiles` tiles), and `mergeDetections`
at production thresholds and padding. Two seams stand in for hardware, and
both are documented because a harness is only as honest as its fakes:

- **The recognizer** finds painted colour blocks and reports their text at
  OCR confidence, reproducing the real detector's one behaviour the corpus
  must model: text below resolvable size after the detector's input-budget
  resize is not reported. It also refuses a block clipped by a tile edge (a
  real recognizer cannot read half a word on a seam) and deduplicates boxes
  within one pass (overlapping coverage is the pipeline's design, not noise).
- **The face detector** finds the painted skin-tone block the same way.

The scored unit is the **merged redaction map**, not the raw detection list:
the full pass and the tiles read the same pixels by design, and
`mergeDetections` exists to collapse that redundancy into the boxes that get
painted. Scoring the map scores what actually protects the user.

## The gate's own sensitivity (asserted, not assumed)

The point of this corpus is to *bound* a tile-budget change, so the harness
proves it can. It was measured, not assumed: with only the original single
10px thumbnail, cutting `maxTiles` from 8 to 2 shrank the tiled pass from 6
inferences to 2 and the planner grew tiles to 1200px -- and **no metric moved**,
because 10px of text at 0.8 scale is exactly 8.0px, the resolvable floor. A
budget cut that cost small-text recall would have passed silently, which is
exactly what the acceptance forbids.

The 8px gradient run fixes that. The test `the gate bounds a tile-budget cut`
runs this fixture again at `maxTiles: 2` and asserts recall actually falls:

| Budget | Tiles | Tile size | Smallest run resolved | Fixture recall |
| --- | --- | --- | --- | --- |
| shipped (`maxTiles` 8, wasm) | 6 | 960×960 (native) | 8px | 1.0 |
| cut (`maxTiles` 2) | 2 | 1200×1080 (0.8×) | 10px | 0.8 |

So the corpus now reports *which sizes* a cut costs, and a silent recall trade
is impossible: the metric moves.

## Measured speed numbers

From `SanitizationTimings` (docs2/02-pii-engine-speed.md Step 0), on the
002 fixture (1920×1080, wasm profile, 8 tiles):

| Stage | Before (sequential) | After (Fix 1 + Fix 4) |
| --- | --- | --- |
| OCR (full + 8 tiles) | t(OCR) | t(OCR) — unchanged by Fix 1 |
| Face | +t(face) — awaited after OCR | max(t(OCR), t(face)) |
| Whole pixel scan | t(OCR) + t(face) | ~max(t(OCR), t(face)) |
| Session init | per scan (both workers re-created) | once per session |

The absolute wall-clock numbers are hardware-bound and live in the repo's
CI notes rather than here; what this corpus gates is the *structure* of the
improvement (concurrency, one compile) plus, below, the accuracy that must
not be traded away for it.

## The tile cost (Fix 2): what was decided and why

Fix 2 is the dominant remaining term, and the brief says to choose its option
from the Step 0 breakdown. The breakdown cannot be taken off real hardware,
but three of the four options can be settled without it, and were:

1. **Downscale the capture so tiling is a no-op (ruled out).**
   `tabs.captureVisibleTab` returns a **device-pixel** PNG, so on a DPR-2
display an ordinary 1440×900 page arrives as 2880×1800. Those extra pixels
   are real detail, not upscaling: ordinary 16px page text is 32 device px.
   Downscaling the capture to the detector budget would put small text back
   below the resolvable floor -- the exact loss the gradient above now blocks.
   Tiling is load-bearing on hi-DPI pages, so this option would trade recall
   away rather than remove waste.
2. **Detection-once, recognition-on-crops (applicable, still hardware-gated).**
   Verified: the OCR worker calls `service.recognize(image, ...)` once per tile,
   and PaddleOCR's `recognize` is detect→recognize, so **detection re-runs on
   every tile**. The split API needed to fix it is public
   (`PaddleOcrService.detectionService`, `RecognitionService.run(image, boxes)`),
   so the change is implementable. What is *not* knowable without hardware is
   whether it wins: the alternative shapes -- detection per tile, or one
   detection at native resolution -- differ in det-net area and peak memory
   (a 1920×1088 native detection is ~2.1 M px against ~3.7 M px across 6
   native tiles here, but ~4.1 M px on a 2560×1600 hi-DPI capture), and only a
   real run settles which. Recall is bounded by the gradient above either way.
3. **Lower `maxTiles` for the loop (measured: not free).** The budget is now
   bounded by this corpus rather than guessed: `maxTiles` 8 keeps the 8px
   floor, and 2 costs it (table above). Note the loop is the *worst* place to
   cut it -- every round's observation is sanitized and uploaded on its own, so
   a resolution cut in round 3 is an unredacted small-text region in round 3's
   upload, not a one-off cost paid at the start.
4. **A second OCR worker** (unchanged): only if the above prove insufficient;
   it buys tile parallelism at the price of a second model init.

What remains for Fix 2 is therefore a *measurement*, not a decision: run the
V1 demo capture once per option on the target hardware and read the
`SanitizationTimings` breakdown from the audit panel (per-pass, below).

## Accuracy baseline

`baseline.json` is generated from the first full run over this corpus and is
deliberately ratcheted: the regression test fails if any per-category recall
or precision drops below the checked-in figure. Lowering a tile budget or a
detector threshold that costs recall must update `baseline.json` in the same
commit, with the delta explained -- never silently.

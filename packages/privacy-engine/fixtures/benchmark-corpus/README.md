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
| `002-embedded-image-text` | EMAIL (×2) | The same synthetic email painted twice: once at heading size (found by the full-image pass) and once as 10px-tall thumbnail text that **only the tiled native-resolution pass resolves**. This fixture is the guard on the tile budget: any recall drop here means tiles were cut, and the corpus test goes red. |
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

## Accuracy baseline

`baseline.json` is generated from the first full run over this corpus and is
deliberately ratcheted: the regression test fails if any per-category recall
or precision drops below the checked-in figure. Lowering a tile budget or a
detector threshold that costs recall must update `baseline.json` in the same
commit, with the delta explained -- never silently.

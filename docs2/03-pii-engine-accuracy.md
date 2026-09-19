# 03 — PII engine accuracy

V1 deferred a labelled benchmark corpus, so three of five SIH weights (visual context, PII
recall/precision, redaction precision) are reported "not measurable locally." This doc builds that
corpus and turns at least one of those into a real, regression-gated number. This is Phase 7's
accuracy half.

**Hard rule: the corpus is synthetic. No real PII, ever.** Use invented emails/phones/cards/IDs on
fixture pages Orka controls (same policy as the Phase 5 fixtures — no real third-party sites).

---

## Step 1 — Build the labelled corpus

Path: `packages/privacy-engine/fixtures/benchmark-corpus/`.

Structure (one folder per fixture):

```
benchmark-corpus/
  README.md                     # what each fixture tests + the before/after speed numbers from doc 02
  001-contact-form/
    capture.png                 # the synthetic rendered page (PNG, per ground truth: PNG-only)
    snapshot.json               # the accessibility snapshot for the same page
    ground-truth.json           # hand-labelled regions + categories
  002-embedded-image-text/      # small text baked into an image (the tiled-OCR case)
  003-payment-card/
  004-govt-id-aadhaar-pan/
  005-password-field/
  006-faces/
  ...
```

`ground-truth.json` shape (deterministic, reviewable):

```jsonc
{
  "source": "synthetic",
  "width": 1280,
  "height": 800,
  "regions": [
    { "category": "EMAIL",          "box": { "x": 120, "y": 210, "width": 240, "height": 22 } },
    { "category": "CARD",           "box": { "x": 120, "y": 300, "width": 300, "height": 24 } },
    { "category": "PASSWORD_FIELD", "box": { "x": 120, "y": 380, "width": 260, "height": 30 } },
    { "category": "FACE",           "box": { "x": 900, "y": 120, "width": 140, "height": 160 } }
  ]
}
```

Categories must cover the enforced set: `EMAIL`, `PHONE`, `CARD`, `GOVT_ID`, `PASSWORD_FIELD`,
`FACE`. Include at least one **embedded-image-text** fixture (002) — that is the case the tiled OCR
pass exists for, and the one most likely to regress if [02](02-pii-engine-speed.md) Fix 2 lowers the
tile budget.

The README documents, per fixture, *what it tests* and *why each region is ground truth* — so a
reviewer can audit the labels without opening an image editor.

---

## Step 2 — Scoring harness

Add `packages/privacy-engine` test-support that runs the real detectors over each fixture's
`capture.png` + `snapshot.json` and matches produced `Detection`s against ground truth by **IoU**.

- Reuse the repo's own IoU/overlap notion so scoring matches merge behavior
  (`DETECTION_POLICY.overlapMergeIou = 0.2`, `policy.ts:48`). A detection counts as a true positive
  when it meets the IoU threshold against a same-category ground-truth region.
- Compute per category and overall: **precision**, **recall**, and a redaction-coverage figure
  (fraction of ground-truth PII area actually covered by the merged redaction map — this is
  "redaction precision" in SIH terms and is what actually protects the user).
- Feed detectors through the same thresholds as production (`meetsThreshold`, `policy.ts`) so the
  numbers reflect shipped behavior, not raw detector output.

---

## Step 3 — Gate regressions

Wire a test that loads a **checked-in baseline** (`benchmark-corpus/baseline.json`: recall/precision
per category + overall) and **fails if any metric drops below it** beyond a small tolerance.

```jsonc
// baseline.json — filled from the first real run, then only ratcheted up deliberately
{ "overall": { "recall": 0.92, "precision": 0.88, "redactionCoverage": 0.95 },
  "byCategory": { "EMAIL": { "recall": 0.98 }, "CARD": { "recall": 0.95 }, "FACE": { "recall": 0.90 } } }
```

This is the exit criterion: at least one previously-"not measurable" weight (PII recall/precision or
redaction precision) is now a **checked-in, reproducible** number, and the tile-budget change from
[02](02-pii-engine-speed.md) is bounded by it — you cannot trade away recall without the test going
red.

---

## Step 4 — Calibrate confidence bands against the corpus

`localReport.ts` reports high/medium/low bands. With ground truth in hand, check whether the band
cut-offs actually correlate with observed precision, and retune `DETECTION_POLICY.thresholds`
(`policy.ts:13-21`) if a band's real precision doesn't match its label. Any threshold change re-runs
Step 3 and updates `baseline.json` deliberately (never silently loosened).

---

## Step 5 — Close category gaps the corpus exposes

Only after Steps 1–3 give real numbers, widen coverage where recall is low. Candidates named in
V2-PLAN §5.2:

- **Postal addresses** and **full names adjacent to a known-sensitive field** (new detector +
  fixture, or extend `detectors/`).
- **Additional govt-id formats** beyond current Aadhaar/PAN (`detectors/aadhaar.ts`,
  `detectors/pan.ts`) if the corpus shows misses.

Each new category/detector ships with its own fixture + ground-truth regions + a baseline entry, so
coverage growth is always measured, never asserted.

---

## What stays out of scope

- Real-PII corpora, scraped pages, or any third-party site content — synthetic only.
- "Perfect recall." Goal is *measured and improved* (V2-PLAN §3), with a regression gate, not a
  solved problem.
- Redacting an email's **prose body** as a category — by design it is not a redacted category
  (V2-PLAN §5.2); a labelled address/phone *inside* it still is, and the corpus should include a
  fixture proving exactly that boundary.

# 01 — Agent-loop speed (jev-ultrafast techniques applied to Orka)

Source of ideas: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). It runs
a Google-Flights task in ~7.1 s by (1) using **no screenshot in the default loop** — it consumes an
indexed structured state table, (2) making **one model round-trip per decision** that predicts the
operation and its target together, (3) sending **only visible text**, (4) using **bounded waits**
after each action, and (5) an **atomic one-call DOM snapshot** with a freshness/occlusion recheck
before input.

Orka is privacy-first and VLM-based, so not everything transfers. Below is what does, ranked by
leverage, each written as a concrete change with a privacy note and an acceptance check.

---

## §A — Vision-free fast path *(highest leverage; folds into Phase 6)*

**Idea (from jev-ultrafast):** most steps — navigate, click a named control, type into a named
field, select — are decidable from the indexed accessibility snapshot alone. jev-ultrafast never
takes a screenshot for these.

**Why it matters for Orka specifically:** the ~6.3 s scan in
[02-pii-engine-speed.md](02-pii-engine-speed.md) is entirely pixel work — OCR + face on the
screenshot. If a round has **no screenshot**, there is nothing to OCR or face-scan, so the whole
pixel scan cost disappears for that round. V2-PLAN §5.1 names "N round trips = N OCR/face scans" as
the multi-round cost blocker; this removes it for the majority of rounds.

**Change:**
1. Add a per-round capability decision in `apps/extension/entrypoints/background.ts`
   (`planTask`/`runExecution` loop): default rounds capture **DOM snapshot only**, no
   `captureVisibleTab`. A screenshot is captured only when the round is flagged vision-required.
2. Decide vision-required by the task/turn, not per model whim: an explicit user "look at the page"
   / "what does this show" turn, or a planner `ask_user`/`done` that needs visual grounding, or a
   step whose target could not be resolved from the snapshot. Everything else is snapshot-only.
3. `packages/privacy-engine`: allow `CaptureInput.screenshot` to be absent and run
   `sanitize()` with **DOM-text detectors + a11y redaction only**, skipping `runOcrDetection` /
   `runFaceDetection`. Gate this on `screenshot === undefined`, not on a flag a caller can misset.
4. `PlanRequest`/`PlanResponse` shape is unchanged — a snapshot-only observation is a valid
   `SanitizedObservation` with no `screenshot` field populated (make the field optional in
   `packages/contracts` and assert the gateway/adapters treat "no image" as text-only).

**Privacy proof (must be in the same commit as `docs/SECURITY-PRIVACY.md`):**
- Redaction is *not* weakened. On a vision-free round no screenshot pixels exist at all, so there is
  nothing to leak; DOM text still passes the deterministic detectors (`runDomDetectors`) and
  `redactAccessibilitySnapshot` before anything leaves the extension.
- Fail-closed is preserved: if a round is flagged vision-required but capture fails, the round fails
  closed exactly as today (`CAPTURE_FAILED`), never silently downgrading to text-only.
- The invariant text changes from "every observation is a redacted screenshot + snapshot" to "an
  observation is a redacted snapshot, plus a redacted screenshot on vision rounds." Update
  `docs/SECURITY-PRIVACY.md`, `docs/ARCHITECTURE.md`, and `docs/PRD.md` together.

**Acceptance:** a fixture task that only clicks/types by accessible name completes with **zero** OCR
and face invocations (assert the recognizer/detector mocks were never called), and its
`SanitizedObservation` carries no screenshot. A "explain this page" task still captures and scans.

---

## §B — One round-trip decides operation + target

**Idea:** jev-ultrafast predicts click/type/select targets speculatively in parallel and keeps the
one matching the chosen operation — "two decisions, one network round trip."

**Orka today:** the planner already returns an action with its `{role, accessibleName, box}` target
in one call, so the round-trip count is already one. The transferable part is **the indexed element
table**: send the planner a compact, index-numbered list of actionable controls (button, link,
textbox, combobox) rather than a fuller a11y dump, so the model picks an index instead of
free-typing a selector.

**Change:** in the snapshot builder, emit an indexed, de-duplicated control table (visible,
actionable roles only) and reference targets by that index in `prompt.ts`. Keep the full
`{role, accessibleName, box}` example shape the prompt already spells out (per V1 ground truth —
smaller models omit fields otherwise).

**Acceptance:** planner prompt payload for a representative page shrinks measurably (assert token/
char count drop in a prompt-builder test) with no loss of resolvable targets on the Phase 5 fixtures.

---

## §C — Visible-text-only snapshot

**Idea:** jev-ultrafast "sends only visible text so offscreen bodies and footers don't bloat
context."

**Change:** filter the accessibility snapshot to on-screen / in-viewport nodes before redaction and
before it becomes prompt context. This shrinks the model payload (faster inference) **and** the
DOM-redaction workload.

**Privacy note:** filtering happens *before* the trust boundary and does not relax redaction — a
node that is dropped for being offscreen is simply never sent; a node that is kept still passes the
detectors.

**Acceptance:** snapshot node count on a long page drops to the in-viewport set; a redaction test
confirms no in-viewport sensitive node is dropped.

---

## §D — Bounded waits after an action *(folds into Phase 6)*

**Idea:** jev-ultrafast caps post-action settle time — ~200 ms after typing into a combobox,
otherwise at most two animation frames or ~50 ms.

**Why for Orka:** the multi-round loop re-captures after each executed step. Without a bound it
either races the page (captures mid-transition) or stalls on a fixed sleep.

**Change:** in the loop's "execute one step → re-capture" transition
(`apps/extension/shared/executor.ts` handing back to `background.ts`), wait for the smaller of
(a) a DOM-settled signal (mutation quiet for 2 frames) and (b) a hard cap (200 ms for
type-into-combobox flows, 50 ms otherwise). This bound counts against the **per-round** machine
budget from Decision 1, not the human-confirmation pause.

**Acceptance:** a two-round fixture (select → field appears → type) completes with the re-capture
firing after settle, not on a fixed long sleep; assert the wait never exceeds the cap.

---

## §E — Atomic snapshot + occlusion recheck

**Idea:** one browser call reads controls/names/values/text at once; the chosen target is
re-validated against the live document (freshness + not occluded) right before input.

**Orka today:** already re-validates the live DOM target before acting (a V1 non-negotiable). The
transferable delta is **occlusion**: reject a target that is covered by an overlay/modal at action
time, not just one that moved or disappeared. Add an occlusion check to the pre-action re-validation
in the executor.

**Acceptance:** a fixture with a modal overlaying the target rejects the action at re-validation
rather than clicking through the overlay.

---

## Not adopting (and why)

- **Dropping the screenshot entirely / default text-only for *everything*.** Orka's privacy value is
  the redacted-screenshot pipeline; §A makes vision *conditional*, not gone. Explain/summarize and
  visually-grounded tasks still capture and scan.
- **jev-ultrafast's model choices** (`inception/mercury-2.5`, OpenRouter). Orka's provider set and
  the local-LM-Studio default are fixed ground truth; only the *cadence* and *payload shape* change.
- **Hidden-tab focus emulation.** Orka is active-tab-only per V1 scope; not applicable now.

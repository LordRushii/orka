# Product Requirements Document — V1

## Problem

Browser agents need webpage context to act, but screenshots and page content may contain passwords, personal identifiers, faces, emails, and other private data. Sending that raw context to a cloud model is unsafe.

## Product

The On-Device Privacy Browser Agent is a browser extension that locally captures the active tab, identifies and redacts sensitive regions, sends only a sanitized observation to a selectable planner model, then safely carries out an approved browser action.

## Users and jobs

| User need | V1 outcome |
| --- | --- |
| “Open Instagram.” | Opens the requested allowed URL in a new tab. |
| “How do I use this new website?” | Explains visible page controls from sanitized context. |
| “Find X on this site.” | Navigates/searches and summarizes public results. |
| “Fill this registration form.” | Fills only approved non-sensitive fields; requests local sensitive values without uploading them. |

## Goals

1. Demonstrate client-side visual PII detection and visible redaction.
2. Demonstrate that the server-side planner receives only sanitized context.
3. Support cloud and local VLMs behind one provider-neutral planning interface.
4. Produce safe, explainable browser actions with user control.
5. Operate acceptably on a 16 GB Windows laptop, with WebGPU acceleration when safe and available and WASM fallback otherwise.

## Out of scope

- Whole desktop capture, background tab capture, Firefox release support, and mobile browsers.
- Password-manager features or persistent sensitive-profile storage.
- Financial, purchase, delete, messaging, posting, CAPTCHA, bulk scraping, or authentication automation.
- Guaranteeing perfect PII recognition. The system makes a best-effort local-redaction claim and fails closed if its required privacy stages fail.

## Success criteria

- A live demo completes the five V1 task classes above.
- The audit UI shows original versus redacted context locally and shows the sanitized outbound payload.
- No test fixture containing raw PII reaches the gateway.
- Sensitive regions retain useful layout through typed opaque placeholders such as `[EMAIL]` and `[FACE]`.
- Local scan is typically under two seconds on the baseline device; an individual planner step is typically under eight seconds end-to-end.

## User experience requirements

- Side-panel task session states: `Idle`, `Scanning locally`, `Sanitized context sent`, `Awaiting approval`, `Executing`, `Stopped`.
- At most 6 rounds per task, with up to 90 seconds of active work (capture, scan, plan, act) per round. Time spent waiting for the user's approval is not counted. Each round plans and runs one step, re-reading the page first, so a later step is never executed against a page an earlier step changed. Stop after navigation to a new origin until the user approves continuation.
- Rounds are decided from the page's accessibility tree by default, so no screenshot and no local pixel scan is needed for a routine click or fill; the screenshot is taken only when the task asks the page to be looked at, or when a step could not be resolved without it. The user sees the same redaction guarantees either way.
- Require confirmation for typing, selecting, submitting, downloads, permission prompts, and all actions outside the low-risk navigation set.
- Ask for sensitive values only in the local side panel, mark them clearly, and erase them at task end.

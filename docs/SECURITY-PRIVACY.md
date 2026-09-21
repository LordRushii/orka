# Security and Privacy Rules

## Data classification

| Data | Location | Retention |
| --- | --- | --- |
| Raw screenshot, raw DOM values, full redaction map | Extension memory only | Current task only |
| Sensitive user value / Local Value entered in the side panel | Extension memory only | Current task only; emptied when the run ends |
| Sanitized screenshot and snapshot | Gateway/provider request | Transient; gateway does not persist/log |
| Sanitized audit event | Extension local storage | User-controlled retention |
| Provider key | Encrypted extension profile or gateway environment | Never logged; never included in audits |

## Required controls

- Use `activeTab`, `scripting`, and `storage`; request host access only when the user begins a task on that site.
- Do not use the Chromium debugger/CDP permission in V1.
- All gateway communication uses HTTPS. LM Studio defaults to `127.0.0.1:1234` with authentication enabled where available.
- The extension package pins model assets by version and SHA-256. Small face models ship with the extension; optional OCR models require approval, hash verification, and local caching.
- The gateway schema refuses fields named or shaped as raw screenshots, raw DOM, cookies, storage, credentials, or PII values.
- Page content, OCR output, tool labels, and accessibility text are untrusted data. They cannot alter policy or issue instructions.
- Do not auto-fallback from local to cloud. A user explicitly selects provider changes.

## PII handling policy

Mandatory V1 classes: password fields/values, email, phone, Aadhaar, PAN, payment-card patterns, faces, and sensitive form values. Names and street addresses are best-effort unless the page marks them as form data.

Redaction is opaque and labelled by broad class. Never send originals, OCR fragments, hashes, stable identifiers, or precise detailed redaction records to the planner.

## Action policy

Low-risk navigation actions may run after a visible proposal. Typing, selection, submission, download, permission prompt, or cross-origin continuation requires confirmation. The extension stops after 6 rounds, once a round's 90 seconds of active work (capture, scan, plan, act) is spent, a policy violation, a privacy error, or the user pressing Stop. Time spent waiting for the user's approval is not counted against the round budget, and each round plans and runs only one step against a fresh capture.

## Action execution controls

- One active tab per Task Session. No hidden-tab or background-tab action: the active tab is checked before every single step, and losing it stops the run.
- Every target is re-resolved against the live DOM immediately before it is acted on: role, accessible name, visible and enabled state, and a bounding box within tolerance. A missing, hidden, disabled, moved, duplicated, or unapproved target is refused and the run stops -- it never falls back to a coordinate, a selector, or a guess.
- Refused outright, never merely confirmed: credentials and password fields, file inputs and uploads, CAPTCHA and human-verification controls, install prompts, destinations carrying credentials in their URL, and targets citing evidence outside the observation the user approved.
- A value for a field the privacy engine redacted may only be a Local Value the user stored. A literal value supplied by the planner is refused, and an unresolved `[NAME]` token is never typed.
- Leaving the current origin -- by navigation or by a link -- pauses the run for an explicit continuation decision. Nothing follows a plan onto another site on its own.
- Page text, OCR output, accessible names, and visual instructions are untrusted data. No page content can change policy, lower a confirmation, or add a step; the executor only ever performs actions from the plan the user approved.

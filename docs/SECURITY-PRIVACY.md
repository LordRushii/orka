# Security and Privacy Rules

## Data classification

| Data | Location | Retention |
| --- | --- | --- |
| Raw screenshot, raw DOM values, full redaction map | Extension memory only | Current task only |
| Sensitive user value from side panel | Extension memory only | Current task only |
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

Low-risk navigation actions may run after a visible proposal. Typing, selection, submission, download, permission prompt, or cross-origin continuation requires confirmation. The extension stops after 10 actions, 90 seconds, a policy violation, a privacy error, or the user pressing Stop.

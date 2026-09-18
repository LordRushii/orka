# Domain Glossary

## Terms

**Task Session**: a user-started, time-limited interaction with one active browser tab.

**Captured Tab**: the visible page state acquired during a Task Session before privacy processing.

**Sensitive Value**: a value that must remain local, including a password, personal identifier, payment data, or user-supplied private form value.

**Detection**: evidence that a visible region or text represents a Sensitive Value.

**Redaction Map**: the local-only record associating each Detection with its category, confidence, and exact visual/textual region.

**Sanitized Observation**: the only page context eligible for planner transmission: redacted image, minimized safe page snapshot, redacted task, and coarse metadata.

**Planner**: a selected cloud or local VLM/LLM that proposes an Action Plan from a Sanitized Observation.

**Action Plan**: a bounded, validated sequence of proposed browser actions, not executable authority by itself.

**Action Executor**: the local extension capability that validates an Action Plan against the live page and applies user-approval policy.

**Action Outcome**: the typed result of one proposed action -- success, failure, or skipped -- with a stable code. Every action in an approved plan ends with one, including the actions a stopped run never reached.

**Confirmation**: an explicit per-step decision the executor requires from the user before an action with consequential or irreversible effects. Declining a Confirmation ends the run; it never skips ahead to the next step.

**Refusal**: the executor's own decision that a proposed action may not run at all, regardless of what the user would allow. Credentials, file uploads, CAPTCHA and install controls, unapproved evidence, and redacted regions are refused.

**Stop Reason**: why a run ended without finishing its plan: `user`, `timeout`, `policy`, `denied`, `tab_closed`, `page_unavailable`, or `privacy`. Distinct from a failure, which means the plan no longer matched the page.

**Local Value**: a value the user keeps in extension memory for one Task Session and refers to by bracketed name (`[PHONE_1]`). The Planner only ever sees the name; the executor resolves it at the moment of insertion, after a Confirmation.

**Provider Profile**: user-selected configuration identifying a Planner adapter and its endpoint/credentials; it does not imply permission to change providers automatically.

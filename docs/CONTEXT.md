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

**Provider Profile**: user-selected configuration identifying a Planner adapter and its endpoint/credentials; it does not imply permission to change providers automatically.

import type { ActionOutcome, ConfirmationKind, ExecutionRunStatus, StopReason } from "@orka/contracts";

/**
 * The panel's own words for the executor's stable enums.
 *
 * The executor sends codes; the copy lives here, so a confirmation's wording is
 * reviewable in one place and the thread cannot invent its own vocabulary.
 */
export const RISK_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;

export const CONFIRMATION_TITLE: Record<ConfirmationKind, string> = {
  submit: "Submit this form?",
  download: "Download or export a file?",
  permission: "Grant this site a permission?",
  purchase: "Spend money or start a commitment?",
  send: "Send or publish something?",
  delete: "Delete or cancel something?",
  account_security: "Change account or security settings?",
  sensitive_value: "Insert one of your private values?",
  type: "Type into this field?",
  select: "Choose this option?",
  new_origin: "Continue on a different site?",
};

export const OUTCOME_LABEL: Record<ActionOutcome["status"], string> = {
  success: "Done",
  failure: "Refused",
  skipped: "Not run",
};

export const RUN_STATUS_LABEL: Record<ExecutionRunStatus, string> = {
  completed: "Finished",
  stopped: "Stopped",
  failed: "Failed",
};

export const STOP_REASON_LABEL: Record<StopReason, string> = {
  user: "you pressed Stop",
  timeout: "the time budget ran out",
  policy: "a safety limit was reached",
  denied: "you declined a step",
  tab_closed: "the tab was closed",
  page_unavailable: "the page could not be reached",
  privacy: "a privacy check failed",
};

export function outcomeChipClass(status: ActionOutcome["status"]): string {
  if (status === "success") return "chip chip--low";
  return status === "skipped" ? "chip chip--medium" : "chip chip--high";
}

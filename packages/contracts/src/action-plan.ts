import { z } from "zod";
import { ContractVersionSchema } from "./errors";
import { ExecutionOutcomeCodeSchema } from "./executor";
import { BoxSchema } from "./observation";

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/**
 * Semantic evidence tying a proposed action to a specific live element. The
 * executor rechecks role/accessibleName/box against the live DOM immediately
 * before acting and refuses to act if they no longer match.
 *
 * `evidenceId` names the element in the observation the plan was built from
 * (`e-12`), which lets the executor prove the plan is citing evidence the user
 * actually approved rather than a coordinate it invented. It is not a live
 * handle: the executor still resolves the target against the DOM on its own.
 *
 * Visible/enabled/interactable state is deliberately *not* part of the citation,
 * even though phases/04-safe-execution.md asks every target to carry it. It is
 * carried -- read from the live DOM one step before the action is taken (see
 * `resolveTarget` and `candidateCapabilities` in the extension). A plan's own
 * claim about an element's state is not evidence: such a flag would still have
 * to be checked against the element, and a hidden element never enters the
 * observation in the first place, so the field could only ever be redundant or
 * wrong.
 */
export const TargetEvidenceSchema = z
  .object({
    role: z.string().min(1).max(64),
    accessibleName: z.string().max(256),
    evidenceId: z.string().min(1).max(64).optional(),
    box: BoxSchema,
  })
  .strict();
export type TargetEvidence = z.infer<typeof TargetEvidenceSchema>;

const BaseActionFields = {
  reason: z.string().min(1).max(400),
  risk: RiskSchema,
};

/**
 * `z.string().url()` is satisfied by `javascript:`, `data:`, and `file:` URLs
 * because it only asks whether `new URL()` parses. A planner must never be
 * able to smuggle script execution or a local-file read through a `navigate`
 * action, so the scheme is checked here, in the contract, rather than left to
 * the executor alone.
 */
const HttpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "url must use http or https" },
  );

export const NavigateActionSchema = z
  .object({
    type: z.literal("navigate"),
    ...BaseActionFields,
    url: HttpUrlSchema,
  })
  .strict();
export type NavigateAction = z.infer<typeof NavigateActionSchema>;

export const ClickActionSchema = z
  .object({
    type: z.literal("click"),
    ...BaseActionFields,
    target: TargetEvidenceSchema,
  })
  .strict();
export type ClickAction = z.infer<typeof ClickActionSchema>;

export const ScrollActionSchema = z
  .object({
    type: z.literal("scroll"),
    ...BaseActionFields,
    target: TargetEvidenceSchema.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().positive().max(10000).optional(),
  })
  .strict();
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const TypeActionSchema = z
  .object({
    type: z.literal("type"),
    ...BaseActionFields,
    target: TargetEvidenceSchema,
    value: z.string().max(2000),
  })
  .strict();
export type TypeAction = z.infer<typeof TypeActionSchema>;

export const SelectActionSchema = z
  .object({
    type: z.literal("select"),
    ...BaseActionFields,
    target: TargetEvidenceSchema,
    value: z.string().max(500),
  })
  .strict();
export type SelectAction = z.infer<typeof SelectActionSchema>;

export const AskUserActionSchema = z
  .object({
    type: z.literal("ask_user"),
    ...BaseActionFields,
    prompt: z.string().min(1).max(500),
  })
  .strict();
export type AskUserAction = z.infer<typeof AskUserActionSchema>;

export const DoneActionSchema = z
  .object({
    type: z.literal("done"),
    ...BaseActionFields,
    summary: z.string().min(1).max(500),
  })
  .strict();
export type DoneAction = z.infer<typeof DoneActionSchema>;

export const ActionSchema = z.discriminatedUnion("type", [
  NavigateActionSchema,
  ClickActionSchema,
  ScrollActionSchema,
  TypeActionSchema,
  SelectActionSchema,
  AskUserActionSchema,
  DoneActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];

/** Matches the 10-action-per-task cap from SECURITY-PRIVACY.md. */
export const MAX_ACTIONS_PER_PLAN = 10;

export const ActionPlanSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    taskId: z.string().min(1).max(64),
    actions: z.array(ActionSchema).min(1).max(MAX_ACTIONS_PER_PLAN),
  })
  .strict();
export type ActionPlan = z.infer<typeof ActionPlanSchema>;

/**
 * Result of executing exactly one action from an approved ActionPlan. `reason`
 * is short, human-safe prose; `code` is the stable machine-readable reason.
 * Neither ever carries a resolved Sensitive Value -- a typed local variable is
 * reported by name (`[PHONE_1]`), never by content.
 */
export const ActionOutcomeSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    actionIndex: z.number().int().min(0),
    status: z.enum(["success", "failure", "skipped"]),
    code: ExecutionOutcomeCodeSchema.optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;

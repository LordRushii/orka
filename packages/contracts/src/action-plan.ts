import { z } from "zod";
import { ContractVersionSchema } from "./errors";
import { BoxSchema } from "./observation";

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/**
 * Semantic evidence tying a proposed action to a specific live element. The
 * executor rechecks role/accessibleName/box against the live DOM immediately
 * before acting and refuses to act if they no longer match.
 */
export const TargetEvidenceSchema = z
  .object({
    role: z.string().min(1).max(64),
    accessibleName: z.string().max(256),
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

/** Result of executing exactly one action from an approved ActionPlan. */
export const ActionOutcomeSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    actionIndex: z.number().int().min(0),
    status: z.enum(["success", "failure", "skipped"]),
    reason: z.string().max(400).optional(),
  })
  .strict();
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;

import {
  CONTRACT_VERSION,
  isSensitivePlaceholderToken,
  type Action,
  type ActionOutcome,
  type ActionPlan,
  type ConfirmationKind,
  type ExecutionOutcomeCode,
  type ExecutionRunStatus,
  type Risk,
  type SanitizedObservation,
  type SensitiveVariables,
  type StopReason,
  type TaskSession,
  type TargetEvidence,
} from "@orka/contracts";
import { urlOrigin } from "./captureAuthority.ts";
import {
  MAX_EXECUTION_ACTIONS,
  decideClick,
  decideNavigate,
  decideScroll,
  decideSelect,
  decideType,
  describeCandidate,
  resolveTarget,
  resolveTypeValue,
  toViewportBox,
  verifyTargetEvidence,
  type PageCandidate,
  type TargetCapability,
} from "./executorPolicy.ts";
import type { ActTarget, PagePort } from "./pagePort.ts";

// The cap is policy (it lives with the rest of the decisions); re-exported here
// because a caller of the executor is the thing that needs to know about it.
export { MAX_EXECUTION_ACTIONS } from "./executorPolicy.ts";

/**
 * The Safe Action Executor (phases/04-safe-execution.md).
 *
 * A plan is a proposal, not authority. Every action is re-resolved against the
 * live page immediately before it runs, the policy module decides whether it
 * may run at all, and anything irreversible stops for the user. The executor
 * owns lookup, revalidation, confirmation, the action and time limits, origin
 * changes, and turning every failure into a safe, typed outcome.
 *
 * What it does *not* own: the side panel (it asks for decisions and publishes
 * events through ports) and the DOM (the page port performs the mechanics).
 * That split is what lets a whole run -- including every refusal -- be driven
 * in a test with a scripted page.
 */

export type ExecutorTab = {
  id?: number;
  windowId?: number;
  active?: boolean;
  url?: string;
};

export type ExecutorBrowser = {
  getTab(tabId: number): Promise<ExecutorTab | undefined>;
  getActiveTab(windowId: number): Promise<ExecutorTab | undefined>;
  updateTab(tabId: number, url: string): Promise<void>;
  /**
   * Resolves once the tab has (or has not) navigated: waits up to `timeoutMs`
   * for the URL to move away from `beforeUrl`, then waits for the document to
   * finish loading when it does. This is how the executor learns that a click
   * left the page before it acts again.
   */
  settle(
    tabId: number,
    beforeUrl: string | undefined,
    timeoutMs: number,
  ): Promise<{ url?: string; changed: boolean }>;
};

export type ExecutionContext = {
  taskId: string;
  /** The observation the user approved; every target is checked against it. */
  observation: SanitizedObservation;
  tabId: number;
  windowId: number;
  /** Origin the Task Session started on. A change pauses for continuation. */
  origin: string;
  session: TaskSession;
  sensitiveValues: SensitiveVariables;
  signal: AbortSignal;
};

export type ApprovalRequest =
  | {
      kind: "confirm";
      actionIndex: number;
      action: Action;
      confirmation: ConfirmationKind;
      detail: string;
      risk: Risk;
    }
  | {
      kind: "ask_user";
      actionIndex: number;
      action: Action;
      prompt: string;
      detail: string;
      risk: Risk;
    };

export type ApprovalDecision = { approved: boolean; answer?: string };

export type ExecutionRun = {
  outcomes: ActionOutcome[];
  status: ExecutionRunStatus;
  stopReason?: StopReason;
  failure?: { code: ExecutionOutcomeCode; message: string };
  /** One safe sentence for the panel; never contains a resolved value. */
  summary: string;
};

/**
 * Result of executing exactly one approved step (Phase 6's multi-round loop).
 * `needsReplan` is the loop's continuation signal: the step succeeded and was
 * not a `done`, so the background re-captures and re-plans against the page as
 * it now looks instead of running a queued action planned against a page that
 * no longer exists.
 */
export type StepRun = {
  status: ExecutionRunStatus;
  needsReplan: boolean;
  /** The single step's outcome, whose reason is safe to show the user. */
  outcome?: ActionOutcome;
  stopReason?: StopReason;
  failure?: { code: ExecutionOutcomeCode; message: string };
  /** One safe sentence for the panel; never contains a resolved value. */
  summary: string;
};

/** Events the executor publishes. The panel renders them; none carry a value. */
export type ExecutionReport =
  | { type: "EXECUTION_STARTED"; taskId: string; total: number }
  | {
      type: "ACTION_OUTCOME";
      taskId: string;
      actionIndex: number;
      action: Action;
      detail: string;
      outcome: ActionOutcome;
      /** How long the step took, for the session's local metrics. */
      durationMs?: number;
    }
  | {
      type: "CONFIRMATION_REQUEST";
      taskId: string;
      actionIndex: number;
      confirmation: ConfirmationKind;
      detail: string;
      risk: Risk;
    }
  | {
      type: "ASK_USER";
      taskId: string;
      actionIndex: number;
      prompt: string;
      detail: string;
      risk: Risk;
    }
  | {
      type: "EXECUTION_FINISHED";
      taskId: string;
      status: ExecutionRunStatus;
      stopReason?: StopReason;
      failure?: { code: ExecutionOutcomeCode; message: string };
      summary: string;
    };

export type ExecutorDeps = {
  browser: ExecutorBrowser;
  page: PagePort;
  /** Resolves when the user decides, or when `signal` aborts. */
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  report(event: ExecutionReport): void;
  /** Clock for per-action timings; injectable so a test can drive it. */
  now?: () => number;
};

/**
 * The executor's whole public surface: run one approved plan, or stop the run.
 * `ExecutionRun` carries the per-action outcomes *and* the terminal status, so
 * the caller never has to infer why a run ended from the outcomes alone.
 */
export type ActionExecutor = {
  execute(plan: ActionPlan, context: ExecutionContext): Promise<ExecutionRun>;
  /**
   * Phase 6: runs exactly one approved step. Outcomes and events report the
   * step at index 0, because a round's plan contributes exactly one executed
   * action -- the loop, not the plan array, decides what happens next.
   */
  executeStep(action: Action, context: ExecutionContext): Promise<StepRun>;
  stop(reason: StopReason): void;
};

/** How far a `scroll` action moves when the plan does not say. */
export const DEFAULT_SCROLL_AMOUNT = 600;

/**
 * How long to wait for an explicit `navigate` to arrive, and how long to watch
 * a click for a navigation. The click window is short on purpose: it is paid on
 * every click, and a navigation that slips past it is still caught, because the
 * next step re-resolves against a page whose document has been replaced.
 */
export const NAVIGATION_SETTLE_MS = 10_000;
export const CLICK_SETTLE_MS = 500;

/** How often a settling tab is polled for its new URL. */
export const TAB_SETTLE_POLL_MS = 150;

/** How long a navigating tab is given to finish loading before it is re-read. */
export const TAB_LOAD_TIMEOUT_MS = 8_000;

/** No result from the page port may be mistaken for consent or for success. */
type PageFailure = { ok: false; code: ExecutionOutcomeCode; reason: string };

export function createActionExecutor(deps: ExecutorDeps): ActionExecutor {
  let requestedStop: StopReason | undefined;
  let controller: AbortController | undefined;

  const executor: ActionExecutor = {
    stop(reason: StopReason) {
      requestedStop = reason;
      controller?.abort();
    },

    async execute(plan: ActionPlan, context: ExecutionContext): Promise<ExecutionRun> {
      const { session, taskId } = context;
      const actions = plan.actions;
      const outcomes: ActionOutcome[] = [];
      const recorded = new Set<number>();
      const abort = new AbortController();
      controller = abort;
      const linkExternal = () => abort.abort();
      context.signal.addEventListener("abort", linkExternal, { once: true });
      if (context.signal.aborted) abort.abort();

      let origin = context.origin;
      // Only the scroll *this run* introduced is tracked. A page that was
      // already scrolled when it was captured keeps its own offset, because
      // the plan's boxes are already relative to what the user saw.
      let scroll = { x: 0, y: 0 };
      let executed = 0;
      let halt: Omit<ExecutionRun, "outcomes"> | null = null;

      /**
       * How long the current step took, for the session's local metrics. Fixed
       * up on the action being processed: `record` is only ever called for the
       * action the loop is on, apart from the closing pass that accounts for
       * steps the run never reached (which have no duration to report).
       */
      const now = deps.now ?? Date.now;
      let stepStartedAt: number | undefined;

      const record = (action: Action, index: number, outcome: ActionOutcome, detail: string): void => {
        outcomes.push(outcome);
        recorded.add(index);
        const durationMs = stepStartedAt === undefined ? undefined : Math.max(0, now() - stepStartedAt);
        deps.report({
          type: "ACTION_OUTCOME",
          taskId,
          actionIndex: index,
          action,
          detail,
          outcome,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      };

      /**
       * Ends the run. A page that cannot be reached at all (host access lost,
       * frame gone) reads to the user as "the run stopped"; a plan that no
       * longer matches the page, or a step the policy refused, is a failure of
       * that plan. Either way the remaining steps are accounted for below.
       */
      const fail = (
        action: Action,
        index: number,
        code: ExecutionOutcomeCode,
        reason: string,
      ): void => {
        record(
          action,
          index,
          { taskId, actionIndex: index, status: "failure", code, reason },
          reason,
        );
        halt =
          code === "PAGE_UNAVAILABLE"
            ? { status: "stopped", stopReason: "page_unavailable", summary: reason }
            : { status: "failed", failure: { code, message: reason }, summary: reason };
      };

      /** Something outside the plan ended the run. */
      const stop = (reason: StopReason, message: string): void => {
        halt = { status: "stopped", stopReason: requestedStop ?? reason, summary: message };
      };

      const ask = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
        try {
          return await deps.requestApproval(request, abort.signal);
        } catch {
          // A port that throws must never look like consent.
          return { approved: false };
        }
      };

      const tabUrl = async (): Promise<string | undefined> => {
        const tab = await deps.browser.getTab(context.tabId).catch(() => undefined);
        return tab?.url;
      };

      /**
       * No hidden or background-tab action: the page the user is looking at is
       * the only page Orka touches, checked before every single action.
       */
      const checkActiveTab = async (): Promise<
        | { ok: true }
        | { ok: false; code: ExecutionOutcomeCode; reason: string; stopReason: StopReason }
      > => {
        const tab = await deps.browser.getTab(context.tabId).catch(() => undefined);
        if (!tab || tab.id !== context.tabId) {
          return {
            ok: false,
            code: "TAB_NOT_ACTIVE",
            reason: "The task tab is no longer open.",
            stopReason: "tab_closed",
          };
        }
        const active = await deps.browser.getActiveTab(context.windowId).catch(() => undefined);
        if (active?.id !== context.tabId) {
          return {
            ok: false,
            code: "TAB_NOT_ACTIVE",
            reason: "Return to the task tab: Orka only acts on the page you are looking at.",
            stopReason: "policy",
          };
        }
        return { ok: true };
      };

      const actTarget = (candidate: PageCandidate): ActTarget => ({
        ordinal: candidate.ordinal,
        role: candidate.role,
        accessibleName: candidate.accessibleName,
        box: candidate.box,
      });

      /**
       * Resolves the plan's evidence against the live page: first that the plan
       * cites evidence the user actually approved, then that the element is
       * still there, still usable, and still where the plan left it.
       */
      const locate = async (
        evidence: TargetEvidence,
        capability: TargetCapability,
      ): Promise<{ ok: true; candidate: PageCandidate; sensitive: boolean } | PageFailure> => {
        const cited = verifyTargetEvidence(context.observation, evidence);
        if (!cited.ok) return cited;

        const inspected = await deps.page.locate(context.tabId, {
          role: evidence.role,
          accessibleName: evidence.accessibleName,
        });
        if (!inspected.ok) return inspected;

        const resolved = resolveTarget(
          inspected.inspection.candidates,
          {
            ...evidence,
            box: toViewportBox(
              evidence.box,
              context.observation.screenshot,
              inspected.inspection.viewport,
              scroll,
            ),
          },
          capability,
        );
        if (!resolved.ok) return resolved;
        // A target cited by placeholder name is sensitive by definition: the
        // privacy engine only rewrites a name it redacted. That holds even when
        // the plan cites no evidence id, so a planner cannot dodge the rule by
        // omitting one.
        return {
          ok: true,
          candidate: resolved.candidate,
          sensitive: cited.sensitive || isSensitivePlaceholderToken(evidence.accessibleName),
        };
      };

      /**
       * Asks before a step the policy flagged. A refusal ends the run instead of
       * skipping to the next action: the remaining steps were planned assuming
       * this one happened.
       */
      const confirmStep = async (
        action: Action,
        index: number,
        confirmation: ConfirmationKind,
        reason: string,
      ): Promise<boolean> => {
        deps.report({
          type: "CONFIRMATION_REQUEST",
          taskId,
          actionIndex: index,
          confirmation,
          detail: reason,
          risk: action.risk,
        });
        const approval = await ask({
          kind: "confirm",
          actionIndex: index,
          action,
          confirmation,
          detail: reason,
          risk: action.risk,
        });
        if (approval.approved) return true;
        record(
          action,
          index,
          {
            taskId,
            actionIndex: index,
            status: "skipped",
            code: "NOT_CONFIRMED",
            reason: "You declined this step.",
          },
          "You declined this step.",
        );
        stop("denied", "You declined a step, so Orka stopped.");
        return false;
      };

      /**
       * After a click or a navigation: if the page is now somewhere else, the
       * user decides whether the rest of the plan may follow. Nothing continues
       * across an origin change on its own.
       */
      const checkOriginChange = async (index: number, action: Action): Promise<void> => {
        const landedOrigin = urlOrigin(await tabUrl()) ?? (await deps.page.origin(context.tabId));
        if (!landedOrigin) {
          stop("page_unavailable", "Orka could not confirm which page it landed on.");
          return;
        }
        if (landedOrigin === origin) return;

        const previousOrigin = origin;
        origin = landedOrigin;
        scroll = { x: 0, y: 0 };
        const approval = await ask({
          kind: "confirm",
          actionIndex: index,
          action,
          confirmation: "new_origin",
          detail: `Orka left ${previousOrigin} and is now on ${landedOrigin}. Continue the rest of the plan there?`,
          risk: "medium",
        });
        if (!approval.approved) {
          stop("denied", `You declined to continue on ${landedOrigin}.`);
        }
      };

      deps.report({ type: "EXECUTION_STARTED", taskId, total: actions.length });

      try {
        for (let index = 0; index < actions.length; index += 1) {
          if (halt) break;
          const action = actions[index]!;
          stepStartedAt = now();

          if (abort.signal.aborted) {
            stop(requestedStop ?? "user", "You stopped the task.");
            break;
          }
          if (session.state !== "executing") {
            stop("user", "The Task Session is no longer running.");
            break;
          }
          if (session.enforceRoundTimeout()) {
            // Per-round budget: machine work only, approval time excluded, and
            // reset each round (docs2/04-PRODUCT-PRD.md §4).
            stop("timeout", "This round's 90-second active-work budget ran out.");
            break;
          }
          // The plan contract already caps a plan at this many actions. This is
          // the executor's own count so a completed plan can still reach
          // `completed` -- the session's own cap stops a session, which is right
          // for a watchdog and wrong for a finished plan.
          if (executed >= MAX_EXECUTION_ACTIONS) {
            stop("policy", `Orka stopped after ${MAX_EXECUTION_ACTIONS} actions.`);
            break;
          }

          const tab = await checkActiveTab();
          if (!tab.ok) {
            record(
              action,
              index,
              { taskId, actionIndex: index, status: "failure", code: tab.code, reason: tab.reason },
              tab.reason,
            );
            stop(tab.stopReason, tab.reason);
            break;
          }

          switch (action.type) {
            case "navigate": {
              const decision = decideNavigate(action.url, origin);
              if (!decision.ok) {
                fail(action, index, decision.code, decision.reason);
                break;
              }
              const beforeUrl = await tabUrl();
              try {
                await deps.browser.updateTab(context.tabId, decision.url);
              } catch {
                fail(action, index, "NAVIGATION_FAILED", "The browser refused to open that page.");
                break;
              }
              const settled = await deps.browser.settle(
                context.tabId,
                beforeUrl,
                NAVIGATION_SETTLE_MS,
              );
              if (!settled.changed && settled.url === undefined) {
                fail(action, index, "PAGE_UNAVAILABLE", "Orka could not confirm that the page opened.");
                break;
              }
              record(action, index, { taskId, actionIndex: index, status: "success" }, decision.reason);
              executed += 1;
              await checkOriginChange(index, action);
              break;
            }

            case "scroll": {
              const amount = action.amount ?? DEFAULT_SCROLL_AMOUNT;
              const decision = decideScroll(amount);
              if (decision.decision === "deny") {
                fail(action, index, decision.code ?? "BLOCKED_BY_POLICY", decision.reason);
                break;
              }
              const scrolled = await deps.page.scroll(context.tabId, action.direction, amount);
              if (!scrolled.ok) {
                fail(action, index, scrolled.code, scrolled.reason);
                break;
              }
              scroll = { x: scroll.x + scrolled.dx, y: scroll.y + scrolled.dy };
              executed += 1;
              // A scroll changes what is visible, so the local view of the page
              // is refreshed before the next step is resolved against it.
              const refreshed = await deps.page.refreshSnapshot(context.tabId);
              record(
                action,
                index,
                { taskId, actionIndex: index, status: "success" },
                refreshed.ok
                  ? `${decision.reason} Refreshed the local page view (${refreshed.elementCount} elements).`
                  : decision.reason,
              );
              break;
            }

            case "click": {
              const located = await locate(action.target, "click");
              if (!located.ok) {
                fail(action, index, located.code, located.reason);
                break;
              }
              const decision = decideClick(located.candidate, { sensitiveTarget: located.sensitive });
              if (decision.decision === "deny") {
                fail(action, index, decision.code ?? "BLOCKED_BY_POLICY", decision.reason);
                break;
              }
              if (
                decision.decision === "confirm" &&
                !(await confirmStep(action, index, decision.kind ?? "submit", decision.reason))
              ) {
                break;
              }
              const beforeUrl = await tabUrl();
              const clicked = await deps.page.click(context.tabId, actTarget(located.candidate));
              if (!clicked.ok) {
                fail(action, index, clicked.code, clicked.reason);
                break;
              }
              executed += 1;
              record(action, index, { taskId, actionIndex: index, status: "success" }, decision.reason);
              const settled = await deps.browser.settle(context.tabId, beforeUrl, CLICK_SETTLE_MS);
              if (settled.changed) await checkOriginChange(index, action);
              break;
            }

            case "type": {
              const located = await locate(action.target, "type");
              if (!located.ok) {
                fail(action, index, located.code, located.reason);
                break;
              }
              const decision = decideType(located.candidate, action.value, context.sensitiveValues, {
                sensitiveTarget: located.sensitive,
              });
              if (decision.decision === "deny") {
                fail(action, index, decision.code ?? "BLOCKED_BY_POLICY", decision.reason);
                break;
              }
              if (
                decision.decision === "confirm" &&
                !(await confirmStep(action, index, decision.kind ?? "type", decision.reason))
              ) {
                break;
              }
              // Resolved here, at the last moment before the keystroke, so the
              // value exists for as little time as possible and never reaches a
              // log, an outcome, or the panel.
              const resolved = resolveTypeValue(action.value, context.sensitiveValues);
              if (!resolved.ok) {
                fail(action, index, resolved.code, resolved.reason);
                break;
              }
              const typed = await deps.page.type(
                context.tabId,
                actTarget(located.candidate),
                resolved.value,
              );
              if (!typed.ok) {
                fail(action, index, typed.code, typed.reason);
                break;
              }
              executed += 1;
              record(
                action,
                index,
                { taskId, actionIndex: index, status: "success" },
                stepDetail(
                  resolved.placeholders,
                  located.candidate,
                  "Inserted your saved",
                  `Typed into ${describeCandidate(located.candidate)}.`,
                ),
              );
              break;
            }

            case "select": {
              const located = await locate(action.target, "select");
              if (!located.ok) {
                fail(action, index, located.code, located.reason);
                break;
              }
              const decision = decideSelect(located.candidate, action.value, context.sensitiveValues, {
                sensitiveTarget: located.sensitive,
              });
              if (decision.decision === "deny") {
                fail(action, index, decision.code ?? "BLOCKED_BY_POLICY", decision.reason);
                break;
              }
              if (
                decision.decision === "confirm" &&
                !(await confirmStep(action, index, decision.kind ?? "select", decision.reason))
              ) {
                break;
              }
              const resolved = resolveTypeValue(action.value, context.sensitiveValues);
              if (!resolved.ok) {
                fail(action, index, resolved.code, resolved.reason);
                break;
              }
              const selected = await deps.page.select(
                context.tabId,
                actTarget(located.candidate),
                resolved.value,
              );
              if (!selected.ok) {
                fail(action, index, selected.code, selected.reason);
                break;
              }
              executed += 1;
              record(
                action,
                index,
                { taskId, actionIndex: index, status: "success" },
                stepDetail(
                  resolved.placeholders,
                  located.candidate,
                  "Chose your saved",
                  `Chose an option in ${describeCandidate(located.candidate)}.`,
                ),
              );
              break;
            }

            case "ask_user": {
              deps.report({
                type: "ASK_USER",
                taskId,
                actionIndex: index,
                prompt: action.prompt,
                detail: action.reason,
                risk: action.risk,
              });
              const approval = await ask({
                kind: "ask_user",
                actionIndex: index,
                action,
                prompt: action.prompt,
                detail: action.reason,
                risk: action.risk,
              });
              if (!approval.approved) {
                record(
                  action,
                  index,
                  {
                    taskId,
                    actionIndex: index,
                    status: "skipped",
                    code: "NOT_CONFIRMED",
                    reason: "You closed the question without answering.",
                  },
                  "You closed the question without answering.",
                );
                stop("denied", "You stopped at the question Orka asked.");
                break;
              }
              // The answer stays in the side panel. Nothing about it is sent
              // anywhere, and it is never written into the outcome.
              record(
                action,
                index,
                { taskId, actionIndex: index, status: "success" },
                "You answered locally; nothing was sent.",
              );
              break;
            }

            case "done": {
              record(
                action,
                index,
                { taskId, actionIndex: index, status: "success", reason: action.summary },
                action.summary,
              );
              halt = { status: "completed", summary: action.summary };
              break;
            }
          }
        }

        // The run is over: from here every `record` is the accounting pass for
        // steps that never ran, and none of those has a duration.
        stepStartedAt = undefined;

        if (!halt) {
          halt = {
            status: "completed",
            summary:
              executed > 0 ? `Ran ${executed} step${executed === 1 ? "" : "s"}.` : "Nothing to run.",
          };
        }

        // Every step the run never reached is accounted for by index, so the
        // user sees the whole plan and exactly where it stopped. A plan that
        // ends in `done` leaves steps unrun too; those read as "finished", not
        // as "stopped here".
        const skippedReason =
          halt.status === "failed"
            ? "Orka stopped after an earlier step failed."
            : halt.status === "stopped"
              ? halt.summary
              : "Orka finished before this step.";
        for (let index = 0; index < actions.length; index += 1) {
          if (recorded.has(index)) continue;
          record(
            actions[index]!,
            index,
            {
              taskId,
              actionIndex: index,
              status: "skipped",
              code: "SKIPPED_AFTER_TERMINAL",
              reason: skippedReason,
            },
            skippedReason,
          );
        }

        const run: ExecutionRun = { outcomes, ...halt };
        deps.report({
          type: "EXECUTION_FINISHED",
          taskId,
          status: run.status,
          stopReason: run.stopReason,
          failure: run.failure,
          summary: run.summary,
        });
        return run;
      } finally {
        context.signal.removeEventListener("abort", linkExternal);
        if (controller === abort) controller = undefined;
      }
    },

    /**
     * Phase 6 (multi-round loop): runs exactly one approved step and hands
     * control back to the caller. The step runs through the same `execute`
     * path as a whole plan, so every per-action policy is unchanged: live-DOM
     * revalidation, the confirmation port, origin and active-tab checks, and
     * the per-round budget all apply exactly as before. Only the outer loop
     * over the plan's array is gone -- the background loop decides what runs
     * next, after seeing what the page looks like now.
     */
    async executeStep(action: Action, context: ExecutionContext): Promise<StepRun> {
      const run = await executor.execute(
        { contractVersion: CONTRACT_VERSION, taskId: context.taskId, actions: [action] },
        context,
      );
      const outcome = run.outcomes[0];
      return {
        status: run.status,
        needsReplan: run.status === "completed" && action.type !== "done",
        ...(outcome ? { outcome } : {}),
        ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
        ...(run.failure !== undefined ? { failure: run.failure } : {}),
        summary: run.summary,
      };
    },
  };
  return executor;
}

/**
 * How a typed or selected step is described in the log. A local value is
 * reported by its name only: the outcome is shown to the user and kept for the
 * session, and a resolved value never belongs in either.
 */
function stepDetail(
  placeholders: string[],
  candidate: PageCandidate,
  insertedVerb: string,
  plain: string,
): string {
  if (placeholders.length === 0) return plain;
  return `${insertedVerb} ${placeholders
    .map((name) => `[${name}]`)
    .join(", ")} into ${describeCandidate(candidate)}.`;
}

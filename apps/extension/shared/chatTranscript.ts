import type {
  Action,
  ActionOutcome,
  ConfirmationKind,
  ExecutionRunStatus,
  Risk,
  StopReason,
} from "@orka/contracts";
import type { ExtensionMessage } from "./messages.ts";

/**
 * The side panel's conversation (Phase 8, docs2/04-PRODUCT-PRD.md §1).
 *
 * This is a **view over the same session events**, not a second state machine:
 * `TaskSession` still decides what may happen when, and the transcript only
 * records what was said. Appending a turn here can never change a policy
 * decision, which is why the whole module is a pure reducer over
 * `ExtensionMessage` -- the same events the panel already receives -- with no
 * timers, no browser calls, and no writer other than the reducer's callers.
 *
 * `ChatTurn` is **extension-local and never crosses the gateway**. The
 * gateway's `PlanRequest`/`PlanResponse` contract is unchanged: it has no chat
 * concept, and it is called once per round exactly as before. Nothing here is
 * persisted; the thread is released with the session.
 */
export type ChatTurn = ChatUserTurn | ChatStepTurn | ChatQuestionTurn | ChatResultTurn | ChatNoteTurn;

/** The user's own words: the task, a decision, or an answer to a question. */
export type ChatUserTurn = {
  id: string;
  role: "user";
  kind: "message";
  text: string;
  /** What kind of utterance this is, so the panel can style it quieter. */
  about: "task" | "decision" | "answer";
};

/**
 * One proposed step, awaiting the user or already decided.
 *
 * `value` is the drafted value **in full**. The executor's `reason` is
 * deliberately clipped (`executorPolicy.ts` `truncate`, 80 chars), which is
 * fine for a log line and not fine for the one thing a person must read before
 * letting Orka type: this field is the whole string.
 */
export type ChatStepTurn = {
  id: string;
  role: "orka";
  kind: "step";
  /** Which round proposed it, so a long thread stays legible. */
  round: number;
  action: Action;
  /** What the step acts on, and never the value. */
  target: string;
  /** The drafted value in full, when the step has one. */
  value?: string;
  risk: Risk;
  /** The planner's own sentence, which may clip the value it mentions. */
  reason: string;
  /** True while the executor is waiting for Allow / Deny on this step. */
  awaiting: boolean;
  decision?: "approved" | "denied";
  outcome?: { status: ActionOutcome["status"]; detail: string; code?: string };
};

/**
 * A prompt that stops the run until a person answers: a confirmation on the
 * approved step, or a question the plan itself asked.
 *
 * Both are one kind because they are one thing -- Orka asking, and the run
 * waiting -- and modelling them separately is how a prompt ends up with no
 * turn to render in and a run that hangs silently.
 */
export type ChatQuestionTurn = {
  id: string;
  role: "orka";
  kind: "question";
  round: number;
  ask:
    | { type: "confirmation"; confirmation: ConfirmationKind; detail: string; risk: Risk }
    | { type: "ask_user"; prompt: string; detail: string; risk: Risk };
  awaiting: boolean;
};

/** The session's terminal turn. */
export type ChatResultTurn = {
  id: string;
  role: "orka";
  kind: "result";
  status: ExecutionRunStatus;
  summary: string;
  stopReason?: StopReason;
  failure?: { code: string; message: string };
};

/** Narration and failures: text with no step behind it. */
export type ChatNoteTurn = {
  id: string;
  role: "orka";
  kind: "message";
  text: string;
  tone?: "error" | "note";
};

/** What the step acts on. Never includes a drafted value. */
export function stepTarget(action: Action): string {
  const named = (role: string, accessibleName: string): string => {
    const name = accessibleName.trim();
    return name ? `the ${role} “${name}”` : `the ${role}`;
  };
  switch (action.type) {
    case "navigate":
      return action.url;
    case "click":
      return named(action.target.role, action.target.accessibleName);
    case "scroll":
      return action.target ? named(action.target.role, action.target.accessibleName) : "the page";
    case "type":
    case "select":
      return named(action.target.role, action.target.accessibleName);
    case "ask_user":
      return "your answer";
    case "done":
      return "finishing the task";
  }
}

/** The drafted value in full, for the action types that carry one. */
export function stepValue(action: Action): string | undefined {
  return action.type === "type" || action.type === "select" ? action.value : undefined;
}

function nextId(turns: ChatTurn[], role: ChatTurn["role"], kind: ChatTurn["kind"]): string {
  return `${turns.length}:${role}/${kind}`;
}

/**
 * Replaces the last turn matching `match`, keeping its id so React keys and any
 * test assertion stay stable. Turns are append-only apart from this: rewriting
 * history would make the thread a second, competing record of the session.
 */
function patchLast(
  turns: ChatTurn[],
  match: (turn: ChatTurn) => boolean,
  patch: (turn: ChatTurn) => ChatTurn,
): ChatTurn[] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = turns[index];
    if (!candidate || !match(candidate)) continue;
    return [...turns.slice(0, index), patch(candidate), ...turns.slice(index + 1)];
  }
  return turns;
}

/**
 * Marks whatever prompt is open as answered. Called when the user decides and
 * when the session ends, so a stale Allow/Deny control can never outlive the
 * run it belonged to -- a prompt that stays on screen after its step is gone is
 * worse than no prompt.
 */
export function resolveAwaiting(turns: ChatTurn[]): ChatTurn[] {
  const open = turns.some(
    (turn) =>
      (turn.kind === "step" && turn.awaiting) || (turn.kind === "question" && turn.awaiting),
  );
  if (!open) return turns;
  return turns.map((turn) => {
    if (turn.kind === "step" && turn.awaiting) return { ...turn, awaiting: false };
    if (turn.kind === "question" && turn.awaiting) return { ...turn, awaiting: false };
    return turn;
  });
}

function isTerminal(turns: ChatTurn[]): boolean {
  return turns.some((turn) => turn.kind === "result");
}

function note(turns: ChatTurn[], text: string, tone?: ChatNoteTurn["tone"]): ChatTurn[] {
  return [...turns, { id: nextId(turns, "orka", "message"), role: "orka", kind: "message", text, tone }];
}

/** The user's task, appended when a session starts. */
export function appendUserTask(turns: ChatTurn[], task: string): ChatTurn[] {
  return appendUserTurn(turns, task, "task");
}

export function appendUserTurn(
  turns: ChatTurn[],
  text: string,
  about: ChatUserTurn["about"],
): ChatTurn[] {
  return [
    ...turns,
    { id: nextId(turns, "user", "message"), role: "user", kind: "message", text, about },
  ];
}

/**
 * Records the user's decision on whatever was open, as their own turn. The
 * decision itself is delivered by the panel's message to the background; this
 * only writes it down.
 */
export function appendUserDecision(
  turns: ChatTurn[],
  approved: boolean,
  /** The user's own words for this decision, when the default reads wrong. */
  words?: string,
): ChatTurn[] {
  const decided = patchLast(
    turns,
    (turn) => turn.kind === "step" && turn.awaiting,
    (turn) => ({ ...(turn as ChatStepTurn), awaiting: false, decision: approved ? "approved" : "denied" }),
  );
  // Any other open prompt (a confirmation on the step already running) closes
  // with the same decision: it belonged to the step this decision ends.
  return appendUserTurn(
    resolveAwaiting(decided),
    words ?? (approved ? "Approved — go ahead." : "Denied and stopped."),
    "decision",
  );
}

/**
 * The user's answer to an `ask_user` question: it closes the question and
 * becomes their own turn. The answer is delivered to the executor by the
 * panel's message, never to the planner, and it is not kept past the session.
 */
export function appendUserAnswer(turns: ChatTurn[], answer: string): ChatTurn[] {
  return appendUserTurn(resolveAwaiting(turns), answer, "answer");
}

/**
 * Folds one session event into the thread.
 *
 * `context.round` is the round the event belongs to. The reducer cannot derive
 * it: `PLAN_RESULT` carries no round, and the panel's listener is attached once
 * and so can never read fresh React state. The caller keeps the round it saw in
 * a ref and passes it in, which also keeps this function pure.
 */
export function reduceTranscript(
  turns: ChatTurn[],
  message: ExtensionMessage,
  context: { round?: number } = {},
): ChatTurn[] {
  const round = context.round ?? 1;

  switch (message.type) {
    // Recorded by the audit panel, which owns the captures and the map: the
    // thread deliberately does not duplicate the evidence.
    case "SANITIZATION_RESULT":
    case "EXECUTION_STARTED":
    case "METRICS_REPORT":
      return turns;

    case "SANITIZATION_FAILURE":
      return note(turns, `The local scan failed, so nothing was sent: ${message.error.message}`, "error");

    case "PLAN_FAILURE":
      return note(turns, `The planner could not propose a step: ${message.error.message}`, "error");

    case "ROUND_PROGRESS":
      // The round badge covers the first round; a later one is worth saying out
      // loud, because "it re-read the page before proposing this" is the whole
      // shape of a multi-round task.
      return message.phase === "started" && message.round > 1
        ? note(turns, `Re-reading the page before step ${message.round}.`, "note")
        : turns;

    case "PLAN_RESULT": {
      // The loop publishes one step per round (the prompt's one-action rule),
      // and the executor runs exactly that step, so the turn shows it.
      const action = message.plan.actions[0];
      if (!action) return note(turns, "The planner returned a step with no action to take.");
      const step: ChatStepTurn = {
        id: nextId(turns, "orka", "step"),
        role: "orka",
        kind: "step",
        round,
        action,
        target: stepTarget(action),
        ...(stepValue(action) === undefined ? {} : { value: stepValue(action) }),
        risk: action.risk,
        reason: action.reason,
        awaiting: true,
      };
      return [...turns, step];
    }

    case "ACTION_OUTCOME": {
      const patched = patchLast(
        turns,
        (turn) => turn.kind === "step" && turn.outcome === undefined,
        (turn) => ({
          ...(turn as ChatStepTurn),
          awaiting: false,
          outcome: {
            status: message.outcome.status,
            detail: message.detail,
            ...(message.outcome.code === undefined ? {} : { code: message.outcome.code }),
          },
        }),
      );
      // A step whose turn is gone (a session that already ended) still gets its
      // outcome recorded rather than dropped.
      return patched === turns
        ? note(turns, `${message.detail} (${message.outcome.status})`)
        : patched;
    }

    case "CONFIRMATION_REQUEST":
      return [
        ...resolveAwaiting(turns),
        {
          id: nextId(turns, "orka", "question"),
          role: "orka",
          kind: "question",
          round,
          ask: {
            type: "confirmation",
            confirmation: message.confirmation,
            detail: message.detail,
            risk: message.risk,
          },
          awaiting: true,
        },
      ];

    case "ASK_USER":
      return [
        ...resolveAwaiting(turns),
        {
          id: nextId(turns, "orka", "question"),
          role: "orka",
          kind: "question",
          round,
          ask: { type: "ask_user", prompt: message.prompt, detail: message.detail, risk: message.risk },
          awaiting: true,
        },
      ];

    case "EXECUTION_FINISHED":
      if (isTerminal(turns)) return resolveAwaiting(turns);
      return [
        ...resolveAwaiting(turns),
        {
          id: nextId(turns, "orka", "result"),
          role: "orka",
          kind: "result",
          status: message.status,
          summary: message.summary,
          ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
          ...(message.failure === undefined ? {} : { failure: message.failure }),
        },
      ];

    case "TASK_STOPPED":
      if (isTerminal(turns)) return resolveAwaiting(turns);
      return [
        ...resolveAwaiting(turns),
        {
          id: nextId(turns, "orka", "result"),
          role: "orka",
          kind: "result",
          status: "stopped",
          summary: "Stopped before the next step.",
          stopReason: "user",
        },
      ];

    // The audit closing ends the session, not the thread: the panel keeps the
    // conversation until the next task starts, which is when the caller clears
    // it. Everything else here is a request the panel sent, not news for it.
    default:
      return turns;
  }
}

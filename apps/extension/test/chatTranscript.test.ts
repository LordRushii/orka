import { describe, expect, test } from "bun:test";
import type { Action } from "@orka/contracts";
import type { ExtensionMessage } from "../shared/messages.ts";
import {
  appendUserAnswer,
  appendUserDecision,
  appendUserTask,
  reduceTranscript,
  type ChatQuestionTurn,
  type ChatStepTurn,
  type ChatTurn,
} from "../shared/chatTranscript.ts";

/**
 * Phase 8's transcript (docs2/04-PRODUCT-PRD.md §1): the panel is a
 * conversation, and this is the model behind it.
 *
 * The reducer is driven with the **real** session messages, so these tests
 * exercise the same union the background publishes -- there is no parallel
 * event vocabulary that could drift from it.
 */

const TASK_ID = "task-1";
const BOX = { x: 0, y: 0, width: 10, height: 10 };

type PlanResult = Extract<ExtensionMessage, { type: "PLAN_RESULT" }>;
type ActionOutcomeMessage = Extract<ExtensionMessage, { type: "ACTION_OUTCOME" }>;
type ConfirmationRequest = Extract<ExtensionMessage, { type: "CONFIRMATION_REQUEST" }>;
type AskUserMessage = Extract<ExtensionMessage, { type: "ASK_USER" }>;
type FinishedMessage = Extract<ExtensionMessage, { type: "EXECUTION_FINISHED" }>;
type RoundProgress = Extract<ExtensionMessage, { type: "ROUND_PROGRESS" }>;

function target(role: string, accessibleName: string) {
  return { role, accessibleName, box: BOX };
}

function click(name: string, reason = `Clicks the ${name} control.`): Action {
  return { type: "click", reason, risk: "low", target: target("button", name) };
}

function navigate(url: string): Action {
  return { type: "navigate", reason: `Opens ${url}.`, risk: "medium", url };
}

function select(value: string, name = "Sort by"): Action {
  return { type: "select", reason: `Choose "${value}".`, risk: "low", target: target("combobox", name), value };
}

function typeInto(value: string, name = "Message"): Action {
  return { type: "type", reason: `Type "${value}".`, risk: "medium", target: target("textbox", name), value };
}

function done(summary: string): Action {
  return { type: "done", reason: "The task is finished.", risk: "low", summary };
}

function plan(actions: Action[]): PlanResult {
  return {
    type: "PLAN_RESULT",
    taskId: TASK_ID,
    plan: { contractVersion: "v1", taskId: TASK_ID, actions },
    meta: { providerId: "mock", model: "phase5-form", latencyMs: 12 },
    outbound: { fields: [], bytes: 128, truncated: false, forbiddenKey: null, absent: [] },
  };
}

function outcome(
  action: Action,
  status: "success" | "failure" | "skipped",
  detail: string,
  code?: ActionOutcomeMessage["outcome"]["code"],
): ActionOutcomeMessage {
  return {
    type: "ACTION_OUTCOME",
    taskId: TASK_ID,
    actionIndex: 0,
    action,
    detail,
    outcome: {
      taskId: TASK_ID,
      actionIndex: 0,
      status,
      ...(code === undefined ? {} : { code }),
    },
  };
}

function confirmation(
  kind: ConfirmationRequest["confirmation"],
  detail: string,
  risk: ConfirmationRequest["risk"] = "high",
): ConfirmationRequest {
  return { type: "CONFIRMATION_REQUEST", taskId: TASK_ID, actionIndex: 0, confirmation: kind, detail, risk };
}

function askUser(prompt: string, detail = "The planner needs one answer before it continues."): AskUserMessage {
  return { type: "ASK_USER", taskId: TASK_ID, actionIndex: 0, prompt, detail, risk: "low" };
}

function finished(
  status: FinishedMessage["status"],
  summary: string,
  extra: Partial<FinishedMessage> = {},
): FinishedMessage {
  return { type: "EXECUTION_FINISHED", taskId: TASK_ID, status, summary, ...extra };
}

function roundStarted(round: number): RoundProgress {
  return { type: "ROUND_PROGRESS", taskId: TASK_ID, round, phase: "started" };
}

const steps = (turns: ChatTurn[]): ChatStepTurn[] =>
  turns.filter((turn): turn is ChatStepTurn => turn.kind === "step");
const questions = (turns: ChatTurn[]): ChatQuestionTurn[] =>
  turns.filter((turn): turn is ChatQuestionTurn => turn.kind === "question");

/**
 * Checked accessors. A test that indexes straight into an array would pass a
 * missing turn along as `undefined` and assert against it silently; these fail
 * loudly instead, which is the difference between a real assertion and none.
 */
function firstStep(turns: ChatTurn[], index = 0): ChatStepTurn {
  const step = steps(turns)[index];
  if (!step) throw new Error(`expected a step turn at ${index}`);
  return step;
}

function firstQuestion(turns: ChatTurn[]): ChatQuestionTurn {
  const question = questions(turns)[0];
  if (!question) throw new Error("expected a question turn");
  return question;
}

function firstTurn(turns: ChatTurn[]): ChatTurn {
  const turn = turns[0];
  if (!turn) throw new Error("expected at least one turn");
  return turn;
}

function lastTurn(turns: ChatTurn[]): ChatTurn {
  const turn = turns[turns.length - 1];
  if (!turn) throw new Error("expected at least one turn");
  return turn;
}

describe("chat transcript: one step per round", () => {
  test("a proposed step becomes an Orka turn, awaiting the user", () => {
    const turns = reduceTranscript(appendUserTask([], "Find the pricing page"), plan([click("Pricing")]));

    expect(turns[0]).toMatchObject({ role: "user", kind: "message", about: "task" });
    const step = firstStep(turns);
    expect(step).toMatchObject({ role: "orka", kind: "step", awaiting: true, risk: "low" });
    expect(step.target).toBe("the button “Pricing”");
    expect(step.value).toBeUndefined();
  });

  test("the turn records which round proposed it", () => {
    const first = reduceTranscript([], plan([click("Reply")]), { round: 1 });
    const second = reduceTranscript(first, plan([click("Send")]), { round: 2 });

    expect(steps(second).map((step) => step.round)).toEqual([1, 2]);
  });

  test("approving writes the user's own turn and closes the step", () => {
    const proposed = reduceTranscript(appendUserTask([], "Reply"), plan([click("Reply")]));
    const approved = appendUserDecision(proposed, true);

    expect(firstStep(approved)).toMatchObject({ awaiting: false, decision: "approved" });
    expect(lastTurn(approved)).toMatchObject({ role: "user", about: "decision" });
  });

  test("denying is recorded on the step, not just in the log", () => {
    const denied = appendUserDecision(reduceTranscript([], plan([click("Delete account")])), false);

    expect(firstStep(denied)).toMatchObject({ awaiting: false, decision: "denied" });
  });

  test("a step's outcome lands on the step's own turn", () => {
    const action = click("Reply");
    const withOutcome = reduceTranscript(
      reduceTranscript([], plan([action])),
      outcome(action, "success", "Clicked the Reply button."),
    );

    expect(firstStep(withOutcome).outcome).toEqual({
      status: "success",
      detail: "Clicked the Reply button.",
    });
  });

  test("a failure outcome keeps its stable code", () => {
    const action = click("Reply");
    const withOutcome = reduceTranscript(
      reduceTranscript([], plan([action])),
      outcome(action, "failure", "The target was not found.", "TARGET_NOT_FOUND"),
    );

    expect(firstStep(withOutcome).outcome).toMatchObject({ status: "failure", code: "TARGET_NOT_FOUND" });
  });
});

describe("chat transcript: the review turn shows the drafted value in full", () => {
  test("a long typed value is carried whole, never clipped the way its reason is", () => {
    // The value a person must read before letting Orka type it. The executor
    // clips `reason` at 80 characters (`executorPolicy.ts` `truncate`), which is
    // right for a log line and wrong for this: the review turn is the only place
    // the whole thing is visible before it is typed.
    const drafted =
      "Dear Dana, Monday at 10am works — I'll bring the revised Q3 figures and the signed contract. Best, Jane";
    const action: Action = {
      type: "type",
      reason: `Type "${drafted.slice(0, 80)}…" into the textbox "Message".`,
      risk: "medium",
      target: target("textbox", "Message"),
      value: drafted,
    };

    const step = firstStep(reduceTranscript([], plan([action])));

    expect(step.value).toBe(drafted);
    expect(step.value).not.toContain("…");
    // The reason cannot be used to read the value back -- it lost the tail --
    // which is exactly why the turn carries the value separately.
    expect(step.reason).toContain("…");
    expect(step.reason).not.toContain(drafted);
  });

  test("a select's chosen value is carried whole too", () => {
    const step = firstStep(reduceTranscript([], plan([select("Nonstop only")])));

    expect(step).toMatchObject({ value: "Nonstop only" });
  });

  test("a private-value placeholder is shown as drafted, not resolved locally", () => {
    const step = firstStep(reduceTranscript([], plan([typeInto("[PHONE_1]", "Phone")])));

    expect(step.value).toBe("[PHONE_1]");
  });
});

describe("chat transcript: prompts are turns, so a waiting run is never invisible", () => {
  test("a confirmation gets its own turn carrying what the panel must offer", () => {
    const asking = reduceTranscript([], confirmation("send", "Sends or publishes something on your behalf."));

    const question = firstQuestion(asking);
    expect(question.awaiting).toBe(true);
    expect(question.ask).toMatchObject({ type: "confirmation", confirmation: "send", risk: "high" });
  });

  test("a confirmation replaces any prompt already open for the same step", () => {
    const turns = reduceTranscript(reduceTranscript([], plan([click("Send")])), confirmation("send", "Send?"));

    expect(firstStep(turns).awaiting).toBe(false);
    expect(questions(turns)).toHaveLength(1);
  });

  test("an ask_user question carries the prompt the planner asked", () => {
    const turns = reduceTranscript([], askUser("Which address should it ship to?"));

    const question = firstQuestion(turns);
    expect(question.ask).toMatchObject({ type: "ask_user", prompt: "Which address should it ship to?" });
    expect(question.awaiting).toBe(true);
  });

  test("answering closes the question and records the user's words", () => {
    const asked = reduceTranscript(appendUserTask([], "Order a book"), askUser("Which address?"));
    // The answer travels to the executor; the panel writes down what the user
    // said and closes the question that was waiting on it.
    const answered = appendUserAnswer(asked, "12 Example Street");

    expect(firstQuestion(answered).awaiting).toBe(false);
    expect(lastTurn(answered)).toMatchObject({ role: "user", text: "12 Example Street", about: "answer" });
  });

  test("no prompt survives the end of the run", () => {
    const open = appendUserDecision(
      reduceTranscript([], confirmation("submit", "Submits the form.")),
      false,
    );
    const ended = reduceTranscript(open, finished("stopped", "Stopped after the step was declined."));

    const stillAsking = ended.some(
      (turn) => (turn.kind === "question" || turn.kind === "step") && turn.awaiting,
    );
    expect(stillAsking).toBe(false);
  });
});

describe("chat transcript: the session ends exactly once, in words", () => {
  test("a finished run appends one result turn", () => {
    const turns = reduceTranscript([], finished("completed", "Everything you asked for is done."));

    expect(turns).toHaveLength(1);
    expect(firstTurn(turns)).toMatchObject({ kind: "result", status: "completed" });
  });

  test("a second terminal event cannot add a second ending", () => {
    const once = reduceTranscript([], finished("completed", "Done."));
    const twice = reduceTranscript(once, finished("stopped", "Also stopped."));

    expect(twice).toHaveLength(1);
  });

  test("a stop with no finish still ends the thread in words", () => {
    const turns = reduceTranscript([], { type: "TASK_STOPPED", taskId: TASK_ID });

    expect(firstTurn(turns)).toMatchObject({ kind: "result", status: "stopped", stopReason: "user" });
  });

  test("failures are stated in the thread instead of leaving it silent", () => {
    const scanFailed = reduceTranscript([], {
      type: "SANITIZATION_FAILURE",
      taskId: TASK_ID,
      error: { ok: false, code: "DETECTOR_TIMEOUT", message: "Face detection timed out." },
    });
    const planFailed = reduceTranscript([], {
      type: "PLAN_FAILURE",
      taskId: TASK_ID,
      error: { code: "PROVIDER_UNAVAILABLE", message: "The gateway is not reachable." },
      outbound: { fields: [], bytes: 0, truncated: false, forbiddenKey: null, absent: [] },
    });

    expect(firstTurn(scanFailed)).toMatchObject({ kind: "message", tone: "error" });
    expect(firstTurn(scanFailed)).toHaveProperty("text", expect.stringContaining("Face detection timed out."));
    expect(firstTurn(planFailed)).toHaveProperty("text", expect.stringContaining("not reachable"));
  });
});

describe("chat transcript: the loop is visible, and the record is honest", () => {
  test("only a round after the first is narrated, because re-reading the page is the news", () => {
    expect(reduceTranscript([], roundStarted(1))).toHaveLength(0);
    const second = reduceTranscript([], roundStarted(2));

    expect(firstTurn(second)).toMatchObject({ kind: "message", tone: "note" });
  });

  test("the reducer never mutates the thread it was given", () => {
    const before = appendUserTask([], "Find the pricing page");
    const snapshot = structuredClone(before);
    const after = reduceTranscript(before, plan([click("Pricing")]));

    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
  });

  test("messages that are not events leave the thread untouched", () => {
    const turns = appendUserTask([], "Explain this page");
    const unchanged = reduceTranscript(turns, { type: "GET_CAPTURE_AUTHORITY" });

    expect(unchanged).toBe(turns);
  });
});

/**
 * The five Phase 5 demo scenarios (docs/PHASE-5-DEMO.md §2–§6), driven through
 * the transcript UI. Phase 8's acceptance is that all five still complete, so
 * each one is spelled out as the turns a person would actually read.
 */
describe("chat transcript: the five demo scenarios", () => {
  test("1 — open a site", () => {
    const action = navigate("https://shop.example.com/pricing");
    let turns = appendUserTask([], "Open the pricing page.");
    turns = reduceTranscript(turns, plan([action]));
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, outcome(action, "success", "Navigated to the pricing page."));
    turns = reduceTranscript(turns, finished("completed", "Opened the pricing page."));

    expect(lastTurn(turns)).toMatchObject({ kind: "result", status: "completed" });
    expect(firstStep(turns).outcome?.status).toBe("success");
  });

  test("2 — explain a new app: one done turn, no actions run", () => {
    let turns = appendUserTask([], "What does this app do?");
    turns = reduceTranscript(turns, plan([done("It is a project tracker with boards and lists.")]));
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, finished("completed", "It is a project tracker with boards and lists."));

    // The explanation itself is the step's summary, shown the same round it is
    // proposed, and nothing was clicked.
    expect(firstStep(turns).action).toMatchObject({ type: "done" });
    expect(steps(turns)).toHaveLength(1);
    expect(lastTurn(turns)).toMatchObject({ kind: "result", status: "completed" });
  });

  test("3 — find and summarize: navigate, then a done turn across two rounds", () => {
    const open = navigate("https://news.example.com/search?q=ai");
    const summarize = done("Three stories, all about model releases.");

    let turns = appendUserTask([], "Find AI news and summarize it.");
    turns = reduceTranscript(turns, plan([open]), { round: 1 });
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, outcome(open, "success", "Navigated to the results page."));
    turns = reduceTranscript(turns, roundStarted(2));
    turns = reduceTranscript(turns, plan([summarize]), { round: 2 });
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, finished("completed", "Summarized the top three stories."));

    expect(steps(turns).map((step) => step.round)).toEqual([1, 2]);
    expect(
      turns.some((turn) => turn.role === "orka" && turn.kind === "message" && turn.tone === "note"),
    ).toBe(true);
  });

  test("4 — search and filter: a click and a select, each approved", () => {
    const openFilters = click("Filters");
    const applySort = select("Nonstop only");

    let turns = appendUserTask([], "Find flights and show only nonstop ones.");
    turns = reduceTranscript(turns, plan([openFilters]), { round: 1 });
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, outcome(openFilters, "success", "Opened the filters panel."));
    turns = reduceTranscript(turns, plan([applySort]), { round: 2 });
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, outcome(applySort, "success", "Selected Nonstop only."));
    turns = reduceTranscript(turns, finished("completed", "Filtered the results to nonstop flights."));

    expect(steps(turns).map((step) => step.action.type)).toEqual(["click", "select"]);
    // The chosen value is readable at review time, in full.
    expect(firstStep(turns, 1).value).toBe("Nonstop only");
  });

  test("5 — synthetic form and a private value: confirm the insertion, then the submit", () => {
    const phone = typeInto("[PHONE_1]", "Phone number");
    const submit = click("Submit", "Clicks the submit control.");

    let turns = appendUserTask([], "Fill the form with [PHONE_1] and submit it.");
    turns = reduceTranscript(turns, plan([phone]), { round: 1 });
    turns = appendUserDecision(turns, true);
    // Putting a real value into a field is confirmed on the live page, and the
    // prompt arrives as its own turn.
    turns = reduceTranscript(turns, confirmation("sensitive_value", "Insert one of your private values?"));
    expect(firstQuestion(turns).ask).toMatchObject({
      type: "confirmation",
      confirmation: "sensitive_value",
    });
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, outcome(phone, "success", "Typed [PHONE_1] into the phone field."));

    turns = reduceTranscript(turns, plan([submit]), { round: 2 });
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, confirmation("submit", "Submits the form."));
    turns = appendUserDecision(turns, true);
    turns = reduceTranscript(turns, outcome(submit, "success", "Submitted the form."));
    turns = reduceTranscript(turns, finished("completed", "Filled and submitted the form."));

    expect(lastTurn(turns)).toMatchObject({ kind: "result", status: "completed" });
    // The resolved value never appears in the thread: only the name the user
    // declared, exactly as the outcome reports it.
    const rendered = JSON.stringify(turns);
    expect(rendered).toContain("[PHONE_1]");
    expect(rendered).not.toContain("+1");
  });
});

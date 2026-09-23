import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Action } from "@orka/contracts";
import type { ExtensionMessage } from "../shared/messages.ts";
import { appendUserTask, reduceTranscript, type ChatTurn } from "../shared/chatTranscript.ts";
import { ChatThread } from "../entrypoints/sidepanel/ChatThread.tsx";
import App from "../entrypoints/sidepanel/App.tsx";

/**
 * What the panel actually prints (Phase 8's acceptance).
 *
 * The transcript model is tested next door; this file checks the thing a person
 * sees: that the drafted value is rendered **in full**, that the controls which
 * gate a run are attached to the turn that needs them, and that the local
 * evidence is not folded into the scrolling conversation.
 */

const TASK_ID = "task-1";

/** One CSS rule's body, so a layout assertion reads as the rule it is about. */
function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

type PlanResult = Extract<ExtensionMessage, { type: "PLAN_RESULT" }>;

function plan(actions: Action[]): PlanResult {
  return {
    type: "PLAN_RESULT",
    taskId: TASK_ID,
    plan: { contractVersion: "v1", taskId: TASK_ID, actions },
    meta: { providerId: "mock", model: "phase5-form", latencyMs: 10 },
    outbound: { fields: [], bytes: 64, truncated: false, forbiddenKey: null, absent: [] },
  };
}

/** No quotes or apostrophes: React escapes those, and this asserts raw text. */
const DRAFTED =
  "Please confirm the appointment on Monday at 10am and bring the revised Q3 figures plus the signed contract for review.";

const typeAction: Action = {
  type: "type",
  // The executor's own clipped phrasing: 80 characters, then an ellipsis.
  reason: `Type "${DRAFTED.slice(0, 80)}…" into the textbox "Message".`,
  risk: "medium",
  target: { role: "textbox", accessibleName: "Message", box: { x: 0, y: 0, width: 10, height: 10 } },
  value: DRAFTED,
};

function renderThread(turns: ChatTurn[], overrides: Partial<Parameters<typeof ChatThread>[0]> = {}) {
  return renderToStaticMarkup(
    <ChatThread
      transcript={turns}
      answer=""
      onAnswerChange={() => {}}
      onApprove={() => {}}
      onDecide={() => {}}
      onStop={() => {}}
      {...overrides}
    />,
  );
}

describe("chat thread: what a person actually reads", () => {
  test("the review turn prints the drafted value whole, in its own block", () => {
    const markup = renderThread(reduceTranscript([], plan([typeAction])));

    expect(markup).toContain('<pre class="turn__value">');
    expect(markup).toContain(DRAFTED);
    // Nothing clipped it: not the executor's 80-character reason, not a line
    // clamp. The reason itself is still shown, ellipsis and all.
    expect(markup).not.toContain("…</pre>");
    expect(markup).toContain("Drafted value, in full");
    expect(markup).toContain("…");
  });

  test("the value is printed in full even when it is longer than the reason", () => {
    const markup = renderThread(reduceTranscript([], plan([typeAction])));
    const printed = markup.slice(
      markup.indexOf('<pre class="turn__value">') + '<pre class="turn__value">'.length,
      markup.indexOf("</pre>"),
    );

    expect(printed).toBe(DRAFTED);
    expect(printed.length).toBeGreaterThan(80);
  });

  test("an awaiting step embeds its own Allow/Deny controls", () => {
    const markup = renderThread(reduceTranscript([], plan([typeAction])));

    expect(markup).toContain("Approve step");
    expect(markup).toContain("Deny and stop");
    expect(markup).toContain("turn--awaiting");
  });

  test("a decided step shows the outcome and no longer offers the control", () => {
    const turns = reduceTranscript(
      reduceTranscript(appendUserTask([], "Reply to this email"), plan([typeAction])),
      {
        type: "ACTION_OUTCOME",
        taskId: TASK_ID,
        actionIndex: 0,
        action: typeAction,
        detail: "Typed into the Message field.",
        outcome: { taskId: TASK_ID, actionIndex: 0, status: "success" },
      },
    );
    const markup = renderThread(turns);

    expect(markup).toContain("Done");
    expect(markup).toContain("Typed into the Message field.");
    expect(markup).not.toContain("Approve step");
  });

  test("a confirmation offers Allow once, a planner question offers Continue", () => {
    const confirmation = renderThread(
      reduceTranscript([], {
        type: "CONFIRMATION_REQUEST",
        taskId: TASK_ID,
        actionIndex: 0,
        confirmation: "send",
        detail: "Sends or publishes something on your behalf.",
        risk: "high",
      }),
    );
    const question = renderThread(
      reduceTranscript([], {
        type: "ASK_USER",
        taskId: TASK_ID,
        actionIndex: 0,
        prompt: "Which address should it ship to?",
        detail: "The planner needs one answer.",
        risk: "low",
      }),
    );

    expect(confirmation).toContain("Send or publish something?");
    expect(confirmation).toContain("Allow once");
    expect(confirmation).toContain("Deny and stop");
    expect(question).toContain("Which address should it ship to?");
    expect(question).toContain("Continue");
    expect(question).toContain("Stop here");
  });

  test("the user's task is their own turn, and an empty thread explains itself", () => {
    expect(renderThread(appendUserTask([], "Find the pricing page"))).toContain("Find the pricing page");
    // No thread yet: the panel says how to start rather than showing nothing.
    expect(renderThread([])).toContain("Describe a task in your own words.");
  });
});

describe("panel layout: the evidence sits below the conversation in its own dropdowns", () => {
  test("the audit and the outbound view render as their own section, outside the thread", () => {
    // Server rendering runs no effects, so this needs no browser APIs: it is
    // the panel's structure, which is the whole claim. `<details>` still emits
    // its inner markup when closed, so the content assertions hold.
    const markup = renderToStaticMarkup(<App />);

    const threadAt = markup.indexOf('class="panel__thread"');
    const evidenceAt = markup.indexOf('class="evidence"');
    expect(threadAt).toBeGreaterThanOrEqual(0);
    expect(evidenceAt).toBeGreaterThan(threadAt);

    // Both dropdowns are present even before anything has happened, so an empty
    // audit reads as "nothing yet" rather than as a missing section.
    expect(markup).toContain("Local audit");
    expect(markup).toContain("What left this device");
    expect(markup).toContain("Nothing scanned yet.");
  });

  test("the chat scrolls on top; settings, metrics and evidence sit in a separate region below", () => {
    // The layout requirement is a CSS fact, so it is asserted as one: the panel
    // itself does not scroll, the chat thread is its own scroll container on
    // top, and the secondary drawers keep their own bounded region below rather
    // than being folded into the conversation.
    const css = readFileSync(new URL("../entrypoints/sidepanel/App.css", import.meta.url), "utf8");

    const panelRule = ruleFor(css, ".panel");
    const threadRule = ruleFor(css, ".panel__thread");
    const drawersRule = ruleFor(css, ".panel__drawers");
    const composerRule = ruleFor(css, ".panel__composer");

    expect(panelRule).toContain("overflow: hidden");
    expect(threadRule).toContain("flex: 1 1 auto");
    expect(threadRule).toContain("overflow-y: auto");
    expect(drawersRule).toContain("flex: 0 0 auto");
    expect(drawersRule).toContain("overflow-y: auto");
    expect(composerRule).toContain("flex: 0 0 auto");
  });
});

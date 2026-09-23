import { useEffect, useRef, type ReactNode } from "react";
import type { Action } from "@orka/contracts";
import type { ChatStepTurn, ChatTurn } from "../../shared/chatTranscript.ts";
import {
  CONFIRMATION_TITLE,
  OUTCOME_LABEL,
  RISK_LABEL,
  RUN_STATUS_LABEL,
  STOP_REASON_LABEL,
  outcomeChipClass,
} from "./panelLabels.ts";

/**
 * The conversation (Phase 8, docs2/04-PRODUCT-PRD.md §1).
 *
 * Every turn is one event the user can read: what Orka is about to do, what it
 * needs decided, and what came of it. The controls that gate a run are
 * **embedded in the turn that needs them** rather than raised as a modal card,
 * because a prompt that is not attached to the step it belongs to is a prompt
 * people answer without knowing what they are answering.
 */

export type ChatThreadProps = {
  transcript: ChatTurn[];
  /** The typed answer to an `ask_user` question, owned by the composer. */
  answer: string;
  onAnswerChange(value: string): void;
  onApprove(): void;
  onDecide(approved: boolean, answer?: string): void;
  onStop(): void;
  /**
   * Rendered after the turns, inside the same scrolling region: the run's
   * measured numbers belong next to the conversation rather than in the
   * evidence panel, whose job is what was redacted and what was sent.
   */
  footer?: ReactNode;
};

/** How a step reads in the first person, before anything has run. */
function stepPhrase(action: Action, target: string): string {
  switch (action.type) {
    case "navigate":
      return `I'll open ${target}.`;
    case "click":
      return `I'll click ${target}.`;
    case "scroll":
      return `I'll scroll ${target}.`;
    case "type":
      return `I'll type into ${target}.`;
    case "select":
      return `I'll choose that option in ${target}.`;
    case "ask_user":
      return "I'll need one answer from you before I continue.";
    case "done":
      return "That's everything, so I'll finish here.";
  }
}

function StepTurn({
  turn,
  onApprove,
  onStop,
}: {
  turn: ChatStepTurn;
  onApprove(): void;
  onStop(): void;
}) {
  return (
    <li className={`turn turn--orka turn--step${turn.awaiting ? " turn--awaiting" : ""}`}>
      <div className="turn__head">
        <span className="plan__type">{turn.action.type}</span>
        <span className={`chip chip--${turn.risk}`}>{RISK_LABEL[turn.risk]}</span>
        <span className="meta">Step {turn.round}</span>
      </div>

      <p className="plan__detail">{stepPhrase(turn.action, turn.target)}</p>

      {/*
        The whole drafted value, in full. The executor's `reason` clips it at 80
        characters, which is right for a log line and useless for a decision.
      */}
      {turn.value !== undefined && (
        <div className="turn__draft">
          <span className="field__label">Drafted value, in full</span>
          <pre className="turn__value">{turn.value}</pre>
        </div>
      )}

      <p className="meta">{turn.reason}</p>

      {turn.outcome && (
        <div className="turn__outcome">
          <span className={outcomeChipClass(turn.outcome.status)}>
            {OUTCOME_LABEL[turn.outcome.status]}
          </span>
          <span className="meta">{turn.outcome.detail}</span>
        </div>
      )}

      {turn.awaiting && (
        <div className="card--actions">
          <button type="button" className="button button--primary" onClick={onApprove}>
            Approve step
          </button>
          <button type="button" className="button button--ghost" onClick={onStop}>
            Deny and stop
          </button>
        </div>
      )}
    </li>
  );
}

export function ChatThread({
  transcript,
  answer,
  onAnswerChange,
  onApprove,
  onDecide,
  onStop,
  footer,
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows, so an awaiting prompt is never below
  // the fold when the user is looking at the panel.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [transcript.length]);

  return (
    <section className="panel__thread" aria-label="Task conversation">
      {transcript.length === 0 && (
        <p className="meta">
          Describe a task in your own words. Orka shows every step here, with what it will do and
          what it needs from you, before it touches the page.
        </p>
      )}
      <ol className="thread">
        {transcript.map((turn) => {
          if (turn.role === "user") {
            return (
              <li key={turn.id} className={`turn turn--user turn--user-${turn.about}`}>
                {turn.text}
              </li>
            );
          }

          switch (turn.kind) {
            case "message":
              return (
                <li
                  key={turn.id}
                  className={`turn turn--orka turn--note${turn.tone === "error" ? " turn--error" : ""}`}
                >
                  <p className="plan__detail">{turn.text}</p>
                </li>
              );

            case "step":
              return (
                <StepTurn key={turn.id} turn={turn} onApprove={onApprove} onStop={onStop} />
              );

            case "question": {
              const { ask } = turn;
              return (
                <li
                  key={turn.id}
                  className={`turn turn--orka turn--question${turn.awaiting ? " turn--awaiting" : ""}`}
                >
                  {ask.type === "confirmation" ? (
                    <>
                      <div className="turn__head">
                        <h3 className="turn__title">{CONFIRMATION_TITLE[ask.confirmation]}</h3>
                        <span className={`chip chip--${ask.risk}`}>{RISK_LABEL[ask.risk]}</span>
                      </div>
                      <p className="plan__detail">{ask.detail}</p>
                    </>
                  ) : (
                    <>
                      <h3 className="turn__title">Orka needs to ask</h3>
                      <p className="plan__detail">{ask.prompt}</p>
                      <p className="meta">{ask.detail}</p>
                    </>
                  )}

                  {turn.awaiting && ask.type === "ask_user" && (
                    <textarea
                      value={answer}
                      rows={2}
                      placeholder="Your answer"
                      aria-label="Answer to the planner's question"
                      onChange={(event) => onAnswerChange(event.target.value)}
                    />
                  )}

                  {turn.awaiting ? (
                    <div className="card--actions">
                      {ask.type === "confirmation" ? (
                        <>
                          <button type="button" className="button button--primary" onClick={() => onDecide(true)}>
                            Allow once
                          </button>
                          <button type="button" className="button button--ghost-neutral" onClick={() => onDecide(false)}>
                            Deny and stop
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button button--primary"
                            onClick={() => onDecide(true, answer)}
                          >
                            Continue
                          </button>
                          <button type="button" className="button button--ghost-neutral" onClick={() => onDecide(false)}>
                            Stop here
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="meta">This prompt is closed.</p>
                  )}

                  {turn.awaiting && ask.type === "ask_user" && (
                    <p className="panel__footnote">
                      Your answer stays in this panel. It is never sent to the planner, and it is not
                      kept after the session.
                    </p>
                  )}
                </li>
              );
            }

            case "result":
              return (
                <li
                  key={turn.id}
                  className={`turn turn--orka turn--result turn--result-${turn.status}`}
                >
                  <div className="turn__head">
                    <h3 className="turn__title">{RUN_STATUS_LABEL[turn.status]}</h3>
                    {turn.stopReason && (
                      <span className="meta">{STOP_REASON_LABEL[turn.stopReason]}</span>
                    )}
                  </div>
                  {turn.summary && <p className="plan__detail">{turn.summary}</p>}
                  {turn.failure && <p className="error-text">{turn.failure.message}</p>}
                </li>
              );
          }
        })}
      </ol>
      {footer}
      <div ref={endRef} />
    </section>
  );
}

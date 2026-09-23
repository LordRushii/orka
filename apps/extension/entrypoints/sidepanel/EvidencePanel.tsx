import type { SanitizedObservation } from "@orka/contracts";
import type { LocalAuditView } from "../../shared/messages.ts";
import type { OutboundView } from "../../shared/outboundView.ts";
import {
  bandSummary,
  formatBytes,
  modelSummary,
  screenshotUrl,
  scanTimingSummary,
} from "./panelFormat.ts";

/**
 * The local evidence, as **collapsed dropdowns** below the conversation.
 *
 * The audit (what was redacted) and the outbound view (what left the machine)
 * each render as a `<details>` drawer, closed by default: the chat is the panel,
 * and this detail is one click away when the user wants it. Both drawers render
 * whether or not there is anything to show, so their absence is never mistaken
 * for "nothing to report".
 */
export function EvidencePanel({
  audit,
  observation,
  outbound,
  onDismiss,
}: {
  audit?: LocalAuditView;
  observation?: SanitizedObservation;
  outbound?: OutboundView;
  /**
   * Closes the session and releases the extension's in-memory captures. It sits
   * with the audit because that is what it releases -- the button and the
   * sentence explaining it belong together.
   */
  onDismiss?: () => void;
}) {
  const captured = audit && observation;

  return (
    <section className="evidence" aria-label="Local audit and outbound view">
      <div className="evidence__inner">
        <details className="drawer audit">
          <summary>
            Local audit
            <span className="meta">Original never leaves this device</span>
          </summary>
          <div className="drawer__body">
            {onDismiss && captured && (
              <button type="button" className="button button--link" onClick={onDismiss}>
                Dismiss session and release these images
              </button>
            )}

            {captured ? (
              <>
                {audit.originalScreenshot && audit.redactedScreenshot ? (
                  <div className="audit__images">
                    <figure>
                      <figcaption>Original (local only)</figcaption>
                      <img src={screenshotUrl(audit.originalScreenshot)} alt="Original active-tab capture" />
                    </figure>
                    <figure>
                      <figcaption>Redacted observation</figcaption>
                      <img src={screenshotUrl(audit.redactedScreenshot)} alt="Opaque redacted active-tab capture" />
                    </figure>
                  </div>
                ) : (
                  <p className="meta">Snapshot-only round: decided from the accessibility tree, no pixels captured.</p>
                )}
                <p className="meta">
                  Sanitized origin: {observation.urlOrigin}. Runtime: {audit.runtime.mode}
                  {audit.boundExecutionProvider ? ` (models on ${audit.boundExecutionProvider})` : ""}.
                </p>
                <div className="audit__summary">
                  {audit.redactionSummary.length === 0
                    ? "No sensitive regions detected."
                    : audit.redactionSummary
                        .map((entry) => `${entry.category}: ${entry.count}`)
                        .join(" · ")}
                </div>
                <p className="meta">Detection confidence: {bandSummary(audit.confidenceBands)}</p>
                <p className="meta">Models: {modelSummary(audit.models)}</p>
                {scanTimingSummary(audit.timings) && (
                  <p className="meta">Local scan cost: {scanTimingSummary(audit.timings)}</p>
                )}
              </>
            ) : (
              <p className="meta">Nothing scanned yet.</p>
            )}
          </div>
        </details>

        <details className="drawer">
          <summary>
            What left this device
            {outbound ? (
              <span className="meta">
                {outbound.forbiddenKey === null
                  ? `no forbidden field · ${formatBytes(outbound.bytes)}`
                  : `unexpected field: ${outbound.forbiddenKey}`}
              </span>
            ) : (
              <span className="meta">nothing yet</span>
            )}
          </summary>
          <div className="drawer__body">
            {outbound ? (
              <>
                <div className="audit__summary">
                  <ul className="metrics__weights">
                    {outbound.fields.map((field) => (
                      <li key={field.path}>
                        <span className="plan__type">{field.path}</span>
                        <span className="meta">
                          {" "}
                          {field.kind}
                          {field.kind === "array" || field.kind === "object"
                            ? ` (${field.size})`
                            : field.kind === "string"
                              ? ` (${field.size} chars)`
                              : ""}
                          {field.note ? ` · ${field.note}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="audit__summary">
                  <strong>Never in the request</strong>
                  <ul className="metrics__weights">
                    {outbound.absent.map((group) => (
                      <li key={group.label}>
                        <span className="plan__type">{group.label}</span>
                        <span className="meta"> {group.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <p className="meta">No planner request yet.</p>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}

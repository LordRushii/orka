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
 * The local evidence, as a **persistent, non-scrolling** panel section (Phase 8,
 * docs2/04-PRODUCT-PRD.md §1: "A persistent, non-scrolling Local Audit / What
 * left this device section stays visible the whole time").
 *
 * It is deliberately *not* part of the scrolling conversation: the point of the
 * audit is that the user can check what was redacted and what was sent at any
 * moment, including in the middle of a step they are being asked to approve.
 * It renders whether or not there is anything to show, so its absence is never
 * mistaken for "nothing to report".
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
        <article className="card audit">
          <div className="status-row">
            <h2>Local audit</h2>
            <span className="meta">Original never leaves this device</span>
          </div>
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
                <p className="meta">
                  Snapshot-only round: this step was decided from the page's accessibility tree, so
                  no pixels were captured at all.
                </p>
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
              <p className="panel__footnote">
                Bands, not boxes: the exact detection map and the original pixels stay in extension
                memory and are released when this session closes.
              </p>
            </>
          ) : (
            <p className="meta">
              Nothing has been scanned yet. The redacted capture, the detection bands, and the
              runtime that produced them appear here for the whole session -- and stay visible while
              you decide on a step.
            </p>
          )}
        </article>

        <article className="card">
          <div className="status-row">
            <h2>What left this device</h2>
            {outbound ? (
              <span className="meta">
                {outbound.forbiddenKey === null
                  ? `no forbidden field · ${formatBytes(outbound.bytes)}`
                  : `unexpected field: ${outbound.forbiddenKey}`}
              </span>
            ) : (
              <span className="meta">nothing yet</span>
            )}
          </div>

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
              <p className="meta">
                Field names and sizes only. The values are not shown here because they are not the
                point: what matters is that these are the only fields the contract has.
              </p>
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
              <p className="panel__footnote">
                Described from the request body itself, so this list cannot drift away from what is
                actually sent.
              </p>
            </>
          ) : (
            <p className="meta">
              No planner request has been made in this session. When one is, this section lists the
              fields it contained, by name and size.
            </p>
          )}
        </article>
      </div>
    </section>
  );
}

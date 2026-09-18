/**
 * Terminal-path resource release for a Task Session.
 *
 * Phase 2's fail-closed rules require that the original screenshot and every
 * local audit reference are dropped when the audit closes or the session
 * ends -- including the failure, stop, timeout, and task-replacement paths,
 * not just the happy one. Keeping that in a single function means a new
 * terminal path cannot quietly forget one of them.
 */
export type ReleasableTask = {
  /** Raw `data:image/png;base64,...` capture; cleared to the empty string. */
  screenshotDataUrl: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** In-memory `LocalAudit` holding exact boxes and the original bitmap. */
  audit?: unknown;
  /**
   * Aborts an in-flight `POST /v1/plan`. A stopped or timed-out session must
   * not leave a request carrying the sanitized screenshot running against the
   * gateway, nor apply a plan that arrives after the user pressed Stop.
   */
  plannerAbort?: { abort(): void };
  /**
   * Aborts an in-flight execution. A stopped, timed-out, closed, or replaced
   * session must not keep clicking through the plan it already started, and a
   * pending confirmation has to stop waiting for an answer nobody will give.
   */
  executorAbort?: { abort(): void };
  /** The approved plan, and the observation every target is checked against. */
  plan?: unknown;
  observation?: unknown;
  /**
   * The user's private values for this task. Cleared to an empty object rather
   * than set to undefined so any reference already handed out is emptied too --
   * a resolved value must not outlive the Task Session that used it.
   */
  sensitiveValues?: Record<string, string>;
  modelManager: { dispose(): void };
  pixelWorkers: { dispose(): void };
};

/**
 * Releases every local artifact the task is holding. Disposal errors are
 * swallowed deliberately: a worker that already crashed must not be able to
 * keep the raw screenshot alive by throwing from `terminate()`.
 */
export function releaseTaskResources(task: ReleasableTask): void {
  task.screenshotDataUrl = "";
  task.audit = undefined;
  task.plan = undefined;
  task.observation = undefined;
  if (task.sensitiveValues !== undefined) {
    // Emptied in place: the private values must not survive the session that
    // used them, even through a reference held elsewhere.
    for (const key of Object.keys(task.sensitiveValues)) delete task.sensitiveValues[key];
  }

  if (task.timeoutHandle !== undefined) {
    clearTimeout(task.timeoutHandle);
    task.timeoutHandle = undefined;
  }

  for (const controller of [task.plannerAbort, task.executorAbort]) {
    if (controller === undefined) continue;
    try {
      controller.abort();
    } catch {
      // An already-settled request or a finished run cannot be un-sent;
      // nothing left to release.
    }
  }
  task.plannerAbort = undefined;
  task.executorAbort = undefined;

  try {
    task.modelManager.dispose();
  } catch {
    // Already-disposed or crashed model state is still released state.
  }
  try {
    task.pixelWorkers.dispose();
  } catch {
    // Same: a failed terminate() must not block the rest of the cleanup.
  }
}

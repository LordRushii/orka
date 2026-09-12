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

  if (task.timeoutHandle !== undefined) {
    clearTimeout(task.timeoutHandle);
    task.timeoutHandle = undefined;
  }

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

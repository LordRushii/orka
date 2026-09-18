/**
 * The extension's entire logging surface, on purpose.
 *
 * phases/05-demo-and-hardening.md ends with "remove development logging and
 * placeholder keys before recording", and the honest reading of that is not
 * "delete the three console lines" -- it is that a log statement must be
 * incapable of printing anything the user was not already shown.
 *
 * A raw error object is not safe to log here. An error can carry a request
 * body, a response fragment, an observation, or a private value on its way
 * out, and a console line ends up in a screenshot, a screen recording, or a
 * bug report. So this module offers exactly one thing to log about a failure:
 * its *name*. Not its message, not its stack, not the object.
 *
 * `apps/extension/test/logging.test.ts` enforces the rest of the rule by
 * reading the source: no `console.log`, `console.debug`, or `console.info`
 * anywhere in shipped code, and every `console.warn` / `console.error`
 * argument is either a string literal or a call to this function.
 */

/** The name of a failure, for a log line that cannot carry its contents. */
export function safeErrorName(error: unknown): string {
  if (error instanceof Error) {
    // A subclass name is a fixed identifier from the codebase; a message is
    // whatever was thrown, which may be a payload wearing a string costume.
    return /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
  }
  return "unknown";
}

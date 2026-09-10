let counter = 0;

/** Generates a locally-unique request id without depending on `crypto.randomUUID` being present. */
export function nextRequestId(): string {
  counter += 1;
  return `req-${Date.now()}-${counter}`;
}

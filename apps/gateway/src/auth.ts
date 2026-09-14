import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so both sides
 * are copied into equal-width zero-filled buffers first and the length check
 * is folded into the result rather than short-circuited. A wrong-length token
 * then costs the same as a wrong-value one.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const width = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(width);
  const paddedRight = Buffer.alloc(width);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

/**
 * Extracts and verifies `Authorization: Bearer <token>`. Returns a boolean
 * only -- the caller must not report *why* a token failed, since that would
 * distinguish "no header" from "wrong token" for an attacker.
 */
export function isAuthorized(
  headerValue: string | undefined,
  expectedToken: string,
): boolean {
  if (!headerValue || expectedToken.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const presented = match?.[1]?.trim();
  if (!presented) return false;
  return constantTimeEquals(presented, expectedToken);
}

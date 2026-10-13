import { createHmac, timingSafeEqual } from "node:crypto";

export const CSRF_HEADER = "x-atlas-csrf";

// Session-bound CSRF-токен без хранения (phase-2-plan §3.1):
// csrf = HMAC_SHA256(key=CSRF_SECRET, msg=session.token_hash), base64url.
export function deriveCsrfToken(sessionTokenHash: string, secret: string): string {
  return createHmac("sha256", secret).update(sessionTokenHash).digest("base64url");
}

export function verifyCsrfToken(
  provided: string | null,
  sessionTokenHash: string,
  secret: string,
): boolean {
  if (!provided) return false;
  const expected = deriveCsrfToken(sessionTokenHash, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

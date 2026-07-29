import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const NIXON_COOKIE_NAME = "yinling_nixon_auth";

// Demo access is intentionally code-pinned so a stale Vercel variable cannot
// silently change the agreed admin login during review.
const ADMIN_PASSWORD_HASH = "6f8633ab6249818e87fe886e0a679c11037c7174a79d60100a01eae17bd0d1eb";

function passwordHash() {
  const configuredHash = process.env.NIXON_PASSWORD_HASH;
  const allowOverride = process.env.ALLOW_NIXON_PASSWORD_OVERRIDE === "true";
  return allowOverride && configuredHash ? configuredHash : ADMIN_PASSWORD_HASH;
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function matchesNixonPassword(candidate: unknown) {
  if (typeof candidate !== "string" || !candidate) return false;
  const candidateHash = createHash("sha256").update(candidate).digest("hex");
  return safeEquals(candidateHash, passwordHash());
}

export function nixonSessionToken() {
  const secret = process.env.OPS_API_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("yinling-nixon-session-v1").digest("hex");
}

export function hasValidNixonSession(value: string | undefined) {
  const expected = nixonSessionToken();
  return Boolean(value && expected && safeEquals(value, expected));
}

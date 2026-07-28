import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const NIXON_COOKIE_NAME = "yinling_nixon_auth";

const FALLBACK_PASSWORD_HASH = "7b404139cd395a7678c81f0e10969c74b243e75641e207d5902743807f062c52";

function passwordHash() {
  return process.env.NIXON_PASSWORD_HASH || FALLBACK_PASSWORD_HASH;
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

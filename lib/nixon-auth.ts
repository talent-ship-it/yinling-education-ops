import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const NIXON_COOKIE_NAME = "yinling_nixon_auth";

const FALLBACK_PASSWORD_HASH = "6f8633ab6249818e87fe886e0a679c11037c7174a79d60100a01eae17bd0d1eb";

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
  return createHmac("sha256", passwordHash()).update("yinling-nixon-session-v1").digest("hex");
}

export function hasValidNixonSession(value: string | undefined) {
  if (!value) return false;
  return safeEquals(value, nixonSessionToken());
}

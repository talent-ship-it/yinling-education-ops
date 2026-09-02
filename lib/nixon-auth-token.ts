import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ELEVATION_TOKEN_VERSION = "v3";
const ELEVATION_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_PATTERN = /^[a-f0-9]{64}$/u;
const ELEVATION_TOKEN_PATTERN = /^v3\.(\d{10})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u;

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signature(secretHex: string, payload: string) {
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update("yinling-admin-elevation-v3\u0000", "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

export function createAdminElevationToken(input: Readonly<{
  secretHex: string;
  sessionId: string;
  now?: Date;
}>) {
  if (!SECRET_PATTERN.test(input.secretHex) || !SESSION_ID_PATTERN.test(input.sessionId)) return null;
  const now = input.now ?? new Date();
  const expiresAt = Math.floor(now.getTime() / 1_000) + ELEVATION_TOKEN_MAX_AGE_SECONDS;
  const payload = `${ELEVATION_TOKEN_VERSION}.${expiresAt}.${input.sessionId}.${randomBytes(32).toString("base64url")}`;
  return `${payload}.${signature(input.secretHex, payload)}`;
}

export function verifyAdminElevationToken(input: Readonly<{
  secretHex: string;
  token: string | undefined;
  expectedSessionId: string;
  now?: Date;
}>) {
  const match = input.token?.match(ELEVATION_TOKEN_PATTERN);
  if (!SECRET_PATTERN.test(input.secretHex)
      || !SESSION_ID_PATTERN.test(input.expectedSessionId)
      || !match
      || match[2] !== input.expectedSessionId) return false;
  const current = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt)
      || expiresAt <= current
      || expiresAt > current + ELEVATION_TOKEN_MAX_AGE_SECONDS) return false;
  const payload = `${ELEVATION_TOKEN_VERSION}.${match[1]}.${match[2]}.${match[3]}`;
  return safeEquals(match[4], signature(input.secretHex, payload));
}

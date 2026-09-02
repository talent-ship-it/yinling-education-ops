import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WECOM_DISPATCH_COOKIE_NAME = "yinling_wecom_dispatch";
export const WECOM_DISPATCH_SESSION_SECONDS = 15 * 60;

function dispatchPassword() {
  return process.env.WECOM_DISPATCH_PASSWORD || "";
}

function dispatchSessionSecret() {
  return process.env.WECOM_DISPATCH_SESSION_SECRET || "";
}

function constantTimeStringMatch(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sign(payload: string) {
  const secret = dispatchSessionSecret();
  if (!secret) return "";
  return createHmac("sha256", secret).update(`yinling-wecom-dispatch-v1.${payload}`).digest("hex");
}

export function isWecomDispatchConfigured() {
  return Boolean(dispatchPassword() && dispatchSessionSecret());
}

export function matchesWecomDispatchPassword(candidate: unknown) {
  const expected = dispatchPassword();
  return Boolean(expected && typeof candidate === "string" && constantTimeStringMatch(expected, candidate));
}

export function issueWecomDispatchSession(now = Date.now()) {
  const expiresAt = now + WECOM_DISPATCH_SESSION_SECONDS * 1000;
  const nonce = randomBytes(18).toString("base64url");
  const payload = `${expiresAt}.${nonce}`;
  const signature = sign(payload);

  if (!signature) return null;

  return {
    value: `${payload}.${signature}`,
    expiresAt,
  };
}

export function hasWecomDispatchAuthorization(value: string | undefined, now = Date.now()) {
  if (!value || !dispatchSessionSecret()) return false;
  const [expiresRaw, nonce, signature, ...extra] = value.split(".");
  if (extra.length || !expiresRaw || !nonce || !signature || !/^\d{13}$/.test(expiresRaw)) return false;

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  const expected = sign(`${expiresRaw}.${nonce}`);
  return Boolean(expected && constantTimeStringMatch(expected, signature));
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

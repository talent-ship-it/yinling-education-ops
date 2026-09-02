import "server-only";

import { createHmac } from "node:crypto";

import { normaliseDemoIdentity } from "@/lib/demo-session-token";
import {
  admitAccountAuthAttempt,
  checkAccountAuthThrottle,
  recordAccountAuthAttempt,
  type AccountAuthThrottleResult,
} from "@/lib/ops-store";

export type AccountAuthThrottlePurpose = "login" | "mfa" | "password";

export class AccountAuthThrottleConfigurationError extends Error {}

function throttleSecret() {
  const secret = process.env.ACCOUNT_AUTH_THROTTLE_SECRET?.trim();
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) {
    throw new AccountAuthThrottleConfigurationError("ACCOUNT_AUTH_THROTTLE_SECRET is required for authentication throttling.");
  }
  return secret;
}

function throttleDigest(
  purpose: AccountAuthThrottlePurpose,
  dimension: "network" | "identity",
  value: string,
) {
  const digest = createHmac("sha256", Buffer.from(throttleSecret(), "hex"))
    .update("yinling-account-auth-throttle-v1\u0000", "utf8")
    .update(purpose, "utf8")
    .update("\u0000", "utf8")
    .update(dimension, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `${dimension === "network" ? "n" : "i"}:${digest}`;
}

function requestAddress(request: Request) {
  if (process.env.NODE_ENV === "production") {
    if (process.env.VERCEL !== "1") {
      throw new AccountAuthThrottleConfigurationError("A trusted production proxy is required for authentication throttling.");
    }
    const candidate = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
    if (!candidate) {
      throw new AccountAuthThrottleConfigurationError("The trusted Vercel client address header is missing.");
    }
    return candidate.normalize("NFKC").slice(0, 160);
  }
  const candidate = request.headers.get("x-real-ip")?.trim() || "local-development";
  return candidate.normalize("NFKC").slice(0, 160);
}

/** Returns opaque, server-keyed dimensions; raw identifiers are never persisted. */
export function accountAuthThrottleKeys(
  request: Request,
  purpose: AccountAuthThrottlePurpose,
  identityHint?: string | null,
) {
  const keys = [throttleDigest(purpose, "network", requestAddress(request))];
  const identityKey = accountAuthThrottleIdentityKey(purpose, identityHint);
  if (identityKey) keys.push(identityKey);
  return keys;
}

export function accountAuthThrottleIdentityKey(
  purpose: AccountAuthThrottlePurpose,
  identityHint?: string | null,
) {
  const identity = typeof identityHint === "string" ? normaliseDemoIdentity(identityHint) : "";
  return identity ? throttleDigest(purpose, "identity", identity) : null;
}

export function checkAuthThrottle(keys: readonly string[]) {
  return checkAccountAuthThrottle(keys);
}

/** Atomically consumes one admission before any password or TOTP verification. */
export function admitAuthAttempt(keys: readonly string[]) {
  return admitAccountAuthAttempt(keys);
}

/** Remove only this successfully verified request's pre-verification admission. */
export function settleSuccessfulAuthAttempt(keys: readonly string[]) {
  return recordAccountAuthAttempt(keys, true);
}

export function retryAfterSeconds(result: AccountAuthThrottleResult) {
  return Math.max(1, Math.min(3_600, Number.isSafeInteger(result.retry_after_seconds)
    ? result.retry_after_seconds
    : 60));
}

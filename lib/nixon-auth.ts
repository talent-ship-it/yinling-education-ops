import "server-only";

import {
  ACCOUNT_PASSWORD_ALGORITHM,
  verifyAccountPassword,
} from "@/lib/account-credentials";
import type { DemoSessionIdentity } from "@/lib/demo-session-token";
import { DEMO_ADMIN_USER } from "@/lib/demo-users";
import {
  createAdminElevationToken,
  verifyAdminElevationToken,
} from "@/lib/nixon-auth-token";

export const NIXON_COOKIE_NAME = "yinling_nixon_auth";

function configuredPasswordCredential(hash: string | undefined, salt: string | undefined) {
  if (!hash || !salt) return null;
  return {
    password_algorithm: ACCOUNT_PASSWORD_ALGORITHM,
    password_hash: hash.trim().toLowerCase(),
    password_salt: salt.trim().toLowerCase(),
  };
}

async function matchesConfiguredPassword(
  candidate: unknown,
  hash: string | undefined,
  salt: string | undefined,
) {
  const credential = configuredPasswordCredential(hash, salt);
  return credential ? verifyAccountPassword(candidate, credential) : false;
}

export function matchesNixonPassword(candidate: unknown) {
  return matchesConfiguredPassword(
    candidate,
    process.env.NIXON_PASSWORD_HASH,
    process.env.NIXON_PASSWORD_SALT,
  );
}

export function matchesLimitedAdminPassword(candidate: unknown) {
  return matchesConfiguredPassword(
    candidate,
    process.env.LIMITED_ADMIN_PASSWORD_HASH,
    process.env.LIMITED_ADMIN_PASSWORD_SALT,
  );
}

function elevationSecret() {
  const value = process.env.NIXON_SESSION_SECRET?.trim();
  return value && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

/**
 * This cookie is only a short-lived elevation marker. Every protected route
 * also validates the opaque v5 account session against the revocable ledger.
 */
export function nixonSessionToken(sessionId: string, now = new Date()) {
  const secret = elevationSecret();
  return secret ? createAdminElevationToken({ secretHex: secret, sessionId, now }) : null;
}

export function hasValidNixonSession(
  value: string | undefined,
  expectedSessionId: string,
  now = new Date(),
) {
  const secret = elevationSecret();
  return secret ? verifyAdminElevationToken({
    secretHex: secret,
    token: value,
    expectedSessionId,
    now,
  }) : false;
}

/** Full-admin authority is valid only inside a live, database-backed session. */
export function hasFullAdminAccess(
  session: DemoSessionIdentity,
  elevationCookie: string | undefined,
) {
  return session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && typeof session.accountId === "string"
    && typeof session.sessionId === "string"
    && session.permissions?.includes("*") === true
    && hasValidNixonSession(elevationCookie, session.sessionId);
}

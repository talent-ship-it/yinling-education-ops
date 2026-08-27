import "server-only";

import { createHash, randomBytes } from "node:crypto";

export const ACCOUNT_INVITE_TTL_SECONDS = 60 * 60 * 24;
export const ACCOUNT_RECOVERY_TTL_SECONDS = 60 * 30;

export type OneTimeAccountToken = Readonly<{
  /** The raw value is held in memory only for a delivery adapter. */
  raw: string;
  hash: string;
}>;

/** Generate a token that is never persisted or returned by an API route. */
export function createOneTimeAccountToken(purpose: "invite" | "recovery"): OneTimeAccountToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashAccountToken(raw, purpose) };
}

/** Purpose separation prevents a token copied between ledgers from being accepted. */
export function hashAccountToken(raw: string, purpose: "invite" | "recovery") {
  return createHash("sha256")
    .update(`yinling-account-${purpose}-token-v1\u0000${raw}`, "utf8")
    .digest("hex");
}

export function isAccountTokenHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

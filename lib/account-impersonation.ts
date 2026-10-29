import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { hasFullAdminAccess } from "@/lib/nixon-auth";
import { validateTeacherSession } from "@/lib/demo-teacher-login";
import { accountIdentityKey } from "@/lib/account-credentials";
import { parseServerSessionToken, type DemoSessionIdentity } from "@/lib/demo-session-token";
import { getAccountSession, getOpsState, revokeCurrentAccountSession, type OpsRpcOptions } from "@/lib/ops-store";

export const IMPERSONATION_COOKIE_NAME = "yinling_account_identity";
export const IMPERSONATION_MAX_AGE = 60 * 60;

type IdentityClaim = Readonly<{
  v: 1;
  actorAccountId: string;
  actorSessionId: string;
  targetAccountId: string;
  targetSessionToken: string;
  identityKey: string;
  expiresAt: number;
}>;

function signingKey() {
  const secret = process.env.DEMO_SESSION_SECRET?.trim();
  return secret && /^[a-f0-9]{64}$/u.test(secret) ? Buffer.from(secret, "hex") : null;
}

function signature(payload: string, key: Buffer) {
  return createHmac("sha256", key).update(`yinling-account-identity-v1:${payload}`).digest("base64url");
}

function validClaim(claim: Partial<IdentityClaim>, now: number): claim is IdentityClaim {
  const fields = [claim.actorAccountId, claim.actorSessionId, claim.targetAccountId, claim.identityKey];
  return claim.v === 1 && Number.isSafeInteger(claim.expiresAt) && claim.expiresAt! > now
    && fields.every((field) => typeof field === "string" && field.length > 0)
    && parseServerSessionToken(claim.targetSessionToken) !== null;
}

function validSignature(parts: string[], key: Buffer) {
  if (parts.length !== 2) return false;
  const expected = Buffer.from(signature(parts[0], key));
  const supplied = Buffer.from(parts[1]);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function createImpersonationToken(input: Omit<IdentityClaim, "v" | "expiresAt">, now = Date.now()) {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({ ...input, v: 1, expiresAt: now + IMPERSONATION_MAX_AGE * 1_000 })).toString("base64url");
  return `${payload}.${signature(payload, key)}`;
}

export function parseImpersonationToken(value: string, now = Date.now()): IdentityClaim | null {
  const key = signingKey();
  if (!key || value.length > 2_048) return null;
  const parts = value.split(".");
  if (!validSignature(parts, key)) return null;
  try {
    const claim = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<IdentityClaim>;
    return validClaim(claim, now) ? claim : null;
  } catch {
    return null;
  }
}

/** Revoke only the disposable target session, preserving the original login. */
export async function revokeImpersonationSession(value: string | undefined) {
  const claim = value ? parseImpersonationToken(value) : null;
  const envelope = claim && parseServerSessionToken(claim.targetSessionToken);
  return envelope ? revokeCurrentAccountSession(envelope) : null;
}

/** Resolve current target authority on every request; never inherit the administrator's permissions. */
export async function resolveImpersonatedSession(input: {
  actor: DemoSessionIdentity;
  token: string;
  elevationCookie?: string;
  rpcOptions?: OpsRpcOptions;
}): Promise<{ session: DemoSessionIdentity; mustChangePassword: boolean } | { error: string; status: 403 | 503 }> {
  const { actor, rpcOptions } = input;
  const claim = parseImpersonationToken(input.token);
  if (!claim || claim.actorAccountId !== actor.accountId || claim.actorSessionId !== actor.sessionId
    || !hasFullAdminAccess(actor, input.elevationCookie)) {
    return { error: "身份切换已失效，请返回管理员后重新选择账号。", status: 403 };
  }
  try {
    const envelope = parseServerSessionToken(claim.targetSessionToken)!;
    const target = await getAccountSession(envelope.tokenHash, rpcOptions);
    if (!target || target.session_id !== envelope.sessionId || target.account_id !== claim.targetAccountId
      || accountIdentityKey(target.account_name, target.account_role) !== claim.identityKey) {
      return { error: "目标账号已停用或不存在，请返回管理员。", status: 403 };
    }
    let session: DemoSessionIdentity = {
      user: target.account_name,
      role: target.account_role,
      accountId: target.account_id,
      sessionId: target.session_id,
      credentialVersion: target.credential_version ?? undefined,
      accessVersion: target.access_version,
      roleVersion: target.role_version,
      scopeVersion: target.scope_version,
      permissions: target.permissions,
      scopeMembers: target.scope_members,
      mfaVerified: target.mfa_verified,
      impersonator: { user: actor.user, accountId: actor.accountId!, sessionId: actor.sessionId! },
    };
    if (session.role === "teacher") {
      const rows = await getOpsState(["teachers"], rpcOptions);
      const validated = validateTeacherSession(session, rows.find((row) => row.entity === "teachers")?.payload);
      if (!("identity" in validated)) return { error: validated.error, status: validated.status === 503 ? 503 : 403 };
      session = { ...session, user: validated.identity.user };
    }
    return { session, mustChangePassword: target.must_change_password };
  } catch {
    return { error: "目标账号权限暂时无法核对，请稍后重试或返回管理员。", status: 503 };
  }
}

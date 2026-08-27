import { NextResponse } from "next/server";

import { accountIdentityKey, verifyAccountPassword } from "@/lib/account-credentials";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSecret,
  MfaConfigurationError,
  verifyTotpCode,
} from "@/lib/account-mfa";
import {
  accountAuthThrottleKeys,
  admitAuthAttempt,
  settleSuccessfulAuthAttempt,
  retryAfterSeconds,
} from "@/lib/account-rate-limit";
import { resolveAccountRequestContext } from "@/lib/account-request-context";
import { normaliseDemoIdentity } from "@/lib/demo-session-token";
import {
  beginAccountMfaSetup,
  confirmAccountMfa,
  disableAccountMfa,
  getAppAccountCredential,
  getAccountMfa,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function expireAuthCookies(response: NextResponse) {
  response.cookies.set("yinling_demo_auth", "", { path: "/", maxAge: 0 });
  response.cookies.set("yinling_nixon_auth", "", { path: "/", maxAge: 0 });
}

function staleSecuritySession() {
  const response = noStore({ error: "账号安全状态刚刚已更新，请重新登录。", code: "stale_session" }, 401);
  expireAuthCookies(response);
  return response;
}

function throttledMfa(retryAfterValue: number) {
  const retryAfter = retryAfterSeconds({ blocked: true, retry_after_seconds: retryAfterValue });
  return NextResponse.json({
    error: `验证码尝试过于频繁，请在 ${retryAfter} 秒后重试。`,
    code: "account_mfa_rate_limited",
    retryAfterSeconds: retryAfter,
  }, {
    status: 429,
    headers: { "Cache-Control": "private, no-store", "Retry-After": String(retryAfter) },
  });
}

export async function GET() {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  try {
    const record = await getAccountMfa(resolved.context.session.accountId);
    return noStore({
      ok: true,
      enabled: record?.enabled ?? false,
      mfaVersion: record?.mfa_version ?? 0,
      setupPending: Boolean(record && !record.enabled),
    });
  } catch {
    return noStore({ error: "MFA 状态暂时无法读取，请稍后重试。" }, 503);
  }
}

export async function POST(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved.context;
  if (!session.sessionId
      || !Number.isSafeInteger(session.credentialVersion)
      || (session.credentialVersion ?? 0) <= 0
      || !Number.isSafeInteger(session.accessVersion)
      || (session.accessVersion ?? 0) <= 0) {
    return staleSecuritySession();
  }
  const securitySnapshot = {
    sessionId: session.sessionId,
    expectedCredentialVersion: session.credentialVersion!,
    expectedAccessVersion: session.accessVersion!,
  } as const;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action;
  if (action !== "begin" && action !== "verify" && action !== "disable") {
    return noStore({ error: "MFA 命令无效。" }, 400);
  }

  let throttleKeys: readonly string[];
  try {
    throttleKeys = accountAuthThrottleKeys(request, "mfa", session.accountId);
    const admission = await admitAuthAttempt(throttleKeys);
    if (admission.blocked) return throttledMfa(admission.retry_after_seconds);
  } catch {
    return noStore({ error: "MFA 安全状态暂时无法核对，请稍后重试。" }, 503);
  }

  try {
    if (action === "begin" || action === "verify") {
      const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
      if (!currentPassword || Array.from(currentPassword).length > 256) {
        return noStore({ error: "请填写当前密码后继续设置 MFA。", code: "current_password_required" }, 400);
      }
      const identityKey = accountIdentityKey(session.user, session.role);
      const credential = await getAppAccountCredential(identityKey);
      if (!credential) {
        return noStore({ error: "请先为当前账号设置独立密码，再启用 MFA。", code: "independent_password_required" }, 409);
      }
      const credentialMatches = credential.identity_key === identityKey
        && credential.enabled
        && credential.account_role === session.role
        && normaliseDemoIdentity(credential.account_name) === normaliseDemoIdentity(session.user);
      const passwordVerified = credentialMatches && await verifyAccountPassword(currentPassword, credential);
      if (!passwordVerified) {
        return noStore({ error: "当前密码不正确。", code: "invalid_current_password" }, 401);
      }
    }

    const current = await getAccountMfa(session.accountId);
    if (action === "begin") {
      if (current?.enabled) return noStore({ error: "MFA 已启用；如需更换，请先验证并停用。" }, 409);
      const secret = generateTotpSecret();
      const saved = await beginAccountMfaSetup({
        accountId: session.accountId,
        encryptedSecret: encryptMfaSecret(secret),
        expectedMfaVersion: current?.mfa_version ?? 0,
        actorAccountId: session.accountId,
        ...securitySnapshot,
      });
      if (!saved) throw new OpsStoreError("MFA 设置未返回结果。", "invalid_commit_result");
      await settleSuccessfulAuthAttempt(throttleKeys);
      const issuer = "吟领教务";
      const label = `${issuer}:${session.user}`;
      const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
      return noStore({ ok: true, secret, otpauthUri, mfaVersion: saved.mfa_version });
    }

    if (!current) return noStore({ error: "请先开始设置 MFA。" }, 409);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!verifyTotpCode(decryptMfaSecret(current.secret_ciphertext), code)) {
      return noStore({ error: "验证码不正确或已过期。", code: "invalid_totp" }, 401);
    }
    try {
      await settleSuccessfulAuthAttempt(throttleKeys);
    } catch {
      return noStore({ error: "MFA 安全状态暂时无法核对，请稍后重试。" }, 503);
    }

    if (action === "verify") {
      if (current.enabled) return noStore({ error: "MFA 已启用。" }, 409);
      const confirmed = await confirmAccountMfa({
        accountId: session.accountId,
        expectedMfaVersion: current.mfa_version,
        actorAccountId: session.accountId,
        ...securitySnapshot,
      });
      if (!confirmed) throw new OpsStoreError("MFA 启用未返回结果。", "invalid_commit_result");
      const response = noStore({ ok: true, enabled: true, reauthRequired: true });
      expireAuthCookies(response);
      return response;
    }

    if (!current.enabled) return noStore({ error: "MFA 尚未启用。" }, 409);
    const disabled = await disableAccountMfa({
      accountId: session.accountId,
      expectedMfaVersion: current.mfa_version,
      actorAccountId: session.accountId,
      ...securitySnapshot,
    });
    if (!disabled) throw new OpsStoreError("MFA 停用未返回结果。", "invalid_commit_result");
    const response = noStore({ ok: true, enabled: false, reauthRequired: true });
    expireAuthCookies(response);
    return response;
  } catch (error) {
    if (error instanceof MfaConfigurationError) {
      return noStore({ error: "MFA 服务器加密密钥尚未配置。", code: "mfa_unconfigured" }, 503);
    }
    if (error instanceof OpsStoreError && error.message === "account_security_session_stale") {
      return staleSecuritySession();
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message.includes("version_conflict"))) {
      return noStore({ error: "MFA 状态刚刚已更新，请刷新后重试。", code: "version_conflict" }, 409);
    }
    return noStore({ error: "MFA 操作暂时失败，请稍后重试。" }, 503);
  }
}

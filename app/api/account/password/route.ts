import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  accountIdentityKey,
  accountPasswordCommandSalt,
  hashAccountPassword,
  validateAccountPassword,
  verifyAccountPassword,
} from "@/lib/account-credentials";
import {
  accountAuthThrottleKeys,
  admitAuthAttempt,
  settleSuccessfulAuthAttempt,
  retryAfterSeconds,
} from "@/lib/account-rate-limit";
import { legacyPasswordMatchesIdentity } from "@/lib/account-directory";
import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import {
  createServerSessionToken,
  normaliseDemoIdentity,
  SERVER_SESSION_MAX_AGE_SECONDS,
} from "@/lib/demo-session-token";
import { NIXON_COOKIE_NAME, nixonSessionToken } from "@/lib/nixon-auth";
import {
  createAccountSession,
  getAccountByIdentity,
  getAppAccountCredential,
  getOpsState,
  OpsStoreError,
  rotateAccountPasswordAtomic,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const COMMAND_KEY_PATTERN = /^account-password:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function changedButReauthenticationRequired() {
  const response = noStore({
    ok: true,
    changed: true,
    reauthRequired: true,
    message: "密码已更新，请使用新密码重新登录。",
  });
  response.cookies.set(DEMO_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  response.cookies.set(NIXON_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return response;
}

function accountContractUnavailable(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function throttledPassword(retryAfterValue: number) {
  const retryAfter = retryAfterSeconds({ blocked: true, retry_after_seconds: retryAfterValue });
  return NextResponse.json({
    error: `当前密码尝试过于频繁，请在 ${retryAfter} 秒后重试。`,
    code: "account_password_rate_limited",
    retryAfterSeconds: retryAfter,
  }, {
    status: 429,
    headers: { "Cache-Control": "private, no-store", "Retry-After": String(retryAfter) },
  });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(
    cookieStore.get(DEMO_COOKIE_NAME)?.value,
    { allowPasswordChangeRequired: true },
  );
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  if (!session.accountId) return noStore({ error: "账号目录尚未建立，请退出后重新登录。" }, 409);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const commandKey = typeof body?.commandKey === "string" ? body.commandKey.trim().toLowerCase() : "";
  const currentPassword = body?.currentPassword;
  const newPassword = body?.newPassword;
  if (!COMMAND_KEY_PATTERN.test(commandKey)
      || typeof currentPassword !== "string"
      || !currentPassword
      || Array.from(currentPassword).length > 256) {
    return noStore({ error: "请填写当前密码和有效的新密码。" }, 400);
  }
  const policyError = validateAccountPassword(newPassword, session.user);
  if (policyError) return noStore({ error: policyError, code: "password_policy" }, 400);

  let throttleKeys: readonly string[];
  try {
    throttleKeys = accountAuthThrottleKeys(request, "password", session.accountId);
    const admission = await admitAuthAttempt(throttleKeys);
    if (admission.blocked) return throttledPassword(admission.retry_after_seconds);
  } catch {
    return noStore({ error: "账号安全状态暂时无法核对，请稍后重试。" }, 503);
  }

  const identityKey = accountIdentityKey(session.user, session.role);
  try {
    const credential = await getAppAccountCredential(identityKey);
    let currentMatches = false;
    let newMatchesCurrent = false;
    if (credential) {
      const credentialMatchesIdentity = credential.identity_key === identityKey
        && credential.enabled
        && credential.account_role === session.role
        && normaliseDemoIdentity(credential.account_name) === normaliseDemoIdentity(session.user);
      if (!credentialMatchesIdentity) return noStore({ error: "账号凭据状态异常，请联系管理员。" }, 409);
      currentMatches = await verifyAccountPassword(currentPassword, credential);
      newMatchesCurrent = await verifyAccountPassword(newPassword, credential);
    } else {
      const rows = await getOpsState(["teachers"]);
      const teacherRow = rows.find((row) => row.entity === "teachers");
      if (!teacherRow) return noStore({ error: "老师名册尚未初始化。" }, 503);
      currentMatches = await legacyPasswordMatchesIdentity(currentPassword, session, teacherRow.payload);
      newMatchesCurrent = await legacyPasswordMatchesIdentity(newPassword, session, teacherRow.payload);
    }
    if (!currentMatches) {
      return noStore({ error: "当前密码不正确。" }, 401);
    }
    await settleSuccessfulAuthAttempt(throttleKeys);
    if (newMatchesCurrent) return noStore({ error: "新密码不能与当前密码相同。", code: "password_reused" }, 400);

    const password = await hashAccountPassword(
      newPassword as string,
      accountPasswordCommandSalt(commandKey, identityKey),
    );
    const result = await rotateAccountPasswordAtomic({
      commandKey,
      accountId: session.accountId,
      ...password,
      expectedCredentialVersion: credential?.credential_version ?? 0,
      mustChangePassword: false,
      action: "self_change",
      actorAccountId: session.accountId,
      issuedPasswordCiphertext: null,
    });
    if (!result || result.identity_key !== identityKey || !result.enabled) {
      throw new OpsStoreError("账号密码已提交但未返回有效结果。", "invalid_commit_result");
    }
    const currentDirectory = await getAccountByIdentity(identityKey).catch(() => null);
    if (!currentDirectory
        || currentDirectory.account_id !== session.accountId
        || currentDirectory.status !== "active") {
      return changedButReauthenticationRequired();
    }
    const serverSession = createServerSessionToken();
    if (!serverSession) return changedButReauthenticationRequired();
    const adminToken = session.user === DEMO_ADMIN_USER && session.role === "admin"
      ? nixonSessionToken(serverSession.sessionId)
      : null;
    if (session.role === "admin" && !adminToken) {
      return changedButReauthenticationRequired();
    }
    const created = await createAccountSession({
      sessionId: serverSession.sessionId,
      tokenHash: serverSession.tokenHash,
      accountId: session.accountId,
      expectedCredentialVersion: result.credential_version,
      expectedAccessVersion: currentDirectory.access_version,
      mfaVerified: session.mfaVerified === true,
      userAgent: request.headers.get("user-agent")?.slice(0, 512) ?? null,
    }).catch(() => null);
    if (!created || created.session_id !== serverSession.sessionId) {
      return changedButReauthenticationRequired();
    }

    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SERVER_SESSION_MAX_AGE_SECONDS,
    } as const;
    const response = noStore({
      ok: true,
      changed: true,
      credentialVersion: result.credential_version,
      mustChangePassword: false,
    });
    response.cookies.set(DEMO_COOKIE_NAME, serverSession.token, cookieOptions);
    if (adminToken) response.cookies.set(NIXON_COOKIE_NAME, adminToken, cookieOptions);
    return response;
  } catch (error) {
    if (accountContractUnavailable(error)) {
      return noStore({ error: "账号密码数据库合同尚未部署，当前不会保存密码。", code: "account_contract_unavailable" }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "account_credential_version_conflict")) {
      return noStore({ error: "账号密码刚刚已更新，请重新登录后再试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "该密码修改命令已用于其他内容，请重新提交。", code: "idempotency_conflict" }, 409);
    }
    return noStore({ error: "修改密码暂时失败，请稍后重试。" }, 503);
  }
}

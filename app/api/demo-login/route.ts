import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  resolveDemoIdentity,
} from "@/lib/demo-auth";
import {
  accountIdentityKey,
  verifyAccountPassword,
} from "@/lib/account-credentials";
import {
  AccountAuthThrottleConfigurationError,
  accountAuthThrottleKeys,
  admitAuthAttempt,
  checkAuthThrottle,
  settleSuccessfulAuthAttempt,
  retryAfterSeconds,
} from "@/lib/account-rate-limit";
import {
  decryptMfaSecret,
  matchTotpCounter,
} from "@/lib/account-mfa";
import {
  createServerSessionToken,
  normaliseDemoIdentity,
  SERVER_SESSION_MAX_AGE_SECONDS,
  type DemoSessionIdentity,
} from "@/lib/demo-session-token";
import { NIXON_COOKIE_NAME, nixonSessionToken } from "@/lib/nixon-auth";
import {
  createAccountSession,
  consumeAccountMfaTotp,
  ensureAccountDirectory,
  getAccountMfaForLogin,
  getAppAccountCredential,
  getOpsState,
  OpsStoreError,
} from "@/lib/ops-store";
import {
  resolveTeacherIdentity,
  type TeacherIdentityResolution,
} from "@/lib/demo-teacher-login";

export const dynamic = "force-dynamic";

type LoginResolution = TeacherIdentityResolution & Readonly<{
  mustChangePassword?: boolean;
  legacyAuthentication?: boolean;
}>;

function privateJson(payload: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store", ...headers },
  });
}

function throttledLogin(result: Readonly<{ retry_after_seconds: number }>, mfaRequired = false) {
  const retryAfter = retryAfterSeconds({ blocked: true, retry_after_seconds: result.retry_after_seconds });
  return privateJson({
    error: `登录尝试过于频繁，请在 ${retryAfter} 秒后重试。`,
    code: "account_auth_rate_limited",
    retryAfterSeconds: retryAfter,
    ...(mfaRequired ? { mfaRequired: true } : {}),
  }, 429, { "Retry-After": String(retryAfter) });
}

function sameIdentity(left: DemoSessionIdentity, right: DemoSessionIdentity) {
  return left.role === right.role && normaliseDemoIdentity(left.user) === normaliseDemoIdentity(right.user);
}

async function resolveLegacyIdentity(candidate: unknown, teachersPayload: unknown): Promise<TeacherIdentityResolution> {
  const pinned = await resolveDemoIdentity(candidate);
  // Admin credentials are dedicated secrets. Staff names are resolved with
  // the roster below so a colliding plain name can only select the teacher;
  // the role-qualified staff alias remains explicit.
  if (pinned && pinned.role !== "staff") return { identity: pinned };
  return resolveTeacherIdentity(candidate, teachersPayload);
}

function resolveNamedIdentity(candidate: unknown, teachersPayload: unknown): TeacherIdentityResolution {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return { error: "请输入账号或姓名。", status: 401 };
  }
  const normalized = normaliseDemoIdentity(candidate);
  if (normalized === "admin" || normalized === normaliseDemoIdentity(DEMO_ADMIN_USER)) {
    return { identity: { user: DEMO_ADMIN_USER, role: "admin" } };
  }
  if (normalized === normaliseDemoIdentity(DEMO_LIMITED_ADMIN_USER)) {
    return { identity: { user: DEMO_LIMITED_ADMIN_USER, role: "limited-admin" } };
  }
  return resolveTeacherIdentity(candidate, teachersPayload);
}

async function loadTeachersPayload() {
  const rows = await getOpsState(["teachers"]);
  const teacherRow = rows.find((row) => row.entity === "teachers");
  if (!teacherRow) throw new OpsStoreError("老师名册尚未初始化。", "teacher_roster_missing");
  return teacherRow.payload;
}

async function resolveLoginIdentity(
  username: unknown,
  password: unknown,
  teachersPayload: unknown,
  requestedResolution: TeacherIdentityResolution | null,
): Promise<LoginResolution> {
  const hasUsername = typeof username === "string" && Boolean(username.trim());
  const requested = hasUsername ? requestedResolution : null;
  if (requested && !("identity" in requested)) return requested;

  if (requested && "identity" in requested) {
    const identityKey = accountIdentityKey(requested.identity.user, requested.identity.role);
    try {
      const credential = await getAppAccountCredential(identityKey);
      if (credential) {
        const validCredential = credential.identity_key === identityKey
          && credential.enabled
          && credential.account_role === requested.identity.role
          && normaliseDemoIdentity(credential.account_name) === normaliseDemoIdentity(requested.identity.user)
          && await verifyAccountPassword(password, credential);
        if (!validCredential) return { error: "账号或密码不正确。", status: 401 };
        return {
          identity: {
            user: credential.account_name,
            role: credential.account_role,
            credentialVersion: credential.credential_version,
          },
          mustChangePassword: credential.must_change_password,
        };
      }
    } catch {
      return { error: "账号登录暂时不可用，请稍后重试。", status: 503 };
    }

    // A roster name is an identifier, never a teacher credential. Newly
    // imported teachers must receive an independent password before login.
    if (requested.identity.role === "teacher") {
      return { error: "账号或密码不正确。", status: 401 };
    }
    // Preserve explicitly configured legacy access for non-teacher accounts.
    const legacy = await resolveLegacyIdentity(password, teachersPayload);
    if ("identity" in legacy && sameIdentity(legacy.identity, requested.identity)) {
      return { identity: requested.identity, mustChangePassword: false, legacyAuthentication: true };
    }
    return { error: "账号或密码不正确。", status: 401 };
  }

  const legacy = await resolveLegacyIdentity(password, teachersPayload);
  if (!("identity" in legacy)) return legacy;
  if (legacy.identity.role === "teacher") {
    return { error: "账号或密码不正确。", status: 401 };
  }
  try {
    const credential = await getAppAccountCredential(accountIdentityKey(legacy.identity.user, legacy.identity.role));
    if (credential) {
      return { error: "该账号已启用独立密码，请同时填写账号或姓名。", status: 401 };
    }
  } catch {
    return { error: "账号登录暂时不可用，请稍后重试。", status: 503 };
  }
  return { identity: legacy.identity, mustChangePassword: false, legacyAuthentication: true };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const username = body?.username;
  const password = body?.password;
  const mfaCode = body?.mfaCode;
  if ((username !== undefined && typeof username !== "string")
      || (typeof username === "string" && Array.from(username).length > 160)
      || typeof password !== "string"
      || !password
      || Array.from(password).length > 256
      || (mfaCode !== undefined && (typeof mfaCode !== "string" || Array.from(mfaCode).length > 12))) {
    return privateJson({ error: "账号或密码不正确。" }, 400);
  }
  let networkThrottleKeys: readonly string[];
  try {
    networkThrottleKeys = accountAuthThrottleKeys(request, "login");
    const networkThrottle = await checkAuthThrottle(networkThrottleKeys);
    if (networkThrottle.blocked) return throttledLogin(networkThrottle, typeof mfaCode === "string");
  } catch (error) {
    const message = error instanceof AccountAuthThrottleConfigurationError
      ? "服务器登录安全配置尚未完成。"
      : "账号安全状态暂时无法核对，请稍后重试。";
    return privateJson({ error: message }, 503);
  }

  let teachersPayload: unknown;
  try {
    teachersPayload = await loadTeachersPayload();
  } catch (error) {
    return privateJson({
      error: error instanceof OpsStoreError && error.code === "teacher_roster_missing"
        ? error.message
        : "老师名册暂时无法核对，请稍后重试。",
    }, 503);
  }
  const hasUsername = typeof username === "string" && Boolean(username.trim());
  const requested = hasUsername ? resolveNamedIdentity(username, teachersPayload) : null;
  const canonicalThrottleIdentity = requested && "identity" in requested
    ? `account:${accountIdentityKey(requested.identity.user, requested.identity.role)}`
    : `${hasUsername ? "unknown" : "legacy"}:${networkThrottleKeys[0]}`;
  let throttleKeys: readonly string[];
  try {
    throttleKeys = accountAuthThrottleKeys(request, "login", canonicalThrottleIdentity);
    const admission = await admitAuthAttempt(throttleKeys);
    if (admission.blocked) return throttledLogin(admission, typeof mfaCode === "string");
  } catch {
    return privateJson({ error: "账号安全状态暂时无法核对，请稍后重试。" }, 503);
  }

  const resolved = await resolveLoginIdentity(username, password, teachersPayload, requested);
  if (!("identity" in resolved)) {
    return privateJson({ error: resolved.error }, resolved.status);
  }
  const { identity } = resolved;
  const identityKey = accountIdentityKey(identity.user, identity.role);
  let directory;
  let mfaVerified = false;
  try {
    directory = await ensureAccountDirectory({
      identityKey,
      accountName: identity.user,
      accountRole: identity.role,
    });
    if (!directory || directory.identity_key !== identityKey || directory.status !== "active") {
      return privateJson({ error: "账号或密码不正确。" }, 401);
    }
    if (resolved.legacyAuthentication && directory.legacy_session_allowed !== true) {
      return privateJson({ error: "账号或密码不正确。" }, 401);
    }
    const mfa = await getAccountMfaForLogin(identityKey);
    if (mfa?.enabled) {
      if (mfaCode === undefined) {
        // The UI discovers MFA only after the password succeeds. This 401 is
        // a challenge transition, not a failed authentication attempt.
        await settleSuccessfulAuthAttempt(throttleKeys);
        return privateJson(
          { error: "请输入验证器中的 6 位验证码。", mfaRequired: true },
          401,
        );
      }
      if (typeof mfaCode !== "string" || !/^\d{6}$/u.test(mfaCode.trim())) {
        return privateJson(
          { error: "请输入有效的 6 位验证码。", mfaRequired: true },
          401,
        );
      }
      const totpCounter = matchTotpCounter(decryptMfaSecret(mfa.secret_ciphertext), mfaCode.trim());
      if (totpCounter === null) {
        return privateJson(
          { error: "验证码不正确或已过期。", mfaRequired: true },
          401,
        );
      }
      if (!await consumeAccountMfaTotp({
        identityKey,
        expectedMfaVersion: mfa.mfa_version,
        counter: totpCounter,
      })) {
        return privateJson(
          { error: "验证码已使用或已过期。", mfaRequired: true },
          401,
        );
      }
      mfaVerified = true;
    }
  } catch {
    return privateJson({ error: "账号安全状态暂时无法核对，请稍后重试。" }, 503);
  }

  try {
    // Admission is consumed before verification for concurrency safety. A
    // success removes exactly its own increment from both dimensions without
    // erasing failures produced by other requests on the shared network.
    await settleSuccessfulAuthAttempt(throttleKeys);
  } catch {
    return privateJson({ error: "账号安全状态暂时无法核对，请稍后重试。" }, 503);
  }

  const serverSession = createServerSessionToken();
  if (!serverSession) {
    return privateJson({ error: "服务器访问配置尚未完成。" }, 503);
  }
  const adminToken = identity.role === "admin"
    ? nixonSessionToken(serverSession.sessionId)
    : null;
  if (identity.role === "admin" && !adminToken) {
    return privateJson({ error: "服务器访问配置尚未完成。" }, 503);
  }
  try {
    const created = await createAccountSession({
      sessionId: serverSession.sessionId,
      tokenHash: serverSession.tokenHash,
      accountId: directory.account_id,
      expectedCredentialVersion: identity.credentialVersion ?? 0,
      expectedAccessVersion: directory.access_version,
      mfaVerified,
      userAgent: request.headers.get("user-agent")?.slice(0, 512) ?? null,
    });
    if (!created || created.session_id !== serverSession.sessionId) {
      throw new OpsStoreError("账号登录会话未返回有效结果。", "invalid_session_result");
    }
  } catch (error) {
    if (error instanceof OpsStoreError
        && (error.code === "40001" || error.message === "account_login_state_stale")) {
      return privateJson({ error: "账号安全状态刚刚已更新，请重新登录。" }, 401);
    }
    return privateJson({ error: "账号登录会话暂时无法建立，请稍后重试。" }, 503);
  }

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SERVER_SESSION_MAX_AGE_SECONDS,
  } as const;
  const response = privateJson({
    ok: true,
    user: identity.user,
    role: identity.role,
    mustChangePassword: resolved.mustChangePassword ?? false,
  });
  response.cookies.set(DEMO_COOKIE_NAME, serverSession.token, cookieOptions);

  if (identity.user === DEMO_ADMIN_USER && identity.role === "admin") {
    response.cookies.set(NIXON_COOKIE_NAME, adminToken!, cookieOptions);
  } else {
    response.cookies.set(NIXON_COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  }

  return response;
}

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { matchesNixonPassword, nixonSessionToken } from "@/lib/nixon-auth";
import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  resolveDemoStaffAlias,
  resolveDemoStaffName,
  type DemoUser,
} from "@/lib/demo-users";

export { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, DEMO_STAFF_USERS } from "@/lib/demo-users";
export type { DemoUser } from "@/lib/demo-users";
import {
  createDemoSessionToken,
  parseServerSessionToken,
  normaliseDemoIdentity,
  parseDemoSessionToken,
  type DemoSessionIdentity,
} from "@/lib/demo-session-token";
import { validateTeacherSession } from "@/lib/demo-teacher-login";
import { accountIdentityKey } from "@/lib/account-credentials";
import {
  getAccountByIdentity,
  getAccountAuthorization,
  getAccountSession,
  getAppAccountAuthState,
  getOpsState,
  type AccountDirectoryRow,
  type AccountSessionResolution,
  OpsStoreError,
} from "@/lib/ops-store";
export { normaliseDemoIdentity } from "@/lib/demo-session-token";
export type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";

export const DEMO_COOKIE_NAME = "yinling_demo_auth";
const FALLBACK_LIMITED_ADMIN_PASSWORD_HASH = "e982e31a4d006b0b470fb414182c7f44bfc1e6d931c1a79c7113c5196db3077f";

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Resolve only identities whose credentials are owned by this application. */
export function resolveDemoIdentity(candidate: unknown): DemoSessionIdentity | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  if (matchesNixonPassword(candidate)) return { user: DEMO_ADMIN_USER, role: "admin" };
  const candidateHash = createHash("sha256").update(candidate).digest("hex");
  const limitedAdminHash = process.env.LIMITED_ADMIN_PASSWORD_HASH || FALLBACK_LIMITED_ADMIN_PASSWORD_HASH;
  if (safeEquals(candidateHash, limitedAdminHash)) return { user: DEMO_LIMITED_ADMIN_USER, role: "limited-admin" };

  const identity = resolveDemoStaffAlias(candidate) ?? resolveDemoStaffName(candidate);
  return identity ? { user: identity, role: "staff" } : null;
}

/** Backwards-compatible username-only helper for non-teacher credentials. */
export function resolveDemoUser(candidate: unknown): DemoUser | null {
  return resolveDemoIdentity(candidate)?.user ?? null;
}

function sessionSecret() {
  return nixonSessionToken();
}

export function demoSessionToken(identity: DemoSessionIdentity, now = new Date()) {
  const secret = sessionSecret();
  return secret ? createDemoSessionToken(identity, secret, now) : null;
}

export function getDemoSession(value: string | undefined, now = new Date()): DemoSessionIdentity | null {
  const secret = sessionSecret();
  return secret ? parseDemoSessionToken(value, secret, now) : null;
}

export type CurrentDemoSessionResolution =
  | { session: DemoSessionIdentity; mustChangePassword: boolean }
  | { error: string; status: 401 | 403 | 503 };

type CurrentDemoSessionOptions = Readonly<{
  /** Only the session-status and self-service password routes may opt in. */
  allowPasswordChangeRequired?: boolean;
}>;

function accountLifecycleUnavailable(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function serverSessionIdentity(session: AccountSessionResolution): DemoSessionIdentity {
  return {
    user: session.account_name,
    role: session.account_role,
    accountId: session.account_id,
    sessionId: session.session_id,
    accessVersion: session.access_version,
    roleVersion: session.role_version,
    scopeVersion: session.scope_version,
    mfaVerified: session.mfa_verified,
    permissions: session.permissions,
    scopeMembers: session.scope_members,
    ...(session.credential_version === null ? {} : { credentialVersion: session.credential_version }),
  };
}

async function currentServerSession(value: string | undefined, options: CurrentDemoSessionOptions) {
  const envelope = parseServerSessionToken(value);
  if (!envelope) return null;
  let current: AccountSessionResolution | null;
  try {
    current = await getAccountSession(envelope.tokenHash);
  } catch {
    // A v5 cookie is never downgraded to a legacy identity when the session
    // ledger is unavailable; doing so would bypass revocation and timeouts.
    return { error: "账号登录状态暂时无法核对，请稍后重试。", status: 503 } as const;
  }
  if (!current || current.session_id !== envelope.sessionId) {
    return { error: "账号登录状态已失效，请重新登录。", status: 401 } as const;
  }

  let identity = serverSessionIdentity(current);
  if (identity.role === "teacher") {
    try {
      const rows = await getOpsState(["teachers"]);
      const teacherRow = rows.find((row) => row.entity === "teachers");
      if (!teacherRow) return { error: "老师登录状态已失效，请重新登录。", status: 401 } as const;
      const validated = validateTeacherSession(identity, teacherRow.payload);
      if (!("identity" in validated)) {
        return { error: validated.error, status: validated.status === 503 ? 503 : 401 } as const;
      }
      identity = { ...identity, user: validated.identity.user };
    } catch {
      return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 } as const;
    }
  }
  if (current.must_change_password && !options.allowPasswordChangeRequired) {
    return { error: "请先修改管理员重置的临时密码。", status: 403 } as const;
  }
  return { session: identity, mustChangePassword: current.must_change_password } as const;
}

/**
 * Validates a signed session against mutable server-owned identity state.
 * Fixed application identities need only their signature; roster-backed
 * teacher identities must still exist exactly once on every protected request.
 */
export async function getCurrentDemoSession(
  value: string | undefined,
  options: CurrentDemoSessionOptions = {},
): Promise<CurrentDemoSessionResolution> {
  const server = await currentServerSession(value, options);
  if (server) return server;

  const session = getDemoSession(value);
  if (!session) return { error: "请先输入访问密码。", status: 401 };

  let mustChangePassword = false;
  let directory: AccountDirectoryRow | null = null;
  let permissions: readonly string[] | undefined;
  let scopeMembers: DemoSessionIdentity["scopeMembers"];
  try {
    const identityKey = accountIdentityKey(session.user, session.role);
    try {
      directory = await getAccountByIdentity(identityKey);
    } catch (error) {
      if (!accountLifecycleUnavailable(error)) {
        return { error: "账号登录状态暂时无法核对，请稍后重试。", status: 503 };
      }
    }
    if (directory && (
      directory.identity_key !== identityKey
      || directory.account_role !== session.role
      || normaliseDemoIdentity(directory.account_name) !== normaliseDemoIdentity(session.user)
      || directory.status !== "active"
      || !directory.legacy_session_allowed
    )) {
      return { error: "账号登录状态已失效，请重新登录。", status: 401 };
    }
    if (directory) {
      const authorization = await getAccountAuthorization(directory.account_id, directory.account_id);
      if (!authorization) return { error: "账号权限状态暂时无法核对，请稍后重试。", status: 503 };
      permissions = authorization.permissions;
      scopeMembers = authorization.scope_members;
    }
    const authState = await getAppAccountAuthState(identityKey);
    if (authState) {
      const identityMatches = authState.identity_key === identityKey
        && authState.account_role === session.role
        && normaliseDemoIdentity(authState.account_name) === normaliseDemoIdentity(session.user);
      if (!identityMatches || !authState.enabled || session.credentialVersion !== authState.credential_version) {
        return { error: "账号登录状态已失效，请重新登录。", status: 401 };
      }
      mustChangePassword = authState.must_change_password;
    } else if (session.credentialVersion !== undefined) {
      return { error: "账号登录状态已失效，请重新登录。", status: 401 };
    }
  } catch {
    // Deploy the database contract before the application. Once this code is
    // live, never treat an unavailable credential reader as "no credential":
    // that would revive a legacy password after a reset or rotation.
    return { error: "账号登录状态暂时无法核对，请稍后重试。", status: 503 };
  }

  if (session.role !== "teacher") {
    if (mustChangePassword && !options.allowPasswordChangeRequired) {
      return { error: "请先修改管理员重置的临时密码。", status: 403 };
    }
    return {
      session: directory ? {
        ...session,
        accountId: directory.account_id,
        accessVersion: directory.access_version,
        roleVersion: directory.role_version,
        scopeVersion: directory.scope_version,
        permissions,
        scopeMembers,
      } : session,
      mustChangePassword,
    };
  }

  try {
    const rows = await getOpsState(["teachers"]);
    const teacherRow = rows.find((row) => row.entity === "teachers");
    if (!teacherRow) {
      return { error: "老师登录状态已失效，请重新登录。", status: 401 };
    }
    const current = validateTeacherSession(session, teacherRow.payload);
    if (!("identity" in current)) {
      return { error: current.error, status: current.status === 503 ? 503 : 401 };
    }
    if (mustChangePassword && !options.allowPasswordChangeRequired) {
      return { error: "请先修改管理员重置的临时密码。", status: 403 };
    }
    return {
      session: {
        ...current.identity,
        ...(session.credentialVersion === undefined ? {} : { credentialVersion: session.credentialVersion }),
        ...(directory ? {
          accountId: directory.account_id,
          accessVersion: directory.access_version,
          roleVersion: directory.role_version,
          scopeVersion: directory.scope_version,
          permissions,
          scopeMembers,
        } : {}),
      },
      mustChangePassword,
    };
  } catch {
    return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 };
  }
}

export function getDemoSessionUser(value: string | undefined): DemoUser | null {
  return getDemoSession(value)?.user ?? null;
}

export function hasValidDemoSession(value: string | undefined) {
  return Boolean(getDemoSession(value));
}

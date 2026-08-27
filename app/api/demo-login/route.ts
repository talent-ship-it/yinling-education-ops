import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  demoSessionToken,
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  resolveDemoIdentity,
} from "@/lib/demo-auth";
import {
  accountIdentityKey,
  verifyAccountPassword,
} from "@/lib/account-credentials";
import { normaliseDemoIdentity, type DemoSessionIdentity } from "@/lib/demo-session-token";
import { NIXON_COOKIE_NAME, nixonSessionToken } from "@/lib/nixon-auth";
import { getAppAccountCredential, getOpsState, OpsStoreError } from "@/lib/ops-store";
import {
  resolveTeacherIdentity,
  type TeacherIdentityResolution,
} from "@/lib/demo-teacher-login";

export const dynamic = "force-dynamic";

type LoginResolution = TeacherIdentityResolution & Readonly<{
  mustChangePassword?: boolean;
}>;

function sameIdentity(left: DemoSessionIdentity, right: DemoSessionIdentity) {
  return left.role === right.role && normaliseDemoIdentity(left.user) === normaliseDemoIdentity(right.user);
}

function resolveLegacyIdentity(candidate: unknown, teachersPayload: unknown): TeacherIdentityResolution {
  const pinned = resolveDemoIdentity(candidate);
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

async function resolveLoginIdentity(username: unknown, password: unknown): Promise<LoginResolution> {
  let teachersPayload: unknown;
  try {
    teachersPayload = await loadTeachersPayload();
  } catch (error) {
    return {
      error: error instanceof OpsStoreError && error.code === "teacher_roster_missing"
        ? error.message
        : "老师名册暂时无法核对，请稍后重试。",
      status: 503,
    };
  }

  const hasUsername = typeof username === "string" && Boolean(username.trim());
  const requested = hasUsername ? resolveNamedIdentity(username, teachersPayload) : null;
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

    // Before an account adopts its own password, its existing review login is
    // still accepted only when it resolves back to the explicitly named user.
    const legacy = resolveLegacyIdentity(password, teachersPayload);
    if ("identity" in legacy && sameIdentity(legacy.identity, requested.identity)) {
      return { identity: requested.identity, mustChangePassword: false };
    }
    return { error: "账号或密码不正确。", status: 401 };
  }

  const legacy = resolveLegacyIdentity(password, teachersPayload);
  if (!("identity" in legacy)) return legacy;
  try {
    const credential = await getAppAccountCredential(accountIdentityKey(legacy.identity.user, legacy.identity.role));
    if (credential) {
      return { error: "该账号已启用独立密码，请同时填写账号或姓名。", status: 401 };
    }
  } catch {
    return { error: "账号登录暂时不可用，请稍后重试。", status: 503 };
  }
  return { identity: legacy.identity, mustChangePassword: false };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const username = body?.username;
  const password = body?.password;
  if ((username !== undefined && typeof username !== "string")
      || (typeof username === "string" && Array.from(username).length > 160)
      || typeof password !== "string"
      || !password
      || Array.from(password).length > 256) {
    return NextResponse.json({ error: "账号或密码不正确。" }, { status: 400 });
  }
  const resolved = await resolveLoginIdentity(username, password);
  if (!("identity" in resolved)) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { identity } = resolved;
  const demoToken = demoSessionToken(identity);
  const adminToken = identity.role === "admin" ? nixonSessionToken() : null;
  if (!demoToken || (identity.role === "admin" && !adminToken)) {
    return NextResponse.json({ error: "服务器访问配置尚未完成。" }, { status: 503 });
  }

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  } as const;
  const response = NextResponse.json({
    ok: true,
    user: identity.user,
    role: identity.role,
    mustChangePassword: resolved.mustChangePassword ?? false,
  });
  response.cookies.set(DEMO_COOKIE_NAME, demoToken, cookieOptions);

  if (identity.user === DEMO_ADMIN_USER && identity.role === "admin") {
    response.cookies.set(NIXON_COOKIE_NAME, adminToken!, cookieOptions);
  } else {
    response.cookies.set(NIXON_COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  }

  return response;
}

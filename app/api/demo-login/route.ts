import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  demoSessionToken,
  DEMO_ADMIN_USER,
  resolveDemoIdentity,
} from "@/lib/demo-auth";
import { NIXON_COOKIE_NAME, nixonSessionToken } from "@/lib/nixon-auth";
import { getOpsState } from "@/lib/ops-store";
import {
  resolveTeacherIdentity,
  type TeacherIdentityResolution,
} from "@/lib/demo-teacher-login";

export const dynamic = "force-dynamic";

async function resolveLoginIdentity(candidate: unknown): Promise<TeacherIdentityResolution> {
  try {
    const rows = await getOpsState(["teachers"]);
    const teacherRow = rows.find((row) => row.entity === "teachers");
    if (!teacherRow) return { error: "老师名册尚未初始化。", status: 503 };
    const pinned = resolveDemoIdentity(candidate);
    // Admin credentials are dedicated secrets. Staff names are resolved with
    // the roster below so a colliding plain name can only select the teacher;
    // the role-qualified staff alias remains explicit.
    if (pinned && pinned.role !== "staff") return { identity: pinned };
    return resolveTeacherIdentity(candidate, teacherRow.payload);
  } catch {
    // Do not expose infrastructure details or any teacher identity information.
    return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 };
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const resolved = await resolveLoginIdentity(body?.password);
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
  const response = NextResponse.json({ ok: true, user: identity.user, role: identity.role });
  response.cookies.set(DEMO_COOKIE_NAME, demoToken, cookieOptions);

  if (identity.user === DEMO_ADMIN_USER && identity.role === "admin") {
    response.cookies.set(NIXON_COOKIE_NAME, adminToken!, cookieOptions);
  } else {
    response.cookies.set(NIXON_COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  }

  return response;
}

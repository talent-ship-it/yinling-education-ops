import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  matchesNixonPassword,
  NIXON_COOKIE_NAME,
  nixonSessionToken,
} from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved) || resolved.session.user !== DEMO_ADMIN_USER || resolved.session.role !== "admin") {
    return NextResponse.json({ error: "请使用 Admin 密码从登录页进入全局视图。" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!matchesNixonPassword(body?.password)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return NextResponse.json({ error: "Admin 权限密码不正确。" }, { status: 401 });
  }
  const token = nixonSessionToken();
  if (!token) return NextResponse.json({ error: "服务器访问配置尚未完成。" }, { status: 503 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(NIXON_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return response;
}

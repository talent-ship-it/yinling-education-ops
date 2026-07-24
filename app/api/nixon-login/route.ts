import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";
import {
  matchesNixonPassword,
  NIXON_COOKIE_NAME,
  nixonSessionToken,
} from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "请先通过系统访问密码。" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!matchesNixonPassword(body?.password)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return NextResponse.json({ error: "Admin 权限密码不正确。" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(NIXON_COOKIE_NAME, nixonSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return response;
}

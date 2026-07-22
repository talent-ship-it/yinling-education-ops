import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  demoSessionToken,
  isDemoPasswordConfigured,
  matchesDemoPassword,
} from "@/lib/demo-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isDemoPasswordConfigured()) {
    return NextResponse.json({ error: "服务器尚未设置访问密码。" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  if (!matchesDemoPassword(body?.password)) {
    return NextResponse.json({ error: "密码不正确。" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(DEMO_COOKIE_NAME, demoSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}

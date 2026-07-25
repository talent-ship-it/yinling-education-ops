import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  demoSessionToken,
  DEMO_ADMIN_USER,
  resolveDemoUser,
} from "@/lib/demo-auth";
import { NIXON_COOKIE_NAME, nixonSessionToken } from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const user = resolveDemoUser(body?.password);
  if (!user) {
    return NextResponse.json({ error: "密码不正确。" }, { status: 401 });
  }

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  } as const;
  const response = NextResponse.json({ ok: true, user });
  response.cookies.set(DEMO_COOKIE_NAME, demoSessionToken(user), cookieOptions);

  if (user === DEMO_ADMIN_USER) {
    response.cookies.set(NIXON_COOKIE_NAME, nixonSessionToken(), cookieOptions);
  } else {
    response.cookies.set(NIXON_COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  }

  return response;
}

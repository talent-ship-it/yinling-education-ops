import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME } from "@/lib/demo-auth";
import { NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

const expiredCookie = {
  httpOnly: true,
  maxAge: 0,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(DEMO_COOKIE_NAME, "", expiredCookie);
  response.cookies.set(NIXON_COOKIE_NAME, "", expiredCookie);
  return response;
}

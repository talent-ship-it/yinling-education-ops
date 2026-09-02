import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { hasWecomDispatchAdminSession } from "@/lib/wecom-dispatch-access";
import {
  isSameOriginRequest,
  isWecomDispatchConfigured,
  issueWecomDispatchSession,
  matchesWecomDispatchPassword,
  WECOM_DISPATCH_COOKIE_NAME,
  WECOM_DISPATCH_SESSION_SECONDS,
} from "@/lib/wecom-dispatch-auth";

export const dynamic = "force-dynamic";

type AttemptWindow = { count: number; resetAt: number };
const attempts = new Map<string, AttemptWindow>();
const maxAttempts = 5;
const attemptWindowMs = 10 * 60 * 1000;

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(key: string, now = Date.now()) {
  const existing = attempts.get(key);
  if (!existing || existing.resetAt <= now) return false;
  return existing.count >= maxAttempts;
}

function recordFailedAttempt(key: string, now = Date.now()) {
  const existing = attempts.get(key);
  if (!existing || existing.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + attemptWindowMs });
    return;
  }
  attempts.set(key, { ...existing, count: existing.count + 1 });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!hasWecomDispatchAdminSession(cookieStore)) {
    return NextResponse.json({ error: "需要完整管理员权限。" }, { status: 403 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  }
  if (!isWecomDispatchConfigured()) {
    return NextResponse.json({ error: "企业微信发送授权尚未配置。" }, { status: 503 });
  }

  const key = clientKey(request);
  if (isRateLimited(key)) {
    return NextResponse.json({ error: "授权尝试次数过多，请稍后再试。" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.password !== "string" || Object.keys(body).length !== 1) {
    return NextResponse.json({ error: "授权信息无效。" }, { status: 400 });
  }
  if (!matchesWecomDispatchPassword(body.password)) {
    recordFailedAttempt(key);
    return NextResponse.json({ error: "授权信息无效。" }, { status: 403 });
  }

  attempts.delete(key);
  const session = issueWecomDispatchSession();
  if (!session) {
    return NextResponse.json({ error: "企业微信发送授权尚未配置。" }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true, expiresIn: WECOM_DISPATCH_SESSION_SECONDS }, {
    headers: { "Cache-Control": "private, no-store" },
  });
  response.cookies.set(WECOM_DISPATCH_COOKIE_NAME, session.value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WECOM_DISPATCH_SESSION_SECONDS,
  });
  return response;
}

import { NextResponse } from "next/server";

import { resolveAccountRequestContext } from "@/lib/account-request-context";
import { getAccountSessions, OpsStoreError, revokeAccountSessions } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  const requested = new URL(request.url).searchParams.get("accountId")?.trim() || context.session.accountId;
  if (!UUID_PATTERN.test(requested)) return noStore({ error: "账号标识无效。" }, 400);
  if (requested !== context.session.accountId && !context.fullAdmin) {
    return noStore({ error: "不能查看其他账号的会话。" }, 403);
  }
  try {
    const sessions = await getAccountSessions({
      actorAccountId: context.session.accountId,
      targetAccountId: requested,
      currentSessionId: context.session.sessionId,
    });
    return noStore({ ok: true, sessions });
  } catch {
    return noStore({ error: "登录会话暂时无法读取，请稍后重试。" }, 503);
  }
}

export async function DELETE(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const targetAccountId = typeof body?.accountId === "string" ? body.accountId.trim() : context.session.accountId;
  if (!UUID_PATTERN.test(targetAccountId) || body?.revokeAll !== true) {
    return noStore({ error: "会话撤销命令无效。" }, 400);
  }
  if (targetAccountId !== context.session.accountId && !context.fullAdmin) {
    return noStore({ error: "不能撤销其他账号的会话。" }, 403);
  }
  try {
    const result = await revokeAccountSessions({
      actorAccountId: context.session.accountId,
      targetAccountId,
      revokeAll: true,
    });
    if (!result) throw new OpsStoreError("会话撤销未返回结果。", "invalid_commit_result");
    const response = noStore({
      ok: true,
      revokedSessionCount: result.revoked_session_count,
      reauthRequired: targetAccountId === context.session.accountId,
    });
    if (targetAccountId === context.session.accountId) {
      response.cookies.set("yinling_demo_auth", "", { path: "/", maxAge: 0 });
      response.cookies.set("yinling_nixon_auth", "", { path: "/", maxAge: 0 });
    }
    return response;
  } catch {
    return noStore({ error: "登录会话暂时无法撤销，请稍后重试。" }, 503);
  }
}

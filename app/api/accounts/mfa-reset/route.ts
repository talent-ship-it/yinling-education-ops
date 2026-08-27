import { NextResponse } from "next/server";

import { resolveAccountRequestContext } from "@/lib/account-request-context";
import { OpsStoreError, resetAccountMfa } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  if (!context.fullAdmin) return noStore({ error: "仅超级管理员可以重置其他账号的 MFA。" }, 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (!UUID_PATTERN.test(accountId)) return noStore({ error: "账号标识无效。" }, 400);
  if (accountId === context.session.accountId) {
    return noStore({ error: "请在“账号安全”中验证后停用当前账号 MFA。" }, 400);
  }
  try {
    const result = await resetAccountMfa({ accountId: context.session.accountId, targetAccountId: accountId });
    if (!result) throw new OpsStoreError("MFA 重置未返回结果。", "invalid_commit_result");
    return noStore({ ok: true, result });
  } catch {
    return noStore({ error: "MFA 暂时无法重置，请稍后重试。" }, 503);
  }
}

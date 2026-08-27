import { NextResponse } from "next/server";

import { ACCOUNT_COMMAND_KEY_PATTERN } from "@/lib/account-credentials";
import { resolveAccountRequestContext } from "@/lib/account-request-context";
import { getAccountDirectory, OpsStoreError, setAccountStatus } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  if (!context.fullAdmin) return noStore({ error: "仅超级管理员可以启用或停用账号。" }, 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const commandKey = typeof body?.commandKey === "string" ? body.commandKey.trim().toLowerCase() : "";
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (!ACCOUNT_COMMAND_KEY_PATTERN.test(commandKey) || !commandKey.startsWith("account-status:")
      || !UUID_PATTERN.test(accountId) || (body?.status !== "active" && body?.status !== "disabled")
      || !Number.isSafeInteger(body?.expectedAccessVersion) || Number(body?.expectedAccessVersion) < 1) {
    return noStore({ error: "账号状态命令无效。" }, 400);
  }
  if (accountId === context.session.accountId) return noStore({ error: "不能停用当前登录账号。" }, 400);

  try {
    const target = (await getAccountDirectory(context.session.accountId)).find((account) => account.account_id === accountId);
    if (!target) return noStore({ error: "未找到该账号。" }, 404);
    if (target.super_admin) return noStore({ error: "超级管理员账号不能在这里停用。" }, 403);
    const result = await setAccountStatus({
      commandKey,
      accountId,
      status: body.status,
      expectedAccessVersion: Number(body.expectedAccessVersion),
      actorAccountId: context.session.accountId,
    });
    if (!result) throw new OpsStoreError("账号状态更新未返回结果。", "invalid_commit_result");
    return noStore({ ok: true, result });
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message.includes("version_conflict"))) {
      return noStore({ error: "账号状态刚刚已更新，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "该状态命令已用于其他内容，请重新提交。", code: "idempotency_conflict" }, 409);
    }
    return noStore({ error: "账号状态暂时无法更新，请稍后重试。" }, 503);
  }
}

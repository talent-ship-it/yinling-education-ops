import { NextResponse } from "next/server";

import {
  materializeManagedAccountDirectory,
  readAccountAuthorization,
  readManagedAccounts,
} from "@/lib/account-directory";
import { resolveAccountRequestContext } from "@/lib/account-request-context";
import { getAccountSessions, getOpsState, OpsStoreError } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  if (!context.fullAdmin) return noStore({ error: "仅超级管理员可以管理账号。" }, 403);

  const requestedAccountId = new URL(request.url).searchParams.get("accountId")?.trim() ?? "";
  if (requestedAccountId && !UUID_PATTERN.test(requestedAccountId)) {
    return noStore({ error: "账号标识无效。" }, 400);
  }

  try {
    const teacherRows = await getOpsState(["teachers"]);
    const teachers = teacherRows.find((row) => row.entity === "teachers");
    if (!teachers) throw new OpsStoreError("老师名册尚未初始化。", "teacher_roster_missing");
    let accounts = await readManagedAccounts(context.session.accountId);
    const materialized = await materializeManagedAccountDirectory(teachers.payload, accounts);
    if (materialized > 0) accounts = await readManagedAccounts(context.session.accountId);
    if (!requestedAccountId) return noStore({ ok: true, accounts });
    const account = accounts.find((candidate) => candidate.account_id === requestedAccountId);
    if (!account) return noStore({ error: "未找到该账号。" }, 404);
    const [authorization, sessions] = await Promise.all([
      readAccountAuthorization(account.account_id, context.session.accountId),
      getAccountSessions({
        actorAccountId: context.session.accountId,
        targetAccountId: account.account_id,
        currentSessionId: context.session.sessionId,
      }),
    ]);
    return noStore({
      ok: true,
      account: {
        ...account,
        authorization,
        permissions: authorization?.permissions ?? [],
        scope_members: authorization?.scope_members ?? [],
        active_session_count: sessions.length,
      },
      sessions,
    });
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({ error: "账号生命周期数据库合同尚未部署。", code: "account_contract_unavailable" }, 501);
    }
    return noStore({ error: "账号目录暂时无法读取，请稍后重试。" }, 503);
  }
}

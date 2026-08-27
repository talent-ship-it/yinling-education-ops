import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  accountIdentityKey,
  accountPasswordCommandSalt,
  hashAccountPassword,
  validateAccountPassword,
} from "@/lib/account-credentials";
import { resolveAccountDirectoryIdentity, sameAccountIdentity } from "@/lib/account-directory";
import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { normaliseDemoIdentity } from "@/lib/demo-session-token";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getAppAccountCredential,
  getOpsState,
  OpsStoreError,
  putAppAccountCredentialAtomic,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const COMMAND_KEY_PATTERN = /^account-credential:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function accountContractUnavailable(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!fullAdmin) return noStore({ error: "仅超级管理员可以重置其他账号密码。" }, 403);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const commandKey = typeof body?.commandKey === "string" ? body.commandKey.trim().toLowerCase() : "";
  if (!COMMAND_KEY_PATTERN.test(commandKey)) return noStore({ error: "密码重置命令无效。" }, 400);

  try {
    const rows = await getOpsState(["teachers"]);
    const teacherRow = rows.find((row) => row.entity === "teachers");
    if (!teacherRow) return noStore({ error: "老师名册尚未初始化。" }, 503);
    const target = resolveAccountDirectoryIdentity(body?.targetUser, body?.targetRole, teacherRow.payload);
    if (!("identity" in target)) return noStore({ error: target.error }, target.status);
    if (sameAccountIdentity(session, target.identity)) {
      return noStore({ error: "请使用“修改密码”更新当前管理员账号。" }, 400);
    }
    const policyError = validateAccountPassword(body?.newPassword, target.identity.user);
    if (policyError) return noStore({ error: policyError, code: "password_policy" }, 400);

    const identityKey = accountIdentityKey(target.identity.user, target.identity.role);
    const existing = await getAppAccountCredential(identityKey);
    if (existing) {
      const credentialMatchesIdentity = existing.identity_key === identityKey
        && existing.account_role === target.identity.role
        && normaliseDemoIdentity(existing.account_name) === normaliseDemoIdentity(target.identity.user);
      if (!credentialMatchesIdentity) return noStore({ error: "账号凭据状态异常，未执行重置。" }, 409);
    }

    const password = await hashAccountPassword(
      body?.newPassword as string,
      accountPasswordCommandSalt(commandKey, identityKey, process.env.OPS_API_SECRET ?? ""),
    );
    const committed = await putAppAccountCredentialAtomic({
      commandKey,
      identityKey,
      accountName: target.identity.user,
      accountRole: target.identity.role,
      ...password,
      expectedVersion: existing?.credential_version ?? 0,
      mustChangePassword: true,
      action: "admin_reset",
      actor: session.user,
    });
    const result = committed[0];
    if (!result || result.identity_key !== identityKey || !result.enabled) {
      throw new OpsStoreError("账号密码重置未返回有效结果。", "invalid_commit_result");
    }
    return noStore({
      ok: true,
      reset: true,
      targetUser: target.identity.user,
      targetRole: target.identity.role,
      mustChangePassword: result.must_change_password,
    });
  } catch (error) {
    if (accountContractUnavailable(error)) {
      return noStore({ error: "账号密码数据库合同尚未部署，当前不会重置密码。", code: "account_contract_unavailable" }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "account_credential_version_conflict")) {
      return noStore({ error: "该账号密码刚刚已更新，请刷新后再试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "该密码重置命令已用于其他内容，请重新提交。", code: "idempotency_conflict" }, 409);
    }
    return noStore({ error: "密码重置暂时失败，请稍后重试。" }, 503);
  }
}

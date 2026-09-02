import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  accountIdentityKey,
  accountPasswordCommandSalt,
  hashAccountPassword,
  validateAccountPassword,
} from "@/lib/account-credentials";
import { encryptAccountIssuedPassword } from "@/lib/account-issued-password";
import {
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { normaliseDemoIdentity } from "@/lib/demo-session-token";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getAccountDirectory,
  getAppAccountCredential,
  OpsStoreError,
  rotateAccountPasswordAtomic,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const COMMAND_KEY_PATTERN = /^account-password:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!fullAdmin) return noStore({ error: "仅超级管理员可以重置其他账号密码。" }, 403);
  if (!session.accountId) return noStore({ error: "账号目录尚未建立，请退出后重新登录。" }, 409);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const commandKey = typeof body?.commandKey === "string" ? body.commandKey.trim().toLowerCase() : "";
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  const expectedCredentialVersion = body?.expectedCredentialVersion;
  if (!COMMAND_KEY_PATTERN.test(commandKey) || !UUID_PATTERN.test(accountId)
      || !Number.isSafeInteger(expectedCredentialVersion)
      || (expectedCredentialVersion as number) < 0) {
    return noStore({ error: "密码重置命令无效。" }, 400);
  }
  if (accountId === session.accountId) return noStore({ error: "请使用“修改密码”更新当前管理员账号。" }, 400);

  try {
    const target = (await getAccountDirectory(session.accountId)).find((account) => account.account_id === accountId);
    if (!target) return noStore({ error: "未找到该账号。" }, 404);
    if (target.super_admin) return noStore({ error: "不能重置其他超级管理员账号。" }, 403);
    const policyError = validateAccountPassword(body?.newPassword, target.account_name);
    if (policyError) return noStore({ error: policyError, code: "password_policy" }, 400);

    const identityKey = accountIdentityKey(target.account_name, target.account_role);
    const existing = await getAppAccountCredential(identityKey);
    if (existing) {
      const credentialMatchesIdentity = existing.identity_key === identityKey
        && existing.account_role === target.account_role
        && normaliseDemoIdentity(existing.account_name) === normaliseDemoIdentity(target.account_name);
      if (!credentialMatchesIdentity) return noStore({ error: "账号凭据状态异常，未执行重置。" }, 409);
    }

    const password = await hashAccountPassword(
      body?.newPassword as string,
      accountPasswordCommandSalt(commandKey, identityKey),
    );
    const issuedPasswordCiphertext = encryptAccountIssuedPassword({
      password: body?.newPassword as string,
      accountId: target.account_id,
      credentialVersion: (expectedCredentialVersion as number) + 1,
      commandKey,
    });
    const result = await rotateAccountPasswordAtomic({
      commandKey,
      accountId: target.account_id,
      ...password,
      expectedCredentialVersion: expectedCredentialVersion as number,
      mustChangePassword: false,
      action: "admin_reset",
      actorAccountId: session.accountId,
      issuedPasswordCiphertext,
    });
    if (!result || result.identity_key !== identityKey || !result.enabled) {
      throw new OpsStoreError("账号密码重置未返回有效结果。", "invalid_commit_result");
    }
    if (!result.currently_active
        || result.current_credential_version !== result.credential_version) {
      return noStore({
        error: "这次密码重置曾成功，但该账号密码后来又被更新；请以最新一次重置为准。",
        code: "password_reset_superseded",
        committed: true,
        reset: false,
        superseded: true,
      }, 409);
    }
    return noStore({
      ok: true,
      reset: true,
      targetUser: target.account_name,
      targetRole: target.account_role,
      mustChangePassword: result.must_change_password,
    });
  } catch (error) {
    if (accountContractUnavailable(error)) {
      return noStore({ error: "账号密码数据库合同尚未部署，当前不会重置密码。", code: "account_contract_unavailable" }, 501);
    }
    if (error instanceof OpsStoreError && error.message === "account_not_active") {
      return noStore({ error: "请先恢复该账号，再重置登录密码。", code: "account_not_active" }, 409);
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

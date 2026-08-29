import { NextResponse } from "next/server";

import { accountIdentityKey, verifyAccountPassword } from "@/lib/account-credentials";
import { decryptAccountIssuedPassword } from "@/lib/account-issued-password";
import { resolveAccountRequestContext } from "@/lib/account-request-context";
import { normaliseDemoIdentity } from "@/lib/demo-session-token";
import {
  getAccountDirectory,
  getAccountIssuedPasswordEscrow,
  getAppAccountCredential,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Cookie",
    },
  });
}

export async function POST(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  if (!context.fullAdmin) return noStore({ error: "仅超级管理员可以查看发放密码。" }, 403);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (!UUID_PATTERN.test(accountId)) return noStore({ error: "账号标识无效。" }, 400);

  try {
    const target = (await getAccountDirectory(context.session.accountId))
      .find((account) => account.account_id === accountId);
    if (!target) return noStore({ error: "未找到该账号。" }, 404);

    const escrow = await getAccountIssuedPasswordEscrow({
      accountId: target.account_id,
      actorAccountId: context.session.accountId,
    });
    if (!escrow || escrow.escrow_state !== "available") {
      return noStore({
        ok: true,
        available: false,
        state: escrow?.escrow_state ?? "not_recorded",
      });
    }
    const credentialVersion = escrow.credential_version;
    if (!escrow.ciphertext
        || typeof credentialVersion !== "number"
        || credentialVersion !== target.credential_version
        || !Number.isSafeInteger(credentialVersion)) {
      return noStore({ ok: true, available: false, state: "stale" });
    }

    const password = decryptAccountIssuedPassword({
      ciphertext: escrow.ciphertext,
      accountId: target.account_id,
      credentialVersion,
    });
    const identityKey = accountIdentityKey(target.account_name, target.account_role);
    const credential = await getAppAccountCredential(identityKey);
    const matches = credential
      && credential.enabled
      && credential.identity_key === identityKey
      && credential.credential_version === credentialVersion
      && credential.account_role === target.account_role
      && normaliseDemoIdentity(credential.account_name) === normaliseDemoIdentity(target.account_name)
      && await verifyAccountPassword(password, credential);
    if (!matches) {
      return noStore({
        error: "当前发放密码已无法通过账号校验，请为该账号重置新密码。",
        code: "issued_password_verification_failed",
      }, 409);
    }

    return noStore({
      ok: true,
      available: true,
      password,
      credentialVersion,
      issuedAt: escrow.issued_at,
    });
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({ error: "账号发放密码数据库合同尚未部署。", code: "account_contract_unavailable" }, 501);
    }
    return noStore({ error: "发放密码暂时无法核对，请稍后重试。" }, 503);
  }
}

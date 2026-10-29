import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createImpersonationToken, IMPERSONATION_COOKIE_NAME, IMPERSONATION_MAX_AGE, resolveImpersonatedSession, revokeImpersonationSession } from "@/lib/account-impersonation";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { createAccountImpersonationSession, getAccountDirectory } from "@/lib/ops-store";
import { createServerSessionToken, type DemoSessionIdentity } from "@/lib/demo-session-token";

export const dynamic = "force-dynamic";

const cookieOptions = { httpOnly: true, path: "/", sameSite: "strict" as const, secure: process.env.NODE_ENV === "production" };
const noStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
type Administrator = { session: DemoSessionIdentity; elevationCookie: string | undefined };

function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin
    && request.headers.get("sec-fetch-site") !== "cross-site";
}

function authorizeAdministrator(session: DemoSessionIdentity, elevationCookie: string | undefined) {
  if (!hasFullAdminAccess(session, elevationCookie)) return { error: "仅超级管理员可以切换账号。", status: 403 } as const;
  return { session, elevationCookie };
}

async function administrator(): Promise<Administrator | { error: string; status: 401 | 403 | 503 }> {
  const store = await cookies();
  const resolved = await getCurrentDemoSession(store.get(DEMO_COOKIE_NAME)?.value, { ignoreImpersonation: true });
  if (!("session" in resolved)) return { error: resolved.error, status: resolved.status };
  const elevationCookie = store.get(NIXON_COOKIE_NAME)?.value;
  return authorizeAdministrator(resolved.session, elevationCookie);
}

export async function GET() {
  const actor = await administrator();
  if (!("session" in actor)) return noStore({ error: actor.error }, actor.status);
  try {
    const accounts = await getAccountDirectory(actor.session.accountId!);
    return noStore({ accounts: accounts.map((account) => ({
      id: account.account_id, user: account.account_name, role: account.account_role,
      status: account.status, isOriginal: account.account_id === actor.session.accountId,
    })) });
  } catch {
    return noStore({ error: "账号列表暂时无法读取，请稍后重试。" }, 503);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return noStore({ error: "请从当前网站切换账号。" }, 403);
  const actor = await administrator();
  if (!("session" in actor)) return noStore({ error: actor.error }, actor.status);
  try {
    return await switchIdentityForActor(actor, await request.json().catch(() => null), request);
  } catch {
    return noStore({ error: "切换账号失败，请稍后重试。" }, 503);
  }
}

function targetAccountId(body: { accountId?: unknown } | null) {
  const value = body?.accountId;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
}

async function switchIdentityForActor(actor: Administrator, body: { accountId?: unknown } | null, request: Request) {
  const targetId = targetAccountId(body);
  if (!targetId) return noStore({ error: "账号标识无效。" }, 400);
  if (targetId === actor.session.accountId) return clearIdentity();
  const target = await activeTarget(actor.session.accountId!, targetId);
  if (!target) return noStore({ error: "目标账号未启用，无法切换。" }, 403);
  return startIdentitySession(actor, target, request);
}

async function activeTarget(actorId: string, targetId: string) {
  return (await getAccountDirectory(actorId)).find((account) => account.account_id === targetId && account.status === "active");
}

async function startIdentitySession(actor: Administrator, target: Awaited<ReturnType<typeof getAccountDirectory>>[number], request: Request) {
  const targetSession = createServerSessionToken();
  if (!targetSession) return noStore({ error: "身份切换暂时不可用。" }, 503);
  const token = createImpersonationToken({
    actorAccountId: actor.session.accountId!, actorSessionId: actor.session.sessionId!,
    targetAccountId: target.account_id, identityKey: target.identity_key,
    targetSessionToken: targetSession.token,
  });
  if (!token) return noStore({ error: "身份切换暂时不可用。" }, 503);
  return createIdentitySession(actor, target, { ...targetSession, claim: token }, request);
}

async function createIdentitySession(actor: Administrator, target: Awaited<ReturnType<typeof getAccountDirectory>>[number], token: NonNullable<ReturnType<typeof createServerSessionToken>> & { claim: string }, request: Request) {
  const created = await createAccountImpersonationSession({
    actorAccountId: actor.session.accountId!, actorSessionId: actor.session.sessionId!,
    targetAccountId: target.account_id, sessionId: token.sessionId, tokenHash: token.tokenHash,
    ...identitySessionOptions(target, request),
  });
  if (created?.session_id !== token.sessionId || created.account_id !== target.account_id) {
    return noStore({ error: "目标账号状态刚刚已变化，请重新选择。" }, 409);
  }
  return finishIdentitySession(actor, token.claim);
}

function identitySessionOptions(target: Awaited<ReturnType<typeof getAccountDirectory>>[number], request: Request) {
  return {
    expectedCredentialVersion: target.credential_version ?? 0,
    expectedAccessVersion: target.access_version,
    userAgent: request.headers.get("user-agent")?.slice(0, 480) ?? null,
  };
}

async function finishIdentitySession(actor: Administrator, token: string) {
  const resolved = await resolveImpersonatedSession({ actor: actor.session, token, elevationCookie: actor.elevationCookie });
  if (!("session" in resolved)) {
    await revokeImpersonationSession(token).catch(() => null);
    return noStore({ error: resolved.error }, resolved.status);
  }
  const store = await cookies();
  await revokeImpersonationSession(store.get(IMPERSONATION_COOKIE_NAME)?.value).catch(() => null);
  const response = noStore({ ok: true, user: resolved.session.user, role: resolved.session.role });
  response.cookies.set(IMPERSONATION_COOKIE_NAME, token, { ...cookieOptions, maxAge: IMPERSONATION_MAX_AGE });
  return response;
}

async function clearIdentity() {
  const store = await cookies();
  await revokeImpersonationSession(store.get(IMPERSONATION_COOKIE_NAME)?.value).catch(() => null);
  const response = noStore({ ok: true });
  response.cookies.set(IMPERSONATION_COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  return response;
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return noStore({ error: "请从当前网站返回管理员。" }, 403);
  // Clearing an effective identity only restores the separately validated original session.
  return clearIdentity();
}

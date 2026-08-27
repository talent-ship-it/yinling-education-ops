import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME } from "@/lib/demo-auth";
import { parseServerSessionToken, SERVER_SESSION_MAX_AGE_SECONDS } from "@/lib/demo-session-token";
import { NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { revokeCurrentAccountSession } from "@/lib/ops-store";

export const dynamic = "force-dynamic";
const LOGOUT_RETRY_COOKIE_NAME = "yinling_logout_retry";
const LOGOUT_RETRY_LIST_PREFIX = "v1~";

const expiredCookie = {
  httpOnly: true,
  maxAge: 0,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};
const retryCookie = {
  httpOnly: true,
  maxAge: SERVER_SESSION_MAX_AGE_SECONDS,
  path: "/api/demo-logout",
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
};

function retryTokens(value: string | undefined) {
  if (!value) return [];
  const candidates = parseServerSessionToken(value)
    ? [value]
    : value.startsWith(LOGOUT_RETRY_LIST_PREFIX)
      ? value.slice(LOGOUT_RETRY_LIST_PREFIX.length).split("~")
      : [];
  return [...new Set(candidates.filter((candidate) => parseServerSessionToken(candidate) !== null))];
}

function serialiseRetryTokens(tokens: readonly string[]) {
  const unique = [...new Set(tokens)];
  if (unique.length === 1) return unique[0];
  return `${LOGOUT_RETRY_LIST_PREFIX}${unique.join("~")}`;
}

async function revokeServerSession(cookieValue: string) {
  const envelope = parseServerSessionToken(cookieValue);
  if (!envelope) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Logout is authorized by possession of the opaque token itself. It
      // must not depend on roster, role, status, or access validation that can
      // reject a still-live ledger session before revocation.
      const revoked = await revokeCurrentAccountSession({
        sessionId: envelope.sessionId,
        tokenHash: envelope.tokenHash,
      });
      if (revoked !== null) return true;
    } catch {
      // Retry once, then preserve this exact token for a later logout retry.
    }
  }
  return false;
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const retryRequested = request.headers.get("x-yinling-logout-retry") === "1";
  const primaryCookieValue = cookieStore.get(DEMO_COOKIE_NAME)?.value;
  const storedRetryCookieValue = cookieStore.get(LOGOUT_RETRY_COOKIE_NAME)?.value;
  const pendingRetryTokens = retryTokens(storedRetryCookieValue);
  const candidateTokens = [...new Set(retryRequested
    ? pendingRetryTokens
    : [...retryTokens(primaryCookieValue), ...pendingRetryTokens])];
  const revocationResults = await Promise.all(candidateTokens.map((token) => revokeServerSession(token)));
  const unresolvedTokens = candidateTokens.filter((_, index) => !revocationResults[index]);
  const serverSessionRevoked = unresolvedTokens.length === 0;
  const response = NextResponse.json({
    ok: serverSessionRevoked,
    localLogout: true,
    serverSessionRevoked,
    ...(serverSessionRevoked ? {} : { error: "本机已退出；服务器会话撤销尚未确认，系统将继续重试。" }),
  }, {
    status: serverSessionRevoked ? 200 : 503,
    headers: { "Cache-Control": "private, no-store" },
  });
  if (!retryRequested) {
    response.cookies.set(DEMO_COOKIE_NAME, "", expiredCookie);
    response.cookies.set(NIXON_COOKIE_NAME, "", expiredCookie);
  }
  if (serverSessionRevoked) {
    response.cookies.set(LOGOUT_RETRY_COOKIE_NAME, "", { ...retryCookie, maxAge: 0 });
  } else {
    response.cookies.set(LOGOUT_RETRY_COOKIE_NAME, serialiseRetryTokens(unresolvedTokens), retryCookie);
  }
  return response;
}

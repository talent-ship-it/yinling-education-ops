import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { projectOperationalAuditEntry } from "@/lib/operational-audit";
import { getOperationalAudit } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  const limitedAdmin = session.user === DEMO_LIMITED_ADMIN_USER && session.role === "limited-admin";
  if ((!fullAdmin && !limitedAdmin)
      || !hasDemoSessionPermission(session, "operations.read")
      || !hasUnrestrictedDemoSessionScope(session)) {
    return noStore({ error: "当前账号没有读取操作审计的权限。" }, 403);
  }

  try {
    const entries = (await getOperationalAudit()).map(projectOperationalAuditEntry);
    return noStore({ entries });
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : "操作审计读取失败。" }, 503);
  }
}

/** Client-authored action/detail/tone values are never accepted as audit evidence. */
export async function POST() {
  return noStore({ error: "操作审计只能由服务器业务事务生成。" }, 410);
}

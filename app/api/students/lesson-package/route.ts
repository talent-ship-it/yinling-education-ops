import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState, putOpsState, OpsStoreError } from "@/lib/ops-store";
import { OpsStateTransitionError } from "@/lib/ops-state-transition";
import { LessonPackageCommandError, parseLessonPackagePurchaseCommand } from "@/lib/lesson-package-purchase-command";
import { commitLessonPackagePurchase } from "@/lib/lesson-package-purchase-service";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return reply({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  try {
    const command = parseLessonPackagePurchaseCommand(await request.json().catch(() => null));
    const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
    return reply(await commitLessonPackagePurchase({ command, actor: session.user, fullAdmin, identity: session, store: { read: getOpsState, write: putOpsState } }));
  } catch (error) {
    if (error instanceof LessonPackageCommandError) return reply({ error: error.message, code: error.code, rejectedBeforeCommit: ["invalid_command", "invalid_target", "source_owned_package"].includes(error.code) }, error.code === "scope_forbidden" ? 403 : error.code === "idempotency_conflict" ? 409 : 400);
    if (error instanceof OpsStateTransitionError) return reply({ error: error.message, rejectedBeforeCommit: true }, error.status);
    if (error instanceof OpsStoreError && error.code === "40001") return reply({ error: "资料刚刚更新，请重试同一笔购买", code: "version_conflict" }, 409);
    return reply({ error: "尚未确认购买结果，请重试同一笔购买，不要重复录入" }, 503);
  }
}

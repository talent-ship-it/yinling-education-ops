import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canAccessStudent, canReadOpsEntity } from "@/lib/ops-access";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getJiaowubaoDirectStudentHistory, getOpsState, OpsStoreError } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function missingReader(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

/**
 * Attached-only supplementary history for one already-authorized Tencent
 * student. It is source history, never a lesson package or editable booking.
 */
export async function GET(_request: Request, context: { params: Promise<{ studentId: string }> }) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);

  const { studentId } = await context.params;
  if (!studentId || studentId !== studentId.trim() || studentId.length > 240) {
    return noStore({ error: "学生 ID 无效。" }, 400);
  }

  const { session } = resolved;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
    if (!canReadOpsEntity(access, "students") || !canReadOpsEntity(access, "bookings")) {
      return noStore({ error: "当前账号不能查看教务宝学生历史。" }, 403);
    }
    if (!canAccessStudent(access, studentId)) return noStore({ error: "未找到该学生档案。" }, 404);
    return noStore(await getJiaowubaoDirectStudentHistory(studentId));
  } catch (error) {
    if (missingReader(error)) {
      return noStore({ error: "教务宝只读资料数据库合同尚未部署。", code: "jiaowubao_direct_reader_unavailable" }, 501);
    }
    return noStore({ error: "教务宝补充资料读取失败。" }, 503);
  }
}

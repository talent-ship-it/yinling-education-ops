import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsEntity, filterOpsStateRows } from "@/lib/ops-access";
import { getOpsState, OpsStoreError, refreshTeacherDepartureCandidatesAtomic } from "@/lib/ops-store";

export const dynamic = "force-dynamic";
const entities = ["bookings", "operations", "students", "teachers"] as const;
function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Explicit refresh updates only the verified recommendation list, never lessons. */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if ("error" in resolved) return response({ error: resolved.error }, resolved.status);
  const session = resolved.session;
  if (session.role === "teacher") return response({ error: "老师账号不能更新离职候选。" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["operationId", "expectedVersions"].includes(key))
    || typeof body.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(body.operationId)
    || !body.expectedVersions || typeof body.expectedVersions !== "object" || Array.isArray(body.expectedVersions)
    || Object.keys(body.expectedVersions).length !== entities.length
    || entities.some((entity) => !Number.isSafeInteger(body.expectedVersions[entity]) || body.expectedVersions[entity] < 1)) {
    return response({ error: "刷新请求无效。" }, 400);
  }
  try {
    const rows = await getOpsState([...entities]);
    const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
    const operation = (rows.find((row) => row.entity === "operations")?.payload as Record<string, unknown>[] | undefined)?.find((entry) => entry.id === body.operationId);
    if (!operation || typeof operation.studentId !== "string" || !canOperateStudent(access, operation.studentId)
      || !canWriteOpsEntity(access, "operations")) return response({ error: "当前账号不能更新此离职记录。" }, 403);
    const [operationRow] = await refreshTeacherDepartureCandidatesAtomic({ operationId: body.operationId, expectedVersions: body.expectedVersions, actor: session.user });
    if (!operationRow) return response({ error: "刷新结果缺失，请重新读取记录。" }, 503);
    return response({ operationRow: filterOpsStateRows([operationRow], access)[0] });
  } catch (error) {
    if (error instanceof OpsStoreError && error.code === "40001") return response({ error: "资料已更新，请刷新页面后重新匹配。" }, 409);
    return response({ error: "候选老师检查失败，请稍后重试。" }, 503);
  }
}

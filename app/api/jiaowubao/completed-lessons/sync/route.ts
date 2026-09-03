import { NextRequest, NextResponse } from "next/server";

import { normalizeCompletedLessonFacts } from "@/lib/jiaowubao/completed-lesson-facts";
import { fetchCompletedLessonsForMembers, JiaowubaoLessonApiError } from "@/lib/jiaowubao/lesson-client";
import { completedMonthlyPeriod } from "@/lib/jiaowubao/monthly-payroll";
import { hasMonthlyPayrollDashboardAccess } from "@/lib/jiaowubao/monthly-payroll-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  if (!(await hasMonthlyPayrollDashboardAccess())) return response({ error: "请先输入访问密码。" }, 401);
  const body = await request.json().catch(() => null);
  const period = body && typeof body === "object" && typeof body.period === "string" ? body.period : "";
  const ids = body && typeof body === "object" && Array.isArray((body as { memberIds?: unknown }).memberIds) ? (body as { memberIds: unknown[] }).memberIds : [];
  const memberIds = [...new Set(ids.filter((id): id is string => typeof id === "string").map((id) => id.trim().replace(/^0+(?=\d)/, "")).filter((id) => /^\d+$/.test(id) && !/^0+$/.test(id)))];
  if (!memberIds.length || memberIds.length > 100) return response({ error: "请提供 1 至 100 个已确认的教务宝学员 ID。" }, 400);
  try {
    const completedPeriod = completedMonthlyPeriod(period);
    const result = await fetchCompletedLessonsForMembers(completedPeriod, memberIds);
    return response({ period: completedPeriod, pages: result.pages, requestedMemberIds: memberIds, ...normalizeCompletedLessonFacts(result.lessons) });
  } catch (error) {
    if (error instanceof JiaowubaoLessonApiError) return response({ error: error.message }, error.code === "configuration" ? 422 : 502);
    if (error instanceof Error) return response({ error: error.message }, 400);
    return response({ error: "教务宝已结课事实同步失败，请稍后重试。" }, 502);
  }
}

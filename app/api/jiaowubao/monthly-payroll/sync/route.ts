import { NextRequest, NextResponse } from "next/server";

import { JiaowubaoLessonApiError } from "@/lib/jiaowubao/lesson-client";
import { hasMonthlyPayrollDashboardAccess } from "@/lib/jiaowubao/monthly-payroll-auth";
import { createMonthlyPayrollSnapshot, MonthlyPayrollSnapshotError } from "@/lib/jiaowubao/monthly-payroll-snapshot";
import { generateMonthlyPayroll, publicSyncSummary } from "@/lib/payroll/monthly-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}
function safeError(error: unknown) {
  if (error instanceof JiaowubaoLessonApiError) return { message: error.message, status: error.code === "configuration" ? 422 : 502 };
  if (error instanceof MonthlyPayrollSnapshotError) return { message: error.message, status: 422 };
  if (error instanceof Error && error.message.includes("月份")) return { message: error.message, status: 400 };
  return { message: "教务宝课时同步失败，请检查接口配置或稍后重试。", status: 502 };
}

export async function POST(request: NextRequest) {
  if (!(await hasMonthlyPayrollDashboardAccess())) return noStore({ error: "请先输入访问密码。" }, 401);

  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || ("period" in body && typeof body.period !== "string")) {
    return noStore({ error: "月份参数必须采用 YYYY-MM 格式。" }, 400);
  }

  try {
    const sync = await generateMonthlyPayroll(body.period);
    // The signed, short-lived report travels back only to the same authorized
    // browser. Export verifies it and writes this exact reviewed source, so a
    // JWB correction between the two buttons cannot change the workbook.
    const snapshot = createMonthlyPayrollSnapshot(sync.report);
    return noStore({
      ...publicSyncSummary(sync),
      snapshot,
      persistence: { saved: false, message: "本次结果仅用于当前浏览器核对，未覆盖原有共享薪资记录；请下载完整版留档。" },
    });
  } catch (error) {
    const result = safeError(error);
    return noStore({ error: result.message }, result.status);
  }
}

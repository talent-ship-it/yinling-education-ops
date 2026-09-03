import { NextRequest, NextResponse } from "next/server";

import { JiaowubaoLessonApiError } from "@/lib/jiaowubao/lesson-client";
import { hasMonthlyPayrollCronAccess } from "@/lib/jiaowubao/monthly-payroll-auth";
import { generateMonthlyPayroll } from "@/lib/payroll/monthly-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}
export async function POST(request: NextRequest) {
  if (!hasMonthlyPayrollCronAccess(request)) return response({ error: "未授权的自动任务请求。" }, 401);

  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || ("period" in body && typeof body.period !== "string")) {
    return response({ error: "月份参数必须采用 YYYY-MM 格式。" }, 400);
  }

  try {
    const sync = await generateMonthlyPayroll(body.period);
    return response({
      period: sync.report.period.value,
      generatedAt: sync.report.generatedAt,
      pages: sync.pages,
      summary: sync.report.summary,
      warnings: sync.report.warnings,
      workbook: "本端点只做受保护的连通性/摘要检查，不写入共享薪资；完整表请通过 /api/jiaowubao/monthly-payroll/export 下载。",
    });
  } catch (error) {
    if (error instanceof JiaowubaoLessonApiError) {
      return response({ error: error.message }, error.code === "configuration" ? 422 : 502);
    }
    if (error instanceof Error && error.message.includes("月份")) return response({ error: error.message }, 400);
    return response({ error: "月度课时表自动生成失败。" }, 503);
  }
}

import { NextRequest, NextResponse } from "next/server";

import { JiaowubaoLessonApiError } from "@/lib/jiaowubao/lesson-client";
import { hasMonthlyPayrollCronAccess, hasMonthlyPayrollDashboardAccess } from "@/lib/jiaowubao/monthly-payroll-auth";
import { MonthlyPayrollSnapshotError, readMonthlyPayrollSnapshot } from "@/lib/jiaowubao/monthly-payroll-snapshot";
import type { MonthlyPayrollReport } from "@/lib/jiaowubao/monthly-payroll";
import { generateMonthlyPayroll } from "@/lib/payroll/monthly-service";
import { createMonthlyPayrollWorkbook, monthlyPayrollFilename } from "@/lib/payroll/monthly-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function exportError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function workbookResponse(report: MonthlyPayrollReport) {
  const workbook = await createMonthlyPayrollWorkbook(report);
  const filename = monthlyPayrollFilename(report.period.value);
  return new NextResponse(new Uint8Array(workbook), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}

function responseForExportError(error: unknown) {
  if (error instanceof JiaowubaoLessonApiError) return exportError(error.message, error.code === "configuration" ? 422 : 502);
  if (error instanceof MonthlyPayrollSnapshotError) return exportError(error.message, 409);
  if (error instanceof Error && error.message.includes("月份")) return exportError(error.message, 400);
  return exportError("完整课时表生成失败，请检查教务宝接口配置后重试。", 502);
}

export async function GET(request: NextRequest) {
  // Fresh exports can issue 100+ rate-limited upstream requests. Browser
  // users download only their just-reviewed POST snapshot; limiting GET to
  // the long Bearer secret prevents a cross-site navigation from draining
  // the institution-wide gateway quota.
  if (!hasMonthlyPayrollCronAccess(request)) return exportError("需要受保护的自动任务凭据。", 401);
  try {
    const sync = await generateMonthlyPayroll(request.nextUrl.searchParams.get("period") || undefined);
    return workbookResponse(sync.report);
  } catch (error) {
    return responseForExportError(error);
  }
}

export async function POST(request: NextRequest) {
  if (!(await hasMonthlyPayrollDashboardAccess())) return exportError("请先输入访问密码。", 401);

  try {
    const body = await request.json().catch(() => null);
    const snapshot = body && typeof body === "object" && "snapshot" in body
      ? (body as { snapshot?: unknown }).snapshot
      : undefined;
    return workbookResponse(readMonthlyPayrollSnapshot(snapshot));
  } catch (error) {
    return responseForExportError(error);
  }
}

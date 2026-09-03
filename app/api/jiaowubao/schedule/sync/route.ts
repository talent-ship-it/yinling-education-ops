import { NextRequest, NextResponse } from "next/server";

import {
  fetchJiaowubaoSchedule,
  JiaowubaoScheduleApiError,
  type JiaowubaoScheduleQuery,
} from "@/lib/jiaowubao/schedule-client";
import { hasMonthlyPayrollDashboardAccess } from "@/lib/jiaowubao/monthly-payroll-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function requiredDate(body: Record<string, unknown>, key: "start" | "end") {
  const value = body[key];
  if (typeof value !== "string") {
    throw new JiaowubaoScheduleApiError(key + " 参数必须采用 YYYY-MM-DD 格式。", "configuration");
  }
  return value;
}

function optionalOver(body: Record<string, unknown>) {
  if (!("over" in body)) return undefined;
  const value = body.over;
  if (value !== 0 && value !== 1) {
    throw new JiaowubaoScheduleApiError("over 参数只能是 0 或 1。", "configuration");
  }
  return value;
}

export async function POST(request: NextRequest) {
  if (!(await hasMonthlyPayrollDashboardAccess())) {
    return noStore({ error: "请先输入访问密码。" }, 401);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return noStore({ error: "排课查询参数格式不正确。" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["start", "end", "over"].includes(key))) {
      throw new JiaowubaoScheduleApiError("排课核对只接受 start、end 和可选 over 参数。", "configuration");
    }
    const query: JiaowubaoScheduleQuery = {
      start: requiredDate(input, "start"),
      end: requiredDate(input, "end"),
      over: optionalOver(input),
    };
    const result = await fetchJiaowubaoSchedule(query);
    return noStore({
      ...result,
      source: "query_schedule_list",
      persistence: {
        saved: false,
        message: "排课核对结果只保留在当前浏览器，未写入共享排课、学生、老师或薪资资料。",
      },
    });
  } catch (error) {
    if (error instanceof JiaowubaoScheduleApiError) {
      return noStore({ error: error.message }, error.code === "configuration" ? 422 : 502);
    }
    return noStore({ error: "教务宝排课查询失败，请检查接口配置或稍后重试。" }, 502);
  }
}

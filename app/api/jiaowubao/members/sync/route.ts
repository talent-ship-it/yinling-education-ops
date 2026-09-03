import { NextRequest, NextResponse } from "next/server";

import {
  fetchJiaowubaoMembers,
  JiaowubaoMemberApiError,
  type JiaowubaoMemberQuery,
} from "@/lib/jiaowubao/member-client";
import { hasMonthlyPayrollDashboardAccess } from "@/lib/jiaowubao/monthly-payroll-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function optionalIdFilter(body: Record<string, unknown>, key: "teacherId" | "teamId") {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new JiaowubaoMemberApiError(key + " 参数格式不正确。", "configuration");
  }
  return value;
}

function optionalKeyword(body: Record<string, unknown>) {
  if (!("keyword" in body)) return undefined;
  const value = body.keyword;
  if (typeof value !== "string") {
    throw new JiaowubaoMemberApiError("keyword 参数格式不正确。", "configuration");
  }
  return value;
}

export async function POST(request: NextRequest) {
  if (!(await hasMonthlyPayrollDashboardAccess())) {
    return noStore({ error: "请先输入访问密码。" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return noStore({ error: "学员同步参数格式不正确。" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const query: JiaowubaoMemberQuery = {
      teacherId: optionalIdFilter(input, "teacherId"),
      teamId: optionalIdFilter(input, "teamId"),
      keyword: optionalKeyword(input),
    };
    // A browser request is deliberately bounded. Operators refine the supplied
    // documented filters instead of turning this endpoint into a full roster
    // export that could exceed a hosted request timeout.
    const result = await fetchJiaowubaoMembers(query, { maxPages: 2 });
    return noStore({
      ...result,
      persistence: {
        saved: false,
        message: "学员目录仅用于当前浏览器的只读核对，未写入共享学生资料。",
      },
    });
  } catch (error) {
    if (error instanceof JiaowubaoMemberApiError) {
      return noStore({ error: error.message }, error.code === "configuration" ? 422 : 502);
    }
    return noStore({ error: "教务宝学员目录同步失败，请检查接口配置或稍后重试。" }, 502);
  }
}

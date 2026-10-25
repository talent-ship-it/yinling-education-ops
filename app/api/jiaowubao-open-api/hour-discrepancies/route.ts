import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getMonthlyHourDiscrepancyReport, MonthlyHourDiscrepancyError } from "@/lib/jiaowubao-monthly-hour-discrepancies-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function selectedOwner(url: URL) {
  const owner = url.searchParams.get("owner") ?? undefined;
  if (owner && (owner.length > 120 || /[\u0000-\u001f\u007f]/u.test(owner))) {
    throw new MonthlyHourDiscrepancyError("invalid_owner", 400, "教务筛选无效。");
  }
  return owner;
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return response({ error: resolved.error }, resolved.status);
  if (resolved.session.role === "teacher") return response({ error: "老师账号不能查看月度课时核查。" }, 403);
  const url = new URL(request.url);
  try {
    return response(await getMonthlyHourDiscrepancyReport({
      month: url.searchParams.get("month") ?? undefined,
      owner: selectedOwner(url),
      session: resolved.session,
      fullAdmin: hasFullAdminAccess(resolved.session, cookieStore.get(NIXON_COOKIE_NAME)?.value),
    }));
  } catch (error) {
    if (error instanceof MonthlyHourDiscrepancyError) return response({ error: error.message, code: error.code }, error.status);
    return response({ error: "暂时无法读取月度课时记录，请稍后重试。" }, 503);
  }
}

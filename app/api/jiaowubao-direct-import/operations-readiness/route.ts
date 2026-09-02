import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canReadOpsEntity } from "@/lib/ops-access";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getJiaowubaoDirectOperationsReadiness,
  getOpsState,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_READINESS_WINDOW_MS = 63 * 24 * 60 * 60 * 1_000;
const READINESS_SCHEDULE_LIMIT = 120;
const READINESS_LEAVE_MAKEUP_LIMIT = 120;
const READINESS_RENEWAL_LIMIT = 160;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function readInstant(value: string | null, field: string) {
  if (!value || !CANONICAL_UTC_INSTANT.test(value)) return { error: `${field} 必须使用 UTC ISO 时间。` } as const;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return { error: `${field} 无效。` } as const;
  }
  return { value: parsed.toISOString() } as const;
}

function missingReader(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

/**
 * Admin-only read surface for reviewing imported Jiaowubao evidence before a
 * human makes a separate, explicit operational decision. It accepts no task,
 * booking, package, student, teacher, or source-row command from the browser.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const windowStart = readInstant(url.searchParams.get("windowStart"), "windowStart");
  const windowEnd = readInstant(url.searchParams.get("windowEnd"), "windowEnd");
  if ("error" in windowStart) return noStore({ error: windowStart.error }, 400);
  if ("error" in windowEnd) return noStore({ error: windowEnd.error }, 400);
  if (new Date(windowEnd.value).getTime() <= new Date(windowStart.value).getTime()) {
    return noStore({ error: "windowEnd 必须晚于 windowStart。" }, 400);
  }
  if (new Date(windowEnd.value).getTime() - new Date(windowStart.value).getTime() > MAX_READINESS_WINDOW_MS) {
    return noStore({ error: "教务宝运营准备度最多读取 63 天。" }, 400);
  }

  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);

  const { session } = resolved;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
    if ((!access.fullAdmin && !access.limitedAdmin)
        || access.restrictedStudentScope
        || !["bookings", "students", "teachers"].every((entity) => canReadOpsEntity(access, entity))) {
      return noStore({ error: "只有管理员可以查看教务宝运营准备度。" }, 403);
    }

    return noStore(await getJiaowubaoDirectOperationsReadiness({
      windowStart: windowStart.value,
      windowEnd: windowEnd.value,
      scheduleLimit: READINESS_SCHEDULE_LIMIT,
      leaveMakeupLimit: READINESS_LEAVE_MAKEUP_LIMIT,
      renewalLimit: READINESS_RENEWAL_LIMIT,
    }));
  } catch (error) {
    if (missingReader(error)) {
      return noStore({
        error: "教务宝运营准备度数据库合同尚未部署。",
        code: "jiaowubao_direct_operations_readiness_unavailable",
      }, 501);
    }
    return noStore({ error: "教务宝运营准备度读取失败。" }, 503);
  }
}

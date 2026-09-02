import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getOpsState,
  getTeacherAvailabilityCompletionPendingTeacherIds,
  OpsStoreError,
} from "@/lib/ops-store";
import {
  buildTeacherAvailabilityCompletionInbox,
  MAX_COMPLETION_PENDING_TEACHERS,
  TeacherAvailabilityCompletionServiceError,
} from "@/lib/teacher-availability-completion-service";
import { hasTeacherAvailabilityReviewAdminAccess } from "@/lib/teacher-availability-review-service";

export const dynamic = "force-dynamic";

const MELBOURNE_TIMEZONE = "Australia/Melbourne";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function currentMonthInMelbourne(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("无法确认当前 AVA 月份。");
  return `${year}-${month}`;
}

function missingReader(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

/**
 * This deliberately has no request parameters and no write method. The server
 * fixes the reviewed month to the current Melbourne calendar month; a browser
 * cannot turn it into a teacher, AVA, schedule, or notification command.
 */
export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);

  const { session } = resolved;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasTeacherAvailabilityReviewAdminAccess(session.user, fullAdmin)
      || !hasDemoSessionPermission(session, "operations.read")
      || !hasUnrestrictedDemoSessionScope(session)) {
    return noStore({ error: "只有管理员可以查看老师 AVA 完整度。" }, 403);
  }

  try {
    const month = currentMonthInMelbourne();
    const [rows, pendingTeacherRows] = await Promise.all([
      getOpsState(["teachers"]),
      getTeacherAvailabilityCompletionPendingTeacherIds({
        month,
        limit: MAX_COMPLETION_PENDING_TEACHERS,
      }),
    ]);
    return noStore(buildTeacherAvailabilityCompletionInbox({
      month,
      teachersRow: rows.find((row) => row.entity === "teachers"),
      pendingTeacherRows,
    }));
  } catch (error) {
    if (missingReader(error)) {
      return noStore({
        error: "老师 AVA 完整度数据库读取合同尚未部署。",
        code: "teacher_availability_completion_contract_unavailable",
      }, 501);
    }
    if (error instanceof TeacherAvailabilityCompletionServiceError) {
      return noStore({ error: error.message, code: error.code }, 503);
    }
    return noStore({
      error: "老师 AVA 完整度暂时无法读取。",
    }, 503);
  }
}

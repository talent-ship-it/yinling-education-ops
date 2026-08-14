import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  bookingCapacityCommandIntent,
  bookingCapacityCommandKey,
  BookingCapacityServiceError,
  parseBookingCapacityCommand,
  prepareBookingCapacityMutation,
} from "@/lib/booking-capacity-service";
import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  BOOKING_CAPACITY_ATOMIC_MUTATION_RPC,
  getBookingCapacityCommandResult,
  getOpsState,
  mutateBookingCapacityAtomic,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function serviceError(error: BookingCapacityServiceError) {
  if (["teacher_forbidden", "student_scope_forbidden", "assignment_change_forbidden"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (["booking_not_found", "student_not_found", "teacher_not_found"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if (error.code === "stale_expected_version") {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (["schedule_conflict", "package_balance_insufficient", "teacher_capacity_unconfigured", "teacher_capacity_exhausted", "teacher_unavailable", "teacher_not_accepting", "past_booking"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  return noStore({ error: error.message, code: error.code }, 400);
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseBookingCapacityCommand(await request.json().catch(() => null));
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
    const visibleRows = filterOpsStateRows(rows, access);
    const visibleBookings = visibleRows.find((row) => row.entity === "bookings");
    const existing = Array.isArray(visibleBookings?.payload)
      ? visibleBookings.payload.find((value) => value && typeof value === "object" && !Array.isArray(value) && (value as { id?: unknown }).id === command.bookingId) as { studentId?: unknown } | undefined
      : undefined;
    const existingStudentId = typeof existing?.studentId === "string" ? existing.studentId : "";
    const studentId = command.booking?.studentId ?? existingStudentId;
    const studentAllowed = Boolean(studentId && canOperateStudent(access, studentId)
      && (!existingStudentId || canOperateStudent(access, existingStudentId)));
    if (!studentAllowed || (session.role === "teacher" && command.action === "delete")) {
      return noStore({ error: "当前账号不能修改这条排课。", code: "student_scope_forbidden" }, 403);
    }
    const commandKey = bookingCapacityCommandKey(command);
    const commandIntent = bookingCapacityCommandIntent(command);
    const replay = await getBookingCapacityCommandResult({ commandKey, commandIntent, actor });
    if (replay[0]) {
      const currentBookingRow = visibleRows.find((row) => row.entity === "bookings");
      const currentTeacherRow = visibleRows.find((row) => row.entity === "teachers");
      if (!currentBookingRow || !currentTeacherRow) throw new OpsStoreError("排课重放结果不可见。", "invalid_commit_result");
      return noStore({
        committed: true,
        action: replay[0].action,
        applied: false,
        bookingId: replay[0].booking_id,
        commandKey: replay[0].command_key,
        bookingRow: currentBookingRow,
        teacherRow: currentTeacherRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }
    const prepared = prepareBookingCapacityMutation({ command, rows, actor, role: session.role, fullAdmin });
    const saved = await mutateBookingCapacityAtomic({ ...prepared, actor });
    if (!saved[0]) throw new OpsStoreError("排课事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "bookings"
      ? saved[0].bookings_row
      : row.entity === "teachers" ? saved[0].teachers_row : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session.role);
    const committedVisible = filterOpsStateRows(committedRows, committedAccess);
    return noStore({
      committed: true,
      action: saved[0].action,
      applied: saved[0].applied,
      bookingId: saved[0].booking_id,
      commandKey: saved[0].command_key,
      bookingRow: committedVisible.find((row) => row.entity === "bookings"),
      teacherRow: committedVisible.find((row) => row.entity === "teachers"),
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "排课与老师容量数据库合同尚未部署，当前不能写入。",
        code: "booking_capacity_contract_unavailable",
        requiredRpc: BOOKING_CAPACITY_ATOMIC_MUTATION_RPC,
      }, 501);
    }
    if (error instanceof BookingCapacityServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "排课、学生或老师资料刚刚发生变化，请刷新后重试。", code: "booking_capacity_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个排课命令已使用不同内容提交，请刷新后重试。", code: "booking_capacity_idempotency_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "排课保存失败。" }, 503);
  }
}

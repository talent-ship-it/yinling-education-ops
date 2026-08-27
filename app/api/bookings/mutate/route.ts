import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  bookingCapacityCommandIntent,
  bookingCapacityCommandKey,
  bookingCapacityTeacherReplayAllowed,
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
  if (["teacher_forbidden", "student_scope_forbidden", "assignment_change_forbidden", "classroom_scope_forbidden"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (["booking_not_found", "occurrence_not_found", "classroom_occurrence_not_found", "student_not_found", "teacher_not_found"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if (error.code === "stale_expected_version") {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (["schedule_conflict", "package_balance_insufficient", "teacher_capacity_unconfigured", "teacher_capacity_exhausted", "teacher_unavailable", "teacher_not_accepting", "past_booking", "classroom_status_regression", "classroom_unavailable"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  if (error.code === "classroom_meeting_id_mismatch") {
    return noStore({ error: error.message, code: error.code }, 400);
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
    const commandKey = bookingCapacityCommandKey(command);
    const commandIntent = bookingCapacityCommandIntent(command);

    // Classroom state is deliberately not part of the staff booking surface.
    // Keep this check before replay so a staff session cannot recover an older
    // classroom command that was authored under a different role.
    if (command.action === "bind_classroom" && session.role === "staff") {
      return noStore({ error: "教务账号不能绑定在线教室。", code: "classroom_scope_forbidden" }, 403);
    }

    // Replay is deliberately resolved before reading a browser-era snapshot.
    // A lost delete response cannot rediscover the removed booking, whereas the
    // actor-bound ledger retains both student identities and all committed rows.
    const replay = await getBookingCapacityCommandResult({ commandKey, commandIntent, actor });
    if (replay[0]) {
      const replayRows = [
        replay[0].bookings_row,
        replay[0].students_row,
        replay[0].lp_items_row,
        replay[0].tasks_row,
        replay[0].teachers_row,
      ];
      const replayAccess = buildOpsAccessContext(replayRows, actor, fullAdmin, session.role);
      const currentReplayBooking = Array.isArray(replay[0].bookings_row.payload)
        ? replay[0].bookings_row.payload.find((value) => value && typeof value === "object" && !Array.isArray(value)
          && (value as { id?: unknown }).id === replay[0].booking_id) as { teacherId?: unknown } | undefined
        : undefined;
      const currentReplayTeacherId = typeof currentReplayBooking?.teacherId === "string" ? currentReplayBooking.teacherId : "";
      const teacherReplayForbidden = !bookingCapacityTeacherReplayAllowed({
        sessionRole: session.role,
        ledgerActorRole: replay[0].actor_role,
        action: command.action === "bind_classroom" ? "bind_classroom" : replay[0].action,
        allowedTeacherIds: replayAccess.teacherIds,
        teacherId: replay[0].teacher_id,
        previousTeacherId: replay[0].previous_teacher_id,
        ...(currentReplayTeacherId ? { currentTeacherId: currentReplayTeacherId } : {}),
      });
      const replayStudents = replayRows.find((row) => row.entity === "students")?.payload;
      const activeReplayStudent = (studentId: string) => Array.isArray(replayStudents)
        && replayStudents.some((value) => value && typeof value === "object" && !Array.isArray(value)
          && (value as { id?: unknown }).id === studentId
          && (value as { importArchived?: unknown }).importArchived !== true);
      const classroomTeacherReplayStudentAllowed = command.action === "bind_classroom" && session.role === "teacher"
        ? activeReplayStudent(replay[0].student_id) && activeReplayStudent(replay[0].previous_student_id)
        : canOperateStudent(replayAccess, replay[0].student_id) && canOperateStudent(replayAccess, replay[0].previous_student_id);
      if (!classroomTeacherReplayStudentAllowed
        || teacherReplayForbidden) {
        return noStore({ error: "当前账号不能重放这条排课。", code: "student_scope_forbidden" }, 403);
      }
      const visible = filterOpsStateRows(replayRows, replayAccess);
      const bookingRow = visible.find((row) => row.entity === "bookings");
      const studentRow = visible.find((row) => row.entity === "students");
      const taskRow = visible.find((row) => row.entity === "tasks");
      const teacherRow = visible.find((row) => row.entity === "teachers");
      if (!bookingRow || !studentRow || !taskRow || !teacherRow) {
        throw new OpsStoreError("排课重放结果不可见。", "invalid_commit_result");
      }
      return noStore({
        committed: true,
        action: replay[0].action,
        requestedAction: command.action,
        applied: false,
        bookingId: replay[0].booking_id,
        commandKey: replay[0].command_key,
        bookingRow,
        studentRow,
        taskRow,
        teacherRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const rows = await getOpsState(["bookings", "students", "lpItems", "tasks", "teachers"]);
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
    // bind_classroom authorization is occurrence-scoped. A substitute teacher
    // may not see the parent series in the ordinary schedule projection, so
    // the service must evaluate the effective occurrence teacher from the
    // locked full rows instead of this parent-booking precheck.
    if (command.action !== "bind_classroom" && (!studentAllowed || (session.role === "teacher" && command.action === "delete"))) {
      return noStore({ error: "当前账号不能修改这条排课。", code: "student_scope_forbidden" }, 403);
    }
    const prepared = prepareBookingCapacityMutation({ command, rows, actor, role: session.role, fullAdmin });
    const saved = await mutateBookingCapacityAtomic({ ...prepared, actorRole: session.role, actor });
    if (!saved[0]) throw new OpsStoreError("排课事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = [
      saved[0].bookings_row,
      saved[0].students_row,
      saved[0].lp_items_row,
      saved[0].tasks_row,
      saved[0].teachers_row,
    ];
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session.role);
    if (!canOperateStudent(committedAccess, saved[0].student_id)
      || !canOperateStudent(committedAccess, saved[0].previous_student_id)
      || (session.role === "teacher" && (
        !committedAccess.teacherIds.has(saved[0].teacher_id)
        || !committedAccess.teacherIds.has(saved[0].previous_teacher_id)
      ))) {
      throw new OpsStoreError("排课事务结果超出当前账号范围。", "invalid_commit_result");
    }
    const committedVisible = filterOpsStateRows(committedRows, committedAccess);
    const bookingRow = committedVisible.find((row) => row.entity === "bookings");
    const studentRow = committedVisible.find((row) => row.entity === "students");
    const taskRow = committedVisible.find((row) => row.entity === "tasks");
    const teacherRow = committedVisible.find((row) => row.entity === "teachers");
    if (!bookingRow || !studentRow || !taskRow || !teacherRow) {
      throw new OpsStoreError("排课事务没有返回完整权威状态。", "invalid_commit_result");
    }
    return noStore({
      committed: true,
      action: saved[0].action,
      requestedAction: command.action,
      applied: saved[0].applied,
      bookingId: saved[0].booking_id,
      commandKey: saved[0].command_key,
      bookingRow,
      studentRow,
      taskRow,
      teacherRow,
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
    if (error instanceof OpsStoreError && error.message === "jiaowubao_direct_import_schedule_conflict") {
      return noStore({
        error: "该老师或学生与教务宝已导入课表重叠，请更换时间或老师后重试。",
        code: "jiaowubao_direct_import_schedule_conflict",
      }, 409);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "排课、学生或老师资料刚刚发生变化，请刷新后重试。", code: "booking_capacity_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个排课命令已使用不同内容提交，请刷新后重试。", code: "booking_capacity_idempotency_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "排课保存失败。" }, 503);
  }
}

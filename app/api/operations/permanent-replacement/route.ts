import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  OperationConfirmationError,
  parsePermanentTeacherReplacementCommand,
  permanentTeacherReplacementCommandKey,
  permanentTeacherReplacementIntent,
  preparePermanentTeacherReplacement,
} from "@/lib/operation-occurrence-service";
import {
  confirmPermanentTeacherReplacementAtomic,
  getOpsState,
  getPermanentTeacherReplacementCommandResult,
  OpsStoreError,
  PERMANENT_TEACHER_REPLACEMENT_ATOMIC_RPC,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serviceError(error: OperationConfirmationError) {
  if (["teacher_forbidden", "operation_scope_forbidden"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (["operation_not_found", "substitute_not_found", "student_not_found"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if ([
    "stale_expected_version",
    "operation_already_confirmed",
    "affected_occurrence_not_found",
    "student_assignment_conflict",
    "unbounded_future_series",
    "substitute_not_candidate",
    "substitute_unavailable",
    "substitute_conflict",
    "replacement_capacity_unconfigured",
    "replacement_capacity_exhausted",
  ].includes(error.code)) {
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
  if (session.role === "teacher") {
    return noStore({ error: "老师账号不能最终确认永久换师。", code: "teacher_forbidden" }, 403);
  }
  const fullAdmin = actor === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parsePermanentTeacherReplacementCommand(await request.json().catch(() => null));
    const rows = await getOpsState(["bookings", "operations", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    const visibleRows = filterOpsStateRows(rows, access);
    const visibleOperations = visibleRows.find((row) => row.entity === "operations");
    const visibleOperation = Array.isArray(visibleOperations?.payload)
      ? visibleOperations.payload.find((value) => value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as { id?: unknown }).id === command.operationId) as { studentId?: unknown } | undefined
      : undefined;
    if (!visibleOperation
      || typeof visibleOperation.studentId !== "string"
      || !canOperateStudent(access, visibleOperation.studentId)) {
      return noStore({ error: "当前账号不能确认这条离职换师记录。", code: "operation_scope_forbidden" }, 403);
    }

    const commandKey = permanentTeacherReplacementCommandKey(command);
    const commandIntent = permanentTeacherReplacementIntent(command);
    const replay = await getPermanentTeacherReplacementCommandResult({ commandKey, commandIntent, actor });
    if (replay[0]) {
      // The command ledger and the first state snapshot are separate reads. A
      // commit can land between them, so a replay must never return those
      // pre-transaction rows. Re-read and re-authorize the current projection.
      const replayRows = await getOpsState(["bookings", "operations", "students", "teachers"]);
      const replayAccess = buildOpsAccessContext(replayRows, actor, fullAdmin, session);
      const replayVisibleRows = filterOpsStateRows(replayRows, replayAccess);
      const replayOperations = replayVisibleRows.find((row) => row.entity === "operations");
      const replayOperation = Array.isArray(replayOperations?.payload)
        ? replayOperations.payload.find((value) => value
          && typeof value === "object"
          && !Array.isArray(value)
          && (value as { id?: unknown }).id === replay[0].operation_id) as { studentId?: unknown } | undefined
        : undefined;
      if (!replayOperation
        || typeof replayOperation.studentId !== "string"
        || !canOperateStudent(replayAccess, replayOperation.studentId)) {
        return noStore({ error: "当前账号不能读取这条永久换师结果。", code: "operation_scope_forbidden" }, 403);
      }
      const current = Object.fromEntries(replayVisibleRows.map((row) => [row.entity, row]));
      if (!current.bookings || !current.operations || !current.teachers || !current.students) {
        throw new OpsStoreError("永久换师重放结果不可见。", "invalid_commit_result");
      }
      return noStore({
        committed: true,
        applied: false,
        operationId: replay[0].operation_id,
        commandKey: replay[0].command_key,
        affectedOccurrenceIds: replay[0].affected_occurrence_ids,
        changedTeacherIds: replay[0].changed_teacher_ids,
        bookingRow: current.bookings,
        operationRow: current.operations,
        teacherRow: current.teachers,
        studentRow: current.students,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const prepared = preparePermanentTeacherReplacement({
      command,
      rows,
      actor,
      fullAdmin,
      role: session.role,
      authorization: session,
    });
    const saved = await confirmPermanentTeacherReplacementAtomic({ ...prepared, actor });
    if (!saved[0]) throw new OpsStoreError("永久换师事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "bookings"
      ? saved[0].bookings_row
      : row.entity === "operations"
        ? saved[0].operations_row
        : row.entity === "teachers"
          ? saved[0].teachers_row
          : row.entity === "students"
            ? saved[0].students_row
            : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session);
    const committedVisible = filterOpsStateRows(committedRows, committedAccess);
    return noStore({
      committed: true,
      applied: saved[0].applied,
      operationId: saved[0].operation_id,
      commandKey: saved[0].command_key,
      affectedOccurrenceIds: saved[0].affected_occurrence_ids,
      changedTeacherIds: saved[0].changed_teacher_ids,
      bookingRow: committedVisible.find((row) => row.entity === "bookings"),
      operationRow: committedVisible.find((row) => row.entity === "operations"),
      teacherRow: committedVisible.find((row) => row.entity === "teachers"),
      studentRow: committedVisible.find((row) => row.entity === "students"),
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof OperationConfirmationError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({
        error: "永久换师数据库合同尚未部署，当前不能最终确认。",
        code: "permanent_teacher_replacement_contract_unavailable",
        requiredRpc: PERMANENT_TEACHER_REPLACEMENT_ATOMIC_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "相关课程、异常、老师或学生资料刚刚发生变化，请刷新后重试。", code: "permanent_teacher_replacement_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个永久换师命令已使用不同内容提交，请刷新后重试。", code: "permanent_teacher_replacement_idempotency_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "永久换师失败。" }, 503);
  }
}

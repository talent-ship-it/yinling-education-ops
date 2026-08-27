import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  parseTeacherDepartureCreationCommand,
  prepareTeacherDepartureCreation,
  TeacherDepartureCreationError,
  teacherDepartureCreationIntent,
} from "@/lib/teacher-departure-creation-service";
import {
  createTeacherDepartureAtomic,
  getOpsState,
  getTeacherDepartureCreationCommandResult,
  OpsStoreError,
  TEACHER_DEPARTURE_CREATION_ATOMIC_RPC,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const DEPARTURE_ENTITIES = ["bookings", "operations", "students", "tasks", "teachers"];

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serviceError(error: TeacherDepartureCreationError) {
  if ([
    "teacher_forbidden",
    "source_teacher_scope_forbidden",
    "affected_student_scope_forbidden",
    "archived_student_read_only",
  ].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (["source_teacher_not_found", "affected_student_not_found"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if ([
    "stale_expected_version",
    "departure_already_exists",
    "replacement_candidate_not_found",
    "unbounded_future_series",
  ].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  return noStore({ error: error.message, code: error.code }, 400);
}

function committedRowsPayload(rows: Awaited<ReturnType<typeof getOpsState>>, operationRow: unknown, taskRow: unknown) {
  return rows.map((row) => row.entity === "operations"
    ? operationRow as typeof row
    : row.entity === "tasks" ? taskRow as typeof row : row);
}

function generatedDepartureTaskCount(taskRow: { payload?: unknown }, operationIds: readonly string[]) {
  if (!Array.isArray(taskRow.payload)) return 0;
  const anchors = new Set(operationIds);
  return taskRow.payload.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const task = value as Record<string, unknown>;
    return typeof task.ruleKey === "string"
      && task.ruleKey.startsWith("teacher-departure:")
      && typeof task.anchorBookingId === "string"
      && anchors.has(task.anchorBookingId);
  }).length;
}

/**
 * Preview groups carry human-readable metadata that is intentionally not part
 * of the historical atomic RPC envelope. Keep the commit payload byte-shape
 * narrow so deployed SQL contracts remain backwards compatible.
 */
function atomicAffectedGroups(groups: Awaited<ReturnType<typeof prepareTeacherDepartureCreation>>["affectedGroups"]) {
  return groups.map(({ studentId, operationId, affectedOccurrenceIds, candidateTeacherIds }) => ({
    studentId,
    operationId,
    affectedOccurrenceIds,
    candidateTeacherIds,
  }));
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  if (session.role === "teacher") {
    return noStore({ error: "老师账号不能创建离职交接流程。", code: "teacher_forbidden" }, 403);
  }
  const actor = session.user;
  const fullAdmin = actor === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const rawBody = await request.json().catch(() => null);
    const isPreview = Boolean(rawBody
      && typeof rawBody === "object"
      && !Array.isArray(rawBody)
      && (rawBody as Record<string, unknown>).preview === true);
    const commandBody = isPreview && rawBody
      && typeof rawBody === "object"
      && !Array.isArray(rawBody)
      ? Object.fromEntries(Object.entries(rawBody as Record<string, unknown>).filter(([key]) => key !== "preview"))
      : rawBody;
    const command = parseTeacherDepartureCreationCommand(commandBody);
    const commandIntent = teacherDepartureCreationIntent(command);
    const rows = await getOpsState(DEPARTURE_ENTITIES);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    if (!access.staff && !access.fullAdmin && !access.limitedAdmin) {
      return noStore({ error: "当前账号不能创建老师离职流程。", code: "source_teacher_scope_forbidden" }, 403);
    }

    if (isPreview) {
      const preparedPreview = prepareTeacherDepartureCreation({
        command,
        rows,
        actor,
        role: session.role,
        authorization: session,
        fullAdmin,
      });
      return noStore({
        preview: true,
        commandKey: preparedPreview.commandKey,
        sourceTeacherId: preparedPreview.sourceTeacherId,
        effectiveDate: preparedPreview.effectiveDate,
        affectedGroups: preparedPreview.affectedGroups.map(({ studentId, subjects, firstAffectedAt, candidateTeacherIds, affectedOccurrenceIds }) => ({
          studentId,
          subjects,
          firstAffectedAt,
          candidateTeacherIds,
          affectedOccurrenceCount: affectedOccurrenceIds.length,
        })),
        affectedOccurrenceCount: preparedPreview.affectedOccurrenceCount,
        generatedTaskCount: preparedPreview.generatedTaskCount,
      });
    }

    const replay = await getTeacherDepartureCreationCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (replay[0]) {
      // A replay result cannot reuse the snapshot read before its ledger lookup.
      // Re-read and re-authorize every affected student before returning rows.
      const replayRows = await getOpsState(DEPARTURE_ENTITIES);
      const replayAccess = buildOpsAccessContext(replayRows, actor, fullAdmin, session);
      if (!replay[0].affected_student_ids.length
        || replay[0].affected_student_ids.some((studentId) => !canOperateStudent(replayAccess, studentId))) {
        return noStore({ error: "当前账号不能读取这次离职流程结果。", code: "affected_student_scope_forbidden" }, 403);
      }
      const visible = filterOpsStateRows(replayRows, replayAccess);
      const operationRow = visible.find((row) => row.entity === "operations");
      const taskRow = visible.find((row) => row.entity === "tasks");
      if (!operationRow || !taskRow) throw new OpsStoreError("离职流程重放结果不可见。", "invalid_commit_result");
      return noStore({
        committed: true,
        applied: false,
        commandKey: replay[0].command_key,
        sourceTeacherId: replay[0].source_teacher_id,
        effectiveDate: replay[0].effective_date,
        operationIds: replay[0].operation_ids,
        affectedStudentIds: replay[0].affected_student_ids,
        generatedTaskCount: generatedDepartureTaskCount(taskRow, replay[0].operation_ids),
        operationRow,
        taskRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const prepared = prepareTeacherDepartureCreation({
      command,
      rows,
      actor,
      role: session.role,
      authorization: session,
      fullAdmin,
    });
    const saved = await createTeacherDepartureAtomic({ ...prepared, affectedGroups: atomicAffectedGroups(prepared.affectedGroups), actor });
    if (!saved[0]) throw new OpsStoreError("离职流程事务没有返回保存结果。", "invalid_commit_result");
    // A concurrent identical request can win after our first ledger miss. In
    // that applied=false path none of the original five rows is authoritative;
    // fetch all five again before rebuilding access and returning projections.
    const committedRows = saved[0].applied
      ? committedRowsPayload(rows, saved[0].operations_row, saved[0].tasks_row)
      : await getOpsState(DEPARTURE_ENTITIES);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session);
    if (!saved[0].affected_student_ids.length
      || saved[0].affected_student_ids.some((studentId) => !canOperateStudent(committedAccess, studentId))) {
      throw new OpsStoreError("离职流程保存后已超出当前账号范围。", "invalid_commit_result");
    }
    const visible = filterOpsStateRows(committedRows, committedAccess);
    const operationRow = visible.find((row) => row.entity === "operations");
    const taskRow = visible.find((row) => row.entity === "tasks");
    if (!operationRow || !taskRow) throw new OpsStoreError("离职流程结果不可见。", "invalid_commit_result");
    return noStore({
      committed: true,
      applied: saved[0].applied,
      commandKey: saved[0].command_key,
      sourceTeacherId: saved[0].source_teacher_id,
      effectiveDate: saved[0].effective_date,
      operationIds: saved[0].operation_ids,
      affectedStudentIds: saved[0].affected_student_ids,
      affectedOccurrenceCount: prepared.affectedOccurrenceCount,
      generatedTaskCount: prepared.generatedTaskCount,
      operationRow,
      taskRow,
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof TeacherDepartureCreationError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({
        error: "老师离职创建原子合同尚未部署，当前不会降级为分散写入。",
        code: "teacher_departure_creation_contract_unavailable",
        requiredRpc: TEACHER_DEPARTURE_CREATION_ATOMIC_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "课程、异常、学生、任务或老师资料刚刚发生变化，请刷新后重试。", code: "teacher_departure_creation_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个离职提交编号已用于不同内容，请关闭窗口后重试。", code: "teacher_departure_creation_idempotency_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "老师离职流程创建失败。" }, 503);
  }
}

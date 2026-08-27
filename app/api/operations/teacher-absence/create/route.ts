import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  parseTeacherAbsenceCreationCommand,
  prepareTeacherAbsenceCreation,
  teacherAbsenceCreationIntent,
  TeacherAbsenceCreationError,
} from "@/lib/teacher-absence-creation-service";
import {
  createTeacherAbsenceAtomic,
  getOpsState,
  getTeacherAbsenceCreationCommandResult,
  OpsStoreError,
  TEACHER_ABSENCE_CREATION_ATOMIC_RPC,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";
const ENTITIES = ["bookings", "operations", "students", "tasks", "teachers"];
function noStore(payload: unknown, status = 200) { return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } }); }
function serviceError(error: TeacherAbsenceCreationError) {
  if (["teacher_forbidden", "source_teacher_scope_forbidden", "affected_student_scope_forbidden", "archived_student_read_only"].includes(error.code)) return noStore({ error: error.message, code: error.code }, 403);
  if (["source_teacher_not_found", "affected_student_not_found"].includes(error.code)) return noStore({ error: error.message, code: error.code }, 404);
  if (["stale_expected_version", "absence_already_exists"].includes(error.code)) return noStore({ error: error.message, code: error.code }, 409);
  if (error.code === "invalid_shared_state") return noStore({ error: error.message, code: error.code }, 503);
  return noStore({ error: error.message, code: error.code }, 400);
}
function visibleRows(rows: Awaited<ReturnType<typeof getOpsState>>, actor: string, fullAdmin: boolean, role: Parameters<typeof buildOpsAccessContext>[3]) {
  const access = buildOpsAccessContext(rows, actor, fullAdmin, role);
  return { access, rows: filterOpsStateRows(rows, access) };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (session.role === "teacher") return noStore({ error: "老师账号不能创建老师请假或代课流程。", code: "teacher_forbidden" }, 403);
  try {
    const body = await request.json().catch(() => null);
    const preview = Boolean(body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).preview === true);
    const command = parseTeacherAbsenceCreationCommand(body && typeof body === "object" && !Array.isArray(body)
      ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => key !== "preview"))
      : body);
    const commandIntent = teacherAbsenceCreationIntent(command);
    if (preview) {
      const rows = await getOpsState(ENTITIES);
      const access = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
      if (!access.staff && !access.fullAdmin && !access.limitedAdmin) return noStore({ error: "当前账号不能创建老师请假流程。", code: "source_teacher_scope_forbidden" }, 403);
      const preparedPreview = prepareTeacherAbsenceCreation({ command, rows, actor, role: session.role, fullAdmin });
      return noStore({ preview: true, commandKey: preparedPreview.commandKey, sourceTeacherId: preparedPreview.sourceTeacherId, eventStart: preparedPreview.eventStart, eventEnd: preparedPreview.eventEnd, affectedGroups: preparedPreview.affectedGroups, affectedOccurrenceCount: preparedPreview.affectedOccurrenceCount, generatedTaskCount: preparedPreview.generatedTaskCount });
    }
    // For a commit, the actor-bound ledger lookup is deliberately the first
    // database operation after signed authentication and strict parsing. A
    // lost-response retry must not be defeated by newer OCC versions or by a
    // scope assignment that changed after the original atomic commit.
    const replay = await getTeacherAbsenceCreationCommandResult({ commandKey: command.commandKey, commandIntent, actor });
    if (replay[0]) {
      let operationRow = null;
      let taskRow = null;
      let scopeAuthorized = false;
      try {
        const currentRows = await getOpsState(ENTITIES);
        const current = visibleRows(currentRows, actor, fullAdmin, session.role);
        scopeAuthorized = replay[0].affected_student_ids.length > 0
          && replay[0].affected_student_ids.every((studentId) => canOperateStudent(current.access, studentId));
        if (scopeAuthorized) {
          operationRow = current.rows.find((row) => row.entity === "operations") ?? null;
          taskRow = current.rows.find((row) => row.entity === "tasks") ?? null;
        }
      } catch {
        // The actor+intent-bound ledger receipt is still authoritative. Never
        // return unscoped state merely because a current projection is absent.
      }
      return noStore({ committed: true, applied: false, commandKey: replay[0].command_key, sourceTeacherId: replay[0].source_teacher_id, eventStart: replay[0].event_start, eventEnd: replay[0].event_end, operationIds: scopeAuthorized ? replay[0].operation_ids : [], affectedStudentIds: scopeAuthorized ? replay[0].affected_student_ids : [], operationRow: operationRow ?? null, taskRow: taskRow ?? null, auditEntryId: replay[0].audit_entry_id });
    }
    const rows = await getOpsState(ENTITIES);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
    if (!access.staff && !access.fullAdmin && !access.limitedAdmin) return noStore({ error: "当前账号不能创建老师请假流程。", code: "source_teacher_scope_forbidden" }, 403);
    const prepared = prepareTeacherAbsenceCreation({ command, rows, actor, role: session.role, fullAdmin });
    const saved = await createTeacherAbsenceAtomic({ ...prepared, tasks: prepared.tasks as unknown as readonly Record<string, unknown>[], actor });
    if (!saved[0]) throw new OpsStoreError("老师请假事务没有返回保存结果。", "invalid_commit_result");
    // A concurrent identical request can win between the first replay lookup
    // and the atomic RPC.  In that applied=false path the original snapshot is
    // no longer authoritative, so re-read every scoped projection.
    let operationRow = null;
    let taskRow = null;
    let scopeAuthorized = false;
    try {
      const committedRows = saved[0].applied
        ? rows.map((row) => row.entity === "operations" ? saved[0].operations_row : row.entity === "tasks" ? saved[0].tasks_row : row)
        : await getOpsState(ENTITIES);
      const committed = visibleRows(committedRows, actor, fullAdmin, session.role);
      scopeAuthorized = saved[0].affected_student_ids.length > 0
        && saved[0].affected_student_ids.every((studentId) => canOperateStudent(committed.access, studentId));
      if (scopeAuthorized) {
        operationRow = committed.rows.find((row) => row.entity === "operations") ?? null;
        taskRow = committed.rows.find((row) => row.entity === "tasks") ?? null;
      }
    } catch {
      // Preserve a successful receipt while withholding state that cannot be
      // re-authorized against the caller's current scope.
    }
    return noStore({ committed: true, applied: saved[0].applied, commandKey: saved[0].command_key, sourceTeacherId: saved[0].source_teacher_id, eventStart: saved[0].event_start, eventEnd: saved[0].event_end, operationIds: scopeAuthorized ? saved[0].operation_ids : [], affectedStudentIds: scopeAuthorized ? saved[0].affected_student_ids : [], affectedOccurrenceCount: scopeAuthorized ? saved[0].affected_occurrence_count : 0, generatedTaskCount: scopeAuthorized ? saved[0].generated_task_count : 0, operationRow: operationRow ?? null, taskRow: taskRow ?? null, auditEntryId: saved[0].audit_entry_id });
  } catch (error) {
    if (error instanceof TeacherAbsenceCreationError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) return noStore({ error: "老师请假原子合同尚未部署，当前不会降级为分散写入。", code: "teacher_absence_creation_contract_unavailable", requiredRpc: TEACHER_ABSENCE_CREATION_ATOMIC_RPC }, 501);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) return noStore({ error: "课程、异常、学生、任务或老师资料刚刚发生变化，请刷新后重试。", code: "teacher_absence_creation_conflict" }, 409);
    if (error instanceof OpsStoreError && error.code === "23505") return noStore({ error: "同一个请假提交编号已用于不同内容，请刷新后重试。", code: "teacher_absence_creation_idempotency_conflict" }, 409);
    return noStore({ error: error instanceof Error ? error.message : "老师请假流程创建失败。" }, 503);
  }
}

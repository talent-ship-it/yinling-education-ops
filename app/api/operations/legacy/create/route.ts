import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction, filterOpsStateRows } from "@/lib/ops-access";
import { getLegacyOperationTaskCommandResult, getOpsState, LEGACY_OPERATION_TASK_ATOMIC_RPC, mutateLegacyOperationTaskAtomic, OpsStoreError, type LegacyOperationTaskCommandResult, type OpsStateRow } from "@/lib/ops-store";
import { LegacyOperationTaskError, legacyOperationTaskIntent, parseLegacyOperationTaskCommand, prepareLegacyOperationTask } from "@/lib/legacy-operation-task-service";

export const dynamic = "force-dynamic";
function noStore(payload: unknown, status = 200) { return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } }); }

function receiptOnly(result: Pick<LegacyOperationTaskCommandResult, "command_key" | "audit_entry_id">) {
  // The command/audit receipt is opaque. Never disclose historic operation,
  // student, task identifiers or state rows after current scope drift.
  return noStore({ committed: true, applied: false, receiptOnly: true, commandKey: result.command_key, auditEntryId: result.audit_entry_id });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function replayVisible(result: LegacyOperationTaskCommandResult, rows: OpsStateRow[], actor: string, fullAdmin: boolean, role: Parameters<typeof buildOpsAccessContext>[3]) {
  const access = buildOpsAccessContext(rows, actor, fullAdmin, role);
  if (!access.staff && !access.fullAdmin && !access.limitedAdmin) return false;
  if (result.affected_student_ids.some((studentId) => !canOperateStudent(access, studentId))) return false;
  const visible = filterOpsStateRows(rows, access);
  const operationsRow = visible.find((row) => row.entity === "operations");
  const tasksRow = visible.find((row) => row.entity === "tasks");
  const operationPayload = operationsRow && Array.isArray(operationsRow.payload) ? operationsRow.payload : [];
  const taskPayload = tasksRow && Array.isArray(tasksRow.payload) ? tasksRow.payload : [];
  const operationIds = Array.isArray(result.operation_ids) ? result.operation_ids : [];
  const operationsVisible = operationIds.length > 0
    && operationIds.every((operationId) => operationPayload.some((value: unknown) => record(value) && value.id === operationId));
  const tasksVisible = operationIds.length > 0
    && operationIds.every((operationId) => taskPayload.some((value: unknown) => record(value) && value.anchorBookingId === operationId));
  return operationsVisible && tasksVisible;
}

async function renderLegacyReplay(result: LegacyOperationTaskCommandResult, actor: string, cookieValue: string | undefined, nixonCookieValue: string | undefined) {
  try {
    const current = await getCurrentDemoSession(cookieValue);
    // A roster/role/assignment change must not turn a committed receipt into
    // a 403 or leak the historic projection.
    if (!("session" in current) || current.session.user !== actor) return receiptOnly(result);
    const fullAdmin = hasFullAdminAccess(current.session, nixonCookieValue);
    const rows = await getOpsState(["bookings", "operations", "tasks", "students", "teachers"]);
    if (!replayVisible(result, rows, actor, fullAdmin, current.session)) return receiptOnly(result);
    const visible = filterOpsStateRows(rows, buildOpsAccessContext(rows, actor, fullAdmin, current.session));
    return noStore({ committed: true, applied: false, receiptOnly: false, commandKey: result.command_key, operationIds: result.operation_ids, affectedStudentIds: result.affected_student_ids,
      operationRow: visible.find((row) => row.entity === "operations") ?? null, taskRow: visible.find((row) => row.entity === "tasks") ?? null, auditEntryId: result.audit_entry_id });
  } catch {
    // The ledger already proves the command committed; visibility failure is a
    // receipt-only success, allowing the actor-scoped pending envelope to clear.
    return receiptOnly(result);
  }
}

export async function POST(request: Request) {
  const cookieStore = await cookies(); const cookieValue = cookieStore.get(DEMO_COOKIE_NAME)?.value;
  const resolved = await getCurrentDemoSession(cookieValue);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  try {
    const command = parseLegacyOperationTaskCommand(await request.json().catch(() => null)); const commandIntent = legacyOperationTaskIntent(command);
    const replay = await getLegacyOperationTaskCommandResult({ commandKey: command.commandKey, commandIntent, actor });
    if (replay[0]) return renderLegacyReplay(replay[0], actor, cookieValue, cookieStore.get(NIXON_COOKIE_NAME)?.value);

    if (session.role === "teacher") return noStore({ error: "老师账号不能创建教务异常流程。", code: "teacher_forbidden" }, 403);
    const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const rows = await getOpsState(["bookings", "operations", "students", "tasks", "teachers"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    if (!canWriteOpsTransaction(access, "operations", ["operations", "tasks"])
        || (!access.staff && !access.fullAdmin && !access.limitedAdmin)) {
      return noStore({ error: "当前账号不能创建教务异常流程。", code: "operation_scope_forbidden" }, 403);
    }
    if (command.studentId && !canOperateStudent(access, command.studentId)) return noStore({ error: "当前账号不能操作该学生。", code: "student_scope_forbidden" }, 403);
    const prepared = prepareLegacyOperationTask(command, rows, actor);
    const saved = await mutateLegacyOperationTaskAtomic({ commandKey: prepared.commandKey, commandIntent: prepared.commandIntent, type: prepared.type, detail: prepared.detail, studentId: prepared.studentId, teacherId: prepared.teacherId, eventStart: prepared.eventStart, eventEnd: prepared.eventEnd, sourceBookingId: prepared.sourceBookingId, expectedVersions: prepared.expectedVersions, actor });
    if (!saved[0] || !saved[0].operations_row || !saved[0].tasks_row) throw new OpsStoreError("异常事务没有返回完整状态行。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "operations" ? saved[0].operations_row! : row.entity === "tasks" ? saved[0].tasks_row! : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session); const visible = filterOpsStateRows(committedRows, committedAccess);
    return noStore({ committed: true, applied: saved[0].applied, commandKey: saved[0].command_key, operationIds: saved[0].operation_ids, affectedStudentIds: saved[0].affected_student_ids, generatedTaskCount: saved[0].generated_task_count ?? null, operationRow: visible.find((row) => row.entity === "operations") ?? null, taskRow: visible.find((row) => row.entity === "tasks") ?? null, auditEntryId: saved[0].audit_entry_id });
  } catch (error) {
    if (error instanceof LegacyOperationTaskError) return noStore({ error: error.message, code: error.code }, error.code === "no_affected_occurrences" ? 409 : 400);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) return noStore({ error: "教务异常原子合同尚未部署，当前不会降级为分散写入。", code: "operation_task_contract_unavailable", requiredRpc: LEGACY_OPERATION_TASK_ATOMIC_RPC }, 501);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) return noStore({ error: "异常或任务资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    if (error instanceof OpsStoreError && error.code === "23505") return noStore({ error: "同一个异常命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    return noStore({ error: "教务异常保存失败。" }, 503);
  }
}

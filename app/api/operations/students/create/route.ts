import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canWriteOpsTransaction, filterOpsStateRows } from "@/lib/ops-access";
import {
  createStudentWithTasksAtomic, getOpsState, getStudentCreationCommandResult,
  OpsStoreError, STUDENT_CREATION_ATOMIC_RPC, type OpsStateRow, type StudentCreationCommandResult,
} from "@/lib/ops-store";
import { authorizeStudentCreationCommand, canonicalizeStudentCreationCommand, parseStudentCreationCommand, prepareStudentCreation, studentCreationIntent, StudentCreationError } from "@/lib/student-creation-service";

export const dynamic = "force-dynamic";
function noStore(payload: unknown, status = 200) { return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } }); }

function receiptOnly(result: Pick<StudentCreationCommandResult, "command_key" | "audit_entry_id">) {
  // The command/audit receipt is opaque. In particular, do not echo the
  // historic student id, task ids, or projection rows after scope drift.
  return noStore({ committed: true, applied: false, receiptOnly: true, commandKey: result.command_key, auditEntryId: result.audit_entry_id });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function replayVisible(result: StudentCreationCommandResult, rows: OpsStateRow[], actor: string, fullAdmin: boolean, role: Parameters<typeof buildOpsAccessContext>[3]) {
  const access = buildOpsAccessContext(rows, actor, fullAdmin, role);
  if (!access.staff && !access.fullAdmin && !access.limitedAdmin) return false;
  const visible = filterOpsStateRows(rows, access);
  const studentsRow = visible.find((row) => row.entity === "students");
  const tasksRow = visible.find((row) => row.entity === "tasks");
  const studentPayload = studentsRow && Array.isArray(studentsRow.payload) ? studentsRow.payload : [];
  const taskPayload = tasksRow && Array.isArray(tasksRow.payload) ? tasksRow.payload : [];
  const studentVisible = studentPayload.some((value: unknown) => record(value) && value.id === result.student_id);
  const taskIds = Array.isArray(result.task_ids) ? result.task_ids : [];
  const tasksVisible = taskIds.length > 0
    && taskIds.every((taskId) => taskPayload.some((value: unknown) => record(value) && value.id === taskId));
  return studentVisible && tasksVisible;
}

async function renderStudentReplay(result: StudentCreationCommandResult, actor: string, cookieValue: string | undefined, nixonCookieValue: string | undefined) {
  try {
    const current = await getCurrentDemoSession(cookieValue);
    // A roster/role change is precisely the case where the signed actor still
    // owns the receipt but must not regain historic rows.
    if (!("session" in current) || current.session.user !== actor) return receiptOnly(result);
    const fullAdmin = hasFullAdminAccess(current.session, nixonCookieValue);
    const rows = await getOpsState(["students", "tasks"]);
    if (!replayVisible(result, rows, actor, fullAdmin, current.session)) return receiptOnly(result);
    const visible = filterOpsStateRows(rows, buildOpsAccessContext(rows, actor, fullAdmin, current.session));
    return noStore({ committed: true, applied: false, receiptOnly: false, commandKey: result.command_key, studentId: result.student_id, taskIds: result.task_ids,
      studentsRow: visible.find((row) => row.entity === "students") ?? null, tasksRow: visible.find((row) => row.entity === "tasks") ?? null, auditEntryId: result.audit_entry_id });
  } catch {
    // The ledger already proved the commit. If current visibility cannot be
    // established, return only the opaque receipt so the client can clear its
    // retry envelope without receiving historic state.
    return receiptOnly(result);
  }
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(DEMO_COOKIE_NAME)?.value;
  const resolved = await getCurrentDemoSession(cookieValue);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  try {
    const parsedCommand = parseStudentCreationCommand(await request.json().catch(() => null));
    // Only semantic canonicalization precedes replay. Current role/owner scope
    // is intentionally deferred until the ledger miss branch below.
    const command = canonicalizeStudentCreationCommand(parsedCommand);
    const commandIntent = studentCreationIntent(command);
    const replay = await getStudentCreationCommandResult({ commandKey: command.commandKey, commandIntent, actor });
    if (replay[0]) return renderStudentReplay(replay[0], actor, cookieValue, cookieStore.get(NIXON_COOKIE_NAME)?.value);

    if (session.role === "teacher") return noStore({ error: "老师账号不能创建学生档案。", code: "teacher_forbidden" }, 403);
    const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const rows = await getOpsState(["students", "tasks"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    if (!canWriteOpsTransaction(access, "students", ["students", "tasks"])
        || (!access.staff && !access.fullAdmin && !access.limitedAdmin)) {
      return noStore({ error: "当前账号不能创建学生档案。", code: "student_scope_forbidden" }, 403);
    }
    const authorized = authorizeStudentCreationCommand(command, actor, fullAdmin || actor === DEMO_LIMITED_ADMIN_USER);
    const prepared = prepareStudentCreation(authorized, rows);
    const saved = await createStudentWithTasksAtomic({ commandKey: prepared.commandKey, commandIntent: prepared.commandIntent, studentFields: prepared.studentFields, expectedVersions: prepared.expectedVersions, actor });
    if (!saved[0] || !saved[0].students_row || !saved[0].tasks_row) throw new OpsStoreError("学生创建事务没有返回完整状态行。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "students" ? saved[0].students_row! : row.entity === "tasks" ? saved[0].tasks_row! : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session);
    const visible = filterOpsStateRows(committedRows, committedAccess);
    return noStore({ committed: true, applied: saved[0].applied, commandKey: saved[0].command_key, studentId: saved[0].student_id, taskIds: saved[0].task_ids,
      studentsRow: visible.find((row) => row.entity === "students") ?? null, tasksRow: visible.find((row) => row.entity === "tasks") ?? null, auditEntryId: saved[0].audit_entry_id });
  } catch (error) {
    if (error instanceof StudentCreationError) return noStore({ error: error.message, code: error.code }, error.code === "scope_forbidden" ? 403 : 400);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) return noStore({ error: "学生创建原子合同尚未部署，当前不会降级为分散写入。", code: "student_creation_contract_unavailable", requiredRpc: STUDENT_CREATION_ATOMIC_RPC }, 501);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) return noStore({ error: "学生或任务资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    if (error instanceof OpsStoreError && error.code === "23505") return noStore({ error: "同一个学生创建命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    return noStore({ error: "学生创建失败。" }, 503);
  }
}

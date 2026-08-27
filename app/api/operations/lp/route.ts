import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  LpAtomicError,
  lpAtomicIntent,
  parseLpAtomicCommand,
  prepareLpAtomicCommand,
} from "@/lib/lp-atomic-service";
import {
  getLpAtomicCommandResult,
  getOpsState,
  LP_ATOMIC_COMMAND_RESULT_RPC,
  mutateLpAtomic,
  OpsStoreError,
  type OpsStateRow,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function rowsPayload(rows: readonly { entity: string; [key: string]: unknown }[]) {
  return {
    studentsRow: rows.find((row) => row.entity === "students") ?? null,
    lpItemsRow: rows.find((row) => row.entity === "lpItems") ?? null,
    tasksRow: rows.find((row) => row.entity === "tasks") ?? null,
    filesRow: rows.find((row) => row.entity === "files") ?? null,
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能创建或修订 LP。", code: "teacher_forbidden" }, 403);
  const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseLpAtomicCommand(await request.json().catch(() => null));
    // Keep the ordinary LP boundary fail-closed even if its parser is ever
    // widened: direct enrollment owns package/purchase creation and must use
    // /api/operations/direct-enrollment's dedicated 191013 transaction.
    if (command.workflowType === "学生直报（无试听）") {
      throw new LpAtomicError("direct_enrollment_required", "学生直报必须使用学生直报专用原子事务，不能通过普通 LP 入口保存。");
    }
    if (command.provisionalIntake && !fullAdmin) throw new LpAtomicError("provisional_forbidden", "无姓名临时建档需要超级管理员处理。");
    const commandIntent = lpAtomicIntent(command);
    // Replay is deliberately before scope/version checks.  A committed command
    // must be recoverable after a timeout or a temporarily incomplete snapshot.
    const replay = await getLpAtomicCommandResult({ commandKey: command.commandKey, commandIntent, actor });
    if (replay[0]) {
      const rows = [replay[0].students_row, replay[0].lp_items_row, replay[0].tasks_row, replay[0].files_row].filter((row): row is OpsStateRow => row !== null);
      const replayAccess = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
      if (!rows.some((row) => row.entity === "students") || !canOperateStudent(replayAccess, replay[0].student_id)) return noStore({ error: "当前账号不能操作该学生。", code: "student_scope_forbidden" }, 403);
      const visible = filterOpsStateRows(rows, replayAccess);
      return noStore({ committed: true, applied: false, commandKey: replay[0].command_key, operation: replay[0].operation, studentId: replay[0].student_id, lpItemId: replay[0].lp_item_id, ...rowsPayload(visible), auditEntryId: replay[0].audit_entry_id });
    }
    const rows = await getOpsState(["students", "lpItems", "tasks", "files"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
    const studentInScope = command.studentId ? canOperateStudent(access, command.studentId) : fullAdmin;
    if (!studentInScope) return noStore({ error: "当前账号不能操作该学生。", code: "student_scope_forbidden" }, 403);
    const prepared = prepareLpAtomicCommand({ command, rows, canOperateStudent: studentInScope, actor, fullAdmin });
    const saved = await mutateLpAtomic(prepared);
    if (!saved[0]) throw new OpsStoreError("LP 原子事务没有返回保存结果。", "invalid_commit_result");
    const result = saved[0];
    if (!result.students_row || !result.lp_items_row || !result.tasks_row || !result.files_row) throw new OpsStoreError("LP 原子事务没有返回完整状态行。", "invalid_commit_result");
    const savedStudentsRow = result.students_row as OpsStateRow;
    const savedLpItemsRow = result.lp_items_row as OpsStateRow;
    const savedTasksRow = result.tasks_row as OpsStateRow;
    const savedFilesRow = result.files_row as OpsStateRow;
    const committedRows = rows.map((row) => row.entity === "students" ? savedStudentsRow : row.entity === "lpItems" ? savedLpItemsRow : row.entity === "tasks" ? savedTasksRow : row.entity === "files" ? savedFilesRow : row);
    const visible = filterOpsStateRows(committedRows, buildOpsAccessContext(committedRows, actor, fullAdmin, session.role));
    const payload = rowsPayload(visible);
    if (!payload.studentsRow || !payload.lpItemsRow || !payload.tasksRow || !payload.filesRow) throw new OpsStoreError("LP 原子结果不可见。", "invalid_commit_result");
    return noStore({ committed: true, applied: result.applied, commandKey: result.command_key, operation: result.operation, studentId: result.student_id, lpItemId: result.lp_item_id, ...payload, auditEntryId: result.audit_entry_id });
  } catch (error) {
    if (error instanceof LpAtomicError) {
      const status = ["student_scope_forbidden", "teacher_forbidden", "student_archived", "provisional_forbidden", "assignment_forbidden"].includes(error.code) ? 403 : ["student_not_found", "lp_not_found"].includes(error.code) ? 404 : ["version_conflict", "idempotency_conflict"].includes(error.code) ? 409 : 400;
      return noStore({ error: error.message, code: error.code }, status);
    }
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) return noStore({ error: "LP 原子数据库合同尚未部署，当前不会降级为分散写入。", code: "lp_atomic_contract_unavailable", requiredRpc: LP_ATOMIC_COMMAND_RESULT_RPC }, 501);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) return noStore({ error: "学生、LP、任务或文件资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    if (error instanceof OpsStoreError && error.code === "23505") return noStore({ error: "同一个 LP 命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    return noStore({ error: error instanceof Error ? error.message : "LP 保存失败。" }, 503);
  }
}

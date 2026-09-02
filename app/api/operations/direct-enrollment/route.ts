import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  buildOpsAccessContext,
  canOperateStudent,
  canWriteOpsTransaction,
  filterOpsStateRows,
} from "@/lib/ops-access";
import {
  DirectEnrollmentError,
  directEnrollmentIntent,
  parseDirectEnrollmentCommand,
  prepareDirectEnrollmentCommand,
} from "@/lib/direct-enrollment-service";
import {
  createStudentDirectEnrollmentAtomic,
  DIRECT_ENROLLMENT_ATOMIC_RPC,
  getStudentDirectEnrollmentCommandResult,
  OpsStoreError,
  getOpsState,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能创建学生直报 LP。", code: "teacher_forbidden" }, 403);
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseDirectEnrollmentCommand(await request.json().catch(() => null));
    const commandIntent = directEnrollmentIntent(command);
    // Replay is intentionally the first database operation after signed
    // identity/role authentication and strict command parsing. It must not be
    // gated by today's scope, archive bit, versions, or a missing state row.
    const replay = await getStudentDirectEnrollmentCommandResult({ commandKey: command.commandKey, commandIntent, actor });
    if (replay[0]) {
      const replayRows = [replay[0].students_row, replay[0].lp_items_row, replay[0].tasks_row]
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      const replayAccess = replayRows.length === 3
        ? buildOpsAccessContext(replayRows, actor, fullAdmin, session)
        : null;
      const committed = replayAccess ? filterOpsStateRows(replayRows, replayAccess) : [];
      const studentRow = committed.find((row) => row.entity === "students");
      const lpItemsRow = committed.find((row) => row.entity === "lpItems");
      const tasksRow = committed.find((row) => row.entity === "tasks");
      return noStore({
        committed: true,
        applied: false,
        commandKey: replay[0].command_key,
        studentId: replay[0].student_id,
        packageId: replay[0].package_id,
        purchaseId: replay[0].purchase_id,
        lpItemId: replay[0].lp_item_id,
        taskIds: replay[0].task_ids,
        studentsRow: studentRow ?? null,
        lpItemsRow: lpItemsRow ?? null,
        tasksRow: tasksRow ?? null,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const rows = await getOpsState(["students", "lpItems", "tasks", "bookings"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    if (!canWriteOpsTransaction(access, "students", ["students", "lpItems", "tasks"])
        || !canOperateStudent(access, command.studentId)) {
      return noStore({ error: "当前账号不能操作该学生。", code: "student_scope_forbidden" }, 403);
    }
    const studentPayload = rows.find((row) => row.entity === "students")?.payload;
    const studentRecord = Array.isArray(studentPayload)
      ? studentPayload.find((value) => value && typeof value === "object" && !Array.isArray(value)
        && (value as { id?: unknown }).id === command.studentId) as { importArchived?: unknown } | undefined
      : undefined;
    if (studentRecord?.importArchived === true) {
      return noStore({ error: "已归档学生不能创建直报 LP。", code: "student_archived" }, 403);
    }

    const prepared = prepareDirectEnrollmentCommand({
      command,
      rows,
      actor,
      canOperateStudent: canOperateStudent(access, command.studentId),
    });
    const saved = await createStudentDirectEnrollmentAtomic({
      commandKey: prepared.commandKey,
      commandIntent: prepared.commandIntent,
      studentId: prepared.studentId,
      fields: prepared.fields,
      purchasedHours: prepared.purchasedHours,
      bonusHours: prepared.bonusHours,
      subject: prepared.subject,
      expectedVersions: prepared.expectedVersions,
      actor,
    });
    if (!saved[0]) throw new OpsStoreError("直报事务没有返回保存结果。", "invalid_commit_result");
    const savedResult = saved[0];
    const savedStudentsRow = savedResult.students_row;
    const savedLpItemsRow = savedResult.lp_items_row;
    const savedTasksRow = savedResult.tasks_row;
    if (!savedStudentsRow || !savedLpItemsRow || !savedTasksRow) {
      throw new OpsStoreError("直报事务没有返回完整状态行。", "invalid_commit_result");
    }
    const committedRows = rows.map((row) => row.entity === "students"
      ? savedStudentsRow
      : row.entity === "lpItems" ? savedLpItemsRow : row.entity === "tasks" ? savedTasksRow : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session);
    const visible = filterOpsStateRows(committedRows, committedAccess);
    const studentsRow = visible.find((row) => row.entity === "students");
    const lpItemsRow = visible.find((row) => row.entity === "lpItems");
    const tasksRow = visible.find((row) => row.entity === "tasks");
    if (!studentsRow || !lpItemsRow || !tasksRow) throw new OpsStoreError("直报结果不可见。", "invalid_commit_result");
    return noStore({
      committed: true,
      applied: savedResult.applied,
      commandKey: savedResult.command_key,
      studentId: savedResult.student_id,
      packageId: savedResult.package_id,
      purchaseId: savedResult.purchase_id,
      lpItemId: savedResult.lp_item_id,
      taskIds: savedResult.task_ids,
      studentsRow,
      lpItemsRow,
      tasksRow,
      auditEntryId: savedResult.audit_entry_id,
    });
  } catch (error) {
    if (error instanceof DirectEnrollmentError) {
      const status = ["student_scope_forbidden", "teacher_forbidden"].includes(error.code) ? 403
        : ["student_not_found"].includes(error.code) ? 404
          : ["version_conflict", "idempotency_conflict"].includes(error.code) ? 409 : 400;
      return noStore({ error: error.message, code: error.code }, status);
    }
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({ error: "学生直报原子合同尚未部署，当前不会降级为分散写入。", code: "direct_enrollment_contract_unavailable", requiredRpc: DIRECT_ENROLLMENT_ATOMIC_RPC }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "学生、LP 或任务资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && (error.code === "40901" || error.message === "subject_package_has_balance")) {
      return noStore({ error: "该科目已有未用完的课包余额，请先完成或处理原课包后再创建直报课包。", code: "subject_package_has_balance" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个直报命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    }
    return noStore({ error: "学生直报保存失败。" }, 503);
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  ExamSubmissionServiceError,
  examSubmissionIntent,
  parseExamSubmissionCommand,
  prepareExamSubmission,
} from "@/lib/exam-submission-service";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  EXAM_SUBMISSION_ATOMIC_RPC,
  getExamSubmissionCommandResult,
  getOpsState,
  OpsStoreError,
  submitExamAtomic,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serviceError(error: ExamSubmissionServiceError) {
  if (["teacher_forbidden", "student_scope_forbidden", "archived_student_read_only"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (error.code === "student_not_found") {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if (["stale_expected_version", "exam_identity_conflict"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  return noStore({ error: error.message, code: error.code }, 400);
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") {
    return noStore({ error: "老师账号不能录入学生考试。", code: "teacher_forbidden" }, 403);
  }
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseExamSubmissionCommand(await request.json().catch(() => null));
    const commandIntent = examSubmissionIntent(command);
    const rows = await getOpsState(["students", "tasks"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    if (!canOperateStudent(access, command.studentId)) {
      return noStore({ error: "当前账号不能录入这位学生的考试。", code: "student_scope_forbidden" }, 403);
    }

    const replay = await getExamSubmissionCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (replay[0]) {
      // Re-read after the ledger lookup so a lost-response recovery never
      // applies a pre-transaction snapshot or expands current access.
      const replayRows = await getOpsState(["students", "tasks"]);
      const replayAccess = buildOpsAccessContext(replayRows, actor, fullAdmin, session);
      if (!canOperateStudent(replayAccess, replay[0].student_id)) {
        return noStore({ error: "当前账号不能读取这次考试提交结果。", code: "student_scope_forbidden" }, 403);
      }
      const visible = filterOpsStateRows(replayRows, replayAccess);
      const studentRow = visible.find((row) => row.entity === "students");
      const taskRow = visible.find((row) => row.entity === "tasks");
      if (!studentRow || !taskRow) throw new OpsStoreError("考试重放结果不可见。", "invalid_commit_result");
      return noStore({
        committed: true,
        applied: false,
        action: replay[0].action,
        commandKey: replay[0].command_key,
        studentId: replay[0].student_id,
        examId: replay[0].exam_id,
        studentRow,
        taskRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const prepared = prepareExamSubmission({
      command,
      rows,
      actor,
      role: session.role,
      authorization: session,
      fullAdmin,
    });
    const saved = await submitExamAtomic({ ...prepared, actor });
    if (!saved[0]) throw new OpsStoreError("考试事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "students"
      ? saved[0].students_row
      : row.entity === "tasks" ? saved[0].tasks_row : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session);
    const visible = filterOpsStateRows(committedRows, committedAccess);
    const studentRow = visible.find((row) => row.entity === "students");
    const taskRow = visible.find((row) => row.entity === "tasks");
    if (!studentRow || !taskRow) throw new OpsStoreError("考试提交结果不可见。", "invalid_commit_result");
    return noStore({
      committed: true,
      applied: saved[0].applied,
      action: saved[0].action,
      commandKey: saved[0].command_key,
      studentId: saved[0].student_id,
      examId: saved[0].exam_id,
      generatedTaskCount: prepared.generatedTaskCount,
      unresolvedRoleLabels: prepared.unresolvedRoleLabels,
      studentRow,
      taskRow,
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "考试与提醒原子提交数据库合同尚未部署，当前不能写入。",
        code: "exam_submission_contract_unavailable",
        requiredRpc: EXAM_SUBMISSION_ATOMIC_RPC,
      }, 501);
    }
    if (error instanceof ExamSubmissionServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "学生或任务资料刚刚发生变化，请刷新后重试。", code: "exam_submission_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个考试提交编号已用于不同内容，请关闭窗口后重试。", code: "exam_submission_idempotency_conflict" }, 409);
    }
    return noStore({ error: "考试保存失败。" }, 503);
  }
}

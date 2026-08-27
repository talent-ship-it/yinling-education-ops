import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  ExamSubmissionServiceError,
  examSubmissionIntent,
  parseExamSubmissionRecoveryCommand,
} from "@/lib/exam-submission-service";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  EXAM_SUBMISSION_COMMAND_RESULT_RPC,
  getExamSubmissionCommandResult,
  getOpsState,
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

/**
 * Resolves a prior unknown transport outcome without ever executing the exam
 * mutation RPC. A missing ledger entry keeps the browser command pending so it
 * can restore and retry that exact intent instead of creating a second exam.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") {
    return noStore({ error: "老师账号不能恢复考试提交。", code: "teacher_forbidden" }, 403);
  }
  const fullAdmin = actor === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseExamSubmissionRecoveryCommand(await request.json().catch(() => null));
    const commandIntent = examSubmissionIntent(command);
    const rows = await getOpsState(["students", "tasks"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    if (!canOperateStudent(access, command.studentId)) {
      return noStore({ error: "当前账号不能恢复这位学生的考试提交。", code: "student_scope_forbidden" }, 403);
    }

    const replay = await getExamSubmissionCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (!replay[0]) {
      return noStore({
        resolved: true,
        committed: false,
        commandKey: command.commandKey,
        studentId: command.studentId,
        examId: command.exam.id,
      });
    }
    if (replay[0].command_key !== command.commandKey
      || replay[0].student_id !== command.studentId
      || replay[0].exam_id !== command.exam.id) {
      throw new OpsStoreError("考试恢复结果身份不一致。", "invalid_commit_result");
    }

    // Re-read after the actor-bound ledger lookup. Access or archival changes
    // that happened after the original commit must govern the recovery result.
    const replayRows = await getOpsState(["students", "tasks"]);
    const replayAccess = buildOpsAccessContext(replayRows, actor, fullAdmin, session);
    if (!canOperateStudent(replayAccess, replay[0].student_id)) {
      return noStore({ error: "当前账号不能读取这次考试提交结果。", code: "student_scope_forbidden" }, 403);
    }
    const visible = filterOpsStateRows(replayRows, replayAccess);
    const studentRow = visible.find((row) => row.entity === "students");
    const taskRow = visible.find((row) => row.entity === "tasks");
    if (!studentRow || !taskRow) {
      throw new OpsStoreError("考试恢复结果不可见。", "invalid_commit_result");
    }
    return noStore({
      resolved: true,
      committed: true,
      applied: false,
      commandKey: replay[0].command_key,
      studentId: replay[0].student_id,
      examId: replay[0].exam_id,
      studentRow,
      taskRow,
      auditEntryId: replay[0].audit_entry_id,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "考试提交恢复数据库合同尚未部署，当前不能确认旧提交。",
        code: "exam_submission_recovery_unavailable",
        requiredRpc: EXAM_SUBMISSION_COMMAND_RESULT_RPC,
      }, 501);
    }
    if (error instanceof ExamSubmissionServiceError) {
      return noStore({ error: error.message, code: error.code }, 400);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({
        error: "旧考试提交编号、内容或操作账号不一致。",
        code: "exam_submission_idempotency_conflict",
      }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "考试提交恢复失败。" }, 503);
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  ExamFollowUpServiceError,
  authorizeExamFollowUpCommand,
  examFollowUpIntent,
  parseExamFollowUpCommand,
  prepareExamFollowUp,
} from "@/lib/exam-follow-up-service";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, filterOpsStateRows } from "@/lib/ops-access";
import {
  EXAM_FOLLOW_UP_ATOMIC_RPC,
  getExamFollowUpCommandResult,
  getExamFollowUpCompletionContext,
  getOpsState,
  mutateExamFollowUpAtomic,
  OpsStoreError,
  type OpsStateRow,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serviceError(error: ExamFollowUpServiceError) {
  if ([
    "teacher_forbidden",
    "task_scope_forbidden",
    "archived_student_read_only",
  ].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (["task_not_found", "student_not_found", "exam_not_found", "completion_context_missing"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if ([
    "stale_expected_version",
    "follow_up_action_conflict",
    "task_identity_conflict",
    "task_recipient_conflict",
    "completion_actor_conflict",
  ].includes(error.code)) {
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

function visibleRows(rows: OpsStateRow[], actor: string, fullAdmin: boolean, role: Parameters<typeof buildOpsAccessContext>[3]) {
  const access = buildOpsAccessContext(rows, actor, fullAdmin, role);
  const visible = filterOpsStateRows(rows, access);
  const studentRow = visible.find((row) => row.entity === "students");
  const taskRow = visible.find((row) => row.entity === "tasks");
  if (!studentRow || !taskRow) {
    throw new OpsStoreError("考试提醒提交结果不可见。", "invalid_commit_result");
  }
  return { studentRow, taskRow };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") {
    return noStore({ error: "老师账号不能完成考试提醒。", code: "teacher_forbidden" }, 403);
  }
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseExamFollowUpCommand(await request.json().catch(() => null));
    const commandIntent = examFollowUpIntent(command);
    const rows = await getOpsState(["students", "tasks"]);
    authorizeExamFollowUpCommand({ command, rows, actor, role: session.role, authorization: session, fullAdmin });

    const replay = await getExamFollowUpCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (replay[0]) {
      // A replay is authorized from a fresh full snapshot: a task assignment or
      // student archival change after the original commit must take effect.
      const replayRows = await getOpsState(["students", "tasks"]);
      const replayIdentity = authorizeExamFollowUpCommand({
        command,
        rows: replayRows,
        actor,
        role: session.role,
        authorization: session,
        fullAdmin,
      });
      if (replay[0].task_id !== replayIdentity.taskId
        || replay[0].student_id !== replayIdentity.studentId
        || replay[0].exam_id !== replayIdentity.examId
        || replay[0].follow_up_kind !== replayIdentity.followUpKind) {
        throw new OpsStoreError("考试提醒重放身份不一致。", "invalid_commit_result");
      }
      const { studentRow, taskRow } = visibleRows(replayRows, actor, fullAdmin, session);
      return noStore({
        committed: true,
        applied: false,
        action: replay[0].action,
        commandKey: replay[0].command_key,
        completionCommandKey: replay[0].completion_command_key,
        taskId: replay[0].task_id,
        studentId: replay[0].student_id,
        examId: replay[0].exam_id,
        followUpKind: replay[0].follow_up_kind,
        studentRow,
        taskRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const completionContext = command.action === "undo"
      ? (await getExamFollowUpCompletionContext({
          completionCommandKey: command.completionCommandKey!,
          actor,
        }))[0]
      : undefined;
    const prepared = prepareExamFollowUp({
      command,
      rows,
      actor,
      role: session.role,
      authorization: session,
      fullAdmin,
      completionContext,
    });
    const saved = await mutateExamFollowUpAtomic({ ...prepared, actor });
    if (!saved[0]) throw new OpsStoreError("考试提醒事务没有返回保存结果。", "invalid_commit_result");

    // A concurrent same-key commit returns applied=false before OCC. Re-read
    // so its response cannot reuse the stale pre-ledger authorization snapshot.
    const committedRows = saved[0].applied
      ? rows.map((row) => row.entity === "students"
          ? saved[0].students_row
          : row.entity === "tasks" ? saved[0].tasks_row : row)
      : await getOpsState(["students", "tasks"]);
    const committedIdentity = authorizeExamFollowUpCommand({
      command,
      rows: committedRows,
      actor,
      role: session.role,
      authorization: session,
      fullAdmin,
    });
    if (saved[0].task_id !== committedIdentity.taskId
      || saved[0].student_id !== committedIdentity.studentId
      || saved[0].exam_id !== committedIdentity.examId
      || saved[0].follow_up_kind !== committedIdentity.followUpKind) {
      throw new OpsStoreError("考试提醒提交身份不一致。", "invalid_commit_result");
    }
    const { studentRow, taskRow } = visibleRows(committedRows, actor, fullAdmin, session);
    return noStore({
      committed: true,
      applied: saved[0].applied,
      action: saved[0].action,
      commandKey: saved[0].command_key,
      completionCommandKey: saved[0].completion_command_key,
      taskId: saved[0].task_id,
      studentId: saved[0].student_id,
      examId: saved[0].exam_id,
      followUpKind: saved[0].follow_up_kind,
      studentRow,
      taskRow,
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "考试提醒原子完成数据库合同尚未部署，当前不能写入。",
        code: "exam_follow_up_contract_unavailable",
        requiredRpc: EXAM_FOLLOW_UP_ATOMIC_RPC,
      }, 501);
    }
    if (error instanceof ExamFollowUpServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "学生或任务资料刚刚发生变化，请刷新后重试。", code: "exam_follow_up_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "考试提醒命令编号或完成快照冲突，请刷新后重试。", code: "exam_follow_up_idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "42501") {
      return noStore({ error: "当前账号不能读取或撤销这次考试提醒操作。", code: "exam_follow_up_scope_forbidden" }, 403);
    }
    return noStore({ error: "考试提醒保存失败。" }, 503);
  }
}

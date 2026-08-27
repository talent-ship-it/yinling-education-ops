import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  buildOpsAccessContext,
  canWriteOpsEntity,
  filterOpsStateRows,
  managedTrialPaymentStudentProjectionSnapshot,
} from "@/lib/ops-access";
import {
  completeTrialPaymentTaskAtomic,
  getTrialPaymentCompletionCommandResult,
  getOpsState,
  OpsStoreError,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  parseTrialPaymentCompletionCommand,
  trialPaymentCompletionIntent,
  TrialPaymentTaskServiceError,
} from "@/lib/trial-payment-task-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function serviceError(error: TrialPaymentTaskServiceError) {
  if (error.code === "task_not_found") return noStore({ error: error.message, code: error.code }, 404);
  if (error.code === "task_forbidden") return noStore({ error: error.message, code: error.code }, 403);
  if (error.code === "invalid_shared_state") return noStore({ error: error.message, code: error.code }, 503);
  return noStore({ error: error.message, code: error.code }, 400);
}

function rowsFromResult(result: {
  bookings_row: OpsStateRow;
  students_row: OpsStateRow;
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
  teachers_row: OpsStateRow;
}) {
  const rows = [result.bookings_row, result.students_row, result.lp_items_row, result.tasks_row, result.teachers_row];
  if (rows.some((row) => !row || typeof row !== "object")) {
    throw new OpsStoreError("试听收费确认回执缺少权威状态行。", "invalid_commit_result");
  }
  return rows;
}

function receiptOnly(result: Readonly<{ task_id: string; audit_entry_id: string }>) {
  return noStore({
    committed: true,
    applied: false,
    receiptOnly: true,
    taskId: result.task_id,
    taskRow: null,
    managedTrialPaymentSnapshot: null,
    auditEntryId: result.audit_entry_id,
  });
}

/** Exact task completion; the request never contains a replacement task row. */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const fullAdmin = resolved.session.user === DEMO_ADMIN_USER
    && resolved.session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  const body = await request.json().catch(() => null);
  try {
    const command = parseTrialPaymentCompletionCommand(body);
    const commandIntent = trialPaymentCompletionIntent(command);
    const readCommandReceipt = () => getTrialPaymentCompletionCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      taskId: command.taskId,
      actor: resolved.session.user,
    });
    const replay = await readCommandReceipt();
    if (replay.length > 1) throw new OpsStoreError("试听收费确认回执不唯一。", "invalid_commit_result");
    if (replay[0]) return receiptOnly(replay[0]);

    const authorizationRows = await getOpsState(["bookings", "students", "lpItems", "tasks", "teachers"]);
    const authorization = buildOpsAccessContext(
      authorizationRows,
      resolved.session.user,
      fullAdmin,
      resolved.session,
    );
    const visibleTasks = filterOpsStateRows(authorizationRows, authorization)
      .find((row) => row.entity === "tasks")?.payload;
    const taskVisible = Array.isArray(visibleTasks)
      && visibleTasks.some((candidate) => candidate && typeof candidate === "object"
        && !Array.isArray(candidate) && (candidate as { id?: unknown }).id === command.taskId);
    if (!canWriteOpsEntity(authorization, "tasks") || !taskVisible) {
      // A concurrent first request may have committed after the initial
      // receipt lookup but before this current-state authorization read.
      const lateReplay = await readCommandReceipt();
      if (lateReplay.length > 1) throw new OpsStoreError("试听收费确认回执不唯一。", "invalid_commit_result");
      if (lateReplay[0]) return receiptOnly(lateReplay[0]);
      return noStore({ error: "这项试听收费提醒没有分配给当前账号。", code: "task_forbidden" }, 403);
    }
    const saved = await completeTrialPaymentTaskAtomic({
      commandKey: command.commandKey,
      commandIntent,
      taskId: command.taskId,
      expectedVersions: command.expectedVersions,
      actor: resolved.session.user,
      actorRole: resolved.session.role,
    });
    if (saved.length !== 1) throw new OpsStoreError("试听收费确认回执不完整。", "invalid_commit_result");
    const committedRows = rowsFromResult(saved[0]);
    const access = buildOpsAccessContext(committedRows, resolved.session.user, fullAdmin, resolved.session);
    const visible = filterOpsStateRows(committedRows, access);
    const taskRow = visible.find((row) => row.entity === "tasks");
    const visibleTask = Array.isArray(taskRow?.payload)
      && taskRow.payload.some((candidate) => candidate && typeof candidate === "object"
        && !Array.isArray(candidate) && (candidate as { id?: unknown }).id === saved[0].task_id);
    if (!taskRow || !visibleTask) {
      // The exact command receipt is still authoritative after a planner/task/
      // LP scope change. Do not leak the historic student identity or rows.
      return receiptOnly(saved[0]);
    }
    return noStore({
      committed: true,
      applied: saved[0].applied,
      receiptOnly: false,
      taskId: saved[0].task_id,
      taskRow,
      managedTrialPaymentSnapshot: managedTrialPaymentStudentProjectionSnapshot(committedRows, access),
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof TrialPaymentTaskServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "试听收费资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "42501") {
      return noStore({ error: "这项试听收费提醒没有分配给当前规划老师。", code: "task_forbidden" }, 403);
    }
    if (error instanceof OpsStoreError && error.code === "P0002") {
      return noStore({ error: "没有找到这项试听收费提醒。", code: "task_not_found" }, 404);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "试听收费确认命令与已有回执冲突。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: "试听收费提醒已经完成或当前不能确认。", code: "invalid_completion" }, 409);
    }
    return noStore({ error: "试听收费确认暂时无法提交；没有写入未确认结果。" }, 503);
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { managedTrialPaymentTaskKind } from "@/lib/managed-trial-payment";
import {
  buildOpsAccessContext,
  canWriteOpsTransaction,
  filterOpsStateRows,
  managedTrialPaymentStudentProjectionSnapshot,
} from "@/lib/ops-access";
import {
  getTrialPaymentCompletionCommandResult,
  getTrialPaymentLifecycleCommandResult,
  getOpsState,
  mutateTrialPaymentTaskLifecycleAtomic,
  OpsStoreError,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  parseTrialPaymentLifecycleCommand,
  trialPaymentLifecycleIntent,
  type TrialPaymentLifecycleAction,
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

function receiptOnly(
  result: Readonly<{ task_id: string; audit_entry_id: string }>,
) {
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

function paymentStateFromResult(
  result: Readonly<{ lp_item_id: string; lp_items_row: OpsStateRow }>,
  action: TrialPaymentLifecycleAction,
) {
  const payload = result.lp_items_row.payload;
  const matches = Array.isArray(payload) ? payload.filter((candidate) => candidate
    && typeof candidate === "object" && !Array.isArray(candidate)
    && (candidate as { id?: unknown }).id === result.lp_item_id) : [];
  const expected = action === "complete";
  if (matches.length !== 1 || (matches[0] as { trialPaid?: unknown }).trialPaid !== expected) {
    throw new OpsStoreError("试听收费回执与 LP 付款状态不一致。", "invalid_commit_result");
  }
  return expected ? "paid" as const : "unpaid" as const;
}

/** Exact task lifecycle mutation; the request never contains replacement rows. */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const fullAdmin = hasFullAdminAccess(resolved.session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  const body = await request.json().catch(() => null);
  try {
    const command = parseTrialPaymentLifecycleCommand(body);
    const commandIntent = trialPaymentLifecycleIntent(command);
    const readCommandReceipt = async () => {
      const lifecycle = await getTrialPaymentLifecycleCommandResult({
        commandKey: command.commandKey,
        commandIntent,
        action: command.action,
        taskId: command.taskId,
        actor: resolved.session.user,
      });
      if (lifecycle.length > 1) throw new OpsStoreError("试听收费操作回执不唯一。", "invalid_commit_result");
      if (lifecycle[0]) return lifecycle[0];
      if (command.action !== "complete") return null;
      // Compatibility for a completion command persisted by a tab opened
      // before the lifecycle upgrade.
      const legacy = await getTrialPaymentCompletionCommandResult({
        commandKey: command.commandKey,
        commandIntent,
        taskId: command.taskId,
        actor: resolved.session.user,
      });
      if (legacy.length > 1) throw new OpsStoreError("试听收费确认回执不唯一。", "invalid_commit_result");
      return legacy[0] ?? null;
    };
    const replay = await readCommandReceipt();
    if (replay) return receiptOnly(replay);

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
    const currentTasks = authorizationRows.find((row) => row.entity === "tasks")?.payload;
    const matchingCurrentTasks = Array.isArray(currentTasks)
      ? currentTasks.filter((candidate) => candidate && typeof candidate === "object"
        && !Array.isArray(candidate) && (candidate as { id?: unknown }).id === command.taskId)
      : [];
    const paymentKind = matchingCurrentTasks.length === 1
      ? managedTrialPaymentTaskKind(matchingCurrentTasks[0] as Record<string, unknown>)
      : null;
    if (!canWriteOpsTransaction(authorization, "tasks", ["tasks", "lpItems"])
      || !taskVisible || !paymentKind) {
      // A concurrent first request may have committed after the initial
      // receipt lookup but before this current-state authorization read.
      const lateReplay = await readCommandReceipt();
      if (lateReplay) return receiptOnly(lateReplay);
      return noStore({ error: "这项试听收费提醒没有分配给当前账号。", code: "task_forbidden" }, 403);
    }
    const saved = await mutateTrialPaymentTaskLifecycleAtomic({
      commandKey: command.commandKey,
      commandIntent,
      action: command.action,
      taskId: command.taskId,
      expectedVersions: command.expectedVersions,
      actor: resolved.session.user,
      actorRole: fullAdmin
        ? "admin"
        : resolved.session.role === "admin" ? "limited-admin" : resolved.session.role,
    });
    if (saved.length !== 1 || saved[0].action !== command.action) {
      throw new OpsStoreError("试听收费操作回执不完整。", "invalid_commit_result");
    }
    if (!saved[0].applied) return receiptOnly(saved[0]);
    const committedRows = rowsFromResult(saved[0]);
    paymentStateFromResult(saved[0], command.action);
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
      return noStore({ error: "试听收费操作命令与已有回执冲突。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: "试听收费提醒当前不能执行这项操作。", code: "invalid_lifecycle" }, 409);
    }
    return noStore({ error: "试听收费操作暂时无法提交；没有写入未确认结果。" }, 503);
  }
}

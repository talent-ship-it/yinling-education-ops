import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  operationConfirmationCommandKey,
  operationConfirmationIntent,
  OperationConfirmationError,
  parseConfirmOperationCommand,
  prepareOperationConfirmation,
} from "@/lib/operation-occurrence-service";
import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  confirmOperationOccurrencesAtomic,
  getOperationConfirmationCommandResult,
  getOpsState,
  OPERATION_CONFIRM_ATOMIC_RPC,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function serviceError(error: OperationConfirmationError) {
  if (["teacher_forbidden", "operation_scope_forbidden"].includes(error.code)) return noStore({ error: error.message, code: error.code }, 403);
  if (["operation_not_found", "substitute_not_found"].includes(error.code)) return noStore({ error: error.message, code: error.code }, 404);
  if (["stale_expected_version", "operation_already_confirmed", "affected_occurrence_not_found", "substitute_unavailable", "substitute_conflict"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") return noStore({ error: error.message, code: error.code }, 503);
  return noStore({ error: error.message, code: error.code }, 400);
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能最终确认教务异常。", code: "teacher_forbidden" }, 403);
  const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseConfirmOperationCommand(await request.json().catch(() => null));
    const rows = await getOpsState(["bookings", "operations", "teachers", "students"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session);
    const visibleRows = filterOpsStateRows(rows, access);
    const visibleOperations = visibleRows.find((row) => row.entity === "operations");
    const visibleOperation = Array.isArray(visibleOperations?.payload)
      ? visibleOperations.payload.find((value) => value && typeof value === "object" && !Array.isArray(value) && (value as { id?: unknown }).id === command.operationId) as { studentId?: unknown; confirmationAction?: unknown } | undefined
      : undefined;
    if (!visibleOperation || typeof visibleOperation.studentId !== "string" || !canOperateStudent(access, visibleOperation.studentId)) {
      return noStore({ error: "当前账号不能确认这条异常。", code: "operation_scope_forbidden" }, 403);
    }
    const resolvedChosenTeacherId = command.chosenTeacherId
      ?? (typeof (visibleOperation as { chosenTeacherId?: unknown }).chosenTeacherId === "string"
        ? (visibleOperation as { chosenTeacherId: string }).chosenTeacherId
        : undefined);
    const replayCommand = { operationId: command.operationId, ...(resolvedChosenTeacherId ? { chosenTeacherId: resolvedChosenTeacherId } : {}) };
    const commandKey = operationConfirmationCommandKey(replayCommand);
    const commandIntent = operationConfirmationIntent(replayCommand);
    const replay = await getOperationConfirmationCommandResult({ commandKey, commandIntent, actor });
    if (replay[0]) {
      const currentBookingRow = visibleRows.find((row) => row.entity === "bookings");
      const currentOperationRow = visibleRows.find((row) => row.entity === "operations");
      if (!currentBookingRow || !currentOperationRow) throw new OpsStoreError("异常重放结果不可见。", "invalid_commit_result");
      return noStore({
        committed: true,
        applied: false,
        operationId: replay[0].operation_id,
        action: replay[0].action,
        commandKey: replay[0].command_key,
        affectedOccurrenceIds: replay[0].affected_occurrence_ids,
        bookingRow: currentBookingRow,
        operationRow: currentOperationRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }
    const prepared = prepareOperationConfirmation({ command, rows, actor, fullAdmin, role: session.role, authorization: session });
    const saved = await confirmOperationOccurrencesAtomic({ ...prepared, actor });
    if (!saved[0]) throw new OpsStoreError("异常确认事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "bookings"
      ? saved[0].bookings_row
      : row.entity === "operations" ? saved[0].operations_row : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session);
    const committedVisible = filterOpsStateRows(committedRows, committedAccess);
    return noStore({
      committed: true,
      applied: saved[0].applied,
      operationId: saved[0].operation_id,
      action: saved[0].action,
      commandKey: saved[0].command_key,
      affectedOccurrenceIds: saved[0].affected_occurrence_ids,
      bookingRow: committedVisible.find((row) => row.entity === "bookings"),
      operationRow: committedVisible.find((row) => row.entity === "operations"),
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof OperationConfirmationError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({ error: "异常处理数据库合同尚未部署，当前不能最终确认。", code: "operation_confirmation_contract_unavailable", requiredRpc: OPERATION_CONFIRM_ATOMIC_RPC }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "异常、课程或老师资料刚刚发生变化，请刷新后重试。", code: "operation_confirmation_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个异常确认命令已使用不同内容提交，请刷新后重试。", code: "operation_confirmation_idempotency_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "异常确认失败。" }, 503);
  }
}

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
  getOpsState,
  getTrialLedgerCommandResult,
  mutateTrialLedgerFieldAtomic,
  OpsStoreError,
  TRIAL_LEDGER_COMMAND_RESULT_RPC,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  isTrialLedgerWorkflow,
  parseTrialLedgerCommand,
  TrialLedgerError,
  trialLedgerCommandIntent,
} from "@/lib/trial-ledger";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function records(row: OpsStateRow | undefined) {
  return Array.isArray(row?.payload) ? row.payload.filter(record) : [];
}

function targetStudentId(lpItemsRow: OpsStateRow, lpItemId: string) {
  const item = records(lpItemsRow).find((candidate) => candidate.id === lpItemId);
  if (!item || !isTrialLedgerWorkflow(item)) return null;
  return typeof item.studentId === "string" && item.studentId.trim()
    ? item.studentId.trim()
    : null;
}

function authorize(input: {
  rows: OpsStateRow[];
  actor: string;
  fullAdmin: boolean;
  session: Parameters<typeof buildOpsAccessContext>[3];
  lpItemId: string;
}) {
  const lpItemsRow = input.rows.find((row) => row.entity === "lpItems");
  if (!lpItemsRow) return null;
  const studentId = targetStudentId(lpItemsRow, input.lpItemId);
  if (!studentId) return null;
  const access = buildOpsAccessContext(input.rows, input.actor, input.fullAdmin, input.session);
  if (!canWriteOpsTransaction(access, "lpItems", ["lpItems"])
    || !canOperateStudent(access, studentId)) return null;
  return { access, studentId };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") {
    return noStore({ error: "老师账号不能修改试听台账。", code: "teacher_forbidden" }, 403);
  }
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseTrialLedgerCommand(await request.json().catch(() => null));
    const commandIntent = trialLedgerCommandIntent(command);

    // Recover a committed response before field-OCC validation. This keeps an
    // unknown-result retry idempotent even if later edits changed the same LP.
    const replay = await getTrialLedgerCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (replay[0]) {
      const students = await getOpsState(["students"]);
      const rows = [...students, replay[0].lp_items_row];
      const authorized = authorize({ rows, actor, fullAdmin, session, lpItemId: replay[0].lp_item_id });
      if (!authorized) {
        return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);
      }
      const lpItemsRow = filterOpsStateRows(rows, authorized.access)
        .find((row) => row.entity === "lpItems");
      if (!lpItemsRow) throw new OpsStoreError("试听台账结果不可见。", "invalid_commit_result");
      return noStore({
        committed: true,
        applied: false,
        commandKey: replay[0].command_key,
        lpItemId: replay[0].lp_item_id,
        field: replay[0].field,
        lpItemsRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const rows = await getOpsState(["students", "lpItems"]);
    const authorized = authorize({ rows, actor, fullAdmin, session, lpItemId: command.lpItemId });
    if (!authorized) {
      const exists = records(rows.find((row) => row.entity === "lpItems"))
        .some((item) => item.id === command.lpItemId);
      return noStore({
        error: exists ? "当前账号不能操作该试听学生。" : "试听 LP 不存在。",
        code: exists ? "student_scope_forbidden" : "lp_not_found",
      }, exists ? 403 : 404);
    }

    const saved = await mutateTrialLedgerFieldAtomic({
      commandKey: command.commandKey,
      commandIntent,
      lpItemId: command.lpItemId,
      field: command.field,
      expectedValue: command.expectedValue ?? null,
      value: command.value ?? null,
      actor,
    });
    if (!saved[0]?.lp_items_row) {
      throw new OpsStoreError("试听台账原子事务没有返回完整状态。", "invalid_commit_result");
    }
    const committedRows = rows.map((row) => row.entity === "lpItems" ? saved[0]!.lp_items_row : row);
    const committedAccess = authorize({
      rows: committedRows,
      actor,
      fullAdmin,
      session,
      lpItemId: saved[0].lp_item_id,
    });
    if (!committedAccess) {
      return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);
    }
    const lpItemsRow = filterOpsStateRows(committedRows, committedAccess.access)
      .find((row) => row.entity === "lpItems");
    if (!lpItemsRow) throw new OpsStoreError("试听台账结果不可见。", "invalid_commit_result");
    return noStore({
      committed: true,
      applied: saved[0].applied,
      commandKey: saved[0].command_key,
      lpItemId: saved[0].lp_item_id,
      field: saved[0].field,
      lpItemsRow,
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof TrialLedgerError) {
      return noStore({ error: error.message, code: error.code }, 400);
    }
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({
        error: "试听台账原子数据库合同尚未部署；当前不会降级为整表覆盖写入。",
        code: "trial_ledger_contract_unavailable",
        requiredRpc: TRIAL_LEDGER_COMMAND_RESULT_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001"
      || error.message.includes("trial_ledger_field_conflict"))) {
      return noStore({ error: "这一列刚刚被其他人修改，请刷新后再试。", code: "field_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个台账命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.message.includes("trial_ledger_lp_not_found")) {
      return noStore({ error: "试听 LP 不存在。", code: "lp_not_found" }, 404);
    }
    return noStore({ error: "试听台账保存失败。" }, 503);
  }
}

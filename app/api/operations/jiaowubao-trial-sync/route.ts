import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction, filterOpsStateRows } from "@/lib/ops-access";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getJiaowubaoTrialSyncCommandResult,
  getOpsState,
  JIAOWUBAO_TRIAL_SYNC_ATOMIC_RPC,
  OpsStoreError,
  syncJiaowubaoTrialMatchesAtomic,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  JiaowubaoTrialSyncError,
  jiaowubaoTrialSyncIntent,
  parseJiaowubaoTrialSyncCommand,
} from "@/lib/jiaowubao-trial-sync";
import {
  JiaowubaoTrialSyncProjectionError,
  prepareJiaowubaoTrialSyncProjection,
} from "@/lib/jiaowubao-trial-sync-projection";
import { readJiaowubaoTrialSourceWindow } from "@/lib/jiaowubao-trial-source-window";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function rowsPayload(rows: readonly OpsStateRow[]) {
  return {
    lpItemsRow: rows.find((row) => row.entity === "lpItems") ?? null,
    tasksRow: rows.find((row) => row.entity === "tasks") ?? null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function records(row: OpsStateRow | undefined) {
  return Array.isArray(row?.payload)
    ? row.payload.filter(record)
    : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function authorized(input: Readonly<{
  rows: OpsStateRow[];
  actor: Parameters<typeof buildOpsAccessContext>[1];
  fullAdmin: boolean;
  session: Parameters<typeof buildOpsAccessContext>[3];
  studentIds: readonly string[];
}>) {
  const access = buildOpsAccessContext(input.rows, input.actor, input.fullAdmin, input.session);
  return {
    access,
    allowed: canWriteOpsTransaction(access, "lpItems", ["lpItems", "tasks"])
      && input.studentIds.length > 0
      && input.studentIds.every((studentId) => canOperateStudent(access, studentId)),
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能同步试听 LP。", code: "teacher_forbidden" }, 403);
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const command = parseJiaowubaoTrialSyncCommand(await request.json().catch(() => null));
    const commandIntent = jiaowubaoTrialSyncIntent(command);

    // Replay precedes source and OCC validation so an unknown-result timeout is
    // recoverable even after the immutable source pointer advances.
    const replay = await getJiaowubaoTrialSyncCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (replay[0]) {
      const receipt = replay[0];
      const scopeRows = await getOpsState(["bookings", "students", "teachers"]);
      const currentRows = [...scopeRows, receipt.lp_items_row, receipt.tasks_row];
      const accessResult = authorized({ rows: currentRows, actor, fullAdmin, session, studentIds: receipt.student_ids });
      if (!accessResult.allowed) return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);
      const visible = filterOpsStateRows(currentRows, accessResult.access);
      const payload = rowsPayload(visible);
      if (!payload.lpItemsRow || !payload.tasksRow) throw new OpsStoreError("试听同步结果不可见。", "invalid_commit_result");
      return noStore({
        committed: true,
        applied: false,
        commandKey: receipt.command_key,
        snapshotRevision: receipt.snapshot_revision,
        lpItemIds: receipt.lp_item_ids,
        ...payload,
        auditEntryId: receipt.audit_entry_id,
      });
    }

    const rows = await getOpsState(["bookings", "students", "teachers", "lpItems", "tasks"]);
    const lpRow = rows.find((row) => row.entity === "lpItems");
    const tasksRow = rows.find((row) => row.entity === "tasks");
    if (!lpRow || !tasksRow || lpRow.version !== command.expectedVersions.lpItems
      || tasksRow.version !== command.expectedVersions.tasks) {
      return noStore({ error: "LP 或任务刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    const lpById = new Map(records(lpRow).map((item) => [text(item.id), item]));
    const studentIds = [...command.matches, ...(command.revocations ?? [])]
      .map((match) => text(lpById.get(match.lpItemId)?.studentId));
    if (studentIds.some((studentId) => !studentId)) {
      return noStore({ error: "试听 LP 已不存在。", code: "lp_not_found" }, 404);
    }
    const accessResult = authorized({ rows, actor, fullAdmin, session, studentIds });
    if (!accessResult.allowed) return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);

    const rawEvents = await readJiaowubaoTrialSourceWindow(command.snapshotRevision, command.window);
    const projection = prepareJiaowubaoTrialSyncProjection({
      rows,
      references: command.matches,
      revocations: command.revocations,
      window: command.window,
      rawEvents,
      snapshotRevision: command.snapshotRevision,
      matchedAt: new Date(),
    });
    if (projection.studentIds.some((studentId) => !canOperateStudent(accessResult.access, studentId))) {
      return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);
    }
    const saved = await syncJiaowubaoTrialMatchesAtomic({
      commandKey: command.commandKey,
      commandIntent,
      snapshotRevision: command.snapshotRevision,
      matches: command.matches,
      revocations: command.revocations,
      expectedVersions: command.expectedVersions,
      nextLpItems: projection.nextLpItems,
      nextTasks: projection.nextTasks,
      actor,
    });
    if (!saved[0] || !saved[0].lp_items_row || !saved[0].tasks_row) {
      throw new OpsStoreError("试听原子事务没有返回完整状态。", "invalid_commit_result");
    }
    const result = saved[0];
    const committedRows = rows.map((row) => row.entity === "lpItems"
      ? result.lp_items_row
      : row.entity === "tasks" ? result.tasks_row : row);
    const committedAccess = authorized({ rows: committedRows, actor, fullAdmin, session, studentIds: result.student_ids });
    if (!committedAccess.allowed) return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);
    const payload = rowsPayload(filterOpsStateRows(committedRows, committedAccess.access));
    if (!payload.lpItemsRow || !payload.tasksRow) throw new OpsStoreError("试听同步结果不可见。", "invalid_commit_result");
    return noStore({
      committed: true,
      applied: result.applied,
      commandKey: result.command_key,
      snapshotRevision: result.snapshot_revision,
      lpItemIds: result.lp_item_ids,
      ...payload,
      auditEntryId: result.audit_entry_id,
    });
  } catch (error) {
    if (error instanceof JiaowubaoTrialSyncError) return noStore({ error: error.message, code: error.code }, 400);
    if (error instanceof JiaowubaoTrialSyncProjectionError) {
      const status = error.code === "lp_not_found" ? 404
        : ["source_changed", "source_mismatch", "match_rejected"].includes(error.code) ? 409 : 400;
      return noStore({ error: error.message, code: error.code }, status);
    }
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({
        error: "试听原子同步数据库合同尚未部署；当前不会降级为分散写入。",
        code: "jiaowubao_trial_sync_contract_unavailable",
        requiredRpc: JIAOWUBAO_TRIAL_SYNC_ATOMIC_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "LP 或任务刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个试听同步命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && (error.message.includes("snapshot_current_pointer_conflict")
      || error.message.includes("snapshot_revision_conflict")
      || error.message.includes("jiaowubao_trial_revocation_"))) {
      return noStore({ error: "教务宝课表快照已变化，请刷新后重试。", code: "source_changed" }, 409);
    }
    return noStore({ error: "试听排课同步失败。" }, 503);
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction, filterOpsStateRows } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getJiaowubaoOpenApiScheduleSnapshotWindow,
  getJiaowubaoTrialSyncCommandResult,
  getOpsState,
  JIAOWUBAO_TRIAL_SYNC_COMMAND_RESULT_RPC,
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

function canonicalInstant(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function normalizedSourceEvent(value: unknown) {
  if (!record(value) || typeof value.eventId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.eventId.trim())) return null;
  const startsAt = canonicalInstant(value.startsAt);
  const endsAt = canonicalInstant(value.endsAt);
  if (!startsAt || !endsAt || new Date(endsAt).valueOf() <= new Date(startsAt).valueOf()
    || typeof value.sourceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.sourceDate)
    || (value.courseName !== null && (typeof value.courseName !== "string" || !value.courseName.trim() || value.courseName.trim().length > 240))
    || (value.sourceTeacherId !== null && (typeof value.sourceTeacherId !== "string" || !value.sourceTeacherId.trim() || value.sourceTeacherId.trim().length > 240))
    || (value.sourceTeacherLabel !== null && (typeof value.sourceTeacherLabel !== "string" || !value.sourceTeacherLabel.trim() || value.sourceTeacherLabel.trim().length > 240))
    || !Array.isArray(value.sourceParticipants)
    || value.sourceParticipants.length > 101
    || !value.sourceParticipants.every((participant) => record(participant)
      && (participant.memberId === null || typeof participant.memberId === "string" && Boolean(participant.memberId.trim()))
      && (participant.label === null || typeof participant.label === "string" && Boolean(participant.label.trim()))
      && (participant.memberId !== null || participant.label !== null))
    || typeof value.sourceStudentsTruncated !== "boolean") return null;
  return {
    eventId: value.eventId.trim(),
    sourceDate: value.sourceDate,
    startsAt,
    endsAt,
    courseName: value.courseName === null ? null : value.courseName.trim(),
    sourceTeacherId: value.sourceTeacherId === null ? null : value.sourceTeacherId.trim(),
    sourceTeacherLabel: value.sourceTeacherLabel === null ? null : value.sourceTeacherLabel.trim(),
    sourceParticipants: value.sourceParticipants.map((participant) => {
      const source = participant as Record<string, unknown>;
      return {
        memberId: source.memberId === null ? null : (source.memberId as string).trim(),
        label: source.label === null ? null : (source.label as string).trim(),
      };
    }),
    sourceStudentsTruncated: value.sourceStudentsTruncated,
  };
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

async function readSourceWindow(
  snapshotRevision: string,
  window: Readonly<{ startsAt: string; endsAt: string }>,
) {
  const events: NonNullable<ReturnType<typeof normalizedSourceEvent>>[] = [];
  const seenCursors = new Set<string>();
  let cursor: Readonly<{ startsAt: string; eventId: string }> | null = null;
  for (let pageIndex = 0; pageIndex < 800; pageIndex += 1) {
    const page = await getJiaowubaoOpenApiScheduleSnapshotWindow({
      windowStart: window.startsAt,
      windowEnd: window.endsAt,
      scope: "all",
      teacherLabels: null,
      studentMemberIds: null,
      studentNameKeys: null,
      limit: 250,
      cursor,
      revision: snapshotRevision,
    });
    if (page.state !== "complete" || page.freshness !== "fresh" || page.revision !== snapshotRevision) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝课表快照已变化或过期，请刷新后重试。");
    }
    const normalized = Array.isArray(page.events) ? page.events.map(normalizedSourceEvent) : [];
    if (normalized.some((event) => event === null)) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课资料格式已变化，请刷新后重试。");
    }
    events.push(...normalized as NonNullable<(typeof normalized)[number]>[]);
    if (!page.hasMore) {
      if (new Set(events.map((event) => event.eventId)).size !== events.length) {
        throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课身份重复，请刷新后重试。");
      }
      return events;
    }
    if (!page.nextCursor) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课分页不完整，请刷新后重试。");
    }
    const cursorKey = `${page.nextCursor.startsAt}\u0000${page.nextCursor.eventId}`;
    if (seenCursors.has(cursorKey)) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课分页重复，请刷新后重试。");
    }
    seenCursors.add(cursorKey);
    cursor = page.nextCursor;
  }
  throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课超过安全分页上限。");
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能同步试听 LP。", code: "teacher_forbidden" }, 403);
  const fullAdmin = actor === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

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
    const studentIds = command.matches.map((match) => text(lpById.get(match.lpItemId)?.studentId));
    if (studentIds.some((studentId) => !studentId)) {
      return noStore({ error: "试听 LP 已不存在。", code: "lp_not_found" }, 404);
    }
    const accessResult = authorized({ rows, actor, fullAdmin, session, studentIds });
    if (!accessResult.allowed) return noStore({ error: "当前账号不能操作该试听学生。", code: "student_scope_forbidden" }, 403);

    const rawEvents = await readSourceWindow(command.snapshotRevision, command.window);
    const projection = prepareJiaowubaoTrialSyncProjection({
      rows,
      references: command.matches,
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
        requiredRpc: JIAOWUBAO_TRIAL_SYNC_COMMAND_RESULT_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "LP 或任务刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个试听同步命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && (error.message.includes("snapshot_current_pointer_conflict")
      || error.message.includes("snapshot_revision_conflict"))) {
      return noStore({ error: "教务宝课表快照已变化，请刷新后重试。", code: "source_changed" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "试听排课同步失败。" }, 503);
  }
}

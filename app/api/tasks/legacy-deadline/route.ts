import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getLegacyTaskDeadlineCommandResult,
  getOpsState,
  LEGACY_TASK_DEADLINE_ATOMIC_RPC,
  LEGACY_TASK_DEADLINE_COMMAND_RESULT_RPC,
  mutateLegacyTaskDeadlineAtomic,
  OpsStoreError,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  authorizeLegacyTaskDeadlineCommand,
  legacyTaskDeadlineIntent,
  parseLegacyTaskDeadlineCommand,
  prepareLegacyTaskDeadline,
  hasLegacyTaskDeadlineAdminAccess,
  LegacyTaskDeadlineServiceError,
} from "@/lib/legacy-task-deadline-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 1_024;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function requireHighTierAdmin() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  }
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasLegacyTaskDeadlineAdminAccess(session.user, fullAdmin)
      || !hasDemoSessionPermission(session, "operations.write")
      || !hasUnrestrictedDemoSessionScope(session)) {
    return { response: noStore({ error: "只有教务管理员可以补写历史任务的截止时间。" }, 403) } as const;
  }
  return { session: { actor: session.user, role: session.role, fullAdmin } } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function taskRow(rows: readonly OpsStateRow[]) {
  const row = rows.find((candidate) => candidate.entity === "tasks");
  if (!row) throw new OpsStoreError("任务资料不可用。", "legacy_task_deadline_tasks_missing");
  return row;
}

async function currentTaskRow() {
  const rows = await getOpsState(["tasks"]);
  return taskRow(rows);
}

async function readBoundedRequestBody(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LegacyTaskDeadlineRequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

class LegacyTaskDeadlineRequestTooLargeError extends Error {}

function serviceError(error: LegacyTaskDeadlineServiceError) {
  if (error.code === "teacher_forbidden" || error.code === "admin_forbidden" || error.code === "archived_student_read_only") {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (error.code === "task_not_found") return noStore({ error: error.message, code: error.code }, 404);
  if (["stale_expected_version", "task_not_legacy", "task_closed"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") return noStore({ error: error.message, code: error.code }, 503);
  return noStore({ error: error.message, code: error.code }, 422);
}

function contractUnavailable() {
  return noStore({
    error: "历史任务截止时间数据库合同尚未部署，当前不能写入。",
    code: "legacy_task_deadline_contract_unavailable",
    requiredRpcs: [
      LEGACY_TASK_DEADLINE_COMMAND_RESULT_RPC,
      LEGACY_TASK_DEADLINE_ATOMIC_RPC,
    ],
  }, 501);
}

/**
 * Writes one explicit exact deadline only for a server-authorized legacy task.
 * The database derives the task projection under students -> tasks locks and
 * appends the audit receipt in the same transaction.
 */
export async function POST(request: Request) {
  const access = await requireHighTierAdmin();
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "历史任务截止时间命令不能超过 1 KB。" }, 413);
  }

  try {
    const raw = await readBoundedRequestBody(request);
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return noStore({ error: "历史任务截止时间命令必须是有效 JSON。" }, 400);
    }
    const command = parseLegacyTaskDeadlineCommand(input);
    const rows = await getOpsState(["students", "tasks"]);
    // This fresh authorization also runs before a replay response. A prior
    // receipt never revives access to a now-archived or rule-managed task.
    authorizeLegacyTaskDeadlineCommand({
      command,
      rows,
      actor: access.session.actor,
      role: access.session.role,
      fullAdmin: access.session.fullAdmin,
    });
    const commandIntent = legacyTaskDeadlineIntent(command);
    const replay = await getLegacyTaskDeadlineCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor: access.session.actor,
    });
    if (replay[0]) {
      return noStore({
        committed: true,
        applied: false,
        ...(replay[0].applied ? {} : { unchanged: true }),
        action: replay[0].action,
        taskId: replay[0].task_id,
        dueAt: replay[0].due_at,
        taskRow: taskRow(rows),
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const prepared = prepareLegacyTaskDeadline({
      command,
      rows,
      actor: access.session.actor,
      role: access.session.role,
      fullAdmin: access.session.fullAdmin,
    });
    const saved = await mutateLegacyTaskDeadlineAtomic({
      commandKey: prepared.commandKey,
      commandIntent: prepared.commandIntent,
      expectedVersions: prepared.expectedVersions,
      actor: access.session.actor,
    });
    if (!saved[0]) throw new OpsStoreError("历史任务截止时间原子命令没有返回结果。", "invalid_commit_result");
    return noStore({
      committed: true,
      applied: saved[0].applied,
      ...(!saved[0].applied ? { unchanged: true } : {}),
      action: saved[0].action,
      taskId: saved[0].task_id,
      dueAt: saved[0].due_at,
      taskRow: saved[0].task_row,
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof LegacyTaskDeadlineRequestTooLargeError) {
      return noStore({ error: "历史任务截止时间命令不能超过 1 KB。" }, 413);
    }
    if (missingRpc(error)) return contractUnavailable();
    if (error instanceof LegacyTaskDeadlineServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      const latest = await currentTaskRow().catch(() => undefined);
      return noStore({
        error: "学生或任务资料刚刚发生变化，请刷新后重试。",
        code: "legacy_task_deadline_conflict",
        ...(latest ? { taskRow: latest } : {}),
      }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "P0002") {
      return noStore({ error: "没有找到该任务，请刷新后重试。", code: "task_not_found" }, 404);
    }
    if (error instanceof OpsStoreError && error.code === "42501") {
      return noStore({ error: "历史归档学生的任务不能修改。", code: "archived_student_read_only" }, 403);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "这项截止时间命令与已保存记录不一致，请刷新后重试。", code: "legacy_task_deadline_idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: "截止时间命令无效、没有变化，或任务已不适合手动修改。", code: "invalid_legacy_task_deadline_command" }, 422);
    }
    return noStore({ error: "历史任务截止时间暂时无法保存；没有写入未确认的结果。" }, 503);
  }
}

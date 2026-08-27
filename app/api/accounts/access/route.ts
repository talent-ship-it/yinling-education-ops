import { NextResponse } from "next/server";

import {
  ACCOUNT_COMMAND_KEY_PATTERN,
} from "@/lib/account-credentials";
import { isAccountRole } from "@/lib/account-directory";
import { resolveAccountRequestContext } from "@/lib/account-request-context";
import {
  getAccountDirectory,
  getOpsState,
  OpsStoreError,
  type OpsStateRow,
  updateAccountAccess,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_PERMISSIONS = new Set([
  "operations.read",
  "operations.write",
  "students.read.assigned",
  "bookings.read.assigned",
  "bookings.write.assigned",
  "messages.write.assigned",
  "availability.write.self",
]);

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function parsePermissionOverrides(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > ALLOWED_PERMISSIONS.size
      || entries.some(([key, allowed]) => !ALLOWED_PERMISSIONS.has(key) || typeof allowed !== "boolean")) return null;
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function parseScopeMembers(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) return null;
  const parsed: Array<{ kind: "student" | "teacher" | "entity"; key: string }> = [];
  let unrestricted = false;
  for (const member of value) {
    if (!member || typeof member !== "object" || Array.isArray(member)) return null;
    const record = member as Record<string, unknown>;
    const keys = Object.keys(record);
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (keys.every((item) => item === "kind" || item === "key")
        && record.kind === "all" && key === "*") {
      if (unrestricted) return null;
      unrestricted = true;
      continue;
    }
    if (keys.some((item) => item !== "kind" && item !== "key")
        || (record.kind !== "student" && record.kind !== "teacher" && record.kind !== "entity")
        || !key || Array.from(key).length > 240) return null;
    parsed.push({ kind: record.kind, key });
  }
  if (unrestricted && parsed.length > 0) return null;
  // Effective scope exposes all:*; an empty stored scope is its canonical form.
  return parsed;
}

function idsFromPayload(rows: OpsStateRow[], entity: "students" | "teachers") {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  if (!Array.isArray(payload)) return new Set<string>();
  return new Set(payload.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }));
}

function validateScopeMembers(
  members: readonly { kind: "student" | "teacher" | "entity"; key: string }[],
  rows: OpsStateRow[],
) {
  const studentIds = idsFromPayload(rows, "students");
  const teacherIds = idsFromPayload(rows, "teachers");
  const entities = new Set([...rows.map((row) => row.entity), "audit", "payroll"]);
  const seen = new Set<string>();
  for (const member of members) {
    const signature = `${member.kind}:${member.key}`;
    if (seen.has(signature)) return "数据范围成员不能重复。";
    seen.add(signature);
    const valid = member.kind === "student"
      ? studentIds.has(member.key)
      : member.kind === "teacher"
        ? teacherIds.has(member.key)
        : entities.has(member.key);
    if (!valid) return member.kind === "entity"
      ? `未找到业务实体 ${member.key}。`
      : `未找到${member.kind === "student" ? "学生" : "老师"}系统 ID ${member.key}。`;
  }
  return null;
}

export async function POST(request: Request) {
  const resolved = await resolveAccountRequestContext();
  if (!("context" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { context } = resolved;
  if (!context.fullAdmin) return noStore({ error: "仅超级管理员可以调整账号权限。" }, 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const commandKey = typeof body?.commandKey === "string" ? body.commandKey.trim().toLowerCase() : "";
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  const permissionOverrides = parsePermissionOverrides(body?.permissionOverrides);
  const scopeMembers = parseScopeMembers(body?.scopeMembers);
  if (!ACCOUNT_COMMAND_KEY_PATTERN.test(commandKey) || !commandKey.startsWith("account-access:")
      || !UUID_PATTERN.test(accountId) || !isAccountRole(body?.accountRole)
      || !Number.isSafeInteger(body?.expectedRoleVersion) || Number(body?.expectedRoleVersion) < 1
      || !Number.isSafeInteger(body?.expectedScopeVersion) || Number(body?.expectedScopeVersion) < 1
      || !permissionOverrides || !scopeMembers) {
    return noStore({ error: "账号权限命令无效。" }, 400);
  }

  try {
    const [directory, opsRows] = await Promise.all([
      getAccountDirectory(context.session.accountId),
      getOpsState(),
    ]);
    const target = directory.find((account) => account.account_id === accountId);
    if (!target) return noStore({ error: "未找到该账号。" }, 404);
    if (target.super_admin) return noStore({ error: "超级管理员权限不能在这里修改。" }, 403);
    if (target.credential_version === null) {
      return noStore({
        error: "请先为该账号重置临时密码；建立独立密码后才能修改权限与范围。",
        code: "independent_password_required",
      }, 409);
    }
    if (body.accountRole !== target.account_role) {
      return noStore({ error: "现阶段账号角色与登录名绑定；请新建对应角色账号，不会原地改写角色。", code: "role_change_unsupported" }, 409);
    }
    const invalidScope = validateScopeMembers(scopeMembers, opsRows);
    if (invalidScope) return noStore({ error: invalidScope, code: "invalid_scope_member" }, 400);
    const result = await updateAccountAccess({
      commandKey,
      accountId,
      accountRole: target.account_role,
      permissionOverrides,
      scopeMembers,
      expectedRoleVersion: Number(body.expectedRoleVersion),
      expectedScopeVersion: Number(body.expectedScopeVersion),
      actorAccountId: context.session.accountId,
    });
    if (!result) throw new OpsStoreError("账号权限更新未返回结果。", "invalid_commit_result");
    return noStore({ ok: true, result });
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message.includes("version_conflict"))) {
      return noStore({ error: "账号权限刚刚已更新，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "该权限命令已用于其他内容，请重新提交。", code: "idempotency_conflict" }, 409);
    }
    return noStore({ error: "账号权限暂时无法更新，请稍后重试。" }, 503);
  }
}

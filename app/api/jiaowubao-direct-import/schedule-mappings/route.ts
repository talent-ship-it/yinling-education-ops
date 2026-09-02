import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getJiaowubaoDirectScheduleMappingReview,
  OpsStoreError,
  putJiaowubaoDirectScheduleMapping,
  JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PUT_RPC,
  JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_REVIEW_RPC,
} from "@/lib/ops-store";
import { hasTeacherImportAdminAccess } from "@/lib/teacher-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_LIMIT = 80;
const MAX_REQUEST_BYTES = 1_024;
const OPAQUE_MAPPING_KEY = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class InvalidScheduleMappingRequest extends Error {}
class ScheduleMappingRequestTooLargeError extends Error {}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function requireHighTierAdmin(permission: "operations.read" | "operations.write") {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  }
  const { session } = resolved;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasTeacherImportAdminAccess(session.user, fullAdmin)
      || !hasDemoSessionPermission(session, permission)
      || !hasUnrestrictedDemoSessionScope(session)) {
    return { response: noStore({ error: "只有教务管理员可以确认教务宝老师与课程映射。" }, 403) } as const;
  }
  return { actor: session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function statementTimedOut(error: unknown) {
  return error instanceof OpsStoreError && error.code === "57014";
}

function contractUnavailable() {
  return noStore({
    error: "教务宝老师与课程映射数据库合同尚未部署。",
    code: "jiaowubao_schedule_mapping_contract_unavailable",
    requiredRpcs: [
      JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_REVIEW_RPC,
      JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PUT_RPC,
    ],
  }, 501);
}

function cursorFromRequest(request: Request) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "cursor") throw new InvalidScheduleMappingRequest("教务宝映射列表参数无效。");
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !OPAQUE_MAPPING_KEY.test(cursor)) {
    throw new InvalidScheduleMappingRequest("教务宝映射分页游标无效，请重新读取列表。");
  }
  return cursor;
}

function text(value: unknown, label: string, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 240) {
    throw new InvalidScheduleMappingRequest(`${label}无效。`);
  }
  return value;
}

function parseCommand(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidScheduleMappingRequest("教务宝映射确认请求必须是有效 JSON。");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "mappingKey",
    "commandKey",
    "action",
    "targetTeacherId",
    "targetSubjectId",
    "expectedTeachersVersion",
  ]);
  if (Object.keys(input).length !== allowed.size || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new InvalidScheduleMappingRequest("教务宝映射确认只接受当前候选、目标老师和目标科目。");
  }
  const mappingKey = text(input.mappingKey, "映射候选")!;
  const commandKey = text(input.commandKey, "确认命令")!;
  if (!OPAQUE_MAPPING_KEY.test(mappingKey) || !UUID.test(commandKey)) {
    throw new InvalidScheduleMappingRequest("教务宝映射确认令牌无效，请刷新后重试。");
  }
  if (input.action !== "confirm" && input.action !== "revoke") {
    throw new InvalidScheduleMappingRequest("教务宝映射操作无效。");
  }
  if (!Number.isSafeInteger(input.expectedTeachersVersion) || (input.expectedTeachersVersion as number) < 0) {
    throw new InvalidScheduleMappingRequest("老师资料版本无效，请刷新后重试。");
  }
  const targetTeacherId = text(input.targetTeacherId, "目标老师", true);
  const targetSubjectId = text(input.targetSubjectId, "目标科目", true);
  if (input.action === "confirm" && (!targetTeacherId || !targetSubjectId)) {
    throw new InvalidScheduleMappingRequest("确认映射必须选择当前老师和其可教科目。");
  }
  if (input.action === "revoke" && (targetTeacherId !== null || targetSubjectId !== null)) {
    throw new InvalidScheduleMappingRequest("撤销映射不能附带老师或科目。");
  }
  return {
    mappingKey,
    commandKey,
    action: input.action,
    targetTeacherId,
    targetSubjectId,
    expectedTeachersVersion: input.expectedTeachersVersion as number,
  } as const;
}

/** Stops consuming a chunked body as soon as it exceeds the command contract. */
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
        throw new ScheduleMappingRequestTooLargeError("教务宝映射确认请求不能超过 1 KB。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** High-tier, server-only reader for paged source-label mapping candidates. */
export async function GET(request: Request) {
  const access = await requireHighTierAdmin("operations.read");
  if ("response" in access) return access.response;
  try {
    const cursor = cursorFromRequest(request);
    return noStore(await getJiaowubaoDirectScheduleMappingReview({ cursor, limit: PAGE_LIMIT }));
  } catch (error) {
    if (missingRpc(error)) return contractUnavailable();
    // PostgreSQL SQLSTATE 57014 is a cancelled read, never a mapping write.
    // Give the high-tier UI a safe actionable result instead of treating it as
    // an unexplained generic 503 or returning raw database error text.
    if (statementTimedOut(error)) {
      return noStore({
        error: "教务宝映射候选读取超时；本次只读操作没有写入任何映射，请刷新重试。",
        code: "jiaowubao_schedule_mapping_read_timeout",
      }, 503);
    }
    if (error instanceof InvalidScheduleMappingRequest
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({ error: "教务宝映射请求无效。", code: "invalid_jiaowubao_schedule_mapping_request" }, 400);
    }
    return noStore({
      error: "教务宝映射候选暂时无法读取；没有显示或写入任何推断结果。",
      code: "jiaowubao_schedule_mapping_read_unavailable",
    }, 503);
  }
}

/**
 * Writes one append-only confirmation or revocation. Source labels, run/event
 * IDs, AVA flags and every business operation remain server-owned and absent
 * from the browser request.
 */
export async function POST(request: Request) {
  const access = await requireHighTierAdmin("operations.write");
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "教务宝映射确认请求不能超过 1 KB。" }, 413);
  }

  try {
    const raw = await readBoundedRequestBody(request);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new InvalidScheduleMappingRequest("教务宝映射确认请求必须是有效 JSON。");
    }
    const command = parseCommand(payload);
    const saved = await putJiaowubaoDirectScheduleMapping({ ...command, actor: access.actor });
    return noStore({ saved: true, ...saved });
  } catch (error) {
    if (missingRpc(error)) return contractUnavailable();
    if (error instanceof ScheduleMappingRequestTooLargeError) {
      return noStore({ error: error.message }, 413);
    }
    if (error instanceof InvalidScheduleMappingRequest
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({ error: "教务宝映射命令无效。", code: "invalid_jiaowubao_schedule_mapping_command" }, 422);
    }
    if (error instanceof OpsStoreError
      && (["23503", "23505", "40001"].includes(error.code ?? "")
        || error.message.startsWith("jiaowubao_schedule_mapping_"))) {
      return noStore({
        error: "教务宝来源或老师科目资料刚刚变化，请刷新候选后重新确认。",
        code: "jiaowubao_schedule_mapping_conflict",
      }, 409);
    }
    return noStore({
      error: "教务宝映射确认失败。",
    }, 503);
  }
}

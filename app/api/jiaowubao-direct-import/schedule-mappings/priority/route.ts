import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getJiaowubaoDirectScheduleMappingPriorityReview,
  JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PRIORITY_REVIEW_RPC,
  OpsStoreError,
} from "@/lib/ops-store";
import { hasTeacherImportAdminAccess } from "@/lib/teacher-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_LIMIT = 80;
const PRIORITY_WINDOW_MS = 63 * 24 * 60 * 60 * 1_000;
const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE_MAPPING_KEY = /^sha256:[a-f0-9]{64}$/;

class InvalidPriorityMappingRequest extends Error {}

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
  if (!hasTeacherImportAdminAccess(session.user, fullAdmin)) {
    return { response: noStore({ error: "只有教务管理员可以查看当前教务宝映射待核对队列。" }, 403) } as const;
  }
  return { ok: true } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function statementTimedOut(error: unknown) {
  return error instanceof OpsStoreError && error.code === "57014";
}

function contractUnavailable() {
  return noStore({
    error: "当前教务宝映射待核对数据库合同尚未部署。",
    code: "jiaowubao_schedule_mapping_priority_contract_unavailable",
    requiredRpcs: [JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PRIORITY_REVIEW_RPC],
  }, 501);
}

function parseCanonicalMidnight(value: string | null, field: string) {
  if (!value || !CANONICAL_UTC_INSTANT.test(value)) {
    throw new InvalidPriorityMappingRequest(`${field} 必须使用 UTC ISO 时间。`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value
    || parsed.getUTCHours() !== 0 || parsed.getUTCMinutes() !== 0
    || parsed.getUTCSeconds() !== 0 || parsed.getUTCMilliseconds() !== 0) {
    throw new InvalidPriorityMappingRequest(`${field} 必须是 UTC 零点。`);
  }
  return parsed.toISOString();
}

/**
 * The queue uses source *start* instants in `[windowStart, windowEnd)`, not
 * interval overlap.  That matches its immutable UTC-day projection and makes
 * every cursor stable without passing raw source filters from the browser.
 */
function requestWindow(request: Request) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "windowStart" && key !== "windowEnd" && key !== "cursor") {
      throw new InvalidPriorityMappingRequest("当前教务宝映射待核对参数无效。");
    }
  }
  const windowStart = parseCanonicalMidnight(url.searchParams.get("windowStart"), "windowStart");
  const windowEnd = parseCanonicalMidnight(url.searchParams.get("windowEnd"), "windowEnd");
  if (new Date(windowEnd).getTime() - new Date(windowStart).getTime() !== PRIORITY_WINDOW_MS) {
    throw new InvalidPriorityMappingRequest("当前教务宝映射待核对固定读取连续 63 天。");
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !OPAQUE_MAPPING_KEY.test(cursor)) {
    throw new InvalidPriorityMappingRequest("当前教务宝映射待核对分页游标无效，请重新读取列表。");
  }
  return { windowStart, windowEnd, cursor } as const;
}

/**
 * High-tier, server-only current/future mapping action queue.  It exposes no
 * run ID, source event ID, workbook coordinate, raw payload, or raw filter;
 * all relevance and priority calculations stay inside the reviewed RPC.
 */
export async function GET(request: Request) {
  const access = await requireHighTierAdmin();
  if ("response" in access) return access.response;

  try {
    const input = requestWindow(request);
    return noStore(await getJiaowubaoDirectScheduleMappingPriorityReview({
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      cursor: input.cursor,
      limit: PAGE_LIMIT,
    }));
  } catch (error) {
    if (missingRpc(error)) return contractUnavailable();
    if (statementTimedOut(error)) {
      return noStore({
        error: "当前教务宝映射待核对读取超时；这是只读操作，没有写入任何映射。",
        code: "jiaowubao_schedule_mapping_priority_read_timeout",
      }, 503);
    }
    if (error instanceof InvalidPriorityMappingRequest
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({ error: error.message, code: "invalid_jiaowubao_schedule_mapping_priority_request" }, 400);
    }
    return noStore({
      error: "当前教务宝映射待核对暂时无法读取；没有显示或写入任何推断结果。",
      code: "jiaowubao_schedule_mapping_priority_read_unavailable",
    }, 503);
  }
}

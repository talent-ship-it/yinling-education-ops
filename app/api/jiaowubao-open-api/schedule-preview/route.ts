import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  DEMO_LIMITED_ADMIN_USER,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import {
  JiaowubaoOpenApiError,
  queryJiaowubaoScheduleList,
} from "@/lib/jiaowubao-open-api";
import { buildOpsAccessContext } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 31;
// This is a human review surface, not a bulk-export endpoint. Keeping the
// offset bounded prevents a browser request from turning into an expensive
// upstream scan; the server-side export workflow owns any future bulk pull.
const MAX_PAGE = 500;
const MAX_LIMIT = 100;
const PREVIEW_WINDOW_MS = 60_000;
const MAX_PREVIEW_REQUESTS_PER_WINDOW = 8;
const previewRequestsByActor = new Map<string, number[]>();

type RecordValue = Record<string, unknown>;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function text(value: unknown, max = 180) {
  const source = typeof value === "string"
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
  if (source === null) return null;
  const trimmed = source.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/.test(value.trim())
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function decimal(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function flag(value: unknown) {
  if (value === 0 || value === "0" || value === false) return false;
  if (value === 1 || value === "1" || value === true) return true;
  return null;
}

function dateParameter(value: string | null, field: string) {
  if (!value || !DATE.test(value)) return { error: `${field} 必须使用 YYYY-MM-DD。` } as const;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    return { error: `${field} 无效。` } as const;
  }
  return { value } as const;
}

function boundedIntegerParameter(value: string | null, field: string, minimum: number, maximum: number) {
  if (value === null || value === "") return { value: undefined } as const;
  const parsed = integer(value, minimum, maximum);
  return parsed === null ? { error: `${field} 无效。` } as const : { value: parsed } as const;
}

function optionalFilter(
  searchParams: URLSearchParams,
  field: string,
  minimum: number,
  maximum: number,
) {
  return boundedIntegerParameter(searchParams.get(field), field, minimum, maximum);
}

function optionalEnumFilter(
  searchParams: URLSearchParams,
  field: string,
  allowed: readonly number[],
) {
  const raw = searchParams.get(field);
  if (raw === null || raw === "") return { value: undefined } as const;
  const parsed = integer(raw, Math.min(...allowed), Math.max(...allowed));
  return parsed === null || !allowed.includes(parsed)
    ? { error: `${field} 无效。` } as const
    : { value: parsed } as const;
}

function parameterValue(parameter: { value?: number } | { error: string }) {
  return "value" in parameter ? parameter.value : undefined;
}

/**
 * Keep the browser response deliberately smaller than the JWB record. In
 * particular, never copy `stu_list`, student names/logos, notes, or pricing
 * fields into this DTO. The API client remains server-only and owns the sk.
 */
function projectSchedule(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const projected: RecordValue = {
    calId: text(source.cal_id, 120),
    type: integer(source.type, 0, 10),
    appoint: integer(source.appoint, -1, 1),
    teamId: text(source.team_id, 120),
    teamTitle: text(source.team_title, 180),
    courseId: text(source.course_id, 120),
    courseTitle: text(source.course_title, 180),
    roomId: text(source.room_id, 120),
    roomTitle: text(source.room_title, 180),
    teacherId: text(source.teacher_id, 120),
    teacherTitle: text(source.teacher_title, 180),
    teacherAssistantId: text(source.teacher_s, 120),
    teacherThirdId: text(source.teacher_t, 120),
    date: text(source.dated, 32),
    start: text(source.time_start, 16),
    end: text(source.time_end, 16),
    durationMinutes: integer(source.cal_length, 0, 24 * 60),
    hours: decimal(source.hours, 0, 1_000),
    createdAt: text(source.created, 64),
    live: flag(source.live),
    maxNum: integer(source.max_num ?? source.mem_max, 0, 100_000),
    studentCount: integer(source.mem_num, 0, 100_000),
    signedCount: integer(source.mem_num_sign, 0, 100_000),
    notSignedCount: integer(source.mem_num_not_sign, 0, 100_000),
    leaveCount: integer(source.mem_num_leave ?? source.mem_leave, 0, 100_000),
    arrivedCount: integer(source.mem_arrive, 0, 100_000),
    arrivalPercent: text(source.arrive_percent, 16),
    notCommentCount: integer(source.mem_not_comment, 0, 100_000),
    allLeave: flag(source.all_leave),
    completed: flag(source.over),
    completionState: integer(source.over_state, 0, 3),
    completedAt: text(source.over_time, 32),
  };
  return Object.fromEntries(Object.entries(projected).filter(([, field]) => field !== null));
}

function safeTotal(value: unknown) {
  return integer(value, 0, 1_000_000);
}

/**
 * This protects the read-heavy admin route on one Vercel instance. The
 * server-only client still serialises upstream starts and handles 429 because
 * an in-memory map cannot be a cross-instance quota authority.
 */
function consumePreviewRequest(actor: string) {
  const now = Date.now();
  const cutoff = now - PREVIEW_WINDOW_MS;
  for (const [key, timestamps] of previewRequestsByActor) {
    const current = timestamps.filter((timestamp) => timestamp > cutoff);
    if (current.length) previewRequestsByActor.set(key, current);
    else previewRequestsByActor.delete(key);
  }
  const timestamps = previewRequestsByActor.get(actor) ?? [];
  if (timestamps.length >= MAX_PREVIEW_REQUESTS_PER_WINDOW) return false;
  timestamps.push(now);
  previewRequestsByActor.set(actor, timestamps);
  return true;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const start = dateParameter(url.searchParams.get("start"), "start");
  const end = dateParameter(url.searchParams.get("end"), "end");
  if ("error" in start) return noStore({ error: start.error }, 400);
  if ("error" in end) return noStore({ error: end.error }, 400);

  const startMs = Date.parse(`${start.value}T00:00:00.000Z`);
  const endMs = Date.parse(`${end.value}T00:00:00.000Z`);
  if (endMs < startMs) return noStore({ error: "end 必须不早于 start。" }, 400);
  if (endMs - startMs > (MAX_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1_000) {
    return noStore({ error: `教务宝排课预览最多读取 ${MAX_WINDOW_DAYS} 天。` }, 400);
  }

  const page = boundedIntegerParameter(url.searchParams.get("page"), "page", 1, MAX_PAGE);
  const limit = boundedIntegerParameter(url.searchParams.get("limit"), "limit", 1, MAX_LIMIT);
  const calType = optionalEnumFilter(url.searchParams, "cal_type", [1, 3]);
  const hiddenLeave = optionalEnumFilter(url.searchParams, "hidden_leave", [-1, 1]);
  const appoint = optionalEnumFilter(url.searchParams, "appoint", [-1, 0, 1]);
  const week = optionalFilter(url.searchParams, "week", 0, 6);
  const over = optionalEnumFilter(url.searchParams, "over", [0, 1]);
  for (const parameter of [page, limit, calType, hiddenLeave, appoint, week, over]) {
    if ("error" in parameter) return noStore({ error: parameter.error }, 400);
  }
  const pageNumber = parameterValue(page) ?? 1;
  const limitNumber = parameterValue(limit) ?? MAX_LIMIT;
  const calTypeValue = parameterValue(calType);
  const hiddenLeaveValue = parameterValue(hiddenLeave);
  const appointValue = parameterValue(appoint);
  const weekValue = parameterValue(week);
  const overValue = parameterValue(over);
  const orderValue = url.searchParams.get("order") ?? "asc";
  if (orderValue !== "asc" && orderValue !== "desc") {
    return noStore({ error: "order 只能是 asc 或 desc。" }, 400);
  }

  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  // Avoid loading the full operational state for ordinary staff/teacher
  // sessions. `buildOpsAccessContext` below remains the authoritative second
  // gate after the minimal identity check.
  const limitedAdminSession = session.user === DEMO_LIMITED_ADMIN_USER
    && session.role === "limited-admin";
  if (!fullAdmin && !limitedAdminSession) {
    return noStore({ error: "只有管理员可以查看教务宝排课预览。" }, 403);
  }
  if (!consumePreviewRequest(session.user)) {
    return noStore({
      error: "教务宝排课预览请求过于频繁，请稍后再试。",
      code: "jiaowubao_open_api_preview_rate_limited",
    }, 429);
  }

  try {
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session.role);
    if (!access.fullAdmin && !access.limitedAdmin) {
      return noStore({ error: "只有管理员可以查看教务宝排课预览。" }, 403);
    }
    const response = await queryJiaowubaoScheduleList({
      page: pageNumber,
      limit: limitNumber,
      start: start.value,
      end: end.value,
      ...(calTypeValue === undefined ? {} : { cal_type: calTypeValue }),
      ...(hiddenLeaveValue === undefined ? {} : { hidden_leave: hiddenLeaveValue }),
      ...(appointValue === undefined ? {} : { appoint: appointValue }),
      ...(weekValue === undefined ? {} : { week: weekValue }),
      ...(overValue === undefined ? {} : { over: overValue }),
      order: orderValue,
    });
    const payload = record(response);
    const sourceLists = payload && Array.isArray(payload.lists) ? payload.lists : [];
    const items = sourceLists.map(projectSchedule).filter((item): item is RecordValue => item !== null);
    const total = safeTotal(payload?.total ?? payload?.count);
    return noStore({
      page: pageNumber,
      limit: limitNumber,
      start: start.value,
      end: end.value,
      items,
      ...(total === null ? {} : { total, hasMore: pageNumber * limitNumber < total }),
    });
  } catch (error) {
    if (error instanceof JiaowubaoOpenApiError && error.code === "rate_limited") {
      return noStore(
        { error: "教务宝排课读取正被限流，请稍后再试。", code: "jiaowubao_open_api_rate_limited" },
        429,
      );
    }
    // Do not reflect the upstream err_msg, response body, URL, or credentials.
    return noStore({ error: "教务宝排课预览暂时不可用。", code: "jiaowubao_open_api_unavailable" }, 503);
  }
}

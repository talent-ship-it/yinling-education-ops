import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getJiaowubaoDirectScheduleWindow, getOpsState, OpsStoreError } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_CURSOR_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEDULE_PAGE_LIMIT = 250;
const CURSOR_TTL_SECONDS = 10 * 60;

type ScheduleCursor = Readonly<{
  cursor: Readonly<{ startsAt: string; eventId: string }>;
  runToken: string;
}>;

type InstantRead = Readonly<{ value: string }> | Readonly<{ error: string }>;
type CursorTokenRead = Readonly<{ value: string | null }> | Readonly<{ error: string }>;
type ScheduleCursorContext = Readonly<{
  windowStart: string;
  windowEnd: string;
  scope: "all" | "teacher" | "student" | "availability";
  teacherIds: readonly string[] | null;
  studentIds: readonly string[] | null;
}>;
type SignedScheduleCursor = Readonly<{
  version: 1;
  runToken: string;
  startsAt: string;
  eventId: string;
  contextHash: string;
  expiresAt: number;
}>;

class ScheduleCursorError extends Error {}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function readInstant(value: string | null, field: string): InstantRead {
  if (!value || !CANONICAL_UTC_INSTANT.test(value)) return { error: `${field} 必须使用 UTC ISO 时间。` } as const;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return { error: `${field} 无效。` } as const;
  }
  return { value: parsed.toISOString() } as const;
}

function readId(value: string | null, field: string) {
  if (value === null || value === "") return { value: undefined } as const;
  if (value !== value.trim() || value.length > 240) return { error: `${field} 无效。` } as const;
  return { value } as const;
}

function readCursorToken(url: URL): CursorTokenRead {
  if (url.searchParams.has("cursorStartsAt") || url.searchParams.has("cursorEventId") || url.searchParams.has("runToken")) {
    return { error: "分页游标格式已更新，请重新读取课表。" } as const;
  }
  const value = url.searchParams.get("cursor");
  if (value === null) return { value: null } as const;
  if (!/^[A-Za-z0-9_-]{32,2048}\.[A-Za-z0-9_-]{32,128}$/.test(value)) {
    return { error: "分页游标无效，请重新读取课表。" } as const;
  }
  return { value } as const;
}

function cursorSigningSecret() {
  const secret = process.env.OPS_API_SECRET;
  if (!secret) throw new Error("教务宝课表分页签名未配置。");
  return secret;
}

function contextHash(context: ScheduleCursorContext) {
  // The cursor itself is signed below, but this extra keyed digest avoids
  // exposing a reusable plain hash of a staff/member scope if a cursor is
  // ever captured by diagnostics or access logs.
  return createHmac("sha256", cursorSigningSecret()).update(JSON.stringify({
    windowStart: context.windowStart,
    windowEnd: context.windowEnd,
    scope: context.scope,
    teacherIds: context.teacherIds ? [...context.teacherIds].sort() : [],
    studentIds: context.studentIds ? [...context.studentIds].sort() : [],
  })).digest("hex");
}

function signCursorPayload(payload: SignedScheduleCursor) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", cursorSigningSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function issueCursor(cursor: NonNullable<Awaited<ReturnType<typeof getJiaowubaoDirectScheduleWindow>>["nextCursor"]>, runToken: string, context: ScheduleCursorContext) {
  return signCursorPayload({
    version: 1,
    runToken,
    startsAt: cursor.startsAt,
    eventId: cursor.eventId,
    contextHash: contextHash(context),
    expiresAt: Math.floor(Date.now() / 1000) + CURSOR_TTL_SECONDS,
  });
}

function readCursorInstant(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_CURSOR_UTC_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19) ? null : value;
}

function verifyCursor(token: string | null, context: ScheduleCursorContext): ScheduleCursor | null {
  if (token === null) return null;
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length) throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  const expectedSignature = createHmac("sha256", cursorSigningSecret()).update(encoded).digest("base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  }
  const value = payload as Partial<SignedScheduleCursor>;
  const startsAt = readCursorInstant(value.startsAt);
  const runToken = value.runToken;
  const eventId = value.eventId;
  const expiresAt = value.expiresAt;
  if (value.version !== 1
    || !UUID.test(runToken ?? "")
    || !UUID.test(eventId ?? "")
    || !startsAt
    || typeof value.contextHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.contextHash)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt === undefined
    || expiresAt <= Math.floor(Date.now() / 1000)
    || value.contextHash !== contextHash(context)) {
    throw new ScheduleCursorError("分页游标已失效，请重新读取课表。");
  }
  return { cursor: { startsAt, eventId: eventId! }, runToken: runToken! };
}

function publicPage(
  page: Awaited<ReturnType<typeof getJiaowubaoDirectScheduleWindow>>,
  context: ScheduleCursorContext,
) {
  const nextCursor = page.state === "complete" && page.nextCursor && page.runToken
    ? { token: issueCursor(page.nextCursor, page.runToken, context) }
    : null;
  return { ...page, nextCursor };
}

async function getPublicSchedulePage(context: ScheduleCursorContext, cursorToken: string | null) {
  const signedCursor = verifyCursor(cursorToken, context);
  const page = await getJiaowubaoDirectScheduleWindow({
    windowStart: context.windowStart,
    windowEnd: context.windowEnd,
    scope: context.scope,
    teacherIds: context.teacherIds,
    studentIds: context.studentIds,
    limit: SCHEDULE_PAGE_LIMIT,
    cursor: signedCursor?.cursor ?? null,
    runToken: signedCursor?.runToken ?? null,
  });
  return publicPage(page, context);
}

function missingReader(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function idsForEntity(rows: Awaited<ReturnType<typeof getOpsState>>, entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  if (!Array.isArray(payload)) return new Set<string>();
  return new Set(payload.flatMap((item) => (
    item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
      ? [(item as { id: string }).id]
      : []
  )));
}

/**
 * Curated imported class events. The browser provides only a UTC time window
 * and an optional teacher selection; the server derives every visibility
 * scope from the signed session and current Ops state.
 */
export async function GET(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);

  const url = new URL(request.url);
  const windowStart = readInstant(url.searchParams.get("windowStart"), "windowStart");
  const windowEnd = readInstant(url.searchParams.get("windowEnd"), "windowEnd");
  const requestedTeacher = readId(url.searchParams.get("teacherId"), "teacherId");
  const cursorToken = readCursorToken(url);
  if ("error" in windowStart) return noStore({ error: windowStart.error }, 400);
  if ("error" in windowEnd) return noStore({ error: windowEnd.error }, 400);
  if ("error" in requestedTeacher) return noStore({ error: requestedTeacher.error }, 400);
  if ("error" in cursorToken) return noStore({ error: cursorToken.error }, 400);
  if (new Date(windowEnd.value).getTime() <= new Date(windowStart.value).getTime()) {
    return noStore({ error: "windowEnd 必须晚于 windowStart。" }, 400);
  }

  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session.role);
    const unrestricted = access.fullAdmin || access.limitedAdmin;
    const requestedTeacherId = requestedTeacher.value;
    const knownTeacherIds = idsForEntity(rows, "teachers");

    if (unrestricted) {
      if (requestedTeacherId && !knownTeacherIds.has(requestedTeacherId)) {
        return noStore({ error: "未找到该老师。" }, 404);
      }
      return noStore(await getPublicSchedulePage({
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: requestedTeacherId ? "teacher" : "all",
        teacherIds: requestedTeacherId ? [requestedTeacherId] : null,
        studentIds: null,
      }, cursorToken.value));
    }

    if (access.teacher) {
      if (requestedTeacherId && !access.teacherIds.has(requestedTeacherId)) {
        // Do not turn this endpoint into a global teacher-ID oracle.
        return noStore({ error: "未找到该老师。" }, 404);
      }
      const teacherIds = requestedTeacherId ? [requestedTeacherId] : [...access.teacherIds].sort();
      if (!teacherIds.length) {
        return noStore({ state: "complete", events: [], invalidTimeEventCount: 0, hasMore: false, nextCursor: null, runToken: null });
      }
      return noStore(await getPublicSchedulePage({
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: "teacher",
        teacherIds,
        // Preserve []: the teacher can see their own event but no participant
        // identifiers are visible without current student-level access.
        studentIds: [...access.studentIds].sort(),
      }, cursorToken.value));
    }

    if (requestedTeacherId) {
      if (!access.staff || !knownTeacherIds.has(requestedTeacherId)) {
        // A non-admin cannot distinguish an unknown teacher from one outside
        // their scope. Staff who can schedule their own students receive only
        // the teacher's occupied availability intervals below.
        return noStore({ error: "未找到该老师。" }, 404);
      }
      return noStore(await getPublicSchedulePage({
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: "availability",
        teacherIds: [requestedTeacherId],
        studentIds: null,
      }, cursorToken.value));
    }
    const studentIds = [...access.studentIds].sort();
    if (!studentIds.length) {
      return noStore({ state: "complete", events: [], invalidTimeEventCount: 0, hasMore: false, nextCursor: null, runToken: null });
    }
    return noStore(await getPublicSchedulePage({
      windowStart: windowStart.value,
      windowEnd: windowEnd.value,
      scope: "student",
      teacherIds: null,
      studentIds,
    }, cursorToken.value));
  } catch (error) {
    if (error instanceof ScheduleCursorError) {
      return noStore({ error: error.message }, 400);
    }
    if (missingReader(error)) {
      return noStore({ error: "教务宝只读课表数据库合同尚未部署。", code: "jiaowubao_direct_reader_unavailable" }, 501);
    }
    return noStore({ error: error instanceof Error ? error.message : "教务宝导入课表读取失败。" }, 503);
  }
}

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  BigBlueButtonError,
  createJoinUrl,
  createMeeting,
  endMeeting,
  getRecordings,
  meetingIdForBooking,
  meetingStatus,
} from "@/lib/bigbluebutton";
import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { buildOpsAccessContext, filterOpsStateRows } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState } from "@/lib/ops-store";
import { cleanTimezone } from "@/lib/timezone";

export const dynamic = "force-dynamic";

type RecordValue = Record<string, unknown>;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function cleanName(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120) || fallback;
}

function handleError(error: unknown) {
  if (error instanceof BigBlueButtonError) {
    return noStore({ error: error.message, code: error.code }, error.status);
  }
  return noStore({ error: error instanceof Error ? error.message : "在线教室操作失败。" }, 500);
}

async function authorizedBooking(bookingId: string) {
  const cookieStore = await cookies();
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!actor) return null;

  const stateRows = await getOpsState(["students", "teachers", "bookings"]);
  const fullAdmin = actor === DEMO_ADMIN_USER && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  const access = buildOpsAccessContext(stateRows, actor, fullAdmin);
  const visible = Object.fromEntries(filterOpsStateRows(stateRows, access).map((item) => [item.entity, item.payload]));
  const booking = rows(visible.bookings).find((item) => item.id === bookingId);
  if (!booking) return { actor, forbidden: true as const };

  const student = rows(visible.students).find((item) => item.id === booking.studentId);
  const teacher = rows(visible.teachers).find((item) => item.id === booking.teacherId);
  return { actor, booking, student, teacher, forbidden: false as const };
}

function bookingIdFrom(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - date.getTime();
}

function bookingStartsAt(booking: RecordValue) {
  const date = typeof booking.date === "string" ? booking.date : "";
  const time = typeof booking.start === "string" ? booking.start : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const timezone = cleanTimezone(booking.timezone);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  return new Date(wallClock - timezoneOffsetMs(first, timezone));
}

function bookingIsHistorical(booking: RecordValue) {
  const startsAt = bookingStartsAt(booking);
  if (!startsAt) return true;
  const duration = Math.max(1, Number(booking.duration) || 60);
  return startsAt.getTime() + duration * 60 * 1000 < Date.now();
}

export async function GET(request: NextRequest) {
  const bookingId = bookingIdFrom(request.nextUrl.searchParams.get("bookingId"));
  if (!bookingId) return noStore({ error: "缺少排课 ID。" }, 400);

  try {
    const context = await authorizedBooking(bookingId);
    if (!context) return noStore({ error: "请先输入访问密码。" }, 401);
    if (context.forbidden) return noStore({ error: "当前账号无权访问这节课。" }, 403);
    const meetingId = meetingIdForBooking(bookingId);
    const [status, recordings] = await Promise.all([meetingStatus(meetingId), getRecordings(meetingId)]);
    return noStore({ status, recordings });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.action !== "string") return noStore({ error: "在线教室参数不完整。" }, 400);
  const bookingId = bookingIdFrom(body.bookingId);
  if (!bookingId) return noStore({ error: "缺少排课 ID。" }, 400);

  try {
    const context = await authorizedBooking(bookingId);
    if (!context) return noStore({ error: "请先输入访问密码。" }, 401);
    if (context.forbidden) return noStore({ error: "当前账号无权访问这节课。" }, 403);

    const meetingId = meetingIdForBooking(bookingId);
    const studentName = cleanName(context.student?.name, "Student");
    const teacherName = cleanName(context.teacher?.name, context.actor);
    const studentId = String(context.booking.studentId || "student");
    const teacherId = String(context.booking.teacherId || "teacher");
    const course = cleanName(context.booking.course, "在线课堂");
    const classroom = record(context.booking.classroom);
    const historical = bookingIsHistorical(context.booking);
    const provision = () => createMeeting({
      meetingId,
      name: `${studentName} · ${course}`,
      durationMinutes: Number(context.booking.duration) || 60,
      logoutUrl: new URL("/", request.nextUrl.origin).toString(),
      bookingId,
      studentId,
      teacherId,
    });

    if (body.action === "create") {
      if (historical) return noStore({ error: "历史课程不能新建在线教室，请创建新的排课。" }, 409);
      const result = await provision();
      return noStore({ meeting: result });
    }

    if (body.action === "teacher-join") {
      if (historical) return noStore({ error: "历史课程不能重新开课，请创建新的排课。" }, 409);
      if (classroom.status === "ended") return noStore({ error: "这节课已经结课，请为新课程创建新的排课。" }, 409);
      await provision();
      return noStore({
        meetingId,
        role: "MODERATOR",
        url: createJoinUrl({ meetingId, fullName: teacherName, role: "MODERATOR", userId: `${teacherId}-${context.actor}` }),
      });
    }

    if (body.action === "student-link") {
      if (historical) return noStore({ error: "历史课程不能生成新的学生进入链接。" }, 409);
      if (classroom.status === "ended") return noStore({ error: "这节课已经结课，请为新课程创建新的排课。" }, 409);
      await provision();
      return noStore({
        meetingId,
        role: "VIEWER",
        url: createJoinUrl({ meetingId, fullName: studentName, role: "VIEWER", userId: studentId }),
      });
    }

    if (body.action === "end") return noStore(await endMeeting(meetingId));
    return noStore({ error: "不支持的在线教室动作。" }, 400);
  } catch (error) {
    return handleError(error);
  }
}

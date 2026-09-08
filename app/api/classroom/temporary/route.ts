import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  BigBlueButtonError,
  createJoinUrl,
  createMeeting,
  createTemporaryTestMeeting,
  meetingIdForOccurrence,
} from "@/lib/bigbluebutton";
import { DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { displayTimezoneOptions } from "@/lib/display-preferences";
import { localTimeToInstant } from "@/lib/teacher-availability";
import {
  bookingCapacityCommandIntent,
  BookingCapacityServiceError,
  parseBookingCapacityCommand,
  prepareBookingCapacityMutation,
} from "@/lib/booking-capacity-service";
import {
  claimTemporaryClassroomRequest,
  getTemporaryClassroomCapability,
  getBookingCapacityCommandResult,
  getOpsState,
  mutateBookingCapacityAtomic,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";
// The recorded temporary-classroom saga has five sequential RPC boundaries
// around one BBB call. At 10s per RPC plus BBB's 15s bound, the worst bounded
// chain is 65s; keep the route budget above that for request processing.
export const maxDuration = 90;

const TEMPORARY_CLASSROOM_RPC_TIMEOUT_MS = 10_000;
const temporaryClassroomRpcOptions = { timeoutMs: TEMPORARY_CLASSROOM_RPC_TIMEOUT_MS } as const;

const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SUPPORTED_TIMEZONES = new Set<string>(displayTimezoneOptions.map((option) => option.id));

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

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryCommandKey(actor: string, requestKey: string) {
  // Keep one server-owned command identity for the requestKey. The database
  // ledger then rejects a changed intent under the same key instead of letting
  // an upsert overwrite the original temporary booking.
  return `booking-capacity:${digest(`temporary-command:${actor}:${requestKey}`)}`;
}

function errorResponse(error: unknown) {
  if (error instanceof BigBlueButtonError) {
    return noStore({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof BookingCapacityServiceError) {
    const forbidden = new Set(["student_scope_forbidden", "teacher_forbidden", "classroom_scope_forbidden"]);
    const notFound = new Set(["student_not_found", "teacher_not_found", "booking_not_found", "occurrence_not_found", "classroom_occurrence_not_found"]);
    const conflict = new Set([
      "schedule_conflict", "package_balance_insufficient", "teacher_capacity_unconfigured",
      "teacher_capacity_exhausted", "teacher_unavailable", "teacher_not_accepting",
      "past_booking", "classroom_status_regression", "classroom_unavailable", "stale_expected_version",
    ]);
    return noStore({ error: error.message, code: error.code }, forbidden.has(error.code)
      ? 403
      : notFound.has(error.code)
        ? 404
        : conflict.has(error.code)
          ? 409
          : error.code === "invalid_shared_state" ? 503 : 400);
  }
  if (error instanceof OpsStoreError) {
    if (error.code === "PGRST202" || error.code === "42883"
      || error.code === "55000" && /temporary_classroom_(?:contract|projection)_/i.test(error.message)) {
      return noStore({
        error: "排课与课堂原子数据库合同尚未部署，当前不能创建带业务记录的临时课堂。",
        code: "temporary_classroom_contract_unavailable",
      }, 501);
    }
    if (error.code === "timeout" || error.code === "57014") {
      return noStore({ error: "课堂数据库请求超时，请稍后用同一 requestKey 重试。", code: "temporary_classroom_rpc_timeout" }, 504);
    }
    if (error.code === "temporary_classroom_request_conflict"
      || error.message === "temporary_classroom_request_conflict"
      || error.code === "23505" && /temporary_classroom_request_conflict/i.test(error.message)) {
      return noStore({
        error: "同一个 requestKey 已绑定其他课堂内容；请修改后使用新的 requestKey。",
        code: "temporary_classroom_request_conflict",
      }, 409);
    }
    if (error.code === "40001" || error.message === "version_conflict") {
      return noStore({ error: "排课资料刚刚发生变化，请重试；系统会复用同一课堂和排课命令。", code: "booking_capacity_conflict" }, 409);
    }
    if (error.code === "23505") {
      return noStore({ error: "同一个临时课堂命令使用了不同内容，请刷新后重试。", code: "booking_capacity_idempotency_conflict" }, 409);
    }
  }
  return noStore({ error: "临时课堂创建失败，请稍后重试。" }, 503);
}

function meetingLinks(meetingId: string, requestKey: string) {
  const suffix = digest(`temporary-user:${requestKey}`).slice(0, 32);
  return {
    meetingId,
    moderatorUrl: createJoinUrl({
      meetingId,
      fullName: "管理员测试",
      role: "MODERATOR",
      userId: `temporary-moderator-${suffix}`,
    }),
    viewerUrl: createJoinUrl({
      meetingId,
      fullName: "测试参与者",
      role: "VIEWER",
      userId: `temporary-viewer-${suffix}`,
    }),
  };
}

function expectedVersions(rows: readonly { entity: string; version: number }[]) {
  const versions = Object.fromEntries(rows.map((row) => [row.entity, row.version]));
  return {
    bookings: Number(versions.bookings),
    students: Number(versions.students),
    lpItems: Number(versions.lpItems),
    tasks: Number(versions.tasks),
    teachers: Number(versions.teachers),
  };
}

/**
 * Creates a BBB-only room when all business fields are empty. With business
 * fields present, the provider is created first and the booking + classroom
 * projection is committed by one atomic projection command below.
 */
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  const adminScope = fullAdmin || (session.user === DEMO_LIMITED_ADMIN_USER && session.role === "limited-admin");
  if (!adminScope) return noStore({ error: "只有管理员可以创建临时课堂。", code: "classroom_scope_forbidden" }, 403);

  const body = record(await request.json().catch(() => null));
  const requestKey = text(body.requestKey);
  if (!requestKey || !REQUEST_KEY.test(requestKey)) return noStore({ error: "requestKey 无效，请重试。", code: "invalid_request" }, 400);

  const businessFields = ["studentId", "teacherId", "subjectId", "teacherSubjectId", "packageId"] as const;
  const details = Object.fromEntries(businessFields.map((field) => [field, text(body[field])])) as Record<typeof businessFields[number], string>;
  const hasRecordDetails = Object.values(details).some(Boolean);
  if (!hasRecordDetails) {
    try {
      // Probe the deployed wrapper before creating even a BBB-only test room.
      // A missing/partial classroom migration must fail closed at this
      // boundary, before any external provider resource is created.
      const capability = await getTemporaryClassroomCapability(temporaryClassroomRpcOptions);
      if (!capability[0]?.available) {
        throw new OpsStoreError("temporary_classroom_contract_unavailable", "55000");
      }
      const meetingId = `yinling-test-${digest(`temporary-test:${session.user}:${requestKey}`).slice(0, 64)}`;
      const claim = await claimTemporaryClassroomRequest({
        requestKey,
        intent: { mode: "test" },
        mode: "test",
        meetingId,
        actor: session.user,
      }, temporaryClassroomRpcOptions);
      if (!claim[0]) throw new OpsStoreError("临时课堂 request claim 没有返回结果。", "invalid_claim_result");
      const meeting = await createTemporaryTestMeeting({
        meetingId,
        logoutUrl: new URL("/", request.nextUrl.origin).toString(),
      });
      return noStore({
        ...meetingLinks(meeting.meetingId, requestKey),
        duplicate: meeting.duplicate,
        recorded: false,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const missing = businessFields.filter((field) => !details[field]);
  if (missing.length) {
    return noStore({
      error: "要保存课堂记录，请完整选择学生、老师、老师科目、课程科目和课包。",
      code: "incomplete_business_fields",
      missing,
    }, 400);
  }
  const duration = Number(body.duration ?? 60);
  if (![60, 90, 120].includes(duration)) return noStore({ error: "课堂时长必须是 60、90 或 120 分钟。", code: "invalid_request" }, 400);
  const timezone = text(body.timezone);
  const date = text(body.date);
  const start = text(body.start);
  if (!timezone || !date || !start || !SUPPORTED_TIMEZONES.has(timezone)) {
    return noStore({ error: "临时课堂日期、时间或时区无效，请重新提交。", code: "invalid_request" }, 400);
  }
  if (!DATE.test(date) || !TIME.test(start)) {
    return noStore({ error: "临时课堂日期、时间或时区无效，请重新提交。", code: "invalid_request" }, 400);
  }

  const bookingId = `TMP-${digest(`temporary-booking:${session.user}:${requestKey}`).slice(0, 48)}`;
  const occurrenceId = `${bookingId}:${date}`;
  const meetingId = meetingIdForOccurrence(occurrenceId);
  const temporaryIntent = {
    mode: "recorded" as const,
    studentId: details.studentId,
    teacherId: details.teacherId,
    subjectId: details.subjectId,
    teacherSubjectId: details.teacherSubjectId,
    packageId: details.packageId,
    duration,
    date,
    start,
    timezone,
  };
  const booking = {
    studentId: details.studentId,
    teacherId: details.teacherId,
    date,
    start,
    duration,
    kind: "常规课" as const,
    timezone,
    recurring: false,
    repeatCount: 1,
    packageId: details.packageId,
    subjectId: details.subjectId,
    teacherSubjectId: details.teacherSubjectId,
  };

  try {
    // Capability and request identity are both resolved before BBB. The claim
    // is durable, actor-bound, and compares the complete normalized intent.
    const capability = await getTemporaryClassroomCapability(temporaryClassroomRpcOptions);
    if (!capability[0]?.available) {
      throw new OpsStoreError("temporary_classroom_contract_unavailable", "55000");
    }
    const claim = await claimTemporaryClassroomRequest({
      requestKey,
      intent: temporaryIntent,
      mode: "recorded",
      bookingId,
      occurrenceId,
      meetingId,
      actor: session.user,
    }, temporaryClassroomRpcOptions);
    if (!claim[0]) throw new OpsStoreError("临时课堂 request claim 没有返回结果。", "invalid_claim_result");
    const commandFields = {
      action: "upsert_bind_classroom",
      bookingId,
      occurrenceId,
      booking,
      classroom: { meetingId, status: "ready" },
    } as const;
    // expectedVersions are deliberately excluded from command intent. Build a
    // placeholder command first so a lost-response retry can replay the
    // authoritative receipt before taking a fresh shared-state snapshot.
    const commandForReplay = parseBookingCapacityCommand({
      ...commandFields,
      expectedVersions: { bookings: 0, students: 0, lpItems: 0, tasks: 0, teachers: 0 },
    });
    const commandIntent = bookingCapacityCommandIntent(commandForReplay);
    const commandKey = temporaryCommandKey(session.user, requestKey);

    // An already committed command is authoritative. This is the recovery
    // path for a lost response and avoids another provider call entirely.
    const replay = await getBookingCapacityCommandResult(
      { commandKey, commandIntent, actor: session.user },
      temporaryClassroomRpcOptions,
    );
    if (replay[0]) {
      return noStore({
        ...meetingLinks(meetingId, requestKey),
        bookingId,
        occurrenceId,
        committed: true,
        duplicate: true,
        recorded: true,
        bookingRow: replay[0].bookings_row,
        studentRow: replay[0].students_row,
        taskRow: replay[0].tasks_row,
        teacherRow: replay[0].teachers_row,
      });
    }

    const rows = await getOpsState(
      ["bookings", "students", "lpItems", "tasks", "teachers"],
      temporaryClassroomRpcOptions,
    );
    const versions = expectedVersions(rows);
    const command = parseBookingCapacityCommand({
      ...commandFields,
      expectedVersions: versions,
    });
    const freshCommandIntent = bookingCapacityCommandIntent(command);
    if (JSON.stringify(freshCommandIntent) !== JSON.stringify(commandIntent)) {
      throw new OpsStoreError("临时课堂命令内容发生变化，请使用同一 requestKey 重试。", "temporary_classroom_intent_drift");
    }

    // Preflight all business validation before creating the external room. A
    // failed BBB call therefore cannot leave a Booking behind; the only
    // remaining boundary is a deterministic, retryable provider-first saga.
    const prepared = prepareBookingCapacityMutation({
      command,
      rows,
      actor: session.user,
      role: session.role,
      authorization: session,
      fullAdmin,
    });
    const studentRow = rows.find((row) => row.entity === "students");
    const student = Array.isArray(studentRow?.payload)
      ? studentRow.payload.find((value) => record(value).id === details.studentId)
      : undefined;
    const meeting = await createMeeting({
      meetingId,
      name: `${text(record(student).name) || details.studentId} · ${details.subjectId}`,
      durationMinutes: duration,
      scheduledStartsAt: localTimeToInstant(date, start, timezone, "earlier").getTime(),
      logoutUrl: new URL("/", request.nextUrl.origin).toString(),
      occurrenceId,
      bookingId,
      studentId: details.studentId,
      teacherId: details.teacherId,
    });
    const saved = await mutateBookingCapacityAtomic({
      ...prepared,
      actorRole: session.role,
      actor: session.user,
    }, temporaryClassroomRpcOptions);
    if (!saved[0]) throw new OpsStoreError("临时课堂事务没有返回保存结果。", "invalid_commit_result");
    return noStore({
      ...meetingLinks(meeting.meetingId, requestKey),
      bookingId,
      occurrenceId,
      committed: true,
      duplicate: meeting.duplicate,
      recorded: true,
      bookingRow: saved[0].bookings_row,
      studentRow: saved[0].students_row,
      taskRow: saved[0].tasks_row,
      teacherRow: saved[0].teachers_row,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

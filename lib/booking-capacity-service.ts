import { isLessonDuration } from "./lesson-duration";
import { createHash } from "node:crypto";

import { meetingIdForOccurrenceValue } from "@/lib/bbb-analytics";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction } from "@/lib/ops-access";
import type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";
import {
  expandLessonOccurrences,
  lessonOccurrenceSourceRangeForTargetRange,
  type LessonOccurrenceOverride,
} from "@/lib/lesson-occurrences";
import {
  LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS,
  normalizeBookingRecurrence,
  recurrenceSourceEndDate,
} from "@/lib/booking-recurrence";
import { getLessonPackageBalance, type StudentLessonPackage } from "@/lib/student-records";
import {
  expandTeacherAvailability,
  type TeacherAvailabilityWindow,
} from "@/lib/teacher-availability";

type RecordValue = Record<string, unknown>;

const BOOKING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const REQUEST_FIELDS = new Set(["action", "bookingId", "expectedVersions", "booking", "occurrenceId", "occurrence", "classroom"]);
const VERSION_FIELDS = new Set(["bookings", "students", "lpItems", "tasks", "teachers"]);
const OCCURRENCE_FIELDS = new Set(["date", "start", "duration", "status"]);
const CLASSROOM_FIELDS = new Set(["meetingId", "status"]);
const BOOKING_FIELDS = new Set([
  "studentId",
  "teacherId",
  "date",
  "start",
  "duration",
  "kind",
  "timezone",
  "recurring",
  "repeatCount",
  "recurrenceIntervalDays",
  "recurrenceEndDate",
  "packageId",
  "subjectId",
  "teacherSubjectId",
]);

export type BookingCapacityCommand = Readonly<{
  action: "upsert" | "upsert_bind_classroom" | "delete" | "cancel_occurrence" | "update_occurrence" | "bind_classroom";
  bookingId: string;
  occurrenceId?: string;
  occurrence?: Readonly<{
    date: string;
    start: string;
    duration: number;
    status: "confirmed";
  }>;
  classroom?: Readonly<{
    meetingId: string;
    status: "ready" | "running" | "ended";
  }>;
  expectedVersions: Readonly<{
    bookings: number;
    students: number;
    lpItems: number;
    tasks: number;
    teachers: number;
  }>;
  booking?: Readonly<{
    studentId: string;
    teacherId: string;
    date: string;
    start: string;
    duration: number;
    kind: "试听" | "常规课" | "代课";
    timezone: string;
    recurring: boolean;
    repeatCount?: number;
    recurrenceIntervalDays?: number;
    recurrenceEndDate?: string;
    packageId?: string;
    subjectId: string;
    teacherSubjectId: string;
  }>;
}>;

export type BookingCapacityServiceErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "booking_not_found"
  | "occurrence_not_found"
  | "student_not_found"
  | "teacher_not_found"
  | "student_scope_forbidden"
  | "teacher_forbidden"
  | "assignment_change_forbidden"
  | "package_required"
  | "package_subject_mismatch"
  | "package_balance_insufficient"
  | "subject_not_allowed"
  | "teacher_subject_not_allowed"
  | "teacher_not_accepting"
  | "teacher_capacity_unconfigured"
  | "teacher_capacity_exhausted"
  | "teacher_unavailable"
  | "schedule_conflict"
  | "past_booking"
  | "classroom_scope_forbidden"
  | "classroom_occurrence_not_found"
  | "classroom_meeting_id_mismatch"
  | "classroom_status_regression"
  | "classroom_unavailable";

export class BookingCapacityServiceError extends Error {
  constructor(readonly code: BookingCapacityServiceErrorCode, message: string) {
    super(message);
    this.name = "BookingCapacityServiceError";
  }
}

export type PreparedBookingCapacityMutation = Readonly<{
  action: "create" | "update" | "delete";
  bookingId: string;
  commandKey: string;
  commandIntent: BookingCapacityCommandIntent;
  expectedVersions: BookingCapacityCommand["expectedVersions"];
  bookings: readonly RecordValue[];
  teachers: readonly RecordValue[];
  changedTeacherIds: readonly string[];
  studentId: string;
  teacherId: string;
}>;

export type BookingCapacityCommandIntent = Readonly<{
  action: BookingCapacityCommand["action"];
  bookingId: string;
  occurrenceId?: string;
  occurrence?: BookingCapacityCommand["occurrence"];
  classroom?: BookingCapacityCommand["classroom"];
  booking?: BookingCapacityCommand["booking"];
}>;

export function bookingCapacityTeacherReplayAllowed(input: Readonly<{
  sessionRole: DemoSessionRole;
  ledgerActorRole: DemoSessionRole;
  action: "create" | "update" | "delete" | "bind_classroom";
  allowedTeacherIds: ReadonlySet<string>;
  teacherId: string;
  previousTeacherId: string;
  currentTeacherId?: string;
}>) {
  if (input.sessionRole !== "teacher") return true;
  return input.ledgerActorRole === "teacher"
    && input.action !== "delete"
    && input.allowedTeacherIds.has(input.teacherId)
    && input.allowedTeacherIds.has(input.previousTeacherId)
    // A classroom command records the effective teacher for the occurrence,
    // while the parent booking may still point at the original series teacher
    // after a substitution. The occurrence-scoped identities above are the
    // authority for a classroom replay.
    && (input.action === "bind_classroom" || !input.currentTeacherId || input.allowedTeacherIds.has(input.currentTeacherId));
}

function fail(code: BookingCapacityServiceErrorCode, message: string): never {
  throw new BookingCapacityServiceError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyFields(value: RecordValue, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail("client_fields_forbidden", "Only the reviewed booking command fields may be submitted.");
  }
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) fail("invalid_request", `${field} is required.`);
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid_request", `${field} is invalid.`);
  return value as number;
}

function assertCalendarDate(value: string, field: string) {
  if (!DATE_PATTERN.test(value)) fail("invalid_request", `${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail("invalid_request", `${field} is not a calendar date.`);
  }
}

function assertTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    fail("invalid_request", "timezone must be a valid IANA timezone.");
  }
}

export function parseBookingCapacityCommand(value: unknown): BookingCapacityCommand {
  if (!isRecord(value)) fail("invalid_request", "Booking command is missing.");
  assertOnlyFields(value, REQUEST_FIELDS);
  const action = value.action;
  if (action !== "upsert" && action !== "upsert_bind_classroom" && action !== "delete" && action !== "cancel_occurrence" && action !== "update_occurrence" && action !== "bind_classroom") {
    fail("invalid_request", "action must be upsert, upsert_bind_classroom, delete, cancel_occurrence, update_occurrence or bind_classroom.");
  }
  const bookingId = requiredText(value.bookingId, "bookingId");
  if (!BOOKING_ID_PATTERN.test(bookingId)) fail("invalid_request", "bookingId is invalid.");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertOnlyFields(value.expectedVersions, VERSION_FIELDS);
  const expectedVersions = {
    bookings: version(value.expectedVersions.bookings, "expectedVersions.bookings"),
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    lpItems: version(value.expectedVersions.lpItems, "expectedVersions.lpItems"),
    tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
    teachers: version(value.expectedVersions.teachers, "expectedVersions.teachers"),
  };
  if (action === "delete") {
    if (value.booking !== undefined || value.occurrenceId !== undefined || value.occurrence !== undefined || value.classroom !== undefined) {
      fail("client_fields_forbidden", "Delete commands cannot submit booking or occurrence data.");
    }
    return { action, bookingId, expectedVersions };
  }
  if (action === "cancel_occurrence") {
    if (value.booking !== undefined || value.occurrence !== undefined || value.classroom !== undefined) fail("client_fields_forbidden", "Occurrence cancellation cannot submit booking data.");
    const occurrenceId = requiredText(value.occurrenceId, "occurrenceId");
    const sourceDate = occurrenceId.slice(-10);
    if (occurrenceId !== `${bookingId}:${sourceDate}` || !DATE_PATTERN.test(sourceDate)) {
      fail("invalid_request", "occurrenceId must identify one source date in bookingId.");
    }
    assertCalendarDate(sourceDate, "occurrenceId source date");
    return { action, bookingId, occurrenceId, expectedVersions };
  }
  if (action === "update_occurrence") {
    if (value.booking !== undefined || value.classroom !== undefined) fail("client_fields_forbidden", "Occurrence updates cannot submit booking data.");
    const occurrenceId = requiredText(value.occurrenceId, "occurrenceId");
    const sourceDate = occurrenceId.slice(-10);
    if (occurrenceId !== `${bookingId}:${sourceDate}` || !DATE_PATTERN.test(sourceDate)) {
      fail("invalid_request", "occurrenceId must identify one source date in bookingId.");
    }
    assertCalendarDate(sourceDate, "occurrenceId source date");
    if (!isRecord(value.occurrence)) fail("invalid_request", "occurrence is required for update_occurrence.");
    assertOnlyFields(value.occurrence, OCCURRENCE_FIELDS);
    const date = requiredText(value.occurrence.date, "occurrence.date");
    const start = requiredText(value.occurrence.start, "occurrence.start");
    const duration = value.occurrence.duration;
    assertCalendarDate(date, "occurrence.date");
    if (!TIME_PATTERN.test(start)) fail("invalid_request", "occurrence.start must use HH:MM.");
    if (!isLessonDuration(duration)) fail("invalid_request", "occurrence.duration must be a whole number of minutes from 15 to 360.");
    if (value.occurrence.status !== "confirmed") fail("invalid_request", "Occurrence updates may only confirm an active lesson.");
    return {
      action,
      bookingId,
      occurrenceId,
      occurrence: { date, start, duration: duration as number, status: "confirmed" },
      expectedVersions,
    };
  }
  if (action === "bind_classroom") {
    if (value.booking !== undefined || value.occurrence !== undefined) {
      fail("client_fields_forbidden", "Classroom binding cannot submit booking or schedule data.");
    }
    const occurrenceId = requiredText(value.occurrenceId, "occurrenceId");
    const sourceDate = occurrenceId.slice(-10);
    if (occurrenceId !== `${bookingId}:${sourceDate}` || !DATE_PATTERN.test(sourceDate)) {
      fail("invalid_request", "occurrenceId must identify one source date in bookingId.");
    }
    assertCalendarDate(sourceDate, "occurrenceId source date");
    if (!isRecord(value.classroom)) fail("invalid_request", "classroom is required for bind_classroom.");
    assertOnlyFields(value.classroom, CLASSROOM_FIELDS);
    const meetingId = requiredText(value.classroom.meetingId, "classroom.meetingId");
    if (!/^yinling-occ-[0-9a-f]{48}$/.test(meetingId)) fail("invalid_request", "classroom.meetingId is invalid.");
    const status = value.classroom.status;
    if (status !== "ready" && status !== "running" && status !== "ended") {
      fail("invalid_request", "classroom.status is invalid.");
    }
    return {
      action,
      bookingId,
      occurrenceId,
      classroom: { meetingId, status },
      expectedVersions,
    };
  }
  if (action === "upsert_bind_classroom") {
    if (value.occurrence !== undefined) fail("client_fields_forbidden", "Combined classroom creation cannot submit a schedule override.");
    const occurrenceId = requiredText(value.occurrenceId, "occurrenceId");
    const sourceDate = occurrenceId.slice(-10);
    if (occurrenceId !== `${bookingId}:${sourceDate}` || !DATE_PATTERN.test(sourceDate)) {
      fail("invalid_request", "occurrenceId must identify one source date in bookingId.");
    }
    assertCalendarDate(sourceDate, "occurrenceId source date");
    if (!isRecord(value.classroom)) fail("invalid_request", "classroom is required for combined classroom creation.");
    assertOnlyFields(value.classroom, CLASSROOM_FIELDS);
    const meetingId = requiredText(value.classroom.meetingId, "classroom.meetingId");
    if (!/^yinling-occ-[0-9a-f]{48}$/.test(meetingId)
      || meetingId !== meetingIdForOccurrenceValue(occurrenceId)) {
      fail("classroom_meeting_id_mismatch", "classroom.meetingId must match occurrenceId.");
    }
    const status = value.classroom.status;
    if (status !== "ready" && status !== "running" && status !== "ended") {
      fail("invalid_request", "classroom.status is invalid.");
    }
  } else if (value.occurrenceId !== undefined || value.occurrence !== undefined || value.classroom !== undefined) {
    fail("client_fields_forbidden", "Booking upserts cannot submit occurrence data.");
  }
  if (!isRecord(value.booking)) fail("invalid_request", "booking is required for upsert.");
  assertOnlyFields(value.booking, BOOKING_FIELDS);
  const date = requiredText(value.booking.date, "booking.date");
  const start = requiredText(value.booking.start, "booking.start");
  const timezone = requiredText(value.booking.timezone, "booking.timezone");
  assertCalendarDate(date, "booking.date");
  if (!TIME_PATTERN.test(start)) fail("invalid_request", "booking.start must use HH:MM.");
  assertTimezone(timezone);
  const duration = value.booking.duration;
  if (!isLessonDuration(duration)) fail("invalid_request", "booking.duration must be a whole number of minutes from 15 to 360.");
  const kind = value.booking.kind;
  if (kind !== "试听" && kind !== "常规课" && kind !== "代课") fail("invalid_request", "booking.kind is invalid.");
  if (typeof value.booking.recurring !== "boolean") fail("invalid_request", "booking.recurring must be boolean.");
  const repeatCount = value.booking.repeatCount;
  if (repeatCount !== undefined && (!Number.isSafeInteger(repeatCount) || (repeatCount as number) < 1 || (repeatCount as number) > 104)) {
    fail("invalid_request", "booking.repeatCount must be from 1 to 104.");
  }
  try {
    normalizeBookingRecurrence({
      startDate: date,
      recurring: value.booking.recurring,
      ...(repeatCount !== undefined ? { repeatCount: repeatCount as number } : {}),
      ...(value.booking.recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays: value.booking.recurrenceIntervalDays as number } : {}),
      ...(value.booking.recurrenceEndDate !== undefined ? { recurrenceEndDate: value.booking.recurrenceEndDate as string } : {}),
    });
  } catch (error) {
    fail("invalid_request", error instanceof Error ? error.message : "booking recurrence is invalid.");
  }
  return {
    action,
    bookingId,
    expectedVersions,
    ...(action === "upsert_bind_classroom" ? {
      occurrenceId: requiredText(value.occurrenceId, "occurrenceId"),
      classroom: {
        meetingId: requiredText((value.classroom as RecordValue).meetingId, "classroom.meetingId"),
        status: (value.classroom as RecordValue).status as "ready" | "running" | "ended",
      },
    } : {}),
    booking: {
      studentId: requiredText(value.booking.studentId, "booking.studentId"),
      teacherId: requiredText(value.booking.teacherId, "booking.teacherId"),
      date,
      start,
      duration: duration as number,
      kind,
      timezone,
      recurring: value.booking.recurring,
      ...(repeatCount !== undefined ? { repeatCount: repeatCount as number } : {}),
      ...(value.booking.recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays: value.booking.recurrenceIntervalDays as number } : {}),
      ...(value.booking.recurrenceEndDate !== undefined ? { recurrenceEndDate: value.booking.recurrenceEndDate as string } : {}),
      ...(optionalText(value.booking.packageId) ? { packageId: optionalText(value.booking.packageId) } : {}),
      subjectId: requiredText(value.booking.subjectId, "booking.subjectId"),
      teacherSubjectId: requiredText(value.booking.teacherSubjectId, "booking.teacherSubjectId"),
    },
  };
}

function payloadRow(rows: readonly OpsStateRow[], entity: string) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
    fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  return { ...row, payload: row.payload as RecordValue[] };
}

function stateId(value: RecordValue, label: string) {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) fail("invalid_shared_state", `${label} id is missing.`);
  return id;
}

function stateText(value: RecordValue, field: string, label: string) {
  const result = typeof value[field] === "string" ? value[field].trim() : "";
  if (!result) fail("invalid_shared_state", `${label}.${field} is missing.`);
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bookingCapacityCommandIntent(command: BookingCapacityCommand): BookingCapacityCommandIntent {
  return {
    action: command.action,
    bookingId: command.bookingId,
    ...(command.occurrenceId ? { occurrenceId: command.occurrenceId } : {}),
    ...(command.occurrence ? { occurrence: command.occurrence } : {}),
    ...(command.classroom ? { classroom: command.classroom } : {}),
    ...(command.booking ? { booking: command.booking } : {}),
  };
}

export function bookingCapacityCommandKey(command: BookingCapacityCommand) {
  const digest = createHash("sha256")
    .update(stableJson(bookingCapacityCommandIntent(command)))
    .digest("hex");
  return `booking-capacity:${digest}`;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function zonedParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")), month: Number(values.get("month")), day: Number(values.get("day")),
    hour: Number(values.get("hour")), minute: Number(values.get("minute")), second: Number(values.get("second")),
  };
}

function offsetMs(instant: Date, timezone: string) {
  const parts = zonedParts(instant, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
}

function bookingInstant(date: string, start: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = start.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock - offsetMs(new Date(wallClock), timezone));
  const instant = new Date(wallClock - offsetMs(first, timezone));
  const roundTrip = zonedParts(instant, timezone);
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day || roundTrip.hour !== hour || roundTrip.minute !== minute) {
    fail("invalid_request", `${date} ${start} does not exist in ${timezone}.`);
  }
  return instant;
}

function bookingOccurrences(booking: RecordValue, rangeStart: string, rangeEnd: string) {
  const duration = booking.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    fail("invalid_shared_state", "booking.duration is invalid.");
  }
  const overrides = Array.isArray(booking.occurrenceOverrides)
    ? booking.occurrenceOverrides.filter(isRecord) as LessonOccurrenceOverride[]
    : [];
  try {
    return expandLessonOccurrences({
      id: stateId(booking, "booking"),
      date: stateText(booking, "date", "booking"),
      start: stateText(booking, "start", "booking"),
      duration,
      recurring: booking.recurring === true,
      ...(typeof booking.repeatCount === "number" ? { repeatCount: booking.repeatCount } : {}),
      ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
      ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
      studentId: optionalText(booking.studentId),
      teacherId: optionalText(booking.teacherId),
      packageId: optionalText(booking.packageId),
      course: optionalText(booking.course),
    }, { rangeStart, rangeEnd, overrides });
  } catch (error) {
    fail("invalid_shared_state", error instanceof Error ? error.message : "booking is invalid.");
  }
}

/**
 * Classroom metadata is keyed by the stable source occurrence identity.  Do
 * not accept a syntactically valid `${bookingId}:${date}` that is outside the
 * booking's concrete series.  In particular, a one-off booking has exactly
 * one source date; an override may move that occurrence, but cannot create a
 * second source occurrence.
 */
function classroomOccurrenceForBooking(booking: RecordValue, occurrenceId: string) {
  const sourceDate = occurrenceId.slice(-10);
  const bookingDate = stateText(booking, "date", "booking");
  if (booking.recurring !== true && sourceDate !== bookingDate) {
    fail("classroom_occurrence_not_found", "在线教室课次不属于这条单次排课。");
  }
  const occurrence = bookingOccurrences(booking, sourceDate, sourceDate)
    .find((candidate) => candidate.occurrenceId === occurrenceId && candidate.sourceDate === sourceDate);
  if (!occurrence) fail("classroom_occurrence_not_found", "在线教室课次不属于这条排课系列。");
  return occurrence;
}

function teacherAvailable(
  teacher: RecordValue,
  booking: RecordValue,
  proposedOccurrences: readonly ReturnType<typeof bookingOccurrences>[number][],
) {
  if (!Array.isArray(teacher.availabilityWindows)) return false;
  const windows = teacher.availabilityWindows as TeacherAvailabilityWindow[];
  const timezone = stateText(booking, "timezone", "booking");
  try {
    return proposedOccurrences
      .filter((occurrence) => occurrence.status !== "cancelled" && occurrence.status !== "leave")
      .every((occurrence) => {
      const requestedStart = bookingInstant(occurrence.date, occurrence.start, timezone);
      const requestedEnd = new Date(requestedStart.getTime() + occurrence.scheduledDurationMinutes * 60_000);
      const utcDate = requestedStart.toISOString().slice(0, 10);
      const occurrences = expandTeacherAvailability(windows, {
        from: addDays(utcDate, -1),
        to: addDays(utcDate, 1),
        displayTimezone: "UTC",
      });
      return occurrences.some((occurrence) =>
        occurrence.teacherId === stateId(teacher, "teacher")
        && requestedStart.getTime() >= Date.parse(occurrence.startsAt)
        && requestedEnd.getTime() <= Date.parse(occurrence.endsAt));
      });
  } catch {
    return false;
  }
}

function activeRelationship(bookings: readonly RecordValue[], teacherId: string, studentId: string) {
  return bookings.some((booking) => {
    if (booking.kind === "代课") return false;
    const date = stateText(booking, "date", "booking");
    let sourceEnd = date;
    if (booking.recurring === true) {
      sourceEnd = recurrenceSourceEndDate({
        startDate: date,
        recurring: true,
        ...(Number.isSafeInteger(booking.repeatCount) ? { repeatCount: booking.repeatCount as number } : {}),
        ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
        ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
      }) ?? "";
      // An unbounded legacy series cannot have every future occurrence
      // cancelled by a finite override set. Its base relationship remains.
      if (!sourceEnd) return booking.teacherId === teacherId && booking.studentId === studentId;
    }
    return bookingOccurrences(booking, date, sourceEnd).some((occurrence) =>
      occurrence.status !== "cancelled"
      && occurrence.status !== "leave"
      && occurrence.teacherId === teacherId
      && occurrence.studentId === studentId);
  });
}

function capacityAssignments(teacher: RecordValue) {
  const value = teacher.capacityAssignments;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    fail("invalid_shared_state", "teacher.capacityAssignments is invalid.");
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

export type TeacherStudentCapacityTransition = Readonly<{
  teacherId: string;
  studentId: string;
  beforeActive: boolean;
  afterActive: boolean;
}>;

/** Applies reviewed relationship transitions without inferring them from raw text. */
export function reconcileTeacherStudentCapacity(input: {
  teachers: readonly RecordValue[];
  transitions: readonly TeacherStudentCapacityTransition[];
}) {
  const nextTeachers = input.teachers.map((teacher) => ({ ...teacher }));
  const changed = new Set<string>();
  const seenPairs = new Set<string>();
  for (const transition of input.transitions) {
    const teacherId = transition.teacherId.trim();
    const studentId = transition.studentId.trim();
    if (!teacherId || !studentId) fail("invalid_shared_state", "Capacity transition identities are missing.");
    const pairKey = `${teacherId}\u0000${studentId}`;
    if (seenPairs.has(pairKey)) fail("invalid_shared_state", "Duplicate capacity transition.");
    seenPairs.add(pairKey);
    if (transition.beforeActive === transition.afterActive) continue;

    const index = nextTeachers.findIndex((teacher) => teacher.id === teacherId);
    if (index < 0) fail("teacher_not_found", "Booking teacher was not found.");
    const teacher = nextTeachers[index];
    const assignments = capacityAssignments(teacher);
    const assigned = assignments.includes(studentId);
    const numericCapacity = Number.isSafeInteger(teacher.newStudentCapacity)
      && (teacher.newStudentCapacity as number) >= 0;
    if (teacher.newStudentCapacity !== undefined && !numericCapacity) {
      fail("invalid_shared_state", "teacher.newStudentCapacity is invalid.");
    }
    if (!transition.beforeActive && transition.afterActive) {
      if (assigned) continue;
      if (!numericCapacity) {
        fail("teacher_capacity_unconfigured", `${stateText(teacher, "name", "teacher")} must have new-student capacity configured before the first assignment.`);
      }
      if ((teacher.newStudentCapacity as number) <= 0) {
        fail("teacher_capacity_exhausted", `${stateText(teacher, "name", "teacher")} has no remaining new-student capacity.`);
      }
      nextTeachers[index] = {
        ...teacher,
        capacityAssignments: [...assignments, studentId].sort(),
        newStudentCapacity: (teacher.newStudentCapacity as number) - 1,
      };
      changed.add(teacherId);
    } else if (transition.beforeActive && !transition.afterActive && assigned) {
      nextTeachers[index] = {
        ...teacher,
        capacityAssignments: assignments.filter((assignment) => assignment !== studentId),
        ...(numericCapacity ? { newStudentCapacity: (teacher.newStudentCapacity as number) + 1 } : {}),
      };
      changed.add(teacherId);
    }
  }
  return { teachers: nextTeachers, changedTeacherIds: [...changed].sort() };
}

function reconcileCapacity(input: {
  beforeBookings: readonly RecordValue[];
  afterBookings: readonly RecordValue[];
  teachers: readonly RecordValue[];
  pairs: ReadonlyArray<readonly [string, string]>;
}) {
  const seenPairs = new Set<string>();
  const transitions: TeacherStudentCapacityTransition[] = [];
  for (const [teacherId, studentId] of input.pairs) {
    const pairKey = `${teacherId}\u0000${studentId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const before = activeRelationship(input.beforeBookings, teacherId, studentId);
    const after = activeRelationship(input.afterBookings, teacherId, studentId);
    transitions.push({ teacherId, studentId, beforeActive: before, afterActive: after });
  }
  return reconcileTeacherStudentCapacity({ teachers: input.teachers, transitions });
}

function studentSubjects(student: RecordValue) {
  const subjects = new Set<string>();
  if (optionalText(student.course)) subjects.add(optionalText(student.course)!);
  const packages = Array.isArray(student.lessonPackages) ? student.lessonPackages.filter(isRecord) : [];
  for (const lessonPackage of packages) {
    if (!Array.isArray(lessonPackage.subjectIds)) continue;
    for (const subject of lessonPackage.subjectIds) if (optionalText(subject)) subjects.add(optionalText(subject)!);
  }
  return { subjects, packages };
}

function packageBalance(lessonPackage: RecordValue) {
  try {
    return getLessonPackageBalance(lessonPackage as StudentLessonPackage).remainingHours;
  } catch (error) {
    fail(
      "invalid_shared_state",
      error instanceof Error ? `The selected lesson package is invalid: ${error.message}` : "The selected lesson package is invalid.",
    );
  }
}

function assertPackageAndSubject(student: RecordValue, booking: BookingCapacityCommand["booking"]) {
  if (!booking) return;
  const { subjects, packages } = studentSubjects(student);
  if (!subjects.has(booking.subjectId)) fail("subject_not_allowed", "The selected subject is not linked to this student.");
  if (booking.kind === "试听") {
    if (booking.packageId) {
      const lessonPackage = packages.find((item) => item.id === booking.packageId);
      if (!lessonPackage || !Array.isArray(lessonPackage.subjectIds) || !lessonPackage.subjectIds.includes(booking.subjectId)) {
        fail("package_subject_mismatch", "The selected trial package is not linked to this subject.");
      }
    }
    return;
  }
  if (!booking.packageId) fail("package_required", "A lesson package is required for every non-trial booking.");
  const lessonPackage = packages.find((item) => item.id === booking.packageId);
  if (!lessonPackage || !Array.isArray(lessonPackage.subjectIds) || !lessonPackage.subjectIds.includes(booking.subjectId)) {
    fail("package_subject_mismatch", "The selected lesson package is not linked to this subject.");
  }
  if (packageBalance(lessonPackage) <= 0) {
    fail("package_balance_insufficient", "The selected lesson package has no available hours.");
  }
}

function assertTeacherSubject(teacher: RecordValue, booking: NonNullable<BookingCapacityCommand["booking"]>) {
  if (!Array.isArray(teacher.subjects)
    || !teacher.subjects.every((subject) => typeof subject === "string" && subject.trim())) {
    fail("invalid_shared_state", "teacher.subjects is invalid.");
  }
  const authoritativeSubjects = new Set(teacher.subjects.map((subject) => subject.trim()));
  if (!authoritativeSubjects.has(booking.teacherSubjectId)) {
    fail(
      "teacher_subject_not_allowed",
      `${stateText(teacher, "name", "teacher")} is not listed in the authoritative Tencent subject sheet ${booking.teacherSubjectId}.`,
    );
  }
}

function bookingSourceEnd(booking: RecordValue) {
  const date = stateText(booking, "date", "booking");
  if (booking.recurring !== true) return date;
  const sourceEnd = recurrenceSourceEndDate({
    startDate: date,
    recurring: true,
    ...(Number.isSafeInteger(booking.repeatCount) ? { repeatCount: booking.repeatCount as number } : {}),
    ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
    ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
  });
  if (!sourceEnd) fail("invalid_shared_state", "A billable recurring booking must have a finite repeatCount or recurrenceEndDate.");
  return sourceEnd;
}

/**
 * Projects every still-active future occurrence against one shared package.
 * Subject is intentionally not part of the key: all subjects bound to the
 * same package draw from the same balance.
 */
export function futureReservedPackageHours(input: {
  bookings: readonly RecordValue[];
  studentId: string;
  packageId: string;
  now: Date;
}) {
  if (!input.studentId.trim() || !input.packageId.trim()) {
    fail("invalid_shared_state", "Package reservation identities are missing.");
  }
  if (!Number.isFinite(input.now.getTime())) {
    fail("invalid_request", "Package reservation now is invalid.");
  }
  let reserved = 0;
  for (const booking of input.bookings) {
    if (booking.kind === "试听") continue;
    const overrides = Array.isArray(booking.occurrenceOverrides)
      ? booking.occurrenceOverrides.filter(isRecord)
      : [];
    const mightUsePackage = booking.studentId === input.studentId && booking.packageId === input.packageId;
    const overrideUsesPackage = overrides.some((override) =>
      (optionalText(override.studentId) ?? optionalText(booking.studentId)) === input.studentId
      && (optionalText(override.packageId) ?? optionalText(booking.packageId)) === input.packageId);
    if (!mightUsePackage && !overrideUsesPackage) continue;
    const occurrences = bookingOccurrences(
      booking,
      stateText(booking, "date", "booking"),
      bookingSourceEnd(booking),
    );
    for (const occurrence of occurrences) {
      if (occurrence.studentId !== input.studentId || occurrence.packageId !== input.packageId) continue;
      if (["completed", "cancelled", "leave", "abnormal"].includes(occurrence.status)) continue;
      const timezone = stateText(booking, "timezone", "booking");
      const occurrenceEnd = bookingInstant(occurrence.date, occurrence.start, timezone).getTime()
        + occurrence.scheduledDurationMinutes * 60_000;
      if (occurrenceEnd <= input.now.getTime()) continue;
      reserved += occurrence.scheduledDurationMinutes / 60;
    }
  }
  return Math.round(reserved * 1_000_000) / 1_000_000;
}

function assertPackageReservation(input: {
  student: RecordValue;
  bookings: readonly RecordValue[];
  booking: NonNullable<BookingCapacityCommand["booking"]>;
  now: Date;
}) {
  if (input.booking.kind === "试听" || !input.booking.packageId) return;
  const packages = Array.isArray(input.student.lessonPackages)
    ? input.student.lessonPackages.filter(isRecord)
    : [];
  const lessonPackage = packages.find((item) => item.id === input.booking.packageId);
  if (!lessonPackage) fail("package_subject_mismatch", "The selected lesson package no longer exists.");
  const available = packageBalance(lessonPackage);
  const reserved = futureReservedPackageHours({
    bookings: input.bookings,
    studentId: stateId(input.student, "student"),
    packageId: input.booking.packageId,
    now: input.now,
  });
  if (reserved > available + 0.000001) {
    fail(
      "package_balance_insufficient",
      `The selected lesson package has ${available} hours available but ${reserved} hours are already scheduled.`,
    );
  }
}

function recurrenceEndDateDerivedFromCount(booking: RecordValue) {
  if (booking.recurring !== true || !Number.isSafeInteger(booking.repeatCount) || typeof booking.recurrenceEndDate !== "string") return false;
  try {
    return recurrenceSourceEndDate({
      startDate: stateText(booking, "date", "booking"),
      recurring: true,
      repeatCount: booking.repeatCount as number,
      ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
    }) === booking.recurrenceEndDate;
  } catch {
    return false;
  }
}

function projectedBookingOccurrences(booking: RecordValue, legacyRepeatCount?: number) {
  const projectionBooking = booking.recurring === true
    && booking.repeatCount === undefined
    && booking.recurrenceEndDate === undefined
    && legacyRepeatCount !== undefined
    ? { ...booking, repeatCount: legacyRepeatCount }
    : booking;
  const sourceEnd = bookingSourceEnd(projectionBooking);
  const overrides = Array.isArray(projectionBooking.occurrenceOverrides)
    ? projectionBooking.occurrenceOverrides.filter(isRecord) as LessonOccurrenceOverride[]
    : [];
  const targetDates = [
    stateText(projectionBooking, "date", "booking"),
    sourceEnd,
    ...overrides.flatMap((override) => typeof override.date === "string" ? [override.date] : []),
  ].sort();
  const sourceRange = lessonOccurrenceSourceRangeForTargetRange(targetDates[0], targetDates.at(-1)!, overrides);
  return bookingOccurrences(projectionBooking, sourceRange.rangeStart, sourceRange.rangeEnd)
    .filter((occurrence) => occurrence.date >= targetDates[0] && occurrence.date <= targetDates.at(-1)!);
}

function assertNoConflict(input: {
  booking: RecordValue;
  proposedOccurrences: readonly ReturnType<typeof bookingOccurrences>[number][];
  existingBookings: readonly RecordValue[];
  excludeBookingId: string;
}) {
  const timezone = stateText(input.booking, "timezone", "booking");
  const proposed = input.proposedOccurrences
    .filter((occurrence) => occurrence.status !== "cancelled" && occurrence.status !== "leave")
    .map((occurrence) => {
      const startsAt = bookingInstant(occurrence.date, occurrence.start, timezone).getTime();
      return {
        occurrence,
        startsAt,
        endsAt: startsAt + occurrence.scheduledDurationMinutes * 60_000,
      };
    });
  if (!proposed.length) return;
  const targetDates = proposed.map((candidate) => candidate.occurrence.date).sort();
  const targetRangeStart = addDays(targetDates[0], -7);
  const targetRangeEnd = addDays(targetDates.at(-1)!, 7);

  for (let index = 0; index < proposed.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < proposed.length; otherIndex += 1) {
      const left = proposed[index];
      const right = proposed[otherIndex];
      const sameParty = left.occurrence.studentId === right.occurrence.studentId
        || left.occurrence.teacherId === right.occurrence.teacherId;
      if (sameParty && left.startsAt < right.endsAt && right.startsAt < left.endsAt) {
        fail("schedule_conflict", `${right.occurrence.date} conflicts with another proposed lesson in this series.`);
      }
    }
  }

  for (const existing of input.existingBookings) {
    if (existing.id === input.excludeBookingId) continue;
    const existingTimezone = stateText(existing, "timezone", "booking");
    const overrides = Array.isArray(existing.occurrenceOverrides)
      ? existing.occurrenceOverrides.filter(isRecord) as LessonOccurrenceOverride[]
      : [];
    const sourceRange = lessonOccurrenceSourceRangeForTargetRange(targetRangeStart, targetRangeEnd, overrides);
    for (const occurrence of bookingOccurrences(existing, sourceRange.rangeStart, sourceRange.rangeEnd)
      .filter((item) => item.date >= targetRangeStart && item.date <= targetRangeEnd)) {
      if (occurrence.status === "cancelled" || occurrence.status === "leave") continue;
      const existingStart = bookingInstant(occurrence.date, occurrence.start, existingTimezone).getTime();
      const existingEnd = existingStart + occurrence.scheduledDurationMinutes * 60_000;
      const overlap = proposed.find((candidate) =>
        (occurrence.studentId === candidate.occurrence.studentId || occurrence.teacherId === candidate.occurrence.teacherId)
        && candidate.startsAt < existingEnd
        && existingStart < candidate.endsAt);
      if (overlap) fail("schedule_conflict", `${overlap.occurrence.date} conflicts with an existing student or teacher booking.`);
    }
  }
}

const CLASSROOM_STATUS_RANK = { ready: 1, running: 2, ended: 3 } as const;

function classroomStatus(value: unknown, label: string): keyof typeof CLASSROOM_STATUS_RANK {
  if (value !== "ready" && value !== "running" && value !== "ended") {
    fail("invalid_shared_state", `${label} status is invalid.`);
  }
  return value;
}

function classroomCreatedAt(existing: RecordValue | undefined, now: Date) {
  const createdAt = existing?.createdAt;
  if (typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt))) return createdAt;
  if (!Number.isFinite(now.getTime())) fail("invalid_request", "classroom binding time is invalid.");
  return now.toISOString();
}

export function prepareBookingCapacityMutation(input: {
  command: BookingCapacityCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role?: DemoSessionRole;
  authorization?: DemoSessionIdentity;
  fullAdmin: boolean;
  now?: Date;
}): PreparedBookingCapacityMutation {
  const bookingRow = payloadRow(input.rows, "bookings");
  const studentRow = payloadRow(input.rows, "students");
  const lpItemRow = payloadRow(input.rows, "lpItems");
  const taskRow = payloadRow(input.rows, "tasks");
  const teacherRow = payloadRow(input.rows, "teachers");
  for (const [entity, row] of [["bookings", bookingRow], ["students", studentRow], ["lpItems", lpItemRow], ["tasks", taskRow], ["teachers", teacherRow]] as const) {
    if (row.version !== input.command.expectedVersions[entity]) {
      fail("stale_expected_version", `${entity} changed after this command was opened.`);
    }
  }
  const access = buildOpsAccessContext(
    input.rows as OpsStateRow[],
    input.actor,
    input.fullAdmin,
    input.authorization ?? input.role,
  );
  const admin = access.fullAdmin || access.limitedAdmin;
  const existing = bookingRow.payload.find((booking) => booking.id === input.command.bookingId);
  if ((input.command.action === "delete" || input.command.action === "cancel_occurrence" || input.command.action === "update_occurrence" || input.command.action === "bind_classroom") && !existing) {
    fail("booking_not_found", "Booking was not found.");
  }
  if ((input.command.action === "upsert" || input.command.action === "upsert_bind_classroom") && existing && existing.id !== input.command.bookingId) fail("invalid_shared_state", "Booking identity changed.");

  const targetStudentId = input.command.booking?.studentId ?? stateText(existing!, "studentId", "booking");
  const targetTeacherId = input.command.booking?.teacherId ?? stateText(existing!, "teacherId", "booking");
  let ledgerStudentId = targetStudentId;
  let ledgerTeacherId = targetTeacherId;
  const oldStudentId = existing ? stateText(existing, "studentId", "booking") : targetStudentId;
  const oldTeacherId = existing ? stateText(existing, "teacherId", "booking") : targetTeacherId;
  const targetStudent = studentRow.payload.find((student) => student.id === targetStudentId);
  const targetTeacher = teacherRow.payload.find((teacher) => teacher.id === targetTeacherId);
  if (!targetStudent) fail("student_not_found", "Booking student was not found.");
  if (!targetTeacher) fail("teacher_not_found", "Booking teacher was not found.");

  if (!canWriteOpsTransaction(access, "bookings", ["bookings", "students", "lpItems", "tasks", "teachers"])
      || (!admin && !access.staff && !access.teacher)) {
    fail("student_scope_forbidden", "Current account cannot mutate bookings.");
  }
  if (input.command.action === "upsert_bind_classroom" && !admin) {
    fail("classroom_scope_forbidden", "只有管理员可以创建带业务记录的临时课堂。");
  }
  if (input.command.action !== "bind_classroom") {
    if (!canOperateStudent(access, targetStudentId)) fail("student_scope_forbidden", "Archived students' bookings cannot be created, changed, or deleted.");
    if (existing && !canOperateStudent(access, oldStudentId)) fail("student_scope_forbidden", "Archived students' bookings cannot be changed or deleted.");
  }
  if (access.teacher && input.command.action !== "bind_classroom") {
    if (input.command.action === "delete") fail("teacher_forbidden", "Teacher accounts cannot delete a booking series.");
    if (!access.teacherIds.has(targetTeacherId) || (existing && oldTeacherId !== targetTeacherId)) {
      fail("teacher_forbidden", "Teacher accounts cannot change the assigned teacher.");
    }
    if (existing && oldStudentId !== targetStudentId) fail("assignment_change_forbidden", "Teacher accounts cannot change the assigned student.");
    if (!existing && !activeRelationship(bookingRow.payload, targetTeacherId, targetStudentId)) {
      fail("teacher_forbidden", "Teacher accounts cannot assign a new student; operations must create the first booking.");
    }
  }

  let nextBookings: RecordValue[];
  let action: PreparedBookingCapacityMutation["action"];
  if (input.command.action === "delete") {
    nextBookings = bookingRow.payload.filter((booking) => booking.id !== input.command.bookingId);
    action = "delete";
  } else if (input.command.action === "bind_classroom") {
    const bindingRole = input.role ?? (admin ? "admin" : access.teacher ? "teacher" : access.staff ? "staff" : undefined);
    if (!bindingRole || bindingRole === "staff" || (!admin && !access.teacher)) {
      fail("classroom_scope_forbidden", "只有管理员或本节课当前授课老师可以绑定在线教室。");
    }
    const occurrenceId = input.command.occurrenceId!;
    const occurrence = classroomOccurrenceForBooking(existing!, occurrenceId);
    if (["cancelled", "leave", "completed", "abnormal"].includes(occurrence.status)) {
      fail("classroom_unavailable", "当前课次状态不能绑定在线教室。");
    }
    const effectiveStudentId = occurrence.studentId ?? stateText(existing!, "studentId", "booking");
    const effectiveTeacherId = occurrence.teacherId ?? stateText(existing!, "teacherId", "booking");
    ledgerStudentId = effectiveStudentId;
    ledgerTeacherId = effectiveTeacherId;
    const effectiveStudent = studentRow.payload.find((student) => student.id === effectiveStudentId);
    if (!effectiveStudent) {
      fail("student_not_found", "Booking student was not found.");
    }
    if (!teacherRow.payload.some((teacher) => teacher.id === effectiveTeacherId)) {
      fail("teacher_not_found", "Booking teacher was not found.");
    }
    // A substitution can make the occurrence's effective teacher differ from
    // the parent series teacher. Keep this authorization narrow: a teacher
    // may bind only when their signed teacher identity is the occurrence's
    // effective teacher, and the effective student is still active. This
    // avoids widening the ordinary schedule scope just for classroom state.
    const effectiveStudentActive = effectiveStudent.importArchived !== true;
    const effectiveClassroomScope = admin
      ? effectiveStudentActive
      : access.teacher && effectiveStudentActive && access.teacherIds.has(effectiveTeacherId);
    if (!effectiveClassroomScope) {
      fail("classroom_scope_forbidden", "当前账号不能绑定这节课的在线教室。");
    }
    if (access.teacher && !access.teacherIds.has(effectiveTeacherId)) {
      fail("classroom_scope_forbidden", "只有本节课当前授课老师可以绑定在线教室。");
    }
    let classroom = input.command.classroom!;
    let expectedMeetingId: string;
    try {
      expectedMeetingId = meetingIdForOccurrenceValue(occurrenceId);
    } catch {
      fail("classroom_meeting_id_mismatch", "在线教室会议 ID 与课次不匹配。");
    }
    if (classroom.meetingId !== expectedMeetingId) {
      fail("classroom_meeting_id_mismatch", "在线教室会议 ID 与课次不匹配。");
    }
    const overrides = Array.isArray(existing!.occurrenceOverrides)
      ? existing!.occurrenceOverrides.filter(isRecord) as LessonOccurrenceOverride[]
      : [];
    const currentOverride = overrides.find((candidate) => candidate.occurrenceId === occurrenceId);
    const currentClassroom = isRecord(currentOverride?.classroom) ? currentOverride?.classroom : undefined;
    if (currentClassroom) {
      if (currentClassroom.meetingId !== expectedMeetingId) {
        fail("classroom_meeting_id_mismatch", "已有在线教室会议 ID 与课次不匹配。");
      }
      const currentStatus = classroomStatus(currentClassroom.status, "classroom");
      if (CLASSROOM_STATUS_RANK[classroom.status] < CLASSROOM_STATUS_RANK[currentStatus]) {
        // Provider polling can arrive out of order. Preserve the authoritative
        // monotonic state instead of allowing a stale ready/running callback to
        // regress an ended room.
        classroom = { ...classroom, status: currentStatus };
      }
    }
    const nextClassroom = {
      occurrenceId,
      meetingId: expectedMeetingId,
      status: classroom.status,
      createdAt: classroomCreatedAt(currentClassroom, input.now ?? new Date()),
    } satisfies NonNullable<LessonOccurrenceOverride["classroom"]>;
    const nextOverride: LessonOccurrenceOverride = {
      ...(currentOverride ?? { occurrenceId }),
      occurrenceId,
      classroom: nextClassroom,
    };
    const nextBooking: RecordValue = {
      ...existing!,
      occurrenceOverrides: [
        ...overrides.filter((candidate) => candidate.occurrenceId !== occurrenceId),
        nextOverride,
      ].sort((left, right) => stateText(left, "occurrenceId", "occurrence override")
        .localeCompare(stateText(right, "occurrenceId", "occurrence override"))),
    };
    nextBookings = bookingRow.payload.map((candidate) => candidate.id === input.command.bookingId ? nextBooking : candidate);
    // `studentId`/`teacherId` are the effective identities used by the
    // classroom authorization and replay ledger. The SQL wrapper derives the
    // parent identities for its booking-capacity core call.
    action = "update";
  } else if (input.command.action === "cancel_occurrence" || input.command.action === "update_occurrence") {
    const occurrenceId = input.command.occurrenceId!;
    const sourceDate = occurrenceId.slice(-10);
    const occurrence = bookingOccurrences(existing!, sourceDate, sourceDate)
      .find((candidate) => candidate.occurrenceId === occurrenceId);
    if (!occurrence) fail("occurrence_not_found", "Booking occurrence was not found.");
    if (["completed", "abnormal", "leave"].includes(occurrence.status)) {
      fail("invalid_request", "Completed, abnormal or leave occurrences cannot be cancelled here.");
    }
    const overrides = Array.isArray(existing!.occurrenceOverrides)
      ? existing!.occurrenceOverrides.filter(isRecord)
      : [];
    const currentOverride = overrides.find((candidate) => candidate.occurrenceId === occurrenceId);
    const nextOverride = input.command.action === "cancel_occurrence"
      ? { ...(currentOverride ?? {}), occurrenceId, status: "cancelled" }
      : {
          ...(currentOverride ?? {}),
          occurrenceId,
          date: input.command.occurrence!.date,
          start: input.command.occurrence!.start,
          durationMinutes: input.command.occurrence!.duration,
          status: input.command.occurrence!.status,
        };
    const nextBooking: RecordValue = {
      ...existing!,
      occurrenceOverrides: [
        ...overrides.filter((candidate) => candidate.occurrenceId !== occurrenceId),
        nextOverride,
      ].sort((left, right) => stateText(left, "occurrenceId", "occurrence override")
        .localeCompare(stateText(right, "occurrenceId", "occurrence override"))),
    };
    nextBookings = bookingRow.payload.map((candidate) => candidate.id === input.command.bookingId ? nextBooking : candidate);
    if (input.command.action === "update_occurrence") {
      const now = input.now ?? new Date();
      const changed = input.command.occurrence!;
      const changedEnd = bookingInstant(changed.date, changed.start, stateText(existing!, "timezone", "booking")).getTime()
        + changed.duration * 60_000;
      if (changedEnd < now.getTime()) fail("past_booking", "Past lesson occurrences cannot be edited.");
      const validationBooking = nextBooking.recurring === true
        && nextBooking.repeatCount === undefined
        && nextBooking.recurrenceEndDate === undefined
        ? { ...nextBooking, repeatCount: 104 }
        : nextBooking;
      const proposedOccurrences = projectedBookingOccurrences(validationBooking);
      assertNoConflict({
        booking: nextBooking,
        proposedOccurrences,
        existingBookings: bookingRow.payload,
        excludeBookingId: input.command.bookingId,
      });
      if (!teacherAvailable(targetTeacher, nextBooking, proposedOccurrences)) {
        fail("teacher_unavailable", `${stateText(targetTeacher, "name", "teacher")} is unavailable for one or more proposed lessons.`);
      }
      assertPackageReservation({
        student: targetStudent,
        bookings: nextBookings,
        booking: {
          studentId: targetStudentId,
          teacherId: targetTeacherId,
          date: stateText(existing!, "date", "booking"),
          start: stateText(existing!, "start", "booking"),
          duration: typeof existing!.duration === "number" ? existing!.duration : 60,
          kind: stateText(existing!, "kind", "booking") as "试听" | "常规课" | "代课",
          timezone: stateText(existing!, "timezone", "booking"),
          recurring: existing!.recurring === true,
          ...(typeof existing!.repeatCount === "number" ? { repeatCount: existing!.repeatCount } : {}),
          ...(typeof existing!.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: existing!.recurrenceIntervalDays } : {}),
          ...(typeof existing!.recurrenceEndDate === "string" ? { recurrenceEndDate: existing!.recurrenceEndDate } : {}),
          ...(typeof existing!.packageId === "string" ? { packageId: existing!.packageId } : {}),
          subjectId: stateText(existing!, "course", "booking"),
          teacherSubjectId: stateText(existing!, "teacherSubjectId", "booking"),
        },
        now,
      });
    }
    action = "update";
  } else {
    const booking = input.command.booking!;
    assertPackageAndSubject(targetStudent, booking);
    assertTeacherSubject(targetTeacher, booking);
    const createsTeacherStudentRelationship = booking.kind !== "代课"
      && !activeRelationship(bookingRow.payload, targetTeacherId, targetStudentId);
    if (createsTeacherStudentRelationship && targetTeacher.acceptsStudents !== true) {
      fail("teacher_not_accepting", `${stateText(targetTeacher, "name", "teacher")} is not accepting new students.`);
    }
    if (booking.recurring && booking.repeatCount === undefined
      && existing?.recurring === true
      && (typeof booking.recurrenceIntervalDays === "number" ? booking.recurrenceIntervalDays : existing.recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS) !== LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS
      && booking.recurrenceEndDate === undefined
      && (typeof existing.recurrenceEndDate !== "string" || recurrenceEndDateDerivedFromCount(existing))) {
      fail("invalid_request", "A count-less legacy weekly series cannot change frequency without repeatCount or recurrenceEndDate.");
    }
    if (!existing && booking.recurring && booking.recurrenceIntervalDays === undefined) {
      fail("invalid_request", "New recurring bookings must persist recurrenceIntervalDays.");
    }
    // A count-less legacy series uses the compatibility 104-occurrence
    // horizon only while it is genuinely unbounded.  Once either the command
    // or the stored row supplies an explicit end date, that date is the
    // authoritative bound and must not be truncated by the compatibility
    // horizon (especially when it is more than 104 intervals away).
    const existingEndDateIsDerived = existing ? recurrenceEndDateDerivedFromCount(existing) : false;
    const effectiveRecurrenceEndDate = typeof booking.recurrenceEndDate === "string"
      ? booking.recurrenceEndDate
      : typeof existing?.recurrenceEndDate === "string" && !existingEndDateIsDerived
        ? existing.recurrenceEndDate
        : undefined;
    const legacyRepeatCount = existing?.recurring === true && existing.repeatCount === undefined
      && effectiveRecurrenceEndDate === undefined && booking.repeatCount === undefined
      ? 104
      : existing?.recurring === true && typeof existing.repeatCount === "number" && booking.repeatCount === undefined
        ? existing.repeatCount
        : undefined;
    const now = input.now ?? new Date();
    const firstInstant = bookingInstant(booking.date, booking.start, booking.timezone);
    if (!existing && firstInstant.getTime() + booking.duration * 60_000 < now.getTime()) fail("past_booking", "Past bookings cannot be created.");
    if (!existing && booking.kind === "试听" && firstInstant.getTime() <= now.getTime()) fail("past_booking", "A trial must start in the future.");
    if (existing) {
      const existingInstant = bookingInstant(
        stateText(existing, "date", "booking"),
        stateText(existing, "start", "booking"),
        stateText(existing, "timezone", "booking"),
      );
      const existingDuration = typeof existing.duration === "number" ? existing.duration : 0;
      if (existingInstant.getTime() + existingDuration * 60_000 < now.getTime()) fail("past_booking", "Archived bookings cannot be edited.");
    }
    const nextBooking: RecordValue = {
      ...(existing ?? {}),
      id: input.command.bookingId,
      studentId: booking.studentId,
      teacherId: booking.teacherId,
      date: booking.date,
      start: booking.start,
      duration: booking.duration,
      kind: booking.kind,
      status: "待确认",
      timezone: booking.timezone,
      recurring: booking.recurring,
      repeatCount: booking.recurring ? booking.repeatCount : 1,
      ...(booking.recurring && booking.recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
      ...(booking.recurring && effectiveRecurrenceEndDate !== undefined ? { recurrenceEndDate: effectiveRecurrenceEndDate } : {}),
      packageId: booking.packageId,
      course: booking.subjectId,
      teacherSubjectId: booking.teacherSubjectId,
      requestedAt: optionalText(existing?.requestedAt) ?? now.toISOString(),
      ...(Array.isArray(existing?.occurrenceOverrides) ? { occurrenceOverrides: existing.occurrenceOverrides } : {}),
    };
    if (!booking.recurring) nextBooking.repeatCount = 1;
    if (booking.recurring && booking.repeatCount === undefined) delete nextBooking.repeatCount;
    if (!booking.recurring) {
      delete nextBooking.recurrenceIntervalDays;
      delete nextBooking.recurrenceEndDate;
    }
    if (booking.recurring && effectiveRecurrenceEndDate === undefined) {
      // A count-derived end is a projection, not an editable cap.  Do not
      // retain it from the spread existing row when the series is edited.
      delete nextBooking.recurrenceEndDate;
    }
    if (!booking.packageId) delete nextBooking.packageId;
    if (input.command.action === "upsert_bind_classroom") {
      const occurrenceId = input.command.occurrenceId!;
      // Validate against the proposed booking before attaching classroom
      // metadata. This is the create path, so there is no existing row whose
      // occurrence expansion could otherwise act as an accidental authority.
      classroomOccurrenceForBooking(nextBooking, occurrenceId);
      const overrides = Array.isArray(nextBooking.occurrenceOverrides)
        ? nextBooking.occurrenceOverrides.filter(isRecord) as LessonOccurrenceOverride[]
        : [];
      const currentOverride = overrides.find((candidate) => candidate.occurrenceId === occurrenceId);
      const currentClassroom = isRecord(currentOverride?.classroom) ? currentOverride.classroom : undefined;
      const requestedClassroom = input.command.classroom!;
      let classroom = requestedClassroom;
      if (currentClassroom) {
        if (currentClassroom.meetingId !== requestedClassroom.meetingId) {
          fail("classroom_meeting_id_mismatch", "已有在线教室会议 ID 与课次不匹配。");
        }
        const currentStatus = classroomStatus(currentClassroom.status, "classroom");
        if (CLASSROOM_STATUS_RANK[classroom.status] < CLASSROOM_STATUS_RANK[currentStatus]) {
          classroom = { ...classroom, status: currentStatus };
        }
      }
      const nextClassroom = {
        occurrenceId,
        meetingId: requestedClassroom.meetingId,
        status: classroom.status,
        createdAt: classroomCreatedAt(currentClassroom, input.now ?? new Date()),
      } satisfies NonNullable<LessonOccurrenceOverride["classroom"]>;
      const nextOverride: LessonOccurrenceOverride = {
        ...(currentOverride ?? { occurrenceId }),
        occurrenceId,
        classroom: nextClassroom,
      };
      nextBooking.occurrenceOverrides = [
        ...overrides.filter((candidate) => candidate.occurrenceId !== occurrenceId),
        nextOverride,
      ].sort((left, right) => stateText(left, "occurrenceId", "occurrence override")
        .localeCompare(stateText(right, "occurrenceId", "occurrence override")));
    }
    const validationBooking = nextBooking.recurring === true
      && nextBooking.repeatCount === undefined
      && nextBooking.recurrenceEndDate === undefined
      ? { ...nextBooking, repeatCount: legacyRepeatCount ?? 104 }
      : nextBooking;
    const proposedOccurrences = projectedBookingOccurrences(validationBooking);
    assertNoConflict({ booking: nextBooking, proposedOccurrences, existingBookings: bookingRow.payload, excludeBookingId: input.command.bookingId });
    if (!teacherAvailable(targetTeacher, nextBooking, proposedOccurrences)) {
      fail("teacher_unavailable", `${stateText(targetTeacher, "name", "teacher")} is unavailable for one or more proposed lessons.`);
    }
    nextBookings = existing
      ? bookingRow.payload.map((candidate) => candidate.id === input.command.bookingId ? nextBooking : candidate)
      : [...bookingRow.payload, nextBooking];
    assertPackageReservation({ student: targetStudent, bookings: nextBookings, booking, now });
    action = existing ? "update" : "create";
  }

  const pairs: Array<readonly [string, string]> = [[oldTeacherId, oldStudentId], [targetTeacherId, targetStudentId]];
  const capacity = reconcileCapacity({
    beforeBookings: bookingRow.payload,
    afterBookings: nextBookings,
    teachers: teacherRow.payload,
    pairs,
  });
  if (access.teacher && capacity.changedTeacherIds.length) fail("teacher_forbidden", "Teacher accounts cannot change new-student capacity.");
  return {
    action,
    bookingId: input.command.bookingId,
    commandKey: bookingCapacityCommandKey(input.command),
    commandIntent: bookingCapacityCommandIntent(input.command),
    expectedVersions: input.command.expectedVersions,
    bookings: nextBookings,
    teachers: capacity.teachers,
    changedTeacherIds: capacity.changedTeacherIds,
    studentId: ledgerStudentId,
    teacherId: ledgerTeacherId,
  };
}

import { createHash } from "node:crypto";

import { buildOpsAccessContext, canOperateStudent } from "@/lib/ops-access";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";
import { expandLessonOccurrences, type LessonOccurrenceOverride } from "@/lib/lesson-occurrences";
import { getLessonPackageBalance, type StudentLessonPackage } from "@/lib/student-records";
import {
  expandTeacherAvailability,
  type TeacherAvailabilityWindow,
} from "@/lib/teacher-availability";

type RecordValue = Record<string, unknown>;

const BOOKING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const REQUEST_FIELDS = new Set(["action", "bookingId", "expectedVersions", "booking"]);
const VERSION_FIELDS = new Set(["bookings", "students", "teachers"]);
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
  "packageId",
  "subjectId",
]);

export type BookingCapacityCommand = Readonly<{
  action: "upsert" | "delete";
  bookingId: string;
  expectedVersions: Readonly<{
    bookings: number;
    students: number;
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
    packageId?: string;
    subjectId: string;
  }>;
}>;

export type BookingCapacityServiceErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "booking_not_found"
  | "student_not_found"
  | "teacher_not_found"
  | "student_scope_forbidden"
  | "teacher_forbidden"
  | "assignment_change_forbidden"
  | "package_required"
  | "package_subject_mismatch"
  | "package_balance_insufficient"
  | "subject_not_allowed"
  | "teacher_not_accepting"
  | "teacher_capacity_unconfigured"
  | "teacher_capacity_exhausted"
  | "teacher_unavailable"
  | "schedule_conflict"
  | "past_booking";

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
  booking?: BookingCapacityCommand["booking"];
}>;

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
  if (action !== "upsert" && action !== "delete") fail("invalid_request", "action must be upsert or delete.");
  const bookingId = requiredText(value.bookingId, "bookingId");
  if (!BOOKING_ID_PATTERN.test(bookingId)) fail("invalid_request", "bookingId is invalid.");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertOnlyFields(value.expectedVersions, VERSION_FIELDS);
  const expectedVersions = {
    bookings: version(value.expectedVersions.bookings, "expectedVersions.bookings"),
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    teachers: version(value.expectedVersions.teachers, "expectedVersions.teachers"),
  };
  if (action === "delete") {
    if (value.booking !== undefined) fail("client_fields_forbidden", "Delete commands cannot submit booking data.");
    return { action, bookingId, expectedVersions };
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
  if (![60, 90, 120].includes(duration as number)) fail("invalid_request", "booking.duration must be 60, 90 or 120 minutes.");
  const kind = value.booking.kind;
  if (kind !== "试听" && kind !== "常规课" && kind !== "代课") fail("invalid_request", "booking.kind is invalid.");
  if (typeof value.booking.recurring !== "boolean") fail("invalid_request", "booking.recurring must be boolean.");
  const repeatCount = value.booking.repeatCount;
  if (repeatCount !== undefined && (!Number.isSafeInteger(repeatCount) || (repeatCount as number) < 1 || (repeatCount as number) > 104)) {
    fail("invalid_request", "booking.repeatCount must be from 1 to 104.");
  }
  return {
    action,
    bookingId,
    expectedVersions,
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
      ...(optionalText(value.booking.packageId) ? { packageId: optionalText(value.booking.packageId) } : {}),
      subjectId: requiredText(value.booking.subjectId, "booking.subjectId"),
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
      studentId: optionalText(booking.studentId),
      teacherId: optionalText(booking.teacherId),
      packageId: optionalText(booking.packageId),
      course: optionalText(booking.course),
    }, { rangeStart, rangeEnd, overrides });
  } catch (error) {
    fail("invalid_shared_state", error instanceof Error ? error.message : "booking is invalid.");
  }
}

function teacherAvailable(teacher: RecordValue, booking: RecordValue, proposedDates: readonly string[]) {
  if (!Array.isArray(teacher.availabilityWindows)) return false;
  const windows = teacher.availabilityWindows as TeacherAvailabilityWindow[];
  const timezone = stateText(booking, "timezone", "booking");
  const start = stateText(booking, "start", "booking");
  const duration = booking.duration as number;
  try {
    return proposedDates.every((date) => {
      const requestedStart = bookingInstant(date, start, timezone);
      const requestedEnd = new Date(requestedStart.getTime() + duration * 60_000);
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
  return bookings.some((booking) =>
    booking.kind !== "代课"
    && booking.teacherId === teacherId
    && booking.studentId === studentId);
}

function capacityAssignments(teacher: RecordValue) {
  const value = teacher.capacityAssignments;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    fail("invalid_shared_state", "teacher.capacityAssignments is invalid.");
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function reconcileCapacity(input: {
  beforeBookings: readonly RecordValue[];
  afterBookings: readonly RecordValue[];
  teachers: readonly RecordValue[];
  pairs: ReadonlyArray<readonly [string, string]>;
}) {
  const nextTeachers = input.teachers.map((teacher) => ({ ...teacher }));
  const changed = new Set<string>();
  const seenPairs = new Set<string>();
  for (const [teacherId, studentId] of input.pairs) {
    const pairKey = `${teacherId}\u0000${studentId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const before = activeRelationship(input.beforeBookings, teacherId, studentId);
    const after = activeRelationship(input.afterBookings, teacherId, studentId);
    if (before === after) continue;
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
    if (!before && after) {
      if (!assigned && !numericCapacity) {
        fail("teacher_capacity_unconfigured", `${stateText(teacher, "name", "teacher")} must have new-student capacity configured before the first assignment.`);
      }
      if (!assigned && (teacher.newStudentCapacity as number) <= 0) {
        fail("teacher_capacity_exhausted", `${stateText(teacher, "name", "teacher")} has no remaining new-student capacity.`);
      }
      nextTeachers[index] = {
        ...teacher,
        capacityAssignments: assigned ? assignments : [...assignments, studentId].sort(),
        ...(!assigned ? { newStudentCapacity: (teacher.newStudentCapacity as number) - 1 } : {}),
      };
      changed.add(teacherId);
    } else if (before && !after && assigned) {
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

function bookingSourceEnd(booking: RecordValue) {
  const date = stateText(booking, "date", "booking");
  if (booking.recurring !== true) return date;
  if (!Number.isSafeInteger(booking.repeatCount) || (booking.repeatCount as number) < 1) {
    fail("invalid_shared_state", "A billable recurring booking must have a finite repeatCount.");
  }
  return addDays(date, ((booking.repeatCount as number) - 1) * 7);
}

function reservedPackageHours(input: {
  bookings: readonly RecordValue[];
  studentId: string;
  packageId: string;
  now: Date;
}) {
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
  const reserved = reservedPackageHours({
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

function proposedDates(booking: BookingCapacityCommand["booking"], legacyRepeatCount?: number) {
  if (!booking) return [];
  if (!booking.recurring) return [booking.date];
  const count = booking.repeatCount ?? legacyRepeatCount;
  if (!count) fail("invalid_request", "A new recurring booking must specify repeatCount.");
  return Array.from({ length: count }, (_, index) => addDays(booking.date, index * 7));
}

function assertNoConflict(input: {
  booking: RecordValue;
  dates: readonly string[];
  existingBookings: readonly RecordValue[];
  excludeBookingId: string;
}) {
  const timezone = stateText(input.booking, "timezone", "booking");
  const start = stateText(input.booking, "start", "booking");
  const duration = input.booking.duration as number;
  const proposed = input.dates.map((date) => {
    const startsAt = bookingInstant(date, start, timezone).getTime();
    return { date, startsAt, endsAt: startsAt + duration * 60_000 };
  });
  if (!proposed.length) return;
  const rangeStart = addDays(input.dates[0], -7);
  const rangeEnd = addDays(input.dates[input.dates.length - 1], 7);
  for (const existing of input.existingBookings) {
    if (existing.id === input.excludeBookingId) continue;
    const sameStudent = existing.studentId === input.booking.studentId;
    const sameTeacher = existing.teacherId === input.booking.teacherId;
    if (!sameStudent && !sameTeacher) continue;
    const existingTimezone = stateText(existing, "timezone", "booking");
    for (const occurrence of bookingOccurrences(existing, rangeStart, rangeEnd)) {
      if (occurrence.status === "cancelled" || occurrence.status === "leave") continue;
      const existingStart = bookingInstant(occurrence.date, occurrence.start, existingTimezone).getTime();
      const existingEnd = existingStart + occurrence.scheduledDurationMinutes * 60_000;
      const overlap = proposed.find((candidate) => candidate.startsAt < existingEnd && existingStart < candidate.endsAt);
      if (overlap) fail("schedule_conflict", `${overlap.date} conflicts with an existing student or teacher booking.`);
    }
  }
}

export function prepareBookingCapacityMutation(input: {
  command: BookingCapacityCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role?: DemoSessionRole;
  fullAdmin: boolean;
  now?: Date;
}): PreparedBookingCapacityMutation {
  const bookingRow = payloadRow(input.rows, "bookings");
  const studentRow = payloadRow(input.rows, "students");
  const teacherRow = payloadRow(input.rows, "teachers");
  for (const [entity, row] of [["bookings", bookingRow], ["students", studentRow], ["teachers", teacherRow]] as const) {
    if (row.version !== input.command.expectedVersions[entity]) {
      fail("stale_expected_version", `${entity} changed after this command was opened.`);
    }
  }
  const access = buildOpsAccessContext(input.rows as OpsStateRow[], input.actor, input.fullAdmin, input.role);
  const admin = access.fullAdmin || access.limitedAdmin;
  const existing = bookingRow.payload.find((booking) => booking.id === input.command.bookingId);
  if (input.command.action === "delete" && !existing) fail("booking_not_found", "Booking was not found.");
  if (input.command.action === "upsert" && existing && existing.id !== input.command.bookingId) fail("invalid_shared_state", "Booking identity changed.");

  const targetStudentId = input.command.booking?.studentId ?? stateText(existing!, "studentId", "booking");
  const targetTeacherId = input.command.booking?.teacherId ?? stateText(existing!, "teacherId", "booking");
  const oldStudentId = existing ? stateText(existing, "studentId", "booking") : targetStudentId;
  const oldTeacherId = existing ? stateText(existing, "teacherId", "booking") : targetTeacherId;
  const targetStudent = studentRow.payload.find((student) => student.id === targetStudentId);
  const targetTeacher = teacherRow.payload.find((teacher) => teacher.id === targetTeacherId);
  if (!targetStudent) fail("student_not_found", "Booking student was not found.");
  if (!targetTeacher) fail("teacher_not_found", "Booking teacher was not found.");

  if (!admin && (!access.staff && !access.teacher)) fail("student_scope_forbidden", "Current account cannot mutate bookings.");
  if (!canOperateStudent(access, targetStudentId)) fail("student_scope_forbidden", "Archived students' bookings cannot be created, changed, or deleted.");
  if (existing && !canOperateStudent(access, oldStudentId)) fail("student_scope_forbidden", "Archived students' bookings cannot be changed or deleted.");
  if (access.teacher) {
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
  } else {
    const booking = input.command.booking!;
    assertPackageAndSubject(targetStudent, booking);
    if (booking.kind === "试听" && targetTeacher.acceptsStudents !== true) {
      fail("teacher_not_accepting", `${stateText(targetTeacher, "name", "teacher")} is not accepting trial students.`);
    }
    const dates = proposedDates(booking, existing?.recurring === true && typeof existing.repeatCount === "number" ? existing.repeatCount : undefined);
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
      packageId: booking.packageId,
      course: booking.subjectId,
      requestedAt: optionalText(existing?.requestedAt) ?? now.toISOString(),
    };
    if (!booking.recurring) nextBooking.repeatCount = 1;
    if (booking.recurring && booking.repeatCount === undefined) delete nextBooking.repeatCount;
    if (!booking.packageId) delete nextBooking.packageId;
    assertNoConflict({ booking: nextBooking, dates, existingBookings: bookingRow.payload, excludeBookingId: input.command.bookingId });
    if (!teacherAvailable(targetTeacher, nextBooking, dates)) {
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
    studentId: targetStudentId,
    teacherId: targetTeacherId,
  };
}

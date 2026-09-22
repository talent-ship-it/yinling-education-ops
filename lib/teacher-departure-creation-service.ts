import { createHash } from "node:crypto";

import type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";
import { canOperateStudent, buildOpsAccessContext, canWriteOpsTransaction } from "@/lib/ops-access";
import {
  expandLessonOccurrences,
  lessonOccurrenceSourceRangeForTargetRange,
  type LessonOccurrence,
  type LessonOccurrenceOverride,
} from "@/lib/lesson-occurrences";
import { DEFAULT_TEACHING_CONTROL_WATCHER, type OpsTask, type TaskTone } from "@/lib/ops-tasks";
import type { OpsStateRow } from "@/lib/ops-store";
import { scheduleDateInTimezone, scheduleOccurrenceInstant, shiftScheduleDate } from "@/lib/schedule-calendar";
import {
  expandTeacherAvailability,
  type TeacherAvailabilityWindow,
} from "@/lib/teacher-availability";
import {
  projectTeacherDepartureOccurrences,
  TeacherDepartureProjectionError,
  type TeacherDepartureBooking,
} from "@/lib/teacher-departure-occurrences";
import { recurrenceSourceEndDate } from "@/lib/booking-recurrence";

type RecordValue = Record<string, unknown>;

const COMMAND_FIELDS = new Set([
  "commandKey",
  "sourceTeacherId",
  "effectiveDate",
  "detail",
  "expectedVersions",
]);
const VERSION_FIELDS = new Set(["bookings", "operations", "students", "tasks", "teachers"]);
const COMMAND_KEY_PATTERN = /^teacher-departure-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_STUDENT_STATUSES = new Set([
  "在读",
  "活跃 + 有课时",
  "活跃 + 无课时",
  "在读 + 加课待排",
]);
const MELBOURNE_TIME_ZONE = "Australia/Melbourne";

type DepartureEntity = "bookings" | "operations" | "students" | "tasks" | "teachers";

export type TeacherDepartureCreationCommand = Readonly<{
  commandKey: string;
  sourceTeacherId: string;
  effectiveDate: string;
  detail: string;
  expectedVersions: Readonly<Record<DepartureEntity, number>>;
}>;

export type TeacherDepartureCreationIntent = Readonly<{
  sourceTeacherId: string;
  effectiveDate: string;
  detail: string;
}>;

export type TeacherDepartureCreationGroup = Readonly<{
  studentId: string;
  operationId: string;
  affectedOccurrenceIds: readonly string[];
  /** Read-only preview metadata; the atomic commit payload strips these fields. */
  subjects: readonly string[];
  firstAffectedAt: string;
  candidateTeacherIds: readonly string[];
}>;

export type PreparedTeacherDepartureCreation = Readonly<{
  commandKey: string;
  commandIntent: TeacherDepartureCreationIntent;
  sourceTeacherId: string;
  effectiveDate: string;
  detail: string;
  expectedVersions: TeacherDepartureCreationCommand["expectedVersions"];
  operations: readonly RecordValue[];
  tasks: readonly RecordValue[];
  affectedGroups: readonly TeacherDepartureCreationGroup[];
  submittedAt: string;
  operationIds: readonly string[];
  affectedStudentIds: readonly string[];
  affectedOccurrenceCount: number;
  generatedTaskCount: number;
}>;

export type TeacherDepartureCreationErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "teacher_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "source_teacher_not_found"
  | "source_teacher_scope_forbidden"
  | "affected_student_not_found"
  | "affected_student_scope_forbidden"
  | "archived_student_read_only"
  | "unbounded_future_series"
  | "affected_occurrence_not_found"
  | "teacher_subject_missing"
  | "replacement_candidate_not_found"
  | "departure_already_exists";

export class TeacherDepartureCreationError extends Error {
  constructor(readonly code: TeacherDepartureCreationErrorCode, message: string) {
    super(message);
    this.name = "TeacherDepartureCreationError";
  }
}

function fail(code: TeacherDepartureCreationErrorCode, message: string): never {
  throw new TeacherDepartureCreationError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyFields(value: RecordValue, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail("client_fields_forbidden", "Only the reviewed teacher-departure command fields may be submitted.");
  }
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid_request", `${field} must be a positive state version.`);
  }
  return value as number;
}

function calendarDate(value: unknown, field: string) {
  const date = requiredText(value, field, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    fail("invalid_request", `${field} must be a valid YYYY-MM-DD date.`);
  }
  return date;
}

export function parseTeacherDepartureCreationCommand(value: unknown): TeacherDepartureCreationCommand {
  if (!isRecord(value)) fail("invalid_request", "Teacher-departure command is missing.");
  assertOnlyFields(value, COMMAND_FIELDS);
  const commandKey = requiredText(value.commandKey, "commandKey", 80);
  if (!COMMAND_KEY_PATTERN.test(commandKey)) fail("invalid_request", "commandKey is invalid.");
  const sourceTeacherId = requiredText(value.sourceTeacherId, "sourceTeacherId", 120);
  if (!ID_PATTERN.test(sourceTeacherId)) fail("invalid_request", "sourceTeacherId is invalid.");
  const effectiveDate = calendarDate(value.effectiveDate, "effectiveDate");
  const detail = requiredText(value.detail, "detail", 2_000);
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertOnlyFields(value.expectedVersions, VERSION_FIELDS);
  return {
    commandKey,
    sourceTeacherId,
    effectiveDate,
    detail,
    expectedVersions: {
      bookings: version(value.expectedVersions.bookings, "expectedVersions.bookings"),
      operations: version(value.expectedVersions.operations, "expectedVersions.operations"),
      students: version(value.expectedVersions.students, "expectedVersions.students"),
      tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
      teachers: version(value.expectedVersions.teachers, "expectedVersions.teachers"),
    },
  };
}

export function teacherDepartureCreationIntent(
  command: Pick<TeacherDepartureCreationCommand, "sourceTeacherId" | "effectiveDate" | "detail">,
): TeacherDepartureCreationIntent {
  return {
    sourceTeacherId: command.sourceTeacherId,
    effectiveDate: command.effectiveDate,
    detail: command.detail,
  };
}

function payloadRow(rows: readonly OpsStateRow[], entity: DepartureEntity) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1
    || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
    fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  const ids = row.payload.map((item) => typeof item.id === "string" ? item.id.trim() : "");
  if (ids.some((id) => !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    fail("invalid_shared_state", `${entity} shared state contains duplicate or invalid ids.`);
  }
  return { ...row, payload: row.payload as RecordValue[] };
}

function text(value: RecordValue, field: string) {
  return typeof value[field] === "string" && (value[field] as string).trim()
    ? (value[field] as string).trim()
    : undefined;
}

function stableId(prefix: "OPS-DEPARTURE" | "TSK-DEPARTURE", seed: string) {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/** IDs are restricted to ASCII; this mirrors PostgreSQL COLLATE "C" exactly. */
function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bookingOverrides(booking: RecordValue): LessonOccurrenceOverride[] {
  if (booking.occurrenceOverrides === undefined) return [];
  if (!Array.isArray(booking.occurrenceOverrides)) {
    fail("invalid_shared_state", "Booking occurrence overrides are invalid.");
  }
  return booking.occurrenceOverrides as LessonOccurrenceOverride[];
}

function expandedWithinDates(booking: RecordValue, rangeStart: string, rangeEnd: string): LessonOccurrence[] {
  const overrides = bookingOverrides(booking);
  try {
    const range = lessonOccurrenceSourceRangeForTargetRange(rangeStart, rangeEnd, overrides);
    return expandLessonOccurrences(booking as TeacherDepartureBooking, {
      ...range,
      overrides,
    }).filter((occurrence) => occurrence.date >= rangeStart
      && occurrence.date <= rangeEnd
      && occurrence.status !== "cancelled"
      && occurrence.status !== "leave");
  } catch {
    fail("invalid_shared_state", "A booking cannot be safely expanded for conflict checks.");
  }
}

function departureOverrideMatches(booking: RecordValue, teacherId: string, studentId: string) {
  return bookingOverrides(booking).some((override) => {
    const resolvedTeacherId = Object.prototype.hasOwnProperty.call(override, "teacherId")
      ? override.teacherId
      : booking.teacherId;
    const resolvedStudentId = Object.prototype.hasOwnProperty.call(override, "studentId")
      ? override.studentId
      : booking.studentId;
    return resolvedTeacherId === teacherId && resolvedStudentId === studentId;
  });
}

function occurrenceInstant(occurrence: LessonOccurrence, booking: RecordValue) {
  const timezone = text(booking, "timezone");
  if (!timezone) fail("invalid_shared_state", "An affected booking is missing its timezone.");
  try {
    return scheduleOccurrenceInstant({
      date: occurrence.date,
      start: occurrence.start,
      timezone,
    });
  } catch {
    fail("invalid_shared_state", "An occurrence time cannot be converted safely.");
  }
}

function teacherWindows(teacher: RecordValue): TeacherAvailabilityWindow[] | null {
  if (!Array.isArray(teacher.availabilityWindows) || !teacher.availabilityWindows.length) return null;
  if (!teacher.availabilityWindows.every(isRecord)) return null;
  const teacherId = text(teacher, "id");
  if (!teacherId || teacher.availabilityWindows.some((window) => window.teacherId !== teacherId)) return null;
  return teacher.availabilityWindows as unknown as TeacherAvailabilityWindow[];
}

function teacherAvailableForOccurrence(
  teacher: RecordValue,
  occurrence: LessonOccurrence,
  booking: RecordValue,
) {
  const windows = teacherWindows(teacher);
  if (!windows) return false;
  const requestedStart = occurrenceInstant(occurrence, booking);
  const requestedEnd = new Date(requestedStart.getTime() + occurrence.scheduledDurationMinutes * 60_000);
  const utcDate = requestedStart.toISOString().slice(0, 10);
  let available;
  try {
    available = expandTeacherAvailability(windows, {
      from: shiftScheduleDate(utcDate, -1),
      to: shiftScheduleDate(utcDate, 1),
      displayTimezone: "UTC",
    });
  } catch {
    return false;
  }
  return available.some((slot) => requestedStart.getTime() >= Date.parse(slot.startsAt)
    && requestedEnd.getTime() <= Date.parse(slot.endsAt));
}

function teacherHasConflict(
  teacherId: string,
  requestedOccurrence: LessonOccurrence,
  requestedBooking: RecordValue,
  bookings: readonly RecordValue[],
) {
  const requestedStart = occurrenceInstant(requestedOccurrence, requestedBooking).getTime();
  const requestedEnd = requestedStart + requestedOccurrence.scheduledDurationMinutes * 60_000;
  return bookings.some((booking) => {
    const timezone = text(booking, "timezone");
    if (!timezone) fail("invalid_shared_state", "A booking is missing its timezone during conflict checks.");
    const firstLocalDate = scheduleDateInTimezone(new Date(requestedStart), timezone);
    const lastLocalDate = scheduleDateInTimezone(new Date(Math.max(requestedStart, requestedEnd - 1)), timezone);
    const rangeStart = shiftScheduleDate(firstLocalDate < lastLocalDate ? firstLocalDate : lastLocalDate, -1);
    const rangeEnd = shiftScheduleDate(firstLocalDate > lastLocalDate ? firstLocalDate : lastLocalDate, 1);
    return expandedWithinDates(booking, rangeStart, rangeEnd).some((occurrence) => {
    if (occurrence.teacherId !== teacherId) return false;
    const existingStart = occurrenceInstant(occurrence, booking).getTime();
    const existingEnd = existingStart + occurrence.scheduledDurationMinutes * 60_000;
    return requestedStart < existingEnd && existingStart < requestedEnd;
    });
  });
}

type AffectedOccurrence = Readonly<{
  booking: RecordValue;
  occurrence: LessonOccurrence;
  teacherSubjectId: string;
}>;

function candidateTeacherIds(input: {
  sourceTeacherId: string;
  studentId: string;
  effectiveDate: string;
  affected: readonly AffectedOccurrence[];
  bookings: readonly RecordValue[];
  teachers: readonly RecordValue[];
}) {
  return input.teachers.filter((teacher) => {
    const teacherId = text(teacher, "id");
    if (!teacherId || teacherId === input.sourceTeacherId) return false;
    if (!Array.isArray(teacher.subjects)
      || !teacher.subjects.every((subject) => typeof subject === "string" && Boolean(subject.trim()))) return false;
    const assignments = teacher.capacityAssignments;
    if (assignments !== undefined
      && (!Array.isArray(assignments)
        || !assignments.every((studentId) => typeof studentId === "string" && Boolean(studentId.trim()))
        || new Set(assignments).size !== assignments.length)) return false;
    const alreadyAssigned = Array.isArray(assignments) && assignments.includes(input.studentId);
    let alreadyActive = false;
    try {
      alreadyActive = projectTeacherDepartureOccurrences({
        bookings: input.bookings as TeacherDepartureBooking[],
        teacherId,
        studentId: input.studentId,
        effectiveDate: input.effectiveDate,
      }).length > 0;
    } catch (error) {
      if (error instanceof TeacherDepartureProjectionError && error.code === "unbounded_future_series") {
        // A count-less existing series still proves that this is not a first
        // teacher/student relationship. It is not part of the departing
        // teacher's mutation closure, so it remains untouched.
        alreadyActive = true;
      } else {
        fail("invalid_shared_state", "An existing candidate relationship cannot be projected safely.");
      }
    }
    const relationshipAlreadyEstablished = alreadyActive || alreadyAssigned;
    if (!relationshipAlreadyEstablished && teacher.acceptsStudents !== true) return false;
    if (!relationshipAlreadyEstablished
      && (!Number.isSafeInteger(teacher.newStudentCapacity) || (teacher.newStudentCapacity as number) <= 0)) return false;
    return input.affected.every(({ occurrence, booking, teacherSubjectId }) =>
      (teacher.subjects as string[]).includes(teacherSubjectId)
      && teacherAvailableForOccurrence(teacher, occurrence, booking)
      && !teacherHasConflict(teacherId, occurrence, booking, input.bookings));
  }).map((teacher) => text(teacher, "id")!).sort(compareAscii);
}

function dueTaskState(dueDate: string, submittedAt: Date, futureTone: TaskTone) {
  const dueAt = scheduleOccurrenceInstant({
    date: dueDate,
    start: "18:00",
    timezone: MELBOURNE_TIME_ZONE,
  });
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(submittedAt)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const status: OpsTask["status"] = dueDate < today ? "overdue" : dueDate === today ? "today" : "upcoming";
  return {
    due: `${dueDate} 18:00`,
    dueAt: dueAt.toISOString(),
    status,
    tone: status === "overdue" ? "red" as const : status === "today" ? "amber" as const : futureTone,
  };
}

/**
 * Finds the finite native occurrences taught by the departing teacher before
 * the effective date.  This is intentionally separate from the future
 * replacement projection: the handover LP deadline is based on the actual
 * penultimate historical lesson, not on an effective-date offset.
 */
function historicalDepartureOccurrences(input: {
  bookings: readonly RecordValue[];
  sourceTeacherId: string;
  studentId: string;
  effectiveDate: string;
}): LessonOccurrence[] {
  const result: LessonOccurrence[] = [];
  for (const booking of input.bookings) {
    if (booking.kind === "代课") continue;
    const canContainTeacher = (booking.teacherId === input.sourceTeacherId
      && booking.studentId === input.studentId)
      || departureOverrideMatches(booking, input.sourceTeacherId, input.studentId);
    if (!canContainTeacher) continue;
    const bookingDate = text(booking, "date");
    if (!bookingDate) fail("invalid_shared_state", "A historical departure lesson is missing its date.");
    const overrides = bookingOverrides(booking);
    const overrideDates = overrides.flatMap((override) => typeof override.date === "string" ? [override.date] : []);
    let sourceEnd: string | undefined;
    try {
      sourceEnd = recurrenceSourceEndDate({
        startDate: bookingDate,
        recurring: booking.recurring === true,
        ...(Number.isSafeInteger(booking.repeatCount) ? { repeatCount: booking.repeatCount as number } : {}),
        ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
        ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
      });
    } catch (error) {
      fail("invalid_shared_state", error instanceof Error ? error.message : "A historical departure lesson has an invalid recurrence range.");
    }
    if (!sourceEnd) {
      fail("unbounded_future_series", "永久换师不能自动处理没有结束次数或结束日期的旧循环课，请先编辑整个课程系列并限定范围。");
    }
    const rangeStart = [bookingDate, ...overrideDates].sort()[0];
    const rangeEnd = [sourceEnd, ...overrideDates].sort().at(-1) ?? sourceEnd;
    const sourceRange = lessonOccurrenceSourceRangeForTargetRange(rangeStart, rangeEnd, overrides);
    let occurrences: LessonOccurrence[];
    try {
      occurrences = expandLessonOccurrences(booking as TeacherDepartureBooking, {
        ...sourceRange,
        overrides,
      });
    } catch {
      fail("invalid_shared_state", "A historical departure lesson cannot be expanded safely.");
    }
    result.push(...occurrences.filter((occurrence) => occurrence.date < input.effectiveDate
      && occurrence.studentId === input.studentId
      && occurrence.teacherId === input.sourceTeacherId
      && occurrence.status !== "cancelled"
      && occurrence.status !== "leave"));
  }
  return result.sort((left, right) =>
    left.date.localeCompare(right.date)
    || left.start.localeCompare(right.start)
    || left.occurrenceId.localeCompare(right.occurrenceId),
  );
}

function penultimateLessonFollowUpDate(input: {
  historicalOccurrences: readonly LessonOccurrence[];
  bookingBySeriesId: ReadonlyMap<string, RecordValue>;
}): string | undefined {
  if (input.historicalOccurrences.length < 2) return undefined;
  const penultimate = input.historicalOccurrences.at(-2);
  if (!penultimate) return undefined;
  const booking = input.bookingBySeriesId.get(penultimate.seriesId);
  if (!booking) return undefined;
  const timezone = text(booking, "timezone");
  if (!timezone) fail("invalid_shared_state", "A historical departure lesson is missing its timezone.");
  try {
    const end = new Date(occurrenceInstant(penultimate, booking).getTime()
      + penultimate.scheduledDurationMinutes * 60_000);
    // Task deadlines are displayed in the operating timezone.  Convert the
    // actual lesson end first, then add one calendar day, at 18:00.
    return shiftScheduleDate(scheduleDateInTimezone(end, MELBOURNE_TIME_ZONE), 1);
  } catch {
    fail("invalid_shared_state", "A historical departure lesson cannot be timed safely.");
  }
}

function departureTask(input: {
  commandKey: string;
  operationId: string;
  studentId: string;
  rule: "recommendation" | "new-teacher-contact" | "handover" | "parent-contact" | "management-watcher" | "lp-to-new-teacher";
  title: string;
  owner: string;
  dueDate: string;
  futureTone: TaskTone;
  trigger: string;
  submittedAt: Date;
}): OpsTask {
  const ruleKey = `teacher-departure:${input.operationId}:${input.rule}`;
  return {
    id: stableId("TSK-DEPARTURE", `${input.commandKey}\u001f${input.studentId}\u001f${input.rule}`),
    title: input.title,
    owner: input.owner,
    assignees: [input.owner],
    watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    studentId: input.studentId,
    ...dueTaskState(input.dueDate, input.submittedAt, input.futureTone),
    category: "请假代课",
    trigger: input.trigger,
    ruleKey,
    anchorBookingId: input.operationId,
  };
}

function tasksForStudent(input: {
  commandKey: string;
  operationId: string;
  studentId: string;
  owner: string;
  effectiveDate: string;
  sourceTeacherId: string;
  sourceTeacherName: string;
  bookings: readonly RecordValue[];
  submittedAt: Date;
}) {
  const fourteenDaysBefore = shiftScheduleDate(input.effectiveDate, -14);
  const sevenDaysBefore = shiftScheduleDate(input.effectiveDate, -7);
  const historicalOccurrences = historicalDepartureOccurrences({
    bookings: input.bookings,
    sourceTeacherId: input.sourceTeacherId,
    studentId: input.studentId,
    effectiveDate: input.effectiveDate,
  });
  const bookingBySeriesId = new Map(input.bookings.map((booking) => [String(booking.id), booking]));
  const lpFollowUpDate = penultimateLessonFollowUpDate({ historicalOccurrences, bookingBySeriesId });
  return [
    departureTask({ ...input, rule: "recommendation", title: "筛选并确认推荐老师名单", owner: "Tiffany", dueDate: fourteenDaysBefore, futureTone: "red", trigger: "老师离职：推荐老师名单" }),
    departureTask({ ...input, rule: "new-teacher-contact", title: "开启新老师沟通", dueDate: fourteenDaysBefore, futureTone: "amber", trigger: "老师离职：新老师沟通" }),
    departureTask({ ...input, rule: "handover", title: "确认 Handover Notes 与原老师约定 DDL", dueDate: sevenDaysBefore, futureTone: "blue", trigger: "老师离职：交接资料" }),
    departureTask({ ...input, rule: "parent-contact", title: "告知家长并记录最终安排", dueDate: sevenDaysBefore, futureTone: "red", trigger: "老师离职：家长沟通" }),
    departureTask({ ...input, rule: "management-watcher", title: "向龙老师汇报离职交接进度", owner: DEFAULT_TEACHING_CONTROL_WATCHER, dueDate: sevenDaysBefore, futureTone: "amber", trigger: "老师离职：管理确认" }),
    ...(lpFollowUpDate ? [departureTask({
      ...input,
      rule: "lp-to-new-teacher",
      title: "写 LP 给新老师",
      owner: input.owner,
      dueDate: lpFollowUpDate,
      futureTone: "blue",
      trigger: "老师离职：写 LP 给新老师",
    })] : []),
  ];
}

export function prepareTeacherDepartureCreation(input: Readonly<{
  command: TeacherDepartureCreationCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  authorization?: DemoSessionIdentity;
  fullAdmin: boolean;
  now?: Date;
}>): PreparedTeacherDepartureCreation {
  if (input.role === "teacher") fail("teacher_forbidden", "Teacher accounts cannot create departure workflows.");
  const bookingRow = payloadRow(input.rows, "bookings");
  const operationRow = payloadRow(input.rows, "operations");
  const studentRow = payloadRow(input.rows, "students");
  const taskRow = payloadRow(input.rows, "tasks");
  const teacherRow = payloadRow(input.rows, "teachers");
  for (const row of [bookingRow, operationRow, studentRow, taskRow, teacherRow]) {
    if (row.version !== input.command.expectedVersions[row.entity as DepartureEntity]) {
      fail("stale_expected_version", `${row.entity} changed after the departure form was opened.`);
    }
  }

  const access = buildOpsAccessContext(input.rows as OpsStateRow[], input.actor, input.fullAdmin, input.authorization ?? input.role);
  if (!canWriteOpsTransaction(access, "operations", ["operations", "tasks"])
      || (!access.staff && !access.fullAdmin && !access.limitedAdmin)) {
    fail("source_teacher_scope_forbidden", "The current account cannot create teacher-departure workflows.");
  }
  const sourceTeachers = teacherRow.payload.filter((teacher) => teacher.id === input.command.sourceTeacherId);
  if (sourceTeachers.length !== 1) fail("source_teacher_not_found", "The departing teacher was not found.");
  if (operationRow.payload.some((operation) => operation.type === "老师离职"
    && operation.status === "待处理"
    && operation.teacherId === input.command.sourceTeacherId)) {
    fail("departure_already_exists", "This teacher already has a pending departure workflow. Complete it before creating another effective date.");
  }

  let projected;
  try {
    projected = projectTeacherDepartureOccurrences({
      bookings: bookingRow.payload as TeacherDepartureBooking[],
      teacherId: input.command.sourceTeacherId,
      effectiveDate: input.command.effectiveDate,
    });
  } catch (error) {
    if (error instanceof TeacherDepartureProjectionError && error.code === "unbounded_future_series") {
      fail("unbounded_future_series", error.message);
    }
    fail("invalid_shared_state", error instanceof Error ? error.message : "Future lessons cannot be projected safely.");
  }
  if (!projected.length) {
    fail("affected_occurrence_not_found", "离职生效日起未找到仍由该老师教授的有限未来课程，未创建任务。");
  }

  const affectedByStudent = new Map<string, AffectedOccurrence[]>();
  const occurrenceIds = new Set<string>();
  for (const item of projected) {
    const studentId = item.occurrence.studentId?.trim();
    if (!studentId || !ID_PATTERN.test(studentId)) {
      fail("invalid_shared_state", "An affected occurrence has no valid student identity.");
    }
    if (occurrenceIds.has(item.occurrence.occurrenceId)) {
      fail("invalid_shared_state", "The departure projection contains a duplicate occurrence.");
    }
    occurrenceIds.add(item.occurrence.occurrenceId);
    const booking = item.booking as RecordValue;
    const teacherSubjectId = text(booking, "teacherSubjectId");
    if (!teacherSubjectId) {
      fail("teacher_subject_missing", "受影响课程缺少老师腾讯表科目分类，请先编辑整个课程系列并人工选择分类。");
    }
    const entries = affectedByStudent.get(studentId) ?? [];
    entries.push({ booking, occurrence: item.occurrence, teacherSubjectId });
    affectedByStudent.set(studentId, entries);
  }

  const now = input.now ? new Date(input.now.getTime()) : new Date();
  if (!Number.isFinite(now.valueOf())) fail("invalid_request", "The submission clock is invalid.");
  const submittedAt = now.toISOString();
  const generatedOperations: RecordValue[] = [];
  const generatedTasks: OpsTask[] = [];
  const affectedGroups: TeacherDepartureCreationGroup[] = [];

  for (const [studentId, affected] of [...affectedByStudent.entries()].sort(([left], [right]) => compareAscii(left, right))) {
    const students = studentRow.payload.filter((student) => student.id === studentId);
    if (students.length !== 1) fail("affected_student_not_found", "An affected student was not found.");
    const student = students[0];
    if (student.importArchived === true || !ACTIVE_STUDENT_STATUSES.has(text(student, "status") ?? "")) {
      fail("archived_student_read_only", "Archived or inactive student records cannot receive a departure workflow.");
    }
    if (!canOperateStudent(access, studentId)) {
      fail("affected_student_scope_forbidden", "The current account cannot create a departure workflow for every affected student.");
    }
    const operationId = stableId("OPS-DEPARTURE", `${input.command.commandKey}\u001f${studentId}`);
    const affectedOccurrenceIds = affected.map(({ occurrence }) => occurrence.occurrenceId).sort(compareAscii);
    const firstAffected = [...affected].sort((left, right) => {
      const leftInstant = occurrenceInstant(left.occurrence, left.booking).getTime();
      const rightInstant = occurrenceInstant(right.occurrence, right.booking).getTime();
      return leftInstant - rightInstant || compareAscii(left.occurrence.occurrenceId, right.occurrence.occurrenceId);
    })[0];
    if (!firstAffected) fail("invalid_shared_state", "An affected student has no valid departure occurrence.");
    const subjects = [...new Set(affected.map(({ teacherSubjectId }) => teacherSubjectId))].sort(compareAscii);
    const firstAffectedAt = occurrenceInstant(firstAffected.occurrence, firstAffected.booking).toISOString();
    const candidates = candidateTeacherIds({
      sourceTeacherId: input.command.sourceTeacherId,
      studentId,
      effectiveDate: input.command.effectiveDate,
      affected,
      bookings: bookingRow.payload,
      teachers: teacherRow.payload,
    });
    // Register the departure even while replacement matching is unresolved.
    // Confirmation independently revalidates the selected teacher and every
    // affected occurrence before changing bookings or capacity.
    generatedOperations.push({
      id: operationId,
      studentId,
      type: "老师离职",
      detail: input.command.detail,
      status: "待处理",
      createdAt: submittedAt,
      teacherId: input.command.sourceTeacherId,
      eventStart: input.command.effectiveDate,
      eventEnd: input.command.effectiveDate,
      affectedLessonCount: affectedOccurrenceIds.length,
      affectedOccurrenceIds,
      recommendedTeacherIds: candidates,
      creationCommandKey: input.command.commandKey,
    });
    const owner = text(student, "owner") ?? "待分配";
    generatedTasks.push(...tasksForStudent({
      commandKey: input.command.commandKey,
      operationId,
      studentId,
      owner,
      effectiveDate: input.command.effectiveDate,
      sourceTeacherId: input.command.sourceTeacherId,
      sourceTeacherName: text(sourceTeachers[0], "name") ?? fail("invalid_shared_state", "离职老师缺少权威姓名。"),
      bookings: bookingRow.payload,
      submittedAt: now,
    }));
    affectedGroups.push({ studentId, operationId, affectedOccurrenceIds, subjects, firstAffectedAt, candidateTeacherIds: candidates });
  }

  return {
    commandKey: input.command.commandKey,
    commandIntent: teacherDepartureCreationIntent(input.command),
    sourceTeacherId: input.command.sourceTeacherId,
    effectiveDate: input.command.effectiveDate,
    detail: input.command.detail,
    expectedVersions: input.command.expectedVersions,
    operations: [...generatedOperations, ...operationRow.payload],
    tasks: [...generatedTasks.map((task) => ({ ...task }) as RecordValue), ...taskRow.payload],
    affectedGroups,
    submittedAt,
    operationIds: generatedOperations.map((operation) => operation.id as string),
    affectedStudentIds: affectedGroups.map((group) => group.studentId),
    affectedOccurrenceCount: projected.length,
    generatedTaskCount: generatedTasks.length,
  };
}

import { createHash } from "node:crypto";

import { buildOpsAccessContext, canOperateStudent } from "@/lib/ops-access";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";
import {
  BookingCapacityServiceError,
  reconcileTeacherStudentCapacity,
} from "@/lib/booking-capacity-service";
import { updateBookingOccurrence } from "@/lib/booking-occurrence-updates";
import {
  expandLessonOccurrences,
  lessonOccurrenceSourceRangeForTargetRange,
  type LessonOccurrence,
  type LessonOccurrenceOverride,
} from "@/lib/lesson-occurrences";
import { expandTeacherAvailability, type TeacherAvailabilityWindow } from "@/lib/teacher-availability";
import {
  projectTeacherDepartureOccurrences,
  TeacherDepartureProjectionError,
} from "@/lib/teacher-departure-occurrences";

type RecordValue = Record<string, unknown>;
type Versions = Readonly<{ bookings: number; operations: number; teachers: number }>;
type PermanentReplacementVersions = Readonly<{
  bookings: number;
  operations: number;
  teachers: number;
  students: number;
}>;

const REQUEST_FIELDS = new Set(["operationId", "chosenTeacherId", "expectedVersions"]);
const VERSION_FIELDS = new Set(["bookings", "operations", "teachers"]);
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DEPARTURE_CREATION_COMMAND_KEY = /^teacher-departure-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERMANENT_REQUEST_FIELDS = new Set(["operationId", "chosenTeacherId", "expectedVersions"]);
const PERMANENT_VERSION_FIELDS = new Set(["bookings", "operations", "teachers", "students"]);

export type ConfirmOperationCommand = Readonly<{
  operationId: string;
  chosenTeacherId?: string;
  expectedVersions: Versions;
}>;

export type PreparedOperationConfirmation = Readonly<{
  commandKey: string;
  commandIntent: OperationConfirmationIntent;
  operationId: string;
  action: "leave" | "substitute" | "confirm_only";
  chosenTeacherId?: string;
  expectedVersions: Versions;
  bookings: readonly RecordValue[];
  operations: readonly RecordValue[];
  affectedOccurrenceIds: readonly string[];
}>;

export type OperationConfirmationIntent = Readonly<{
  operationId: string;
  chosenTeacherId: string | null;
}>;

/**
 * One reviewed departure/student decision. Effective date and affected lesson
 * IDs are deliberately server-derived from the stored departure operation.
 */
export type PermanentTeacherReplacementCommand = Readonly<{
  operationId: string;
  chosenTeacherId: string;
  expectedVersions: PermanentReplacementVersions;
}>;

export type PermanentTeacherReplacementIntent = Readonly<{
  operationId: string;
  chosenTeacherId: string;
}>;

export type PreparedPermanentTeacherReplacement = Readonly<{
  commandKey: string;
  commandIntent: PermanentTeacherReplacementIntent;
  operationId: string;
  studentId: string;
  sourceTeacherId: string;
  replacementTeacherId: string;
  effectiveDate: string;
  expectedVersions: PermanentReplacementVersions;
  bookings: readonly RecordValue[];
  operations: readonly RecordValue[];
  teachers: readonly RecordValue[];
  students: readonly RecordValue[];
  affectedOccurrenceIds: readonly string[];
  changedTeacherIds: readonly string[];
}>;

export type OperationConfirmationErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "operation_not_found"
  | "operation_already_confirmed"
  | "operation_scope_forbidden"
  | "teacher_forbidden"
  | "range_invalid"
  | "affected_occurrence_not_found"
  | "substitute_required"
  | "substitute_not_found"
  | "substitute_not_candidate"
  | "substitute_unavailable"
  | "substitute_conflict"
  | "operation_not_departure"
  | "student_not_found"
  | "student_assignment_conflict"
  | "unbounded_future_series"
  | "replacement_capacity_unconfigured"
  | "replacement_capacity_exhausted";

export class OperationConfirmationError extends Error {
  constructor(readonly code: OperationConfirmationErrorCode, message: string) {
    super(message);
    this.name = "OperationConfirmationError";
  }
}

function fail(code: OperationConfirmationErrorCode, message: string): never {
  throw new OperationConfirmationError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function persistedVersion(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid_request", `${field} is invalid.`);
  return value as number;
}

function assertFields(value: RecordValue, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail("client_fields_forbidden", "Only the reviewed operation confirmation fields may be submitted.");
  }
}

export function parseConfirmOperationCommand(value: unknown): ConfirmOperationCommand {
  if (!isRecord(value)) fail("invalid_request", "Operation confirmation is missing.");
  assertFields(value, REQUEST_FIELDS);
  const operationId = requiredText(value.operationId, "operationId");
  if (!OPERATION_ID.test(operationId)) fail("invalid_request", "operationId is invalid.");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertFields(value.expectedVersions, VERSION_FIELDS);
  return {
    operationId,
    ...(optionalText(value.chosenTeacherId) ? { chosenTeacherId: optionalText(value.chosenTeacherId) } : {}),
    expectedVersions: {
      bookings: version(value.expectedVersions.bookings, "expectedVersions.bookings"),
      operations: version(value.expectedVersions.operations, "expectedVersions.operations"),
      teachers: version(value.expectedVersions.teachers, "expectedVersions.teachers"),
    },
  };
}

export function parsePermanentTeacherReplacementCommand(value: unknown): PermanentTeacherReplacementCommand {
  if (!isRecord(value)) fail("invalid_request", "Permanent teacher replacement is missing.");
  assertFields(value, PERMANENT_REQUEST_FIELDS);
  const operationId = requiredText(value.operationId, "operationId");
  if (!OPERATION_ID.test(operationId)) fail("invalid_request", "operationId is invalid.");
  const chosenTeacherId = requiredText(value.chosenTeacherId, "chosenTeacherId");
  if (!OPERATION_ID.test(chosenTeacherId)) fail("invalid_request", "chosenTeacherId is invalid.");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertFields(value.expectedVersions, PERMANENT_VERSION_FIELDS);
  return {
    operationId,
    chosenTeacherId,
    expectedVersions: {
      bookings: persistedVersion(value.expectedVersions.bookings, "expectedVersions.bookings"),
      operations: persistedVersion(value.expectedVersions.operations, "expectedVersions.operations"),
      teachers: persistedVersion(value.expectedVersions.teachers, "expectedVersions.teachers"),
      students: persistedVersion(value.expectedVersions.students, "expectedVersions.students"),
    },
  };
}

function payloadRow(rows: readonly OpsStateRow[], entity: keyof PermanentReplacementVersions) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
    fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  return { ...row, payload: row.payload as RecordValue[] };
}

function stateText(value: RecordValue, field: string, label: string) {
  const result = optionalText(value[field]);
  if (!result) fail("invalid_shared_state", `${label}.${field} is missing.`);
  return result;
}

function actionFor(operation: RecordValue, chosenTeacherId?: string): PreparedOperationConfirmation["action"] {
  const type = stateText(operation, "type", "operation");
  if (["代课", "换老师", "老师离职"].includes(type)) {
    if (!chosenTeacherId) fail("substitute_required", "请先选择代课老师。");
    return "substitute";
  }
  if (["请假", "老师请假"].includes(type) && chosenTeacherId) return "substitute";
  if (["请假", "学生请假", "老师请假", "停课"].includes(type)) return "leave";
  if (type === "调课") return "confirm_only";
  fail("invalid_shared_state", "operation.type is invalid.");
}

function expandBooking(booking: RecordValue, rangeStart: string, rangeEnd: string) {
  try {
    return expandLessonOccurrences({
      id: stateText(booking, "id", "booking"),
      date: stateText(booking, "date", "booking"),
      start: stateText(booking, "start", "booking"),
      duration: Number(booking.duration),
      recurring: booking.recurring === true,
      ...(typeof booking.repeatCount === "number" ? { repeatCount: booking.repeatCount } : {}),
      studentId: optionalText(booking.studentId),
      teacherId: optionalText(booking.teacherId),
      packageId: optionalText(booking.packageId),
      course: optionalText(booking.course),
    }, {
      rangeStart,
      rangeEnd,
      overrides: Array.isArray(booking.occurrenceOverrides) ? booking.occurrenceOverrides as never : [],
    });
  } catch (error) {
    fail("invalid_shared_state", error instanceof Error ? error.message : "Booking occurrence data is invalid.");
  }
}

function affectedOccurrences(bookings: readonly RecordValue[], operation: RecordValue) {
  const type = stateText(operation, "type", "operation");
  const rangeStart = stateText(operation, "eventStart", "operation");
  const rangeEnd = stateText(operation, "eventEnd", "operation");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeStart) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeEnd) || rangeStart > rangeEnd) {
    fail("range_invalid", "异常记录的影响日期范围无效。");
  }
  const studentId = stateText(operation, "studentId", "operation");
  const teacherId = optionalText(operation.teacherId);
  const sourceBookingId = optionalText(operation.sourceBookingId);
  const teacherScoped = ["请假", "老师请假", "代课", "换老师", "老师离职"].includes(type);
  if (teacherScoped && !teacherId) fail("invalid_shared_state", "operation.teacherId is missing.");

  return bookings.flatMap((booking) => {
    if (sourceBookingId && booking.id !== sourceBookingId) return [];
    return expandBooking(booking, rangeStart, rangeEnd).filter((occurrence) =>
      occurrence.studentId === studentId
      && (!teacherScoped || occurrence.teacherId === teacherId)
      && occurrence.status !== "cancelled"
      && occurrence.status !== "completed"
      && occurrence.status !== "leave");
  }).sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));
}

function zonedParts(instant: Date, timezone: string) {
  const values = new Map(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { year: Number(values.get("year")), month: Number(values.get("month")), day: Number(values.get("day")), hour: Number(values.get("hour")), minute: Number(values.get("minute")), second: Number(values.get("second")) };
}

function occurrenceInstant(occurrence: LessonOccurrence, booking: RecordValue) {
  const timezone = stateText(booking, "timezone", "booking");
  const [year, month, day] = occurrence.date.split("-").map(Number);
  const [hour, minute] = occurrence.start.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (instant: Date) => {
    const part = zonedParts(instant, timezone);
    return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - instant.getTime();
  };
  const first = new Date(wall - offset(new Date(wall)));
  return new Date(wall - offset(first));
}

function shiftDate(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function bookingForOccurrence(bookings: readonly RecordValue[], occurrence: LessonOccurrence) {
  const booking = bookings.find((candidate) => candidate.id === occurrence.seriesId);
  if (!booking) fail("invalid_shared_state", "Affected booking series disappeared.");
  return booking;
}

function expandBookingAroundTarget(booking: RecordValue, rangeStart: string, rangeEnd: string) {
  const overrides = Array.isArray(booking.occurrenceOverrides)
    ? booking.occurrenceOverrides.filter(isRecord) as LessonOccurrenceOverride[]
    : [];
  try {
    const sourceRange = lessonOccurrenceSourceRangeForTargetRange(rangeStart, rangeEnd, overrides);
    return expandBooking(booking, sourceRange.rangeStart, sourceRange.rangeEnd);
  } catch (error) {
    fail("invalid_shared_state", error instanceof Error ? error.message : "Booking occurrence data is invalid.");
  }
}

function assertSubstitute(input: {
  chosenTeacherId: string;
  operation: RecordValue;
  teachers: readonly RecordValue[];
  bookings: readonly RecordValue[];
  affected: readonly LessonOccurrence[];
}) {
  const sourceTeacherId = stateText(input.operation, "teacherId", "operation");
  if (input.chosenTeacherId === sourceTeacherId) fail("substitute_not_candidate", "代课老师不能与原老师相同。");
  const teacher = input.teachers.find((candidate) => candidate.id === input.chosenTeacherId);
  if (!teacher) fail("substitute_not_found", "所选代课老师不存在。");
  if (!Array.isArray(teacher.availabilityWindows)) fail("substitute_unavailable", "所选老师没有已确认 AVA。");

  const recommended = Array.isArray(input.operation.recommendedTeacherIds)
    ? input.operation.recommendedTeacherIds.filter((id): id is string => typeof id === "string")
    : [];
  if (!recommended.includes(input.chosenTeacherId)) fail("substitute_not_candidate", "所选老师不在该异常的已核验候选范围内。");
  const subjects = Array.isArray(teacher.subjects) ? teacher.subjects.filter((item): item is string => typeof item === "string") : [];

  for (const occurrence of input.affected) {
    const booking = bookingForOccurrence(input.bookings, occurrence);
    const teacherSubjectId = optionalText(booking.teacherSubjectId);
    if (!teacherSubjectId) {
      fail("invalid_shared_state", "受影响课程缺少老师腾讯表科目分类，请先人工补充后再选择代课或接替老师。");
    }
    if (!subjects.includes(teacherSubjectId)) {
      fail("substitute_not_candidate", "所选老师不能教授受影响课程的腾讯表科目分类。");
    }
    const start = occurrenceInstant(occurrence, booking);
    const end = new Date(start.getTime() + occurrence.scheduledDurationMinutes * 60_000);
    let availability;
    try {
      availability = expandTeacherAvailability(teacher.availabilityWindows as TeacherAvailabilityWindow[], {
        from: new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10),
        to: new Date(start.getTime() + 86_400_000).toISOString().slice(0, 10),
        displayTimezone: "UTC",
      });
    } catch {
      fail("substitute_unavailable", "所选老师的 AVA 资料无效。");
    }
    if (!availability.some((window) => window.teacherId === input.chosenTeacherId && Date.parse(window.startsAt) <= start.getTime() && Date.parse(window.endsAt) >= end.getTime())) {
      fail("substitute_unavailable", `${occurrence.occurrenceId} 不在所选老师已确认 AVA 内。`);
    }
    for (const existing of input.bookings) {
      for (const candidate of expandBookingAroundTarget(existing, shiftDate(occurrence.date, -7), shiftDate(occurrence.date, 7))) {
        if (input.affected.some((item) => item.occurrenceId === candidate.occurrenceId)) continue;
        if (candidate.teacherId !== input.chosenTeacherId || ["cancelled", "leave"].includes(candidate.status)) continue;
        const candidateBooking = bookingForOccurrence(input.bookings, candidate);
        const candidateStart = occurrenceInstant(candidate, candidateBooking);
        const candidateEnd = new Date(candidateStart.getTime() + candidate.scheduledDurationMinutes * 60_000);
        if (start < candidateEnd && candidateStart < end) fail("substitute_conflict", `${occurrence.occurrenceId} 与所选老师已有课程冲突。`);
      }
    }
  }
}

export function operationConfirmationIntent(
  command: Pick<ConfirmOperationCommand, "operationId" | "chosenTeacherId">,
): OperationConfirmationIntent {
  return { operationId: command.operationId, chosenTeacherId: command.chosenTeacherId ?? null };
}

export function operationConfirmationCommandKey(command: Pick<ConfirmOperationCommand, "operationId" | "chosenTeacherId">) {
  const identity = { operationId: command.operationId, chosenTeacherId: command.chosenTeacherId ?? null };
  return `operation-confirm:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function prepareOperationConfirmation(input: {
  command: ConfirmOperationCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  fullAdmin: boolean;
  role?: DemoSessionRole;
}): PreparedOperationConfirmation {
  const bookingRow = payloadRow(input.rows, "bookings");
  const operationRow = payloadRow(input.rows, "operations");
  const teacherRow = payloadRow(input.rows, "teachers");
  const operation = operationRow.payload.find((candidate) => candidate.id === input.command.operationId);
  if (!operation) fail("operation_not_found", "异常记录不存在。");

  const access = buildOpsAccessContext(input.rows as OpsStateRow[], input.actor, input.fullAdmin, input.role);
  if (access.teacher || (!access.staff && !access.fullAdmin && !access.limitedAdmin)) {
    fail("teacher_forbidden", "老师账号不能最终确认教务异常。");
  }
  if (!canOperateStudent(access, stateText(operation, "studentId", "operation"))) {
    fail("operation_scope_forbidden", "当前账号不能确认这名学生的异常记录。");
  }

  const persistedChosen = optionalText(operation.chosenTeacherId);
  const chosenTeacherId = input.command.chosenTeacherId ?? persistedChosen;
  if (persistedChosen && input.command.chosenTeacherId && persistedChosen !== input.command.chosenTeacherId) {
    fail("substitute_not_candidate", "所选代课老师与已记录候选不一致。");
  }
  const action = actionFor(operation, chosenTeacherId);
  const alreadyConfirmed = operation.status === "已确认";
  if (alreadyConfirmed) {
    const stored = Array.isArray(operation.affectedOccurrenceIds)
      ? operation.affectedOccurrenceIds.filter((id): id is string => typeof id === "string")
      : [];
    if (optionalText(operation.confirmationAction) !== action || optionalText(operation.chosenTeacherId) !== chosenTeacherId) {
      fail("operation_already_confirmed", "该异常已用另一套处理方案确认。");
    }
    const storedCommandKey = optionalText(operation.confirmationCommandKey);
    if (!storedCommandKey) fail("operation_already_confirmed", "该异常已确认，不能用新命令覆盖。");
    return { commandKey: storedCommandKey, commandIntent: operationConfirmationIntent({ operationId: input.command.operationId, chosenTeacherId }), operationId: input.command.operationId, action, ...(chosenTeacherId ? { chosenTeacherId } : {}), expectedVersions: input.command.expectedVersions, bookings: bookingRow.payload, operations: operationRow.payload, affectedOccurrenceIds: stored };
  }
  for (const [entity, row] of [["bookings", bookingRow], ["operations", operationRow], ["teachers", teacherRow]] as const) {
    if (row.version !== input.command.expectedVersions[entity]) fail("stale_expected_version", `${entity} changed after confirmation was opened.`);
  }

  const affected = action === "confirm_only" ? [] : affectedOccurrences(bookingRow.payload, operation);
  if (action !== "confirm_only" && !affected.length) fail("affected_occurrence_not_found", "未找到仍可处理的具体课次，请刷新后重试。");
  if (action === "substitute") assertSubstitute({ chosenTeacherId: chosenTeacherId!, operation, teachers: teacherRow.payload, bookings: bookingRow.payload, affected });
  const exactIds = affected.map((item) => item.occurrenceId).sort();
  // Apply the server-derived exact occurrence IDs. This preserves earlier
  // single-occurrence edits and cannot broaden to sibling dates in a series.
  let nextBookings = bookingRow.payload as readonly RecordValue[];
  for (const occurrence of affected) {
    nextBookings = updateBookingOccurrence(nextBookings as never, action === "substitute" ? {
      occurrenceId: occurrence.occurrenceId,
      status: "confirmed",
      teacherId: chosenTeacherId,
    } : {
      occurrenceId: occurrence.occurrenceId,
      status: "leave",
    }) as readonly RecordValue[];
  }
  const nextOperations = operationRow.payload.map((candidate) => candidate.id === input.command.operationId ? {
    ...candidate,
    status: "已确认",
    chosenTeacherId,
    affectedOccurrenceIds: exactIds,
    confirmationAction: action,
    confirmationCommandKey: operationConfirmationCommandKey({ operationId: input.command.operationId, chosenTeacherId }),
    confirmedAt: new Date().toISOString(),
    confirmedBy: input.actor,
  } : candidate);
  return { commandKey: operationConfirmationCommandKey({ operationId: input.command.operationId, chosenTeacherId }), commandIntent: operationConfirmationIntent({ operationId: input.command.operationId, chosenTeacherId }), operationId: input.command.operationId, action, ...(chosenTeacherId ? { chosenTeacherId } : {}), expectedVersions: input.command.expectedVersions, bookings: nextBookings, operations: nextOperations, affectedOccurrenceIds: exactIds };
}

export function permanentTeacherReplacementCommandKey(
  command: Pick<PermanentTeacherReplacementCommand, "operationId" | "chosenTeacherId">,
) {
  return `permanent-teacher-replacement:${createHash("sha256").update(JSON.stringify(permanentTeacherReplacementIntent(command))).digest("hex")}`;
}

export function permanentTeacherReplacementIntent(
  command: Pick<PermanentTeacherReplacementCommand, "operationId" | "chosenTeacherId">,
): PermanentTeacherReplacementIntent {
  return { operationId: command.operationId, chosenTeacherId: command.chosenTeacherId };
}

function finiteSeriesEnd(booking: RecordValue) {
  const date = stateText(booking, "date", "booking");
  if (booking.recurring !== true) return date;
  if (!Number.isSafeInteger(booking.repeatCount) || (booking.repeatCount as number) < 1) {
    fail("unbounded_future_series", "永久换师不能自动处理没有结束次数的旧循环课，请先人工限定课次范围。");
  }
  if ((booking.repeatCount as number) > 104) {
    fail("invalid_shared_state", "循环课次数超过可安全处理的 104 次上限。");
  }
  return shiftDate(date, ((booking.repeatCount as number) - 1) * 7);
}

function activeFutureOccurrences(input: {
  bookings: readonly RecordValue[];
  studentId: string;
  teacherId: string;
  effectiveDate: string;
  requireBounded: boolean;
}) {
  try {
    return projectTeacherDepartureOccurrences({
      bookings: input.bookings as never,
      teacherId: input.teacherId,
      effectiveDate: input.effectiveDate,
      studentId: input.studentId,
    })
      .map(({ occurrence }) => occurrence);
  } catch (error) {
    if (error instanceof TeacherDepartureProjectionError && error.code === "unbounded_future_series") {
      if (!input.requireBounded) return null;
      fail("unbounded_future_series", error.message);
    }
    fail(
      error instanceof TeacherDepartureProjectionError && error.code === "invalid_effective_date"
        ? "range_invalid"
        : "invalid_shared_state",
      error instanceof Error ? error.message : "Booking occurrence data is invalid.",
    );
  }
}

function hasActiveFutureRelationship(input: {
  bookings: readonly RecordValue[];
  studentId: string;
  teacherId: string;
  effectiveDate: string;
}) {
  const occurrences = activeFutureOccurrences({ ...input, requireBounded: false });
  return occurrences === null || occurrences.length > 0;
}

function makeReplacementTheFutureSeriesDefault(input: {
  beforeBookings: readonly RecordValue[];
  afterBookings: readonly RecordValue[];
  affected: readonly LessonOccurrence[];
  studentId: string;
  sourceTeacherId: string;
  replacementTeacherId: string;
}) {
  const affectedIds = new Set(input.affected.map((occurrence) => occurrence.occurrenceId));
  const affectedSeriesIds = new Set(input.affected.map((occurrence) => occurrence.seriesId));
  let next = input.afterBookings;
  for (const seriesId of affectedSeriesIds) {
    const original = input.beforeBookings.find((booking) => booking.id === seriesId);
    if (!original
      || optionalText(original.studentId) !== input.studentId
      || optionalText(original.teacherId) !== input.sourceTeacherId) continue;
    const allOriginal = expandBooking(original, stateText(original, "date", "booking"), finiteSeriesEnd(original));
    next = next.map((booking) => booking.id === seriesId
      ? { ...booking, teacherId: input.replacementTeacherId }
      : booking);
    // Preserve historical, cancelled and pre-effective occurrences explicitly
    // when the parent series default becomes the permanent replacement.
    for (const occurrence of allOriginal) {
      if (affectedIds.has(occurrence.occurrenceId) || occurrence.teacherId !== input.sourceTeacherId) continue;
      next = updateBookingOccurrence(next as never, {
        occurrenceId: occurrence.occurrenceId,
        teacherId: input.sourceTeacherId,
      }) as readonly RecordValue[];
    }
  }
  return next;
}

/**
 * Prepares one permanent departure assignment for atomic server persistence.
 * The caller submits only the reviewed operation/teacher decision and OCC
 * versions; all future lesson IDs, capacity changes and the effective date are
 * derived from authoritative shared state.
 */
export function preparePermanentTeacherReplacement(input: {
  command: PermanentTeacherReplacementCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  fullAdmin: boolean;
  role?: DemoSessionRole;
  now?: Date;
}): PreparedPermanentTeacherReplacement {
  const bookingRow = payloadRow(input.rows, "bookings");
  const operationRow = payloadRow(input.rows, "operations");
  const teacherRow = payloadRow(input.rows, "teachers");
  const studentRow = payloadRow(input.rows, "students");
  const operation = operationRow.payload.find((candidate) => candidate.id === input.command.operationId);
  if (!operation) fail("operation_not_found", "异常记录不存在。");
  if (stateText(operation, "type", "operation") !== "老师离职") {
    fail("operation_not_departure", "只有老师离职记录可以执行永久换师。");
  }
  const operationStatus = stateText(operation, "status", "operation");
  if (operationStatus !== "待处理" && operationStatus !== "已确认") {
    fail("invalid_shared_state", "离职记录状态无效，不能执行永久换师。");
  }

  const studentId = stateText(operation, "studentId", "operation");
  const sourceTeacherId = stateText(operation, "teacherId", "operation");
  const effectiveDate = stateText(operation, "eventEnd", "operation");
  const creationCommandKey = optionalText(operation.creationCommandKey);
  const expectedOperationId = creationCommandKey
    ? `OPS-DEPARTURE-${createHash("sha256").update(`${creationCommandKey}\u001f${studentId}`).digest("hex").slice(0, 24)}`
    : undefined;
  if (!creationCommandKey
    || !DEPARTURE_CREATION_COMMAND_KEY.test(creationCommandKey)
    || operation.id !== expectedOperationId) {
    fail("invalid_shared_state", "离职记录缺少可核验的原子创建来源，不能执行永久换师。");
  }
  const effectiveDateValue = new Date(`${effectiveDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
    || Number.isNaN(effectiveDateValue.valueOf())
    || effectiveDateValue.toISOString().slice(0, 10) !== effectiveDate) {
    fail("range_invalid", "离职生效日期无效。");
  }
  const access = buildOpsAccessContext(input.rows as OpsStateRow[], input.actor, input.fullAdmin, input.role);
  if (access.teacher || (!access.staff && !access.fullAdmin && !access.limitedAdmin)) {
    fail("teacher_forbidden", "老师账号不能最终确认永久换师。");
  }
  if (!canOperateStudent(access, studentId)) {
    fail("operation_scope_forbidden", "当前账号不能确认这名学生的永久换师。");
  }

  if (operationStatus === "已确认") {
    // A genuine replay must have been returned by the command ledger before
    // this preparation step. Never synthesize a missing ledger entry from an
    // already-mutated operation or create a second no-op audit trail.
    fail("operation_already_confirmed", "该离职记录已经确认；找不到可重放的原子命令结果。");
  }

  const persistedChosen = optionalText(operation.chosenTeacherId);
  if (persistedChosen && persistedChosen !== input.command.chosenTeacherId) {
    fail("substitute_not_candidate", "所选老师与已记录的人工选择不一致。");
  }
  const commandKey = permanentTeacherReplacementCommandKey(input.command);
  for (const [entity, row] of [
    ["bookings", bookingRow], ["operations", operationRow], ["teachers", teacherRow], ["students", studentRow],
  ] as const) {
    if (row.version !== input.command.expectedVersions[entity]) {
      fail("stale_expected_version", `${entity} changed after permanent replacement was opened.`);
    }
  }

  const sourceTeacher = teacherRow.payload.find((teacher) => teacher.id === sourceTeacherId);
  const replacementTeacher = teacherRow.payload.find((teacher) => teacher.id === input.command.chosenTeacherId);
  if (!sourceTeacher) fail("invalid_shared_state", "离职老师不存在。");
  if (!replacementTeacher) fail("substitute_not_found", "所选接替老师不存在。");
  const student = studentRow.payload.find((candidate) => candidate.id === studentId);
  if (!student) fail("student_not_found", "受影响学生不存在。");
  const replacementAlreadyActive = hasActiveFutureRelationship({
    bookings: bookingRow.payload,
    studentId,
    teacherId: input.command.chosenTeacherId,
    effectiveDate,
  });
  const replacementAlreadyAssigned = Array.isArray(replacementTeacher.capacityAssignments)
    && replacementTeacher.capacityAssignments.includes(studentId);
  if (!replacementAlreadyActive && !replacementAlreadyAssigned && replacementTeacher.acceptsStudents !== true) {
    fail("substitute_not_candidate", "首次建立师生关系时，所选接替老师必须已确认可接新生。");
  }
  const currentTeacherName = optionalText(student.teacher);
  const sourceTeacherName = stateText(sourceTeacher, "name", "teacher");
  if (currentTeacherName && ![sourceTeacherName, "待匹配", "待确认"].includes(currentTeacherName)) {
    fail("student_assignment_conflict", "学生档案中的当前老师与离职记录不一致，必须先人工复核。");
  }

  const affected = activeFutureOccurrences({
    bookings: bookingRow.payload,
    studentId,
    teacherId: sourceTeacherId,
    effectiveDate,
    requireBounded: true,
  })!;
  if (!affected.length) fail("affected_occurrence_not_found", "离职日起没有可永久换师的未来课次。");
  assertSubstitute({
    chosenTeacherId: input.command.chosenTeacherId,
    operation,
    teachers: teacherRow.payload,
    bookings: bookingRow.payload,
    affected,
  });

  let nextBookings = bookingRow.payload as readonly RecordValue[];
  for (const occurrence of affected) {
    nextBookings = updateBookingOccurrence(nextBookings as never, {
      occurrenceId: occurrence.occurrenceId,
      status: "confirmed",
      teacherId: input.command.chosenTeacherId,
    }) as readonly RecordValue[];
  }
  nextBookings = makeReplacementTheFutureSeriesDefault({
    beforeBookings: bookingRow.payload,
    afterBookings: nextBookings,
    affected,
    studentId,
    sourceTeacherId,
    replacementTeacherId: input.command.chosenTeacherId,
  });
  if (hasActiveFutureRelationship({ bookings: nextBookings, studentId, teacherId: sourceTeacherId, effectiveDate })) {
    fail("invalid_shared_state", "永久换师后仍有未来课次指向离职老师。");
  }

  let capacity;
  try {
    capacity = reconcileTeacherStudentCapacity({
      teachers: teacherRow.payload,
      transitions: [
        { teacherId: sourceTeacherId, studentId, beforeActive: true, afterActive: false },
        { teacherId: input.command.chosenTeacherId, studentId, beforeActive: replacementAlreadyActive, afterActive: true },
      ],
    });
  } catch (error) {
    if (error instanceof BookingCapacityServiceError && error.code === "teacher_capacity_unconfigured") {
      fail("replacement_capacity_unconfigured", error.message);
    }
    if (error instanceof BookingCapacityServiceError && error.code === "teacher_capacity_exhausted") {
      fail("replacement_capacity_exhausted", error.message);
    }
    throw error;
  }

  const replacementTeacherName = stateText(replacementTeacher, "name", "teacher");
  const nextStudents = studentRow.payload.map((candidate) => candidate.id === studentId
    ? { ...candidate, teacher: replacementTeacherName }
    : candidate);
  const affectedOccurrenceIds = affected.map((occurrence) => occurrence.occurrenceId).sort();
  const confirmedAt = (input.now ?? new Date()).toISOString();
  const nextOperations = operationRow.payload.map((candidate) => candidate.id === input.command.operationId ? {
    ...candidate,
    status: "已确认",
    chosenTeacherId: input.command.chosenTeacherId,
    affectedOccurrenceIds,
    changedTeacherIds: capacity.changedTeacherIds,
    confirmationAction: "permanent_replacement",
    confirmationCommandKey: commandKey,
    confirmedAt,
    confirmedBy: input.actor,
  } : candidate);
  return {
    commandKey,
    commandIntent: permanentTeacherReplacementIntent(input.command),
    operationId: input.command.operationId,
    studentId,
    sourceTeacherId,
    replacementTeacherId: input.command.chosenTeacherId,
    effectiveDate,
    expectedVersions: input.command.expectedVersions,
    bookings: nextBookings,
    operations: nextOperations,
    teachers: capacity.teachers,
    students: nextStudents,
    affectedOccurrenceIds,
    changedTeacherIds: capacity.changedTeacherIds,
  };
}

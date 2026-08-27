import {
  deductCompletedLesson,
  reverseLessonDeduction,
  type LessonHourDeduction,
  type LessonHourLedgerEntry,
  type StudentLessonPackage,
} from "./student-records";
import {
  LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS,
  normalizeBookingRecurrence,
  shiftBookingDate,
} from "./booking-recurrence";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_ATTENDANCE_TOLERANCE_SECONDS = 5 * 60;
const HOUR_PRECISION = 1_000_000;

export const LESSON_OCCURRENCE_STATUSES = [
  "confirmed",
  "completed",
  "cancelled",
  "leave",
  "abnormal",
] as const;

export type LessonOccurrenceStatus = (typeof LESSON_OCCURRENCE_STATUSES)[number];

export type AttendanceAbnormalReason =
  | "missing_student"
  | "missing_teacher"
  | "student_identity_mismatch"
  | "teacher_identity_mismatch"
  | "invalid_student_evidence"
  | "invalid_teacher_evidence"
  | "student_duration_short"
  | "teacher_duration_short";

/** Compatible with the current Booking shape, including count-less legacy series. */
export type LegacyLessonSeries = Readonly<{
  id: string;
  date: string;
  start: string;
  duration: number;
  recurring?: boolean;
  repeatCount?: number;
  recurrenceIntervalDays?: number;
  recurrenceEndDate?: string;
  studentId?: string;
  teacherId?: string;
  packageId?: string;
  subjectId?: string;
  /** Current legacy bookings store the subject in `course`. */
  course?: string;
  /** Deliberately ignored when occurrences are expanded. */
  status?: unknown;
}>;

export type LessonOccurrenceOverride = Readonly<{
  occurrenceId: string;
  status?: LessonOccurrenceStatus;
  date?: string;
  start?: string;
  durationMinutes?: number;
  studentId?: string | null;
  teacherId?: string | null;
  packageId?: string | null;
  subjectId?: string | null;
  classroom?: Readonly<{
    occurrenceId: string;
    meetingId: string;
    status: "ready" | "running" | "ended";
    createdAt: string;
  }>;
  settledAt?: string;
  settledBy?: string;
  attendanceReference?: string;
  attendanceReasons?: readonly AttendanceAbnormalReason[];
  settlementOverrideReason?: string;
}>;

export type LessonOccurrence = Readonly<{
  occurrenceId: string;
  seriesId: string;
  /** Original weekly date; remains stable when an override moves the lesson. */
  sourceDate: string;
  date: string;
  start: string;
  scheduledDurationMinutes: number;
  status: LessonOccurrenceStatus;
  studentId?: string;
  teacherId?: string;
  packageId?: string;
  subjectId?: string;
}>;

export type ExpandLessonOccurrencesOptions = Readonly<{
  rangeStart: string;
  rangeEnd: string;
  overrides?: readonly LessonOccurrenceOverride[];
}>;

export type AttendanceSpan = Readonly<{
  joinedAt: string;
  leftAt: string;
}>;

export type AttendancePartyEvidence = Readonly<{
  userId: string;
  /** Raw join/leave spans. Overlaps are merged before time is accumulated. */
  joinLeave?: readonly AttendanceSpan[];
  /** Provider-computed cumulative time, used when raw spans are unavailable. */
  accumulatedSeconds?: number;
}>;

export type LessonAttendanceEvidence = Readonly<{
  student?: AttendancePartyEvidence;
  teacher?: AttendancePartyEvidence;
}>;

export type LessonAttendanceEvaluation = Readonly<{
  classification: "normal" | "abnormal";
  scheduledSeconds: number;
  requiredSeconds: number;
  toleranceSeconds: number;
  studentUserId?: string;
  teacherUserId?: string;
  studentSeconds: number;
  teacherSeconds: number;
  reasons: readonly AttendanceAbnormalReason[];
}>;

export type TeacherPayrollCredit = Readonly<{
  id: string;
  kind: "teacher_hours";
  occurrenceId: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  subjectId: string;
  payableHours: number;
  occurredAt: string;
}>;

export type TeacherPayrollReversal = Readonly<{
  id: string;
  kind: "reversal";
  occurrenceId: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  subjectId: string;
  payableHours: number;
  occurredAt: string;
  reversesEntryId: string;
}>;

export type TeacherPayrollLedgerEntry = TeacherPayrollCredit | TeacherPayrollReversal;

export type LessonOccurrenceSettlementState = Readonly<{
  occurrence: LessonOccurrence;
  packages: readonly StudentLessonPackage[];
  studentHoursLedger: readonly LessonHourLedgerEntry[];
  teacherPayrollLedger: readonly TeacherPayrollLedgerEntry[];
}>;

export type CompleteLessonOccurrenceCommand = Readonly<{
  completedAt: string;
  attendance: LessonAttendanceEvidence;
  toleranceSeconds?: number;
}>;

export type LessonOccurrenceSettlementResult = Readonly<{
  occurrence: LessonOccurrence;
  packages: readonly StudentLessonPackage[];
  studentHoursLedger: readonly LessonHourLedgerEntry[];
  teacherPayrollLedger: readonly TeacherPayrollLedgerEntry[];
  attendance: LessonAttendanceEvaluation | null;
  applied: boolean;
  disposition: "completed" | "abnormal" | "not_billable" | "reversed" | "not_settled";
}>;

export type ReverseLessonOccurrenceCommand = Readonly<{
  reversedAt: string;
  statusAfterReversal?: Exclude<LessonOccurrenceStatus, "completed">;
}>;

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
}

function requireDate(value: string, field: string) {
  if (!DATE_PATTERN.test(value)) throw new Error(`${field} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date`);
  }
}

function requireTime(value: string, field: string) {
  if (!TIME_PATTERN.test(value)) throw new Error(`${field} must use HH:MM`);
}

function requireTimestamp(value: string, field: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be a valid timestamp`);
}

function requireDuration(value: number, field = "scheduled duration") {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${field} must be a positive number`);
}

function roundedHours(minutes: number) {
  return Math.round((minutes / 60) * HOUR_PRECISION) / HOUR_PRECISION;
}

function copyPackages(packages: readonly StudentLessonPackage[]) {
  return packages.map((lessonPackage) => ({
    ...lessonPackage,
    subjectIds: [...lessonPackage.subjectIds],
    purchaseRecords: lessonPackage.purchaseRecords.map((purchase) => ({ ...purchase })),
  }));
}

function copyState(state: LessonOccurrenceSettlementState) {
  return {
    occurrence: { ...state.occurrence },
    packages: copyPackages(state.packages),
    studentHoursLedger: [...state.studentHoursLedger],
    teacherPayrollLedger: [...state.teacherPayrollLedger],
  };
}

function own<Key extends PropertyKey>(value: object, key: Key): value is Record<Key, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function overrideText(
  override: LessonOccurrenceOverride | undefined,
  field: "studentId" | "teacherId" | "packageId" | "subjectId",
  fallback: string | undefined,
) {
  if (!override || !own(override, field)) return fallback;
  const value = override[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function lessonOccurrenceId(seriesId: string, sourceDate: string) {
  requireText(seriesId, "seriesId");
  requireDate(sourceDate, "sourceDate");
  return `${seriesId}:${sourceDate}`;
}

/**
 * Expands a target-date query far enough to include occurrences whose stable
 * source date sits outside that target range. This is required when a single
 * occurrence has been moved into the requested day or week.
 */
export function lessonOccurrenceSourceRangeForTargetRange(
  rangeStart: string,
  rangeEnd: string,
  overrides: readonly LessonOccurrenceOverride[] = [],
) {
  requireDate(rangeStart, "rangeStart");
  requireDate(rangeEnd, "rangeEnd");
  if (rangeEnd < rangeStart) throw new RangeError("rangeEnd must not be before rangeStart");

  const sourceDates = overrides.flatMap((override) => {
    if (!override.date) return [];
    requireDate(override.date, "occurrence date");
    if (override.date < rangeStart || override.date > rangeEnd) return [];
    const sourceDate = override.occurrenceId.slice(-10);
    return DATE_PATTERN.test(sourceDate) ? [sourceDate] : [];
  });

  return {
    rangeStart: [rangeStart, ...sourceDates].sort()[0],
    rangeEnd: [rangeEnd, ...sourceDates].sort().at(-1)!,
  };
}

/** Earliest visible date for a series, including occurrences moved earlier. */
export function earliestLessonOccurrenceTargetDate(
  seriesDate: string,
  overrides: readonly LessonOccurrenceOverride[] = [],
) {
  requireDate(seriesDate, "series.date");
  const targetDates = overrides.flatMap((override) => {
    if (!override.date) return [];
    requireDate(override.date, "occurrence date");
    return [override.date];
  });
  return [seriesDate, ...targetDates].sort()[0];
}

/** Expands legacy and interval-based series into independently mutable occurrences. */
export function expandLessonOccurrences(
  series: LegacyLessonSeries,
  options: ExpandLessonOccurrencesOptions,
): LessonOccurrence[] {
  requireText(series.id, "series.id");
  requireDate(series.date, "series.date");
  requireTime(series.start, "series.start");
  requireDuration(series.duration, "series.duration");
  requireDate(options.rangeStart, "rangeStart");
  requireDate(options.rangeEnd, "rangeEnd");
  if (options.rangeEnd < options.rangeStart) throw new RangeError("rangeEnd must not be before rangeStart");
  const recurrence = normalizeBookingRecurrence({ ...series, startDate: series.date });
  if (series.recurring && series.repeatCount !== undefined && (!Number.isSafeInteger(series.repeatCount) || series.repeatCount < 1 || series.repeatCount > 104)) {
    throw new RangeError("repeatCount must be an integer from 1 to 104");
  }

  const overrides = new Map<string, LessonOccurrenceOverride>();
  for (const override of options.overrides ?? []) {
    requireText(override.occurrenceId, "override.occurrenceId");
    if (overrides.has(override.occurrenceId)) throw new Error(`duplicate occurrence override ${override.occurrenceId}`);
    overrides.set(override.occurrenceId, override);
  }

  const sourceDates: string[] = [];
  if (!series.recurring) {
    if (series.date >= options.rangeStart && series.date <= options.rangeEnd) sourceDates.push(series.date);
  } else {
    const maximum = series.repeatCount ?? Number.POSITIVE_INFINITY;
    const interval = series.recurrenceIntervalDays ?? recurrence.recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS;
    for (let index = 0, date = series.date; index < maximum && date <= options.rangeEnd; index += 1, date = shiftBookingDate(date, interval)) {
      if (series.recurrenceEndDate && date > series.recurrenceEndDate) break;
      if (date >= options.rangeStart) sourceDates.push(date);
    }
  }

  return sourceDates.map((sourceDate) => {
    const occurrenceId = lessonOccurrenceId(series.id, sourceDate);
    const override = overrides.get(occurrenceId);
    const date = override?.date ?? sourceDate;
    const start = override?.start ?? series.start;
    const scheduledDurationMinutes = override?.durationMinutes ?? series.duration;
    requireDate(date, "occurrence date");
    requireTime(start, "occurrence start");
    requireDuration(scheduledDurationMinutes);
    return {
      occurrenceId,
      seriesId: series.id,
      sourceDate,
      date,
      start,
      scheduledDurationMinutes,
      // Parent status is intentionally never inherited by an occurrence.
      status: override?.status ?? "confirmed",
      ...(overrideText(override, "studentId", series.studentId) ? { studentId: overrideText(override, "studentId", series.studentId) } : {}),
      ...(overrideText(override, "teacherId", series.teacherId) ? { teacherId: overrideText(override, "teacherId", series.teacherId) } : {}),
      ...(overrideText(override, "packageId", series.packageId) ? { packageId: overrideText(override, "packageId", series.packageId) } : {}),
      ...(overrideText(override, "subjectId", series.subjectId ?? series.course) ? { subjectId: overrideText(override, "subjectId", series.subjectId ?? series.course) } : {}),
    };
  });
}

function mergedSpanSeconds(spans: readonly AttendanceSpan[]) {
  const ranges = spans.map((span) => {
    requireTimestamp(span.joinedAt, "joinedAt");
    requireTimestamp(span.leftAt, "leftAt");
    const start = Date.parse(span.joinedAt);
    const end = Date.parse(span.leftAt);
    if (end < start) throw new RangeError("leftAt must not be before joinedAt");
    return [start, end] as const;
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  let totalMilliseconds = 0;
  let activeStart: number | null = null;
  let activeEnd: number | null = null;
  for (const [start, end] of ranges) {
    if (activeStart === null || activeEnd === null) {
      activeStart = start;
      activeEnd = end;
    } else if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end);
    } else {
      totalMilliseconds += activeEnd - activeStart;
      activeStart = start;
      activeEnd = end;
    }
  }
  if (activeStart !== null && activeEnd !== null) totalMilliseconds += activeEnd - activeStart;
  return Math.floor(totalMilliseconds / 1000);
}

export function accumulatedAttendanceSeconds(evidence: AttendancePartyEvidence) {
  requireText(evidence.userId, "attendance userId");
  if (evidence.joinLeave?.length) return mergedSpanSeconds(evidence.joinLeave);
  const seconds = evidence.accumulatedSeconds;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError("attendance accumulatedSeconds must be a non-negative integer");
  }
  return seconds;
}

function attendanceSeconds(
  evidence: AttendancePartyEvidence | undefined,
  invalidReason: AttendanceAbnormalReason,
  reasons: AttendanceAbnormalReason[],
): number {
  if (!evidence) return 0;
  try {
    return accumulatedAttendanceSeconds(evidence);
  } catch {
    reasons.push(invalidReason);
    return 0;
  }
}

export function evaluateLessonAttendance(
  occurrence: LessonOccurrence,
  evidence: LessonAttendanceEvidence,
  toleranceSeconds = DEFAULT_ATTENDANCE_TOLERANCE_SECONDS,
): LessonAttendanceEvaluation {
  requireDuration(occurrence.scheduledDurationMinutes);
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError("toleranceSeconds must be a non-negative integer");
  }
  const scheduledSeconds = Math.round(occurrence.scheduledDurationMinutes * 60);
  const requiredSeconds = Math.max(1, scheduledSeconds - toleranceSeconds);
  const reasons: AttendanceAbnormalReason[] = [];
  const studentUserId = evidence.student?.userId.trim();
  const teacherUserId = evidence.teacher?.userId.trim();

  if (!studentUserId) reasons.push("missing_student");
  else if (studentUserId !== occurrence.studentId) reasons.push("student_identity_mismatch");
  if (!teacherUserId) reasons.push("missing_teacher");
  else if (teacherUserId !== occurrence.teacherId) reasons.push("teacher_identity_mismatch");

  const studentSeconds = attendanceSeconds(evidence.student, "invalid_student_evidence", reasons);
  const teacherSeconds = attendanceSeconds(evidence.teacher, "invalid_teacher_evidence", reasons);
  if (studentUserId && studentSeconds < requiredSeconds) reasons.push("student_duration_short");
  if (teacherUserId && teacherSeconds < requiredSeconds) reasons.push("teacher_duration_short");

  return {
    classification: reasons.length ? "abnormal" : "normal",
    scheduledSeconds,
    requiredSeconds,
    toleranceSeconds,
    ...(studentUserId ? { studentUserId } : {}),
    ...(teacherUserId ? { teacherUserId } : {}),
    studentSeconds,
    teacherSeconds,
    reasons,
  };
}

function completionFields(occurrence: LessonOccurrence) {
  requireText(occurrence.studentId, "occurrence.studentId");
  requireText(occurrence.teacherId, "occurrence.teacherId");
  requireText(occurrence.packageId, "occurrence.packageId");
  requireText(occurrence.subjectId, "occurrence.subjectId");
  requireDuration(occurrence.scheduledDurationMinutes);
  return {
    studentId: occurrence.studentId,
    teacherId: occurrence.teacherId,
    packageId: occurrence.packageId,
    subjectId: occurrence.subjectId,
    payableHours: roundedHours(occurrence.scheduledDurationMinutes),
  };
}

function sameDeduction(
  deduction: LessonHourDeduction,
  occurrence: LessonOccurrence,
  completedAt: string,
  fields: ReturnType<typeof completionFields>,
) {
  return deduction.packageId === fields.packageId
    && deduction.subjectId === fields.subjectId
    && deduction.hours === fields.payableHours
    && deduction.occurredAt === completedAt
    && deduction.lessonId === occurrence.occurrenceId;
}

function studentDeductionForOccurrence(ledger: readonly LessonHourLedgerEntry[], occurrenceId: string) {
  return ledger.find((entry): entry is LessonHourDeduction => entry.kind === "deduction" && entry.lessonId === occurrenceId);
}

function teacherCreditForOccurrence(ledger: readonly TeacherPayrollLedgerEntry[], occurrenceId: string) {
  return ledger.find((entry): entry is TeacherPayrollCredit => entry.kind === "teacher_hours" && entry.occurrenceId === occurrenceId);
}

function sameCredit(left: TeacherPayrollCredit, right: TeacherPayrollCredit) {
  return left.id === right.id
    && left.occurrenceId === right.occurrenceId
    && left.teacherId === right.teacherId
    && left.studentId === right.studentId
    && left.packageId === right.packageId
    && left.subjectId === right.subjectId
    && left.payableHours === right.payableHours
    && left.occurredAt === right.occurredAt;
}

function assertUniqueTeacherLedgerIds(ledger: readonly TeacherPayrollLedgerEntry[]) {
  const ids = new Set<string>();
  for (const entry of ledger) {
    if (ids.has(entry.id)) throw new Error(`duplicate teacher payroll ledger id ${entry.id}`);
    ids.add(entry.id);
  }
}

/**
 * Settles one occurrence only. Merely expanding or changing an occurrence
 * status never invokes this command and therefore never deducts or pays.
 */
export function completeLessonOccurrence(
  state: LessonOccurrenceSettlementState,
  command: CompleteLessonOccurrenceCommand,
): LessonOccurrenceSettlementResult {
  const fields = completionFields(state.occurrence);
  requireTimestamp(command.completedAt, "completedAt");
  assertUniqueTeacherLedgerIds(state.teacherPayrollLedger);

  if (state.occurrence.status === "cancelled" || state.occurrence.status === "leave") {
    return { ...copyState(state), attendance: null, applied: false, disposition: "not_billable" };
  }

  const attendance = evaluateLessonAttendance(state.occurrence, command.attendance, command.toleranceSeconds);
  if (attendance.classification === "abnormal") {
    return {
      ...copyState(state),
      occurrence: { ...state.occurrence, status: "abnormal" },
      attendance,
      applied: false,
      disposition: "abnormal",
    };
  }

  const existingDeduction = studentDeductionForOccurrence(state.studentHoursLedger, state.occurrence.occurrenceId);
  const existingCredit = teacherCreditForOccurrence(state.teacherPayrollLedger, state.occurrence.occurrenceId);
  if (Boolean(existingDeduction) !== Boolean(existingCredit)) {
    throw new Error(`occurrence ${state.occurrence.occurrenceId} has an incomplete settlement`);
  }
  if (existingDeduction && !sameDeduction(existingDeduction, state.occurrence, command.completedAt, fields)) {
    throw new Error(`occurrence ${state.occurrence.occurrenceId} already has a different student deduction`);
  }

  const credit: TeacherPayrollCredit = {
    id: `teacher-hours:${state.occurrence.occurrenceId}`,
    kind: "teacher_hours",
    occurrenceId: state.occurrence.occurrenceId,
    teacherId: fields.teacherId,
    studentId: fields.studentId,
    packageId: fields.packageId,
    subjectId: fields.subjectId,
    payableHours: fields.payableHours,
    occurredAt: command.completedAt,
  };
  if (existingCredit && !sameCredit(existingCredit, credit)) {
    throw new Error(`occurrence ${state.occurrence.occurrenceId} already has different teacher hours`);
  }
  if (!existingCredit && state.teacherPayrollLedger.some((entry) => entry.id === credit.id)) {
    throw new Error(`teacher payroll ledger id ${credit.id} already exists`);
  }

  // This is deliberately evaluated before returning any state, so failures
  // (including insufficient balance) cannot expose a partial payroll entry.
  const deduction = deductCompletedLesson(state.packages, state.studentHoursLedger, {
    entryId: `student-hours:${state.occurrence.occurrenceId}`,
    lessonId: state.occurrence.occurrenceId,
    packageId: fields.packageId,
    subjectId: fields.subjectId,
    hours: fields.payableHours,
    completedAt: command.completedAt,
  });
  const teacherPayrollLedger = existingCredit
    ? [...state.teacherPayrollLedger]
    : [...state.teacherPayrollLedger, credit];

  return {
    occurrence: { ...state.occurrence, status: "completed" },
    packages: deduction.packages,
    studentHoursLedger: deduction.ledger,
    teacherPayrollLedger,
    attendance,
    applied: deduction.applied || !existingCredit,
    disposition: "completed",
  };
}

function teacherReversalForCredit(
  ledger: readonly TeacherPayrollLedgerEntry[],
  creditId: string,
) {
  return ledger.find((entry): entry is TeacherPayrollReversal =>
    entry.kind === "reversal" && entry.reversesEntryId === creditId);
}

export function reverseLessonOccurrenceCompletion(
  state: LessonOccurrenceSettlementState,
  command: ReverseLessonOccurrenceCommand,
): LessonOccurrenceSettlementResult {
  requireTimestamp(command.reversedAt, "reversedAt");
  assertUniqueTeacherLedgerIds(state.teacherPayrollLedger);
  const deduction = studentDeductionForOccurrence(state.studentHoursLedger, state.occurrence.occurrenceId);
  const credit = teacherCreditForOccurrence(state.teacherPayrollLedger, state.occurrence.occurrenceId);
  if (!deduction && !credit) {
    return { ...copyState(state), attendance: null, applied: false, disposition: "not_settled" };
  }
  if (!deduction || !credit) {
    throw new Error(`occurrence ${state.occurrence.occurrenceId} has an incomplete settlement`);
  }

  const existingStudentReversal = state.studentHoursLedger.find((entry) =>
    entry.kind === "reversal" && entry.reversesEntryId === deduction.id);
  const existingTeacherReversal = teacherReversalForCredit(state.teacherPayrollLedger, credit.id);
  if (Boolean(existingStudentReversal) !== Boolean(existingTeacherReversal)) {
    throw new Error(`occurrence ${state.occurrence.occurrenceId} has an incomplete reversal`);
  }

  const studentReversal = reverseLessonDeduction(state.packages, state.studentHoursLedger, {
    deductionEntryId: deduction.id,
    reversalEntryId: `student-hours-reversal:${state.occurrence.occurrenceId}`,
    reversedAt: command.reversedAt,
  });
  const reversal: TeacherPayrollReversal = existingTeacherReversal ?? {
    id: `teacher-hours-reversal:${state.occurrence.occurrenceId}`,
    kind: "reversal",
    occurrenceId: credit.occurrenceId,
    teacherId: credit.teacherId,
    studentId: credit.studentId,
    packageId: credit.packageId,
    subjectId: credit.subjectId,
    payableHours: credit.payableHours,
    occurredAt: command.reversedAt,
    reversesEntryId: credit.id,
  };
  if (!existingTeacherReversal && state.teacherPayrollLedger.some((entry) => entry.id === reversal.id)) {
    throw new Error(`teacher payroll ledger id ${reversal.id} already exists`);
  }

  return {
    occurrence: { ...state.occurrence, status: command.statusAfterReversal ?? "confirmed" },
    packages: studentReversal.packages,
    studentHoursLedger: studentReversal.ledger,
    teacherPayrollLedger: existingTeacherReversal
      ? [...state.teacherPayrollLedger]
      : [...state.teacherPayrollLedger, reversal],
    attendance: null,
    applied: studentReversal.applied || !existingTeacherReversal,
    disposition: "reversed",
  };
}

import { createHash } from "node:crypto";

import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER, isDemoStaff, isDemoTeacher } from "@/lib/demo-users";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import {
  completeLessonOccurrence,
  expandLessonOccurrences,
  type LegacyLessonSeries,
  type LessonAttendanceEvidence,
  type LessonOccurrence,
  type LessonOccurrenceOverride,
  type LessonOccurrenceSettlementResult,
  type TeacherPayrollLedgerEntry,
} from "@/lib/lesson-occurrences";
import type { OpsStateRow } from "@/lib/ops-store";
import type {
  LessonHourLedgerEntry,
  StudentLessonPackage,
} from "@/lib/student-records";

type RecordValue = Record<string, unknown>;

const OCCURRENCE_ID_PATTERN = /^(.+):(\d{4}-\d{2}-\d{2})$/;
const ATTENDANCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const COMPLETE_REQUEST_FIELDS = new Set(["occurrenceId", "expectedVersion", "attendanceEvidenceReference", "overrideReason"]);

export type CompleteLessonOccurrenceRequest = Readonly<{
  occurrenceId: string;
  expectedVersion: number;
  attendanceEvidenceReference?: string;
  overrideReason?: string;
}>;

export type LessonOccurrenceServiceErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "occurrence_not_found"
  | "student_not_found"
  | "teacher_not_found"
  | "package_not_found"
  | "attendance_not_found"
  | "attendance_abnormal"
  | "occurrence_not_billable"
  | "insufficient_hours"
  | "override_admin_required"
  | "override_reason_required"
  | "teacher_forbidden"
  | "student_scope_forbidden"
  | "stale_expected_version";

export class LessonOccurrenceServiceError extends Error {
  constructor(readonly code: LessonOccurrenceServiceErrorCode, message: string) {
    super(message);
    this.name = "LessonOccurrenceServiceError";
  }
}

export type LessonSettlementAccess = Readonly<{
  allowed: boolean;
  fullAdmin: boolean;
  limitedAdmin: boolean;
  overrideAllowed: boolean;
}>;

export type PreparedLessonOccurrenceSettlement = Readonly<{
  occurrence: LessonOccurrence;
  settlement: LessonOccurrenceSettlementResult;
  idempotencyKey: string;
  attendanceReference?: string;
  overrideReason?: string;
  studentVersion: number;
  stateVersions: Readonly<Record<string, number>>;
}>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function records(row: OpsStateRow | undefined, entity: string) {
  if (!row || row.entity !== entity || !Number.isSafeInteger(row.version) || !Array.isArray(row.payload)) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  if (!row.payload.every(isRecord)) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", `${entity} shared state contains an invalid record.`);
  }
  return row.payload;
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", `${field} is missing.`);
  }
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", `${field} is invalid.`);
  }
  return value;
}

function nonNegativeNumberValue(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", `${field} is invalid.`);
  }
  return value;
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", `${field} is invalid.`);
  }
  return value as string[];
}

function parsePackages(value: unknown): readonly StudentLessonPackage[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) throw new LessonOccurrenceServiceError("invalid_shared_state", "lessonPackages is invalid.");
    const purchases = Array.isArray(item.purchaseRecords) ? item.purchaseRecords.map((purchase) => {
      if (!isRecord(purchase)) throw new LessonOccurrenceServiceError("invalid_shared_state", "purchaseRecords is invalid.");
      const hours = numberValue(purchase.hours, "purchase hours");
      const hasPurchasedHours = purchase.purchasedHours !== undefined;
      const hasBonusHours = purchase.bonusHours !== undefined;
      if (hasPurchasedHours !== hasBonusHours) {
        throw new LessonOccurrenceServiceError("invalid_shared_state", "purchase breakdown is invalid.");
      }
      const purchasedHours = hasPurchasedHours
        ? nonNegativeNumberValue(purchase.purchasedHours, "purchase purchasedHours")
        : undefined;
      const bonusHours = hasBonusHours
        ? nonNegativeNumberValue(purchase.bonusHours, "purchase bonusHours")
        : undefined;
      if (purchasedHours !== undefined && Math.round((purchasedHours + bonusHours!) * 1_000_000)
        !== Math.round(hours * 1_000_000)) {
        throw new LessonOccurrenceServiceError("invalid_shared_state", "purchase breakdown is invalid.");
      }
      return {
        id: requiredText(purchase.id, "purchase id"),
        purchasedAt: requiredText(purchase.purchasedAt, "purchase purchasedAt"),
        hours,
        ...(purchasedHours !== undefined ? { purchasedHours, bonusHours } : {}),
        ...(optionalText(purchase.note) ? { note: optionalText(purchase.note) } : {}),
      };
    }) : [];
    const consumedHours = typeof item.consumedHours === "number" ? item.consumedHours : 0;
    return {
      id: requiredText(item.id, "lesson package id"),
      name: requiredText(item.name, "lesson package name"),
      subjectIds: stringArray(item.subjectIds, "lesson package subjectIds"),
      purchaseRecords: purchases,
      consumedHours,
    };
  });
}

function parseStudentLedger(value: unknown): readonly LessonHourLedgerEntry[] {
  return Array.isArray(value) ? value as LessonHourLedgerEntry[] : [];
}

function parsePayrollLedger(row: OpsStateRow | undefined): readonly TeacherPayrollLedgerEntry[] {
  if (!row) return [];
  return records(row, "payroll").filter((item) => item.kind === "teacher_hours" || item.kind === "reversal") as TeacherPayrollLedgerEntry[];
}

function bookingSeries(value: RecordValue): LegacyLessonSeries {
  const duration = value.durationMinutes ?? value.duration;
  return {
    id: requiredText(value.id, "booking id"),
    date: requiredText(value.date, "booking date"),
    start: requiredText(value.start, "booking start"),
    duration: numberValue(duration, "booking duration"),
    ...(value.recurring === true ? { recurring: true } : {}),
    ...(typeof value.repeatCount === "number" ? { repeatCount: value.repeatCount } : {}),
    ...(typeof value.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: value.recurrenceIntervalDays } : {}),
    ...(typeof value.recurrenceEndDate === "string" ? { recurrenceEndDate: value.recurrenceEndDate } : {}),
    ...(optionalText(value.studentId) ? { studentId: optionalText(value.studentId) } : {}),
    ...(optionalText(value.teacherId) ? { teacherId: optionalText(value.teacherId) } : {}),
    ...(optionalText(value.packageId) ? { packageId: optionalText(value.packageId) } : {}),
    ...(optionalText(value.subjectId) ? { subjectId: optionalText(value.subjectId) } : {}),
    ...(optionalText(value.course) ? { course: optionalText(value.course) } : {}),
  };
}

export function parseCompleteLessonOccurrenceRequest(value: unknown): CompleteLessonOccurrenceRequest {
  if (!isRecord(value)) throw new LessonOccurrenceServiceError("invalid_request", "Completion request is missing.");
  if (Object.keys(value).some((field) => !COMPLETE_REQUEST_FIELDS.has(field))) {
    throw new LessonOccurrenceServiceError("client_fields_forbidden", "Only occurrence, version and evidence confirmation may be submitted.");
  }
  const occurrenceId = typeof value.occurrenceId === "string" ? value.occurrenceId.trim() : "";
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId)) {
    throw new LessonOccurrenceServiceError("invalid_request", "A valid occurrenceId is required.");
  }
  if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0) {
    throw new LessonOccurrenceServiceError("invalid_request", "A valid expectedVersion is required.");
  }
  const attendanceEvidenceReference = optionalText(value.attendanceEvidenceReference);
  const overrideReason = optionalText(value.overrideReason);
  if (attendanceEvidenceReference && !ATTENDANCE_REFERENCE_PATTERN.test(attendanceEvidenceReference)) {
    throw new LessonOccurrenceServiceError("invalid_request", "Attendance evidence reference is invalid.");
  }
  if (overrideReason && (overrideReason.length < 8 || overrideReason.length > 500)) {
    throw new LessonOccurrenceServiceError("override_reason_required", "Override reason must be 8 to 500 characters.");
  }
  if (Boolean(attendanceEvidenceReference) === Boolean(overrideReason)) {
    throw new LessonOccurrenceServiceError("invalid_request", "Provide exactly one attendance reference or override reason.");
  }
  return {
    occurrenceId,
    expectedVersion: value.expectedVersion as number,
    ...(attendanceEvidenceReference ? { attendanceEvidenceReference } : {}),
    ...(overrideReason ? { overrideReason } : {}),
  };
}

export function lessonSettlementAccess(input: {
  actor: string;
  fullAdmin: boolean;
  studentOwner: string;
  role?: DemoSessionRole;
}): LessonSettlementAccess {
  const limitedAdmin = input.actor === DEMO_LIMITED_ADMIN_USER;
  const fullAdmin = input.actor === DEMO_ADMIN_USER && input.fullAdmin;
  const teacher = input.role ? input.role === "teacher" : isDemoTeacher(input.actor);
  const staff = input.role ? input.role === "staff" : isDemoStaff(input.actor);
  const staffOwnsStudent = staff
    && input.studentOwner.trim().toLocaleLowerCase() === input.actor.trim().toLocaleLowerCase();
  return {
    allowed: !teacher && (fullAdmin || limitedAdmin || staffOwnsStudent),
    fullAdmin,
    limitedAdmin,
    overrideAllowed: fullAdmin || limitedAdmin,
  };
}

function occurrenceFromRows(input: {
  occurrenceId: string;
  bookings: readonly RecordValue[];
}) {
  const match = OCCURRENCE_ID_PATTERN.exec(input.occurrenceId);
  if (!match) throw new LessonOccurrenceServiceError("invalid_request", "A valid occurrenceId is required.");
  const [, seriesId, sourceDate] = match;
  const booking = input.bookings.find((item) => item.id === seriesId);
  if (!booking) throw new LessonOccurrenceServiceError("occurrence_not_found", "Lesson occurrence was not found.");
  const overrides = Array.isArray(booking.occurrenceOverrides)
    ? booking.occurrenceOverrides.filter(isRecord).filter((item) => typeof item.occurrenceId === "string") as LessonOccurrenceOverride[]
    : [];
  let occurrences: LessonOccurrence[];
  try {
    occurrences = expandLessonOccurrences(bookingSeries(booking), {
      rangeStart: sourceDate,
      rangeEnd: sourceDate,
      overrides: overrides.filter((override) => override.occurrenceId === input.occurrenceId),
    });
  } catch (error) {
    throw new LessonOccurrenceServiceError("invalid_shared_state", error instanceof Error ? error.message : "Booking occurrence is invalid.");
  }
  const occurrence = occurrences.find((item) => item.occurrenceId === input.occurrenceId);
  if (!occurrence) throw new LessonOccurrenceServiceError("occurrence_not_found", "Lesson occurrence was not found.");
  return occurrence;
}

function idempotencyKey(occurrenceId: string) {
  return `lesson-complete:${createHash("sha256").update(`lesson-completion-v1:${occurrenceId}`).digest("hex")}`;
}

function settlementStateVersions(rows: readonly OpsStateRow[]) {
  const entities = ["bookings", "students", "teachers", "payroll"];
  return Object.fromEntries(entities.map((entity) => [
    entity,
    rows.find((row) => row.entity === entity)?.version ?? -1,
  ]));
}

export function prepareLessonOccurrenceSettlement(input: {
  request: CompleteLessonOccurrenceRequest;
  rows: readonly OpsStateRow[];
  actor: string;
  fullAdmin: boolean;
  role?: DemoSessionRole;
  trustedProvider?: "bbb";
  attendance?: LessonAttendanceEvidence;
  completedAt: string;
}): PreparedLessonOccurrenceSettlement {
  const bookingsRow = input.rows.find((row) => row.entity === "bookings");
  const studentsRow = input.rows.find((row) => row.entity === "students");
  const teachersRow = input.rows.find((row) => row.entity === "teachers");
  const payrollRow = input.rows.find((row) => row.entity === "payroll");
  const occurrence = occurrenceFromRows({
    occurrenceId: input.request.occurrenceId,
    bookings: records(bookingsRow, "bookings"),
  });
  if (input.request.expectedVersion !== bookingsRow!.version) {
    throw new LessonOccurrenceServiceError("stale_expected_version", "The booking changed after this occurrence was loaded.");
  }
  const student = records(studentsRow, "students").find((item) => item.id === occurrence.studentId);
  if (!student) throw new LessonOccurrenceServiceError("student_not_found", "Occurrence student was not found.");
  const teacher = records(teachersRow, "teachers").find((item) => item.id === occurrence.teacherId);
  if (!teacher) throw new LessonOccurrenceServiceError("teacher_not_found", "Occurrence teacher was not found.");

  if (!input.trustedProvider) {
    const access = lessonSettlementAccess({
      actor: input.actor,
      fullAdmin: input.fullAdmin,
      studentOwner: requiredText(student.owner, "student owner"),
      role: input.role,
    });
    if (!access.allowed) {
      const code = (input.role ? input.role === "teacher" : isDemoTeacher(input.actor)) ? "teacher_forbidden" : "student_scope_forbidden";
      throw new LessonOccurrenceServiceError(code, "Current account cannot settle this student's lesson.");
    }
    if (input.request.overrideReason && !access.overrideAllowed) {
      throw new LessonOccurrenceServiceError("override_admin_required", "Only an administrator may override attendance.");
    }
  } else if (input.request.overrideReason) {
    throw new LessonOccurrenceServiceError("invalid_request", "Provider callbacks cannot override attendance.");
  }

  if (student.importArchived === true) {
    throw new LessonOccurrenceServiceError("student_scope_forbidden", "Archived students' lessons cannot be settled.");
  }

  const packages = parsePackages(student.lessonPackages);
  if (!packages.some((lessonPackage) => lessonPackage.id === occurrence.packageId)) {
    throw new LessonOccurrenceServiceError("package_not_found", "Occurrence lesson package was not found on the student.");
  }
  const effectiveAttendance: LessonAttendanceEvidence = input.request.overrideReason
    ? {
        student: { userId: requiredText(occurrence.studentId, "occurrence student"), accumulatedSeconds: occurrence.scheduledDurationMinutes * 60 },
        teacher: { userId: requiredText(occurrence.teacherId, "occurrence teacher"), accumulatedSeconds: occurrence.scheduledDurationMinutes * 60 },
      }
    : input.attendance ?? (() => { throw new LessonOccurrenceServiceError("attendance_not_found", "Attendance evidence was not found."); })();

  const studentHoursLedger = parseStudentLedger(student.lessonLedger);
  const teacherPayrollLedger = parsePayrollLedger(payrollRow);
  const priorDeduction = studentHoursLedger.find((entry) =>
    entry.kind === "deduction" && entry.lessonId === occurrence.occurrenceId);
  const settlementCompletedAt = priorDeduction?.occurredAt ?? input.completedAt;

  let settlement: LessonOccurrenceSettlementResult;
  try {
    settlement = completeLessonOccurrence({
      occurrence,
      packages,
      studentHoursLedger,
      teacherPayrollLedger,
    }, {
      completedAt: settlementCompletedAt,
      attendance: effectiveAttendance,
    });
  } catch (error) {
    if (error instanceof RangeError && /insufficient hours/.test(error.message)) {
      throw new LessonOccurrenceServiceError("insufficient_hours", error.message);
    }
    throw new LessonOccurrenceServiceError("invalid_shared_state", error instanceof Error ? error.message : "Lesson settlement failed.");
  }
  if (settlement.disposition === "not_billable") {
    throw new LessonOccurrenceServiceError("occurrence_not_billable", "Cancelled or leave occurrences cannot be completed.");
  }
  if (settlement.disposition === "abnormal" && !input.trustedProvider) {
    throw new LessonOccurrenceServiceError("attendance_abnormal", "Both parties must meet the attendance duration before automatic completion.");
  }
  return {
    occurrence,
    settlement,
    idempotencyKey: idempotencyKey(occurrence.occurrenceId),
    ...(input.request.attendanceEvidenceReference ? { attendanceReference: input.request.attendanceEvidenceReference } : {}),
    ...(input.request.overrideReason ? { overrideReason: input.request.overrideReason } : {}),
    studentVersion: studentsRow!.version,
    stateVersions: settlementStateVersions(input.rows),
  };
}

import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER } from "@/lib/demo-users";
import type { OpsStateRow, TeacherAvailabilitySubmissionRow } from "@/lib/ops-store";
import {
  approveTeacherAvailabilitySubmission,
  TeacherAvailabilityValidationError,
  type AvailabilitySlotInput,
  type TeacherAvailabilitySubmission,
  type TeacherAvailabilityWindow,
} from "@/lib/teacher-availability";

const REVIEW_REQUEST_FIELDS = new Set([
  "submissionId",
  "decision",
  "expectedTeacherVersion",
  "reviewNote",
]);

type RecordValue = Record<string, unknown>;

export type TeacherAvailabilityReviewDecision = "approved" | "rejected";

export type TeacherAvailabilityReviewRequest = Readonly<{
  submissionId: number;
  decision: TeacherAvailabilityReviewDecision;
  expectedTeacherVersion: number;
  reviewNote?: string;
}>;

export type TeacherAvailabilityReviewItem = Readonly<{
  submission: TeacherAvailabilitySubmission;
  teacherName: string;
  currentCity?: string;
  additionalStudents: number;
  notes?: string;
  submittedAt: string;
}>;

export type TeacherAvailabilityReviewInbox = Readonly<{
  teacherVersion: number;
  submissions: readonly TeacherAvailabilityReviewItem[];
}>;

export type PreparedTeacherAvailabilityReview = Readonly<{
  submissionId: number;
  decision: TeacherAvailabilityReviewDecision;
  expectedSubmissionStatus: "pending";
  expectedTeacherVersion: number;
  availabilityWindows: readonly TeacherAvailabilityWindow[] | null;
  actor: typeof DEMO_ADMIN_USER | typeof DEMO_LIMITED_ADMIN_USER;
  reviewNote?: string;
}>;

export type TeacherAvailabilityReviewServiceErrorCode =
  | "invalid_request"
  | "invalid_submission_rows"
  | "invalid_teachers_state"
  | "submission_not_found"
  | "submission_changed"
  | "teacher_not_found"
  | "stale_teacher_version"
  | "invalid_submission";

export class TeacherAvailabilityReviewServiceError extends Error {
  constructor(
    readonly code: TeacherAvailabilityReviewServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeacherAvailabilityReviewServiceError";
  }
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidRows(message: string): never {
  throw new TeacherAvailabilityReviewServiceError("invalid_submission_rows", message);
}

function parseSubmissionId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalidRows(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) invalidRows(`${label} is missing.`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") invalidRows(`${label} must be text.`);
  return value.trim() || undefined;
}

function parseSlots(value: unknown): AvailabilitySlotInput[] {
  if (!Array.isArray(value)) invalidRows("availability_slots must be an array.");
  return value.map((slot, index) => {
    if (!isRecord(slot)
      || !Number.isInteger(slot.day)
      || (slot.day as number) < 0
      || (slot.day as number) > 6
      || typeof slot.start !== "string"
      || typeof slot.end !== "string") {
      invalidRows(`availability_slots[${index}] is invalid.`);
    }
    return {
      ...(typeof slot.id === "string" && slot.id.trim() ? { id: slot.id.trim() } : {}),
      day: slot.day as number,
      start: slot.start,
      end: slot.end,
    };
  });
}

function parseSubmissionRow(value: unknown): TeacherAvailabilitySubmissionRow {
  if (!isRecord(value)) invalidRows("Availability submission row is invalid.");
  const status = value.status;
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    invalidRows("Availability submission status is invalid.");
  }
  const additionalStudents = value.additional_students;
  if (!Number.isSafeInteger(additionalStudents) || (additionalStudents as number) < 0) {
    invalidRows("additional_students is invalid.");
  }
  const submittedAt = requiredText(value.submitted_at, "submitted_at");
  if (!Number.isFinite(new Date(submittedAt).getTime())) invalidRows("submitted_at is invalid.");
  return {
    id: parseSubmissionId(value.id, "submission id"),
    teacher_id: requiredText(value.teacher_id, "teacher_id"),
    teacher_name: requiredText(value.teacher_name, "teacher_name"),
    submission_month: requiredText(value.submission_month, "submission_month"),
    availability_timezone: requiredText(value.availability_timezone, "availability_timezone"),
    current_city: optionalText(value.current_city, "current_city") ?? null,
    additional_students: additionalStudents as number,
    availability_slots: parseSlots(value.availability_slots),
    notes: optionalText(value.notes, "notes") ?? null,
    status,
    submitted_at: submittedAt,
    reviewed_at: optionalText(value.reviewed_at, "reviewed_at") ?? null,
    reviewed_by: optionalText(value.reviewed_by, "reviewed_by") ?? null,
    review_note: optionalText(value.review_note, "review_note") ?? null,
  };
}

function toDomainSubmission(row: TeacherAvailabilitySubmissionRow): TeacherAvailabilitySubmission {
  return {
    id: String(row.id),
    teacherId: row.teacher_id,
    month: row.submission_month,
    timezone: row.availability_timezone,
    slots: parseSlots(row.availability_slots),
  };
}

function parseTeachersState(row: OpsStateRow | undefined): {
  version: number;
  teachers: readonly RecordValue[];
} {
  if (!row
    || row.entity !== "teachers"
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || !Array.isArray(row.payload)) {
    throw new TeacherAvailabilityReviewServiceError(
      "invalid_teachers_state",
      "Teachers state is not available for availability review.",
    );
  }
  const teachers = row.payload.map((teacher) => {
    if (!isRecord(teacher) || typeof teacher.id !== "string" || !teacher.id.trim()) {
      throw new TeacherAvailabilityReviewServiceError(
        "invalid_teachers_state",
        "Teachers state contains an invalid teacher record.",
      );
    }
    return teacher;
  });
  return { version: row.version, teachers };
}

function teacherWindows(teacher: RecordValue): TeacherAvailabilityWindow[] {
  if (teacher.availabilityWindows === undefined) return [];
  if (!Array.isArray(teacher.availabilityWindows)) {
    throw new TeacherAvailabilityReviewServiceError(
      "invalid_teachers_state",
      "The teacher availability record is invalid.",
    );
  }
  return teacher.availabilityWindows as TeacherAvailabilityWindow[];
}

export function hasTeacherAvailabilityReviewAdminAccess(
  actor: string | null,
  fullAdmin: boolean,
) {
  return actor === DEMO_LIMITED_ADMIN_USER || (actor === DEMO_ADMIN_USER && fullAdmin);
}

export function parseTeacherAvailabilityReviewRequest(
  value: unknown,
): TeacherAvailabilityReviewRequest {
  if (!isRecord(value)
    || Object.keys(value).some((field) => !REVIEW_REQUEST_FIELDS.has(field))) {
    throw new TeacherAvailabilityReviewServiceError(
      "invalid_request",
      "Availability review parameters are invalid.",
    );
  }
  if (!Number.isSafeInteger(value.submissionId) || (value.submissionId as number) < 1
    || (value.decision !== "approved" && value.decision !== "rejected")
    || !Number.isSafeInteger(value.expectedTeacherVersion)
    || (value.expectedTeacherVersion as number) < 1
    || (value.reviewNote !== undefined && typeof value.reviewNote !== "string")
    || (typeof value.reviewNote === "string" && value.reviewNote.length > 1000)) {
    throw new TeacherAvailabilityReviewServiceError(
      "invalid_request",
      "Availability review parameters are invalid.",
    );
  }
  return {
    submissionId: value.submissionId as number,
    decision: value.decision,
    expectedTeacherVersion: value.expectedTeacherVersion as number,
    ...(typeof value.reviewNote === "string" && value.reviewNote.trim()
      ? { reviewNote: value.reviewNote.trim() }
      : {}),
  };
}

export function buildTeacherAvailabilityReviewInbox(input: {
  rows: readonly unknown[];
  teachersRow: OpsStateRow | undefined;
}): TeacherAvailabilityReviewInbox {
  const teachersState = parseTeachersState(input.teachersRow);
  const submissions = input.rows
    .filter((row) => isRecord(row) && row.status === "pending")
    .map(parseSubmissionRow)
    .map((row): TeacherAvailabilityReviewItem => ({
      submission: toDomainSubmission(row),
      teacherName: row.teacher_name,
      ...(row.current_city ? { currentCity: row.current_city } : {}),
      additionalStudents: row.additional_students,
      ...(row.notes ? { notes: row.notes } : {}),
      submittedAt: row.submitted_at,
    }));
  return { teacherVersion: teachersState.version, submissions };
}

/**
 * Computes the only write payload accepted by the atomic RPC. Submitted time
 * windows always come from the database row; the browser supplies no windows.
 */
export function prepareTeacherAvailabilityReview(input: {
  request: TeacherAvailabilityReviewRequest;
  rows: readonly unknown[];
  teachersRow: OpsStateRow | undefined;
  actor: string;
  fullAdmin: boolean;
}): PreparedTeacherAvailabilityReview {
  if (!hasTeacherAvailabilityReviewAdminAccess(input.actor, input.fullAdmin)) {
    throw new TeacherAvailabilityReviewServiceError("invalid_request", "Admin access is required.");
  }
  const teachersState = parseTeachersState(input.teachersRow);
  if (teachersState.version !== input.request.expectedTeacherVersion) {
    throw new TeacherAvailabilityReviewServiceError(
      "stale_teacher_version",
      "The teacher directory changed after this submission was loaded.",
    );
  }
  const rawSubmissionRow = input.rows.find((row) => isRecord(row)
    && row.id === input.request.submissionId);
  if (!rawSubmissionRow) {
    throw new TeacherAvailabilityReviewServiceError(
      "submission_not_found",
      "The availability submission was not found.",
    );
  }
  const submissionRow = parseSubmissionRow(rawSubmissionRow);
  if (submissionRow.status !== "pending") {
    throw new TeacherAvailabilityReviewServiceError(
      "submission_changed",
      "The availability submission has already been reviewed.",
    );
  }
  const teacher = teachersState.teachers.find((item) => item.id === submissionRow.teacher_id);
  if (!teacher) {
    throw new TeacherAvailabilityReviewServiceError(
      "teacher_not_found",
      "The teacher linked to this submission was not found.",
    );
  }

  let availabilityWindows: readonly TeacherAvailabilityWindow[] | null = null;
  if (input.request.decision === "approved") {
    try {
      availabilityWindows = approveTeacherAvailabilitySubmission(
        teacherWindows(teacher),
        toDomainSubmission(submissionRow),
      );
    } catch (error) {
      if (error instanceof TeacherAvailabilityValidationError) {
        throw new TeacherAvailabilityReviewServiceError(
          "invalid_submission",
          `The submitted availability is invalid: ${error.message}`,
        );
      }
      throw error;
    }
  }

  return {
    submissionId: submissionRow.id,
    decision: input.request.decision,
    expectedSubmissionStatus: "pending",
    expectedTeacherVersion: teachersState.version,
    availabilityWindows,
    actor: input.actor as typeof DEMO_ADMIN_USER | typeof DEMO_LIMITED_ADMIN_USER,
    ...(input.request.reviewNote ? { reviewNote: input.request.reviewNote } : {}),
  };
}

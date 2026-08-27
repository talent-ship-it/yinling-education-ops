import type { DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";
import {
  assertValidAvailabilitySlots,
  TeacherAvailabilityValidationError,
  type AvailabilitySlotInput,
} from "@/lib/teacher-availability";

type RecordValue = Record<string, unknown>;

const REQUEST_FIELDS = new Set([
  "submissionKey",
  "month",
  "timezone",
  "additionalStudents",
  "slots",
  "notes",
]);
const SLOT_FIELDS = new Set(["day", "start", "end"]);
const SUBMISSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type TeacherAvailabilitySubmitRequest = Readonly<{
  submissionKey: string;
  month: string;
  timezone: string;
  additionalStudents: number;
  slots: readonly Readonly<{ day: number; start: string; end: string }>[];
  notes?: string;
}>;

export type PreparedTeacherAvailabilitySubmission = TeacherAvailabilitySubmitRequest & Readonly<{
  expectedTeacherVersion: number;
  teacherId: string;
  teacherName: string;
  actor: string;
}>;

export type TeacherAvailabilitySubmitErrorCode =
  | "invalid_request"
  | "invalid_month"
  | "invalid_timezone"
  | "invalid_slots"
  | "teacher_only"
  | "teacher_identity_not_found"
  | "teacher_identity_ambiguous"
  | "invalid_teachers_state";

export class TeacherAvailabilitySubmitError extends Error {
  constructor(readonly code: TeacherAvailabilitySubmitErrorCode, message: string) {
    super(message);
    this.name = "TeacherAvailabilitySubmitError";
  }
}

function fail(code: TeacherAvailabilitySubmitErrorCode, message: string): never {
  throw new TeacherAvailabilitySubmitError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyFields(value: RecordValue, allowed: ReadonlySet<string>) {
  return !Object.keys(value).some((field) => !allowed.has(field));
}

function optionalText(value: unknown, field: string, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail("invalid_request", `${field} must be text.`);
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > maximum) fail("invalid_request", `${field} is too long.`);
  return result;
}

function monthIndex(month: string) {
  const [year, value] = month.split("-").map(Number);
  return year * 12 + value - 1;
}

export function parseTeacherAvailabilitySubmitRequest(
  value: unknown,
  now = new Date(),
): TeacherAvailabilitySubmitRequest {
  if (!isRecord(value) || !onlyFields(value, REQUEST_FIELDS)) {
    fail("invalid_request", "Availability submission fields are invalid.");
  }
  if (typeof value.submissionKey !== "string" || !SUBMISSION_KEY.test(value.submissionKey)) {
    fail("invalid_request", "submissionKey must be a UUID v4.");
  }
  if (typeof value.month !== "string" || !MONTH.test(value.month)) {
    fail("invalid_month", "month must use YYYY-MM.");
  }
  if (Number.isNaN(now.valueOf())) fail("invalid_request", "Server time is invalid.");
  const currentMonth = now.toISOString().slice(0, 7);
  const offset = monthIndex(value.month) - monthIndex(currentMonth);
  if (offset < 0 || offset > 12) {
    fail("invalid_month", "month must be the current month or one of the next 12 months.");
  }
  if (typeof value.timezone !== "string" || !value.timezone.trim() || value.timezone.length > 100) {
    fail("invalid_timezone", "timezone is required.");
  }
  const timezone = value.timezone.trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    fail("invalid_timezone", "timezone must be a valid IANA timezone.");
  }
  if (!Number.isSafeInteger(value.additionalStudents)
    || (value.additionalStudents as number) < 0
    || (value.additionalStudents as number) > 100) {
    fail("invalid_request", "additionalStudents must be an integer from 0 to 100.");
  }
  if (!Array.isArray(value.slots) || value.slots.length > 64) {
    fail("invalid_slots", "slots must contain at most 64 weekly time ranges.");
  }
  const slots: AvailabilitySlotInput[] = value.slots.map((slot, index) => {
    if (!isRecord(slot)
      || !onlyFields(slot, SLOT_FIELDS)
      || !Number.isInteger(slot.day)
      || (slot.day as number) < 0
      || (slot.day as number) > 6
      || typeof slot.start !== "string"
      || typeof slot.end !== "string"
      || !TIME.test(slot.start)
      || !TIME.test(slot.end)
      || slot.end === slot.start) {
      fail("invalid_slots", `slots[${index}] is invalid.`);
    }
    return { day: slot.day as number, start: slot.start, end: slot.end };
  });
  try {
    assertValidAvailabilitySlots(slots);
  } catch (error) {
    if (error instanceof TeacherAvailabilityValidationError) {
      fail("invalid_slots", error.message);
    }
    throw error;
  }
  const notes = optionalText(value.notes, "notes", 1000);
  return {
    submissionKey: value.submissionKey.toLowerCase(),
    month: value.month,
    timezone,
    additionalStudents: value.additionalStudents as number,
    slots,
    ...(notes ? { notes } : {}),
  };
}

function normaliseName(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

export function prepareTeacherAvailabilitySubmission(input: {
  request: TeacherAvailabilitySubmitRequest;
  teachersRow: OpsStateRow | undefined;
  actor: string;
  role: DemoSessionRole;
}): PreparedTeacherAvailabilitySubmission {
  if (input.role !== "teacher") fail("teacher_only", "Only a signed-in teacher can submit monthly availability.");
  const row = input.teachersRow;
  if (!row
    || row.entity !== "teachers"
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || !Array.isArray(row.payload)
    || !row.payload.every(isRecord)) {
    fail("invalid_teachers_state", "Teacher directory is unavailable.");
  }
  const matches = row.payload.filter((teacher) => normaliseName(teacher.name) === normaliseName(input.actor));
  if (!matches.length) fail("teacher_identity_not_found", "The signed-in teacher is not linked to the teacher directory.");
  if (matches.length !== 1) fail("teacher_identity_ambiguous", "The signed-in teacher identity is ambiguous.");
  const teacher = matches[0];
  if (typeof teacher.id !== "string" || !teacher.id.trim()
    || typeof teacher.name !== "string" || !teacher.name.trim()) {
    fail("invalid_teachers_state", "The linked teacher record is invalid.");
  }
  return {
    ...input.request,
    expectedTeacherVersion: row.version,
    teacherId: teacher.id.trim(),
    teacherName: teacher.name.trim(),
    actor: input.actor,
  };
}

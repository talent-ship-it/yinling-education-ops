import { createHash } from "node:crypto";

import { buildOpsAccessContext, canOperateStudent } from "@/lib/ops-access";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";
import { renewalTaskAnchor } from "@/lib/renewal-tasks";
import { RENEWAL_STATUSES, type RenewalStatus } from "@/lib/student-records";

type RecordValue = Record<string, unknown>;

export const RENEWAL_FOLLOW_UP_RESULTS = ["已跟进", "本次未跟进", "等待家长"] as const;
export type RenewalFollowUpResult = (typeof RENEWAL_FOLLOW_UP_RESULTS)[number];

const COMMAND_FIELDS = new Set([
  "commandKey",
  "renewalId",
  "studentId",
  "packageId",
  "businessStatus",
  "result",
  "attemptedAt",
  "note",
  "renewalDateNote",
  "expectedVersions",
  "attachment",
]);
const VERSION_FIELDS = new Set(["files", "renewals", "students", "tasks"]);
const ATTACHMENT_FIELDS = new Set(["fileName", "fileTitle", "contentType", "contentBase64", "sha256"]);
const COMMAND_KEY_PATTERN = /^renewal-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const RENEWAL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]|%[0-9a-f]{2}){0,119}$/i;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const NOTE_MAX_LENGTH = 2000;
const RENEWAL_DATE_NOTE_MAX_LENGTH = 500;
const ACTIVE_STUDENT_STATUSES = new Set([
  "在读",
  "活跃 + 有课时",
  "活跃 + 无课时",
  "在读 + 加课待排",
]);

export type RenewalFollowUpAttachment = Readonly<{
  fileName: string;
  fileTitle: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  contentBase64: string;
  sha256: string;
}>;

export type RenewalFollowUpCommand = Readonly<{
  commandKey: string;
  renewalId: string;
  studentId: string;
  packageId?: string;
  businessStatus: RenewalStatus;
  result: RenewalFollowUpResult;
  attemptedAt: string;
  note: string;
  renewalDateNote: string;
  expectedVersions: Readonly<{
    files: number;
    renewals: number;
    students: number;
    tasks: number;
  }>;
  attachment?: RenewalFollowUpAttachment;
}>;

export type RenewalFollowUpIntent = Readonly<{
  renewalId: string;
  studentId: string;
  packageId?: string;
  businessStatus: RenewalStatus;
  result: RenewalFollowUpResult;
  attemptedAt: string;
  note: string;
  renewalDateNote: string;
  hasAttachment: boolean;
  attachmentSha256?: string;
}>;

export type PreparedRenewalFollowUp = Readonly<{
  commandKey: string;
  commandIntent: RenewalFollowUpIntent;
  renewalId: string;
  studentId: string;
  packageId?: string;
  businessStatus: RenewalStatus;
  result: RenewalFollowUpResult;
  attemptedAt: string;
  note: string;
  renewalDateNote: string;
  expectedVersions: RenewalFollowUpCommand["expectedVersions"];
  attachment?: RenewalFollowUpAttachment;
}>;

export type RenewalFollowUpServiceErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "renewal_not_found"
  | "student_not_found"
  | "renewal_identity_conflict"
  | "student_scope_forbidden"
  | "teacher_forbidden"
  | "archived_student_read_only";

export class RenewalFollowUpServiceError extends Error {
  constructor(readonly code: RenewalFollowUpServiceErrorCode, message: string) {
    super(message);
    this.name = "RenewalFollowUpServiceError";
  }
}

function fail(code: RenewalFollowUpServiceErrorCode, message: string): never {
  throw new RenewalFollowUpServiceError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, field, maxLength);
}

function boundedText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.length > maxLength) {
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

function assertOnlyFields(value: RecordValue, allowed: ReadonlySet<string>, message: string) {
  if (Object.keys(value).some((field) => !allowed.has(field))) fail("client_fields_forbidden", message);
}

function assertIsoDateTime(value: string) {
  if (!DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail("invalid_request", "attemptedAt must be an ISO UTC timestamp.");
  }
}

function expectedVersions(value: unknown) {
  if (!isRecord(value)) fail("invalid_request", "expectedVersions is required.");
  assertOnlyFields(value, VERSION_FIELDS, "Only renewal OCC versions may be submitted.");
  return {
    files: version(value.files, "expectedVersions.files"),
    renewals: version(value.renewals, "expectedVersions.renewals"),
    students: version(value.students, "expectedVersions.students"),
    tasks: version(value.tasks, "expectedVersions.tasks"),
  } as const;
}

function parseAttachment(value: unknown): RenewalFollowUpAttachment | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail("invalid_request", "attachment is invalid.");
  assertOnlyFields(value, ATTACHMENT_FIELDS, "Only reviewed renewal attachment fields may be submitted.");
  const fileName = requiredText(value.fileName, "attachment.fileName", 180);
  const fileTitle = requiredText(value.fileTitle, "attachment.fileTitle", 180);
  const contentType = requiredText(value.contentType, "attachment.contentType", 80);
  if (!(["image/jpeg", "image/png", "image/webp"] as readonly string[]).includes(contentType)) {
    fail("invalid_request", "attachment.contentType is invalid.");
  }
  const contentBase64 = requiredText(value.contentBase64, "attachment.contentBase64", 5_600_000);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    fail("invalid_request", "attachment.contentBase64 is invalid.");
  }
  const sha256 = requiredText(value.sha256, "attachment.sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("invalid_request", "attachment.sha256 is invalid.");
  const actual = createHash("sha256").update(Buffer.from(contentBase64, "base64")).digest("hex");
  if (actual !== sha256) fail("invalid_request", "attachment.sha256 does not match its bytes.");
  return {
    fileName,
    fileTitle,
    contentType: contentType as RenewalFollowUpAttachment["contentType"],
    contentBase64,
    sha256,
  };
}

export function parseRenewalFollowUpCommand(value: unknown): RenewalFollowUpCommand {
  if (!isRecord(value)) fail("invalid_request", "Renewal follow-up command is missing.");
  assertOnlyFields(value, COMMAND_FIELDS, "Only reviewed renewal follow-up fields may be submitted.");
  const commandKey = requiredText(value.commandKey, "commandKey", 100);
  if (!COMMAND_KEY_PATTERN.test(commandKey)) fail("invalid_request", "commandKey is invalid.");
  const renewalId = requiredText(value.renewalId, "renewalId");
  if (!RENEWAL_ID_PATTERN.test(renewalId)) fail("invalid_request", "renewalId is invalid.");
  const studentId = requiredText(value.studentId, "studentId");
  if (!ID_PATTERN.test(studentId)) fail("invalid_request", "studentId is invalid.");
  const packageId = optionalText(value.packageId, "packageId", 120);
  const businessStatus = requiredText(value.businessStatus, "businessStatus", 80);
  if (!(RENEWAL_STATUSES as readonly string[]).includes(businessStatus)) {
    fail("invalid_request", "businessStatus is invalid.");
  }
  const result = requiredText(value.result, "result", 40);
  if (!(RENEWAL_FOLLOW_UP_RESULTS as readonly string[]).includes(result)) {
    fail("invalid_request", "result is invalid.");
  }
  const attemptedAt = requiredText(value.attemptedAt, "attemptedAt", 40);
  assertIsoDateTime(attemptedAt);
  const note = boundedText(value.note ?? "", "note", NOTE_MAX_LENGTH);
  const renewalDateNote = boundedText(value.renewalDateNote ?? "", "renewalDateNote", RENEWAL_DATE_NOTE_MAX_LENGTH);
  const attachment = parseAttachment(value.attachment);
  return {
    commandKey,
    renewalId,
    studentId,
    ...(packageId ? { packageId } : {}),
    businessStatus: businessStatus as RenewalStatus,
    result: result as RenewalFollowUpResult,
    attemptedAt,
    note,
    renewalDateNote,
    expectedVersions: expectedVersions(value.expectedVersions),
    ...(attachment ? { attachment } : {}),
  };
}

export function renewalFollowUpIntent(command: RenewalFollowUpCommand): RenewalFollowUpIntent {
  return {
    renewalId: command.renewalId,
    studentId: command.studentId,
    ...(command.packageId ? { packageId: command.packageId } : {}),
    businessStatus: command.businessStatus,
    result: command.result,
    attemptedAt: command.attemptedAt,
    note: command.note,
    renewalDateNote: command.renewalDateNote,
    hasAttachment: Boolean(command.attachment),
    ...(command.attachment ? { attachmentSha256: command.attachment.sha256 } : {}),
  };
}

/**
 * Automatic renewal rows are projections, not client-owned records.  The
 * stable id is deliberately the only signal the route uses to select the
 * create-if-missing RPC; all package identity is still checked against the
 * authoritative student row below and again inside the database function.
 */
export function isCreateIfMissingRenewal(command: Pick<RenewalFollowUpCommand, "renewalId">) {
  return command.renewalId.startsWith("REN-AUTO:");
}

function payloadRecords(rows: readonly OpsStateRow[], entity: string) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1
    || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
    fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  return { row, payload: row.payload as RecordValue[] };
}

export function prepareRenewalFollowUp(input: Readonly<{
  command: RenewalFollowUpCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  fullAdmin: boolean;
}>): PreparedRenewalFollowUp {
  if (input.role === "teacher") fail("teacher_forbidden", "Teacher accounts cannot record renewal follow-up.");
  const students = payloadRecords(input.rows, "students");
  const renewals = payloadRecords(input.rows, "renewals");
  const files = payloadRecords(input.rows, "files");
  const tasks = payloadRecords(input.rows, "tasks");
  if (students.row.version !== input.command.expectedVersions.students
    || renewals.row.version !== input.command.expectedVersions.renewals
    || files.row.version !== input.command.expectedVersions.files
    || tasks.row.version !== input.command.expectedVersions.tasks) {
    fail("stale_expected_version", "Student, renewal, task or file state changed; refresh before saving the follow-up.");
  }
  const access = buildOpsAccessContext(input.rows as OpsStateRow[], input.actor, input.fullAdmin, input.role);
  if (!canOperateStudent(access, input.command.studentId)) {
    fail("student_scope_forbidden", "The current account cannot record renewal follow-up for this student.");
  }
  const matchingStudents = students.payload.filter((student) => student.id === input.command.studentId);
  if (matchingStudents.length !== 1) fail("student_not_found", "The student was not found.");
  const student = matchingStudents[0];
  if (student.importArchived === true) fail("archived_student_read_only", "Archived student records are read-only.");
  if (isCreateIfMissingRenewal(input.command)) {
    if (typeof student.status !== "string" || !ACTIVE_STUDENT_STATUSES.has(student.status.trim())) {
      fail("student_scope_forbidden", "Inactive students cannot create renewal follow-up records.");
    }
    if (!input.command.packageId) {
      fail("renewal_identity_conflict", "Create-if-missing renewal follow-up requires an exact package.");
    }
    const packages = student.lessonPackages;
    if (!Array.isArray(packages)) {
      fail("renewal_identity_conflict", "The selected student has no authoritative lesson package for this renewal.");
    }
    const matchingPackages = packages.filter((lessonPackage) => isRecord(lessonPackage) && lessonPackage.id === input.command.packageId);
    if (matchingPackages.length !== 1) {
      fail("renewal_identity_conflict", "The selected package is not an exact active student package.");
    }
    const expectedRenewalId = `REN-AUTO:${renewalTaskAnchor(input.command.studentId, input.command.packageId)}`;
    if (input.command.renewalId !== expectedRenewalId) {
      fail("renewal_identity_conflict", "The automatic renewal identity does not match the selected student and package.");
    }
  }
  const matchingRenewals = renewals.payload.filter((renewal) => renewal.id === input.command.renewalId);
  if (!isCreateIfMissingRenewal(input.command)) {
    if (matchingRenewals.length !== 1) fail("renewal_not_found", "The renewal record was not found.");
    if (matchingRenewals[0].studentId !== input.command.studentId) {
      fail("renewal_identity_conflict", "The renewal record does not belong to the selected student.");
    }
    if (input.command.packageId !== undefined && matchingRenewals[0].packageId !== input.command.packageId) {
      fail("renewal_identity_conflict", "The renewal package changed; refresh before saving the follow-up.");
    }
  } else if (matchingRenewals.length > 1) {
    fail("renewal_identity_conflict", "The automatic renewal identity is duplicated.");
  } else if (matchingRenewals[0]) {
    if (matchingRenewals[0].studentId !== input.command.studentId
      || matchingRenewals[0].packageId !== input.command.packageId
      || (matchingRenewals[0].subjectId !== undefined && matchingRenewals[0].subjectId !== null && matchingRenewals[0].subjectId !== "")) {
      fail("renewal_identity_conflict", "The automatic renewal record is not the exact student package record.");
    }
  }
  return {
    commandKey: input.command.commandKey,
    commandIntent: renewalFollowUpIntent(input.command),
    renewalId: input.command.renewalId,
    studentId: input.command.studentId,
    ...(input.command.packageId ? { packageId: input.command.packageId } : {}),
    businessStatus: input.command.businessStatus,
    result: input.command.result,
    attemptedAt: input.command.attemptedAt,
    note: input.command.note,
    renewalDateNote: input.command.renewalDateNote,
    expectedVersions: input.command.expectedVersions,
    ...(input.command.attachment ? { attachment: input.command.attachment } : {}),
  };
}

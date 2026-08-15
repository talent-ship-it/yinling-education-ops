import "server-only";

import type {
  ImportedStudentRecord,
  JwbStudentImportRow,
  MasterStudentDuplicateResolution,
  MasterStudentImportRow,
} from "@/lib/student-import";
import type {
  ImportedTeacherRecord,
  TeacherHardResolutionDecision,
  TeacherIdentityLink,
  TeacherWorkbookKind,
  TeacherWorkbookSnapshot,
} from "@/lib/teacher-import";
import type {
  LessonAttendanceEvidence,
  LessonOccurrenceSettlementResult,
} from "@/lib/lesson-occurrences";
import type { AvailabilitySlotInput, TeacherAvailabilityWindow } from "@/lib/teacher-availability";

export type OpsStateRow = {
  entity: string;
  payload: unknown;
  version: number;
  updated_at: string;
  updated_by: string;
};

export type OpsVersionRow = Omit<OpsStateRow, "payload">;

export type OpsSourceRow = {
  source_id: string;
  title: string;
  source_type: string;
  url: string | null;
  modified_at: string | null;
  synced_at: string;
  row_count: number;
  status: string;
  payload: unknown;
};

export type FuAttachmentRow = {
  id: string;
  student_id: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  uploaded_by: string;
  uploaded_at: string;
  content_base64?: string;
};

export type StudentFuAttachmentAtomicCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  attachment: FuAttachmentRow;
  files_row: OpsStateRow;
  students_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type StudentFuAttachmentReferenceSnapshot = Readonly<{
  studentIds: readonly string[];
  fingerprint: string;
}>;

export type TeacherAvailabilitySubmissionRow = Readonly<{
  id: number;
  teacher_id: string;
  teacher_name: string;
  submission_month: string;
  availability_timezone: string;
  current_city: string | null;
  additional_students: number;
  availability_slots: readonly AvailabilitySlotInput[] | unknown;
  notes: string | null;
  status: "pending" | "approved" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
}>;

export type TeacherAvailabilityReviewCommitResult = Readonly<{
  submission_id: number;
  status: "approved" | "rejected";
  teacher_version: number;
  reviewed_at: string;
  reviewed_by: string;
  audit_entry_id: string;
}>;

export type TeacherAvailabilitySubmitCommitResult = Readonly<{
  submission_key: string;
  submission_id: number;
  teacher_id: string;
  status: "pending" | "approved" | "rejected";
  applied: boolean;
  submitted_at: string;
  audit_entry_id: string;
}>;

/**
 * Contract for a future reviewed RPC over the server-owned source_rows table.
 * Revisions are opaque database values and are carried into the atomic commit.
 */
export type StudentImportSourceRowsSnapshot = Readonly<{
  master: Readonly<{
    sourceId: string;
    revision: string;
    rows: readonly MasterStudentImportRow[];
  }>;
  jwb: Readonly<{
    sourceId: string;
    revision: string;
    rows: readonly JwbStudentImportRow[];
  }>;
  identityLinks: readonly Readonly<{
    masterSourceRow: string | number;
    jwbSourceRow?: string | number;
    studentId: string;
  }>[];
  identityLinkFingerprint: string;
  /** Monotonic revocation generation for opaque identity-review options. */
  identityReviewEpoch: number;
  masterDuplicateResolutions: readonly MasterStudentDuplicateResolution[];
  masterDuplicateResolutionFingerprint: string;
  fuAttachmentReferences: StudentFuAttachmentReferenceSnapshot;
}>;

export type StudentImportCommitResult = Readonly<{
  entity: "students";
  version: number;
  updated_at: string;
  updated_by: string;
}>;

export type StudentImportSourceIngestResult = Readonly<{
  sourceKind: "master" | "jwb";
  sourceId: string;
  revision: string;
  rowCount: number;
  unchanged: boolean;
}>;

export type StudentImportIdentityLinkSaveResult = Readonly<{
  fingerprint: string;
  count: number;
  unchanged: boolean;
}>;

export type StudentImportIdentityReviewSaveResult = StudentImportIdentityLinkSaveResult & Readonly<{
  resolutionKey: string;
  decision: "merge" | "create";
}>;

export type StudentImportIdentityClearResult = StudentImportIdentityLinkSaveResult & Readonly<{
  reviewEpoch: number;
}>;

export type StudentImportIdentityBulkReviewPreview = Readonly<{
  confirmationKey: string;
  mergeCandidateCount: number;
  pendingMergeCount: number;
  alreadyLinkedMergeCount: number;
  currentLinkCount: number;
  resultingLinkCount: number;
  canSubmit: boolean;
}>;

export type StudentImportIdentityBulkReviewResult = Readonly<{
  confirmationKey: string;
  fingerprint: string;
  count: number;
  requestedCount: number;
  newlyAppliedCount: number;
  alreadyAppliedCount: number;
  finalCount: number;
  unchanged: boolean;
}>;

export type StudentImportIdentityBulkCreateReviewPreview = Readonly<{
  confirmationKey: string;
  createCandidateCount: number;
  pendingCreateCount: number;
  alreadyLinkedCreateCount: number;
  currentLinkCount: number;
  resultingLinkCount: number;
  canSubmit: boolean;
}>;

export type StudentImportIdentityBulkCreateReviewResult = Readonly<{
  confirmationKey: string;
  fingerprint: string;
  count: number;
  requestedCount: number;
  newlyAppliedCount: number;
  alreadyAppliedCount: number;
  finalCount: number;
  unchanged: boolean;
}>;

export type StudentImportMasterDuplicateResolutionSaveResult = Readonly<{
  resolutionKey: string;
  decision: "select" | "ignore";
  fingerprint: string;
  unchanged: boolean;
}>;

export type TeacherImportSourceSnapshot = Readonly<Record<
  TeacherWorkbookKind,
  TeacherWorkbookSnapshot
>> & Readonly<{
  identityLinks: readonly TeacherIdentityLink[];
  hardResolutions: readonly TeacherHardResolutionDecision[];
}>;

export type TeacherImportSourceIngestResult = Readonly<{
  workbook: TeacherWorkbookKind;
  sourceId: string;
  revision: string;
  rosterRowCount: number;
  subjectRowCount: number;
  unchanged: boolean;
}>;

export type TeacherImportCommitResult = Readonly<{
  entity: "teachers";
  version: number;
  updated_at: string;
  updated_by: string;
  applied: boolean;
}>;

export type TeacherIdentityLinkSaveResult = Readonly<{
  resolutionKey: string;
  decision: "merge" | "separate" | "assign" | "ignore";
  unchanged: boolean;
}>;

export const STUDENT_IMPORT_SOURCE_ROWS_RPC = "get_latest_student_import_source_rows";
export const STUDENT_IMPORT_SOURCE_INGEST_RPC = "put_student_import_source_rows";
export const STUDENT_IMPORT_ATOMIC_COMMIT_RPC = "commit_student_import_plan_atomic";
export const STUDENT_IMPORT_COMMIT_REPLAY_RESULT_RPC = "get_student_import_commit_replay_result";
export const STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC = "put_student_import_identity_review_decision";
export const STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC = "put_student_import_identity_review_pair";
export const STUDENT_IMPORT_IDENTITY_CLEAR_RPC = "clear_student_import_identity_links";
export const STUDENT_IMPORT_IDENTITY_REVIEW_CONTRACT_RPC = "get_student_import_identity_review_contract";
export const STUDENT_IMPORT_IDENTITY_BULK_PREVIEW_RPC = "get_student_import_identity_bulk_review_preview";
export const STUDENT_IMPORT_IDENTITY_BULK_PUT_RPC = "put_student_import_identity_bulk_review";
export const STUDENT_IMPORT_IDENTITY_BULK_CREATE_PREVIEW_RPC = "get_student_import_identity_bulk_create_review_preview";
export const STUDENT_IMPORT_IDENTITY_BULK_CREATE_PUT_RPC = "put_student_import_identity_bulk_create_review";
export const STUDENT_IMPORT_MASTER_DUPLICATE_RESOLUTION_PUT_RPC = "put_student_import_master_duplicate_resolution";
export const TEACHER_IMPORT_SOURCE_RPC = "get_latest_teacher_import_sources";
export const TEACHER_IMPORT_SOURCE_INGEST_RPC = "put_teacher_import_source";
export const TEACHER_IMPORT_ATOMIC_COMMIT_RPC = "commit_teacher_import_plan_atomic";
export const TEACHER_IDENTITY_LINK_PUT_RPC = "put_teacher_import_identity_link";
export const TEACHER_HARD_RESOLUTION_PUT_RPC = "put_teacher_import_hard_resolution";
export const LESSON_ATTENDANCE_EVIDENCE_PUT_RPC = "put_lesson_attendance_evidence";
export const LESSON_ATTENDANCE_EVIDENCE_RPC = "get_lesson_attendance_evidence";
export const LESSON_OCCURRENCE_ATOMIC_COMPLETE_RPC = "complete_lesson_occurrence_atomic";
export const TEACHER_AVAILABILITY_SUBMISSIONS_RPC = "get_teacher_availability_submissions";
export const TEACHER_AVAILABILITY_ATOMIC_REVIEW_RPC = "review_teacher_availability_submission_atomic";
export const TEACHER_AVAILABILITY_ATOMIC_SUBMIT_RPC = "submit_teacher_availability_atomic";
export const BOOKING_CAPACITY_ATOMIC_MUTATION_RPC = "mutate_booking_capacity_atomic";
export const OPERATION_CONFIRM_ATOMIC_RPC = "confirm_operation_occurrences_atomic";
export const BOOKING_CAPACITY_COMMAND_RESULT_RPC = "get_booking_capacity_command_result";
export const OPERATION_CONFIRM_COMMAND_RESULT_RPC = "get_operation_confirmation_command_result";
export const PERMANENT_TEACHER_REPLACEMENT_ATOMIC_RPC = "confirm_permanent_teacher_replacement_atomic";
export const PERMANENT_TEACHER_REPLACEMENT_COMMAND_RESULT_RPC = "get_permanent_teacher_replacement_command_result";
export const TEACHER_DEPARTURE_CREATION_ATOMIC_RPC = "create_teacher_departure_atomic";
export const TEACHER_DEPARTURE_CREATION_COMMAND_RESULT_RPC = "get_teacher_departure_creation_command_result";
export const EXAM_SUBMISSION_ATOMIC_RPC = "submit_exam_atomic";
export const EXAM_SUBMISSION_COMMAND_RESULT_RPC = "get_exam_submission_command_result";
export const EXAM_FOLLOW_UP_ATOMIC_RPC = "mutate_exam_follow_up_atomic";
export const EXAM_FOLLOW_UP_COMMAND_RESULT_RPC = "get_exam_follow_up_command_result";
export const EXAM_FOLLOW_UP_COMPLETION_CONTEXT_RPC = "get_exam_follow_up_completion_context";
export const STUDENT_FU_ATTACHMENT_ATOMIC_PUT_RPC = "put_student_fu_attachment_atomic";

export class OpsStoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

function configuration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.OPS_API_SECRET;

  if (!url || !publishableKey || !secret) {
    throw new OpsStoreError("Supabase 共享数据环境变量尚未配置。", "missing_configuration");
  }

  return { url: url.replace(/\/$/, ""), publishableKey, secret };
}

async function rpc<T>(name: string, body: Record<string, unknown>) {
  const { url, publishableKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload as { message?: string; code?: string; details?: string } | null;
    throw new OpsStoreError(error?.message || "Supabase 请求失败。", error?.code, error?.details);
  }

  return payload as T;
}

export function getOpsState(entities?: string[]) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>("get_ops_state", {
    p_secret: secret,
    p_entities: entities?.length ? entities : null,
  });
}

export function getOpsVersions() {
  const { secret } = configuration();
  return rpc<OpsVersionRow[]>("get_ops_versions", { p_secret: secret });
}

export function getOpsSources() {
  const { secret } = configuration();
  return rpc<OpsSourceRow[]>("get_ops_sources", { p_secret: secret });
}

export function getTeacherAvailabilitySubmissions() {
  const { secret } = configuration();
  return rpc<TeacherAvailabilitySubmissionRow[]>(TEACHER_AVAILABILITY_SUBMISSIONS_RPC, {
    p_secret: secret,
  });
}

export function submitTeacherAvailabilityAtomic(input: {
  submissionKey: string;
  expectedTeacherVersion: number;
  teacherId: string;
  month: string;
  timezone: string;
  additionalStudents: number;
  slots: readonly Readonly<{ day: number; start: string; end: string }>[];
  notes?: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherAvailabilitySubmitCommitResult[]>(TEACHER_AVAILABILITY_ATOMIC_SUBMIT_RPC, {
    p_secret: secret,
    p_submission_key: input.submissionKey,
    p_expected_teacher_version: input.expectedTeacherVersion,
    p_teacher_id: input.teacherId,
    p_month: input.month,
    p_timezone: input.timezone,
    p_additional_students: input.additionalStudents,
    p_slots: input.slots,
    p_notes: input.notes ?? null,
    p_actor: input.actor,
  });
}

/**
 * Applies one review transaction. `availabilityWindows` must be computed from
 * the server-read submission and teacher state, never accepted from a client.
 */
export function reviewTeacherAvailabilitySubmissionAtomic(input: {
  submissionId: number;
  decision: "approved" | "rejected";
  expectedSubmissionStatus: "pending";
  expectedTeacherVersion: number;
  availabilityWindows: readonly TeacherAvailabilityWindow[] | null;
  actor: string;
  reviewNote?: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherAvailabilityReviewCommitResult[]>(TEACHER_AVAILABILITY_ATOMIC_REVIEW_RPC, {
    p_secret: secret,
    p_submission_id: input.submissionId,
    p_decision: input.decision,
    p_expected_submission_status: input.expectedSubmissionStatus,
    p_expected_teacher_version: input.expectedTeacherVersion,
    p_availability_windows: input.availabilityWindows,
    p_actor: input.actor,
    p_review_note: input.reviewNote ?? null,
  });
}

/**
 * Reads the latest master-list and JWB row sets in one database snapshot.
 * The RPC is intentionally only a contract until a separately reviewed
 * migration is created and applied.
 */
export function getLatestStudentImportSourceRows() {
  const { secret } = configuration();
  return rpc<StudentImportSourceRowsSnapshot>(STUDENT_IMPORT_SOURCE_ROWS_RPC, {
    p_secret: secret,
  });
}

/** Fails closed when the complete identity-review migration is not deployed. */
export function getStudentImportIdentityReviewContract() {
  const { secret } = configuration();
  return rpc<Readonly<{ contractVersion: number }>>(
    STUDENT_IMPORT_IDENTITY_REVIEW_CONTRACT_RPC,
    { p_secret: secret },
  );
}

/** Server-only HMAC key used to mint non-forgeable manual-review row tokens. */
export function getStudentImportIdentityReviewTokenSecret() {
  const secret = process.env.STUDENT_IMPORT_IDENTITY_REVIEW_TOKEN_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new OpsStoreError(
      "学生身份人工审核 HMAC 密钥尚未配置为独立的 256-bit 十六进制值。",
      "missing_configuration",
    );
  }
  return secret;
}

/** Stores exactly one explicitly identified source snapshot for later dry-run. */
export function putStudentImportSourceRows(input: {
  sourceKind: "master" | "jwb";
  sourceId: string;
  revision: string;
  rows: readonly MasterStudentImportRow[] | readonly JwbStudentImportRow[];
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportSourceIngestResult>(STUDENT_IMPORT_SOURCE_INGEST_RPC, {
    p_secret: secret,
    p_source_kind: input.sourceKind,
    p_source_id: input.sourceId,
    p_revision: input.revision,
    p_rows: input.rows,
    p_actor: input.actor,
  });
}

/**
 * Persists one opaque reviewed option. Source references and target student
 * IDs are deliberately absent: the database recomputes them while holding
 * the source, students and identity-set locks.
 */
export function putStudentImportIdentityReviewDecision(input: {
  resolutionKey: string;
  decision: "merge" | "create";
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportIdentityReviewSaveResult>(STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC, {
    p_secret: secret,
    p_resolution_key: input.resolutionKey,
    p_decision: input.decision,
    p_actor: input.actor,
  });
}

/**
 * Persists one explicit manual pairing using only revision/epoch-bound opaque
 * row tokens. The database resolves every source row and target identity
 * again under locks and never accepts a browser-provided row reference or ID.
 */
export function putStudentImportIdentityReviewPair(input: {
  masterToken: string;
  jwbToken: string;
  decision: "merge" | "create";
  existingToken?: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportIdentityReviewSaveResult>(STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC, {
    p_secret: secret,
    p_token_secret: getStudentImportIdentityReviewTokenSecret(),
    p_master_token: input.masterToken,
    p_jwb_token: input.jwbToken,
    p_decision: input.decision,
    p_existing_token: input.existingToken ?? null,
    p_actor: input.actor,
  });
}

/** Revokes the exact currently displayed link set using a DB-recomputed opaque CAS key. */
export function clearStudentImportIdentityLinks(input: {
  resolutionKey: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportIdentityClearResult>(STUDENT_IMPORT_IDENTITY_CLEAR_RPC, {
    p_secret: secret,
    p_resolution_key: input.resolutionKey,
    p_actor: input.actor,
  });
}

/**
 * Returns counts and one opaque CAS key for the complete current set of
 * exact, unique-Han, existing-student merge candidates. No row reference,
 * name, student ID or revision crosses this server-only boundary.
 */
export function getStudentImportIdentityBulkReviewPreview() {
  const { secret } = configuration();
  return rpc<StudentImportIdentityBulkReviewPreview>(
    STUDENT_IMPORT_IDENTITY_BULK_PREVIEW_RPC,
    { p_secret: secret },
  );
}

/** Atomically persists the DB-recomputed merge-only candidate set. */
export function putStudentImportIdentityBulkReview(input: {
  confirmationKey: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportIdentityBulkReviewResult>(STUDENT_IMPORT_IDENTITY_BULK_PUT_RPC, {
    p_secret: secret,
    p_confirmation_key: input.confirmationKey,
    p_actor: input.actor,
  });
}

/**
 * Returns counts and one opaque CAS key for the complete current set of
 * exact, unique-Han, required create-only candidates. No row reference,
 * name, student ID or revision crosses this server-only boundary.
 */
export function getStudentImportIdentityBulkCreateReviewPreview() {
  const { secret } = configuration();
  return rpc<StudentImportIdentityBulkCreateReviewPreview>(
    STUDENT_IMPORT_IDENTITY_BULK_CREATE_PREVIEW_RPC,
    { p_secret: secret },
  );
}

/** Atomically persists the DB-recomputed create-only candidate set. */
export function putStudentImportIdentityBulkCreateReview(input: {
  confirmationKey: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportIdentityBulkCreateReviewResult>(
    STUDENT_IMPORT_IDENTITY_BULK_CREATE_PUT_RPC,
    {
      p_secret: secret,
      p_confirmation_key: input.confirmationKey,
      p_actor: input.actor,
    },
  );
}

/**
 * Recovers only a previously committed result after an HTTP response was
 * lost. The database accepts no rows or source references and revalidates the
 * locked current state against its immutable commit record.
 */
export function getStudentImportCommitReplayResult(input: {
  planFingerprint: string;
  expectedStudentVersion: number;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportCommitResult[]>(STUDENT_IMPORT_COMMIT_REPLAY_RESULT_RPC, {
    p_secret: secret,
    p_plan_fingerprint: input.planFingerprint,
    p_expected_student_version: input.expectedStudentVersion,
    p_actor: input.actor,
  });
}

/** Saves one opaque hard option after the database recomputes its exact current duplicate group. */
export function putStudentImportMasterDuplicateResolution(input: {
  resolutionKey: string;
  decision: "select" | "ignore";
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportMasterDuplicateResolutionSaveResult>(
    STUDENT_IMPORT_MASTER_DUPLICATE_RESOLUTION_PUT_RPC,
    {
      p_secret: secret,
      p_resolution_key: input.resolutionKey,
      p_decision: input.decision,
      p_actor: input.actor,
    },
  );
}

/**
 * Commits the server-computed replacement in one database transaction. Never
 * replace this with repeated putOpsState calls: the expected version and both
 * source revisions must be checked while the students row is locked.
 */
export function commitStudentImportPlanAtomic(input: {
  planFingerprint: string;
  expectedStudentVersion: number;
  sourceRevisions: Readonly<{
    master: string;
    jwb: string;
    identityLinks: string;
    masterDuplicateResolutions: string;
    fuAttachments: string;
    bookingsVersion: number;
  }>;
  students: readonly ImportedStudentRecord[];
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportCommitResult[]>(STUDENT_IMPORT_ATOMIC_COMMIT_RPC, {
    p_secret: secret,
    p_plan_fingerprint: input.planFingerprint,
    p_expected_student_version: input.expectedStudentVersion,
    p_source_revisions: input.sourceRevisions,
    p_students: input.students,
    p_actor: input.actor,
  });
}

/** Reads both teacher workbooks from one server-owned database snapshot. */
export function getLatestTeacherImportSources() {
  const { secret } = configuration();
  return rpc<TeacherImportSourceSnapshot>(TEACHER_IMPORT_SOURCE_RPC, {
    p_secret: secret,
  });
}

/** Saves only a server-computed resolution key; source refs never come from the browser. */
export function putTeacherImportIdentityLink(input: { resolutionKey: string; decision: "merge" | "separate"; actor: string }) {
  const { secret } = configuration();
  return rpc<TeacherIdentityLinkSaveResult>(TEACHER_IDENTITY_LINK_PUT_RPC, {
    p_secret: secret,
    p_resolution_key: input.resolutionKey,
    p_decision: input.decision,
    p_actor: input.actor,
  });
}

/**
 * Saves one opaque choice after the database resolves it against both current
 * workbook revisions. Names, rows and assignment targets never cross the
 * browser/server trust boundary as client-selected fields.
 */
export function putTeacherImportHardResolution(input: {
  resolutionKey: string;
  decision: "merge" | "separate" | "assign" | "ignore";
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherIdentityLinkSaveResult>(TEACHER_HARD_RESOLUTION_PUT_RPC, {
    p_secret: secret,
    p_resolution_key: input.resolutionKey,
    p_decision: input.decision,
    p_actor: input.actor,
  });
}

/** Stores exactly one explicitly identified teacher workbook snapshot. */
export function putTeacherImportSource(input: TeacherWorkbookSnapshot & { actor: string }) {
  const { secret } = configuration();
  return rpc<TeacherImportSourceIngestResult>(TEACHER_IMPORT_SOURCE_INGEST_RPC, {
    p_secret: secret,
    p_workbook: input.workbook,
    p_source_id: input.sourceId,
    p_revision: input.revision,
    p_sheet_names: input.sheetNames,
    p_roster_rows: input.rosterRows,
    p_subject_rows: input.subjectRows,
    p_actor: input.actor,
  });
}

/** Atomically replaces teachers after locking both source revisions and state. */
export function commitTeacherImportPlanAtomic(input: {
  planFingerprint: string;
  expectedTeacherVersion: number;
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
  teachers: readonly ImportedTeacherRecord[];
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherImportCommitResult[]>(TEACHER_IMPORT_ATOMIC_COMMIT_RPC, {
    p_secret: secret,
    p_plan_fingerprint: input.planFingerprint,
    p_expected_teacher_version: input.expectedTeacherVersion,
    p_source_revisions: input.sourceRevisions,
    p_teachers: input.teachers,
    p_actor: input.actor,
  });
}

export type LessonAttendanceEvidenceRecord = Readonly<{
  reference: string;
  occurrenceId: string;
  capturedAt: string;
  evidence: LessonAttendanceEvidence;
}>;

export type LessonOccurrenceCommitResult = Readonly<{
  occurrence_id: string;
  idempotency_key: string;
  applied: boolean;
  disposition: Extract<LessonOccurrenceSettlementResult["disposition"], "completed" | "abnormal">;
  version: number;
  audit_entry_id?: string;
}>;

export type BookingCapacityCommitResult = Readonly<{
  command_key: string;
  action: "create" | "update" | "delete";
  applied: boolean;
  booking_id: string;
  bookings_row: OpsStateRow;
  teachers_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type OperationConfirmationCommitResult = Readonly<{
  command_key: string;
  operation_id: string;
  action: "leave" | "substitute" | "confirm_only";
  applied: boolean;
  affected_occurrence_ids: readonly string[];
  bookings_row: OpsStateRow;
  operations_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type BookingCapacityCommandResult = Readonly<{
  command_key: string;
  action: "create" | "update" | "delete";
  booking_id: string;
  audit_entry_id: string;
}>;

export type OperationConfirmationCommandResult = Readonly<{
  command_key: string;
  operation_id: string;
  action: "leave" | "substitute" | "confirm_only";
  affected_occurrence_ids: readonly string[];
  audit_entry_id: string;
}>;

export type PermanentTeacherReplacementCommitResult = Readonly<{
  command_key: string;
  operation_id: string;
  applied: boolean;
  affected_occurrence_ids: readonly string[];
  changed_teacher_ids: readonly string[];
  bookings_row: OpsStateRow;
  operations_row: OpsStateRow;
  teachers_row: OpsStateRow;
  students_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type PermanentTeacherReplacementCommandResult = Readonly<{
  command_key: string;
  operation_id: string;
  affected_occurrence_ids: readonly string[];
  changed_teacher_ids: readonly string[];
  audit_entry_id: string;
}>;

export type TeacherDepartureCreationCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  source_teacher_id: string;
  effective_date: string;
  operation_ids: readonly string[];
  affected_student_ids: readonly string[];
  operations_row: OpsStateRow;
  tasks_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TeacherDepartureCreationCommandResult = Readonly<{
  command_key: string;
  source_teacher_id: string;
  effective_date: string;
  operation_ids: readonly string[];
  affected_student_ids: readonly string[];
  audit_entry_id: string;
}>;

export type ExamSubmissionCommitResult = Readonly<{
  command_key: string;
  action: "create" | "update";
  applied: boolean;
  student_id: string;
  exam_id: string;
  students_row: OpsStateRow;
  tasks_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type ExamSubmissionCommandResult = Readonly<{
  command_key: string;
  action: "create" | "update";
  student_id: string;
  exam_id: string;
  audit_entry_id: string;
}>;

export type ExamFollowUpCommitResult = Readonly<{
  command_key: string;
  action: "complete" | "undo";
  applied: boolean;
  task_id: string;
  student_id: string;
  exam_id: string;
  follow_up_kind: "exam_care" | "exam_recall" | "exam_results_follow_up";
  completion_command_key: string;
  students_row: OpsStateRow;
  tasks_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type ExamFollowUpCommandResult = Readonly<{
  command_key: string;
  action: "complete" | "undo";
  task_id: string;
  student_id: string;
  exam_id: string;
  follow_up_kind: "exam_care" | "exam_recall" | "exam_results_follow_up";
  completion_command_key: string;
  audit_entry_id: string;
}>;

export type ExamFollowUpCompletionContextResult = Readonly<{
  command_key: string;
  task_id: string;
  student_id: string;
  exam_id: string;
  follow_up_kind: "exam_care" | "exam_recall" | "exam_results_follow_up";
  prior_task: Record<string, unknown>;
  prior_follow_up_state_exists: boolean;
  prior_follow_up_state: Record<string, unknown> | null;
  committed_task: Record<string, unknown>;
  committed_follow_up_state: Record<string, unknown>;
}>;

export function getBookingCapacityCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<BookingCapacityCommandResult[]>(BOOKING_CAPACITY_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

export function getOperationConfirmationCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<OperationConfirmationCommandResult[]>(OPERATION_CONFIRM_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

export function getPermanentTeacherReplacementCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<PermanentTeacherReplacementCommandResult[]>(PERMANENT_TEACHER_REPLACEMENT_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

export function getTeacherDepartureCreationCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherDepartureCreationCommandResult[]>(TEACHER_DEPARTURE_CREATION_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

export function getExamSubmissionCommandResult(input: {
  commandKey: string;
  commandIntent: unknown;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<ExamSubmissionCommandResult[]>(EXAM_SUBMISSION_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

export function getExamFollowUpCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<ExamFollowUpCommandResult[]>(EXAM_FOLLOW_UP_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

export function getExamFollowUpCompletionContext(input: {
  completionCommandKey: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<ExamFollowUpCompletionContextResult[]>(EXAM_FOLLOW_UP_COMPLETION_CONTEXT_RPC, {
    p_secret: secret,
    p_completion_command_key: input.completionCommandKey,
    p_actor: input.actor,
  });
}

/** Stores immutable provider evidence. Duplicate references must be byte-equivalent. */
export function putLessonAttendanceEvidence(input: {
  reference: string;
  occurrenceId: string;
  capturedAt: string;
  evidence: LessonAttendanceEvidence;
  provider: "bbb" | "zoom" | "classin" | "voov" | "manual_import";
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<LessonAttendanceEvidenceRecord>(LESSON_ATTENDANCE_EVIDENCE_PUT_RPC, {
    p_secret: secret,
    p_reference: input.reference,
    p_occurrence_id: input.occurrenceId,
    p_captured_at: input.capturedAt,
    p_evidence: input.evidence,
    p_provider: input.provider,
    p_actor: input.actor,
  });
}

/** Reads provider evidence by opaque reference; raw evidence is never accepted from the browser. */
export function getLessonAttendanceEvidence(input: { reference: string; occurrenceId: string }) {
  const { secret } = configuration();
  return rpc<LessonAttendanceEvidenceRecord | null>(LESSON_ATTENDANCE_EVIDENCE_RPC, {
    p_secret: secret,
    p_reference: input.reference,
    p_occurrence_id: input.occurrenceId,
  });
}

/** One transaction must verify versions, deduct hours, credit payroll and append any override audit. */
export function completeLessonOccurrenceAtomic(input: {
  occurrenceId: string;
  expectedVersion: number;
  stateVersions: Readonly<Record<string, number>>;
  idempotencyKey: string;
  settlement: LessonOccurrenceSettlementResult;
  attendanceReference?: string;
  overrideReason?: string;
  actor: string;
  callbackNonceSha256?: string;
}) {
  const { secret } = configuration();
  return rpc<LessonOccurrenceCommitResult[]>(LESSON_OCCURRENCE_ATOMIC_COMPLETE_RPC, {
    p_secret: secret,
    p_occurrence_id: input.occurrenceId,
    p_expected_version: input.expectedVersion,
    p_state_versions: input.stateVersions,
    p_idempotency_key: input.idempotencyKey,
    p_settlement: input.settlement,
    p_attendance_reference: input.attendanceReference ?? null,
    p_override_reason: input.overrideReason ?? null,
    p_actor: input.actor,
    p_callback_nonce_sha256: input.callbackNonceSha256 ?? null,
  });
}

/** Atomically writes the already server-validated booking/capacity transition. */
export function mutateBookingCapacityAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  action: "create" | "update" | "delete";
  bookingId: string;
  expectedVersions: Readonly<{ bookings: number; students: number; teachers: number }>;
  bookings: readonly Record<string, unknown>[];
  teachers: readonly Record<string, unknown>[];
  changedTeacherIds: readonly string[];
  studentId: string;
  teacherId: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<BookingCapacityCommitResult[]>(BOOKING_CAPACITY_ATOMIC_MUTATION_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_action: input.action,
    p_booking_id: input.bookingId,
    p_expected_versions: input.expectedVersions,
    p_bookings: input.bookings,
    p_teachers: input.teachers,
    p_changed_teacher_ids: input.changedTeacherIds,
    p_student_id: input.studentId,
    p_teacher_id: input.teacherId,
    p_actor: input.actor,
  });
}

/** Locks bookings, operations and teachers and commits one exact occurrence transition. */
export function confirmOperationOccurrencesAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  operationId: string;
  action: "leave" | "substitute" | "confirm_only";
  chosenTeacherId?: string;
  expectedVersions: Readonly<{ bookings: number; operations: number; teachers: number }>;
  bookings: readonly Record<string, unknown>[];
  operations: readonly Record<string, unknown>[];
  affectedOccurrenceIds: readonly string[];
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<OperationConfirmationCommitResult[]>(OPERATION_CONFIRM_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_operation_id: input.operationId,
    p_action: input.action,
    p_chosen_teacher_id: input.chosenTeacherId ?? null,
    p_expected_versions: input.expectedVersions,
    p_bookings: input.bookings,
    p_operations: input.operations,
    p_affected_occurrence_ids: input.affectedOccurrenceIds,
    p_actor: input.actor,
  });
}

/** Atomically commits the four authoritative projections of one permanent handover. */
export function confirmPermanentTeacherReplacementAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  operationId: string;
  studentId: string;
  sourceTeacherId: string;
  replacementTeacherId: string;
  effectiveDate: string;
  expectedVersions: Readonly<{ bookings: number; operations: number; teachers: number; students: number }>;
  bookings: readonly Record<string, unknown>[];
  operations: readonly Record<string, unknown>[];
  teachers: readonly Record<string, unknown>[];
  students: readonly Record<string, unknown>[];
  affectedOccurrenceIds: readonly string[];
  changedTeacherIds: readonly string[];
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<PermanentTeacherReplacementCommitResult[]>(PERMANENT_TEACHER_REPLACEMENT_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_operation_id: input.operationId,
    p_student_id: input.studentId,
    p_source_teacher_id: input.sourceTeacherId,
    p_replacement_teacher_id: input.replacementTeacherId,
    p_effective_date: input.effectiveDate,
    p_expected_versions: input.expectedVersions,
    p_bookings: input.bookings,
    p_operations: input.operations,
    p_teachers: input.teachers,
    p_students: input.students,
    p_affected_occurrence_ids: input.affectedOccurrenceIds,
    p_changed_teacher_ids: input.changedTeacherIds,
    p_actor: input.actor,
  });
}

/** Locks all five departure inputs and atomically inserts the derived operations/tasks. */
export function createTeacherDepartureAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  sourceTeacherId: string;
  effectiveDate: string;
  detail: string;
  expectedVersions: Readonly<{
    bookings: number;
    operations: number;
    students: number;
    tasks: number;
    teachers: number;
  }>;
  operations: readonly Record<string, unknown>[];
  tasks: readonly Record<string, unknown>[];
  affectedGroups: readonly Readonly<{
    studentId: string;
    operationId: string;
    affectedOccurrenceIds: readonly string[];
    candidateTeacherIds: readonly string[];
  }>[];
  submittedAt: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherDepartureCreationCommitResult[]>(TEACHER_DEPARTURE_CREATION_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_source_teacher_id: input.sourceTeacherId,
    p_effective_date: input.effectiveDate,
    p_detail: input.detail,
    p_expected_versions: input.expectedVersions,
    p_operations: input.operations,
    p_tasks: input.tasks,
    p_affected_groups: input.affectedGroups,
    p_submitted_at: input.submittedAt,
    p_actor: input.actor,
  });
}

/** Atomically stores one student exam and its complete managed reminder set. */
export function submitExamAtomic(input: {
  commandKey: string;
  commandIntent: unknown;
  studentId: string;
  examId: string;
  action: "create" | "update";
  expectedVersions: Readonly<{ students: number; tasks: number }>;
  students: readonly Record<string, unknown>[];
  tasks: readonly Record<string, unknown>[];
  preparedAt: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<ExamSubmissionCommitResult[]>(EXAM_SUBMISSION_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_student_id: input.studentId,
    p_exam_id: input.examId,
    p_action: input.action,
    p_expected_versions: input.expectedVersions,
    p_students: input.students,
    p_tasks: input.tasks,
    p_prepared_at: input.preparedAt,
    p_actor: input.actor,
  });
}

/** Atomically completes or restores one managed exam reminder and exam step. */
export function mutateExamFollowUpAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  action: "complete" | "undo";
  expectedVersions: Readonly<{ students: number; tasks: number }>;
  students: readonly Record<string, unknown>[];
  tasks: readonly Record<string, unknown>[];
  preparedAt: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<ExamFollowUpCommitResult[]>(EXAM_FOLLOW_UP_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_action: input.action,
    p_expected_versions: input.expectedVersions,
    p_students: input.students,
    p_tasks: input.tasks,
    p_prepared_at: input.preparedAt,
    p_actor: input.actor,
  });
}

export function putOpsState(input: {
  entity: string;
  payload: unknown;
  expectedVersion: number;
  actor: string;
  scopeVersions?: Record<string, number> | null;
}) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>("put_scoped_ops_state", {
    p_secret: secret,
    p_entity: input.entity,
    p_payload: input.payload,
    p_expected_version: input.expectedVersion,
    p_actor: input.actor,
    p_scope_versions: input.scopeVersions ?? null,
  });
}

/** Atomically stores attachment bytes and updates the canonical file/student indexes. */
export function putStudentFuAttachmentAtomic(input: {
  commandKey: string;
  studentId: string;
  fileName: string;
  contentType: string;
  contentBase64: string;
  fileTitle: string;
  fileType: "Report 资料" | "FU" | "续课 FU";
  fuCategory?: string;
  expectedVersions: Readonly<{ files: number; students: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentFuAttachmentAtomicCommitResult[]>(STUDENT_FU_ATTACHMENT_ATOMIC_PUT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_student_id: input.studentId,
    p_file_name: input.fileName,
    p_content_type: input.contentType,
    p_content_base64: input.contentBase64,
    p_file_title: input.fileTitle,
    p_file_type: input.fileType,
    p_fu_category: input.fuCategory ?? null,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
  });
}

export function getStudentFuAttachment(id: string) {
  const { secret } = configuration();
  return rpc<FuAttachmentRow>("get_student_fu_attachment", {
    p_secret: secret,
    p_id: id,
  });
}

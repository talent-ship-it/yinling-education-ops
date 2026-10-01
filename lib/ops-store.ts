import "server-only";

import {
  resolveOpsRpcTiming,
  type OpsRpcBudgetOptions,
} from "@/lib/ops-rpc-budget";

import type {
  ImportedStudentRecord,
  JwbStudentImportRow,
  MasterStudentDuplicateResolution,
  MasterStudentImportRow,
  StudentImportIdentityMatchStrategy,
  StudentNumberReservation,
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

export type OperationalAuditRecord = Readonly<{
  id: string;
  action: string;
  actor: string;
  target_type: string;
  target_id: string;
  created_at: string;
}>;

export type TencentTrialLedgerSyncClaim = Readonly<{
  lease_token: string;
  events: readonly Readonly<{
    eventId: string;
    entity: "students" | "lpItems";
    entityVersion: number;
    attempt: number;
  }>[];
  source_versions: Readonly<{ students: number; lpItems: number }>;
  state_rows: readonly OpsStateRow[];
  mappings: readonly Readonly<{
    lpItemId: string;
    recordId: string;
    payloadSha256: string;
  }>[];
  attempt_count: number;
}>;

export type TencentTrialLedgerSyncStatus = Readonly<{
  pending_count: number;
  failed_count: number;
  dead_count: number;
  active_lease_expires_at: string | null;
  last_synced_at: string | null;
  last_payload_sha256: string | null;
  last_record_count: number | null;
}>;

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

export type WecomArchiveIngestResult = Readonly<{
  inserted: number;
  duplicates: number;
  linked: number;
  ambiguous: number;
  pending: number;
  projectedFiles: number;
}>;

export type WecomBotIngestResult = Readonly<{
  inserted: number;
  duplicates: number;
  promoted: number;
  linked: number;
  ambiguous: number;
  pending: number;
  projectedFiles: number;
}>;

export type WecomArchiveInboxRow = Readonly<{
  message_id: string;
  chat_id: string;
  sender_id: string;
  sent_at: string;
  message_type: "text" | "image" | "file" | "mixed" | "other";
  body: string | null;
  classification: "handover" | "renewal_follow_up" | "trial_scheduling" | "other";
  student_name_hint: string | null;
  guardian_wechat_hint: string | null;
  operations_owner_hint: string | null;
  course_planner_hint: string | null;
  trial_handover_id: string | null;
  trial_identity_status: "awaiting_student_name" | "identified" | "identity_conflict" | "identity_ambiguous" | null;
  trial_identity_student_name: string | null;
  student_id: string | null;
  match_status: "pending" | "ambiguous" | "linked";
  media_count: number;
  projected_at: string | null;
  ingested_at: string;
}>;

export type WecomArchiveStatus = Readonly<{
  total: number;
  linked: number;
  ambiguous: number;
  pending: number;
  trialAwaitingStudentName: number;
  trialIdentified: number;
  trialIdentityConflict: number;
  trialIdentityAmbiguous: number;
  latestSentAt: string | null;
  latestIngestedAt: string | null;
  receiver: (import("./wecom-receiver-health").WecomReceiverHealth & Readonly<{ recordedAt: string }>) | null;
}>;

export type WecomArchiveMedia = Readonly<{
  id: string;
  student_id: string;
  file_name: string;
  content_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  byte_size: number;
  content_base64: string;
}>;

export type RenewalFollowUpAtomicCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  renewal_id: string;
  student_id: string;
  attachment: FuAttachmentRow | null;
  renewals_row: OpsStateRow;
  students_row: OpsStateRow;
  files_row: OpsStateRow;
  tasks_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type RenewalFollowUpCommandResult = Readonly<{
  command_key: string;
  renewal_id: string;
  student_id: string;
  attachment_id: string | null;
  task_id: string | null;
  audit_entry_id: string;
}>;

export type StudentFileLinkAtomicCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  file_record: Record<string, unknown>;
  files_row: OpsStateRow;
  students_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type AppAccountAuthState = Readonly<{
  identity_key: string;
  account_name: string;
  account_role: "admin" | "limited-admin" | "staff" | "teacher";
  credential_version: number;
  must_change_password: boolean;
  enabled: boolean;
}>;

export type AppAccountCredential = AppAccountAuthState & Readonly<{
  password_algorithm: "scrypt-v1";
  password_hash: string;
  password_salt: string;
}>;

export type AppAccountCredentialCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  identity_key: string;
  credential_version: number;
  must_change_password: boolean;
  enabled: boolean;
  audit_entry_id: string;
}>;

export type AccountPasswordRotationResult = AppAccountCredentialCommitResult & Readonly<{
  current_credential_version: number;
  currently_active: boolean;
}>;

export type AccountIssuedPasswordEscrowResult = Readonly<{
  escrow_state: "available" | "self_changed" | "not_recorded" | "stale";
  credential_version: number | null;
  ciphertext: string | null;
  issued_at: string | null;
  audit_entry_id: string | null;
}>;

export type AccountIssuedPasswordRewrapResult = Readonly<{
  applied: boolean;
  audit_entry_id: string | null;
}>;

export type AccountRole = "admin" | "limited-admin" | "staff" | "teacher";
export type AccountStatus = "invited" | "active" | "disabled";

/** Directory projection deliberately contains no password, token, or MFA secret. */
export type AccountDirectoryRow = Readonly<{
  account_id: string;
  identity_key: string;
  account_name: string;
  account_role: AccountRole;
  status: AccountStatus;
  super_admin: boolean;
  access_version: number;
  role_version: number;
  scope_version: number;
  credential_version: number | null;
  must_change_password: boolean;
  mfa_enabled: boolean;
  legacy_session_allowed: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string;
}>;

export type AccountAuthorization = Readonly<{
  account_id: string;
  account_role: AccountRole;
  super_admin: boolean;
  access_version: number;
  role_version: number;
  scope_version: number;
  permissions: readonly string[];
  scope_members: readonly Readonly<{ kind: string; key: string }> [];
}>;

export type AccountInviteResult = Readonly<{
  account_id: string;
  account_name: string;
  account_role: AccountRole;
  status: "invited";
  role_version: number;
  scope_version: number;
  access_version: number;
  expires_at: string;
  delivery_status: "delivery_unconfigured";
  audit_entry_id: string;
}>;

export type AccountInviteAcceptResult = Readonly<{
  account_id: string;
  account_name: string;
  account_role: AccountRole;
  status: "active";
  credential_version: number;
  access_version: number;
  audit_entry_id: string;
}>;

export type AccountAccessUpdateResult = Readonly<{
  account_id: string;
  account_role: AccountRole;
  status: AccountStatus;
  role_version: number;
  scope_version: number;
  access_version: number;
  permissions: readonly string[];
  scope_members: readonly Readonly<{ kind: string; key: string }> [];
  audit_entry_id: string;
}>;

export type AccountStatusResult = Readonly<{
  account_id: string;
  status: AccountStatus;
  access_version: number;
  revoked_session_count: number;
  audit_entry_id: string;
}>;

export type AccountSessionResolution = Readonly<{
  session_id: string;
  account_id: string;
  account_name: string;
  account_role: AccountRole;
  status: "active";
  super_admin: boolean;
  access_version: number;
  role_version: number;
  scope_version: number;
  credential_version: number | null;
  must_change_password: boolean;
  mfa_verified: boolean;
  permissions: readonly string[];
  scope_members: readonly Readonly<{ kind: string; key: string }> [];
}>;

export type AccountSessionCreateResult = Readonly<{
  session_id: string;
  account_id: string;
  absolute_expires_at: string;
  idle_expires_at: string;
  access_version: number;
  audit_entry_id: string;
}>;

export type AccountSessionRow = Readonly<{
  session_id: string;
  created_at: string;
  last_seen_at: string;
  absolute_expires_at: string;
  idle_expires_at: string;
  mfa_verified: boolean;
  current: boolean;
}>;

export type AccountSessionRevokeResult = Readonly<{
  revoked_session_count: number;
  audit_entry_id: string | null;
}>;

export type AccountAuthThrottleResult = Readonly<{
  blocked: boolean;
  retry_after_seconds: number;
}>;

export type AccountRecoveryIssueResult = Readonly<{
  accepted: boolean;
  expires_at: string | null;
  delivery_status: "delivery_unconfigured" | null;
}>;

export type AccountRecoveryResult = Readonly<{
  account_id: string;
  account_name: string;
  account_role: AccountRole;
  credential_version: number;
  access_version: number;
  audit_entry_id: string;
}>;

/** Ciphertext is consumed only by server-side MFA verification code. */
export type AccountMfaRecord = Readonly<{
  account_id: string;
  secret_ciphertext: string;
  enabled: boolean;
  mfa_version: number;
}>;

export type AccountMfaMutationResult = Readonly<{
  account_id: string;
  enabled: boolean;
  mfa_version: number;
  access_version: number;
  revoked_session_count: number;
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

/**
 * Minimal monthly-completion presence result. It intentionally contains no
 * submitted availability, city, notes, or reviewer data.
 */
export type TeacherAvailabilityCompletionPendingTeacherIds = Readonly<{
  pending_teacher_ids: readonly string[];
  overflowed: boolean;
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

/** Curated read models only; raw Jiaowubao workbook evidence remains internal. */
export type JiaowubaoDirectScheduleEvent = Readonly<{
  eventId: string;
  sourceDate: string;
  startsAt: string;
  endsAt: string;
  courseName: string | null;
  teacherId: string | null;
  availabilityEffect: "display_only" | "blocks_teacher_ava";
  visibleStudentIds: readonly string[];
  /** The curated list stops at 100 authorized participants per class event. */
  visibleStudentsTruncated: boolean;
}>;

export type JiaowubaoDirectScheduleCursor = Readonly<{
  /** Six-digit UTC text is preserved exactly for keyset pagination. */
  startsAt: string;
  eventId: string;
}>;

export type JiaowubaoDirectScheduleWindow = Readonly<{
  state: "absent" | "complete" | "reset";
  events: readonly JiaowubaoDirectScheduleEvent[];
  invalidTimeEventCount: number;
  hasMore: boolean;
  nextCursor: JiaowubaoDirectScheduleCursor | null;
  /** Latest completed import that all pages in this response belong to. */
  runToken: string | null;
}>;

export type JiaowubaoDirectSupplementalHistoryItem = Readonly<{
  kind: "student_snapshot" | "quick_list" | "contract" | "hour_balance" | "class_membership";
  courseName: string | null;
  className: string | null;
  classType: string | null;
  studentType: string | null;
  totalHours: string | null;
  usedHours: string | null;
  remainingHours: string | null;
}>;

export type JiaowubaoDirectLeaveMakeupHistoryItem = Readonly<{
  date: string | null;
  timeText: string | null;
  kind: "leave" | "makeup" | "unknown";
  courseName: string | null;
}>;

export type JiaowubaoDirectStudentHistory = Readonly<{
  state: "absent" | "complete";
  supplemental: Readonly<{
    items: readonly JiaowubaoDirectSupplementalHistoryItem[];
    truncated: boolean;
  }>;
  leaveMakeups: Readonly<{
    items: readonly JiaowubaoDirectLeaveMakeupHistoryItem[];
    truncated: boolean;
  }>;
}>;

/**
 * Admin-only, curated readiness evidence from the latest completed Jiaowubao
 * direct import. It is deliberately read-only: these rows are not bookings,
 * packages, tasks, operations, or online classrooms.
 */
export type JiaowubaoDirectOperationsReadiness = Readonly<{
  state: "absent" | "complete";
  /** Opaque token for the immutable completed source run, not a source key. */
  runToken: string | null;
  window: Readonly<{ startsAt: string; endsAt: string }>;
  schedule: Readonly<{
    summary: Readonly<{
      /** Parsed schedule events falling inside the requested bounded window. */
      windowEvents: number;
      needsTeacherMapping: number;
      needsCourseMapping: number;
      readyForAvaReview: number;
      /** Source-date count only; invalid records never become AVA blocks. */
      invalidTime: number;
    }>;
    rows: readonly Readonly<{
      eventId: string;
      sourceDate: string;
      startsAt: string;
      endsAt: string;
      courseName: string | null;
      /** Current app teacher ID when the imported label matched exactly. */
      teacherId: string | null;
      /** Admin-only source label required to review teacher mapping. */
      teacherLabel: string | null;
      teacherResolution: "exact_name" | "unresolved" | "ambiguous" | "not_found";
      subjectResolution: "exact_name" | "unresolved" | "ambiguous" | "not_found";
      availabilityEffect: "display_only" | "blocks_teacher_ava";
      attachedParticipantCount: number;
      needsTeacherMapping: boolean;
      needsCourseMapping: boolean;
      readyForAvaReview: boolean;
    }>[];
    truncated: boolean;
  }>;
  leaveMakeups: Readonly<{
    summary: Readonly<{ attached: number; leave: number; makeup: number; unknown: number }>;
    rows: readonly Readonly<{
      incidentId: string;
      /** Current app student ID only; no source identity, name, or phone. */
      studentId: string;
      kind: "leave" | "makeup" | "unknown";
      sourceDate: string | null;
      timeText: string | null;
      courseName: string | null;
      className: string | null;
      /** Admin-only source label, with no teacher identity link implied. */
      teacherLabel: string | null;
    }>[];
    truncated: boolean;
  }>;
  renewalEvidence: Readonly<{
    summary: Readonly<{ candidates: number; withContract: number; withHourBalance: number }>;
    rows: readonly Readonly<{
      studentId: string;
      courseName: string | null;
      hasContractEvidence: boolean;
      hasHourBalanceEvidence: boolean;
      totalHours: string | null;
      usedHours: string | null;
      remainingHours: string | null;
    }>[];
    truncated: boolean;
  }>;
}>;

/**
 * Admin-reviewed mapping overlay for one completed Jiaowubao source run.
 * These are source-label decisions only, never operational bookings or AVA
 * blocks. `mappingKey` and `nextCursor` are opaque database values.
 */
export type JiaowubaoDirectScheduleMappingReview = Readonly<{
  state: "absent" | "complete";
  runToken: string | null;
  teachersVersion: number | null;
  teachers: readonly Readonly<{
    id: string;
    name: string;
    subjectIds: readonly string[];
  }>[];
  summary: Readonly<{
    total: number;
    unmapped: number;
    confirmed: number;
    revoked: number;
    authorityChanged: number;
  }>;
  candidates: readonly Readonly<{
    mappingKey: string;
    teacherLabel: string;
    courseLabel: string;
    eventCount: number;
    status: "unmapped" | "confirmed" | "revoked" | "authority_changed";
    targetTeacherId: string | null;
    targetTeacherName: string | null;
    targetSubjectId: string | null;
    decidedAt: string | null;
  }>[];
  nextCursor: string | null;
}>;

/**
 * Current/future action queue derived from immutable mapping relevance days.
 * `nextStartsAt` is a parsed source class start inside the requested canonical
 * UTC window, not a booking or an inferred task deadline.
 */
export type JiaowubaoDirectScheduleMappingPriorityReview = Readonly<{
  state: "absent" | "complete";
  runToken: string | null;
  teachersVersion: number | null;
  teachers: readonly Readonly<{
    id: string;
    name: string;
    subjectIds: readonly string[];
  }>[];
  window: Readonly<{ startsAt: string; endsAt: string }>;
  summary: Readonly<{
    /** Only human-actionable mappings: unmapped + authority changed. */
    total: number;
    unmapped: number;
    authorityChanged: number;
    /** Visible for audit only; revoked pairs cannot re-enter this queue. */
    revokedInWindow: number;
  }>;
  candidates: readonly Readonly<{
    mappingKey: string;
    teacherLabel: string;
    courseLabel: string;
    /** All immutable source events in this label-pair candidate. */
    eventCount: number;
    status: "unmapped" | "authority_changed";
    targetTeacherId: string | null;
    targetTeacherName: string | null;
    targetSubjectId: string | null;
    decidedAt: string | null;
    /** Exact parsed source start inside `window`; no relative-time guess. */
    nextStartsAt: string;
    windowEventCount: number;
  }>[];
  nextCursor: string | null;
}>;

export type JiaowubaoDirectScheduleMappingSaveResult = Readonly<{
  mappingKey: string;
  action: "confirm" | "revoke";
  targetTeacherId: string | null;
  targetSubjectId: string | null;
  teachersVersion: number;
  unchanged: boolean;
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
    matchStrategy?: StudentImportIdentityMatchStrategy;
  }>[];
  identityLinkFingerprint: string;
  /** Monotonic revocation generation for opaque identity-review options. */
  identityReviewEpoch: number;
  masterDuplicateResolutions: readonly MasterStudentDuplicateResolution[];
  masterDuplicateResolutionFingerprint: string;
  fuAttachmentReferences: StudentFuAttachmentReferenceSnapshot;
  /** Internal server snapshot of numbers permanently reserved for student IDs. */
  studentNumberReservations: readonly StudentNumberReservation[];
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

/**
 * A source-wide one-to-one review of JWB names whose only difference is one
 * pure Latin-letter parenthetical annotation. The confirmation key is opaque;
 * the browser never submits source rows, names, IDs, or a matching rule.
 */
export type StudentImportIdentityAnnotationReviewPreview = Readonly<{
  confirmationKey: string;
  candidateCount: number;
  pendingCount: number;
  alreadyLinkedCount: number;
  currentLinkCount: number;
  resultingLinkCount: number;
  canSubmit: boolean;
}>;

export type StudentImportIdentityAnnotationReviewResult = Readonly<{
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
export const STUDENT_IMPORT_IDENTITY_ANNOTATION_PREVIEW_RPC = "get_student_import_identity_annotation_review_preview";
export const STUDENT_IMPORT_IDENTITY_ANNOTATION_PUT_RPC = "put_student_import_identity_annotation_review";
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
export const TEACHER_AVAILABILITY_COMPLETION_PENDING_TEACHERS_RPC = "get_teacher_availability_completion_pending_teacher_ids";
export const TEACHER_AVAILABILITY_ATOMIC_REVIEW_RPC = "review_teacher_availability_submission_atomic";
export const TEACHER_AVAILABILITY_ATOMIC_SUBMIT_RPC = "submit_teacher_availability_atomic";
export const BOOKING_CAPACITY_ATOMIC_MUTATION_RPC = "mutate_booking_projection_atomic";
export const TEMPORARY_CLASSROOM_CAPABILITY_RPC = "get_temporary_classroom_capability";
export const TEMPORARY_CLASSROOM_REQUEST_CLAIM_RPC = "claim_temporary_classroom_request";
export const JIAOWUBAO_DIRECT_SCHEDULE_WINDOW_RPC = "get_jiaowubao_direct_schedule_window";
export const JIAOWUBAO_DIRECT_STUDENT_HISTORY_RPC = "get_jiaowubao_direct_student_history";
export const JIAOWUBAO_DIRECT_OPERATIONS_READINESS_RPC = "get_jiaowubao_direct_operations_readiness";
export const JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_REVIEW_RPC = "get_jiaowubao_direct_schedule_mapping_review";
export const JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PRIORITY_REVIEW_RPC = "get_jiaowubao_direct_schedule_mapping_priority_review";
export const JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PUT_RPC = "put_jiaowubao_direct_schedule_label_mapping";
export const OPERATION_CONFIRM_ATOMIC_RPC = "confirm_operation_occurrences_atomic";
export const BOOKING_CAPACITY_COMMAND_RESULT_RPC = "get_booking_projection_command_result";
export const OPERATION_CONFIRM_COMMAND_RESULT_RPC = "get_operation_confirmation_command_result";
export const PERMANENT_TEACHER_REPLACEMENT_ATOMIC_RPC = "confirm_permanent_teacher_replacement_atomic";
export const PERMANENT_TEACHER_REPLACEMENT_COMMAND_RESULT_RPC = "get_permanent_teacher_replacement_command_result";
export const TEACHER_DEPARTURE_CREATION_ATOMIC_RPC = "create_teacher_departure_atomic";
export const TEACHER_DEPARTURE_CREATION_COMMAND_RESULT_RPC = "get_teacher_departure_creation_command_result";
export const TEACHER_ABSENCE_CREATION_ATOMIC_RPC = "create_teacher_absence_atomic";
export const TEACHER_ABSENCE_CREATION_COMMAND_RESULT_RPC = "get_teacher_absence_creation_command_result";
export const EXAM_SUBMISSION_ATOMIC_RPC = "submit_exam_atomic";
export const EXAM_SUBMISSION_COMMAND_RESULT_RPC = "get_exam_submission_command_result";
export const EXAM_FOLLOW_UP_ATOMIC_RPC = "mutate_exam_follow_up_atomic";
export const EXAM_FOLLOW_UP_COMMAND_RESULT_RPC = "get_exam_follow_up_command_result";
export const EXAM_FOLLOW_UP_COMPLETION_CONTEXT_RPC = "get_exam_follow_up_completion_context";
export const LEGACY_TASK_DEADLINE_ATOMIC_RPC = "mutate_legacy_task_deadline_atomic";
export const LEGACY_TASK_DEADLINE_COMMAND_RESULT_RPC = "get_legacy_task_deadline_command_result";
export const STUDENT_FU_ATTACHMENT_ATOMIC_PUT_RPC = "put_student_fu_attachment_atomic";
export const RENEWAL_FOLLOW_UP_ATOMIC_RPC = "put_renewal_follow_up_atomic";
export const RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC = "put_renewal_follow_up_create_if_missing_atomic";
export const RENEWAL_FOLLOW_UP_COMMAND_RESULT_RPC = "get_renewal_follow_up_command_result";
export const DIRECT_ENROLLMENT_ATOMIC_RPC = "create_student_direct_enrollment_atomic";
export const DIRECT_ENROLLMENT_COMMAND_RESULT_RPC = "get_student_direct_enrollment_command_result";
export const STUDENT_CREATION_ATOMIC_RPC = "create_student_with_tasks_atomic";
export const STUDENT_CREATION_COMMAND_RESULT_RPC = "get_student_creation_command_result";
export const LEGACY_OPERATION_TASK_ATOMIC_RPC = "mutate_legacy_operation_task_atomic";
export const LEGACY_OPERATION_TASK_COMMAND_RESULT_RPC = "get_legacy_operation_task_command_result";
export const LP_ATOMIC_RPC = "mutate_lp_atomic";
export const LP_ATOMIC_COMMAND_RESULT_RPC = "get_lp_atomic_command_result";
export const TRIAL_LEDGER_ATOMIC_RPC = "mutate_trial_ledger_field_atomic";
export const TRIAL_LEDGER_COMMAND_RESULT_RPC = "get_trial_ledger_command_result";
export const TENCENT_TRIAL_LEDGER_SYNC_CLAIM_RPC = "claim_tencent_trial_ledger_sync_batch_v2";
export const TENCENT_TRIAL_LEDGER_SYNC_COMPLETE_RPC = "complete_tencent_trial_ledger_sync_batch";
export const TENCENT_TRIAL_LEDGER_SYNC_FAIL_RPC = "fail_tencent_trial_ledger_sync_batch";
export const TENCENT_TRIAL_LEDGER_SYNC_STATUS_RPC = "get_tencent_trial_ledger_sync_status";
export const STUDENT_FILE_LINK_ATOMIC_PUT_RPC = "put_student_file_link_atomic";
export const APP_ACCOUNT_AUTH_STATE_RPC = "read_app_account_auth_state";
export const APP_ACCOUNT_CREDENTIAL_RPC = "read_app_account_credential";
export const APP_ACCOUNT_CREDENTIAL_PUT_RPC = "put_app_account_credential_atomic";
export const ACCOUNT_DIRECTORY_RPC = "read_account_directory";
export const ACCOUNT_BY_IDENTITY_RPC = "read_account_by_identity";
export const ACCOUNT_ENSURE_DIRECTORY_RPC = "ensure_account_directory";
export const ACCOUNT_INVITE_RPC = "create_account_invite";
export const ACCOUNT_INVITE_ACCEPT_RPC = "accept_account_invite";
export const ACCOUNT_ACCESS_RPC = "update_account_access";
export const ACCOUNT_STATUS_RPC = "set_account_status";
export const ACCOUNT_AUTHORIZATION_RPC = "read_account_authorization";
export const ACCOUNT_SESSION_CREATE_RPC = "create_account_session";
export const ACCOUNT_SESSION_READ_RPC = "read_account_session";
export const ACCOUNT_SESSIONS_READ_RPC = "read_account_sessions";
export const ACCOUNT_SESSION_REVOKE_RPC = "revoke_account_sessions";
export const ACCOUNT_CURRENT_SESSION_REVOKE_RPC = "revoke_current_account_session";
export const ACCOUNT_PASSWORD_ROTATE_RPC = "rotate_account_password_tx_v4";
export const ACCOUNT_ISSUED_PASSWORD_READ_RPC = "read_account_issued_password_escrow";
export const ACCOUNT_ISSUED_PASSWORD_REWRAP_RPC = "rewrap_account_issued_password_escrow";
export const ACCOUNT_ISSUED_PASSWORD_SEED_RPC = "seed_account_issued_password_escrow";
export const ACCOUNT_RECOVERY_ISSUE_RPC = "issue_account_recovery";
export const ACCOUNT_RECOVERY_CONSUME_RPC = "consume_account_recovery";
export const ACCOUNT_MFA_LOGIN_RPC = "read_account_mfa_for_login";
export const ACCOUNT_MFA_TOTP_CONSUME_RPC = "consume_account_mfa_totp";
export const ACCOUNT_MFA_READ_RPC = "read_account_mfa";
export const ACCOUNT_MFA_BEGIN_RPC = "begin_account_mfa_setup";
export const ACCOUNT_MFA_CONFIRM_RPC = "confirm_account_mfa";
export const ACCOUNT_MFA_DISABLE_RPC = "disable_account_mfa";
export const ACCOUNT_MFA_RESET_RPC = "reset_account_mfa";
export const ACCOUNT_AUTH_THROTTLE_ADMIT_RPC = "admit_account_auth_attempt";
export const ACCOUNT_AUTH_THROTTLE_CHECK_RPC = "check_account_auth_throttle";
export const ACCOUNT_AUTH_THROTTLE_RECORD_RPC = "record_account_auth_attempt";
export const LP_PARENT_PROGRESS_SCHEDULER_BEGIN_RPC = "begin_lp_parent_progress_scheduler_run";
export const LP_PARENT_PROGRESS_SCHEDULER_FINISH_RPC = "finish_lp_parent_progress_scheduler_run";
export const LP_PARENT_PROGRESS_SCHEDULER_COMMIT_RPC = "put_lp_parent_progress_scheduler_tasks_authoritative";
export const LP_PARENT_PROGRESS_SCHEDULER_RECOVER_RPC = "recover_stale_lp_parent_progress_scheduler_runs";
export const TRIAL_PAYMENT_RECONCILE_RPC = "reconcile_trial_payment_tasks_authoritative";
export const TRIAL_PAYMENT_COMPLETE_RPC = "complete_trial_payment_task_tx";
export const JIAOWUBAO_TRIAL_PAYMENT_COMPLETE_RPC = "complete_jiaowubao_trial_payment_task_tx";
export const TRIAL_PAYMENT_COMPLETION_COMMAND_RESULT_RPC = "get_trial_payment_completion_command_result";
export const TRIAL_PAYMENT_LIFECYCLE_RPC = "mutate_trial_payment_task_lifecycle_tx";
export const TRIAL_PAYMENT_LIFECYCLE_COMMAND_RESULT_RPC = "get_trial_payment_lifecycle_command_result";
export const JIAOWUBAO_OPEN_API_SCHEDULE_CONFIRM_RPC = "confirm_jiaowubao_open_api_schedule_snapshot_current";
export const JIAOWUBAO_OPEN_API_SCHEDULE_BEGIN_RPC = "begin_jiaowubao_open_api_schedule_snapshot_ingest";
export const JIAOWUBAO_OPEN_API_SCHEDULE_STAGE_RPC = "stage_jiaowubao_open_api_schedule_snapshot_page";
export const JIAOWUBAO_OPEN_API_SCHEDULE_COMPLETE_RPC = "complete_jiaowubao_open_api_schedule_snapshot_ingest";
export const JIAOWUBAO_OPEN_API_SCHEDULE_STATUS_RPC = "get_jiaowubao_open_api_schedule_snapshot_ingest_status";
export const JIAOWUBAO_OPEN_API_SCHEDULE_ABORT_RPC = "abort_jiaowubao_open_api_schedule_snapshot_ingest";
export const JIAOWUBAO_OPEN_API_SCHEDULE_LEASE_CLAIM_RPC = "claim_jiaowubao_open_api_schedule_sync_lease_v2";
export const JIAOWUBAO_OPEN_API_SCHEDULE_LEASE_RELEASE_RPC = "release_jiaowubao_open_api_schedule_sync_lease_v2";
export const JIAOWUBAO_OPEN_API_SCHEDULE_READER_RPC = "get_jiaowubao_open_api_schedule_snapshot_window";
const JIAOWUBAO_OPEN_API_SCHEDULE_PROJECTION_TARGET_RPC = "get_jiaowubao_open_api_schedule_projection_target";
const JIAOWUBAO_OPEN_API_SCHEDULE_PROJECTION_ADVANCE_RPC = "advance_jiaowubao_open_api_schedule_projection";
export const JIAOWUBAO_OPEN_API_AUTHORITY_PROJECT_RPC = "project_jiaowubao_open_api_authority";
export const JIAOWUBAO_COMPLETED_LESSON_PREFLIGHT_RPC = "get_jiaowubao_completed_lesson_snapshot_preflight";
export const JIAOWUBAO_COMPLETED_LESSON_BEGIN_RPC = "begin_jiaowubao_completed_lesson_snapshot_ingest";
export const JIAOWUBAO_COMPLETED_LESSON_STAGE_RPC = "stage_jiaowubao_completed_lesson_snapshot_page";
export const JIAOWUBAO_COMPLETED_LESSON_COMPLETE_RPC = "complete_jiaowubao_completed_lesson_snapshot_ingest";
export const JIAOWUBAO_COMPLETED_LESSON_ABORT_RPC = "abort_jiaowubao_completed_lesson_snapshot_ingest";
export const JIAOWUBAO_COMPLETED_LESSON_CONFIRM_RPC = "confirm_jiaowubao_completed_lesson_snapshot_current";
export const JIAOWUBAO_COMPLETED_LESSON_READER_RPC = "get_jiaowubao_completed_lesson_snapshot_page";
export const JIAOWUBAO_COMPLETED_LESSON_SCHEDULE_READER_RPC = "get_jiaowubao_completed_lesson_snapshot_schedule_page";
export const JIAOWUBAO_COMPLETED_LESSON_SCHEDULE_STAGE_RPC = "stage_jiaowubao_completed_lesson_snapshot_schedule_page";
export const JIAOWUBAO_COMPLETED_LESSON_LEASE_CLAIM_RPC = "claim_jiaowubao_completed_lesson_sync_lease";
export const JIAOWUBAO_COMPLETED_LESSON_LEASE_RELEASE_RPC = "release_jiaowubao_completed_lesson_sync_lease";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_GET_RPC = "get_jiaowubao_completed_lesson_member_collection";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_PENDING_RPC = "get_jiaowubao_completed_lesson_pending_month";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_BEGIN_RPC = "begin_jiaowubao_completed_lesson_member_collection";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_RESERVE_RPC = "reserve_jiaowubao_completed_lesson_api_request";
export const JIAOWUBAO_OPEN_API_SCHEDULE_RESERVE_RPC = "reserve_jiaowubao_open_api_schedule_request";
const JIAOWUBAO_SCHEDULE_HORIZON_BEGIN_RPC = "begin_jiaowubao_schedule_horizon_collection";
const JIAOWUBAO_SCHEDULE_HORIZON_STAGE_RPC = "stage_jiaowubao_schedule_horizon_page";
const JIAOWUBAO_SCHEDULE_HORIZON_READ_RPC = "read_jiaowubao_schedule_horizon_pages";
const JIAOWUBAO_SCHEDULE_HORIZON_CLOSE_RPC = "close_jiaowubao_schedule_horizon_collection";
const JIAOWUBAO_SCHEDULE_HORIZON_ABORT_RPC = "abort_jiaowubao_schedule_horizon_collection";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_STAGE_RPC = "stage_jiaowubao_completed_lesson_member_page";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_ITEMS_RPC = "get_jiaowubao_completed_lesson_member_items_page";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_PREPARE_RPC = "prepare_jiaowubao_completed_lesson_member_publication";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_PUBLISH_RPC = "complete_jiaowubao_completed_lesson_member_publication";
export const JIAOWUBAO_COMPLETED_LESSON_MEMBER_ABORT_RPC = "abort_jiaowubao_completed_lesson_member_collection";
export const JIAOWUBAO_TRIAL_SYNC_ATOMIC_RPC = "sync_jiaowubao_trial_matches_atomic_v2";
export const JIAOWUBAO_TRIAL_SYNC_COMMAND_RESULT_RPC = "get_jiaowubao_trial_sync_command_result";
export const WECOM_ARCHIVE_INGEST_RPC = "ingest_wecom_archive_batch";
export const WECOM_ARCHIVE_INBOX_RPC = "read_wecom_archive_inbox";
export const WECOM_ARCHIVE_LINK_RPC = "link_wecom_archive_message";
export const WECOM_ARCHIVE_MEDIA_RPC = "get_wecom_archive_media";
export const WECOM_ARCHIVE_STATUS_RPC = "get_wecom_archive_status";
export const WECOM_BOT_INGEST_RPC = "ingest_wecom_bot_batch";
const WECOM_RECEIVER_HEALTH_RECORD_RPC = "record_wecom_receiver_health";

export class OpsStoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** Default bound for ordinary RPC calls; classroom routes may opt into a tighter bound. */
export const OPS_RPC_TIMEOUT_MS = 15_000;

/** Optional per-call bound used by routes with a shorter end-to-end budget. */
export type OpsRpcOptions = OpsRpcBudgetOptions;

export type DirectEnrollmentCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  student_id: string;
  package_id: string;
  purchase_id: string;
  lp_item_id: string;
  task_ids: readonly string[];
  students_row: OpsStateRow | null;
  lp_items_row: OpsStateRow | null;
  tasks_row: OpsStateRow | null;
  audit_entry_id: string;
}>;

export type DirectEnrollmentCommandResult = Readonly<{
  command_key: string;
  student_id: string;
  package_id: string;
  purchase_id: string;
  lp_item_id: string;
  task_ids: readonly string[];
  students_row: OpsStateRow | null;
  lp_items_row: OpsStateRow | null;
  tasks_row: OpsStateRow | null;
  audit_entry_id: string;
}>;

export type StudentCreationCommitResult = Readonly<{
  command_key: string; applied: boolean; student_id: string; task_ids: readonly string[];
  students_row: OpsStateRow | null; tasks_row: OpsStateRow | null; audit_entry_id: string;
}>;
export type StudentCreationCommandResult = Omit<StudentCreationCommitResult, "applied">;
export type LegacyOperationTaskCommitResult = Readonly<{
  command_key: string; applied: boolean; operation_ids: readonly string[]; affected_student_ids: readonly string[];
  affected_occurrence_count?: number; generated_task_count?: number;
  operations_row: OpsStateRow | null; tasks_row: OpsStateRow | null; audit_entry_id: string;
}>;
export type LegacyOperationTaskCommandResult = Omit<LegacyOperationTaskCommitResult, "applied">;

export type LpAtomicCommitResult = Readonly<{
  command_key: string;
  operation: "create" | "revise";
  applied: boolean;
  student_id: string;
  lp_item_id: string;
  students_row: OpsStateRow | null;
  lp_items_row: OpsStateRow | null;
  tasks_row: OpsStateRow | null;
  files_row: OpsStateRow | null;
  audit_entry_id: string;
}>;

export type LpAtomicCommandResult = Omit<LpAtomicCommitResult, "applied">;

export type TrialLedgerCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  lp_item_id: string;
  student_id: string;
  field: string;
  lp_items_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TrialLedgerCommandResult = Omit<TrialLedgerCommitResult, "applied">;

export type TrialPaymentReconcileResult = Readonly<{
  run_key: string;
  applied: boolean;
  changed_count: number;
  bookings_row: OpsStateRow;
  students_row: OpsStateRow;
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
  teachers_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TrialPaymentCompletionResult = Readonly<{
  command_key: string;
  applied: boolean;
  task_id: string;
  booking_id: string;
  student_id: string;
  bookings_row: OpsStateRow;
  students_row: OpsStateRow;
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
  teachers_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TrialPaymentCompletionCommandResult = Readonly<{
  command_key: string;
  task_id: string;
  audit_entry_id: string;
}>;

export type TrialPaymentLifecycleResult = Readonly<{
  command_key: string;
  applied: boolean;
  action: "complete" | "reopen";
  task_id: string;
  anchor_id: string;
  student_id: string;
  lp_item_id: string;
  bookings_row: OpsStateRow;
  students_row: OpsStateRow;
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
  teachers_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TrialPaymentLifecycleCommandResult = Readonly<{
  command_key: string;
  action: "complete" | "reopen";
  task_id: string;
  audit_entry_id: string;
}>;

type JiaowubaoOpenApiScheduleSnapshotBeginReceipt = Readonly<{
  runId: string;
  state: "staging" | "complete";
  revision: string;
  expectedPageCount: number;
  expectedRowCount: number;
  replayed: boolean;
}>;

type JiaowubaoOpenApiScheduleSnapshotPageReceipt = Readonly<{
  runId: string;
  pageIndex: number;
  pageSha256: string;
  rowCount: number;
  replayed: boolean;
}>;

type JiaowubaoOpenApiScheduleSnapshotCompleteReceipt = Readonly<{
  runId: string;
  state: "complete";
  revision: string;
  rowCount: number;
  pageCount?: number;
  rowsSha256: string;
  payloadSha256: string;
  replayed: boolean;
}>;

export type JiaowubaoScheduleHorizonCollectionReceipt = Readonly<{
  runId: string;
  state: "collecting" | "ready";
  passNumber: number;
  windowIndex: number;
  nextPage: number;
  firstPassCount: number;
  secondPassCount: number;
}>;

type JiaowubaoScheduleHorizonPageBatch = Readonly<{
  runId: string;
  state: "ready";
  pageCount: number;
  pages: readonly Readonly<{
    passNumber: number;
    windowIndex: number;
    pageNumber: number;
    rows: readonly Readonly<{ sourceKey: string; record: Readonly<Record<string, unknown>> }>[];
  }>[];
  hasMore: boolean;
}>;

export type JiaowubaoOpenApiScheduleSnapshotIdentityPage = Readonly<{
  state: "absent" | "complete" | "reset";
  revision: string | null;
  rowCount: number;
  items: readonly Readonly<{ sourceKey: string; sourceDate: string | null }>[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type JiaowubaoOpenApiScheduleProjectionTarget =
  | Readonly<{ state: "absent" }>
  | Readonly<{
    state: "ready";
    revision: string;
    rowCount: number;
    projectionState: "pending" | "authority_done" | "complete";
    window: Readonly<{ start: string; end: string }>;
    publishedAt: string;
  }>;

type JiaowubaoOpenApiScheduleProjectionTransition =
  | Readonly<{ state: "absent"; replayed: false }>
  | Readonly<{ state: "reset" | "authority_done" | "complete"; revision: string; replayed: boolean }>;

export type JiaowubaoOpenApiAuthorityProjectionReceipt = Readonly<{
  schemaVersion: 1;
  authorityMode: "one_of_multiple";
  tool: "query_schedule_list";
  snapshotRevision: string;
  projectionRunId: string;
  checkedAt: string;
  cadenceMinutes: 30;
  coverage: Readonly<{
    snapshotRows: number;
    normalizedEntityRows: number;
    matchedEntityRows: number;
    sourceOnlyEntityRows: number;
  }>;
  replayed: boolean;
  [key: string]: unknown;
}>;

export type JiaowubaoOpenApiScheduleSyncLease = Readonly<{
  acquired: boolean;
  runKey: string;
  retryAfterSeconds: number;
}>;

/** Private, month-scoped source evidence; the browser only sees a route DTO. */
export type JiaowubaoCompletedLessonSnapshotReceipt = Readonly<{
  runId: string;
  state: "staging" | "complete" | "aborted";
  abortReason?: "caller_failure" | "current_pointer_conflict" | "staging_envelope_conflict" | "superseded_current_pointer";
  rowCount?: number;
  scheduleRowCount?: number;
  rowsSha256?: string;
  payloadSha256?: string;
  replayed?: boolean;
  republished?: boolean;
}>;

export type JiaowubaoCompletedLessonSnapshotPreflight = Readonly<{
  apiSourceKey: "jwb-open-api-completed-lessons";
  month: string;
  current: Readonly<{ revision: string; rowCount: number; scheduleRowCount?: number; publishedAt: string }> | null;
}>;

export type JiaowubaoCompletedLessonSnapshotPage = Readonly<{
  state: "absent" | "complete" | "reset";
  month: string;
  revision: string | null;
  rowCount: number;
  pageIndex: number;
  pageCount: number;
  publishedAt: string | null;
  items: readonly Readonly<{ sourceKey: string; record: Readonly<Record<string, unknown>> }>[];
}>;

export type JiaowubaoCompletedLessonSyncLease = Readonly<{
  acquired: boolean;
  runKey: string;
  retryAfterSeconds: number;
}>;

export type JiaowubaoCompletedLessonMemberCollection = Readonly<{
  state: "absent" | "collecting" | "ready" | "published" | "aborted" | "blocked";
  month: string;
  runId?: string;
  scheduleRevision?: string;
  scheduleMemberSetSha256?: string;
  scheduleMemberCount?: number;
  catalogRevisionSha256?: string;
  catalogMemberCount?: number;
  memberSetSha256?: string;
  memberCount?: number;
  completedMemberCount?: number;
  rowCount?: number;
  expectedCurrentRevision?: string | null;
  finalRevision?: string | null;
  abortReason?: "schedule_changed" | "source_conflict" | "caller_failure" | "catalog_changed" | null;
  nextMemberId?: number | null;
  nextPage?: number | null;
  expectedTotal?: number | null;
  targetVersion?: number | null;
}>;

export type JiaowubaoCompletedLessonMemberItemsPage = Readonly<{
  state: "ready" | "published";
  runId: string;
  month: string;
  rowCount: number;
  pageIndex: number;
  pageCount: number;
  items: readonly Readonly<{ sourceKey: string; record: Readonly<Record<string, unknown>> }>[];
}>;

export type JiaowubaoCompletedLessonPendingMonth = Readonly<{
  month: string | null;
}>;

export type JiaowubaoTrialSyncCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  snapshot_revision: string;
  lp_item_ids: readonly string[];
  student_ids: readonly string[];
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type JiaowubaoTrialSyncCommandResult = Omit<JiaowubaoTrialSyncCommitResult, "applied">;

/** Server-only raw receipt from the Open API source snapshot reader. */
export type JiaowubaoOpenApiScheduleSnapshotWindow = Readonly<{
  state: "absent" | "complete" | "stale" | "reset";
  events: readonly Readonly<{
    eventId: string;
    sourceDate: string;
    startsAt: string;
    endsAt: string;
    courseName: string | null;
    sourceTeacherId: string | null;
    sourceTeacherLabel: string | null;
    sourceParticipants: readonly Readonly<{
      memberId: string | null;
      label: string | null;
    }>[];
    sourceStudentsTruncated: boolean;
  }>[];
  invalidTimeEventCount: number;
  hasMore: boolean;
  nextCursor: Readonly<{ startsAt: string; eventId: string }> | null;
  revision: string | null;
  publishedAt: string | null;
  sourceWindow: Readonly<{ start: string; end: string }> | null;
  freshness: "absent" | "fresh" | "stale";
  empty: boolean;
}>;

function configuration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.OPS_API_SECRET;

  if (!url || !publishableKey || !secret) {
    throw new OpsStoreError("Supabase 共享数据环境变量尚未配置。", "missing_configuration");
  }

  return { url: url.replace(/\/$/, ""), publishableKey, secret };
}

async function parseRpcPayload(response: Response, controller: AbortController) {
  try {
    return await response.json() as unknown;
  } catch (error) {
    if (controller.signal.aborted) throw error;
    throw new OpsStoreError("Supabase 返回了无效响应。", "invalid_response");
  }
}

async function requestRpc(
  url: string,
  publishableKey: string,
  name: string,
  body: Record<string, unknown>,
  controller: AbortController,
) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: controller.signal,
  });
  return Object.freeze({
    response,
    payload: await parseRpcPayload(response, controller),
  });
}

function unwrapRpcResponse<T>(response: Response, payload: unknown) {
  if (!response.ok) {
    const error = payload as { message?: string; code?: string; details?: string } | null;
    throw new OpsStoreError(error?.message || "Supabase 请求失败。", error?.code, error?.details);
  }
  return payload as T;
}

async function rpc<T>(name: string, body: Record<string, unknown>, options: OpsRpcOptions = {}) {
  const { url, publishableKey } = configuration();
  const controller = new AbortController();
  const timing = resolveOpsRpcTiming(options, OPS_RPC_TIMEOUT_MS);
  if (timing === null) {
    throw new OpsStoreError("本轮数据库请求预算已用尽；系统会安全重试。", "deadline");
  }
  const timeout = setTimeout(() => controller.abort(), timing.timeoutMs);
  let result: Awaited<ReturnType<typeof requestRpc>>;
  try {
    result = await requestRpc(url, publishableKey, name, body, controller);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpsStoreError(
        "数据库请求超时，请稍后用同一命令重试。",
        timing.timeoutCode,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return unwrapRpcResponse<T>(result.response, result.payload);
}

export function getOpsState(entities?: string[], options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>("get_ops_state", {
    p_secret: secret,
    p_entities: entities?.length ? entities : null,
  }, options);
}

export type ClassroomEndRequest = Readonly<{
  occurrence_id: string;
  meeting_id: string;
  status: "closing" | "ended";
}>;

export function claimClassroomCreation(occurrenceId: string, meetingId: string, leaseId: string, temporaryRequestIdentity?: string) {
  const { secret } = configuration();
  if (temporaryRequestIdentity) return rpc<boolean>("claim_temporary_classroom_creation", { p_secret: secret, p_occurrence_id: occurrenceId, p_meeting_id: meetingId, p_lease_id: leaseId, p_request_identity: temporaryRequestIdentity });
  return rpc<boolean>("claim_classroom_creation", { p_secret: secret, p_occurrence_id: occurrenceId, p_meeting_id: meetingId, p_lease_id: leaseId });
}

export function releaseClassroomCreation(occurrenceId: string, leaseId: string) {
  const { secret } = configuration();
  return rpc<boolean>("release_classroom_creation", { p_secret: secret, p_occurrence_id: occurrenceId, p_lease_id: leaseId });
}

export function readClassroomEndRequests(occurrenceId?: string) {
  const { secret } = configuration();
  return rpc<ClassroomEndRequest[]>("read_classroom_end_requests", { p_secret: secret, p_occurrence_id: occurrenceId ?? null });
}

export function beginClassroomEnd(input: { occurrenceId: string; meetingId: string; expectedVersion: number; actor: string }) {
  const { secret } = configuration();
  return rpc<ClassroomEndRequest>("begin_classroom_end", { p_secret: secret, p_occurrence_id: input.occurrenceId, p_meeting_id: input.meetingId, p_expected_version: input.expectedVersion, p_actor: input.actor });
}

export function finishClassroomEnd(occurrenceId: string, providerStopped: boolean) {
  const { secret } = configuration();
  return rpc<ClassroomEndRequest>("finish_classroom_end", { p_secret: secret, p_occurrence_id: occurrenceId, p_provider_stopped: providerStopped });
}

export function getOperationalAudit(limit = 500) {
  const { secret } = configuration();
  return rpc<OperationalAuditRecord[]>("read_operational_contract_audit", {
    p_secret: secret,
    p_limit: limit,
  });
}

/** The browser sends only the narrow direct-enrollment command. The RPC derives every array. */
export function createStudentDirectEnrollmentAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  studentId: string;
  fields: Readonly<Record<string, unknown>>;
  purchasedHours: number;
  bonusHours: number;
  subject: string;
  expectedVersions: Readonly<{ students: number; lpItems: number; tasks: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<DirectEnrollmentCommitResult[]>(DIRECT_ENROLLMENT_ATOMIC_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_student_id: input.studentId,
    p_lp_fields: input.fields,
    p_purchased_hours: input.purchasedHours,
    p_bonus_hours: input.bonusHours,
    p_subject: input.subject,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
  });
}

export function getStudentDirectEnrollmentCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<DirectEnrollmentCommandResult[]>(DIRECT_ENROLLMENT_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

/** Server derives the student row and initial tasks; this wrapper never accepts arrays. */
export function createStudentWithTasksAtomic(input: {
  commandKey: string; commandIntent: Readonly<Record<string, unknown>>;
  studentFields: Readonly<Record<string, unknown>>;
  expectedVersions: Readonly<{ students: number; tasks: number }>; actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentCreationCommitResult[]>(STUDENT_CREATION_ATOMIC_RPC, {
    p_secret: secret, p_command_key: input.commandKey, p_command_intent: input.commandIntent,
    p_student_fields: input.studentFields, p_expected_versions: input.expectedVersions, p_actor: input.actor,
  });
}

export function getStudentCreationCommandResult(input: { commandKey: string; commandIntent: Readonly<Record<string, unknown>>; actor: string }) {
  const { secret } = configuration();
  return rpc<StudentCreationCommandResult[]>(STUDENT_CREATION_COMMAND_RESULT_RPC, {
    p_secret: secret, p_command_key: input.commandKey, p_command_intent: input.commandIntent, p_actor: input.actor,
  });
}

/** Legacy exception workflows append only server-derived rows in one transaction. */
export function mutateLegacyOperationTaskAtomic(input: {
  commandKey: string; commandIntent: Readonly<Record<string, unknown>>;
  type: "学生请假" | "停课" | "换老师"; detail: string; studentId?: string; teacherId?: string;
  eventStart: string; eventEnd: string; sourceBookingId?: string;
  expectedVersions: Readonly<{ bookings: number; operations: number; students: number; tasks: number; teachers: number }>; actor: string;
}) {
  const { secret } = configuration();
  return rpc<LegacyOperationTaskCommitResult[]>(LEGACY_OPERATION_TASK_ATOMIC_RPC, {
    p_secret: secret, p_command_key: input.commandKey, p_command_intent: input.commandIntent,
    p_type: input.type, p_detail: input.detail, p_student_id: input.studentId ?? null, p_teacher_id: input.teacherId ?? null,
    p_event_start: input.eventStart, p_event_end: input.eventEnd, p_source_booking_id: input.sourceBookingId ?? null,
    p_expected_versions: input.expectedVersions, p_actor: input.actor,
  });
}

export function getLegacyOperationTaskCommandResult(input: { commandKey: string; commandIntent: Readonly<Record<string, unknown>>; actor: string }) {
  const { secret } = configuration();
  return rpc<LegacyOperationTaskCommandResult[]>(LEGACY_OPERATION_TASK_COMMAND_RESULT_RPC, {
    p_secret: secret, p_command_key: input.commandKey, p_command_intent: input.commandIntent, p_actor: input.actor,
  });
}

export function mutateLpAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  operation: "create" | "revise";
  studentId?: string;
  provisionalIntake?: Readonly<{ course: string; guardianWechat: string; owner: string; planner: string }>;
  lpItemId?: string;
  workflowType?: string;
  fields: Readonly<Record<string, unknown>>;
  revisionNote?: string;
  authorizedAssignment: Readonly<{ owner: string; planner: string; mayReassign: boolean }>;
  expectedVersions: Readonly<{ students: number; lpItems: number; tasks: number; files: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<LpAtomicCommitResult[]>(LP_ATOMIC_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_operation: input.operation,
    p_student_id: input.studentId ?? null,
    p_provisional_intake: input.provisionalIntake ?? null,
    p_lp_item_id: input.lpItemId ?? null,
    p_workflow_type: input.workflowType ?? null,
    p_fields: input.fields,
    p_revision_note: input.revisionNote ?? null,
    p_authorized_assignment: input.authorizedAssignment,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
  });
}

export function getLpAtomicCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<LpAtomicCommandResult[]>(LP_ATOMIC_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

/** Applies one manual trial-ledger field with field-level OCC under the LP row lock. */
export function mutateTrialLedgerFieldAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  lpItemId: string;
  field: string;
  expectedValue: string | boolean | null;
  value: string | boolean | null;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TrialLedgerCommitResult[]>(TRIAL_LEDGER_ATOMIC_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_lp_item_id: input.lpItemId,
    p_field: input.field,
    p_expected_value: input.expectedValue,
    p_value: input.value,
    p_actor: input.actor,
  });
}

/** Recovers the authoritative receipt for an already committed ledger edit. */
export function getTrialLedgerCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TrialLedgerCommandResult[]>(TRIAL_LEDGER_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

/** Claims one durable batch for the external Tencent Docs MCP bridge. */
export function claimTencentTrialLedgerSyncBatch(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}) {
  const { secret } = configuration();
  return rpc<TencentTrialLedgerSyncClaim[]>(TENCENT_TRIAL_LEDGER_SYNC_CLAIM_RPC, {
    p_secret: secret,
    p_worker_id: input.workerId,
    p_limit: input.limit ?? 100,
    p_lease_seconds: input.leaseSeconds ?? 300,
  });
}

/** Acknowledges a batch only after Tencent records have been read back. */
export function completeTencentTrialLedgerSyncBatch(input: {
  leaseToken: string;
  payloadSha256: string;
  recordMappings: readonly Readonly<{
    lpItemId: string;
    recordId: string;
    payloadSha256: string;
  }>[];
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<readonly Readonly<{
    completed: boolean;
    completed_event_count: number;
    synced_record_count: number;
  }>[]>(TENCENT_TRIAL_LEDGER_SYNC_COMPLETE_RPC, {
    p_secret: secret,
    p_lease_token: input.leaseToken,
    p_payload_sha256: input.payloadSha256,
    p_record_count: input.recordMappings.length,
    p_record_mappings: input.recordMappings,
    p_actor: input.actor,
  });
}

/** Releases a failed MCP write with bounded database-owned backoff. */
export function failTencentTrialLedgerSyncBatch(input: {
  leaseToken: string;
  errorCode: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<readonly Readonly<{
    failed: boolean;
    dead: boolean;
    retry_at: string;
  }>[]>(TENCENT_TRIAL_LEDGER_SYNC_FAIL_RPC, {
    p_secret: secret,
    p_lease_token: input.leaseToken,
    p_error_code: input.errorCode,
    p_actor: input.actor,
  });
}

export function getTencentTrialLedgerSyncStatus() {
  const { secret } = configuration();
  return rpc<TencentTrialLedgerSyncStatus[]>(TENCENT_TRIAL_LEDGER_SYNC_STATUS_RPC, {
    p_secret: secret,
  });
}

export function getOpsVersions() {
  const { secret } = configuration();
  return rpc<OpsVersionRow[]>("get_ops_versions", { p_secret: secret });
}

/** Database derives the complete payment reminder projection under five locks. */
export function reconcileTrialPaymentTasksAuthoritative(input: {
  runKey: string;
  expectedVersions: Readonly<Record<"bookings" | "students" | "lpItems" | "tasks" | "teachers", number>>;
}) {
  const { secret } = configuration();
  return rpc<TrialPaymentReconcileResult[]>(TRIAL_PAYMENT_RECONCILE_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_expected_versions: input.expectedVersions,
    p_actor: "Trial Payment Scheduler",
  });
}

/** Completes one exact planner-assigned payment task without a client task payload. */
export function completeTrialPaymentTaskAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  taskId: string;
  expectedVersions: Readonly<Record<"bookings" | "students" | "lpItems" | "tasks" | "teachers", number>>;
  actor: string;
  actorRole: "admin" | "limited-admin" | "staff" | "teacher";
}) {
  const { secret } = configuration();
  return rpc<TrialPaymentCompletionResult[]>(TRIAL_PAYMENT_COMPLETE_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_task_id: input.taskId,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
    p_actor_role: input.actorRole,
  });
}

/** Completes one exact Jiaowubao-linked planner reminder under the same five locks. */
export function completeJiaowubaoTrialPaymentTaskAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  taskId: string;
  expectedVersions: Readonly<Record<"bookings" | "students" | "lpItems" | "tasks" | "teachers", number>>;
  actor: string;
  actorRole: "admin" | "limited-admin" | "staff" | "teacher";
}) {
  const { secret } = configuration();
  return rpc<TrialPaymentCompletionResult[]>(JIAOWUBAO_TRIAL_PAYMENT_COMPLETE_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_task_id: input.taskId,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
    p_actor_role: input.actorRole,
  });
}

/** Reads only an actor-bound immutable receipt; it returns no operational rows. */
export function getTrialPaymentCompletionCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  taskId: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TrialPaymentCompletionCommandResult[]>(TRIAL_PAYMENT_COMPLETION_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_task_id: input.taskId,
    p_actor: input.actor,
  });
}

/** Atomically completes or reopens one payment task and its LP paid flag. */
export function mutateTrialPaymentTaskLifecycleAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  action: "complete" | "reopen";
  taskId: string;
  expectedVersions: Readonly<Record<"bookings" | "students" | "lpItems" | "tasks" | "teachers", number>>;
  actor: string;
  actorRole: "admin" | "limited-admin" | "staff" | "teacher";
}) {
  const { secret } = configuration();
  return rpc<TrialPaymentLifecycleResult[]>(TRIAL_PAYMENT_LIFECYCLE_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_action: input.action,
    p_task_id: input.taskId,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
    p_actor_role: input.actorRole,
  });
}

/** Reads one actor-bound payment lifecycle receipt without operational rows. */
export function getTrialPaymentLifecycleCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  action: "complete" | "reopen";
  taskId: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TrialPaymentLifecycleCommandResult[]>(TRIAL_PAYMENT_LIFECYCLE_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_action: input.action,
    p_task_id: input.taskId,
    p_actor: input.actor,
  });
}

/** Starts one server-owned LP scheduler attempt in the internal audit ledger. */
export function beginLpParentProgressSchedulerRun(input: {
  runKey: string;
  sourceDigest: string;
  sourceVersions: Readonly<Record<string, number>>;
  taskVersionBefore: number;
  targetTasks: readonly Record<string, unknown>[];
  processedCount: number;
  changedCount: number;
}) {
  const { secret } = configuration();
  return rpc<Readonly<{ run_key: string; outcome: "running"; audit_entry_id: string }[]>>(
    LP_PARENT_PROGRESS_SCHEDULER_BEGIN_RPC,
    {
      p_secret: secret,
      p_run_key: input.runKey,
      p_source_digest: input.sourceDigest,
      p_source_versions: input.sourceVersions,
      p_task_version_before: input.taskVersionBefore,
      p_target_tasks: input.targetTasks,
      p_processed_count: input.processedCount,
      p_changed_count: input.changedCount,
    },
  );
}

/** Finishes one LP scheduler attempt. A duplicate finish is a safe replay. */
export function finishLpParentProgressSchedulerRun(input: {
  runKey: string;
  outcome: "no_change" | "failed";
  errorCode?: string;
}) {
  const { secret } = configuration();
  return rpc<Readonly<{ run_key: string; outcome: string; audit_entry_id: string }[]>>(
    LP_PARENT_PROGRESS_SCHEDULER_FINISH_RPC,
    {
      p_secret: secret,
      p_run_key: input.runKey,
      p_outcome: input.outcome,
      p_error_code: input.errorCode ?? null,
    },
  );
}

/**
 * Commits only the scheduler's derived task projection while locking the
 * authoritative bookings/lpItems versions again in PostgreSQL.
 */
export function putLpParentProgressSchedulerTasks(input: {
  runKey: string;
  tasks: readonly Record<string, unknown>[];
}) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>(LP_PARENT_PROGRESS_SCHEDULER_COMMIT_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_tasks: input.tasks,
    p_actor: "LP Scheduler",
  });
}

/** Converges old `running` attempts without ever inferring an applied write. */
export function recoverStaleLpParentProgressSchedulerRuns() {
  const { secret } = configuration();
  return rpc<Readonly<{ recovered_no_change: number; recovered_failed: number }[]>>(
    LP_PARENT_PROGRESS_SCHEDULER_RECOVER_RPC,
    { p_secret: secret },
  );
}

export function getOpsSources() {
  const { secret } = configuration();
  return rpc<OpsSourceRow[]>("get_ops_sources", { p_secret: secret });
}

/** Persists a worker-normalised WeCom batch and projects only unique exact matches. */
export function ingestWecomArchiveBatch(input: {
  records: readonly Readonly<Record<string, unknown>>[];
  startedAt: string;
  actor?: string;
}) {
  const { secret } = configuration();
  return rpc<WecomArchiveIngestResult>(WECOM_ARCHIVE_INGEST_RPC, {
    p_secret: secret,
    p_records: input.records,
    p_started_at: input.startedAt,
    p_actor: input.actor ?? "WeCom Archive Worker",
  });
}

/** Stores bot callbacks, groups trial handovers by explicit WeChat identity,
 * and auto-projects only unique exact active-student matches. */
export function ingestWecomBotBatch(input: {
  records: readonly Readonly<Record<string, unknown>>[];
  startedAt: string;
}) {
  const { secret } = configuration();
  return rpc<WecomBotIngestResult>(WECOM_BOT_INGEST_RPC, {
    p_secret: secret,
    p_records: input.records,
    p_started_at: input.startedAt,
    p_actor: "WeCom Bot Receiver",
  });
}

export function readWecomArchiveInbox(limit = 100) {
  const { secret } = configuration();
  return rpc<WecomArchiveInboxRow[]>(WECOM_ARCHIVE_INBOX_RPC, {
    p_secret: secret,
    p_limit: limit,
  });
}

/** Case-first inbox: older unresolved identities must not age out behind messages. */
export function readWecomHandoverCases(input: {
  filter: import("./wecom-handover-review").WecomHandoverFilter;
  cursor: string | null;
}) {
  return rpc<import("./wecom-handover-review").WecomHandoverCasePage>("read_wecom_handover_cases", {
    p_secret: configuration().secret, p_filter: input.filter, p_cursor: input.cursor, p_limit: 30,
  });
}

/** Full-admin review action for records that could not be uniquely matched. */
export function linkWecomArchiveMessage(input: { messageId: string; studentId: string; actor: string }) {
  const { secret } = configuration();
  return rpc<Readonly<{
    messageId: string;
    studentId: string;
    messageProjected: boolean;
    fileCount: number;
    auditEntryId: string;
  }>>(WECOM_ARCHIVE_LINK_RPC, {
    p_secret: secret,
    p_message_id: input.messageId,
    p_student_id: input.studentId,
    p_actor: input.actor,
  });
}

export function getWecomArchiveMedia(id: string) {
  const { secret } = configuration();
  return rpc<WecomArchiveMedia | null>(WECOM_ARCHIVE_MEDIA_RPC, {
    p_secret: secret,
    p_id: id,
  });
}

export function getWecomArchiveStatus() {
  const { secret } = configuration();
  return rpc<WecomArchiveStatus>(WECOM_ARCHIVE_STATUS_RPC, { p_secret: secret });
}

export function recordWecomReceiverHealth(
  health: import("./wecom-receiver-health").WecomReceiverHealth,
) {
  const { secret } = configuration();
  return rpc<Readonly<{ outcome: "committed"; recordedAt: string }>>(
    WECOM_RECEIVER_HEALTH_RECORD_RPC,
    { p_secret: secret, p_health: health },
  );
}

/** Server-only source snapshot writer; callers are cron/management code, never browser code. */
export function claimJiaowubaoOpenApiScheduleSyncLease(input: {
  apiSourceKey: string;
  runKey: string;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleSyncLease>(JIAOWUBAO_OPEN_API_SCHEDULE_LEASE_CLAIM_RPC, {
    p_secret: secret,
    p_api_source_key: input.apiSourceKey,
    p_run_key: input.runKey,
    p_actor: input.actor,
  }, options);
}

export function releaseJiaowubaoOpenApiScheduleSyncLease(input: {
  apiSourceKey: string;
  runKey: string;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<Readonly<{ released: boolean }>>(JIAOWUBAO_OPEN_API_SCHEDULE_LEASE_RELEASE_RPC, {
    p_secret: secret,
    p_api_source_key: input.apiSourceKey,
    p_run_key: input.runKey,
    p_actor: input.actor,
  }, options);
}

export function confirmJiaowubaoOpenApiScheduleSnapshotCurrent(input: {
  apiSourceKey: string;
  revision: string;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<Readonly<{
    confirmed: boolean;
    revision: string;
    rowCount: number;
    publishedAt: string;
  }>>(JIAOWUBAO_OPEN_API_SCHEDULE_CONFIRM_RPC, {
    p_secret: secret,
    p_api_source_key: input.apiSourceKey,
    p_revision: input.revision,
    p_actor: input.actor,
  }, options);
}

export function beginJiaowubaoOpenApiScheduleSnapshot(input: {
  envelope: Readonly<Record<string, unknown>>;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleSnapshotBeginReceipt>(JIAOWUBAO_OPEN_API_SCHEDULE_BEGIN_RPC, {
    p_secret: secret,
    p_envelope: input.envelope,
    p_actor: input.actor,
  }, options);
}

export function beginJiaowubaoScheduleHorizonCollection(input: {
  runKey: string;
  window: Readonly<{ start: string; end: string }>;
  expectedCurrentRevision: string | null;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoScheduleHorizonCollectionReceipt>(JIAOWUBAO_SCHEDULE_HORIZON_BEGIN_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_window_start: input.window.start,
    p_window_end: input.window.end,
    p_expected_current_revision: input.expectedCurrentRevision,
    p_actor: input.actor,
  }, options);
}

export function stageJiaowubaoScheduleHorizonPage(input: {
  runKey: string;
  runId: string;
  passNumber: number;
  windowIndex: number;
  pageNumber: number;
  rows: readonly Readonly<{ sourceKey: string; record: Readonly<Record<string, unknown>> }>[];
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoScheduleHorizonCollectionReceipt>(JIAOWUBAO_SCHEDULE_HORIZON_STAGE_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_run_id: input.runId,
    p_pass_number: input.passNumber,
    p_window_index: input.windowIndex,
    p_page_number: input.pageNumber,
    p_rows: input.rows,
    p_actor: input.actor,
  }, options);
}

export function readJiaowubaoScheduleHorizonPages(input: {
  runKey: string;
  runId: string;
  offset: number;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoScheduleHorizonPageBatch>(JIAOWUBAO_SCHEDULE_HORIZON_READ_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_run_id: input.runId,
    p_offset: input.offset,
    p_actor: input.actor,
  }, options);
}

export function closeJiaowubaoScheduleHorizonCollection(input: {
  runKey: string;
  runId: string;
  publishedRevision: string;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<Readonly<{ runId: string; closed: boolean }>>(JIAOWUBAO_SCHEDULE_HORIZON_CLOSE_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_run_id: input.runId,
    p_published_revision: input.publishedRevision,
    p_actor: input.actor,
  }, options);
}

export function abortJiaowubaoScheduleHorizonCollection(input: {
  runKey: string;
  runId: string;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<Readonly<{ runId: string; aborted: boolean }>>(JIAOWUBAO_SCHEDULE_HORIZON_ABORT_RPC, {
    p_secret: secret,
    p_run_key: input.runKey,
    p_run_id: input.runId,
    p_actor: input.actor,
  }, options);
}

export function stageJiaowubaoOpenApiScheduleSnapshotPage(input: {
  runId: string;
  pageIndex: number;
  rows: readonly Readonly<Record<string, unknown>>[];
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleSnapshotPageReceipt>(JIAOWUBAO_OPEN_API_SCHEDULE_STAGE_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_page_index: input.pageIndex,
    p_rows: input.rows,
    p_actor: input.actor,
  }, options);
}

export function completeJiaowubaoOpenApiScheduleSnapshot(
  input: { runId: string; actor: "Ops Admin" },
  options: OpsRpcOptions = {},
) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleSnapshotCompleteReceipt>(JIAOWUBAO_OPEN_API_SCHEDULE_COMPLETE_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_actor: input.actor,
  }, options);
}

/** Server-only completed-lesson evidence writer; it never changes ops_state. */
export function getJiaowubaoCompletedLessonSnapshotPreflight(input: { month: string; actor: "Ops Admin" }) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotPreflight>(JIAOWUBAO_COMPLETED_LESSON_PREFLIGHT_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_actor: input.actor,
  });
}

export function beginJiaowubaoCompletedLessonSnapshot(input: {
  envelope: Readonly<Record<string, unknown>>;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotReceipt>(JIAOWUBAO_COMPLETED_LESSON_BEGIN_RPC, {
    p_secret: secret,
    p_envelope: input.envelope,
    p_actor: input.actor,
  });
}

export function stageJiaowubaoCompletedLessonSnapshotPage(input: {
  runId: string;
  pageIndex: number;
  rows: readonly Readonly<Record<string, unknown>>[];
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotReceipt>(JIAOWUBAO_COMPLETED_LESSON_STAGE_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_page_index: input.pageIndex,
    p_rows: input.rows,
    p_actor: input.actor,
  });
}

/** Stages the private query_schedule_list(over=1) sidecar for the same run. */
export function stageJiaowubaoCompletedScheduleSnapshotPage(input: {
  runId: string;
  pageIndex: number;
  rows: readonly Readonly<Record<string, unknown>>[];
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotReceipt>(JIAOWUBAO_COMPLETED_LESSON_SCHEDULE_STAGE_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_page_index: input.pageIndex,
    p_rows: input.rows,
    p_actor: input.actor,
  });
}

export function completeJiaowubaoCompletedLessonSnapshot(input: { runId: string; actor: "Ops Admin" }) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotReceipt>(JIAOWUBAO_COMPLETED_LESSON_COMPLETE_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_actor: input.actor,
  });
}

/** Best-effort cleanup for a failed staging run; completed evidence is immutable. */
export function abortJiaowubaoCompletedLessonSnapshot(input: { runId: string; actor: "Ops Admin" }) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotReceipt>(JIAOWUBAO_COMPLETED_LESSON_ABORT_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_actor: input.actor,
  });
}

export function confirmJiaowubaoCompletedLessonSnapshotCurrent(input: {
  month: string;
  revision: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<Readonly<{ confirmed: boolean; revision: string; rowCount: number; scheduleRowCount?: number; publishedAt: string }>>(
    JIAOWUBAO_COMPLETED_LESSON_CONFIRM_RPC,
    { p_secret: secret, p_month: input.month, p_revision: input.revision, p_actor: input.actor },
  );
}

/**
 * Reads one bounded browser page from the immutable completed-lesson source.
 * A supplied revision pins continuation pages to the same published month.
 */
export function getJiaowubaoCompletedLessonSnapshotPage(input: {
  month: string;
  pageIndex: number;
  revision: string | null;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotPage>(JIAOWUBAO_COMPLETED_LESSON_READER_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_page_index: input.pageIndex,
    p_expected_revision: input.revision,
    p_actor: input.actor,
  }, { timeoutMs: 30_000 });
}

/** Reads one revision-pinned private page of completed schedule role evidence. */
export function getJiaowubaoCompletedScheduleSnapshotPage(input: {
  month: string;
  pageIndex: number;
  revision: string | null;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSnapshotPage>(JIAOWUBAO_COMPLETED_LESSON_SCHEDULE_READER_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_page_index: input.pageIndex,
    p_expected_revision: input.revision,
    p_actor: input.actor,
  }, { timeoutMs: 30_000 });
}

export function claimJiaowubaoCompletedLessonSyncLease(input: {
  month: string;
  runKey: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonSyncLease>(JIAOWUBAO_COMPLETED_LESSON_LEASE_CLAIM_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_run_key: input.runKey,
    p_actor: input.actor,
  });
}

export function releaseJiaowubaoCompletedLessonSyncLease(input: {
  month: string;
  runKey: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<Readonly<{ released: boolean }>>(JIAOWUBAO_COMPLETED_LESSON_LEASE_RELEASE_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_run_key: input.runKey,
    p_actor: input.actor,
  });
}

/** Private resumable cursor; member IDs never leave the server sync path. */
export function getJiaowubaoCompletedLessonMemberCollection(input: {
  month: string;
  runKey: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberCollection>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_GET_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_run_key: input.runKey,
    p_actor: input.actor,
  });
}

/** Lets the scheduler resume an older manually-started month before starting a new one. */
export function getJiaowubaoCompletedLessonPendingMonth(input: { actor: "Ops Admin" }) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonPendingMonth>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_PENDING_RPC, {
    p_secret: secret,
    p_actor: input.actor,
  });
}

export function beginJiaowubaoCompletedLessonMemberCollection(input: {
  month: string;
  runKey: string;
  scheduleRevision: string;
  scheduleMemberIds: readonly number[];
  scheduleMemberSetSha256: string;
  expectedCurrentRevision: string | null;
  force: boolean;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberCollection>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_BEGIN_RPC, {
    p_secret: secret,
    p_month: input.month,
    p_run_key: input.runKey,
    p_schedule_revision: input.scheduleRevision,
    p_schedule_member_ids: input.scheduleMemberIds,
    p_schedule_member_set_sha256: input.scheduleMemberSetSha256,
    p_expected_current_revision: input.expectedCurrentRevision,
    p_force: input.force,
    p_actor: input.actor,
  }, { timeoutMs: 30_000 });
}

export function reserveJiaowubaoCompletedLessonApiRequest(input: {
  month: string;
  runKey: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<Readonly<{ tool: "query_lesson_list"; notBefore: string }>>(
    JIAOWUBAO_COMPLETED_LESSON_MEMBER_RESERVE_RPC,
    { p_secret: secret, p_month: input.month, p_run_key: input.runKey, p_tool: "query_lesson_list", p_actor: input.actor },
  );
}

/** Cross-instance supplier start gate shared by both scheduled schedule readers. */
export function reserveJiaowubaoOpenApiScheduleRequest(
  input: { actor: "Ops Admin" },
  options: OpsRpcOptions = {},
) {
  const { secret } = configuration();
  return rpc<Readonly<{ tool: "query_schedule_list"; notBefore: string }>>(
    JIAOWUBAO_OPEN_API_SCHEDULE_RESERVE_RPC,
    { p_secret: secret, p_tool: "query_schedule_list", p_actor: input.actor },
    options,
  );
}

export function stageJiaowubaoCompletedLessonMemberPage(input: {
  runId: string;
  runKey: string;
  memberId: number;
  page: number;
  targetVersion: number;
  sourceTotal: number;
  rows: readonly Readonly<Record<string, unknown>>[];
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberCollection>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_STAGE_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_run_key: input.runKey,
    p_member_id: input.memberId,
    p_page: input.page,
    p_expected_target_version: input.targetVersion,
    p_source_total: input.sourceTotal,
    p_rows: input.rows,
    p_actor: input.actor,
  }, { timeoutMs: 30_000 });
}

export function getJiaowubaoCompletedLessonMemberItemsPage(input: {
  runId: string;
  runKey: string;
  pageIndex: number;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberItemsPage>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_ITEMS_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_run_key: input.runKey,
    p_page_index: input.pageIndex,
    p_actor: input.actor,
  }, { timeoutMs: 30_000 });
}

export function prepareJiaowubaoCompletedLessonMemberPublication(input: {
  runId: string;
  runKey: string;
  revision: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberCollection>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_PREPARE_RPC, {
    p_secret: secret, p_run_id: input.runId, p_run_key: input.runKey, p_revision: input.revision, p_actor: input.actor,
  });
}

export function completeJiaowubaoCompletedLessonMemberPublication(input: {
  runId: string;
  runKey: string;
  revision: string;
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberCollection>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_PUBLISH_RPC, {
    p_secret: secret, p_run_id: input.runId, p_run_key: input.runKey, p_revision: input.revision, p_actor: input.actor,
  });
}

export function abortJiaowubaoCompletedLessonMemberCollection(input: {
  runId: string;
  runKey: string;
  reason: "schedule_changed" | "source_conflict" | "caller_failure" | "catalog_changed";
  actor: "Ops Admin";
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoCompletedLessonMemberCollection>(JIAOWUBAO_COMPLETED_LESSON_MEMBER_ABORT_RPC, {
    p_secret: secret, p_run_id: input.runId, p_run_key: input.runKey, p_reason: input.reason, p_actor: input.actor,
  });
}

/**
 * Projects one exact completed Open API snapshot, atomically synchronizes its
 * native students/teachers/courses/bookings, and verifies the post-write match.
 */
export function projectJiaowubaoOpenApiAuthority(input: {
  revision: string;
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiAuthorityProjectionReceipt>(JIAOWUBAO_OPEN_API_AUTHORITY_PROJECT_RPC, {
    p_secret: secret,
    p_revision: input.revision,
    p_actor: input.actor,
  }, { ...options, timeoutMs: options.timeoutMs ?? 115_000 });
}

export function getJiaowubaoOpenApiScheduleSnapshotStatus(input: { runId: string; actor: "Ops Admin" }) {
  const { secret } = configuration();
  return rpc<Readonly<Record<string, unknown>>>(JIAOWUBAO_OPEN_API_SCHEDULE_STATUS_RPC, {
    p_secret: secret,
    p_run_id: input.runId,
    p_actor: input.actor,
  });
}

/**
 * Reads the immutable Open API source pointer. Source teacher/member keys are
 * consumed by the server route and never returned to a browser DTO.
 */
export function getJiaowubaoOpenApiScheduleSnapshotWindow(input: {
  windowStart: string;
  windowEnd: string;
  scope: "all" | "teacher" | "student" | "availability";
  teacherLabels: readonly string[] | null;
  studentMemberIds: readonly string[] | null;
  studentNameKeys: readonly string[] | null;
  limit: number;
  cursor: Readonly<{ startsAt: string; eventId: string }> | null;
  revision: string | null;
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleSnapshotWindow>(JIAOWUBAO_OPEN_API_SCHEDULE_READER_RPC, {
    p_secret: secret,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_scope: input.scope,
    p_scope_teacher_labels: input.teacherLabels,
    p_scope_student_member_ids: input.studentMemberIds,
    p_scope_student_name_keys: input.studentNameKeys,
    p_limit: input.limit,
    p_cursor_start: input.cursor?.startsAt ?? null,
    p_cursor_event_id: input.cursor?.eventId ?? null,
    p_snapshot_revision: input.revision,
  }, options);
}

export function getJiaowubaoOpenApiScheduleProjectionTarget(
  input: { actor: "Ops Admin" },
  options: OpsRpcOptions = {},
) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleProjectionTarget>(
    JIAOWUBAO_OPEN_API_SCHEDULE_PROJECTION_TARGET_RPC,
    { p_secret: secret, p_actor: input.actor },
    options,
  );
}

export function advanceJiaowubaoOpenApiScheduleProjection(input: {
  revision: string;
  expectedState: "pending" | "authority_done" | "complete";
  nextState: "pending" | "authority_done" | "complete";
  actor: "Ops Admin";
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoOpenApiScheduleProjectionTransition>(
    JIAOWUBAO_OPEN_API_SCHEDULE_PROJECTION_ADVANCE_RPC,
    {
      p_secret: secret,
      p_revision: input.revision,
      p_expected_state: input.expectedState,
      p_next_state: input.nextState,
      p_actor: input.actor,
    },
    options,
  );
}

/** Commits the server-derived LP/task projection as one OCC transaction. */
export function syncJiaowubaoTrialMatchesAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  snapshotRevision: string;
  matches: readonly Readonly<{ lpItemId: string; eventId: string; startsAt: string }>[];
  revocations?: readonly Readonly<{ lpItemId: string; eventId: string; startsAt: string }>[];
  expectedVersions: Readonly<{ lpItems: number; tasks: number }>;
  nextLpItems: readonly unknown[];
  nextTasks: readonly unknown[];
  actor: string;
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<JiaowubaoTrialSyncCommitResult[]>(JIAOWUBAO_TRIAL_SYNC_ATOMIC_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_snapshot_revision: input.snapshotRevision,
    p_matches: input.matches,
    p_revocations: input.revocations ?? [],
    p_expected_versions: input.expectedVersions,
    p_next_lp_items: input.nextLpItems,
    p_next_tasks: input.nextTasks,
    p_actor: input.actor,
  }, options);
}

/** Reads an already committed command before any source/OCC revalidation. */
export function getJiaowubaoTrialSyncCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoTrialSyncCommandResult[]>(JIAOWUBAO_TRIAL_SYNC_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_uuid: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  });
}

/**
 * Calendar-window reader for imported class events. The API route, not the
 * browser, derives any teacher/student filter from the signed access scope.
 */
export function getJiaowubaoDirectScheduleWindow(input: {
  windowStart: string;
  windowEnd: string;
  scope: "all" | "teacher" | "student" | "availability";
  teacherIds: readonly string[] | null;
  studentIds: readonly string[] | null;
  /** The route fixes this to a safe page size; callers cannot enlarge it. */
  limit: number;
  cursor: JiaowubaoDirectScheduleCursor | null;
  runToken: string | null;
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoDirectScheduleWindow>(JIAOWUBAO_DIRECT_SCHEDULE_WINDOW_RPC, {
    p_secret: secret,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_scope: input.scope,
    p_scope_teacher_ids: input.teacherIds,
    p_scope_student_ids: input.studentIds,
    p_limit: input.limit,
    p_cursor_start: input.cursor?.startsAt ?? null,
    p_cursor_event_id: input.cursor?.eventId ?? null,
    p_run_token: input.runToken,
  });
}

/** Curated supplemental history for one already-authorized formal student. */
export function getJiaowubaoDirectStudentHistory(studentId: string, limit = 200) {
  const { secret } = configuration();
  return rpc<JiaowubaoDirectStudentHistory>(JIAOWUBAO_DIRECT_STUDENT_HISTORY_RPC, {
    p_secret: secret,
    p_student_id: studentId,
    p_limit: limit,
  });
}

/**
 * Server-owned operations-readiness reader. Every limit is fixed by the API
 * route; the browser cannot expand a queue or name a raw source scope.
 */
export function getJiaowubaoDirectOperationsReadiness(input: {
  windowStart: string;
  windowEnd: string;
  scheduleLimit: number;
  leaveMakeupLimit: number;
  renewalLimit: number;
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoDirectOperationsReadiness>(JIAOWUBAO_DIRECT_OPERATIONS_READINESS_RPC, {
    p_secret: secret,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_schedule_limit: input.scheduleLimit,
    p_leave_makeup_limit: input.leaveMakeupLimit,
    p_renewal_limit: input.renewalLimit,
  });
}

/**
 * Server-only, cursor-bounded mapping evidence reader. The browser cannot
 * supply raw source labels, event IDs, run IDs, page limits or SQL filters.
 */
export function getJiaowubaoDirectScheduleMappingReview(input: {
  cursor: string | null;
  limit: number;
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoDirectScheduleMappingReview>(JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_REVIEW_RPC, {
    p_secret: secret,
    p_limit: input.limit,
    p_after_mapping_key: input.cursor,
  });
}

/**
 * Server-only current/future queue.  The route fixes both the review window
 * and page limit; callers cannot pass a run ID, raw source filter, or target.
 */
export function getJiaowubaoDirectScheduleMappingPriorityReview(input: {
  windowStart: string;
  windowEnd: string;
  cursor: string | null;
  limit: number;
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoDirectScheduleMappingPriorityReview>(
    JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PRIORITY_REVIEW_RPC,
    {
      p_secret: secret,
      p_window_start: input.windowStart,
      p_window_end: input.windowEnd,
      p_limit: input.limit,
      p_after_mapping_key: input.cursor,
    },
  );
}

/**
 * Persists exactly one opaque source candidate decision. PostgreSQL resolves
 * the candidate and current teacher/subject authority again under locks.
 */
export function putJiaowubaoDirectScheduleMapping(input: {
  mappingKey: string;
  commandKey: string;
  action: "confirm" | "revoke";
  targetTeacherId: string | null;
  targetSubjectId: string | null;
  expectedTeachersVersion: number;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<JiaowubaoDirectScheduleMappingSaveResult>(JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PUT_RPC, {
    p_secret: secret,
    p_mapping_key: input.mappingKey,
    p_command_key: input.commandKey,
    p_action: input.action,
    p_target_teacher_id: input.targetTeacherId,
    p_target_subject_id: input.targetSubjectId,
    p_expected_teachers_version: input.expectedTeachersVersion,
    p_actor: input.actor,
  });
}

export function getTeacherAvailabilitySubmissions() {
  const { secret } = configuration();
  return rpc<TeacherAvailabilitySubmissionRow[]>(TEACHER_AVAILABILITY_SUBMISSIONS_RPC, {
    p_secret: secret,
  });
}

/**
 * Server-only, bounded presence reader for the AVA completion surface. The
 * route fixes the Melbourne month and cap; browser code never supplies either.
 */
export function getTeacherAvailabilityCompletionPendingTeacherIds(input: {
  month: string;
  limit: number;
}) {
  const { secret } = configuration();
  return rpc<TeacherAvailabilityCompletionPendingTeacherIds[]>(
    TEACHER_AVAILABILITY_COMPLETION_PENDING_TEACHERS_RPC,
    {
      p_secret: secret,
      p_month: input.month,
      p_limit: input.limit,
    },
  );
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
 * Previews only the closed, one-to-one Latin-parenthetical JWB annotation
 * exception. The database binds the returned opaque key to both source
 * hashes, student version, review epoch, duplicate decisions and link set.
 */
export function getStudentImportIdentityAnnotationReviewPreview() {
  const { secret } = configuration();
  return rpc<StudentImportIdentityAnnotationReviewPreview>(
    STUDENT_IMPORT_IDENTITY_ANNOTATION_PREVIEW_RPC,
    { p_secret: secret },
  );
}

/** Persists only the DB-recomputed annotation candidate set behind a CAS key. */
export function putStudentImportIdentityAnnotationReview(input: {
  confirmationKey: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentImportIdentityAnnotationReviewResult>(
    STUDENT_IMPORT_IDENTITY_ANNOTATION_PUT_RPC,
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
    formalImportDate: string;
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
  student_id: string;
  previous_student_id: string;
  teacher_id: string;
  previous_teacher_id: string;
  bookings_row: OpsStateRow;
  students_row: OpsStateRow;
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
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
  student_id: string;
  previous_student_id: string;
  teacher_id: string;
  previous_teacher_id: string;
  actor_role: "admin" | "limited-admin" | "staff" | "teacher";
  booking_version: number;
  student_version: number;
  lp_item_version: number;
  task_version: number;
  teacher_version: number;
  bookings_row: OpsStateRow;
  students_row: OpsStateRow;
  lp_items_row: OpsStateRow;
  tasks_row: OpsStateRow;
  teachers_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TemporaryClassroomCapability = Readonly<{
  available: boolean;
  contract: string;
}>;

export type TemporaryClassroomRequestClaim = Readonly<{
  request_identity: string;
  request_key: string;
  actor: string;
  intent: Readonly<Record<string, unknown>>;
  mode: "test" | "recorded";
  booking_id: string | null;
  occurrence_id: string | null;
  meeting_id: string;
  replayed: boolean;
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

export type TeacherAbsenceCreationCommitResult = Readonly<{
  command_key: string;
  applied: boolean;
  source_teacher_id: string;
  event_start: string;
  event_end: string;
  operation_ids: readonly string[];
  affected_student_ids: readonly string[];
  affected_occurrence_count: number;
  generated_task_count: number;
  operations_row: OpsStateRow;
  tasks_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type TeacherAbsenceCreationCommandResult = Readonly<{
  command_key: string;
  source_teacher_id: string;
  event_start: string;
  event_end: string;
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
  follow_up_kind: "exam_care" | "exam_recall" | "exam_month_planning" | "exam_results_follow_up";
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
  follow_up_kind: "exam_care" | "exam_recall" | "exam_month_planning" | "exam_results_follow_up";
  completion_command_key: string;
  audit_entry_id: string;
}>;

export type ExamFollowUpCompletionContextResult = Readonly<{
  command_key: string;
  task_id: string;
  student_id: string;
  exam_id: string;
  follow_up_kind: "exam_care" | "exam_recall" | "exam_month_planning" | "exam_results_follow_up";
  prior_task: Record<string, unknown>;
  prior_follow_up_state_exists: boolean;
  prior_follow_up_state: Record<string, unknown> | null;
  committed_task: Record<string, unknown>;
  committed_follow_up_state: Record<string, unknown>;
}>;

/** Server-derived result for one explicit legacy/manual task deadline repair. */
export type LegacyTaskDeadlineCommitResult = Readonly<{
  command_key: string;
  action: "set" | "clear";
  applied: boolean;
  task_id: string;
  due_at: string | null;
  task_row: OpsStateRow;
  audit_entry_id: string;
}>;

export type LegacyTaskDeadlineCommandResult = Readonly<{
  command_key: string;
  action: "set" | "clear";
  /** Whether the first execution actually changed dueAt (never repeated). */
  applied: boolean;
  task_id: string;
  due_at: string | null;
  audit_entry_id: string;
}>;

export function getBookingCapacityCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<BookingCapacityCommandResult[]>(BOOKING_CAPACITY_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_actor: input.actor,
  }, options);
}

/**
 * Capability gate for the provider-first temporary classroom saga.  The route
 * calls this before BBB so a missing/partial migration cannot create an
 * external room that the app is unable to bind atomically.
 */
export function getTemporaryClassroomCapability(options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<TemporaryClassroomCapability[]>(TEMPORARY_CLASSROOM_CAPABILITY_RPC, {
    p_secret: secret,
  }, options);
}

/** Claims the actor + requestKey identity before the external provider call. */
export function claimTemporaryClassroomRequest(input: {
  requestKey: string;
  intent: Readonly<Record<string, unknown>>;
  mode: "test" | "recorded";
  bookingId?: string;
  occurrenceId?: string;
  meetingId: string;
  actor: string;
}, options: OpsRpcOptions = {}) {
  const { secret } = configuration();
  return rpc<TemporaryClassroomRequestClaim[]>(TEMPORARY_CLASSROOM_REQUEST_CLAIM_RPC, {
    p_secret: secret,
    p_request_key: input.requestKey,
    p_intent: input.intent,
    p_mode: input.mode,
    p_booking_id: input.bookingId ?? null,
    p_occurrence_id: input.occurrenceId ?? null,
    p_meeting_id: input.meetingId,
    p_actor: input.actor,
  }, options);
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

export function getTeacherAbsenceCreationCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherAbsenceCreationCommandResult[]>(TEACHER_ABSENCE_CREATION_COMMAND_RESULT_RPC, {
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

/** Looks up an uncertain legacy deadline command without exposing task payloads. */
export function getLegacyTaskDeadlineCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<LegacyTaskDeadlineCommandResult[]>(LEGACY_TASK_DEADLINE_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
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
  expectedVersions: Readonly<{ bookings: number; students: number; lpItems: number; tasks: number; teachers: number }>;
  bookings: readonly Record<string, unknown>[];
  teachers: readonly Record<string, unknown>[];
  changedTeacherIds: readonly string[];
  studentId: string;
  teacherId: string;
  actorRole: "admin" | "limited-admin" | "staff" | "teacher";
  actor: string;
}, options: OpsRpcOptions = {}) {
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
    p_actor_role: input.actorRole,
    p_actor: input.actor,
  }, options);
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

/** Refreshes verified departure candidates without changing lesson assignments. */
export function refreshTeacherDepartureCandidatesAtomic(input: {
  operationId: string;
  expectedVersions: Readonly<{ bookings: number; operations: number; students: number; teachers: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>("refresh_teacher_departure_candidates_atomic", {
    p_secret: secret, p_operation_id: input.operationId,
    p_expected_versions: input.expectedVersions, p_actor: input.actor,
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

/** Locks all five state projections and atomically inserts teacher absence operations/tasks. */
export function createTeacherAbsenceAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  sourceTeacherId: string;
  eventStart: string;
  eventEnd: string;
  type: string;
  detail: string;
  expectedVersions: Readonly<{ bookings: number; operations: number; students: number; tasks: number; teachers: number }>;
  operations: readonly Record<string, unknown>[];
  tasks: readonly Record<string, unknown>[];
  affectedGroups: readonly Readonly<{ studentId: string; operationId: string; affectedOccurrenceIds: readonly string[]; subjects: readonly string[]; firstAffectedAt: string }>[];
  submittedAt: string;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<TeacherAbsenceCreationCommitResult[]>(TEACHER_ABSENCE_CREATION_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_source_teacher_id: input.sourceTeacherId,
    p_event_start: input.eventStart,
    p_event_end: input.eventEnd,
    p_type: input.type,
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

/**
 * Atomically writes only dueAt on a server-authorized legacy task. Historical
 * clear results remain in the receipt type solely for immutable replay.
 * The browser never supplies the task projection or a UTC timestamp.
 */
export function mutateLegacyTaskDeadlineAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  expectedVersions: Readonly<{ students: number; tasks: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<LegacyTaskDeadlineCommitResult[]>(LEGACY_TASK_DEADLINE_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_expected_versions: input.expectedVersions,
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

/** Atomically registers a normal file-center link and updates the student count. */
export function putStudentFileLinkAtomic(input: {
  commandKey: string;
  studentId: string;
  fileTitle: string;
  fileType: string;
  source: string;
  expectedVersions: Readonly<{ files: number; students: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<StudentFileLinkAtomicCommitResult[]>(STUDENT_FILE_LINK_ATOMIC_PUT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_student_id: input.studentId,
    p_file_title: input.fileTitle,
    p_file_type: input.fileType,
    p_source: input.source,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
  });
}

/** Minimal per-request state; password material is never returned by this reader. */
export async function getAppAccountAuthState(identityKey: string) {
  const { secret } = configuration();
  const rows = await rpc<AppAccountAuthState[]>(APP_ACCOUNT_AUTH_STATE_RPC, {
    p_secret: secret,
    p_identity_key: identityKey,
  });
  return rows[0] ?? null;
}

/** Server-only credential material used solely for password verification. */
export async function getAppAccountCredential(identityKey: string) {
  const { secret } = configuration();
  const rows = await rpc<AppAccountCredential[]>(APP_ACCOUNT_CREDENTIAL_RPC, {
    p_secret: secret,
    p_identity_key: identityKey,
  });
  return rows[0] ?? null;
}

/** Creates or rotates one independent account password with optimistic concurrency. */
export function putAppAccountCredentialAtomic(input: {
  commandKey: string;
  identityKey: string;
  accountName: string;
  accountRole: AppAccountAuthState["account_role"];
  passwordAlgorithm: "scrypt-v1";
  passwordHash: string;
  passwordSalt: string;
  expectedVersion: number;
  mustChangePassword: boolean;
  action: "self_change" | "admin_reset";
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<AppAccountCredentialCommitResult[]>(APP_ACCOUNT_CREDENTIAL_PUT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_identity_key: input.identityKey,
    p_account_name: input.accountName,
    p_account_role: input.accountRole,
    p_password_algorithm: input.passwordAlgorithm,
    p_password_hash: input.passwordHash,
    p_password_salt: input.passwordSalt,
    p_expected_version: input.expectedVersion,
    p_must_change_password: input.mustChangePassword,
    p_action: input.action,
    p_actor: input.actor,
  });
}

export async function getAccountDirectory(actorAccountId: string) {
  const { secret } = configuration();
  return rpc<AccountDirectoryRow[]>(ACCOUNT_DIRECTORY_RPC, {
    p_secret: secret,
    p_actor_account_id: actorAccountId,
  });
}

export async function getAccountByIdentity(identityKey: string) {
  const { secret } = configuration();
  const rows = await rpc<AccountDirectoryRow[]>(ACCOUNT_BY_IDENTITY_RPC, {
    p_secret: secret,
    p_identity_key: identityKey,
  });
  return rows[0] ?? null;
}

/** Creates the stable row for a known legacy demo identity during transition. */
export async function ensureAccountDirectory(input: {
  identityKey: string;
  accountName: string;
  accountRole: AccountRole;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountDirectoryRow[]>(ACCOUNT_ENSURE_DIRECTORY_RPC, {
    p_secret: secret,
    p_identity_key: input.identityKey,
    p_account_name: input.accountName,
    p_account_role: input.accountRole,
  });
  return rows[0] ?? null;
}

export async function createAccountInvite(input: {
  commandKey: string;
  identityKey: string;
  accountName: string;
  accountRole: AccountRole;
  tokenHash: string;
  actorAccountId: string;
  permissionOverrides?: Record<string, boolean>;
  scopeMembers?: readonly Readonly<{ kind: string; key: string }>[];
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountInviteResult[]>(ACCOUNT_INVITE_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_identity_key: input.identityKey,
    p_account_name: input.accountName,
    p_account_role: input.accountRole,
    p_token_hash: input.tokenHash,
    p_actor_account_id: input.actorAccountId,
    p_permission_overrides: input.permissionOverrides ?? {},
    p_scope_members: input.scopeMembers ?? [],
  });
  return rows[0] ?? null;
}

export async function acceptAccountInvite(input: {
  commandKey: string;
  tokenHash: string;
  passwordAlgorithm: "scrypt-v1";
  passwordHash: string;
  passwordSalt: string;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountInviteAcceptResult[]>(ACCOUNT_INVITE_ACCEPT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_token_hash: input.tokenHash,
    p_password_algorithm: input.passwordAlgorithm,
    p_password_hash: input.passwordHash,
    p_password_salt: input.passwordSalt,
  });
  return rows[0] ?? null;
}

export async function updateAccountAccess(input: {
  commandKey: string;
  accountId: string;
  accountRole: AccountRole;
  permissionOverrides: Record<string, boolean>;
  scopeMembers: readonly Readonly<{ kind: string; key: string }>[];
  expectedRoleVersion: number;
  expectedScopeVersion: number;
  actorAccountId: string;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountAccessUpdateResult[]>(ACCOUNT_ACCESS_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_account_id: input.accountId,
    p_account_role: input.accountRole,
    p_permission_overrides: input.permissionOverrides,
    p_scope_members: input.scopeMembers,
    p_expected_role_version: input.expectedRoleVersion,
    p_expected_scope_version: input.expectedScopeVersion,
    p_actor_account_id: input.actorAccountId,
  });
  return rows[0] ?? null;
}

export async function setAccountStatus(input: {
  commandKey: string;
  accountId: string;
  status: "active" | "disabled";
  expectedAccessVersion: number;
  actorAccountId: string;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountStatusResult[]>(ACCOUNT_STATUS_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_account_id: input.accountId,
    p_status: input.status,
    p_expected_access_version: input.expectedAccessVersion,
    p_actor_account_id: input.actorAccountId,
  });
  return rows[0] ?? null;
}

export async function getAccountAuthorization(accountId: string, actorAccountId = accountId) {
  const { secret } = configuration();
  const rows = await rpc<AccountAuthorization[]>(ACCOUNT_AUTHORIZATION_RPC, {
    p_secret: secret,
    p_account_id: accountId,
    p_actor_account_id: actorAccountId,
  });
  return rows[0] ?? null;
}

export async function createAccountSession(input: {
  sessionId: string;
  tokenHash: string;
  accountId: string;
  expectedCredentialVersion: number;
  expectedAccessVersion: number;
  mfaVerified: boolean;
  userAgent?: string | null;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountSessionCreateResult[]>(ACCOUNT_SESSION_CREATE_RPC, {
    p_secret: secret,
    p_session_id: input.sessionId,
    p_token_hash: input.tokenHash,
    p_account_id: input.accountId,
    p_expected_credential_version: input.expectedCredentialVersion,
    p_expected_access_version: input.expectedAccessVersion,
    p_mfa_verified: input.mfaVerified,
    p_user_agent: input.userAgent ?? null,
  });
  return rows[0] ?? null;
}

export async function getAccountSession(tokenHash: string) {
  const { secret } = configuration();
  const rows = await rpc<AccountSessionResolution[]>(ACCOUNT_SESSION_READ_RPC, {
    p_secret: secret,
    p_token_hash: tokenHash,
  });
  return rows[0] ?? null;
}

export async function getAccountSessions(input: { actorAccountId: string; targetAccountId?: string; currentSessionId?: string }) {
  const { secret } = configuration();
  return rpc<AccountSessionRow[]>(ACCOUNT_SESSIONS_READ_RPC, {
    p_secret: secret,
    p_actor_account_id: input.actorAccountId,
    p_target_account_id: input.targetAccountId ?? input.actorAccountId,
    p_current_session_id: input.currentSessionId ?? null,
  });
}

export async function revokeAccountSessions(input: {
  actorAccountId: string;
  targetAccountId?: string;
  tokenHash?: string | null;
  revokeAll: boolean;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountSessionRevokeResult[]>(ACCOUNT_SESSION_REVOKE_RPC, {
    p_secret: secret,
    p_actor_account_id: input.actorAccountId,
    p_target_account_id: input.targetAccountId ?? input.actorAccountId,
    p_token_hash: input.tokenHash ?? null,
    p_revoke_all: input.revokeAll,
  });
  return rows[0] ?? null;
}

/** Logout capability: the opaque token can revoke only its exact ledger row. */
export async function revokeCurrentAccountSession(input: { sessionId: string; tokenHash: string }) {
  const { secret } = configuration();
  const rows = await rpc<AccountSessionRevokeResult[]>(ACCOUNT_CURRENT_SESSION_REVOKE_RPC, {
    p_secret: secret,
    p_session_id: input.sessionId,
    p_token_hash: input.tokenHash,
  });
  return rows[0] ?? null;
}

export async function checkAccountAuthThrottle(throttleKeys: readonly string[]) {
  const { secret } = configuration();
  const rows = await rpc<AccountAuthThrottleResult[]>(ACCOUNT_AUTH_THROTTLE_CHECK_RPC, {
    p_secret: secret,
    p_throttle_keys: throttleKeys,
  });
  return rows[0] ?? { blocked: false, retry_after_seconds: 0 };
}

export async function admitAccountAuthAttempt(throttleKeys: readonly string[]) {
  const { secret } = configuration();
  const rows = await rpc<AccountAuthThrottleResult[]>(ACCOUNT_AUTH_THROTTLE_ADMIT_RPC, {
    p_secret: secret,
    p_throttle_keys: throttleKeys,
  });
  return rows[0] ?? { blocked: false, retry_after_seconds: 0 };
}

export async function recordAccountAuthAttempt(throttleKeys: readonly string[], succeeded: boolean) {
  const { secret } = configuration();
  const rows = await rpc<AccountAuthThrottleResult[]>(ACCOUNT_AUTH_THROTTLE_RECORD_RPC, {
    p_secret: secret,
    p_throttle_keys: throttleKeys,
    p_succeeded: succeeded,
  });
  return rows[0] ?? { blocked: false, retry_after_seconds: 0 };
}

export async function rotateAccountPasswordAtomic(input: {
  commandKey: string;
  accountId: string;
  passwordAlgorithm: "scrypt-v1";
  passwordHash: string;
  passwordSalt: string;
  expectedCredentialVersion: number;
  mustChangePassword: boolean;
  action: "self_change" | "admin_reset";
  actorAccountId: string;
  issuedPasswordCiphertext: string | null;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountPasswordRotationResult[]>(ACCOUNT_PASSWORD_ROTATE_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_account_id: input.accountId,
    p_password_algorithm: input.passwordAlgorithm,
    p_password_hash: input.passwordHash,
    p_password_salt: input.passwordSalt,
    p_expected_credential_version: input.expectedCredentialVersion,
    p_must_change_password: input.mustChangePassword,
    p_action: input.action,
    p_actor_account_id: input.actorAccountId,
    p_issued_password_ciphertext: input.issuedPasswordCiphertext,
  });
  return rows[0] ?? null;
}

export async function getAccountIssuedPasswordEscrow(input: {
  accountId: string;
  actorAccountId: string;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountIssuedPasswordEscrowResult[]>(ACCOUNT_ISSUED_PASSWORD_READ_RPC, {
    p_secret: secret,
    p_account_id: input.accountId,
    p_actor_account_id: input.actorAccountId,
  });
  return rows[0] ?? null;
}

export async function rewrapAccountIssuedPasswordEscrow(input: {
  accountId: string;
  expectedCredentialVersion: number;
  expectedCiphertext: string;
  rewrappedCiphertext: string;
  actorAccountId: string;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountIssuedPasswordRewrapResult[]>(ACCOUNT_ISSUED_PASSWORD_REWRAP_RPC, {
    p_secret: secret,
    p_account_id: input.accountId,
    p_expected_credential_version: input.expectedCredentialVersion,
    p_expected_ciphertext: input.expectedCiphertext,
    p_rewrapped_ciphertext: input.rewrappedCiphertext,
    p_actor_account_id: input.actorAccountId,
  });
  return rows[0] ?? null;
}

export async function issueAccountRecovery(identityKey: string, tokenHash: string) {
  const { secret } = configuration();
  const rows = await rpc<AccountRecoveryIssueResult[]>(ACCOUNT_RECOVERY_ISSUE_RPC, {
    p_secret: secret,
    p_identity_key: identityKey,
    p_token_hash: tokenHash,
  });
  return rows[0] ?? { accepted: false, expires_at: null, delivery_status: null };
}

export async function consumeAccountRecovery(input: {
  commandKey: string;
  tokenHash: string;
  passwordAlgorithm: "scrypt-v1";
  passwordHash: string;
  passwordSalt: string;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountRecoveryResult[]>(ACCOUNT_RECOVERY_CONSUME_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_token_hash: input.tokenHash,
    p_password_algorithm: input.passwordAlgorithm,
    p_password_hash: input.passwordHash,
    p_password_salt: input.passwordSalt,
  });
  return rows[0] ?? null;
}

export async function getAccountMfaForLogin(identityKey: string) {
  const { secret } = configuration();
  const rows = await rpc<AccountMfaRecord[]>(ACCOUNT_MFA_LOGIN_RPC, {
    p_secret: secret,
    p_identity_key: identityKey,
  });
  return rows[0] ?? null;
}

export async function consumeAccountMfaTotp(input: {
  identityKey: string;
  expectedMfaVersion: number;
  counter: number;
}) {
  const { secret } = configuration();
  const rows = await rpc<Array<{ accepted: boolean }>>(ACCOUNT_MFA_TOTP_CONSUME_RPC, {
    p_secret: secret,
    p_identity_key: input.identityKey,
    p_expected_mfa_version: input.expectedMfaVersion,
    p_counter: input.counter,
  });
  return rows[0]?.accepted === true;
}

export async function getAccountMfa(accountId: string, actorAccountId = accountId) {
  const { secret } = configuration();
  const rows = await rpc<AccountMfaRecord[]>(ACCOUNT_MFA_READ_RPC, {
    p_secret: secret,
    p_account_id: accountId,
    p_actor_account_id: actorAccountId,
  });
  return rows[0] ?? null;
}

export async function beginAccountMfaSetup(input: {
  accountId: string;
  encryptedSecret: string;
  expectedMfaVersion: number;
  actorAccountId: string;
  sessionId: string;
  expectedCredentialVersion: number;
  expectedAccessVersion: number;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountMfaMutationResult[]>(ACCOUNT_MFA_BEGIN_RPC, {
    p_secret: secret,
    p_account_id: input.accountId,
    p_secret_ciphertext: input.encryptedSecret,
    p_expected_mfa_version: input.expectedMfaVersion,
    p_actor_account_id: input.actorAccountId,
    p_session_id: input.sessionId,
    p_expected_credential_version: input.expectedCredentialVersion,
    p_expected_access_version: input.expectedAccessVersion,
  });
  return rows[0] ?? null;
}

export async function confirmAccountMfa(input: {
  accountId: string;
  expectedMfaVersion: number;
  actorAccountId: string;
  sessionId: string;
  expectedCredentialVersion: number;
  expectedAccessVersion: number;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountMfaMutationResult[]>(ACCOUNT_MFA_CONFIRM_RPC, {
    p_secret: secret,
    p_account_id: input.accountId,
    p_expected_mfa_version: input.expectedMfaVersion,
    p_actor_account_id: input.actorAccountId,
    p_session_id: input.sessionId,
    p_expected_credential_version: input.expectedCredentialVersion,
    p_expected_access_version: input.expectedAccessVersion,
  });
  return rows[0] ?? null;
}

export async function disableAccountMfa(input: {
  accountId: string;
  expectedMfaVersion: number;
  actorAccountId: string;
  sessionId: string;
  expectedCredentialVersion: number;
  expectedAccessVersion: number;
}) {
  const { secret } = configuration();
  const rows = await rpc<AccountMfaMutationResult[]>(ACCOUNT_MFA_DISABLE_RPC, {
    p_secret: secret,
    p_account_id: input.accountId,
    p_expected_mfa_version: input.expectedMfaVersion,
    p_actor_account_id: input.actorAccountId,
    p_session_id: input.sessionId,
    p_expected_credential_version: input.expectedCredentialVersion,
    p_expected_access_version: input.expectedAccessVersion,
  });
  return rows[0] ?? null;
}

export async function resetAccountMfa(input: { accountId: string; targetAccountId: string }) {
  const { secret } = configuration();
  const rows = await rpc<AccountMfaMutationResult[]>(ACCOUNT_MFA_RESET_RPC, {
    p_secret: secret,
    p_actor_account_id: input.accountId,
    p_target_account_id: input.targetAccountId,
  });
  return rows[0] ?? null;
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

/** Atomically records one renewal follow-up, its student history entry and an optional screenshot. */
export function putRenewalFollowUpAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  renewalId: string;
  studentId: string;
  packageId?: string;
  businessStatus: string;
  result: string;
  attemptedAt: string;
  note: string;
  renewalDateNote: string;
  attachment?: Readonly<{
    fileName: string;
    fileTitle: string;
    contentType: string;
    contentBase64: string;
    sha256: string;
  }>;
  expectedVersions: Readonly<{ files: number; renewals: number; students: number; tasks: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<RenewalFollowUpAtomicCommitResult[]>(RENEWAL_FOLLOW_UP_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_renewal_id: input.renewalId,
    p_student_id: input.studentId,
    p_package_id: input.packageId ?? null,
    p_business_status: input.businessStatus,
    p_result: input.result,
    p_attempted_at: input.attemptedAt,
    p_note: input.note,
    p_renewal_date_note: input.renewalDateNote,
    p_file_name: input.attachment?.fileName ?? null,
    p_file_content_type: input.attachment?.contentType ?? null,
    p_file_content_base64: input.attachment?.contentBase64 ?? null,
    p_file_title: input.attachment?.fileTitle ?? null,
    p_file_sha256: input.attachment?.sha256 ?? null,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
  });
}

/**
 * Creates the exact automatic renewal projection inside the follow-up
 * transaction when the shared renewal row has not been materialised yet.
 * The database derives owner, package name and balance from students.payload;
 * this wrapper intentionally accepts no client-provided projection fields.
 */
export function putRenewalFollowUpCreateIfMissingAtomic(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  renewalId: string;
  studentId: string;
  packageId: string;
  businessStatus: string;
  result: string;
  attemptedAt: string;
  note: string;
  renewalDateNote: string;
  attachment?: Readonly<{
    fileName: string;
    fileTitle: string;
    contentType: string;
    contentBase64: string;
    sha256: string;
  }>;
  expectedVersions: Readonly<{ files: number; renewals: number; students: number; tasks: number }>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<RenewalFollowUpAtomicCommitResult[]>(RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
    p_renewal_id: input.renewalId,
    p_student_id: input.studentId,
    p_package_id: input.packageId,
    p_business_status: input.businessStatus,
    p_result: input.result,
    p_attempted_at: input.attemptedAt,
    p_note: input.note,
    p_renewal_date_note: input.renewalDateNote,
    p_file_name: input.attachment?.fileName ?? null,
    p_file_content_type: input.attachment?.contentType ?? null,
    p_file_content_base64: input.attachment?.contentBase64 ?? null,
    p_file_title: input.attachment?.fileTitle ?? null,
    p_file_sha256: input.attachment?.sha256 ?? null,
    p_expected_versions: input.expectedVersions,
    p_actor: input.actor,
  });
}

export function getRenewalFollowUpCommandResult(input: {
  commandKey: string;
  commandIntent: Readonly<Record<string, unknown>>;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<RenewalFollowUpCommandResult[]>(RENEWAL_FOLLOW_UP_COMMAND_RESULT_RPC, {
    p_secret: secret,
    p_command_key: input.commandKey,
    p_command_intent: input.commandIntent,
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

export type TeacherLeaveRequest = Readonly<{ id: string; teacher_id: string; actor: string; start_date: string; end_date: string; reason: string; created_at: string }>;
export function readTeacherLeaveRequests(teacherIds: string[]) {
  return rpc<TeacherLeaveRequest[]>("read_teacher_leave_requests", { p_secret: configuration().secret, p_teacher_ids: teacherIds });
}
export function submitTeacherLeaveRequest(input: { id: string; teacherId: string; actor: string; start: string; end: string; reason: string }) {
  return rpc<string>("submit_teacher_leave_request", { p_secret: configuration().secret, p_id: input.id, p_teacher_id: input.teacherId, p_actor: input.actor, p_start: input.start, p_end: input.end, p_reason: input.reason });
}

/** Private, published mirror evidence. Never promotes OCR to a completed business record. */
export function readWecomMirrorReview(input: { kind: string; query: string; page: number; batch: string }) {
  const { secret } = configuration();
  return rpc<import("./wecom-mirror-review").MirrorReview>("read_wecom_mirror_review_v2", {
    p_secret: secret, p_kind: input.kind, p_query: input.query, p_page: input.page, p_batch_id: input.batch,
  });
}

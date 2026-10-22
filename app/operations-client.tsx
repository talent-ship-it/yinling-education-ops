"use client";

import type { ClassroomAttendance } from "@/lib/classroom-attendance";
import { dateTimeFormat } from "@/lib/date-time-format";
import { dashboardLessonsForDay } from "@/lib/dashboard-schedule";
import { buildAuditView } from "@/lib/audit-view";
import { mergeConcurrentPayload } from "@/lib/concurrent-payload-merge";
import { createSharedStatePoller } from "@/lib/shared-state-poller";

import { isLessonDuration } from "../lib/lesson-duration";
import { LessonDurationInput } from "./lesson-duration-input";
import { TrialScheduleDetails, trialSchedulePendingLabel } from "./trial-schedule-details";
import { useWorkspaceLocation } from "./use-workspace-location";
import { TeacherLeavePanel } from "./teacher-leave-panel";
import { RecordPicker } from "./record-picker";
import { MobileDetailBackButton } from "./mobile-detail-back-button";

import {
  ArrowUpDown,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CalendarOff,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Database,
  Download,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  Filter,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  KeyRound,
  Link2,
  LogOut,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UserCog,
  UserRoundX,
  Users,
  Video,
  Wallet,
  X,
} from "lucide-react";

import { cleanTimezone } from "@/lib/timezone";
import { AccountLifecycleWorkspace } from "@/app/account-lifecycle-workspace";
import { AuthStatusScreen } from "@/app/auth-status-screen";
import { JiaowubaoAuthorityStatusPanel } from "@/app/jiaowubao-authority-status";
import type { AccountDirectoryRecord } from "@/app/account-admin-lifecycle";
import { bookingHasEffectiveTeacher } from "@/lib/booking-teacher-scope";
import {
  sortStudentsByName,
  type StudentNameSortDirection,
} from "@/lib/student-sort";
import {
  clearTemporaryClassroomPending,
  createTemporaryClassroomPending,
  TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES,
  newTemporaryClassroomRequestKey,
  normalizeTemporaryClassroomIntent,
  readTemporaryClassroomPending,
  writeTemporaryClassroomPending,
  type TemporaryClassroomPending,
  type TemporaryClassroomRecordedPayload,
} from "@/lib/temporary-classroom-request";
import {
  buildOperationsReportExport,
  operationsReportFilename,
} from "@/lib/operations-report-export";
import {
  operationsReportOwnerOptions,
  pendingOperationsTaskWorkload,
} from "@/lib/operations-report-workload";
import {
  FIXED_REMINDER_RULES,
  RULE_OPTIONS,
  normalizeRules,
  rulesMatch,
  type Rules,
} from "@/lib/ops-rules";
import { opsSourceIsStale, partitionOpsSources } from "@/lib/ops-source-lifecycle";
import { findJiaowubaoAuthorityStatus } from "@/lib/jiaowubao-authority-status";
import { observeInterfaceLocalization, translateInterfaceText } from "@/lib/interface-localization";
import { downloadPayrollExcel, type PayrollExportRow } from "@/lib/payroll-export";
import { canPollAbsentPayrollMonth, createPayrollAbsentMonthWake, PAYROLL_ABSENT_ERROR_DELAY_MS, PAYROLL_ABSENT_POLL_DELAY_MS, previousMelbournePayrollMonth } from "@/lib/payroll-month";
import { undoPayrollLocks, type PayrollLockReceipt } from "@/lib/payroll-lock-undo";
import {
  currentJiaowubaoPayrollExportEvidence,
  JIAOWUBAO_PAYROLL_SOURCE_VERSION_REVIEW_REASON,
  jiaowubaoPayrollStudentAggregationKey,
  jiaowubaoPayrollSourceVersionIsCurrent,
  overlayPersistedPayrollWithJiaowubaoEvidence,
  payrollLockSnapshotIsCurrent,
  reviewOnlyPersistedPayrollWithJiaowubaoEvidence,
} from "@/lib/jiaowubao-completed-lesson-payroll-evidence";
import {
  defaultAccountDisplayPreferences,
  defaultDisplayPreferences,
  displayPreferencesStorageKey,
  displayTerm,
  displayTimezoneOptions,
  interfaceCopy,
  localeFor,
  readAccountDisplayPreferences,
  timezoneLabelFor,
  type DisplayPreferences,
  type InterfaceLanguage,
} from "@/lib/display-preferences";
import { FormEvent, ReactNode, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  DEMO_LIMITED_ADMIN_USER,
  DEMO_STAFF_USERS,
  matchesOperationsOwnerFilter,
  operationsOwnerFilterOptions,
  operationsOwnerFormOptions,
  resolveAssignableOperationsOwner,
} from "@/lib/demo-users";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import { resolveTaskTrialSchedule } from "@/lib/task-trial-schedule";
import {
  DEFAULT_TEACHING_CONTROL_WATCHER,
  closeTrialEscalationTasks,
  formatCompactTaskDeadline,
  isExecutableOpenTask,
  isTrialAcceptanceFixtureTask,
  isTrialEscalationTaskRule,
  refreshTaskStatus,
  sortTasksByDueAt,
  statusForDueAt,
  taskTitlePresentation,
  type OpsTask,
  type TaskCategory,
  type TaskStatus,
} from "@/lib/ops-tasks";
import {
  LP_STAGES,
  LP_RESULT_STATUSES,
  LP_WORKFLOW_TYPES,
  TRIAL_OPERATIONS,
  allowedLpResultStatuses,
  changeLpResultStatus,
  changeLpStage,
  lpResultStatusLabel,
  type LpFieldValues,
  type LpRevision,
  type LpResultAuditEntry,
  type LpResultStatus,
  type LpStage,
  type LpStageAuditEntry,
  type LpWorkflowType,
} from "@/lib/lp-workflows";
import {
  RENEWAL_STATUS_LABELS,
  FU_ATTACHMENT_CATEGORIES,
  FU_ATTACHMENT_CATEGORY_LABELS,
  appendStudentFollowUp,
  getLatestStudentFollowUp,
  getLessonPackageBalance,
  mapLessonPackageDepletionEstimates,
  normalizeRenewalBusinessStatus,
  deriveExamFollowUpStatuses,
  estimateExamResultDate,
  resolveExamVariant,
  type LessonHourLedgerEntry,
  type FuAttachmentCategory,
  type RenewalStatus as RenewalBusinessStatus,
  type ExamTaskKind,
  type StudentExamRecord,
  type StudentFollowUp,
  type StudentLessonPackage,
} from "@/lib/student-records";
import type { LpRevisionHistoryProps, LpWorkflowDetailsProps, LpWorkflowFieldsProps, parseLpWorkflowFormData } from "@/app/lp-workflow-fields";
import { ToDoList, type TaskDeadlineTimeZone, type ToDoFilter } from "@/app/to-do-list";
import { buildStudentRecordsPanelData, StudentRecordsPanel, type StudentHistoricalJwbSnapshot, type StudentRecordPanelSection } from "@/app/student-records-panel";
import { CoursePackageSummary } from "@/app/course-package-summary";
import { ScheduleMonthView, type ScheduleMonthAvailability, type ScheduleMonthLesson } from "@/app/schedule-month-view";
import {
  JiaowubaoImportedSchedulePanel,
  completeJiaowubaoImportedSchedulePages,
  jiaowubaoImportedAvailabilityBlocksForTeacher,
  parseJiaowubaoImportedSchedulePage as parseSnapshotSchedulePage,
  type JiaowubaoImportedScheduleFeed,
  type JiaowubaoImportedSchedulePage,
  type JiaowubaoImportedScheduleReadError,
} from "@/app/jiaowubao-imported-schedule";
import {
  completeJiaowubaoCompletedMonthEvidencePages,
  jiaowubaoCompletedMonthEvidenceMatchesExportVersion,
  jiaowubaoCompletedMonthEvidenceReadyForPayrollLock,
  jiaowubaoCompletedMonthEvidenceReadyForExport,
  parseJiaowubaoCompletedMonthEvidencePage,
  type JiaowubaoCompletedLessonFeed,
  type JiaowubaoCompletedLessonFeedItem,
  type JiaowubaoCompletedLessonPage,
  type JiaowubaoCompletedLessonTeacherSummary,
  type JiaowubaoCompletedMonthEvidencePage,
  type JiaowubaoCompletedSchedulePage,
} from "@/app/jiaowubao-completed-month-evidence";
import {
  JiaowubaoScheduleMappingReviewPanel,
  parseJiaowubaoScheduleMappingReview,
  type JiaowubaoScheduleMappingReview,
} from "@/app/jiaowubao-schedule-mapping-review";
import {
  JiaowubaoScheduleMappingPriorityReviewPanel,
  parseJiaowubaoScheduleMappingPriorityReview,
  type JiaowubaoScheduleMappingPriorityReview,
} from "@/app/jiaowubao-schedule-mapping-priority-review";
import {
  parseTeacherAvailabilityCompletionInbox,
  type TeacherAvailabilityCompletionInbox,
} from "@/app/teacher-availability-completion";
import { buildJiaowubaoOperationsReadinessWindow } from "@/lib/jiaowubao-operations-readiness-window";
import { ExamForm, FollowUpForm, parseExamFormData, parseFollowUpFormData } from "@/app/student-record-forms";
import { LessonPackagePurchaseForm } from "@/app/lesson-package-purchase-form";
import { resolveStudentDisplayName } from "@/lib/student-intake";
import { getStudentSubjectOptions } from "@/lib/student-subject-options";
import {
  buildCoursePackageCatalog,
  isActiveCoursePackageCatalogStudent,
} from "@/lib/course-package-catalog";
import {
  clearDirectEnrollmentPendingCommands,
  removeDirectEnrollmentPendingCommand,
  persistDirectEnrollmentPendingCommands,
  readDirectEnrollmentPendingCommands,
  upsertDirectEnrollmentPendingCommand,
  type DirectEnrollmentPendingCommand,
  type DirectEnrollmentPendingStorage,
} from "@/lib/direct-enrollment-pending";
import {
  clearTeacherAbsencePendingCommands,
  persistTeacherAbsencePendingCommands,
  readTeacherAbsencePendingCommands,
  removeTeacherAbsencePendingCommand,
  teacherAbsencePendingDisposition,
  upsertTeacherAbsencePendingCommand,
  type TeacherAbsencePendingCommand,
} from "@/lib/teacher-absence-pending";
import {
  lpAtomicIntent,
  parseLpAtomicCommand,
} from "@/lib/lp-atomic-service";
import {
  persistLpAtomicPendingCommands,
  readLpAtomicPendingCommands,
  removeLpAtomicPendingCommand,
  upsertLpAtomicPendingCommand,
  type LpAtomicPendingEntry,
} from "@/lib/lp-atomic-pending";
import {
  clearBookingProjectionPendingCommands,
  persistBookingProjectionPendingCommands,
  readBookingProjectionPendingCommands,
  prepareBookingProjectionPendingCommand,
  removeBookingProjectionPendingCommand,
  upsertBookingProjectionPendingCommand,
  type BookingProjectionPendingCommand,
} from "@/lib/booking-projection-pending";
import {
  clearStudentCreationPendingCommands,
  persistStudentCreationPendingCommands,
  readStudentCreationPendingCommands,
  removeStudentCreationPendingCommand,
  studentCreationPendingDisposition,
  upsertStudentCreationPendingCommand,
  type StudentCreationPendingCommand,
} from "@/lib/student-creation-pending";
import {
  clearLegacyOperationTaskPendingCommands,
  legacyOperationTaskPendingDisposition,
  persistLegacyOperationTaskPendingCommands,
  readLegacyOperationTaskPendingCommands,
  removeLegacyOperationTaskPendingCommand,
  upsertLegacyOperationTaskPendingCommand,
  type LegacyOperationTaskPendingCommand,
} from "@/lib/legacy-operation-task-pending";
import {
  TeacherAvailabilityPanel,
  type TeacherAvailabilityAction,
  type TeacherAvailabilityEditAction,
  type TeacherAvailabilitySubmissionReview,
} from "@/app/teacher-availability-panel";
import { buildRenewalDateNote, latestRenewalPurchaseAt, reconcileRenewalTasks, renewalCycleTaskAnchor, renewalProjectionStateForStudent, renewalStatusForPackage, renewalTaskAnchor, renewalTaskCycleForPackage, type RenewalPackageProjection } from "@/lib/renewal-tasks";
import {
  earliestLessonOccurrenceTargetDate,
  expandLessonOccurrences,
  lessonOccurrenceSourceRangeForTargetRange,
  type LessonOccurrenceOverride,
  type LessonOccurrenceStatus,
} from "@/lib/lesson-occurrences";
import {
  LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS,
  recurrenceIntervalForFrequency,
  recurrenceOccurrenceCount,
  recurrenceSourceEndDate,
  validateBookingRecurrence,
  type BookingRecurrenceFrequency,
} from "@/lib/booking-recurrence";
import { isManagedExamTaskRecipient } from "@/lib/exam-tasks";
import {
  MANAGED_EXAM_AUTHORITY_ENTITIES,
  managedExamSnapshotCanReplace,
  managedExamSnapshotIsCurrent,
  parseManagedExamAuthorityVersions,
  parseManagedExamProjectionSnapshot,
  type ManagedExamProjectionSnapshot,
  type ManagedExamStudentProjection,
} from "@/lib/managed-exam-refresh";
import {
  isManagedTrialPaymentConfirmationTask,
  isManagedTrialPaymentTask,
  isManagedTrialPaymentTaskRecipient,
  MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES,
  managedTrialPaymentSnapshotCanReplace,
  managedTrialPaymentSnapshotIsCurrent,
  parseManagedTrialPaymentAuthorityVersions,
  parseManagedTrialPaymentLifecycleReceipt,
  parseManagedTrialPaymentProjectionSnapshot,
  type ManagedTrialPaymentProjectionSnapshot,
} from "@/lib/managed-trial-payment";
import {
  persistTrialPaymentPendingCommands,
  readTrialPaymentPendingCommands,
  removeTrialPaymentPendingCommand,
  trialPaymentPendingDisposition,
  upsertTrialPaymentPendingCommand,
  type TrialPaymentPendingCommand,
} from "@/lib/trial-payment-pending";
import {
  parsePendingExamSubmission,
  pendingExamMatchesDraft,
  pendingExamRecoveryCommand,
  type PendingExamSubmission,
} from "@/lib/exam-submission-pending";
import {
  scheduleMonthWindow,
  shiftScheduleMonth,
  subtractBookedFromAvailability,
  summarizeScheduleAttendance,
} from "@/lib/schedule-calendar";
import {
  assertValidTeacherAvailability,
  createMonthlyAvailabilityWindows,
  deleteAllTeacherAvailability,
  deleteAvailabilityDate,
  deleteAvailabilityWeek,
  editAvailabilityDate,
  expandTeacherAvailability,
  normalizeLegacyAvailability,
  projectTeacherSchedulingReadiness,
  promoteLegacyAvailabilityForMonth,
  type AvailabilitySlotInput,
  type TeacherAvailabilityWindow,
  type TeacherAvailabilitySubmission,
} from "@/lib/teacher-availability";
import {
  fetchJsonWithTimeout,
  recoverSharedStateAfterUnknownWrite,
  matchesCommittedSharedPayload,
  SHARED_STATE_REQUEST_TIMEOUT_MS,
  type SharedStateRow,
} from "@/lib/shared-state-recovery";
import {
  closeTrialTeacherReplyTasks,
  completeTrialTaskWithHandbookFollowUps,
  formatJiaowubaoTodayTaskTitle,
  isTrialTeacherReplyTaskRule,
  matchTrialScheduleEvents,
  reopenTrialTaskWithHandbookFollowUps,
  TRIAL_PENDING_SCHEDULING_RULE_KEY,
  trialIntakeFromFields,
  type TrialIntake,
  type TrialScheduleLink,
} from "@/lib/trial-operations";
import {
  effectiveTrialResultStatus,
  TRIAL_LEDGER_PLANNERS,
  TRIAL_LEDGER_WORKFLOW_TYPES,
  isTrialLedgerWorkflow,
  normalizeTrialLedgerFieldValue,
  trialLedgerStoredValue,
  type TrialLedgerAuditEntry,
  type TrialLedgerField,
  type TrialLedgerFieldValue,
  type TrialLedgerOverrides,
} from "@/lib/trial-ledger";
import {
  defaultTrialLedgerViewState,
  filterAndSortTrialLedgerRows,
  parseTrialLedgerViewState,
  trialLedgerViewFilterOptions,
  trialLedgerViewHasFilters,
  trialLedgerViewStats,
  trialLedgerViewStorageKey,
  type TrialLedgerViewState,
} from "@/lib/trial-ledger-view";
import { TENCENT_TRIAL_LEDGER_URL } from "@/lib/tencent-trial-ledger-mirror";
import {
  JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES,
  jiaowubaoTrialMissingScheduleRefs,
  jiaowubaoTrialSyncPendingDisposition,
  jiaowubaoTrialSyncScope,
  persistJiaowubaoTrialSyncPendingCommands,
  readJiaowubaoTrialSyncPendingCommands,
  removeJiaowubaoTrialSyncPendingCommand,
  upsertJiaowubaoTrialSyncPendingCommand,
  type JiaowubaoTrialSyncCommand,
  type JiaowubaoTrialSyncPendingCommand,
} from "@/lib/jiaowubao-trial-sync";

const LazyLpWorkflowFields = lazy(() => import("@/app/lp-workflow-fields").then((module) => ({ default: module.LpWorkflowFields })));
const LazyLpWorkflowDetails = lazy(() => import("@/app/lp-workflow-fields").then((module) => ({ default: module.LpWorkflowDetails })));
const LazyLpRevisionHistory = lazy(() => import("@/app/lp-workflow-fields").then((module) => ({ default: module.LpRevisionHistory })));
function LpWorkflowFields(props: LpWorkflowFieldsProps) { return <Suspense fallback={null}><LazyLpWorkflowFields {...props} /></Suspense>; }
function LpWorkflowDetails(props: LpWorkflowDetailsProps) { return <Suspense fallback={null}><LazyLpWorkflowDetails {...props} /></Suspense>; }
function LpRevisionHistory(props: LpRevisionHistoryProps) { return <Suspense fallback={null}><LazyLpRevisionHistory {...props} /></Suspense>; }

const TrialScreenshotConfirmWorkspace = lazy(() => import("@/app/trial-screenshot-confirm-workspace").then((module) => ({ default: module.TrialScreenshotConfirmWorkspace })));

const WecomLpDraftWorkspace = lazy(() => import("@/app/wecom-lp-draft-workspace").then((module) => ({ default: module.WecomLpDraftWorkspace })));


const AvaCalendarLiveClient = lazy(() => import("./ava-calendar/live/calendar-client"));
const ClassroomMaterialsPanel = lazy(() => import("./classroom-materials-panel"));
const ClassroomLessonTools = lazy(() => import("./classroom-lesson-tools"));

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOGOUT_RETRY_NOTICE_KEY = "yinling:logout-retry-notice";

const teacherSubjectOptions = [
  "Local English",
  "ABC华裔English",
  "Maths&Science",
  "奖学金",
  "AEAS",
  "青少英语",
  "AMC数学竞赛",
  "科学竞赛",
  "雅思PTE",
  "IB",
  "高考 English EAL",
  "高考 Humanities",
  "高考 LOTE",
  "高考中文",
  "高考地理",
  "高考心理学",
  "高考法律",
  "高考数学",
  "高考化学",
  "高考物理",
  "高考生物",
  "高考经济",
  "高考会计",
  "高考商科",
  "高考计算机",
  "高考设计",
  "高考日语",
  "高考法语",
  "Engineering",
  "商科",
  "IT",
  "理科",
  "文科（含论文辅导）",
  "教育学",
  "其他科目",
] as const;

type Section =
  | "dashboard"
  | "students"
  | "teachers"
  | "schedule"
  | "classroom"
  | "courses"
  | "lp"
  | "operations"
  | "renewals"
  | "ava-calendar"
  | "payroll"
  | "messages"
  | "files"
  | "sync"
  | "reports"
  | "settings"
  | "accounts"
  | "audit";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
type ModalKind = "student" | "studentEdit" | "studentEvidence" | "studentReport" | "studentRecords" | "studentFollowUp" | "lessonPackage" | "exam" | "task" | "legacyTaskDeadline" | "booking" | "bookingOccurrence" | "temporaryClassroom" | "lessonSettlement" | "operation" | "renewal" | "file" | "template" | "lp" | "lpRevision" | "ava" | "teacherAvailabilitySubmit" | "teacherCapacity" | "payrollNew" | "payrollEdit" | "accountPasswordChange" | "accountPasswordReset" | null;
type StudentBoundModalKind = Extract<ModalKind, "studentEdit" | "studentEvidence" | "studentReport" | "studentRecords" | "studentFollowUp" | "lessonPackage" | "exam">;
const STUDENT_BOUND_MODAL_KINDS = new Set<StudentBoundModalKind>([
  "studentEdit",
  "studentEvidence",
  "studentReport",
  "studentRecords",
  "studentFollowUp",
  "lessonPackage",
  "exam",
]);
type MobilePreview = "student" | "teacher" | "booking" | "operation" | "message" | "classroom" | "course" | null;

type OperatorProfile = { role: string; scope: string; tone: Tone };
type AccountPasswordResetTarget = Readonly<{
  accountId: string;
  label: string;
  login: string;
  expectedCredentialVersion: number;
}>;

function operatorProfile(operator: string, teacherNames: ReadonlySet<string> = new Set()): OperatorProfile {
  if (operator === "Nixon") return { role: "超级管理员", scope: "全部资料、薪资和系统设置", tone: "purple" };
  if (operator === DEMO_LIMITED_ADMIN_USER) return { role: "运营管理员", scope: "全局运营与教务协同", tone: "blue" };
  if (teacherNames.has(operator)) return { role: "老师", scope: "自己的学生、约课和网上课堂", tone: "green" };
  return { role: "教务", scope: "负责学生、排课和跟进", tone: "blue" };
}
type StudentStatus = "在读" | "不活跃 + 无课时" | "活跃 + 无课时" | "活跃 + 有课时" | "不活跃 + 有课时" | "在读 + 加课待排";
type StudentSegment = "试听" | "已报名";
type LpNeed = "待确认" | "无需LP" | "试听LP" | "新生LP" | "老生新LP" | "代课LP" | "LP修改";

type AvailabilitySlot = {
  day: number;
  start: string;
  end: string;
};

type Student = {
  id: string;
  /** Human-facing immutable number: YYYYMMDD + same-day sequence. */
  studentNumber?: string;
  name: string;
  initials: string;
  status: StudentStatus;
  segment?: StudentSegment;
  owner: string;
  course: string;
  timezone: string;
  /** Legacy import-only field. New records use guardianWechat. */
  guardian?: string;
  guardianWechat?: string;
  teacher: string;
  next: string;
  nextTone: Tone;
  files: number;
  examDate?: string;
  examSubject?: string;
  resultDate?: string;
  grade?: string;
  gradeBaseYear?: number;
  location?: string;
  planner?: string;
  remainingHours?: number;
  contractHours?: number;
  contractEffectiveDate?: string;
  firstJwbHourEntryDate?: string;
  /** Jiaowubao enriches a Tencent-master student but never determines whether the student is valid. */
  jwbMatchStatus?: "matched" | "unmatched" | "ambiguous";
  studentNumberDateSource?: "jwb_first_positive_contract" | "formal_import_date" | "system_entry_date";
  jwbSyncedAt?: string;
  jwbSyncStatus?: string;
  reportProgress?: string;
  followUp?: string;
  followUpHistory?: StudentFollowUp[];
  exams?: StudentExamRecord[];
  lessonPackages?: StudentLessonPackage[];
  packageCoverage?: "complete" | "partial" | "none";
  /** Read-only retained JWB evidence; never an active lesson package ledger. */
  historicalJwbSnapshot?: StudentHistoricalJwbSnapshot;
  lessonLedger?: LessonHourLedgerEntry[];
  notes?: string;
  lpNeed?: LpNeed;
  renewalMonth?: string;
  renewalDate?: string;
  sourceRow?: number;
  importArchived?: boolean;
  importArchivedReason?: "referenced_history";
};

type Teacher = {
  id: string;
  name: string;
  initials: string;
  subjects: string[];
  timezone: string;
  availability: string;
  load: number;
  capacity: number;
  acceptsStudents: boolean;
  note: string;
  departments?: string[];
  subjectDetail?: string;
  location?: string;
  availabilityTimezone?: string;
  availabilityStatus?: "可接新生" | "暂停接新" | "待确认";
  availabilityUpdated?: string;
  /** Verbatim Tencent roster evidence. It is never parsed into structured AVA automatically. */
  availabilitySourceText?: string;
  /** Verbatim Tencent roster evidence. It is reviewed before capacity is configured. */
  capacitySourceText?: string;
  availabilityWindows?: TeacherAvailabilityWindow[];
  /** Historical weekly template only. It is never monthly confirmation. */
  availabilitySlots?: AvailabilitySlot[];
  offlineArea?: string;
  sourceCategories?: string[];
  newStudentCapacity?: number;
  capacityAssignments?: string[];
};

type Task = OpsTask;

function taskRecipients(owner: string, additionalAssignees: string[] = []) {
  return { assignees: [...new Set([owner, ...additionalAssignees].filter(Boolean))], watchers: [DEFAULT_TEACHING_CONTROL_WATCHER] };
}

type Booking = {
  id: string;
  studentId: string;
  teacherId: string;
  date: string;
  start: string;
  duration: number;
  kind: "试听" | "常规课" | "代课";
  status: "待确认" | "已确认" | "已完成";
  timezone: string;
  recurring?: boolean;
  repeatCount?: number;
  recurrenceIntervalDays?: number;
  recurrenceEndDate?: string;
  course?: string;
  teacherSubjectId?: string;
  source?: string;
  sourceLessonId?: string;
  sourceStudentName?: string;
  sourceTeacherName?: string;
  sourceTiming?: "已结束" | "未开始";
  requestedAt?: string;
  packageId?: string;
  completedAt?: string;
  occurrenceOverrides?: LessonOccurrenceOverride[];
  classroom?: {
    occurrenceId: string;
    meetingId: string;
    status: "ready" | "running" | "ended";
    createdAt: string;
  };
};

type ClassroomRuntime = {
  meetingId: string;
  closing?: boolean;
  ended?: boolean;
  running: boolean;
  participantCount: number;
  moderatorCount: number;
  recording?: boolean;
  attendance?: ClassroomAttendance | null;
  attendanceUnavailable?: boolean;
  recordings: Array<{
    id: string;
    name: string;
    state: string;
    playbackUrl?: string;
  }>;
};

function classroomRuntimeResponse(result: { status: ClassroomRuntime; recordings?: unknown; attendance?: ClassroomAttendance; attendanceUnavailable?: unknown; closing?: unknown; ended?: unknown }): ClassroomRuntime {
  return { ...result.status, recordings: Array.isArray(result.recordings) ? result.recordings : [], attendance: result.attendance ?? null, attendanceUnavailable: result.attendanceUnavailable === true, closing: result.closing === true, ended: result.ended === true };
}

type CourseRecord = {
  id: string;
  name: string;
  status: "在用" | "已完结";
  source: string;
};

type BookingOccurrence = Booking & {
  occurrenceId: string;
  sourceDate: string;
  occurrenceKey: string;
  occurrenceStatus: LessonOccurrenceStatus;
};

type LpItem = {
  id: string;
  studentId: string;
  title: string;
  workflowType?: LpWorkflowType;
  stage: LpStage;
  resultStatus?: LpResultStatus;
  owner: string;
  due: string;
  /** Exact LP request instant; legacy date-only records intentionally omit it. */
  requestedAt?: string;
  needsParentFollowUp?: boolean;
  needsTeacherPrep?: boolean;
  publishedDate?: string;
  fields?: LpFieldValues;
  revisionNumber?: number;
    revisions?: LpRevision[];
  stageAudit?: LpStageAuditEntry[];
  resultAudit?: LpResultAuditEntry[];
  /** Manual intake fields from the trial handbook; kept separate from legacy LP RPC fields. */
  trialIntake?: TrialIntake;
  /** Immutable source evidence selected from the latest completed 教务宝 snapshot. */
  trialSchedule?: TrialScheduleLink;
  /** Ledger-only corrections never rewrite immutable LP or Jiaowubao source fields. */
  trialLedgerOverrides?: TrialLedgerOverrides;
  trialPaid?: boolean;
  trialLedgerNote?: string;
  trialLedgerAudit?: TrialLedgerAuditEntry[];
};

type Operation = {
  id: string;
  studentId: string;
  type: "调课" | "请假" | "学生请假" | "老师请假" | "停课" | "代课" | "换老师" | "老师离职";
  detail: string;
  status: "待处理" | "已确认";
  createdAt: string;
  teacherId?: string;
  eventStart?: string;
  eventEnd?: string;
  firstAffectedAt?: string;
  affectedLessonCount?: number;
  recommendedTeacherIds?: string[];
  chosenTeacherId?: string;
  sourceBookingId?: string;
};

type RenewalStatus = "已续课" | "未续课-活跃" | "未续课-不活跃" | "未续课-不活跃（已考完）" | "待跟进" | "已联系" | "已跟进" | "本次未跟进" | "等待家长" | "已确认";

type Renewal = {
  id: string;
  studentId: string;
  remaining: number;
  estimate: string;
  status: RenewalStatus;
  businessStatus?: RenewalBusinessStatus;
  owner: string;
  lastAttemptAt?: string;
  remainingHoursAtRenewal?: number;
  lastContactedAt?: string;
  followUpNote?: string;
  followUpAttachmentId?: string;
  followUpAttachmentTitle?: string;
  renewalDateNote?: string;
  packageId?: string;
  packageName?: string;
  subjectId?: string;
  teacherNames?: string[];
};

/**
 * Automatic depletion evidence is display-only. It is deliberately kept off
 * Renewal so it cannot become part of the shared/persisted renewal record.
 */
type RenewalDraft = Renewal & {
  automaticRenewalDateNote?: string;
};

type PayrollRow = {
  id: string;
  teacherId: string;
  lessons: number;
  trialLessons: number;
  amount: number;
  status: "需核对" | "可审核" | "已锁定";
  note: string;
  month?: string;
  section?: string;
  currency?: "CNY" | "AUD";
  teacherName?: string;
  teacherTotalHours?: number;
  teacherTotalAmount?: number;
  lineAmount?: number;
  lineCount?: number;
  rateRange?: number[];
  sourceHours?: number | null;
  sourceLessonCount?: number | null;
  sourceNoShowHours?: number | null;
  hourVariance?: number | null;
  sourceRevision?: string;
  sourceProjectionRevision?: string;
  bankAccount?: string;
  bankName?: string;
  paymentNote?: string;
  source?: string;
  lockedBy?: string;
  lockedAt?: string;
  lines?: PayrollLine[];
};

type PayrollDisplayRow = PayrollRow & {
  viewKey: string;
  sourceIndex: number | null;
  paymentReviewOnly?: boolean;
};

type TeacherPayrollLedgerRow = {
  id: string;
  kind: "teacher_hours" | "reversal";
  occurrenceId: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  subjectId: string;
  payableHours: number;
  occurredAt: string;
};

type PayrollStateRow = PayrollRow | TeacherPayrollLedgerRow;

type PayrollLine = {
  studentName: string;
  hours: number | null;
  hoursIssue?: "missing" | "non_numeric" | "out_of_range" | null;
  rate: number;
  subtotal: number;
  note?: string;
  isTrial?: boolean;
  sourceRow?: number;
  /**
   * A source-evidence line explains an imported teacher total, but is not an
   * allocation of that teacher's salary across every student in a group.
   */
  evidenceOnly?: boolean;
  /** Stable identities retained for monthly XLSX aggregation and evidence. */
  studentKey?: string;
  studentId?: string | null;
  sourceMemberId?: string | null;
  sourceKey?: string;
  studentMatch?: string;
};

function payrollTeacherMonthKey(teacherId: string, month: string | undefined) {
  return `${teacherId}\u0000${month ?? ""}`;
}

function jiaowubaoCompletedLessonLineNote(item: JiaowubaoCompletedLessonFeedItem) {
  return [item.lessonDate, item.timeTitle, item.courseTitle, item.teamTitle, item.hoursIssue ? "课时待核对" : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function jiaowubaoCompletedLessonEvidenceLines(items: readonly JiaowubaoCompletedLessonFeedItem[]): PayrollLine[] {
  return items.map((item, index) => ({
    studentName: item.displayStudentName ?? `${item.memberName ?? item.memberId}（待核对姓名）`,
    // Trial A/B/C are shared accounts: different real learners can carry the
    // same memberId. When no internal ID exists, the safely resolved display
    // name is the only identity that may be aggregated across the month.
    studentKey: jiaowubaoPayrollStudentAggregationKey(item),
    studentId: item.studentId,
    sourceMemberId: item.memberId,
    sourceKey: item.sourceKey,
    studentMatch: item.studentMatch,
    hours: item.hours,
    hoursIssue: item.hoursIssue ?? null,
    // A shared/group lesson's student rows are source evidence only. They
    // must never multiply the teacher's salary total.
    rate: 0,
    subtotal: 0,
    evidenceOnly: true,
    note: jiaowubaoCompletedLessonLineNote(item) || "教务宝已消课",
    isTrial: item.isTrial,
    sourceRow: index + 1,
  }));
}

function jiaowubaoCompletedLessonEvidenceItemsForTeacher(
  feed: JiaowubaoCompletedLessonFeed,
  summary: JiaowubaoCompletedLessonTeacherSummary,
) {
  const sourceKeys = feed.teacherEvidenceSourceKeys.get(summary.identityKey);
  return sourceKeys
    ? feed.items.filter((item) => sourceKeys.has(item.sourceKey))
    : [];
}

function jiaowubaoCompletedLessonCanGeneratePayroll(summary: JiaowubaoCompletedLessonTeacherSummary) {
  return Boolean(
    summary.teacherId
    && summary.sourceHours !== null
    && summary.trialSourceHours !== null
    && summary.unresolvedLessonCount === 0
    && summary.unresolvedTrialLessonCount === 0
    && summary.missingStudentDisplayNameCount === 0,
  );
}

function jiaowubaoCompletedLessonSourceReviewLabel(summary: JiaowubaoCompletedLessonTeacherSummary) {
  if (summary.teacherMatch === "ambiguous") return "老师匹配冲突";
  if (!summary.teacherId) return "待匹配老师";
  if (summary.unresolvedLessonCount > 0 || summary.sourceHours === null) return "课时来源待核对";
  if (summary.unresolvedTrialLessonCount > 0 || summary.trialSourceHours === null) return "试听分类待核对";
  if (summary.missingStudentDisplayNameCount > 0) return "学生姓名待核对";
  return "来源待核对";
}

type Message = {
  id: string;
  studentId: string;
  kind: string;
  recipient: string;
  body: string;
  status: "待人工确认" | "仅内部" | "已记录发送";
  createdAt: string;
};

type FileRecord = {
  id: string;
  studentId: string;
  title: string;
  type: "Learning Plan" | "学校资料" | "Report 资料" | "成绩单" | "课堂反馈" | "FU" | "续课 FU" | "资料链接" | "其他";
  source: string;
  addedAt: string;
  fuCategory?: FuAttachmentCategory;
};

type AuditEntry = {
  id: string;
  time: string;
  actor: string;
  action: string;
  detail: string;
  tone: Tone;
};

export type ImportPayload = {
  meta?: { studentCount?: number; teacherCount?: number; createdAt?: string; replaceExisting?: boolean };
  students?: Student[];
  teachers?: Teacher[];
  tasks?: Task[];
  bookings?: Booking[];
  courses?: CourseRecord[];
  lpItems?: LpItem[];
  operations?: Operation[];
  renewals?: Renewal[];
  payroll?: PayrollStateRow[];
  messages?: Message[];
  files?: FileRecord[];
  audit?: AuditEntry[];
  rules?: Rules;
  dataSnapshot?: { label: string; students: number; teachers: number; importedAt: string };
  versions?: Record<string, number>;
  syncSources?: SyncSource[];
  managedExamStudents?: ManagedExamStudentProjection[];
  managedExamSnapshot?: ManagedExamProjectionSnapshot;
  managedTrialPaymentSnapshot?: ManagedTrialPaymentProjectionSnapshot;
};

type SyncSource = {
  source_id: string;
  title: string;
  source_type: string;
  url?: string | null;
  modified_at?: string | null;
  synced_at: string;
  row_count: number;
  status: string;
  payload?: { sheetNames?: string[]; note?: string };
};

type RemoteStateRow<T = unknown> = {
  entity: string;
  payload: T;
  version: number;
  updated_at: string;
  updated_by: string;
};

type SharedSyncState = "synced" | "saving" | "offline" | "error" | "conflict";

type SharedStateDesired<T> = T | ((current: T) => T);

type ToastState = {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type ConfirmRequest = {
  title: string;
  detail: string;
  items?: string[];
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => void | Promise<void>;
};

type StudentImportPreview = {
  planFingerprint: string;
  expectedStudentVersion: number;
  /** Melbourne day used only when a new Tencent-master student lacks a safe JWB first-positive-contract date. */
  formalImportDate: string;
  canCommit: boolean;
  sources: {
    master: { sourceId: string; revision: string; rowCount: number };
    jwb: { sourceId: string; revision: string; rowCount: number };
  };
  identityCoverage: {
    requiredMasterRows: number;
    matchedRequiredMasterRows: number;
    missingRequiredMasterRows: number;
    ready: boolean;
  };
  summary: {
    insert: number;
    update: number;
    unchanged: number;
    excluded: number;
    unmatched: number;
    ambiguous: number;
    preservedManualTrials: number;
    preservedReferencedArchived: number;
    importedPackages: number;
    studentsMissingPackageData: number;
  };
  excluded: Array<{ sourceRow: string | number; name: string; reason: string }>;
  unmatched: Array<{ source: "master" | "jwb"; sourceRow: string | number; name: string; reason: string }>;
  ambiguous: Array<{ kind: string; masterSourceRows: Array<string | number>; jwbSourceRows: Array<string | number>; existingStudentCount: number }>;
  masterDuplicateResolutions: Array<{
    candidateKey: string;
    sourceRows: Array<{
      sourceRow: string | number;
      status: string;
      attributes?: Partial<Record<"location" | "year" | "owner" | "planner", string>>;
    }>;
    options: Array<{
      resolutionKey: string;
      decision: "select" | "ignore";
      label: string;
      selectedSourceRow?: string | number;
      selectedStatus?: "在读" | "不活跃 + 无课时" | "活跃 + 无课时" | "活跃 + 有课时" | "不活跃 + 有课时" | "在读 + 加课待排";
    }>;
  }>;
};

type StudentImportSourceKind = "master" | "jwb";

type StudentIdentityReviewCandidate = {
  candidateKey: string;
  master: { name: string; sourceRow: string | number };
  jwb: { name: string; sourceRow: string | number };
  existing?: { name: string; sourceRow?: string | number };
  existingMatchCount: number;
  options: Array<{
    resolutionKey: string;
    decision: "merge" | "create";
    label: string;
  }>;
  blockedReason?: "existing_identity_ambiguous" | "identity_already_used" | "derived_identity_conflict";
};

type StudentIdentityManualReview = {
  masters: Array<{
    token: string;
    name: string;
    sourceRow: string | number;
    status: "在读" | "活跃 + 有课时" | "不活跃 + 有课时" | "在读 + 加课待排";
  }>;
  jwb: Array<{ token: string; name: string; sourceRow: string | number }>;
  existing: Array<{
    token: string;
    name: string;
    sourceRow?: string | number;
    status?: string;
    segment?: string;
  }>;
};

type StudentIdentityAnnotationReviewPreview = {
  confirmationKey: string;
  candidateCount: number;
  pendingCount: number;
  alreadyLinkedCount: number;
  currentLinkCount: number;
  resultingLinkCount: number;
  canSubmit: boolean;
};

type StudentImportSourceIngestResult = {
  sourceKind: StudentImportSourceKind;
  sourceId: string;
  revision: string;
  rowCount: number;
  unchanged: boolean;
};

type TeacherImportSourceKind = "k12" | "university";

type TeacherImportSourceIngestResult = {
  workbook: TeacherImportSourceKind;
  sourceId: string;
  revision: string;
  rosterRowCount: number;
  subjectRowCount: number;
  unchanged: boolean;
};

type TeacherImportPreview = {
  planFingerprint: string;
  expectedTeacherVersion: number;
  canCommit: boolean;
  sources: Record<TeacherImportSourceKind, {
    sourceId: string;
    revision: string;
    rosterRowCount: number;
    subjectRowCount: number;
  }>;
  summary: {
    insert: number;
    update: number;
    unchanged: number;
    blocked: number;
    issues: number;
    unstructuredAvailability: number;
    unstructuredCapacity: number;
  };
  actions: Array<{
    kind: "insert" | "update" | "unchanged" | "blocked";
    teacherId?: string;
    name: string;
    matchMethod: string;
    changedFields: string[];
  }>;
  issues: Array<{
    code: string;
    workbook?: TeacherImportSourceKind;
    name?: string;
    sheetName?: string;
    detail: string;
  }>;
  identityResolutions: Array<{
    kind: "cross_workbook_identity" | "same_workbook_identity";
    resolutionKey: string;
    options: Array<{
      resolutionKey: string;
      decision: "merge" | "separate";
      label: string;
    }>;
    name: string;
    persistenceContract: "teacher_identity_link_v1" | "teacher_hard_resolution_v2";
    sourceRefs: Array<{
      workbook: TeacherImportSourceKind;
      sourceId: string;
      sourceRow: string | number;
    }>;
  }>;
  subjectResolutions: Array<{
    kind: "subject_assignment";
    workbook: TeacherImportSourceKind;
    name: string;
    sheetName: string;
    persistenceContract: "teacher_hard_resolution_v2";
    subjectRef: {
      workbook: TeacherImportSourceKind;
      sourceId: string;
      sheetName: string;
      sourceRow: string | number;
    };
    options: Array<{
      resolutionKey: string;
      decision: "assign" | "ignore";
      label: string;
    }>;
  }>;
};

const navigationDefinitions: Array<{ id: Section; label: string; icon: typeof LayoutDashboard; group: "work" | "support" }> = [
  { id: "dashboard", label: "工作台", icon: LayoutDashboard, group: "work" },
  { id: "students", label: "学生档案", icon: Users, group: "work" },
  { id: "teachers", label: "老师资源", icon: GraduationCap, group: "work" },
  { id: "schedule", label: "排课", icon: CalendarDays, group: "work" },
  { id: "classroom", label: "网上教室", icon: Video, group: "work" },
  { id: "courses", label: "课程与课包", icon: BookOpen, group: "work" },
  { id: "lp", label: "试听与 LP", icon: BookOpen, group: "work" },
  { id: "operations", label: "调课与代课", icon: CalendarPlus, group: "work" },
  { id: "renewals", label: "考试与续课", icon: ListChecks, group: "work" },
  { id: "payroll", label: "课时与薪资", icon: Wallet, group: "support" },
  { id: "messages", label: "消息队列", icon: MessageSquare, group: "support" },
  { id: "files", label: "文件中心", icon: FolderOpen, group: "support" },
  { id: "sync", label: "同步与导入", icon: RefreshCw, group: "support" },
  { id: "reports", label: "运营报表", icon: SlidersHorizontal, group: "support" },
  { id: "settings", label: "规则设置", icon: Settings, group: "support" },
  { id: "accounts", label: "账号与安全", icon: KeyRound, group: "support" },
  { id: "audit", label: "操作审计", icon: ShieldCheck, group: "support" },
  { id: "ava-calendar", label: "AVA日历", icon: CalendarDays, group: "work" },
];

function navigationFor(language: InterfaceLanguage) {
  return navigationDefinitions.map((item) => ({ ...item, label: item.id === "ava-calendar" && language === "en-AU" ? "AVA calendar" : displayTerm(item.label, language) }));
}

const staffSectionIds = new Set<Section>(["dashboard", "students", "teachers", "schedule", "ava-calendar", "courses", "lp", "operations", "renewals", "messages", "files", "accounts"]);
const teacherSectionIds = new Set<Section>(["dashboard", "students", "schedule", "ava-calendar", "classroom", "accounts"]);
const noPayrollAdminSectionIds = new Set<Section>(navigationDefinitions.filter((item) => item.id !== "payroll").map((item) => item.id));
const SIDEBAR_COLLAPSED_STORAGE_KEY = "yinling.sidebar-collapsed";

const baseStudents: Student[] = [
  { id: "STU-0248", name: "Olivia Chen", initials: "OC", status: "活跃 + 无课时", owner: "思佳", course: "Year 10 English", timezone: "Australia/Melbourne · UTC+10", guardian: "Chen 先生 · 企业微信客户群", teacher: "待匹配", next: "确认 N-2 资料与收费", nextTone: "red", files: 4 },
  { id: "STU-0194", name: "Lucas Wang", initials: "LW", status: "在读", owner: "Tiffany", course: "IB Mathematics AA HL", timezone: "Australia/Sydney · UTC+10", guardian: "Wang 女士 · 企业微信客户", teacher: "Daniel Wu", next: "发送 LP 给老师", nextTone: "amber", files: 9, examDate: "2026-11-03" },
  { id: "STU-0231", name: "Sophie Liu", initials: "SL", status: "在读", owner: "Abby", course: "VCE Chemistry", timezone: "Australia/Melbourne · UTC+10", guardian: "Liu 女士 · 企业微信客户群", teacher: "Amelia Brown", next: "更新考试节点", nextTone: "blue", files: 7, examDate: "2026-10-29" },
  { id: "STU-0176", name: "Ethan Zhao", initials: "EZ", status: "活跃 + 有课时", owner: "思佳", course: "Year 12 Physics", timezone: "Australia/Perth · UTC+8", guardian: "Zhao 女士 · 企业微信客户", teacher: "Michael Yu", next: "续课 N-8 跟进", nextTone: "amber", files: 6 },
  { id: "STU-0251", name: "Mia Zhang", initials: "MZ", status: "活跃 + 无课时", owner: "思佳", course: "Year 8 English", timezone: "Australia/Melbourne · UTC+10", guardian: "Zhang 女士 · 企业微信客户群", teacher: "待匹配", next: "匹配试听老师", nextTone: "blue", files: 3 },
  { id: "STU-0252", name: "Noah Li", initials: "NL", status: "在读", owner: "Tiffany", course: "IB Chemistry HL", timezone: "Australia/Sydney · UTC+10", guardian: "Li 先生 · 企业微信客户", teacher: "Amelia Brown", next: "课后反馈检查", nextTone: "green", files: 8, examDate: "2026-11-06" },
  { id: "STU-0253", name: "Emma Xu", initials: "EX", status: "活跃 + 无课时", owner: "Abby", course: "Year 11 Mathematics", timezone: "Asia/Shanghai · UTC+8", guardian: "Xu 女士 · 企业微信客户群", teacher: "Grace Lin", next: "确认试听反馈", nextTone: "amber", files: 4 },
  { id: "STU-0254", name: "Leo Sun", initials: "LS", status: "在读", owner: "思佳", course: "VCE Physics", timezone: "Australia/Melbourne · UTC+10", guardian: "Sun 先生 · 企业微信客户", teacher: "Michael Yu", next: "更新 Learning Plan", nextTone: "blue", files: 10, examDate: "2026-10-30" },
  { id: "STU-0255", name: "Chloe Yang", initials: "CY", status: "不活跃 + 有课时", owner: "Tara", course: "Year 9 Science", timezone: "Australia/Brisbane · UTC+10", guardian: "Yang 女士 · 企业微信客户", teacher: "Rachel Song", next: "确认预计复课日", nextTone: "red", files: 6 },
  { id: "STU-0256", name: "Oscar Hu", initials: "OH", status: "活跃 + 有课时", owner: "Tiffany", course: "IB Economics HL", timezone: "Australia/Sydney · UTC+10", guardian: "Hu 先生 · 企业微信客户群", teacher: "Daniel Wu", next: "续课 N-8 跟进", nextTone: "purple", files: 9 },
  { id: "STU-0257", name: "Ava Lin", initials: "AL", status: "在读", owner: "Abby", course: "Year 7 English", timezone: "Australia/Perth · UTC+8", guardian: "Lin 女士 · 企业微信客户", teacher: "Grace Lin", next: "作业提交检查", nextTone: "green", files: 7 },
  { id: "STU-0258", name: "Henry Gao", initials: "HG", status: "在读 + 加课待排", owner: "思佳", course: "HSC Mathematics Advanced", timezone: "Australia/Sydney · UTC+10", guardian: "Gao 先生 · 企业微信客户群", teacher: "待匹配", next: "确认长期时间", nextTone: "blue", files: 2 },
  { id: "STU-0259", name: "Sophia Wu", initials: "SW", status: "活跃 + 无课时", owner: "Tara", course: "VCE English", timezone: "Australia/Melbourne · UTC+10", guardian: "Wu 女士 · 企业微信客户", teacher: "Amelia Brown", next: "试听前 N-2 检查", nextTone: "red", files: 5 },
  { id: "STU-0260", name: "Jack Huang", initials: "JH", status: "在读", owner: "Tiffany", course: "IB Mathematics AI", timezone: "Asia/Shanghai · UTC+8", guardian: "Huang 女士 · 企业微信客户群", teacher: "Daniel Wu", next: "确认下月课表", nextTone: "amber", files: 11 },
  { id: "STU-0261", name: "Ella Zhou", initials: "EZ", status: "在读", owner: "Abby", course: "Year 10 Chemistry", timezone: "Australia/Brisbane · UTC+10", guardian: "Zhou 先生 · 企业微信客户", teacher: "Rachel Song", next: "补充最近成绩单", nextTone: "amber", files: 4 },
  { id: "STU-0262", name: "William Tang", initials: "WT", status: "活跃 + 有课时", owner: "思佳", course: "HSC English Advanced", timezone: "Australia/Sydney · UTC+10", guardian: "Tang 女士 · 企业微信客户群", teacher: "Amelia Brown", next: "确认新学期目标", nextTone: "purple", files: 8 },
];

const initialStudentDetails: Record<string, Partial<Student>> = {
  "STU-0248": { segment: "试听", grade: "Year 10", gradeBaseYear: 2026, location: "VIC", planner: "Tara", remainingHours: 0, lpNeed: "试听LP", reportProgress: "待试听后补充", followUp: "待完成试听", notes: "试听资料仍需确认" },
  "STU-0194": { segment: "已报名", grade: "Year 11", gradeBaseYear: 2026, location: "NSW", planner: "Eileen", remainingHours: 12, lpNeed: "老生新LP", reportProgress: "Semester 1 已归档", followUp: "2026-07-16", examSubject: "IB Mathematics", notes: "需要保留历史 LP 版本" },
  "STU-0231": { segment: "已报名", grade: "Year 12", gradeBaseYear: 2026, location: "VIC", planner: "Tara", remainingHours: 4, lpNeed: "LP修改", reportProgress: "待上传", followUp: "2026-07-18", examSubject: "VCE Chemistry", notes: "考试日期变更后需复核排课" },
  "STU-0176": { segment: "已报名", grade: "Year 12", gradeBaseYear: 2026, location: "WA", planner: "Tara", remainingHours: 3, lpNeed: "无需LP", reportProgress: "已完成", followUp: "2026-07-17", notes: "低课时强提醒仅在在读状态生效" },
  "STU-0251": { segment: "试听", grade: "Year 8", gradeBaseYear: 2026, location: "VIC", planner: "Eileen", lpNeed: "试听LP", reportProgress: "未开始", followUp: "待试听", notes: "等待匹配老师" },
  "STU-0252": { segment: "已报名", grade: "Year 11", gradeBaseYear: 2026, location: "NSW", planner: "Tara", remainingHours: 9, lpNeed: "无需LP", reportProgress: "已归档", followUp: "2026-07-15", examSubject: "IB Chemistry", notes: "无特殊备注" },
  "STU-0253": { segment: "试听", grade: "Year 11", gradeBaseYear: 2026, location: "CHN", planner: "Eileen", lpNeed: "试听LP", reportProgress: "未开始", followUp: "待试听反馈", notes: "中国时区" },
  "STU-0254": { segment: "已报名", grade: "Year 9", gradeBaseYear: 2025, location: "VIC", planner: "Tara", remainingHours: 7, lpNeed: "老生新LP", reportProgress: "待更新", followUp: "2026-07-14", examSubject: "VCE Physics", notes: "系统按基准年份自动显示当前年级" },
  "STU-0255": { segment: "已报名", grade: "Year 9", gradeBaseYear: 2026, location: "QLD", planner: "Eileen", remainingHours: 2, lpNeed: "无需LP", reportProgress: "暂停", followUp: "等待复课", notes: "停课学生不进入低课时强提醒" },
};

const initialStudents: Student[] = baseStudents.map((student) => ({ ...student, ...initialStudentDetails[student.id] }));
const sampleStudentIds = new Set(initialStudents.map((student) => student.id));

const baseTeachers: Teacher[] = [
  { id: "TEA-011", name: "Amelia Brown", initials: "AB", subjects: ["Year 10 English", "VCE English"], timezone: "Australia/Melbourne · UTC+10", availability: "周六 15:00-20:00", load: 8, capacity: 12, acceptsStudents: true, note: "长期时段匹配，试听经验充足" },
  { id: "TEA-027", name: "Grace Lin", initials: "GL", subjects: ["Year 7-10 English", "写作"], timezone: "Australia/Sydney · UTC+10", availability: "周六 16:00-19:00", load: 10, capacity: 12, acceptsStudents: true, note: "科目匹配，当前负载偏高" },
  { id: "TEA-042", name: "Rachel Song", initials: "RS", subjects: ["Year 9-10 English"], timezone: "Australia/Brisbane · UTC+10", availability: "周六 14:00-17:00", load: 4, capacity: 10, acceptsStudents: false, note: "需确认家长对老师背景的偏好" },
  { id: "TEA-053", name: "Daniel Wu", initials: "DW", subjects: ["IB Mathematics AA HL", "IB Mathematics AI"], timezone: "Australia/Sydney · UTC+10", availability: "周四 17:00-21:00", load: 7, capacity: 10, acceptsStudents: true, note: "IB 课程规划完成，长期时段稳定" },
  { id: "TEA-061", name: "Michael Yu", initials: "MY", subjects: ["VCE Physics", "Year 10-12 Physics"], timezone: "Australia/Melbourne · UTC+10", availability: "周二、周日 17:00-21:00", load: 9, capacity: 12, acceptsStudents: true, note: "物理课程稳定，可接一位长期学生" },
  { id: "TEA-067", name: "Olivia Park", initials: "OP", subjects: ["IB Chemistry HL", "VCE Chemistry"], timezone: "Australia/Sydney · UTC+10", availability: "周三、周六 16:00-20:00", load: 5, capacity: 10, acceptsStudents: true, note: "化学方向匹配，可承担试听" },
  { id: "TEA-071", name: "Kevin Zhang", initials: "KZ", subjects: ["HSC Mathematics Advanced", "Year 7-10 Mathematics"], timezone: "Australia/Brisbane · UTC+10", availability: "周一、周五 18:00-21:00", load: 10, capacity: 10, acceptsStudents: false, note: "当前满载，仅保留代课候选" },
  { id: "TEA-076", name: "Lily Chen", initials: "LC", subjects: ["IB Economics HL", "VCE Economics"], timezone: "Australia/Melbourne · UTC+10", availability: "周六、周日 10:00-16:00", load: 3, capacity: 9, acceptsStudents: true, note: "经济学方向，周末容量充足" },
  { id: "TEA-082", name: "Sophie Martin", initials: "SM", subjects: ["HSC English Advanced", "VCE English"], timezone: "Australia/Sydney · UTC+10", availability: "周二、周四 17:30-21:00", load: 6, capacity: 10, acceptsStudents: true, note: "高年级英语与写作经验" },
  { id: "TEA-088", name: "Andrew Liu", initials: "AL", subjects: ["Year 7-10 Science", "Year 10 Chemistry"], timezone: "Australia/Perth · UTC+8", availability: "周末 13:00-18:00", load: 4, capacity: 8, acceptsStudents: true, note: "西澳时区，适合中国晚间课程" },
];

const initialTeacherDetails: Record<string, Partial<Teacher>> = {
  "TEA-011": { departments: ["中小学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "15:00", end: "20:00" }] },
  "TEA-027": { departments: ["中小学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "16:00", end: "19:00" }] },
  "TEA-042": { departments: ["中小学"], location: "QLD", availabilityTimezone: "Australia/Brisbane", availabilityStatus: "暂停接新", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "14:00", end: "17:00" }] },
  "TEA-053": { departments: ["中小学", "大学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 4, start: "17:00", end: "21:00" }] },
  "TEA-061": { departments: ["中小学", "大学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 2, start: "17:00", end: "21:00" }, { day: 0, start: "17:00", end: "21:00" }] },
  "TEA-067": { departments: ["中小学", "大学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 3, start: "16:00", end: "20:00" }, { day: 6, start: "16:00", end: "20:00" }] },
  "TEA-071": { departments: ["中小学"], location: "QLD", availabilityTimezone: "Australia/Brisbane", availabilityStatus: "暂停接新", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 1, start: "18:00", end: "21:00" }, { day: 5, start: "18:00", end: "21:00" }] },
  "TEA-076": { departments: ["中小学", "大学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "10:00", end: "16:00" }, { day: 0, start: "10:00", end: "16:00" }] },
  "TEA-082": { departments: ["中小学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 2, start: "17:30", end: "21:00" }, { day: 4, start: "17:30", end: "21:00" }] },
  "TEA-088": { departments: ["中小学"], location: "WA", availabilityTimezone: "Australia/Perth", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "13:00", end: "18:00" }, { day: 0, start: "13:00", end: "18:00" }] },
};

const initialTeachers: Teacher[] = baseTeachers.map((teacher) => ({ ...teacher, ...initialTeacherDetails[teacher.id] }));
const sampleTeacherIds = new Set(initialTeachers.map((teacher) => teacher.id));
function buildRuntimeDefaults(importPayload?: ImportPayload) {
  const realStudents = (importPayload?.students ?? []).filter((student) => student?.id && student?.name);
  const realTeachers = (importPayload?.teachers ?? []).filter((teacher) => teacher?.id && teacher?.name);
  // A successfully loaded empty snapshot is still authoritative production
  // state. Sample rows are allowed only when no import payload was supplied at
  // all (for isolated component demos), never as an empty-database fallback.
  const hasImportedPayload = importPayload !== undefined;
  const importedAt = importPayload?.meta?.createdAt ?? new Date().toISOString().slice(0, 10);

  return {
    defaultStudents: hasImportedPayload ? realStudents : initialStudents,
    defaultTeachers: hasImportedPayload ? realTeachers : initialTeachers,
    defaultTasks: hasImportedPayload ? importPayload?.tasks ?? [] : initialTasks,
    defaultBookings: hasImportedPayload ? importPayload?.bookings ?? [] : initialBookings,
    defaultCourses: hasImportedPayload ? importPayload?.courses ?? [] : [],
    defaultLpItems: hasImportedPayload ? importPayload?.lpItems ?? [] : initialLp,
    defaultOperations: hasImportedPayload ? importPayload?.operations ?? [] : initialOperations,
    defaultRenewals: hasImportedPayload ? importPayload?.renewals ?? [] : initialRenewals,
    defaultPayroll: hasImportedPayload
      ? Array.isArray(importPayload?.payroll)
        ? importPayload.payroll
        : []
      : initialPayroll,
    defaultMessages: hasImportedPayload ? importPayload?.messages ?? [] : initialMessages,
    defaultFiles: hasImportedPayload ? importPayload?.files ?? [] : initialFiles,
    defaultAudit: hasImportedPayload ? importPayload?.audit ?? [] : initialAudit,
    defaultRules: normalizeRules(importPayload?.rules),
    defaultDataSnapshot: importPayload?.dataSnapshot ?? (hasImportedPayload
      ? { label: "Supabase 真实资料快照", students: realStudents.length, teachers: realTeachers.length, importedAt }
      : { label: "脱敏示例数据", students: initialStudents.length, teachers: initialTeachers.length, importedAt: "未导入" }),
    defaultSelectedStudentId: hasImportedPayload ? realStudents[0]?.id ?? "" : "STU-0248",
    defaultSelectedTeacherId: hasImportedPayload ? realTeachers[0]?.id ?? "" : "TEA-011",
    storagePrefix: hasImportedPayload ? `yinling-mvp-supabase-${importedAt}` : "yinling-mvp",
  };
}

const initialTasks: Task[] = [];
const initialBookings: Booking[] = [];
const initialLp: LpItem[] = [];
const initialOperations: Operation[] = [];
const initialRenewals: Renewal[] = [];
const initialPayroll: PayrollRow[] = [];
const initialMessages: Message[] = [];
const initialFiles: FileRecord[] = [];
const initialAudit: AuditEntry[] = [];

const lpStages: LpItem["stage"][] = [...LP_STAGES];

type PendingExamFollowUp = Readonly<{
  action: "complete" | "undo";
  taskId: string;
  commandKey: string;
  completionCommandKey?: string;
}>;

function examSubmissionSessionKey(actor: string) {
  return `insider-leads:exam-submission:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

const BROWSER_UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function readPendingExamSubmission(actor: string): PendingExamSubmission | null {
  try {
    return parsePendingExamSubmission(
      JSON.parse(window.sessionStorage.getItem(examSubmissionSessionKey(actor)) ?? "null"),
    );
  } catch {
    return null;
  }
}

function writePendingExamSubmission(actor: string, value: PendingExamSubmission) {
  try {
    window.sessionStorage.setItem(examSubmissionSessionKey(actor), JSON.stringify(value));
  } catch {
    // A disabled storage API only removes cross-refresh recovery; the in-memory
    // command reference still protects retries within this page lifetime.
  }
}

function clearPendingExamSubmission(actor: string) {
  try { window.sessionStorage.removeItem(examSubmissionSessionKey(actor)); } catch { /* no-op */ }
}

function examFollowUpSessionKey(actor: string, action: "complete" | "undo", taskId: string) {
  return `insider-leads:exam-follow-up:${encodeURIComponent(actor.trim().toLocaleLowerCase())}:${action}:${encodeURIComponent(taskId)}`;
}

function readPendingExamFollowUp(actor: string, action: "complete" | "undo", taskId: string) {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(examFollowUpSessionKey(actor, action, taskId)) ?? "null") as Partial<PendingExamFollowUp> | null;
    if (!value
      || value.action !== action
      || value.taskId !== taskId
      || !new RegExp(`^exam-follow-up:${BROWSER_UUID_V4_PATTERN}$`).test(String(value.commandKey ?? ""))) return null;
    if (action === "undo" && !new RegExp(`^exam-follow-up:${BROWSER_UUID_V4_PATTERN}$`).test(String(value.completionCommandKey ?? ""))) return null;
    return value as PendingExamFollowUp;
  } catch {
    return null;
  }
}

function writePendingExamFollowUp(actor: string, value: PendingExamFollowUp) {
  try {
    window.sessionStorage.setItem(
      examFollowUpSessionKey(actor, value.action, value.taskId),
      JSON.stringify(value),
    );
  } catch {
    // The in-memory map below still provides same-page lost-response replay.
  }
}

function clearPendingExamFollowUp(actor: string, action: "complete" | "undo", taskId: string) {
  try { window.sessionStorage.removeItem(examFollowUpSessionKey(actor, action, taskId)); } catch { /* no-op */ }
}

function browserSessionStorage(): DirectEnrollmentPendingStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function useSharedState<T>(
  entity: string,
  initialValue: T,
  initialVersion: number,
  actor: string,
  onSync: (state: SharedSyncState, message?: string) => void,
  readOnly = false,
  scopeVersions?: Readonly<Record<string, number>>,
  autoSave = true,
) {
  const [value, setValue] = useState<T>(initialValue);
  const [version, setVersion] = useState(initialVersion);
  const versionRef = useRef(initialVersion);
  const valueRef = useRef(initialValue);
  const readyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const committedRef = useRef(JSON.stringify(initialValue));
  const remoteGenerationRef = useRef(0);
  const pendingWriteRef = useRef(false);
  const autoSaveRef = useRef(autoSave);
  // An explicit commit owns this exact serialized payload until its server
  // receipt (or authoritative recovery) is known.  The regular optimistic
  // effect must not schedule a second PUT for the same user action.
  const explicitCommitPayloadRef = useRef<string | null>(null);
  const scopeVersionsKey = JSON.stringify(scopeVersions ?? null);

  useLayoutEffect(() => {
    autoSaveRef.current = autoSave;
    if (autoSave || timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [autoSave]);

  useEffect(() => {
    readyRef.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingWriteRef.current) return;
      // A browser unload cannot safely flush an authenticated OCC PUT.  Keep
      // the native leave confirmation instead of claiming that local state is
      // already durable.
      event.preventDefault();
      event.returnValue = "";
    };
    const pagehide = (event: PageTransitionEvent) => {
      if (!pendingWriteRef.current) return;
      // pagehide is not a reliable transport primitive.  Do not send a fake
      // beacon; surface the uncertainty to the shared status channel.
      event.preventDefault();
      onSync("saving", `${entity} 仍在保存，离开页面前不会伪称已同步`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pagehide);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [entity, onSync]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!readyRef.current || readOnly || !autoSave) return;
    const serialized = JSON.stringify(value);
    if (serialized === committedRef.current) return;
    if (explicitCommitPayloadRef.current === serialized) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    pendingWriteRef.current = true;
    onSync("saving", `正在保存 ${entity}`);

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const payload = value;
      const payloadSerialized = serialized;
      const scheduledGeneration = remoteGenerationRef.current;
      const scheduledScopeVersions = JSON.parse(scopeVersionsKey) as Record<string, number> | null;
      let sentCommittedBaseline: SharedStateRow<T> | null = null;
      queueRef.current = queueRef.current.then(async () => {
        if (!autoSaveRef.current || scheduledGeneration !== remoteGenerationRef.current) return;
        sentCommittedBaseline = {
          entity,
          payload: JSON.parse(committedRef.current) as T,
          version: versionRef.current,
          updated_at: "",
          updated_by: actor,
        };
        const { response, body: receivedBody } = await fetchJsonWithTimeout(fetch, "/api/app-state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity,
            payload,
            expectedVersion: versionRef.current,
            ...(scheduledScopeVersions ? { scopeVersions: scheduledScopeVersions } : {}),
          }),
        }, SHARED_STATE_REQUEST_TIMEOUT_MS);
        const body = receivedBody ?? {};

        if (scheduledGeneration !== remoteGenerationRef.current) return;

        if (response.status === 409 && body.current) {
          const current = body.current as RemoteStateRow<T>;
          if (body.accessChanged || current.version <= versionRef.current) {
            throw new Error(body.error || `${entity} 权限或版本已变化`);
          }
          const merged = mergeConcurrentPayload(JSON.parse(committedRef.current) as T, valueRef.current, current.payload);
          remoteGenerationRef.current += 1;
          committedRef.current = JSON.stringify(current.payload);
          versionRef.current = current.version;
          setVersion(current.version);
          setValue(merged.value);
          onSync("conflict", merged.conflicts ? `${entity} 有 ${merged.conflicts} 条同一记录被其他人更新，已保留最新版本，请复核` : `${entity} 已合并其他人的更新，正在保存你的改动`);
          return;
        }
        if (!response.ok || !body.row) throw new Error(body.error || `${entity} 保存失败`);

        const row = body.row as RemoteStateRow<T>;
        if (row.version <= versionRef.current) return;
        // The server may add or normalize fields while accepting this write
        // (for example, it assigns a new student's immutable studentNumber).
        // Keep that returned payload as the committed baseline. If the user
        // changed something again while this request was in flight, preserve
        // that later local delta against the server-authoritative response.
        const localAfterSubmit = valueRef.current;
        const hasNewerLocalChanges = JSON.stringify(localAfterSubmit) !== payloadSerialized;
        const merged = hasNewerLocalChanges
          ? mergeConcurrentPayload(payload, localAfterSubmit, row.payload)
          : { value: row.payload, conflicts: 0 };
        committedRef.current = JSON.stringify(row.payload);
        valueRef.current = merged.value;
        versionRef.current = row.version;
        setVersion(row.version);
        setValue(merged.value);
        pendingWriteRef.current = JSON.stringify(merged.value) !== JSON.stringify(row.payload);
        onSync(
          merged.conflicts ? "conflict" : "synced",
          merged.conflicts
            ? `${entity} 有 ${merged.conflicts} 条同一记录被服务器更新，请复核`
            : `${entity} 已同步`,
        );
      }).catch(async (error: unknown) => {
        if (scheduledGeneration !== remoteGenerationRef.current || !sentCommittedBaseline) return;
        const failureMessage = error instanceof Error ? error.message : `${entity} 保存失败`;

        // An exception or non-2xx response does not tell us whether the
        // database committed. Invalidate pending timers/queued writes before
        // reading the authoritative entity, so this recovery cannot turn into
        // an automatic retry or a merge of the unconfirmed local delta.
        const recoveryGeneration = remoteGenerationRef.current + 1;
        remoteGenerationRef.current = recoveryGeneration;
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const recovery = await recoverSharedStateAfterUnknownWrite({
          entity,
          committedBaseline: sentCommittedBaseline,
          fetchImpl: fetch,
          timeoutMs: SHARED_STATE_REQUEST_TIMEOUT_MS,
        });
        if (remoteGenerationRef.current !== recoveryGeneration) return;

        // Invalidate any local write that was queued while the GET was in
        // flight. A later user edit starts from this authoritative snapshot
        // with a fresh generation and can be saved normally.
        remoteGenerationRef.current += 1;
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const recoveredRow = recovery.row;
        committedRef.current = JSON.stringify(recoveredRow.payload);
        valueRef.current = recoveredRow.payload;
        versionRef.current = recoveredRow.version;
        setVersion(recoveredRow.version);
        setValue(recoveredRow.payload);
        pendingWriteRef.current = false;
        if (recovery.outcome === "authoritative") {
          onSync("synced", `${entity} 保存结果不确定，已重新读取服务器权威状态（${failureMessage}）`);
        } else {
          onSync(navigator.onLine ? "error" : "offline", `${entity} 保存结果不确定，已回滚到发送前状态，等待共享轮询校正（${failureMessage}）`);
        }
      });
    }, 450);
  }, [actor, autoSave, entity, onSync, readOnly, scopeVersionsKey, value]);

  const applyRemote = useCallback((row: RemoteStateRow<T>) => {
    if (row.version <= versionRef.current) return;
    remoteGenerationRef.current += 1;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const local = valueRef.current;
    const committed = JSON.parse(committedRef.current) as T;
    const hasPendingLocalChanges = JSON.stringify(local) !== committedRef.current;
    const merged = hasPendingLocalChanges ? mergeConcurrentPayload(committed, local, row.payload) : { value: row.payload, conflicts: 0 };
    committedRef.current = JSON.stringify(row.payload);
    valueRef.current = merged.value;
    versionRef.current = row.version;
    setVersion(row.version);
    setValue(merged.value);
    pendingWriteRef.current = JSON.stringify(merged.value) !== JSON.stringify(row.payload);
    onSync(merged.conflicts ? "conflict" : "synced", merged.conflicts ? `${entity} 有 ${merged.conflicts} 条同一记录已更新，请复核` : hasPendingLocalChanges ? `${entity} 已合并其他人的更新` : `${entity} 已接收 ${row.updated_by} 的更新`);
  }, [entity, onSync]);

  const getCurrentVersion = useCallback(() => versionRef.current, []);
  const getCurrentValue = useCallback(() => valueRef.current, []);

  const mutateAndCommit = useCallback((desired: SharedStateDesired<T>) => {
    if (readOnly) return Promise.reject(new Error(`${entity} 只读，不能保存`));

    const next = typeof desired === "function"
      ? (desired as (current: T) => T)(valueRef.current)
      : desired;
    const payloadSerialized = JSON.stringify(next);
    if (payloadSerialized === committedRef.current) {
      pendingWriteRef.current = false;
      onSync("synced", `${entity} 已是服务器最新状态`);
      return Promise.resolve({
        entity,
        payload: next,
        version: versionRef.current,
        updated_at: "",
        updated_by: actor,
      } satisfies SharedStateRow<T>);
    }
    explicitCommitPayloadRef.current = payloadSerialized;
    pendingWriteRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    valueRef.current = next;
    setValue(next);

    let sentCommittedBaseline: SharedStateRow<T> | null = null;
    const queued = queueRef.current.then(async () => {
      const payload = next;
      const baseline: SharedStateRow<T> = {
        entity,
        payload: JSON.parse(committedRef.current) as T,
        version: versionRef.current,
        updated_at: "",
        updated_by: actor,
      };
      sentCommittedBaseline = baseline;
      const received = await fetchJsonWithTimeout(fetch, "/api/app-state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity,
            payload,
            expectedVersion: baseline.version,
            ...(scopeVersionsKey !== "null" ? { scopeVersions: JSON.parse(scopeVersionsKey) } : {}),
          }),
        }, SHARED_STATE_REQUEST_TIMEOUT_MS);
      const { response, body: receivedBody } = received;
      const body = receivedBody ?? {};

      if (response.status === 409 && body.current) {
        const current = body.current as RemoteStateRow<T>;
        if (body.accessChanged || current.version <= versionRef.current) {
          const conflict = new Error(body.error || `${entity} 权限或版本已变化`);
          (conflict as Error & { sharedKnownConflict?: boolean }).sharedKnownConflict = true;
          throw conflict;
        }
        const merged = mergeConcurrentPayload(
          JSON.parse(committedRef.current) as T,
          valueRef.current,
          current.payload,
        );
        remoteGenerationRef.current += 1;
        committedRef.current = JSON.stringify(current.payload);
        versionRef.current = current.version;
        setVersion(current.version);
        setValue(merged.value);
        valueRef.current = merged.value;
        explicitCommitPayloadRef.current = JSON.stringify(merged.value);
        pendingWriteRef.current = JSON.stringify(merged.value) !== JSON.stringify(current.payload);
        onSync("conflict", merged.conflicts
          ? `${entity} 有 ${merged.conflicts} 条同一记录被其他人更新，请复核后重试`
          : `${entity} 已接收其他人的更新，请复核后重试`);
        const conflict = new Error(body.error || `${entity} 版本冲突，请复核后重试`);
        (conflict as Error & { sharedKnownConflict?: boolean }).sharedKnownConflict = true;
        throw conflict;
      }
      if (!response.ok || !body.row) throw new Error(body.error || `${entity} 保存失败`);

      const row = body.row as RemoteStateRow<T>;
      if (row.version <= versionRef.current) {
        // Polling or another authoritative response may have advanced the
        // local version while this PUT was in flight.  An older receipt with
        // the same desired payload confirms the action, but must never roll
        // the current committed version back.  A different payload is a real
        // conflict and must stay visible to the caller.
        const currentCommittedPayload = JSON.parse(committedRef.current) as T;
        if (matchesCommittedSharedPayload(entity, currentCommittedPayload, payload)) {
          const hasNewerLocalChanges = JSON.stringify(valueRef.current) !== committedRef.current;
          pendingWriteRef.current = hasNewerLocalChanges;
          onSync(
            hasNewerLocalChanges ? "saving" : "synced",
            hasNewerLocalChanges
              ? `${entity} 已收到服务器保存回执，后续改动仍在保存`
              : `${entity} 已收到服务器保存回执`,
          );
          return {
            ...row,
            payload: currentCommittedPayload,
            version: versionRef.current,
          };
        }
        const conflict = new Error(`${entity} 权威保存回执已过期，请刷新后重试`);
        (conflict as Error & { sharedKnownConflict?: boolean }).sharedKnownConflict = true;
        onSync("conflict", `${entity} 收到过期保存回执，当前权威版本未被覆盖，请刷新后重试`);
        throw conflict;
      }
      const localAfterSubmit = valueRef.current;
      const hasNewerLocalChanges = JSON.stringify(localAfterSubmit) !== payloadSerialized;
      const merged = hasNewerLocalChanges
        ? mergeConcurrentPayload(payload, localAfterSubmit, row.payload)
        : { value: row.payload, conflicts: 0 };
      committedRef.current = JSON.stringify(row.payload);
      valueRef.current = merged.value;
      versionRef.current = row.version;
      setVersion(row.version);
      setValue(merged.value);
      pendingWriteRef.current = JSON.stringify(merged.value) !== JSON.stringify(row.payload);
      onSync(
        merged.conflicts ? "conflict" : "synced",
        merged.conflicts
          ? `${entity} 有 ${merged.conflicts} 条同一记录被服务器更新，请复核`
          : `${entity} 已收到服务器保存回执`,
      );
      return row;
    }).catch(async (error: unknown) => {
      if ((error as Error & { sharedKnownConflict?: boolean }).sharedKnownConflict) {
        pendingWriteRef.current = JSON.stringify(valueRef.current) !== committedRef.current;
        throw error;
      }

      const recoveryGeneration = remoteGenerationRef.current + 1;
      remoteGenerationRef.current = recoveryGeneration;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const recovery = await recoverSharedStateAfterUnknownWrite({
        entity,
        committedBaseline: sentCommittedBaseline ?? {
          entity,
          payload: JSON.parse(committedRef.current) as T,
          version: versionRef.current,
          updated_at: "",
          updated_by: actor,
        },
        fetchImpl: fetch,
        timeoutMs: SHARED_STATE_REQUEST_TIMEOUT_MS,
      });
      if (remoteGenerationRef.current !== recoveryGeneration) throw error;
      const recoveredRow = recovery.row as RemoteStateRow<T>;
      const matchesDesired = matchesCommittedSharedPayload(entity, recoveredRow.payload, next);
      committedRef.current = JSON.stringify(recoveredRow.payload);
      valueRef.current = recoveredRow.payload;
      versionRef.current = recoveredRow.version;
      setVersion(recoveredRow.version);
      setValue(recoveredRow.payload);
      pendingWriteRef.current = false;
      explicitCommitPayloadRef.current = JSON.stringify(recoveredRow.payload);
      if (matchesDesired && recovery.outcome === "authoritative") {
        onSync("synced", `${entity} 保存回执丢失，但已由服务器权威状态确认`);
        return recoveredRow;
      }
      onSync(
        recovery.outcome === "authoritative" ? "error" : (navigator.onLine ? "error" : "offline"),
        `${entity} 保存结果不确定，已恢复服务器权威状态，请确认后重试`,
      );
      throw error;
    }).finally(() => {
      if (explicitCommitPayloadRef.current === payloadSerialized) explicitCommitPayloadRef.current = null;
      if (JSON.stringify(valueRef.current) === committedRef.current) pendingWriteRef.current = false;
    });

    // Keep the shared queue usable after an explicit failure while returning
    // the original promise to the caller for an authoritative success/error.
    queueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [actor, entity, onSync, readOnly, scopeVersionsKey]);

  return [value, setValue, { version, applyRemote, getCurrentVersion, getCurrentValue, mutateAndCommit }] as const;
}

function nowLabel(preferences = defaultDisplayPreferences()) {
  return formatClock(new Date(), preferences.timezone, preferences);
}

function currentDateTimeValueInTimezone(timezone: string) {
  return dateTimeValueInTimezone(new Date(), timezone);
}

function dateTimeValueInTimezone(value: Date, timezone: string) {
  const parts = zonedParts(value, cleanTimezone(timezone));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function formatFollowUpTime(value?: string, preferences = defaultDisplayPreferences()) {
  if (!value) return preferences.language === "en-AU" ? "No successful follow-up recorded" : "暂无成功跟进记录";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    const suffix = preferences.language === "en-AU" ? "(time not recorded in the historical entry)" : "（历史记录未含具体时间）";
    return `${formatDisplayDate(date, preferences.timezone, preferences)} ${suffix}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDisplayDate(parsed, preferences.timezone, preferences)} ${formatClock(parsed, preferences.timezone, preferences)}`;
}

let uniqueSequence = 0;

// The temporary route bounds each of its five RPC boundaries at 10 seconds
// and BBB at 15 seconds; keep the browser budget below the 90-second server
// ceiling while retaining the actor/request-key retry envelope for any lost
// response.
const CLASSROOM_CLIENT_TIMEOUT_MS = 80_000;
const BOOKING_MUTATION_CLIENT_TIMEOUT_MS = 20_000;

async function classroomFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  try {
    return await fetchJsonWithTimeout(fetch, input, init, CLASSROOM_CLIENT_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("在线教室请求超时，请检查网络后重试；系统会复用同一课堂。");
    }
    throw error;
  }
}

async function bookingMutationFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  try {
    return await fetchJsonWithTimeout(fetch, input, init, BOOKING_MUTATION_CLIENT_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("排课命令请求超时，请稍后重试；系统会复用同一命令。");
    }
    throw error;
  }
}

function id(prefix: string) {
  uniqueSequence += 1;
  return `${prefix}-${Date.now().toString().slice(-6)}-${uniqueSequence}`;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "新";
}

const timezoneOptions = displayTimezoneOptions.map((option) => ({ ...option, label: option.zh }));

function timezoneLabel(value: string, language: InterfaceLanguage = "zh-CN") {
  const timezone = cleanTimezone(value);
  return timezoneLabelFor(timezone, language);
}

function zonedParts(date: Date, timezone: string) {
  const parts = dateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])) as Record<string, string>;
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - date.getTime();
}

function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  return new Date(wallClock - timezoneOffsetMs(first, timezone));
}

function bookingInstant(booking: Booking) {
  return zonedDateTimeToUtc(booking.date, booking.start, cleanTimezone(booking.timezone));
}

function formatDisplayDate(date: Date, timezone: string, preferences = defaultDisplayPreferences()) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  return preferences.dateFormat === "ymd"
    ? `${parts.year}/${parts.month}/${parts.day}`
    : `${parts.day}/${parts.month}/${parts.year}`;
}

function formatInstant(date: Date, timezone: string, preferences = defaultDisplayPreferences()) {
  const safeTimezone = cleanTimezone(timezone);
  const weekday = dateTimeFormat(localeFor(preferences.language), { timeZone: safeTimezone, weekday: "short" }).format(date);
  return `${formatDisplayDate(date, safeTimezone, preferences)} ${weekday} ${formatClock(date, safeTimezone, preferences)}`;
}

function formatHours(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "待匹配";
  return `${Number(value.toFixed(2)).toLocaleString()} 小时`;
}

function formatMoney(amount: number, currency: PayrollRow["currency"] = "AUD") {
  const prefix = currency === "CNY" ? "¥" : "A$";
  return `${prefix}${Number(amount.toFixed(2)).toLocaleString()}`;
}

function payrollCurrencyLabel(currency: PayrollRow["currency"] = "AUD") {
  return currency === "CNY" ? "人民币" : "澳币";
}

function payrollDisplayKey(source: "persisted" | "automatic", id: string, ordinal: number) {
  return `${source}:${id}:${ordinal}`;
}

function maskAccount(value?: string) {
  if (!value) return "未导入";
  if (value.startsWith("尾号")) return value;
  const compact = value.replace(/\s+/g, "");
  if (!compact) return "未导入";
  return `尾号 ${compact.slice(-4)}`;
}

function formatClock(date: Date, timezone: string, preferences = defaultDisplayPreferences()) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  if (preferences.timeFormat === "12h") {
    const hour = Number(parts.hour);
    const marker = preferences.language === "en-AU" ? (hour < 12 ? "am" : "pm") : (hour < 12 ? "上午" : "下午");
    return `${hour % 12 || 12}:${parts.minute} ${marker}`;
  }
  return `${parts.hour}:${parts.minute}`;
}

function isoDateInTimezone(date: Date, timezone: string) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isPastBooking(booking: Booking) {
  const startsAt = bookingInstant(booking).getTime();
  const endsAt = startsAt + Math.max(1, booking.duration || 0) * 60 * 1000;
  return endsAt < Date.now();
}

function formatSourceTime(value?: string | null, preferences = defaultDisplayPreferences()) {
  if (!value) return preferences.language === "en-AU" ? "Never synced" : "从未读取";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDisplayDate(parsed, preferences.timezone, preferences)} ${formatClock(parsed, preferences.timezone, preferences)}`;
}

function formatAuditTime(value: string, preferences = defaultDisplayPreferences()) {
  if (!value || value.startsWith("今天") || value.startsWith("昨天")) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDisplayDate(parsed, preferences.timezone, preferences)} ${formatClock(parsed, preferences.timezone, preferences)}`;
}

function shiftIsoDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function daysBetweenIsoDates(from: string, to: string) {
  const start = new Date(`${from}T12:00:00Z`).getTime();
  const end = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((end - start) / 86400000);
}

function weekDatesForTimezone(timezone: string, preferences = defaultDisplayPreferences()) {
  const today = isoDateInTimezone(new Date(), timezone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = shiftIsoDate(today, weekday === 0 ? -6 : 1 - weekday);
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftIsoDate(monday, index);
    const dateAtNoon = new Date(`${date}T12:00:00Z`);
    return { date, label: dateTimeFormat(localeFor(preferences.language), { weekday: "short", day: "numeric", timeZone: "UTC" }).format(dateAtNoon) };
  });
}

function bookingOccurrencesWithinRange(booking: Booking, rangeStart: string, rangeEnd: string, includeInactive = false): BookingOccurrence[] {
  if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) return [];
  const sourceRange = lessonOccurrenceSourceRangeForTargetRange(
    rangeStart,
    rangeEnd,
    booking.occurrenceOverrides,
  );

  return expandLessonOccurrences(booking, {
    rangeStart: sourceRange.rangeStart,
    rangeEnd: sourceRange.rangeEnd,
    overrides: booking.occurrenceOverrides,
  })
    .filter((occurrence) =>
      occurrence.date >= rangeStart &&
      occurrence.date <= rangeEnd &&
      (includeInactive || (occurrence.status !== "cancelled" && occurrence.status !== "leave")),
    )
    .map((occurrence) => {
      const override = (booking.occurrenceOverrides ?? [])
        .find((item) => item.occurrenceId === occurrence.occurrenceId);
      // Legacy one-off lessons stored completion on the parent booking before
      // concrete occurrence status existed. Recurring parent completion stays
      // deliberately non-inheriting because it cannot prove every lesson ran.
      const occurrenceStatus: LessonOccurrenceStatus = occurrence.status === "confirmed"
        && !booking.recurring
        && booking.status === "已完成"
        && override?.status === undefined
        ? "completed"
        : occurrence.status;
      // Downstream calendar filters consume this effective identity, including
      // substitute-teacher overrides, rather than the parent series identity.
      return {
        ...booking,
        studentId: occurrence.studentId ?? booking.studentId,
        teacherId: occurrence.teacherId ?? booking.teacherId,
        date: occurrence.date,
        start: occurrence.start,
        duration: occurrence.scheduledDurationMinutes,
        occurrenceId: occurrence.occurrenceId,
        sourceDate: occurrence.sourceDate,
        packageId: occurrence.packageId,
        course: occurrence.subjectId ?? booking.course,
        status:
          occurrenceStatus === "completed"
            ? "已完成"
            : occurrenceStatus === "abnormal"
              ? "待确认"
              : booking.recurring && booking.status === "已完成"
                ? "已确认"
                : booking.status,
        occurrenceKey: occurrence.occurrenceId,
        occurrenceStatus,
        classroom: override?.classroom,
      };
    });
}

/**
 * Resolve one occurrence by its immutable source identity.  A moved lesson
 * may share its target date with another moved lesson, so target-date lookup
 * is only a legacy fallback and must be unique.
 */
function bookingOccurrenceByStableKey(
  booking: Booking,
  occurrenceKey: string,
  sourceDate?: string | null,
): BookingOccurrence | undefined {
  if (!occurrenceKey || !occurrenceKey.startsWith(`${booking.id}:`)) return undefined;
  const keySourceDate = occurrenceKey.slice(-10);
  if (!DATE_PATTERN.test(keySourceDate) || (sourceDate && sourceDate !== keySourceDate)) return undefined;
  const override = (booking.occurrenceOverrides ?? []).find((item) => item.occurrenceId === occurrenceKey);
  const targetDate = override?.date ?? keySourceDate;
  if (!DATE_PATTERN.test(targetDate)) return undefined;
  try {
    const matches = bookingOccurrencesWithinRange(booking, targetDate, targetDate, true)
      .filter((occurrence) => occurrence.occurrenceKey === occurrenceKey);
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function uniqueBookingOccurrenceForTargetDate(booking: Booking, targetDate: string): BookingOccurrence | undefined {
  if (!DATE_PATTERN.test(targetDate)) return undefined;
  try {
    const matches = bookingOccurrencesWithinRange(booking, targetDate, targetDate, true)
      .filter((occurrence) => occurrence.date === targetDate);
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function recurrenceEndDateDerivedFromCount(booking: Booking | null) {
  if (!booking?.recurring || !Number.isSafeInteger(booking.repeatCount) || !booking.recurrenceEndDate) return undefined;
  try {
    const derivedEndDate = recurrenceSourceEndDate({
      startDate: booking.date,
      recurring: true,
      repeatCount: booking.repeatCount,
      ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
    });
    return derivedEndDate === booking.recurrenceEndDate ? derivedEndDate : undefined;
  } catch {
    return undefined;
  }
}

function lpPublishedDay(item: LpItem) {
  if (!item.publishedDate) return null;
  const elapsed = Math.max(0, daysBetweenIsoDates(item.publishedDate, isoDateInTimezone(new Date(), "Australia/Melbourne")));
  return `已发布第 ${elapsed + 1} 天`;
}

function isActiveStudent(student: Student) {
  return student.status === "在读" || student.status === "活跃 + 有课时" || student.status === "活跃 + 无课时" || student.status === "在读 + 加课待排";
}

function requiresLp(student: Student) {
  return Boolean(student.lpNeed && student.lpNeed !== "无需LP" && student.lpNeed !== "待确认");
}

function availabilitySummary(teacher: Teacher) {
  const month = isoDateInTimezone(new Date(), "Australia/Melbourne").slice(0, 7);
  const monthWindows = (teacher.availabilityWindows ?? []).filter(
    (window) => window.validFrom.slice(0, 7) <= month && window.validTo.slice(0, 7) >= month,
  );
  if (!monthWindows.length) return { title: "本月未收集", detail: "月度 AVA", raw: true };
  return { title: `${monthWindows.length} 个固定时段`, detail: `${month} · 已收集`, raw: false };
}

function teacherCapacitySummary(teacher: Teacher) {
  if (teacher.newStudentCapacity === undefined) return { value: "待录入", detail: "可接新生" };
  const assigned = new Set(teacher.capacityAssignments ?? []).size;
  const total = assigned + teacher.newStudentCapacity;
  return {
    value: `${assigned} / ${total}`,
    detail: `剩余 ${teacher.newStudentCapacity} 人`,
  };
}

function teacherAvailableAt(teacher: Teacher, date: string, start: string, duration: number, inputTimezone: string) {
  if (!teacher.availabilityWindows?.length) return false;
  try {
    const requestedStart = zonedDateTimeToUtc(date, start, inputTimezone);
    const requestedEnd = new Date(requestedStart.getTime() + duration * 60000);
    const requestedUtcDate = requestedStart.toISOString().slice(0, 10);
    const occurrences = expandTeacherAvailability(teacher.availabilityWindows, {
      from: shiftIsoDate(requestedUtcDate, -1),
      to: shiftIsoDate(requestedUtcDate, 1),
      displayTimezone: "UTC",
    });
    return occurrences.some((occurrence) =>
      requestedStart.getTime() >= new Date(occurrence.startsAt).getTime()
      && requestedEnd.getTime() <= new Date(occurrence.endsAt).getTime(),
    );
  } catch {
    return false;
  }
}

function bookingHasDstRisk(booking: Booking, student: Student, teacher: Teacher) {
  if (!booking.recurring) return false;
  const projectionHorizon = shiftIsoDate(booking.date, 140);
  let recurrenceEnd: string | undefined;
  try {
    recurrenceEnd = recurrenceSourceEndDate({
      startDate: booking.date,
      recurring: true,
      ...(Number.isSafeInteger(booking.repeatCount) ? { repeatCount: booking.repeatCount } : {}),
      ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
      ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
    });
  } catch {
    recurrenceEnd = undefined;
  }
  const rangeEnd = recurrenceEnd && recurrenceEnd < projectionHorizon ? recurrenceEnd : projectionHorizon;
  const occurrences = bookingOccurrencesWithinRange(booking, booking.date, rangeEnd);
  if (occurrences.length < 2) return false;
  const studentTimezone = cleanTimezone(student.timezone);
  const teacherTimezone = cleanTimezone(teacher.timezone);
  const initialInstant = bookingInstant(occurrences[0]);
  const initialDifference = timezoneOffsetMs(initialInstant, studentTimezone) - timezoneOffsetMs(initialInstant, teacherTimezone);
  return occurrences.slice(1).some((occurrence) => {
    const instant = bookingInstant(occurrence);
    return timezoneOffsetMs(instant, studentTimezone) - timezoneOffsetMs(instant, teacherTimezone) !== initialDifference;
  });
}

type ExamDisplayStatus = "pending" | "completed" | "not_required";

/**
 * Structured exam history is authoritative. The legacy fields are retained
 * only for old snapshots that do not have an exams array at all.
 */
function examRecordsForStudent(student: Student): StudentExamRecord[] {
  if (Array.isArray(student.exams)) return student.exams;
  const examDate = student.examDate;
  const examMonth = examDate?.slice(0, 7) ?? student.renewalMonth;
  if (!examMonth || !/^\d{4}-\d{2}$/.test(examMonth) || (!examDate && !student.examSubject)) return [];
  return [{
    id: `legacy-exam:${student.id}:${examMonth}:${student.examSubject ?? student.course}`,
    subject: student.examSubject ?? student.course,
    examType: "other",
    examMonth,
    ...(examDate ? { examDate } : {}),
    ...(student.resultDate ? { resultDateOverride: student.resultDate } : {}),
  }];
}

function examMonthLabel(month: string, preferences: DisplayPreferences) {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(monthNumber)) return month;
  return dateTimeFormat(localeFor(preferences.language), {
    year: "numeric",
    month: "long",
    timeZone: "Australia/Melbourne",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 15, 12)));
}

function examDateOrMonthLabel(exam: StudentExamRecord, preferences: DisplayPreferences) {
  return exam.examDate ?? `${examMonthLabel(exam.examMonth, preferences)}（月份待确认）`;
}

function examFollowUpStatusLabel(status: ExamDisplayStatus) {
  return status === "completed" ? "已完成" : status === "not_required" ? "不适用" : "待跟进";
}

function examFollowUpStatusTone(status: ExamDisplayStatus): Tone {
  return status === "completed" ? "green" : status === "not_required" ? "neutral" : "amber";
}

function statusTone(status: Student["status"] | TaskStatus | PayrollRow["status"] | Renewal["status"]): Tone {
  const map: Record<string, Tone> = {
    "在读": "green", "活跃 + 有课时": "green", "活跃 + 无课时": "amber", "在读 + 加课待排": "blue", "不活跃 + 有课时": "neutral", "不活跃 + 无课时": "neutral",
    overdue: "red", today: "amber", upcoming: "blue", waiting: "purple", done: "green",
    "需核对": "amber", "可审核": "blue", "已锁定": "green",
    "待跟进": "amber", "已联系": "blue", "已跟进": "blue", "本次未跟进": "amber", "等待家长": "purple", "已确认": "green",
    "已续课": "green", "未续课-活跃": "amber", "未续课-不活跃": "neutral", "未续课-不活跃（已考完）": "neutral",
  };
  return map[status] ?? "neutral";
}

function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Avatar({ initials: letters, tone = "blue" }: { initials: string; tone?: Tone }) {
  return <span className={`avatar ${tone}`}>{letters}</span>;
}

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return <button className="icon-button" aria-label={label} title={label} type="button" onClick={onClick}>{children}</button>;
}

function globalSearchOriginSignature(element: HTMLElement) {
  return JSON.stringify({
    tag: element.tagName,
    className: element.className,
    label: element.getAttribute("aria-label") ?? "",
    searchTrigger: element.hasAttribute("data-global-search-trigger"),
    text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
  });
}

function isCurrentGlobalSearchOrigin(element: HTMLElement) {
  const expected = element.getAttribute("data-global-search-origin-signature");
  return Boolean(expected && expected === globalSearchOriginSignature(element));
}

function clearGlobalSearchOriginMarker(element: HTMLElement | null | undefined) {
  element?.removeAttribute("data-global-search-origin");
  element?.removeAttribute("data-global-search-origin-signature");
}

function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header"><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
        {children}
      </section>
    </div>
  );
}

function ViewTabs({ value, items, onChange, label = "保存视图" }: { value: string; items: Array<{ id: string; label: string; count?: number }>; onChange: (value: string) => void; label?: string }) {
  return <div className="view-tabs" role="group" aria-label={label}>{items.map((item) => <button className={value === item.id ? "active" : ""} type="button" aria-pressed={value === item.id} key={item.id} onClick={() => onChange(item.id)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</div>;
}

function ListToolbar({ query, onQuery, placeholder, children }: { query: string; onQuery: (value: string) => void; placeholder: string; count: string; children?: ReactNode }) {
  return <div className="collection-toolbar"><div className="search-field"><Search size={16} aria-hidden="true" /><input name="list-search" type="search" autoComplete="off" value={query} onChange={(event) => onQuery(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></div><div className="toolbar-actions">{children}</div></div>;
}

function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  return <footer className="pagination"><div><button type="button" aria-label="上一页" disabled={safePage <= 1} onClick={() => onPage(safePage - 1)}><ChevronLeft size={16} /></button><strong>第 {safePage} / {pageCount} 页</strong><button type="button" aria-label="下一页" disabled={safePage >= pageCount} onClick={() => onPage(safePage + 1)}><ChevronRight size={16} /></button></div></footer>;
}

function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="collection-empty" role="status" aria-live="polite"><Search size={22} aria-hidden="true" /><strong>{title}</strong>{detail ? <span>{detail}</span> : null}{action ? <div className="collection-empty-action">{action}</div> : null}</div>;
}

function PasswordUsernameContext({ login }: { login: string }) {
  return <input
    aria-label="登录账号"
    autoComplete="username"
    className="visually-hidden"
    name="username"
    readOnly
    tabIndex={-1}
    type="text"
    value={login}
  />;
}

function AccountPasswordForm({
  accountLabel,
  accountLogin,
  forced = false,
  onChanged,
  onCancel,
  onLogout,
  logoutBusy = false,
  logoutError = "",
}: {
  accountLabel: string;
  accountLogin: string;
  forced?: boolean;
  onChanged: () => void;
  onCancel?: () => void;
  onLogout?: () => void;
  logoutBusy?: boolean;
  logoutError?: string;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commandRef = useRef<{ intent: string; commandKey: string } | null>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!forced || !window.matchMedia("(min-width: 761px) and (pointer: fine)").matches) return;
    const frame = window.requestAnimationFrame(() => currentPasswordRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [forced]);

  const resetIntent = () => {
    commandRef.current = null;
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致。");
      return;
    }
    const intent = JSON.stringify([currentPassword, newPassword]);
    const commandKey = commandRef.current?.intent === intent
      ? commandRef.current.commandKey
      : "account-password:" + crypto.randomUUID();
    commandRef.current = { intent, commandKey };
    setBusy(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandKey, currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => null) as { error?: string; changed?: boolean; reauthRequired?: boolean } | null;
      if (!response.ok || !body?.changed) {
        setError(body?.error || "修改密码失败，请稍后重试。");
        return;
      }
      commandRef.current = null;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      if (body.reauthRequired) {
        window.location.reload();
        return;
      }
      onChanged();
    } catch {
      setError("网络暂时不可用，请保持页面打开后重试。");
    } finally {
      setBusy(false);
    }
  };

  return <form className="form-grid account-password-form" onSubmit={submit}>
    <PasswordUsernameContext login={accountLogin} />
    {forced && <div className="form-notice span-2"><KeyRound size={16} /> 管理员已重置此账号密码。请先设置只有你知道的新密码，再继续使用系统。</div>}
    <div className="account-password-identity span-2"><small>当前账号</small><strong>{accountLabel}</strong></div>
    <label className="span-2">当前密码<input ref={currentPasswordRef} name="currentPassword" data-dialog-autofocus="true" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); resetIntent(); }} maxLength={256} required /></label>
    <label className="span-2">新密码<input name="newPassword" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); resetIntent(); }} minLength={12} maxLength={128} required /></label>
    <label className="span-2">再次输入新密码<input name="confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); resetIntent(); }} minLength={12} maxLength={128} required /></label>
    <p className="form-footnote span-2">至少 12 个字符，同时包含字母和数字；不要使用账号名称。</p>
    {error && <div className="form-error span-2" role="alert">{error}</div>}
    {!error && logoutError && <div className="form-error span-2" role="alert">{logoutError}</div>}
    <footer>
      {forced && onLogout
        ? <button className="secondary-button" type="button" disabled={busy || logoutBusy} onClick={onLogout}><LogOut size={15} />{logoutBusy ? "正在退出" : "退出登录"}</button>
        : onCancel ? <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消</button> : null}
      <button className="primary-button" type="submit" disabled={busy}><KeyRound size={16} />{busy ? "正在更新…" : "更新密码"}</button>
    </footer>
  </form>;
}

function AuthPasswordChangeScreen({ user, onChanged, onLogout, logoutBusy, logoutError }: { user: string; onChanged: () => void; onLogout: () => void; logoutBusy: boolean; logoutError: string }) {
  return <main className="login-shell password-change-shell">
    <section className="login-panel password-change-panel">
      <div className="brand-mark">吟</div>
      <h1>请先设置新密码</h1>
      <AccountPasswordForm accountLabel={user === "Nixon" ? "Admin" : user} accountLogin={user} forced onChanged={onChanged} onLogout={onLogout} logoutBusy={logoutBusy} logoutError={logoutError} />
    </section>
  </main>;
}

async function fetchSupabaseSnapshot() {
  const response = await fetch("/api/app-snapshot", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "真实资料读取失败。");
  const payload = body as ImportPayload;
  const managedExamSnapshot = parseManagedExamProjectionSnapshot(
    body.managedExamSnapshot,
    body.versions ?? {},
  );
  const managedTrialPaymentSnapshot = parseManagedTrialPaymentProjectionSnapshot(
    body.managedTrialPaymentSnapshot,
    body.versions ?? {},
  );
  return {
    ...payload,
    managedExamSnapshot,
    managedExamStudents: [...managedExamSnapshot.students],
    managedTrialPaymentSnapshot,
  };
}

class JiaowubaoImportedScheduleReadFailure extends Error {
  constructor(readonly code: JiaowubaoImportedScheduleReadError) {
    super(code);
  }
}

class JiaowubaoCompletedLessonReadFailure extends Error {
  constructor(readonly code: "reset" | "unavailable") {
    super(code);
  }
}

async function readJiaowubaoCompletedLessonPage(input: Readonly<{
  month: string;
  pageIndex: number;
  revision: string | null;
  projectionRevision: string | null;
  source: "lessons";
  signal?: AbortSignal;
}>): Promise<JiaowubaoCompletedLessonPage>;
async function readJiaowubaoCompletedLessonPage(input: Readonly<{
  month: string;
  pageIndex: number;
  revision: string | null;
  projectionRevision: string | null;
  source: "schedules";
  signal?: AbortSignal;
}>): Promise<JiaowubaoCompletedSchedulePage>;
async function readJiaowubaoCompletedLessonPage(input: Readonly<{
  month: string;
  pageIndex: number;
  revision: string | null;
  projectionRevision: string | null;
  source: "lessons" | "schedules";
  signal?: AbortSignal;
}>): Promise<JiaowubaoCompletedMonthEvidencePage> {
  const query = new URLSearchParams({ month: input.month, page: String(input.pageIndex), source: input.source });
  if (input.revision) query.set("revision", input.revision);
  if (input.projectionRevision) query.set("projectionRevision", input.projectionRevision);
  const response = await fetch(`/api/jiaowubao-open-api/completed-lessons?${query.toString()}`, {
    cache: "no-store",
    signal: input.signal,
  });
  const body = await response.json().catch(() => null);
  if (response.status === 409) {
    const page = parseJiaowubaoCompletedMonthEvidencePage(body);
    if (page.state === "reset") throw new JiaowubaoCompletedLessonReadFailure("reset");
    throw new JiaowubaoCompletedLessonReadFailure("unavailable");
  }
  if (!response.ok) throw new JiaowubaoCompletedLessonReadFailure("unavailable");
  const page = parseJiaowubaoCompletedMonthEvidencePage(body);
  if (page.state === "reset") throw new JiaowubaoCompletedLessonReadFailure("reset");
  if (page.source !== input.source) throw new JiaowubaoCompletedLessonReadFailure("unavailable");
  return page as JiaowubaoCompletedMonthEvidencePage;
}

async function readRemainingJiaowubaoCompletedLessonPages<
  Page extends JiaowubaoCompletedLessonPage | JiaowubaoCompletedSchedulePage,
>(input: Readonly<{
  first: Page;
  source: Page["source"];
  month: string;
  signal?: AbortSignal;
}>): Promise<Page[]> {
  if (input.first.state !== "complete" || !input.first.revision || !input.first.projectionRevision) {
    throw new JiaowubaoCompletedLessonReadFailure("reset");
  }
  const pages: Page[] = [input.first];
  // Four concurrent 250-row reads per source keep an immutable month bounded
  // in the browser. Both feeds are still revision-pinned before combining.
  for (let start = 1; start < input.first.pageCount; start += 4) {
    const pageIndexes = Array.from(
      { length: Math.min(4, input.first.pageCount - start) },
      (_, offset) => start + offset,
    );
    const batch = await Promise.all(pageIndexes.map(async (pageIndex) => {
      const page = input.source === "lessons"
        ? await readJiaowubaoCompletedLessonPage({ month: input.month, pageIndex, revision: input.first.revision, projectionRevision: input.first.projectionRevision, source: "lessons", signal: input.signal })
        : await readJiaowubaoCompletedLessonPage({ month: input.month, pageIndex, revision: input.first.revision, projectionRevision: input.first.projectionRevision, source: "schedules", signal: input.signal });
      // Do this here rather than only in the final combiner so a source or
      // mapping revision race receives the documented one-shot restart.
      // `publishedAt` is informational and can differ on legacy snapshots;
      // the immutable source + mapping revisions are the identities.
      if (page.source !== input.source || page.state !== "complete"
        || page.month !== input.first.month || page.revision !== input.first.revision
        || page.projectionRevision !== input.first.projectionRevision
        || page.rowCount !== input.first.rowCount || page.pageCount !== input.first.pageCount) {
        throw new JiaowubaoCompletedLessonReadFailure("reset");
      }
      return page as Page;
    }));
    pages.push(...batch);
  }
  return pages;
}

/**
 * Loads every bounded page for one version-pinned month.  One retry handles a
 * concurrent completed-lesson sync; partial pages never reach payroll or a
 * student/teacher detail panel.
 */
async function loadAllJiaowubaoCompletedLessonPages(input: Readonly<{
  month: string;
  signal?: AbortSignal;
}>): Promise<JiaowubaoCompletedLessonFeed> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const firstLesson = await readJiaowubaoCompletedLessonPage({
        month: input.month,
        pageIndex: 0,
        revision: null,
        projectionRevision: null,
        source: "lessons",
        signal: input.signal,
      });
      const firstSchedule = await readJiaowubaoCompletedLessonPage({
        month: input.month,
        pageIndex: 0,
        revision: firstLesson.state === "complete" ? firstLesson.revision : null,
        projectionRevision: firstLesson.state === "complete" ? firstLesson.projectionRevision : null,
        source: "schedules",
        signal: input.signal,
      });
      if (firstLesson.month !== firstSchedule.month
        || firstLesson.state !== firstSchedule.state
        || (firstLesson.state === "complete" && (
          firstLesson.revision !== firstSchedule.revision
          || firstLesson.projectionRevision !== firstSchedule.projectionRevision
        ))) {
        throw new JiaowubaoCompletedLessonReadFailure("reset");
      }
      if (firstLesson.state === "absent" || firstSchedule.state === "absent") {
        return completeJiaowubaoCompletedMonthEvidencePages({
          lessonPages: [firstLesson],
          schedulePages: [firstSchedule],
        });
      }
      if (firstLesson.state !== "complete" || !firstLesson.revision || !firstLesson.projectionRevision
        || firstSchedule.state !== "complete" || !firstSchedule.revision || !firstSchedule.projectionRevision) {
        throw new JiaowubaoCompletedLessonReadFailure("reset");
      }
      const [lessonPages, schedulePages] = await Promise.all([
        readRemainingJiaowubaoCompletedLessonPages({ first: firstLesson, source: "lessons", month: input.month, signal: input.signal }),
        readRemainingJiaowubaoCompletedLessonPages({ first: firstSchedule, source: "schedules", month: input.month, signal: input.signal }),
      ]);
      return completeJiaowubaoCompletedMonthEvidencePages({ lessonPages, schedulePages });
    } catch (error) {
      if (error instanceof JiaowubaoCompletedLessonReadFailure && error.code === "reset" && attempt === 0) {
        continue;
      }
      throw error;
    }
  }
  throw new JiaowubaoCompletedLessonReadFailure("unavailable");
}

/** Reads only the bounded, opaque mapping-review DTO from the high-tier route. */
async function readJiaowubaoScheduleMappingReview(cursor: string | null = null, signal?: AbortSignal) {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
  const response = await fetch(`/api/jiaowubao-direct-import/schedule-mappings${query}`, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error("教务宝映射候选读取失败。");
  return parseJiaowubaoScheduleMappingReview(body);
}

/** Reads the current/future queue within one immutable UTC 63-day window. */
async function readJiaowubaoScheduleMappingPriorityReview(
  window: Readonly<{ startsAt: string; endsAt: string }>,
  cursor: string | null = null,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    windowStart: window.startsAt,
    windowEnd: window.endsAt,
  });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/jiaowubao-direct-import/schedule-mappings/priority?${query.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error("当前教务宝映射待核对读取失败。");
  const review = parseJiaowubaoScheduleMappingPriorityReview(body);
  if (review.window.startsAt !== window.startsAt || review.window.endsAt !== window.endsAt) {
    throw new Error("当前教务宝映射待核对时间范围已变化。");
  }
  return review;
}

export type OperationsInitialSession = Readonly<{
  user: string;
  role: DemoSessionRole | "";
  mustChangePassword: boolean;
}>;

function workspaceSessionRole(role: DemoSessionRole | ""): DemoSessionRole {
  return role === "" ? "staff" : role;
}

export default function OperationsApp({ initialSession }: { initialSession: OperationsInitialSession }) {
  const [initialData, setInitialData] = useState<ImportPayload | null>(null);
  const [nixonAuthenticated, setNixonAuthenticated] = useState(false);
  const [sessionMustChangePassword, setSessionMustChangePassword] = useState(initialSession.mustChangePassword);
  const [passwordLogoutBusy, setPasswordLogoutBusy] = useState(false);
  const [passwordLogoutError, setPasswordLogoutError] = useState("");
  const [dataError, setDataError] = useState("");

  useEffect(() => {
    if (sessionMustChangePassword) return;

    let active = true;
    Promise.all([
      fetchSupabaseSnapshot(),
      fetch("/api/nixon-session", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ ok: false })),
    ])
      .then(([payload, nixonSession]) => {
        if (!active) return;
        setNixonAuthenticated(Boolean(nixonSession.ok));
        setDataError("");
        setInitialData(payload);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDataError(error instanceof Error ? error.message : "Supabase 数据读取失败。");
        setInitialData(null);
      });

    return () => {
      active = false;
    };
  }, [sessionMustChangePassword]);

  const logoutFromPasswordChange = async () => {
    if (passwordLogoutBusy) return;
    setPasswordLogoutBusy(true);
    setPasswordLogoutError("");
    try {
      const response = await fetch("/api/demo-logout", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.serverSessionRevoked === true) {
        window.location.reload();
        return;
      }
      if (body.localLogout === true) {
        window.sessionStorage.setItem(
          LOGOUT_RETRY_NOTICE_KEY,
          typeof body.error === "string" ? body.error : "本机已退出；服务器会话撤销将在后台重试。",
        );
        window.location.reload();
        return;
      }
      throw new Error(typeof body.error === "string" ? body.error : "退出失败，请重试。");
    } catch (error) {
      setPasswordLogoutBusy(false);
      setPasswordLogoutError(error instanceof Error ? error.message : "退出失败，请重试。");
    }
  };

  if (sessionMustChangePassword) return <AuthPasswordChangeScreen user={initialSession.user} onChanged={() => setSessionMustChangePassword(false)} onLogout={() => void logoutFromPasswordChange()} logoutBusy={passwordLogoutBusy} logoutError={passwordLogoutError} />;
  if (dataError) return <AuthStatusScreen title="无法读取真实资料" detail={dataError} />;
  if (!initialData) return <AuthStatusScreen title="正在加载资料" detail="已通过验证，正在读取学生和老师数据。" />;

  return <OperationsWorkspace key={`${initialSession.role}:${initialSession.user}`} initialData={initialData} initialNixonUnlocked={nixonAuthenticated} initialOperator={initialSession.user} initialRole={workspaceSessionRole(initialSession.role)} />;
}

function OperationsWorkspace({ initialData, initialNixonUnlocked, initialOperator, initialRole }: { initialData?: ImportPayload; initialNixonUnlocked: boolean; initialOperator: string; initialRole: DemoSessionRole }) {
  const defaults = useMemo(() => buildRuntimeDefaults(initialData), [initialData]);
  const [active, setActive] = useWorkspaceLocation<Section>("section", "dashboard");
  const isAvaCalendarView = active === "ava-calendar";
  const sessionOperator = initialOperator || (initialNixonUnlocked ? "Nixon" : defaults.defaultStudents.find((student) => student.owner && student.owner !== "Nixon")?.owner ?? "Abby");
  const isAdminSession = initialNixonUnlocked && initialRole === "admin" && sessionOperator === "Nixon";
  const [currentOperator, setCurrentOperator] = useState(sessionOperator);
  const [displayPreferences, setDisplayPreferences] = useState<DisplayPreferences>(() => readAccountDisplayPreferences(sessionOperator, initialRole, (key) => window.localStorage.getItem(key)));
  const taskDeadlineTimeZone = cleanTimezone(displayPreferences.timezone);
  const taskDeadlineTimeZoneLabel = timezoneLabelFor(taskDeadlineTimeZone, displayPreferences.language);
  const [displayPreferencesOpen, setDisplayPreferencesOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarCollapseReady, setSidebarCollapseReady] = useState(false);
  const [sharedSyncState, setSharedSyncState] = useState<SharedSyncState>("synced");
  const [sharedSyncMessage, setSharedSyncMessage] = useState("已同步");
  const reportSharedSync = useCallback((state: SharedSyncState, message = "") => {
    setSharedSyncState(state);
    if (message) setSharedSyncMessage(message);
  }, []);
  const versionFor = (entity: string) => initialData?.versions?.[entity] ?? 1;
  const [students, , studentsShared] = useSharedState("students", defaults.defaultStudents, versionFor("students"), currentOperator, reportSharedSync);
  const [teachers, , teachersShared] = useSharedState("teachers", defaults.defaultTeachers, versionFor("teachers"), currentOperator, reportSharedSync);
  const [tasks, setTasks, tasksShared] = useSharedState("tasks", defaults.defaultTasks, versionFor("tasks"), currentOperator, reportSharedSync, false, undefined, !isAvaCalendarView);
  const bookingScopeVersions = useMemo(() => ({
    students: studentsShared.version,
    teachers: teachersShared.version,
  }), [studentsShared.version, teachersShared.version]);
  const [bookings, setBookings, bookingsShared] = useSharedState("bookings", defaults.defaultBookings, versionFor("bookings"), currentOperator, reportSharedSync, false, bookingScopeVersions);
  const [courses, , coursesShared] = useSharedState("courses", defaults.defaultCourses, versionFor("courses"), currentOperator, reportSharedSync);
  const [lpItems, , lpShared] = useSharedState("lpItems", defaults.defaultLpItems, versionFor("lpItems"), currentOperator, reportSharedSync);
  const [operations, setOperations, operationsShared] = useSharedState("operations", defaults.defaultOperations, versionFor("operations"), currentOperator, reportSharedSync);
  const [renewals, , renewalsShared] = useSharedState("renewals", defaults.defaultRenewals, versionFor("renewals"), currentOperator, reportSharedSync);
  const [payrollState, , payrollShared] = useSharedState("payroll", defaults.defaultPayroll, versionFor("payroll"), currentOperator, reportSharedSync);
  const payroll = useMemo(
    () => payrollState.filter((row): row is PayrollRow => !("kind" in row)),
    [payrollState],
  );
  const payrollLedger = useMemo(
    () => payrollState.filter((row): row is TeacherPayrollLedgerRow => "kind" in row),
    [payrollState],
  );
  const commitPayroll = payrollShared.mutateAndCommit;
  const getCurrentPayrollState = payrollShared.getCurrentValue;
  const getCurrentPayrollVersion = payrollShared.getCurrentVersion;
  const mutatePayrollAndCommit = useCallback((desired: SharedStateDesired<PayrollRow[]>) => (
    commitPayroll((current) => {
      const currentSummaryRows = current.filter((row): row is PayrollRow => !("kind" in row));
      const currentLedgerRows = current.filter((row): row is TeacherPayrollLedgerRow => "kind" in row);
      const nextSummaryRows = typeof desired === "function"
        ? (desired as (current: PayrollRow[]) => PayrollRow[])(currentSummaryRows)
        : desired;
      return [...nextSummaryRows, ...currentLedgerRows];
    })
  ), [commitPayroll]);
  const [messages, , messagesShared] = useSharedState("messages", defaults.defaultMessages, versionFor("messages"), currentOperator, reportSharedSync);
  const [files, , filesShared] = useSharedState("files", defaults.defaultFiles, versionFor("files"), currentOperator, reportSharedSync);
  const [audit, setAudit, auditShared] = useSharedState("audit", defaults.defaultAudit, versionFor("audit"), currentOperator, reportSharedSync, true);
  const [rules, , rulesShared] = useSharedState("rules", defaults.defaultRules, versionFor("rules"), currentOperator, reportSharedSync, true);
  const [dataSnapshot, , dataSnapshotShared] = useSharedState("dataSnapshot", defaults.defaultDataSnapshot, versionFor("dataSnapshot"), currentOperator, reportSharedSync);
  const getCurrentBookingsVersion = bookingsShared.getCurrentVersion;
  const getCurrentStudentsVersion = studentsShared.getCurrentVersion;
  const getCurrentLpItemsVersion = lpShared.getCurrentVersion;
  const getCurrentTasksVersion = tasksShared.getCurrentVersion;
  const getCurrentTeachersVersion = teachersShared.getCurrentVersion;
  const applyStudentsRemote = studentsShared.applyRemote;
  const applyTasksRemote = tasksShared.applyRemote;
  const applyOperationsRemote = operationsShared.applyRemote;
  const applyRemoteTrialPaymentTasks = tasksShared.applyRemote;
  const [managedExamProjectionSnapshot, setManagedExamProjectionSnapshot] = useState<ManagedExamProjectionSnapshot>(() => initialData?.managedExamSnapshot ?? {
    versions: {
      students: versionFor("students"),
      tasks: versionFor("tasks"),
    },
    students: [],
  });
  const managedExamProjectionRef = useRef(managedExamProjectionSnapshot);
  const managedExamRefreshRequiredRef = useRef(!initialData?.managedExamSnapshot);
  const replaceManagedExamProjection = useCallback((snapshot: ManagedExamProjectionSnapshot) => {
    managedExamProjectionRef.current = snapshot;
    managedExamRefreshRequiredRef.current = false;
    setManagedExamProjectionSnapshot(snapshot);
  }, []);
  const clearManagedExamProjection = useCallback(() => {
    managedExamRefreshRequiredRef.current = true;
    const current = managedExamProjectionRef.current;
    if (!current.students.length) return;
    const cleared = { ...current, students: [] } satisfies ManagedExamProjectionSnapshot;
    managedExamProjectionRef.current = cleared;
    setManagedExamProjectionSnapshot(cleared);
  }, []);
  const [managedTrialPaymentProjectionSnapshot, setManagedTrialPaymentProjectionSnapshot] = useState<ManagedTrialPaymentProjectionSnapshot>(() => initialData?.managedTrialPaymentSnapshot ?? {
    versions: {
      bookings: versionFor("bookings"),
      students: versionFor("students"),
      lpItems: versionFor("lpItems"),
      tasks: versionFor("tasks"),
    },
    students: [],
  });
  const managedTrialPaymentProjectionRef = useRef(managedTrialPaymentProjectionSnapshot);
  const managedTrialPaymentRefreshRequiredRef = useRef(!initialData?.managedTrialPaymentSnapshot);
  const replaceManagedTrialPaymentProjection = useCallback((snapshot: ManagedTrialPaymentProjectionSnapshot) => {
    managedTrialPaymentProjectionRef.current = snapshot;
    managedTrialPaymentRefreshRequiredRef.current = false;
    setManagedTrialPaymentProjectionSnapshot(snapshot);
  }, []);
  const clearManagedTrialPaymentProjection = useCallback(() => {
    managedTrialPaymentRefreshRequiredRef.current = true;
    const current = managedTrialPaymentProjectionRef.current;
    if (!current.students.length) return;
    const cleared = { ...current, students: [] } satisfies ManagedTrialPaymentProjectionSnapshot;
    managedTrialPaymentProjectionRef.current = cleared;
    setManagedTrialPaymentProjectionSnapshot(cleared);
  }, []);
  const [syncSources, setSyncSources] = useState<SyncSource[]>(initialData?.syncSources ?? []);
  const [syncRefreshBusy, setSyncRefreshBusy] = useState(false);
  const [studentImportBusy, setStudentImportBusy] = useState(false);
  const [studentImportPreview, setStudentImportPreview] = useState<StudentImportPreview | null>(null);
  const [studentImportSourceBusy, setStudentImportSourceBusy] = useState<StudentImportSourceKind | null>(null);
  const [studentImportSourceStatus, setStudentImportSourceStatus] = useState<Partial<Record<StudentImportSourceKind, StudentImportSourceIngestResult>>>({});
  const [studentImportSourceMeta, setStudentImportSourceMeta] = useState<Record<StudentImportSourceKind, { sourceId: string; revision: string }>>({
    master: { sourceId: "student-master-list", revision: "" },
    jwb: { sourceId: "jiaowubao-export", revision: "" },
  });
  const [studentImportSourceJson, setStudentImportSourceJson] = useState<Record<StudentImportSourceKind, string>>({
    master: "",
    jwb: "",
  });
  const [studentIdentityLinkBusy, setStudentIdentityLinkBusy] = useState(false);
  const [studentIdentityLinkStatus, setStudentIdentityLinkStatus] = useState<{ count: number; unchanged: boolean } | null>(null);
  const [studentIdentityReviewCandidates, setStudentIdentityReviewCandidates] = useState<StudentIdentityReviewCandidate[] | null>(null);
  const [studentIdentityReviewClearKey, setStudentIdentityReviewClearKey] = useState<string | null>(null);
  const [studentIdentityManualReview, setStudentIdentityManualReview] = useState<StudentIdentityManualReview | null>(null);
  const [studentIdentityManualMasterToken, setStudentIdentityManualMasterToken] = useState("");
  const [studentIdentityManualJwbToken, setStudentIdentityManualJwbToken] = useState("");
  const [studentIdentityManualExistingToken, setStudentIdentityManualExistingToken] = useState("");
  const [studentIdentityManualDecision, setStudentIdentityManualDecision] = useState<"create" | "merge">("create");
  const [studentIdentityAnnotationBusy, setStudentIdentityAnnotationBusy] = useState(false);
  const [studentIdentityAnnotationPreview, setStudentIdentityAnnotationPreview] = useState<StudentIdentityAnnotationReviewPreview | null>(null);
  const [studentMasterResolutionBusy, setStudentMasterResolutionBusy] = useState<string | null>(null);
  const [studentJwbNegativePolicy] = useState<"reject" | "aggregate-only">("reject");
  const [teacherImportBusy, setTeacherImportBusy] = useState(false);
  const [teacherImportPreview, setTeacherImportPreview] = useState<TeacherImportPreview | null>(null);
  const [teacherImportSourceBusy, setTeacherImportSourceBusy] = useState<TeacherImportSourceKind | null>(null);
  const [teacherImportSourceStatus, setTeacherImportSourceStatus] = useState<Partial<Record<TeacherImportSourceKind, TeacherImportSourceIngestResult>>>({});
  const [teacherImportSourceJson, setTeacherImportSourceJson] = useState<Record<TeacherImportSourceKind, string>>({
    k12: "",
    university: "",
  });
  const [teacherIdentityResolutionBusy, setTeacherIdentityResolutionBusy] = useState<`${string}:${"merge" | "separate" | "assign" | "ignore"}` | null>(null);
  const [rulesDraft, setRulesDraft] = useState<Rules>(defaults.defaultRules);
  const [rulesDraftTouched, setRulesDraftTouched] = useState(false);
  const [rulesDraftBaseVersion, setRulesDraftBaseVersion] = useState(versionFor("rules"));
  const [selectedStudentId, setSelectedStudentId] = useWorkspaceLocation("student", defaults.defaultSelectedStudentId);
  const [selectedTeacherId, setSelectedTeacherId] = useWorkspaceLocation("teacher", defaults.defaultSelectedTeacherId);
  const [selectedMessageId, setSelectedMessageId] = useState("MSG-001");
  const [taskFilter, setTaskFilter] = useState<ToDoFilter>("all");
  const [skipLinkFocused, setSkipLinkFocused] = useState(false);
  const [taskRefreshKey, setTaskRefreshKey] = useState(0);
  const [legacyTaskDeadlineDraft, setLegacyTaskDeadlineDraft] = useState<Task | null>(null);
  const [legacyTaskDeadlineBusy, setLegacyTaskDeadlineBusy] = useState(false);
  const legacyTaskDeadlineCommandKeysRef = useRef(new Map<string, string>());
  const directEnrollmentStorage = browserSessionStorage();
  const directEnrollmentCommandKeysRef = useRef<Map<string, DirectEnrollmentPendingCommand>>(
    readDirectEnrollmentPendingCommands(directEnrollmentStorage, sessionOperator),
  );
  const directEnrollmentBusyRef = useRef(false);
  const lpAtomicCommandKeysRef = useRef<Map<string, LpAtomicPendingEntry>>(
    readLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator),
  );
  const lpAtomicBusyRef = useRef(false);
  const bookingProjectionCommandKeysRef = useRef<Map<string, BookingProjectionPendingCommand>>(
    readBookingProjectionPendingCommands(directEnrollmentStorage, sessionOperator),
  );
  const bookingProjectionBusyRef = useRef(false);
  const studentCreationCommandKeysRef = useRef<Map<string, StudentCreationPendingCommand>>(
    readStudentCreationPendingCommands(directEnrollmentStorage, sessionOperator),
  );
  const studentCreationBusyRef = useRef(false);
  const studentCreationRecoveryActorRef = useRef("");
  const legacyOperationTaskCommandKeysRef = useRef<Map<string, LegacyOperationTaskPendingCommand>>(
    readLegacyOperationTaskPendingCommands(directEnrollmentStorage, sessionOperator),
  );
  const legacyOperationTaskBusyRef = useRef(false);
  const legacyOperationTaskRecoveryActorRef = useRef("");
  const trialPaymentCommandKeysRef = useRef<Map<string, TrialPaymentPendingCommand>>(
    readTrialPaymentPendingCommands(directEnrollmentStorage, sessionOperator),
  );
  const trialPaymentBusyRef = useRef(new Set<string>());
  const trialPaymentRecoveryActorRef = useRef("");
  const teacherAbsenceCommandKeysRef = useRef<Map<string, TeacherAbsencePendingCommand>>(
    readTeacherAbsencePendingCommands(directEnrollmentStorage, sessionOperator),
  );
  useEffect(() => {
    // Never retain another operator's in-memory retry envelope when the signed
    // session changes without a full component remount.
    teacherAbsenceCommandKeysRef.current = readTeacherAbsencePendingCommands(
      browserSessionStorage(),
      sessionOperator,
    );
  }, [sessionOperator]);
  useEffect(() => {
    lpAtomicCommandKeysRef.current = readLpAtomicPendingCommands(browserSessionStorage(), sessionOperator);
  }, [sessionOperator]);
  useEffect(() => {
    bookingProjectionCommandKeysRef.current = readBookingProjectionPendingCommands(
      browserSessionStorage(),
      sessionOperator,
    );
  }, [sessionOperator]);
  useEffect(() => {
    studentCreationCommandKeysRef.current = readStudentCreationPendingCommands(
      browserSessionStorage(),
      sessionOperator,
    );
    studentCreationRecoveryActorRef.current = "";
  }, [sessionOperator]);
  useEffect(() => {
    legacyOperationTaskCommandKeysRef.current = readLegacyOperationTaskPendingCommands(
      browserSessionStorage(),
      sessionOperator,
    );
    legacyOperationTaskRecoveryActorRef.current = "";
  }, [sessionOperator]);
  useEffect(() => {
    trialPaymentCommandKeysRef.current = readTrialPaymentPendingCommands(
      browserSessionStorage(),
      sessionOperator,
    );
    trialPaymentRecoveryActorRef.current = "";
  }, [sessionOperator]);
  const [search, setSearch] = useState("");
  const [studentView, setStudentView] = useState("all");
  const [studentOwner, setStudentOwner] = useState("all");
  const [studentPage, setStudentPage] = useState(1);
  const [studentNameSort, setStudentNameSort] = useState<StudentNameSortDirection>("asc");
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [teacherQuery, setTeacherQuery] = useState("");
  const [teacherView, setTeacherView] = useState("all");
  const [teacherMatching, setTeacherMatching] = useState(false);
  const [teacherSubject, setTeacherSubject] = useState("all");
  const [teacherDay, setTeacherDay] = useState("all");
  const [teacherPage, setTeacherPage] = useState(1);
  const [teacherAvailabilitySubmissions, setTeacherAvailabilitySubmissions] = useState<TeacherAvailabilitySubmissionReview[]>([]);
  const [teacherAvailabilityReviewVersion, setTeacherAvailabilityReviewVersion] = useState(teachersShared.version);
  const [teacherAvailabilityReviewBusy, setTeacherAvailabilityReviewBusy] = useState<string | null>(null);
  const [teacherAvailabilityInboxBusy, setTeacherAvailabilityInboxBusy] = useState(false);
  const [teacherAvailabilityReviewError, setTeacherAvailabilityReviewError] = useState("");
  const [teacherAvailabilitySubmitBusy, setTeacherAvailabilitySubmitBusy] = useState(false);
  const teacherAvailabilitySubmissionKey = useRef<string | null>(null);
  const [scheduleMode, setScheduleMode] = useState<"month" | "week" | "agenda">("month");
  const [scheduleMonth, setScheduleMonth] = useState(() => isoDateInTimezone(new Date(), displayPreferences.timezone).slice(0, 7));
  const [scheduleFilter, setScheduleFilter] = useState("all");
  const [scheduleDay, setScheduleDay] = useState("all");
  const [scheduleTeacherFilter, setScheduleTeacherFilter] = useState("all");
  const [schedulePage, setSchedulePage] = useState(1);
  const [jiaowubaoImportedSchedule, setJiaowubaoImportedSchedule] = useState<JiaowubaoImportedScheduleFeed | null>(null);
  const [jiaowubaoImportedScheduleLoading, setJiaowubaoImportedScheduleLoading] = useState(false);
  const [jiaowubaoImportedScheduleError, setJiaowubaoImportedScheduleError] = useState(false);
  const [jiaowubaoImportedScheduleErrorCode, setJiaowubaoImportedScheduleErrorCode] = useState<JiaowubaoImportedScheduleReadError | null>(null);
  const [jiaowubaoImportedScheduleLoadedKey, setJiaowubaoImportedScheduleLoadedKey] = useState<string | null>(null);
  const [trialScheduleSyncing, setTrialScheduleSyncing] = useState(false);
  const trialScheduleSyncRunRef = useRef(false);
  const trialSchedulePendingRecoveryAttemptedRef = useRef(new Set<string>());
  const [teacherAvailabilityCompletion, setTeacherAvailabilityCompletion] = useState<TeacherAvailabilityCompletionInbox | null>(null);
  const [teacherAvailabilityCompletionLoading, setTeacherAvailabilityCompletionLoading] = useState(false);
  const [teacherAvailabilityCompletionError, setTeacherAvailabilityCompletionError] = useState(false);
  const [jiaowubaoScheduleMappingReview, setJiaowubaoScheduleMappingReview] = useState<JiaowubaoScheduleMappingReview | null>(null);
  const [jiaowubaoScheduleMappingLoading, setJiaowubaoScheduleMappingLoading] = useState(false);
  const [jiaowubaoScheduleMappingLoadingMore, setJiaowubaoScheduleMappingLoadingMore] = useState(false);
  const [jiaowubaoScheduleMappingError, setJiaowubaoScheduleMappingError] = useState(false);
  const [jiaowubaoScheduleMappingBusyKey, setJiaowubaoScheduleMappingBusyKey] = useState<string | null>(null);
  const jiaowubaoScheduleMappingCommandKeysRef = useRef(new Map<string, string>());
  const [jiaowubaoScheduleMappingPriorityReview, setJiaowubaoScheduleMappingPriorityReview] = useState<JiaowubaoScheduleMappingPriorityReview | null>(null);
  const [jiaowubaoScheduleMappingPriorityLoading, setJiaowubaoScheduleMappingPriorityLoading] = useState(false);
  const [jiaowubaoScheduleMappingPriorityLoadingMore, setJiaowubaoScheduleMappingPriorityLoadingMore] = useState(false);
  const [jiaowubaoScheduleMappingPriorityError, setJiaowubaoScheduleMappingPriorityError] = useState(false);
  const [jiaowubaoScheduleMappingPriorityBusyKey, setJiaowubaoScheduleMappingPriorityBusyKey] = useState<string | null>(null);
  const jiaowubaoScheduleMappingPriorityCommandKeysRef = useRef(new Map<string, string>());
  const [selectedBookingId, setSelectedBookingId] = useState("LES-001");
  const [selectedBookingDate, setSelectedBookingDate] = useState<string | null>(null);
  const [selectedBookingDateId, setSelectedBookingDateId] = useState<string | null>(null);
  // Stable occurrence identity is authoritative for classroom/schedule
  // selection.  Date/dateId remain as a compatibility bridge for old state.
  const [selectedBookingOccurrenceKey, setSelectedBookingOccurrenceKey] = useState<string | null>(null);
  const [selectedBookingSourceDate, setSelectedBookingSourceDate] = useState<string | null>(null);
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([]);
  const [bookingDraft, setBookingDraft] = useState<Booking | null>(null);
  const [bookingOccurrenceDraft, setBookingOccurrenceDraft] = useState<BookingOccurrence | null>(null);
  const [bookingFrequency, setBookingFrequency] = useState<BookingRecurrenceFrequency>("single");
  const [bookingPrefillTeacherId, setBookingPrefillTeacherId] = useState<string | null>(null);
  const [bookingFormStudentId, setBookingFormStudentId] = useState("");
  const [bookingFormKind, setBookingFormKind] = useState<Booking["kind"]>("常规课");
  const [bookingFormSubjectId, setBookingFormSubjectId] = useState("");
  const [operationDraft, setOperationDraft] = useState<Partial<Operation> | null>(null);
  const [classroomRuntime, setClassroomRuntime] = useState<ClassroomRuntime | null>(null);
  const [provisionedClassrooms, setProvisionedClassrooms] = useState<Record<string, string>>({});
  const [classroomBusy, setClassroomBusy] = useState(false);
  const [classroomView, setClassroomView] = useState<"upcoming" | "history">("upcoming");
  const [temporaryClassroomLink, setTemporaryClassroomLink] = useState<{ occurrenceId: string; url: string } | null>(null);
  const [temporaryTestClassroom, setTemporaryTestClassroom] = useState<{ meetingId: string; viewerUrl: string } | null>(null);
  // One actor-scoped envelope survives a timeout, reload and modal reopen.
  // Generated date/start values live in the envelope payload so a retry after
  // a minute boundary cannot silently become a second booking intent.
  const temporaryClassroomPendingRef = useRef<TemporaryClassroomPending[]>(readTemporaryClassroomPending(sessionOperator));
  // Keep these refs as a small compatibility bridge for existing classroom
  // contract tests and same-page diagnostics; storage is the authority.
  const temporaryClassroomRequestKeyRef = useRef<string | null>(null);
  const temporaryClassroomRequestIntentRef = useRef<string | null>(null);
  useEffect(() => {
    temporaryClassroomPendingRef.current = readTemporaryClassroomPending(sessionOperator);
    temporaryClassroomRequestKeyRef.current = temporaryClassroomPendingRef.current[0]?.requestKey ?? null;
    temporaryClassroomRequestIntentRef.current = temporaryClassroomPendingRef.current[0]?.intent ?? null;
  }, [sessionOperator]);
  const [temporaryClassroomStudentId, setTemporaryClassroomStudentId] = useState("");
  const [temporaryClassroomSubjectId, setTemporaryClassroomSubjectId] = useState("");
  const [temporaryClassroomRecordLesson, setTemporaryClassroomRecordLesson] = useState(false);
  const [temporaryClassroomTeacherId, setTemporaryClassroomTeacherId] = useState("");
  const [temporaryClassroomTeacherSubjectId, setTemporaryClassroomTeacherSubjectId] = useState("");
  const [lessonSettlementDraft, setLessonSettlementDraft] = useState<BookingOccurrence | null>(null);
  const [lessonSettlementBusy, setLessonSettlementBusy] = useState(false);
  const [lessonSettlementError, setLessonSettlementError] = useState("");
  const [courseQuery, setCourseQuery] = useState("");
  const [coursePage, setCoursePage] = useState(1);
  const [selectedCourseId, setSelectedCourseId] = useState(defaults.defaultCourses[0]?.id ?? "");
  const [lpMode, setLpMode] = useState<"board" | "table">("board");
  const [lpFilter, setLpFilter] = useState("active");
  const [trialLedgerDrafts, setTrialLedgerDrafts] = useState<Record<string, string>>({});
  const [trialLedgerSaving, setTrialLedgerSaving] = useState<Record<string, boolean>>({});
  const [trialLedgerView, setTrialLedgerView] = useState<TrialLedgerViewState>(defaultTrialLedgerViewState);
  const [trialLedgerViewReady, setTrialLedgerViewReady] = useState(false);
  const [trialLedgerViewOwner, setTrialLedgerViewOwner] = useState("");
  const [lpDraftType, setLpDraftType] = useState<LpWorkflowType>(LP_WORKFLOW_TYPES[0]);
  const [lpDraftStudentId, setLpDraftStudentId] = useState(defaults.defaultSelectedStudentId);
  const [lpRevisionDraft, setLpRevisionDraft] = useState<LpItem | null>(null);
  const [trialScreenshotItem, setTrialScreenshotItem] = useState<LpItem | null>(null);
  const [examDraft, setExamDraft] = useState<StudentExamRecord | null>(null);
  const [examFormResetToken, setExamFormResetToken] = useState(0);
  const [examSubmissionBusy, setExamSubmissionBusy] = useState(false);
  const [lessonPackageBusy, setLessonPackageBusy] = useState(false);
  const examSubmissionRef = useRef<PendingExamSubmission | null>(null);
  const examFollowUpCommandRef = useRef(new Map<string, PendingExamFollowUp>());
  const examCompletionCommandKeysRef = useRef(new Map<string, string>());
  const [examCompletionCommandKeys, setExamCompletionCommandKeys] = useState<Record<string, string>>({});
  const examFollowUpBusyRef = useRef(new Set<string>());
  const examFollowUpVersionsRef = useRef({
    students: studentsShared.version,
    tasks: tasksShared.version,
  });
  useEffect(() => {
    examFollowUpVersionsRef.current = {
      students: studentsShared.version,
      tasks: tasksShared.version,
    };
  }, [studentsShared.version, tasksShared.version]);
  const [operationFilter, setOperationFilter] = useState("open");
  const [selectedOperationId, setSelectedOperationId] = useState("OPS-001");
  const [departureCandidateRefresh, setDepartureCandidateRefresh] = useState<{ operationId: string; busy?: boolean; error?: string } | null>(null);
  const [teacherDepartureCreationBusy, setTeacherDepartureCreationBusy] = useState(false);
  // Departure keeps its existing same-page key. Teacher absence has a separate
  // actor-scoped, reload-safe command ledger in sessionStorage.
  const teacherDepartureCreationRef = useRef<{ intent: string; commandKey: string } | null>(null);
  const [teacherAbsencePreview, setTeacherAbsencePreview] = useState<{
    affectedGroups: Array<{ studentId: string; subjects: string[]; firstAffectedAt: string; candidateTeacherIds: string[] }>;
    affectedOccurrenceCount: number;
    generatedTaskCount: number;
  } | null>(null);
  const teacherAbsencePreviewRequestRef = useRef(0);
  const teacherAbsencePreviewAbortRef = useRef<AbortController | null>(null);
  const [renewalFilter, setRenewalFilter] = useState("attention");
  const [renewalOwnerFilter, setRenewalOwnerFilter] = useState("all");
  const [renewalPage, setRenewalPage] = useState(1);
  const melbourneExamMonth = isoDateInTimezone(new Date(), "Australia/Melbourne").slice(0, 7);
  const [examMonthSelection, setExamMonthSelection] = useState(melbourneExamMonth);
  const [examFilter, setExamFilter] = useState("all");
  const [renewalDraft, setRenewalDraft] = useState<RenewalDraft | null>(null);
  const [studentRecordKind, setStudentRecordKind] = useState<StudentRecordPanelSection>("lp");
  const [teacherCapacityDraft, setTeacherCapacityDraft] = useState<Teacher | null>(null);
  const [renewalUploadBusy, setRenewalUploadBusy] = useState(false);
  const [evidenceUploadBusy, setEvidenceUploadBusy] = useState(false);
  const [reportUploadBusy, setReportUploadBusy] = useState(false);
  const [fileLinkBusy, setFileLinkBusy] = useState(false);
  const [fileStorageMode, setFileStorageMode] = useState<"link" | "upload">("link");
  const [fileUploadType, setFileUploadType] = useState<"Report 资料" | "FU" | "续课 FU">("Report 资料");
  const attachmentCommandKeysRef = useRef(new Map<string, { intent: string; commandKey: string }>());
  const commandKeyForAttachment = useCallback((flow: "evidence" | "report" | "renewal", studentId: string, file: File, metadata: readonly string[]) => {
    const scope = `${flow}:${studentId}`;
    const intent = JSON.stringify([file.name, file.size, file.lastModified, file.type, ...metadata]);
    const existing = attachmentCommandKeysRef.current.get(scope);
    if (existing?.intent === intent) return existing.commandKey;
    const commandKey = `${flow === "renewal" ? "renewal-follow-up" : "fu-attachment"}:${crypto.randomUUID()}`;
    attachmentCommandKeysRef.current.set(scope, { intent, commandKey });
    return commandKey;
  }, []);
  const clearAttachmentCommandKey = useCallback((flow: "evidence" | "report" | "renewal", studentId: string) => {
    attachmentCommandKeysRef.current.delete(`${flow}:${studentId}`);
  }, []);
  const renewalFollowUpCommandKeysRef = useRef(new Map<string, { intent: string; commandKey: string }>());
  const commandKeyForRenewalFollowUp = useCallback((studentId: string, renewalId: string, metadata: readonly string[]) => {
    const scope = `${studentId}:${renewalId}`;
    const intent = JSON.stringify(metadata);
    const existing = renewalFollowUpCommandKeysRef.current.get(scope);
    if (existing?.intent === intent) return existing.commandKey;
    const commandKey = `renewal-follow-up:${crypto.randomUUID()}`;
    renewalFollowUpCommandKeysRef.current.set(scope, { intent, commandKey });
    return commandKey;
  }, []);
  const clearRenewalFollowUpCommandKey = useCallback((studentId: string, renewalId: string) => {
    renewalFollowUpCommandKeysRef.current.delete(`${studentId}:${renewalId}`);
  }, []);
  const fileLinkCommandKeysRef = useRef(new Map<string, { intent: string; commandKey: string }>());
  const commandKeyForFileLink = useCallback((studentId: string, metadata: readonly string[]) => {
    const intent = JSON.stringify([studentId, ...metadata]);
    const existing = fileLinkCommandKeysRef.current.get(studentId);
    if (existing?.intent === intent) return existing.commandKey;
    const commandKey = `file-link:${crypto.randomUUID()}`;
    fileLinkCommandKeysRef.current.set(studentId, { intent, commandKey });
    return commandKey;
  }, []);
  const clearFileLinkCommandKey = useCallback((studentId: string) => {
    fileLinkCommandKeysRef.current.delete(studentId);
  }, []);
  const [payrollFilter, setPayrollFilter] = useState("all");
  const [payrollCurrency, setPayrollCurrency] = useState("all");
  const [payrollMonthSelection, setPayrollMonthSelection] = useState("");
  const [payrollPage, setPayrollPage] = useState(1);
  const [selectedPayrollKey, setSelectedPayrollKey] = useState("");
  const [payrollDraft, setPayrollDraft] = useState<PayrollRow | null>(null);
  const [payrollDraftSourceIndex, setPayrollDraftSourceIndex] = useState<number | null>(null);
  const [jiaowubaoCompletedLessonFeed, setJiaowubaoCompletedLessonFeed] = useState<JiaowubaoCompletedLessonFeed | null>(null);
  const [jiaowubaoCompletedLessonLoading, setJiaowubaoCompletedLessonLoading] = useState(false);
  const [jiaowubaoCompletedLessonError, setJiaowubaoCompletedLessonError] = useState(false);
  const [jiaowubaoCompletedLessonSyncing, setJiaowubaoCompletedLessonSyncing] = useState(false);
  const [jiaowubaoCompletedLessonExporting, setJiaowubaoCompletedLessonExporting] = useState(false);
  const jiaowubaoCompletedLessonExportRunRef = useRef(false);
  const jiaowubaoCompletedLessonEvidenceByTeacherMonth = useMemo(() => {
    const evidence = new Map<string, Readonly<{
      summary: JiaowubaoCompletedLessonTeacherSummary;
      lines: readonly PayrollLine[];
    }>>();
    if (jiaowubaoCompletedLessonFeed?.state !== "complete") return evidence;
    for (const summary of jiaowubaoCompletedLessonFeed.teachers) {
      if (!summary.teacherId) continue;
      const details = jiaowubaoCompletedLessonEvidenceItemsForTeacher(jiaowubaoCompletedLessonFeed, summary);
      evidence.set(payrollTeacherMonthKey(summary.teacherId, jiaowubaoCompletedLessonFeed.month), Object.freeze({
        summary,
        lines: Object.freeze(jiaowubaoCompletedLessonEvidenceLines(details)),
      }));
    }
    return evidence;
  }, [jiaowubaoCompletedLessonFeed]);
  const automaticLedgerPayrollRows = useMemo(() => {
    const grouped = new Map<string, TeacherPayrollLedgerRow[]>();
    const timezone = cleanTimezone(displayPreferences.timezone);
    payrollLedger.forEach((entry) => {
      const occurredAt = new Date(entry.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) return;
      const month = isoDateInTimezone(occurredAt, timezone).slice(0, 7);
      const key = `${entry.teacherId}:${month}`;
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    });
    return Array.from(grouped.entries()).map(([key, entries]): PayrollRow => {
      const [teacherId, month] = key.split(":");
      const teacher = teachers.find((item) => item.id === teacherId);
      const hours = Number(entries.reduce(
        (total, entry) => total + (entry.kind === "reversal" ? -entry.payableHours : entry.payableHours),
        0,
      ).toFixed(6));
      return {
        id: `AUTO-LEDGER-${teacherId}-${month}`,
        teacherId,
        teacherName: teacher?.name ?? teacherId,
        month,
        section: "系统课次结算",
        currency: "AUD",
        lessons: hours,
        trialLessons: 0,
        teacherTotalHours: hours,
        teacherTotalAmount: 0,
        amount: 0,
        status: "需核对",
        note: "系统已按完成课次计入老师课时，费率与金额待核对",
        source: "lesson-occurrence-ledger",
        lineCount: entries.length,
        lines: entries.map((entry, index) => ({
          studentName: students.find((student) => student.id === entry.studentId)?.name ?? entry.studentId,
          hours: entry.kind === "reversal" ? -entry.payableHours : entry.payableHours,
          rate: 0,
          subtotal: 0,
          note: `${entry.subjectId} · ${entry.kind === "reversal" ? "结课撤销" : "完成课次"}`,
          sourceRow: index + 1,
        })),
      };
    }).filter((row) => !payroll.some((summary) => (
      payrollTeacherMonthKey(summary.teacherId, summary.month) === payrollTeacherMonthKey(row.teacherId, row.month)
    )));
  }, [displayPreferences.timezone, payroll, payrollLedger, students, teachers]);
  const automaticJiaowubaoPayrollRows = useMemo(() => {
    if (jiaowubaoCompletedLessonFeed?.state !== "complete") return [];
    const rows: PayrollRow[] = [];
    for (const summary of jiaowubaoCompletedLessonFeed.teachers) {
      const sourceHours = summary.sourceHours;
      const trialHours = summary.trialSourceHours;
      if (!jiaowubaoCompletedLessonCanGeneratePayroll(summary)
        || !summary.teacherId
        || sourceHours === null
        || trialHours === null
        || !teachers.some((teacher) => teacher.id === summary.teacherId)) continue;
      const details = jiaowubaoCompletedLessonEvidenceItemsForTeacher(jiaowubaoCompletedLessonFeed, summary);
      const teacher = teachers.find((item) => item.id === summary.teacherId);
      const lines = jiaowubaoCompletedLessonEvidenceLines(details);
      rows.push({
        id: `AUTO-JWB-${summary.teacherId}-${jiaowubaoCompletedLessonFeed.month}`,
        teacherId: summary.teacherId,
        teacherName: teacher?.name ?? summary.teacherName ?? summary.sourceTeacherName ?? summary.teacherId,
        month: jiaowubaoCompletedLessonFeed.month,
        section: "教务宝已消课",
        currency: "AUD",
        lessons: Number(Math.max(0, sourceHours - trialHours).toFixed(4)),
        trialLessons: trialHours,
        teacherTotalHours: sourceHours,
        teacherTotalAmount: 0,
        amount: 0,
        status: "需核对",
        note: "教务宝已消课双源快照（over=1）：老师课时来自已消课排课角色字段，学生明细仅作核对，不按小组人数重复计薪。",
        source: "jiaowubao-completed-lessons",
        sourceHours,
        sourceLessonCount: summary.sourceLessonCount,
        sourceNoShowHours: null,
        hourVariance: 0,
        sourceRevision: jiaowubaoCompletedLessonFeed.revision ?? undefined,
        sourceProjectionRevision: jiaowubaoCompletedLessonFeed.projectionRevision ?? undefined,
        lineCount: lines.length,
        rateRange: [],
        lines,
      });
    }
    return rows;
  }, [jiaowubaoCompletedLessonFeed, teachers]);
  const unmatchedJiaowubaoPayrollExportRows = useMemo<PayrollExportRow[]>(() => {
    if (jiaowubaoCompletedLessonFeed?.state !== "complete") return [];
    const persistedKeys = new Set(payroll.map((row) => payrollTeacherMonthKey(row.teacherId, row.month)));
    return jiaowubaoCompletedLessonFeed.teachers
      .filter((summary) => {
        const automatic = jiaowubaoCompletedLessonCanGeneratePayroll(summary)
          && Boolean(summary.teacherId && teachers.some((teacher) => teacher.id === summary.teacherId));
        const persisted = summary.teacherId
          ? persistedKeys.has(payrollTeacherMonthKey(summary.teacherId, jiaowubaoCompletedLessonFeed.month))
          : false;
        return !automatic && !persisted;
      })
      .map((summary: JiaowubaoCompletedLessonTeacherSummary): PayrollExportRow | null => {
        const details = jiaowubaoCompletedLessonEvidenceItemsForTeacher(jiaowubaoCompletedLessonFeed, summary);
        const label = summary.sourceTeacherName ?? summary.sourceTeacherId ?? "未匹配老师";
        const reviewLabel = jiaowubaoCompletedLessonSourceReviewLabel(summary);
        return {
          teacherKey: summary.identityKey,
          teacherId: summary.teacherId,
          sourceTeacherId: summary.sourceTeacherId,
          teacherName: label,
          month: jiaowubaoCompletedLessonFeed.month,
          section: `教务宝来源 · ${reviewLabel}`,
          currency: "AUD",
          status: "需核对",
          // Source-only rows are never a payment instruction. Preserve the
          // documented schedule total separately and leave payroll at zero.
          payrollHours: 0,
          sourceHours: summary.sourceHours,
          sourceLessonCount: summary.sourceLessonCount,
          amount: 0,
          paymentMode: "review_only",
          paymentNote: `仅保留教务宝 over=1 双源资料：${reviewLabel}，不会写入薪资或付款资料。`,
          lines: jiaowubaoCompletedLessonEvidenceLines(details),
        };
      })
      .filter((row): row is PayrollExportRow => row !== null);
  }, [jiaowubaoCompletedLessonFeed, payroll, teachers]);
  const automaticPayrollRows = useMemo(() => {
    const existingPairs = new Set(payroll.map((row) => payrollTeacherMonthKey(row.teacherId, row.month)));
    const jiaowubaoPairs = new Set(automaticJiaowubaoPayrollRows.map((row) => payrollTeacherMonthKey(row.teacherId, row.month)));
    return [
      ...automaticJiaowubaoPayrollRows.filter((row) => !existingPairs.has(payrollTeacherMonthKey(row.teacherId, row.month))),
      ...automaticLedgerPayrollRows.filter((row) => {
        const key = payrollTeacherMonthKey(row.teacherId, row.month);
        return !existingPairs.has(key) && !jiaowubaoPairs.has(key);
      }),
    ];
  }, [automaticJiaowubaoPayrollRows, automaticLedgerPayrollRows, payroll]);
  const payrollDisplayRows = useMemo(() => {
    const persistedOrdinals = new Map<string, number>();
    const persisted = payroll.map((row, sourceIndex): PayrollDisplayRow => {
      const ordinal = persistedOrdinals.get(row.id) ?? 0;
      persistedOrdinals.set(row.id, ordinal + 1);
      const currentFeedForRow = jiaowubaoCompletedLessonFeed?.state === "complete"
        && jiaowubaoCompletedLessonFeed.month === row.month
        ? jiaowubaoCompletedLessonFeed
        : null;
      const source = jiaowubaoCompletedLessonEvidenceByTeacherMonth.get(payrollTeacherMonthKey(row.teacherId, row.month));
      const sourceEvidence = source ? {
          sourceHours: source.summary.sourceHours,
          sourceLessonCount: source.summary.sourceLessonCount,
          sourceNoShowHours: null,
          lines: source.lines,
        } : currentFeedForRow ? {
          sourceHours: null,
          sourceLessonCount: null,
          sourceNoShowHours: null,
          lines: [] as PayrollLine[],
        } : null;
      const refreshed = source && sourceEvidence
        ? overlayPersistedPayrollWithJiaowubaoEvidence(row, sourceEvidence)
        : null;
      const sourceReviewReason = currentFeedForRow && sourceEvidence
        ? !source
          ? "当前月份没有教务宝来源资料"
          : !jiaowubaoPayrollSourceVersionIsCurrent({
            persistedSourceRevision: row.sourceRevision,
            persistedProjectionRevision: row.sourceProjectionRevision,
            currentSourceRevision: currentFeedForRow.revision,
            currentProjectionRevision: currentFeedForRow.projectionRevision,
          })
            ? JIAOWUBAO_PAYROLL_SOURCE_VERSION_REVIEW_REASON
            : !jiaowubaoCompletedLessonCanGeneratePayroll(source.summary)
              ? jiaowubaoCompletedLessonSourceReviewLabel(source.summary)
              : refreshed && refreshed.hourVariance !== null && Math.abs(refreshed.hourVariance) > 0.01
                ? "薪资表课时与教务宝课时不一致"
                : null
        : null;
      const displayRow = sourceEvidence && sourceReviewReason
        ? reviewOnlyPersistedPayrollWithJiaowubaoEvidence(row, sourceEvidence, {
          reviewReason: sourceReviewReason,
        })
        : refreshed ?? row;
      return {
        ...displayRow,
        viewKey: payrollDisplayKey("persisted", row.id, ordinal),
        sourceIndex,
      };
    });
    const automaticOrdinals = new Map<string, number>();
    const automatic = automaticPayrollRows.map((row): PayrollDisplayRow => {
      const ordinal = automaticOrdinals.get(row.id) ?? 0;
      automaticOrdinals.set(row.id, ordinal + 1);
      return {
        ...row,
        viewKey: payrollDisplayKey("automatic", row.id, ordinal),
        sourceIndex: null,
      };
    });
    return [...persisted, ...automatic];
  }, [automaticPayrollRows, jiaowubaoCompletedLessonEvidenceByTeacherMonth, jiaowubaoCompletedLessonFeed, payroll]);
  const activePayrollMonth = payrollMonthSelection || previousMelbournePayrollMonth(new Date());
  const monthPayroll = useMemo(
    () => payrollDisplayRows.filter((row) => row.month === activePayrollMonth),
    [activePayrollMonth, payrollDisplayRows],
  );
  const sourceOnlyPayrollTeachers = useMemo(() => {
    if (jiaowubaoCompletedLessonFeed?.state !== "complete" || jiaowubaoCompletedLessonFeed.month !== activePayrollMonth) return [];
    return jiaowubaoCompletedLessonFeed.teachers.filter((summary) => (
      !jiaowubaoCompletedLessonCanGeneratePayroll(summary)
      || !summary.teacherId
      || !teachers.some((teacher) => teacher.id === summary.teacherId)
    ));
  }, [activePayrollMonth, jiaowubaoCompletedLessonFeed, teachers]);
  const [messageFilter, setMessageFilter] = useState("open");
  const [messageQuery, setMessageQuery] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [fileQuery, setFileQuery] = useState("");
  const [reportOwner, setReportOwner] = useState("all");
  const [settingsTab, setSettingsTab] = useState("reminders");
  const [auditQuery, setAuditQuery] = useState("");
  const [auditFilter, setAuditFilter] = useState("all");
  const [auditPage, setAuditPage] = useState(1);
  const [accountPasswordResetTarget, setAccountPasswordResetTarget] = useState<AccountPasswordResetTarget | null>(null);
  const [accountPasswordResetBusy, setAccountPasswordResetBusy] = useState(false);
  const [accountPasswordResetError, setAccountPasswordResetError] = useState("");
  const [accountLifecycleRefreshVersion, setAccountLifecycleRefreshVersion] = useState(0);
  const accountPasswordResetCommandRef = useRef<{ intent: string; commandKey: string } | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [modal, setModal] = useState<ModalKind>(null);
  const overlayFocusOriginRef = useRef<{ element: HTMLElement; signature: string } | null>(null);
  // Student-specific dialogs carry the exact record selected at open time.
  // Never derive their target from the general selected-student fallback,
  // which is allowed to choose a display row when the current selection is
  // empty.
  const [studentModalTargetId, setStudentModalTargetId] = useState("");
  const [studentModalTargetWasArchived, setStudentModalTargetWasArchived] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [mobilePreview, setMobilePreview] = useState<MobilePreview>(null);
  const courseDetailOpener = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const interfaceRootRef = useRef<HTMLDivElement>(null);
  const operatorMenuRef = useRef<HTMLDivElement>(null);
  const operatorLabel = (operator: string) => operator === "Nixon" ? "Admin" : operator;

  useEffect(() => {
    const focusableOriginSelector = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";
    const rememberPageOrigin = (event: FocusEvent | MouseEvent) => {
      const target = event.target;
      const element = target instanceof Element
        ? target.closest<HTMLElement>(focusableOriginSelector)
        : null;
      if (!element || element === document.body || element.closest("[aria-modal='true']")) return;
      overlayFocusOriginRef.current = {
        element,
        signature: globalSearchOriginSignature(element),
      };
    };
    document.addEventListener("focusin", rememberPageOrigin, true);
    // Pointer activation does not consistently focus a button before React's
    // onClick opens a dialog. Capture the semantic launcher while it is still
    // connected so Escape and close can restore focus to that exact control.
    document.addEventListener("click", rememberPageOrigin, true);
    return () => {
      document.removeEventListener("focusin", rememberPageOrigin, true);
      document.removeEventListener("click", rememberPageOrigin, true);
    };
  }, []);

  const openGlobalSearch = useCallback((origin?: HTMLElement | null) => {
    document.querySelectorAll<HTMLElement>("[data-global-search-origin='true']")
      .forEach(clearGlobalSearchOriginMarker);
    const activeOrigin = origin
      ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : Array.from(document.querySelectorAll<HTMLElement>("[data-global-search-trigger]"))
          .find((element) => element.getClientRects().length > 0))
      ?? null;
    if (activeOrigin) {
      activeOrigin.setAttribute("data-global-search-origin", "true");
      activeOrigin.setAttribute("data-global-search-origin-signature", globalSearchOriginSignature(activeOrigin));
    }
    setGlobalSearchOpen(true);
  }, []);

  const closeGlobalSearch = useCallback((transition?: () => void) => {
    const restoreFocus = () => {
      const markedOrigin = document.querySelector<HTMLElement>("[data-global-search-origin='true']");
      if (markedOrigin?.isConnected && isCurrentGlobalSearchOrigin(markedOrigin) && markedOrigin.getClientRects().length > 0) {
        markedOrigin.focus({ preventScroll: true });
        clearGlobalSearchOriginMarker(markedOrigin);
        return;
      }
      const visibleTrigger = Array.from(document.querySelectorAll<HTMLElement>("[data-global-search-trigger]"))
        .find((element) => element.isConnected && !element.closest(".global-search-dialog") && element.getClientRects().length > 0);
      if (visibleTrigger) {
        visibleTrigger.focus({ preventScroll: true });
        clearGlobalSearchOriginMarker(markedOrigin);
        return;
      }
      const heading = document.querySelector<HTMLElement>("#main-content h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      } else {
        document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true });
      }
      clearGlobalSearchOriginMarker(markedOrigin);
    };
    // Navigation must be queued inside the same synchronous commit as the
    // dialog close. Otherwise React may leave the old page mounted while the
    // focus target is selected, then unmount that target immediately after.
    flushSync(() => {
      transition?.();
      setGlobalSearchOpen(false);
    });
    restoreFocus();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reads one external, actor-scoped table preference after hydration.
    setTrialLedgerViewReady(false);
    try {
      setTrialLedgerView(parseTrialLedgerViewState(
        window.localStorage.getItem(trialLedgerViewStorageKey(sessionOperator)),
      ));
    } catch {
      setTrialLedgerView(defaultTrialLedgerViewState());
    } finally {
      setTrialLedgerViewOwner(sessionOperator);
      setTrialLedgerViewReady(true);
    }
  }, [sessionOperator]);

  useEffect(() => {
    let storedCollapsed = false;
    try {
      storedCollapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      // Browser storage can be unavailable in private mode; the full sidebar is the safe fallback.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reads one durable browser layout preference after hydration.
    setSidebarCollapsed(storedCollapsed);
    setSidebarCollapseReady(true);
  }, []);

  useEffect(() => {
    let timer = 0;
    const refresh = () => {
      setTaskRefreshKey(Date.now());
      timer = window.setTimeout(refresh, 60_000);
    };
    timer = window.setTimeout(refresh, 60_000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(displayPreferencesStorageKey(sessionOperator), JSON.stringify(displayPreferences));
    } catch {
      // Browser storage can be unavailable in private mode; displaying the selected values still works for this session.
    }
  }, [displayPreferences, sessionOperator]);

  useEffect(() => {
    if (!trialLedgerViewReady || trialLedgerViewOwner !== sessionOperator) return;
    try {
      window.localStorage.setItem(
        trialLedgerViewStorageKey(sessionOperator),
        JSON.stringify(trialLedgerView),
      );
    } catch {
      // Browser storage can be unavailable; the current account keeps its filters until reload.
    }
  }, [sessionOperator, trialLedgerView, trialLedgerViewOwner, trialLedgerViewReady]);

  useEffect(() => {
    if (!sidebarCollapseReady) return;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // Browser storage can be unavailable in private mode; the current layout still works for this session.
    }
  }, [sidebarCollapseReady, sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.lang = displayPreferences.language;
    document.title = displayPreferences.language === "en-AU"
      ? "Yinling Operations"
      : "吟领教务";
  }, [displayPreferences.language]);

  useEffect(() => {
    if (!interfaceRootRef.current) return;
    return observeInterfaceLocalization(interfaceRootRef.current, displayPreferences.language);
  }, [displayPreferences.language]);

  const updateDisplayPreferences = useCallback((patch: Partial<DisplayPreferences>) => {
    setDisplayPreferences((current) => ({ ...current, ...patch }));
  }, []);
  const scheduleTimezone = cleanTimezone(displayPreferences.timezone);
  const scheduleDensity = displayPreferences.density;
  const jiaowubaoScheduleWindow = useMemo(() => {
    if (scheduleMode === "month") {
      const monthWindow = scheduleMonthWindow(scheduleMonth);
      return {
        startsAt: zonedDateTimeToUtc(monthWindow.gridStart, "00:00", scheduleTimezone).toISOString(),
        endsAt: zonedDateTimeToUtc(shiftIsoDate(monthWindow.gridEnd, 1), "00:00", scheduleTimezone).toISOString(),
      };
    }
    const week = weekDatesForTimezone(scheduleTimezone);
    return {
      startsAt: zonedDateTimeToUtc(week[0]!.date, "00:00", scheduleTimezone).toISOString(),
      endsAt: zonedDateTimeToUtc(shiftIsoDate(week.at(-1)!.date, 1), "00:00", scheduleTimezone).toISOString(),
    };
  }, [scheduleMode, scheduleMonth, scheduleTimezone]);
  const trialScheduleWindow = useMemo(() => {
    const now = new Date();
    const melbourneDate = isoDateInTimezone(now, "Australia/Melbourne");
    return {
      startsAt: zonedDateTimeToUtc(melbourneDate, "00:00", "Australia/Melbourne").toISOString(),
      endsAt: zonedDateTimeToUtc(shiftIsoDate(melbourneDate, 31), "00:00", "Australia/Melbourne").toISOString(),
    };
  }, []);
  const activeJiaowubaoScheduleWindow = active === "lp" ? trialScheduleWindow : jiaowubaoScheduleWindow;
  const activeJiaowubaoTeacherFilter = active === "lp" ? "all" : scheduleTeacherFilter;
  const jiaowubaoScheduleRequestKey = `${active}|${activeJiaowubaoScheduleWindow.startsAt}|${activeJiaowubaoScheduleWindow.endsAt}|${activeJiaowubaoTeacherFilter}`;
  const currentJiaowubaoImportedSchedule = jiaowubaoImportedScheduleLoadedKey === jiaowubaoScheduleRequestKey
    ? jiaowubaoImportedSchedule
    : null;

  useEffect(() => {
    if (active !== "schedule" && active !== "lp") return;
    const controller = new AbortController();
    const loadAllJiaowubaoSchedulePages = async (): Promise<JiaowubaoImportedScheduleFeed> => {
      const pages: JiaowubaoImportedSchedulePage[] = [];
      const seenCursors = new Set<string>();
      let cursorToken: string | null = null;

      // Imports are capped at 200,000 events server-side and each page contains
      // at most 250 events, so 800 pages is the complete safe client ceiling.
      // If the feed cannot complete below that limit, fail closed rather than
      // subtracting a partial imported schedule from teacher AVA.
      for (let pageIndex = 0; pageIndex < 800; pageIndex += 1) {
        const query = new URLSearchParams({
          windowStart: activeJiaowubaoScheduleWindow.startsAt,
          windowEnd: activeJiaowubaoScheduleWindow.endsAt,
        });
        if (active === "lp") query.set("trialOnly", "1");
        if (activeJiaowubaoTeacherFilter !== "all") query.set("teacherId", activeJiaowubaoTeacherFilter);
        if (cursorToken) query.set("cursor", cursorToken);

        const response = await fetch(`/api/jiaowubao-open-api/schedule?${query.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new JiaowubaoImportedScheduleReadFailure(
            response.status === 401 ? "session" : response.status === 501 ? "reader_unavailable" : "unavailable",
          );
        }
        const page = parseSnapshotSchedulePage(body);
        if (page.state === "reset") throw new Error("教务宝同步课表分页已重置。");

        pages.push(page);
        if (!page.hasMore) return completeJiaowubaoImportedSchedulePages(pages);
        if ((page.state !== "complete" && page.state !== "stale") || !page.nextCursor) {
          throw new Error("教务宝同步课表分页没有有效续页游标。");
        }
        if (seenCursors.has(page.nextCursor.token)) throw new Error("教务宝同步课表分页游标重复。");
        seenCursors.add(page.nextCursor.token);
        cursorToken = page.nextCursor.token;
      }

      throw new Error("教务宝同步课表分页超过安全上限。");
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect -- The request lifecycle must immediately replace a stale calendar-window result with a loading state.
    setJiaowubaoImportedScheduleLoading(true);
    // The next external read owns the visible error state for this window.
    setJiaowubaoImportedScheduleError(false);
    setJiaowubaoImportedScheduleErrorCode(null);
    void loadAllJiaowubaoSchedulePages()
      .then((feed) => {
        if (!controller.signal.aborted) {
          setJiaowubaoImportedScheduleLoadedKey(jiaowubaoScheduleRequestKey);
          setJiaowubaoImportedSchedule(feed);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setJiaowubaoImportedScheduleLoadedKey(null);
          setJiaowubaoImportedSchedule(null);
          setJiaowubaoImportedScheduleError(true);
          setJiaowubaoImportedScheduleErrorCode(error instanceof JiaowubaoImportedScheduleReadFailure ? error.code : "unavailable");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setJiaowubaoImportedScheduleLoading(false);
      });

    return () => controller.abort();
  }, [active, activeJiaowubaoScheduleWindow, activeJiaowubaoTeacherFilter, jiaowubaoScheduleRequestKey]);

  const selectedTeacher = teachers.find((teacher) => teacher.id === selectedTeacherId) ?? teachers[0];
  const studentsById = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
  const teachersById = useMemo(() => new Map(teachers.map((teacher) => [teacher.id, teacher])), [teachers]);
  const studentById = (studentId: string) => studentsById.get(studentId);
  const teacherById = (teacherId: string) => teachersById.get(teacherId);
  const jiaowubaoCompletedLessonsByStudentId = useMemo(() => {
    const grouped = new Map<string, JiaowubaoCompletedLessonFeedItem[]>();
    if (jiaowubaoCompletedLessonFeed?.state !== "complete") return grouped;
    for (const item of jiaowubaoCompletedLessonFeed.items) {
      if (!item.studentId) continue;
      grouped.set(item.studentId, [...(grouped.get(item.studentId) ?? []), item]);
    }
    return grouped;
  }, [jiaowubaoCompletedLessonFeed]);
  const jiaowubaoCompletedLessonsByTeacherId = useMemo(() => {
    const grouped = new Map<string, JiaowubaoCompletedLessonFeed["teachers"][number]>();
    if (jiaowubaoCompletedLessonFeed?.state !== "complete") return grouped;
    for (const summary of jiaowubaoCompletedLessonFeed.teachers) {
      if (summary.teacherId) grouped.set(summary.teacherId, summary);
    }
    return grouped;
  }, [jiaowubaoCompletedLessonFeed]);
  const hasRealSnapshot = dataSnapshot.label === "真实资料本地快照" || dataSnapshot.label === "真实资料线上临时快照" || dataSnapshot.label === "Supabase 真实资料快照" || dataSnapshot.label === "Supabase 多人共享真实资料";
  const snapshotStudents = useMemo(
    () => hasRealSnapshot ? students.filter((student) => !sampleStudentIds.has(student.id)) : students,
    [hasRealSnapshot, students],
  );
  const recordStudents = useMemo(
    () => snapshotStudents.filter((student) => student.importArchived !== true),
    [snapshotStudents],
  );
  const archivedRecordStudents = useMemo(
    () => snapshotStudents.filter((student) => student.importArchived === true),
    [snapshotStudents],
  );
  const recordTeachers = useMemo(() => hasRealSnapshot ? teachers.filter((teacher) => !sampleTeacherIds.has(teacher.id)) : teachers, [hasRealSnapshot, teachers]);
  const teacherOperatorNames = useMemo(() => new Set(recordTeachers.map((teacher) => teacher.name)), [recordTeachers]);
  const isFullAdminSession = isAdminSession;
  const isLimitedAdminSession = initialRole === "limited-admin" && sessionOperator === DEMO_LIMITED_ADMIN_USER;
  const canUseAdminScope = isFullAdminSession || isLimitedAdminSession;
  const canViewPayroll = isFullAdminSession && currentOperator === "Nixon";
  const isAdminView = canUseAdminScope && (currentOperator === "Nixon" || currentOperator === DEMO_LIMITED_ADMIN_USER);
  // A roster teacher may share a name with a pinned staff account. The signed
  // role must win for a non-admin session; admins may still inspect a teacher
  // workspace through the account switcher.
  const isTeacherView = teacherOperatorNames.has(currentOperator) && (initialRole === "teacher" || canUseAdminScope);
  const canViewClassroom = isAdminView || isTeacherView;
  const canJoinTeacherClassroom = initialRole === "teacher" && isTeacherView;
  // Keep the priority queue tied to one exact UTC-day window while an admin
  // reviews it. This prevents pagination from silently mixing imports.
  const jiaowubaoScheduleMappingPriorityWindow = useMemo(
    () => buildJiaowubaoOperationsReadinessWindow(),
    [],
  );
  const jiaowubaoCompletedLessonReadMonth = canViewPayroll
    && (active === "payroll" || active === "students" || active === "teachers")
    ? activePayrollMonth
    : null;
  useEffect(() => {
    if (!jiaowubaoCompletedLessonReadMonth) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A selected month needs an explicit loading state so an old immutable month is never presented as current evidence.
    setJiaowubaoCompletedLessonLoading(true);
    setJiaowubaoCompletedLessonError(false);
    void loadAllJiaowubaoCompletedLessonPages({
      month: jiaowubaoCompletedLessonReadMonth,
      signal: controller.signal,
    })
      .then((feed) => {
        if (!controller.signal.aborted) setJiaowubaoCompletedLessonFeed(feed);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setJiaowubaoCompletedLessonFeed(null);
          setJiaowubaoCompletedLessonError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setJiaowubaoCompletedLessonLoading(false);
      });
    return () => controller.abort();
  }, [jiaowubaoCompletedLessonReadMonth]);

  useEffect(() => {
    if (!canPollAbsentPayrollMonth({
      canView: canViewPayroll, active, month: activePayrollMonth, currentMonth: melbourneExamMonth,
      feed: jiaowubaoCompletedLessonFeed, loading: jiaowubaoCompletedLessonLoading,
      syncing: jiaowubaoCompletedLessonSyncing, exporting: jiaowubaoCompletedLessonExporting,
    })) return;
    const poller = createSharedStatePoller({
      canRun: () => !document.hidden,
      successDelayMs: PAYROLL_ABSENT_POLL_DELAY_MS,
      errorDelayMs: PAYROLL_ABSENT_ERROR_DELAY_MS,
      onError: () => {
        wakeClock.markError();
        setJiaowubaoCompletedLessonError(true);
      },
      run: async (signal) => {
        wakeClock.markStarted();
        const feed = await loadAllJiaowubaoCompletedLessonPages({ month: activePayrollMonth, signal });
        if (signal.aborted) return;
        setJiaowubaoCompletedLessonError(false);
        setJiaowubaoCompletedLessonFeed(feed);
      },
    });
    const wakeClock = createPayrollAbsentMonthWake({
      wake: () => void poller.wake(),
      isHidden: () => document.hidden,
      now: () => Date.now(),
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (timer) => window.clearTimeout(timer),
    });
    const initialWake = window.setTimeout(() => void poller.wake(), PAYROLL_ABSENT_POLL_DELAY_MS);
    document.addEventListener("visibilitychange", wakeClock.resume);
    window.addEventListener("focus", wakeClock.resume);
    return () => {
      window.clearTimeout(initialWake);
      document.removeEventListener("visibilitychange", wakeClock.resume);
      window.removeEventListener("focus", wakeClock.resume);
      wakeClock.stop();
      poller.stop();
    };
  }, [active, activePayrollMonth, canViewPayroll, jiaowubaoCompletedLessonExporting, jiaowubaoCompletedLessonFeed, jiaowubaoCompletedLessonLoading, jiaowubaoCompletedLessonSyncing, melbourneExamMonth]);

  useEffect(() => {
    if (!canUseAdminScope || !isAdminView || active !== "dashboard") return;
    const controller = new AbortController();

    // eslint-disable-next-line react-hooks/set-state-in-effect -- A current administrator-only reader must replace stale completion evidence before it is rendered in the risk summary.
    setTeacherAvailabilityCompletionLoading(true);
    setTeacherAvailabilityCompletionError(false);
    void fetch("/api/teacher-availability/completion", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error("老师 AVA 完整度读取失败。");
        return parseTeacherAvailabilityCompletionInbox(body);
      })
      .then((inbox) => {
        if (!controller.signal.aborted) setTeacherAvailabilityCompletion(inbox);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTeacherAvailabilityCompletion(null);
          setTeacherAvailabilityCompletionError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setTeacherAvailabilityCompletionLoading(false);
      });
    return () => controller.abort();
  }, [active, canUseAdminScope, isAdminView]);

  useEffect(() => {
    if (!canUseAdminScope || !isAdminView || active !== "sync") return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fresh admin-only source reads replace stale mapping evidence before it is actionable.
    setJiaowubaoScheduleMappingPriorityLoading(true);
    setJiaowubaoScheduleMappingPriorityError(false);
    void readJiaowubaoScheduleMappingPriorityReview(
      jiaowubaoScheduleMappingPriorityWindow,
      null,
      controller.signal,
    )
      .then((review) => {
        if (!controller.signal.aborted) setJiaowubaoScheduleMappingPriorityReview(review);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setJiaowubaoScheduleMappingPriorityReview(null);
          setJiaowubaoScheduleMappingPriorityError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setJiaowubaoScheduleMappingPriorityLoading(false);
      });
    return () => controller.abort();
  }, [active, canUseAdminScope, isAdminView, jiaowubaoScheduleMappingPriorityWindow]);

  useEffect(() => {
    if (!canUseAdminScope || !isAdminView || active !== "sync") return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fresh admin-only source reads replace stale mapping evidence before it is actionable.
    setJiaowubaoScheduleMappingLoading(true);
    setJiaowubaoScheduleMappingError(false);
    void readJiaowubaoScheduleMappingReview(null, controller.signal)
      .then((review) => {
        if (!controller.signal.aborted) setJiaowubaoScheduleMappingReview(review);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setJiaowubaoScheduleMappingReview(null);
          setJiaowubaoScheduleMappingError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setJiaowubaoScheduleMappingLoading(false);
      });
    return () => controller.abort();
  }, [active, canUseAdminScope, isAdminView]);

  useEffect(() => {
    if (!canUseAdminScope) return;
    let cancelled = false;
    void fetch("/api/student-import/source-rows", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ready !== true || !body.sources) return;
        const nextStatus: Partial<Record<StudentImportSourceKind, StudentImportSourceIngestResult>> = {};
        const nextMeta: Partial<Record<StudentImportSourceKind, { sourceId: string; revision: string }>> = {};
        for (const sourceKind of ["master", "jwb"] as const) {
          const source = body.sources[sourceKind];
          if (!source || typeof source.sourceId !== "string" || typeof source.revision !== "string"
            || !Number.isSafeInteger(source.rowCount) || source.rowCount < 0) continue;
          nextStatus[sourceKind] = {
            sourceKind,
            sourceId: source.sourceId,
            revision: source.revision,
            rowCount: source.rowCount,
            unchanged: true,
          };
          nextMeta[sourceKind] = { sourceId: source.sourceId, revision: source.revision };
        }
        if (cancelled) return;
        setStudentImportSourceStatus(nextStatus);
        setStudentImportSourceMeta((current) => ({
          master: nextMeta.master ?? current.master,
          jwb: nextMeta.jwb ?? current.jwb,
        }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [canUseAdminScope]);

  const interfaceText = interfaceCopy[displayPreferences.language];
  const navigation = useMemo(() => navigationFor(displayPreferences.language), [displayPreferences.language]);
  const currentTeacher = useMemo(() => isTeacherView ? recordTeachers.find((teacher) => teacher.name.trim().toLocaleLowerCase() === currentOperator.trim().toLocaleLowerCase()) : undefined, [currentOperator, isTeacherView, recordTeachers]);
  const currentTeacherIds = useMemo(() => new Set(currentTeacher ? [currentTeacher.id] : []), [currentTeacher]);
  const teacherBookingStudentIds = useMemo(() => new Set(currentTeacher
    ? bookings.filter((booking) => bookingHasEffectiveTeacher(booking, currentTeacherIds)).map((booking) => booking.studentId)
    : []), [bookings, currentTeacher, currentTeacherIds]);
  const visibleNavigation = useMemo(() => isAdminView ? navigation.filter((item) => canViewPayroll || noPayrollAdminSectionIds.has(item.id)) : navigation.filter((item) => isTeacherView ? teacherSectionIds.has(item.id) : staffSectionIds.has(item.id)), [canViewPayroll, isAdminView, isTeacherView, navigation]);
  const visibleMobileNavigation = useMemo(() => visibleNavigation.filter((item) => isTeacherView ? ["dashboard", "students", "schedule", "classroom"].includes(item.id) : ["dashboard", "students", "schedule", "messages"].includes(item.id)), [isTeacherView, visibleNavigation]);
  const canOpenAvaCalendar = visibleNavigation.some((item) => item.id === "schedule");
  const avaCalendarLabel = displayPreferences.language === "en-AU" ? "AVA calendar" : "AVA日历";
  const scopedStudents = useMemo(() => {
    if (isAdminView) return recordStudents;
    if (isTeacherView) {
      const teacherName = currentOperator.trim().toLocaleLowerCase();
      return recordStudents.filter((student) => student.teacher.trim().toLocaleLowerCase() === teacherName || teacherBookingStudentIds.has(student.id));
    }
    return recordStudents.filter((student) => student.owner === currentOperator);
  }, [currentOperator, isAdminView, isTeacherView, recordStudents, teacherBookingStudentIds]);
  const scopedArchivedStudents = useMemo(() => {
    if (isAdminView) return archivedRecordStudents;
    if (isTeacherView) {
      const teacherName = currentOperator.trim().toLocaleLowerCase();
      return archivedRecordStudents.filter((student) => student.teacher.trim().toLocaleLowerCase() === teacherName || teacherBookingStudentIds.has(student.id));
    }
    return archivedRecordStudents.filter((student) => student.owner === currentOperator);
  }, [archivedRecordStudents, currentOperator, isAdminView, isTeacherView, teacherBookingStudentIds]);
  const readableScopedStudents = useMemo(
    () => [...scopedStudents, ...scopedArchivedStudents],
    [scopedArchivedStudents, scopedStudents],
  );
  // Every interactive student selector is restricted to the current signed
  // actor's active scope. Archived/history rows remain readable elsewhere but
  // can never become a new task, message, file, booking, or classroom target.
  const scopedActiveStudents = useMemo(
    () => scopedStudents.filter(isActiveStudent),
    [scopedStudents],
  );
  const scopedStudentIds = useMemo(() => new Set(scopedStudents.map((student) => student.id)), [scopedStudents]);
  const scopedActiveStudentIds = useMemo(() => new Set(scopedActiveStudents.map((student) => student.id)), [scopedActiveStudents]);
  const readableScopedStudentIds = useMemo(() => new Set(readableScopedStudents.map((student) => student.id)), [readableScopedStudents]);
  const managedExamStudents = useMemo(() => {
    if (isAdminView || initialRole !== "staff" || currentOperator !== sessionOperator) return [];
    return managedExamProjectionSnapshot.students
      .filter((student) => !scopedStudentIds.has(student.id))
      .map((student): Student => ({
        id: student.id,
        name: student.name,
        initials: student.initials,
        status: "在读",
        owner: student.owner,
        course: "待确认",
        timezone: "Australia/Melbourne",
        teacher: "待确认",
        next: "考试任务",
        nextTone: "amber",
        files: 0,
        exams: [...student.exams],
      }));
  }, [currentOperator, initialRole, isAdminView, managedExamProjectionSnapshot.students, scopedStudentIds, sessionOperator]);
  const managedExamStudentIds = useMemo(() => new Set(managedExamStudents.map((student) => student.id)), [managedExamStudents]);
  const managedExamTaskIdentities = useMemo(() => new Set(managedExamStudents.flatMap((student) =>
    (student.exams ?? []).map((exam) => `${student.id}\u0000${exam.id}`),
  )), [managedExamStudents]);
  const examStudents = useMemo(() => [...scopedStudents, ...managedExamStudents], [managedExamStudents, scopedStudents]);
  const managedTrialPaymentStudents = useMemo(() => {
    if (isAdminView || initialRole !== "staff" || currentOperator !== sessionOperator) return [];
    return managedTrialPaymentProjectionSnapshot.students
      .filter((student) => !scopedStudentIds.has(student.id));
  }, [currentOperator, initialRole, isAdminView, managedTrialPaymentProjectionSnapshot.students, scopedStudentIds, sessionOperator]);
  const managedTrialPaymentStudentIds = useMemo(
    () => new Set(managedTrialPaymentStudents.map((student) => student.id)),
    [managedTrialPaymentStudents],
  );
  const taskStudentNames = useMemo(() => new Map(
    [...examStudents, ...managedTrialPaymentStudents].map((student) => [student.id, student.name]),
  ), [examStudents, managedTrialPaymentStudents]);
  const scopedTasks = useMemo(() => isAdminView ? tasks : tasks.filter((task) => {
    const managedTrialPaymentTask = isManagedTrialPaymentTask(task);
    if (managedTrialPaymentTask) {
      return initialRole === "staff"
        && currentOperator === sessionOperator
        && isManagedTrialPaymentTaskRecipient(task, currentOperator)
        && (scopedStudentIds.has(task.studentId) || managedTrialPaymentStudentIds.has(task.studentId));
    }
    const addressedManagedExamTask = initialRole === "staff"
      && currentOperator === sessionOperator
      && isManagedExamTaskRecipient(task, currentOperator);
    const managedExamRule = task.ruleKey?.match(/^exam:([^:]+):(planning|care|recall|results)$/);
    const authorizedCrossOwnerTask = addressedManagedExamTask
      && Boolean(managedExamRule)
      && task.anchorBookingId === `exam:${managedExamRule?.[1]}`
      && managedExamTaskIdentities.has(`${task.studentId}\u0000${managedExamRule?.[1]}`);
    if (!scopedStudentIds.has(task.studentId) && !authorizedCrossOwnerTask) return false;
    return addressedManagedExamTask
      || new Set([task.owner, ...(task.assignees ?? []), ...(task.watchers ?? [])]).has(currentOperator);
  }), [currentOperator, initialRole, isAdminView, managedExamTaskIdentities, managedTrialPaymentStudentIds, scopedStudentIds, sessionOperator, tasks]);
  const scopedBookings = useMemo(() => isAdminView ? bookings : isTeacherView ? bookings.filter((booking) => bookingHasEffectiveTeacher(booking, currentTeacherIds)) : bookings.filter((booking) => scopedStudentIds.has(booking.studentId)), [bookings, currentTeacherIds, isAdminView, isTeacherView, scopedStudentIds]);
  const scopedLpItems = useMemo(() => isAdminView ? lpItems : lpItems.filter((item) => item.owner === currentOperator || scopedStudentIds.has(item.studentId)), [currentOperator, isAdminView, lpItems, scopedStudentIds]);
  const trialScheduleMatches = useMemo(() => matchTrialScheduleEvents({
    lpItems: scopedLpItems,
    students: recordStudents,
    teachers: recordTeachers,
    events: currentJiaowubaoImportedSchedule?.events ?? [],
    sourceRevision: currentJiaowubaoImportedSchedule?.revision,
    matchedAt: new Date(),
  }), [currentJiaowubaoImportedSchedule, recordStudents, recordTeachers, scopedLpItems]);
  const trialScheduleMatchByLpId = useMemo(
    () => new Map(trialScheduleMatches.map((match) => [match.lpItemId, match])),
    [trialScheduleMatches],
  );
  const trialTaskSchedule = useCallback((task: OpsTask) => resolveTaskTrialSchedule(task, {
    lpItems: scopedLpItems,
    bookings: scopedBookings,
    bookingStartsAt: (booking) => bookingInstant(booking).toISOString(),
  }), [scopedBookings, scopedLpItems]);
  const trialTaskTitle = useCallback((task: OpsTask) => {
    const schedule = task.requestAnchorBookingId
      ? lpItems.find((item) => item.id === task.requestAnchorBookingId)?.trialSchedule
      : undefined;
    return formatJiaowubaoTodayTaskTitle({
      task,
      endsAt: schedule?.endsAt,
      timeZone: taskDeadlineTimeZone,
      timeZoneLabel: taskDeadlineTimeZoneLabel,
      locale: localeFor(displayPreferences.language),
      timeFormat: displayPreferences.timeFormat,
    });
  }, [displayPreferences.language, displayPreferences.timeFormat, lpItems, taskDeadlineTimeZone, taskDeadlineTimeZoneLabel]);
  const scopedOperations = useMemo(() => isAdminView ? operations : operations.filter((operation) => scopedStudentIds.has(operation.studentId)), [isAdminView, operations, scopedStudentIds]);
  const scopedRenewals = useMemo(() => isAdminView ? renewals : renewals.filter((renewal) => renewal.owner === currentOperator || scopedStudentIds.has(renewal.studentId)), [currentOperator, isAdminView, renewals, scopedStudentIds]);
  const scopedMessages = useMemo(() => isAdminView ? messages : messages.filter((message) => scopedStudentIds.has(message.studentId)), [isAdminView, messages, scopedStudentIds]);
  const scopedFiles = useMemo(() => isAdminView ? files : files.filter((file) => scopedStudentIds.has(file.studentId)), [files, isAdminView, scopedStudentIds]);
  const readableScopedTasks = useMemo(() => isAdminView ? tasks : tasks.filter((task) => {
    if (!readableScopedStudentIds.has(task.studentId)) return false;
    return new Set([task.owner, ...(task.assignees ?? []), ...(task.watchers ?? [])]).has(currentOperator);
  }), [currentOperator, isAdminView, readableScopedStudentIds, tasks]);
  const readableScopedBookings = useMemo(() => isAdminView ? bookings : isTeacherView ? bookings.filter((booking) => bookingHasEffectiveTeacher(booking, currentTeacherIds)) : bookings.filter((booking) => readableScopedStudentIds.has(booking.studentId)), [bookings, currentTeacherIds, isAdminView, isTeacherView, readableScopedStudentIds]);
  const coursePackageCatalogScope = useMemo(() => {
    const activeStudents = scopedStudents.filter(isActiveCoursePackageCatalogStudent);
    const activeStudentIds = new Set(activeStudents.map((student) => student.id));
    const activeBookings = readableScopedBookings.filter((booking) => activeStudentIds.has(booking.studentId));
    const catalog = buildCoursePackageCatalog({
      courses,
      students: activeStudents,
      bookings: activeBookings,
      ...(isAdminView ? { teachers: recordTeachers, includeTeacherEligibility: true } : {}),
    });
    return { activeStudentIds, catalog };
  }, [courses, isAdminView, readableScopedBookings, recordTeachers, scopedStudents]);
  const readableScopedLpItems = useMemo(() => isAdminView ? lpItems : lpItems.filter((item) => item.owner === currentOperator || readableScopedStudentIds.has(item.studentId)), [currentOperator, isAdminView, lpItems, readableScopedStudentIds]);
  const readableScopedOperations = useMemo(() => isAdminView ? operations : operations.filter((operation) => readableScopedStudentIds.has(operation.studentId)), [isAdminView, operations, readableScopedStudentIds]);
  const readableScopedRenewals = useMemo(() => isAdminView ? renewals : renewals.filter((renewal) => renewal.owner === currentOperator || readableScopedStudentIds.has(renewal.studentId)), [currentOperator, isAdminView, readableScopedStudentIds, renewals]);
  const readableScopedMessages = useMemo(() => isAdminView ? messages : messages.filter((message) => readableScopedStudentIds.has(message.studentId)), [isAdminView, messages, readableScopedStudentIds]);
  const readableScopedFiles = useMemo(() => isAdminView ? files : files.filter((file) => readableScopedStudentIds.has(file.studentId)), [files, isAdminView, readableScopedStudentIds]);
  const selectBookingRecord = (record: Booking | BookingOccurrence, preview?: MobilePreview) => {
    if (!scopedActiveStudentIds.has(record.studentId)) {
      notify("当前身份只能打开当前范围的活跃学生课程。");
      return false;
    }
    const occurrence = "occurrenceKey" in record
      ? record
      : (() => {
          const series = bookings.find((booking) => booking.id === record.id) ?? record;
          return bookingOccurrenceByStableKey(series, `${record.id}:${record.date}`)
            ?? uniqueBookingOccurrenceForTargetDate(series, record.date);
        })();
    if (!occurrence) {
      // An old date-only selection is safe only when it identifies one
      // occurrence.  Keep the legacy fields for display, but fail closed for
      // classroom actions when a moved-date collision is ambiguous.
      setSelectedBookingId(record.id);
      setSelectedBookingDate(record.date);
      setSelectedBookingDateId(record.id);
      setSelectedBookingOccurrenceKey(null);
      setSelectedBookingSourceDate(null);
      if (preview) setMobilePreview(preview);
      return false;
    }
    setSelectedBookingId(occurrence.id);
    setSelectedBookingDate(occurrence.date);
    setSelectedBookingDateId(occurrence.id);
    setSelectedBookingOccurrenceKey(occurrence.occurrenceKey);
    setSelectedBookingSourceDate(occurrence.sourceDate);
    setSelectedStudentId(occurrence.studentId);
    setSelectedTeacherId(occurrence.teacherId);
    if (preview) setMobilePreview(preview);
    return true;
  };
  const selectedStudentPool = active === "students" && studentView === "archived" ? scopedArchivedStudents : scopedStudents;
  const selectedScopedActiveStudent = scopedStudents.find((student) => student.id === selectedStudentId) ?? scopedStudents[0];
  const effectiveSelectedStudentId = readableScopedStudentIds.has(selectedStudentId)
    ? selectedStudentId
    : scopedActiveStudents[0]?.id ?? "";
  // A staff view with no owned students has no selected student. Keep an
  // explicit non-record sentinel for display-only code; never fall back to a
  // global record row from another operator's scope.
  const selectedStudent = selectedStudentPool.find((student) => student.id === effectiveSelectedStudentId)
    ?? scopedActiveStudents.find((student) => student.id === effectiveSelectedStudentId)
    ?? {
    id: "STU-NONE",
    name: "暂无关联学生",
    initials: "--",
    status: "活跃 + 无课时",
    owner: currentOperator,
    course: "待分配",
    timezone: "Australia/Melbourne",
    teacher: currentOperator,
    next: "等待管理员关联学生",
    nextTone: "neutral",
    files: 0,
  } satisfies Student;
  const studentModalTargetStudent = studentModalTargetId
    ? readableScopedStudents.find((student) => student.id === studentModalTargetId)
    : undefined;
  const studentModalTargetIsValid = Boolean(studentModalTargetStudent)
    && Boolean(studentModalTargetStudent?.importArchived) === studentModalTargetWasArchived
    && (modal === "studentRecords"
      || Boolean(studentModalTargetStudent && scopedActiveStudentIds.has(studentModalTargetStudent.id)));
  const lpDraftStudent = readableScopedStudents.find((student) => student.id === lpDraftStudentId);
  const lpDraftOwner = isFullAdminSession && isAdminView ? resolveAssignableOperationsOwner(lpDraftStudent?.owner) ?? "" : lpDraftStudent?.owner ?? "";
  const selectedMessageState = scopedMessages.find((message) => message.id === selectedMessageId);
  const selectedBookingSeries = scopedBookings.find((booking) => booking.id === selectedBookingId);
  const selectedBookingByStableKey = selectedBookingSeries && selectedBookingOccurrenceKey
    ? bookingOccurrenceByStableKey(selectedBookingSeries, selectedBookingOccurrenceKey, selectedBookingSourceDate)
    : undefined;
  const selectedBookingByLegacyDate = selectedBookingSeries && !selectedBookingOccurrenceKey && selectedBookingDate && selectedBookingDateId === selectedBookingSeries.id
    ? uniqueBookingOccurrenceForTargetDate(selectedBookingSeries, selectedBookingDate)
    : undefined;
  const selectedClassroomOccurrence = selectedBookingByStableKey ?? selectedBookingByLegacyDate ?? null;
  const selectedClassroomBookingId = selectedClassroomOccurrence?.id ?? null;
  const selectedClassroomOccurrenceKey = selectedClassroomOccurrence?.occurrenceKey ?? null;
  const selectedClassroomSourceDate = selectedClassroomOccurrence?.sourceDate ?? selectedBookingSourceDate;
  const selectedClassroomMeetingId = selectedClassroomOccurrence?.classroom?.meetingId
    ?? (selectedClassroomOccurrenceKey ? provisionedClassrooms[selectedClassroomOccurrenceKey] : null)
    ?? null;
  const selectedOperationState = scopedOperations.find((operation) => operation.id === selectedOperationId);
  const examReminderStudents = useMemo(() => {
    const now = new Date();
    const today = isoDateInTimezone(now, "Australia/Melbourne");
    const threshold = Number(rules.examDays || 30);
    return examStudents.filter((student) => {
      if (!isActiveStudent(student)) return false;
      return examRecordsForStudent(student).some((record) => {
        if (!record.examDate) return false;
        const days = daysBetweenIsoDates(today, record.examDate);
        return days >= 0 && days <= threshold;
      });
    });
  }, [examStudents, rules.examDays]);
  const dstRiskBookings = useMemo(() => scopedBookings.filter((booking) => {
    const student = students.find((item) => item.id === booking.studentId);
    const teacher = teachers.find((item) => item.id === booking.teacherId);
    return student && teacher ? bookingHasDstRisk(booking, student, teacher) : false;
  }), [scopedBookings, students, teachers]);
  const ownerOptions = useMemo(() => operationsOwnerFilterOptions(recordStudents.map((student) => student.owner)), [recordStudents]);
  const operatorOptions = useMemo(() => canUseAdminScope ? Array.from(new Set([sessionOperator, DEMO_LIMITED_ADMIN_USER, ...DEMO_STAFF_USERS, ...ownerOptions.filter((owner) => owner !== "Nixon"), ...recordTeachers.map((teacher) => teacher.name)])) : [sessionOperator], [canUseAdminScope, ownerOptions, recordTeachers, sessionOperator]);
  const teamOwnerOptions = useMemo(() => operationsOwnerFormOptions(isAdminView ? undefined : currentOperator), [currentOperator, isAdminView]);
  const sourceGroups = useMemo(() => partitionOpsSources(syncSources), [syncSources]);
  const jiaowubaoAuthorityStatus = useMemo(() => findJiaowubaoAuthorityStatus(syncSources), [syncSources]);
  const activeSources = sourceGroups.active;
  const archivedSources = sourceGroups.archived;
  const staleSources = useMemo(() => activeSources.filter((source) => opsSourceIsStale(source)), [activeSources]);
  const latestSourceSync = useMemo(() => activeSources
    .map((source) => new Date(source.synced_at))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())[0], [activeSources]);
  const sourceFreshnessLabel = !syncSources.length
    ? "未连接外部只读来源"
    : !activeSources.length
      ? `${archivedSources.length} 个历史来源已归档`
    : staleSources.length
      ? `${staleSources.length} 个来源已超过 36 小时未读取`
      : `外部来源截至 ${formatSourceTime(latestSourceSync?.toISOString(), displayPreferences)}`;
  const displayedRules = rulesDraftTouched ? rulesDraft : normalizeRules(rules);
  const rulesDraftStale = rulesDraftTouched && rulesDraftBaseVersion !== rulesShared.version;
  const updateRulesDraft = (nextRules: Rules) => {
    const changed = !rulesMatch(nextRules, rules);
    if (!rulesDraftTouched && changed) setRulesDraftBaseVersion(rulesShared.version);
    if (!changed) setRulesDraftBaseVersion(rulesShared.version);
    setRulesDraft(nextRules);
    setRulesDraftTouched(changed);
  };
  const renewalTaskProjectionSnapshot = useMemo<{
    projections: RenewalPackageProjection[];
    scopeStudentIds: string[];
  }>(() => {
    const now = new Date();
    const today = isoDateInTimezone(now, "Australia/Melbourne");
    const projectionEnd = shiftIsoDate(today, 365);
    const targetStudents = isAdminView ? recordStudents : scopedStudents;
    const renewalStatusRecords = renewals.map((renewal) => ({
      studentId: renewal.studentId,
      packageId: renewal.packageId,
      subjectId: renewal.subjectId,
      status: renewal.businessStatus ?? normalizeRenewalBusinessStatus(renewal.status),
      lastAttemptAt: renewal.lastAttemptAt,
      remainingHoursAtRenewal: renewal.remainingHoursAtRenewal,
    }));
    const scopeStudentIds: string[] = [];
    const projections = targetStudents.flatMap((student) => {
      const packages = student.lessonPackages ?? [];
      if (!packages.length) {
        scopeStudentIds.push(student.id);
        return [];
      }
      const occurrences = bookings
        .filter((booking) => booking.studentId === student.id && booking.packageId)
        .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(today, -1), projectionEnd))
        .filter((occurrence) => bookingInstant(occurrence).getTime() >= now.getTime())
        .flatMap((occurrence) => {
          const lessonPackage = packages.find((entry) => entry.id === occurrence.packageId);
          const subjectId = occurrence.course ?? student.course;
          return lessonPackage?.subjectIds.includes(subjectId) ? [{
            id: occurrence.occurrenceKey,
            packageId: occurrence.packageId,
            subjectId,
            date: occurrence.date,
            start: occurrence.start,
            timezone: occurrence.timezone,
            duration: occurrence.duration,
            status: occurrence.status,
          }] : [];
        });
      let estimates: ReturnType<typeof mapLessonPackageDepletionEstimates> = [];
      try { estimates = mapLessonPackageDepletionEstimates(packages, occurrences); } catch { return []; }
      scopeStudentIds.push(student.id);
      return estimates.flatMap((estimate) => {
        const lessonPackage = packages.find((entry) => entry.id === estimate.packageId);
        if (!lessonPackage) return [];
        const remainingHours = getLessonPackageBalance(lessonPackage).remainingHours;
        const lowBalance = remainingHours < Number(rules.lowHours || 5);
        if (!estimate.depletionDate && !lowBalance) return [];
        const recordedStatus = renewalStatusForPackage(renewalStatusRecords, {
          studentId: student.id,
          packageId: estimate.packageId,
          packageCount: packages.length,
          cycleStartedAt: latestRenewalPurchaseAt(lessonPackage.purchaseRecords),
          remainingHours,
        }) ?? "not_renewed_active";
        const status = renewalProjectionStateForStudent(recordedStatus, isActiveStudent(student));
        const packageOccurrences = occurrences
          .filter((occurrence) => occurrence.packageId === estimate.packageId)
          .sort((left, right) => left.date.localeCompare(right.date) || left.start.localeCompare(right.start) || left.id.localeCompare(right.id));
        const depletionIndex = estimate.occurrenceId
          ? packageOccurrences.findIndex((occurrence) => occurrence.id === estimate.occurrenceId)
          : -1;
        const depletionOccurrence = depletionIndex >= 0 ? packageOccurrences[depletionIndex] : undefined;
        const nextScheduled = packageOccurrences[0];
        const nextAfterDepletion = depletionIndex >= 0 ? packageOccurrences[depletionIndex + 1] : undefined;
        const depletionInstant = depletionOccurrence
          ? zonedDateTimeToUtc(depletionOccurrence.date, depletionOccurrence.start, depletionOccurrence.timezone)
          : null;
        const afterInstant = nextAfterDepletion
          ? zonedDateTimeToUtc(nextAfterDepletion.date, nextAfterDepletion.start, nextAfterDepletion.timezone)
          : null;
        const renewalDateNote = buildRenewalDateNote({
          depletionSubjectId: estimate.subjectId,
          remainingHours,
          depletionLessonHours: depletionOccurrence ? depletionOccurrence.duration / 60 : undefined,
          nextScheduledLesson: nextScheduled ? {
            subjectId: nextScheduled.subjectId,
            date: nextScheduled.date,
            start: nextScheduled.start,
            hours: nextScheduled.duration / 60,
          } : null,
          nextLessonAfterDepletion: nextAfterDepletion && depletionInstant && afterInstant ? {
            subjectId: nextAfterDepletion.subjectId,
            date: nextAfterDepletion.date,
            start: nextAfterDepletion.start,
            withinSevenDays: afterInstant.getTime() - depletionInstant.getTime() < 7 * 24 * 60 * 60 * 1000,
          } : null,
        });
        return [{
          studentId: student.id,
          packageId: estimate.packageId,
          packageName: lessonPackage.name,
          renewalDateNote: renewalDateNote || undefined,
          owner: student.owner,
          cycleStartedAt: renewalTaskCycleForPackage(renewalStatusRecords, {
            studentId: student.id, packageId: estimate.packageId, packageCount: packages.length,
            cycleStartedAt: latestRenewalPurchaseAt(lessonPackage.purchaseRecords), remainingHours,
          }),
          remainingHours,
          // Depletion dates come only from real lesson evidence. Zero balance
          // without one generates an explicitly labeled follow-up deadline.
          depletionAt: estimate.depletionDate && depletionInstant
            ? depletionInstant.toISOString()
            : undefined,
          status,
        } satisfies RenewalPackageProjection];
      });
    });
    return { projections, scopeStudentIds };
  }, [bookings, isAdminView, recordStudents, renewals, rules.lowHours, scopedStudents]);
  const renewalTaskProjections = renewalTaskProjectionSnapshot.projections;

  useEffect(() => {
    if (isTeacherView || isAvaCalendarView) return;
    setTasks((current) => {
      const next = reconcileRenewalTasks(current, renewalTaskProjections, {
        now: new Date(),
        scopeStudentIds: renewalTaskProjectionSnapshot.scopeStudentIds,
      });
      const before = JSON.stringify(current);
      return before === JSON.stringify(next) ? current : next;
    });
  }, [isAvaCalendarView, isTeacherView, renewalTaskProjectionSnapshot, renewalTaskProjections, setTasks]);

  const addAudit = (action: string, detail: string, tone: Tone = "blue") => {
    void action;
    void detail;
    void tone;
    if (!canUseAdminScope) return;
    // Business RPCs and generic state commits write the authoritative event in
    // the database transaction. Refresh only that server projection after the
    // shared-state debounce; never persist browser-authored audit prose.
    window.setTimeout(() => {
      void fetch("/api/audit", { cache: "no-store" }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.entries)) {
          notify(body.error || "操作审计读取失败");
          return;
        }
        setAudit(body.entries as AuditEntry[]);
      }).catch(() => notify("操作审计读取失败"));
    }, 1_000);
  };

  const notify = useCallback((message: string, undo?: () => void) => {
    const toastId = id("TOAST");
    setToast({
      id: toastId,
      message: translateInterfaceText(message, displayPreferences.language),
      actionLabel: undo ? translateInterfaceText("撤销", displayPreferences.language) : undefined,
      onAction: undo,
    });
    window.setTimeout(
      () => setToast((current) => (current?.id === toastId ? null : current)),
      undo ? 12000 : 4200,
    );
  }, [displayPreferences.language]);

  const syncJiaowubaoCompletedLessons = async () => {
    if (jiaowubaoCompletedLessonSyncing || jiaowubaoCompletedLessonExporting) return;
    const month = activePayrollMonth;
    setJiaowubaoCompletedLessonSyncing(true);
    setJiaowubaoCompletedLessonError(false);
    try {
      const response = await fetch("/api/jiaowubao-open-api/completed-lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // An administrator can rebuild a published snapshot. A blocked run
        // still needs the separate administrator recovery procedure.
        body: JSON.stringify({ month, force: true }),
      });
      const body = await response.json().catch(() => null) as {
        outcome?: unknown;
        retryAfterSeconds?: unknown;
        memberCount?: unknown;
        completedMemberCount?: unknown;
        rowCount?: unknown;
        sync?: { outcome?: unknown };
      } | null;
      if (body?.outcome === "blocked" || body?.sync?.outcome === "blocked") {
        setJiaowubaoCompletedLessonError(true);
        notify("该月份采集已被阻断，请联系管理员核对并恢复；当前显示的仍是此前已发布快照。");
        return;
      }
      if (response.status === 202 && body?.outcome === "already_running") {
        const retry = typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0
          ? `约 ${Math.ceil(body.retryAfterSeconds / 60)} 分钟后`
          : "稍后";
        notify(`该月份正在同步，请${retry}刷新查看。`);
        return;
      }
      if (response.status === 202 && body?.outcome === "in_progress") {
        const memberCount = typeof body.memberCount === "number" ? body.memberCount : 0;
        const completedMemberCount = typeof body.completedMemberCount === "number" ? body.completedMemberCount : 0;
        const rowCount = typeof body.rowCount === "number" ? body.rowCount : 0;
        notify(`已采集 ${completedMemberCount}/${memberCount} 个教务宝学员（${rowCount} 条已消课明细）；后台会自动续跑并在完整后发布。`);
        return;
      }
      if (!response.ok || !body || !["applied", "no_change"].includes(String(body.sync?.outcome))) {
        throw new Error("教务宝已消课同步未完成。");
      }
      const feed = await loadAllJiaowubaoCompletedLessonPages({ month });
      setJiaowubaoCompletedLessonFeed(feed);
      addAudit("同步教务宝已消课", `${month} · ${feed.rowCount} 条学生明细 · ${feed.scheduleRowCount} 条排课角色资料`, "blue");
      notify(feed.state === "complete"
        ? `已同步 ${feed.rowCount} 条学生明细及 ${feed.scheduleRowCount} 条老师角色资料；待核对项目已保留。`
        : "该月份暂无已发布的教务宝已消课快照。");
    } catch {
      setJiaowubaoCompletedLessonError(true);
      notify("教务宝已消课同步未完成；已发布的历史快照不会被覆盖。");
    } finally {
      setJiaowubaoCompletedLessonSyncing(false);
    }
  };

  const syncTrialSchedulesFromJiaowubao = async () => {
    if (trialScheduleSyncRunRef.current) return;
    trialScheduleSyncRunRef.current = true;
    setTrialScheduleSyncing(true);
    try {
      const storage = browserSessionStorage();
      let pending = readJiaowubaoTrialSyncPendingCommands(storage, currentOperator);
      const submit = async (command: JiaowubaoTrialSyncCommand, scope: string) => {
        const requestCommand: JiaowubaoTrialSyncCommand = {
          commandKey: command.commandKey,
          snapshotRevision: command.snapshotRevision,
          window: command.window,
          matches: command.matches,
          ...(command.revocations ? { revocations: command.revocations } : {}),
          expectedVersions: command.expectedVersions,
        };
        const response = await fetch("/api/operations/jiaowubao-trial-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestCommand),
        });
        const body = await response.json().catch(() => ({}));
        const hasAuthoritativeRows = Boolean(body.lpItemsRow && body.tasksRow);
        const disposition = jiaowubaoTrialSyncPendingDisposition({
          status: response.status,
          committed: body.committed === true,
          hasAuthoritativeRows,
        });
        if (disposition === "clear") {
          pending = removeJiaowubaoTrialSyncPendingCommand(pending.values(), scope);
          persistJiaowubaoTrialSyncPendingCommands(storage, currentOperator, pending.values());
        }
        if (!response.ok || body.committed !== true || !hasAuthoritativeRows) {
          throw new Error(body.error || "试听原子同步没有返回完整权威状态");
        }
        lpShared.applyRemote(body.lpItemsRow as RemoteStateRow<LpItem[]>);
        tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
      };

      // Unknown-result commands are replayed before inspecting the current
      // browser snapshot. A committed write therefore remains recoverable even
      // when the source pointer or local OCC versions have since advanced.
      for (const entry of [...pending.values()]) {
        await submit(entry, entry.scope);
      }

      if (!currentJiaowubaoImportedSchedule || currentJiaowubaoImportedSchedule.state !== "complete") {
        notify(currentJiaowubaoImportedSchedule?.state === "stale" ? "教务宝课表快照已过期，暂不写入试听任务" : "教务宝真实课表尚未读取完成");
        return;
      }
      if (!currentJiaowubaoImportedSchedule.revision) {
        notify("教务宝课表缺少可验证版本，请刷新后重试");
        return;
      }
      const revocations = jiaowubaoTrialMissingScheduleRefs({
        lpItems: scopedLpItems,
        eventIds: new Set(currentJiaowubaoImportedSchedule.events.map((event) => event.eventId)),
        window: trialScheduleWindow,
        now: new Date(),
      }).filter((reference) => !trialScheduleMatches.some((match) => match.lpItemId === reference.lpItemId));
      if (!trialScheduleMatches.length && !revocations.length) {
        notify("当前没有可无歧义匹配的试听排课；请核对学生姓名和 A/B/C 规划老师");
        return;
      }
      const matchRefs = trialScheduleMatches.map((match) => ({
        lpItemId: match.lpItemId,
        eventId: match.link.eventId,
        startsAt: match.link.startsAt,
      })).sort((left, right) => left.lpItemId.localeCompare(right.lpItemId) || left.eventId.localeCompare(right.eventId));
      const changes = [...matchRefs.map((reference) => ({ reference, revoke: false })),
        ...revocations.map((reference) => ({ reference, revoke: true }))];
      for (let offset = 0; offset < changes.length; offset += JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES) {
        const batch = changes.slice(offset, offset + JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES);
        const revoked = batch.filter((change) => change.revoke).map((change) => change.reference);
        const command: JiaowubaoTrialSyncCommand = {
          commandKey: crypto.randomUUID(),
          snapshotRevision: currentJiaowubaoImportedSchedule.revision,
          window: {
            startsAt: trialScheduleWindow.startsAt,
            endsAt: trialScheduleWindow.endsAt,
          },
          matches: batch.filter((change) => !change.revoke).map((change) => change.reference),
          ...(revoked.length ? { revocations: revoked } : {}),
          expectedVersions: {
            lpItems: lpShared.getCurrentVersion(),
            tasks: tasksShared.getCurrentVersion(),
          },
        };
        const scope = jiaowubaoTrialSyncScope(command);
        const existing = pending.get(scope);
        const pendingCommand: JiaowubaoTrialSyncPendingCommand = existing ?? { scope, ...command };
        pending = upsertJiaowubaoTrialSyncPendingCommand(pending.values(), pendingCommand);
        persistJiaowubaoTrialSyncPendingCommands(storage, currentOperator, pending.values());
        await submit(pendingCommand, scope);
      }
      addAudit("同步教务宝试听排课", `${trialScheduleMatches.length} 条试听排课与任务已更新；${revocations.length} 条失效关联已撤销`, "green");
      notify(`已核对 ${trialScheduleMatches.length} 条试听；撤销 ${revocations.length} 条已取消排课的关联和未完成提醒`);
    } catch (error) {
      notify(error instanceof Error ? `试听排课同步失败：${error.message}` : "试听排课同步失败，可安全重试");
    } finally {
      trialScheduleSyncRunRef.current = false;
      setTrialScheduleSyncing(false);
    }
  };

  useEffect(() => {
    if (active !== "lp") return;
    const recoveryKey = currentOperator.trim().toLocaleLowerCase();
    if (!recoveryKey || trialSchedulePendingRecoveryAttemptedRef.current.has(recoveryKey)) return;
    trialSchedulePendingRecoveryAttemptedRef.current.add(recoveryKey);
    if (readJiaowubaoTrialSyncPendingCommands(browserSessionStorage(), currentOperator).size) {
      void syncTrialSchedulesFromJiaowubao();
    }
    // Recovery is intentionally once per signed actor and calls the same
    // idempotent command path before any source revalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentOperator]);

  const refreshJiaowubaoScheduleMappingReview = async () => {
    const review = await readJiaowubaoScheduleMappingReview();
    setJiaowubaoScheduleMappingReview(review);
    setJiaowubaoScheduleMappingError(false);
    return review;
  };

  const refreshJiaowubaoScheduleMappingPriorityReview = async () => {
    const review = await readJiaowubaoScheduleMappingPriorityReview(jiaowubaoScheduleMappingPriorityWindow);
    setJiaowubaoScheduleMappingPriorityReview(review);
    setJiaowubaoScheduleMappingPriorityError(false);
    return review;
  };

  const loadMoreJiaowubaoScheduleMappingPriority = async () => {
    const current = jiaowubaoScheduleMappingPriorityReview;
    if (!canUseAdminScope || !isAdminView || active !== "sync" || jiaowubaoScheduleMappingPriorityLoadingMore
      || !current || current.state !== "complete" || !current.nextCursor) return;
    const cursor = current.nextCursor;
    setJiaowubaoScheduleMappingPriorityLoadingMore(true);
    try {
      const next = await readJiaowubaoScheduleMappingPriorityReview(jiaowubaoScheduleMappingPriorityWindow, cursor);
      if (next.state !== "complete" || next.runToken !== current.runToken
        || next.teachersVersion !== current.teachersVersion
        || next.window.startsAt !== current.window.startsAt || next.window.endsAt !== current.window.endsAt
        || next.candidates.some((candidate) => current.candidates.some((loaded) => loaded.mappingKey === candidate.mappingKey))) {
        throw new Error("当前教务宝映射待核对分页已变化。");
      }
      setJiaowubaoScheduleMappingPriorityReview({
        ...current,
        candidates: [...current.candidates, ...next.candidates],
        nextCursor: next.nextCursor,
      });
    } catch {
      setJiaowubaoScheduleMappingPriorityReview(null);
      setJiaowubaoScheduleMappingPriorityError(true);
    } finally {
      setJiaowubaoScheduleMappingPriorityLoadingMore(false);
    }
  };

  const loadMoreJiaowubaoScheduleMappings = async () => {
    const current = jiaowubaoScheduleMappingReview;
    if (!canUseAdminScope || !isAdminView || active !== "sync" || jiaowubaoScheduleMappingLoadingMore
      || !current || current.state !== "complete" || !current.nextCursor) return;
    const cursor = current.nextCursor;
    setJiaowubaoScheduleMappingLoadingMore(true);
    try {
      const next = await readJiaowubaoScheduleMappingReview(cursor);
      if (next.state !== "complete" || next.runToken !== current.runToken
        || next.teachersVersion !== current.teachersVersion
        || next.candidates.some((candidate) => current.candidates.some((loaded) => loaded.mappingKey === candidate.mappingKey))) {
        throw new Error("教务宝映射分页已变化。");
      }
      setJiaowubaoScheduleMappingReview({
        ...current,
        candidates: [...current.candidates, ...next.candidates],
        nextCursor: next.nextCursor,
      });
    } catch {
      setJiaowubaoScheduleMappingReview(null);
      setJiaowubaoScheduleMappingError(true);
    } finally {
      setJiaowubaoScheduleMappingLoadingMore(false);
    }
  };

  const saveJiaowubaoScheduleMapping = async (
    mappingKey: string,
    action: "confirm" | "revoke",
    targetTeacherId: string | null,
    targetSubjectId: string | null,
  ) => {
    const review = jiaowubaoScheduleMappingReview;
    if (!canUseAdminScope || !isAdminView || active !== "sync" || jiaowubaoScheduleMappingBusyKey
      || jiaowubaoScheduleMappingPriorityBusyKey || !review || review.state !== "complete"
      || review.teachersVersion === null || !review.candidates.some((candidate) => candidate.mappingKey === mappingKey)) return;
    if (action === "confirm") {
      const targetTeacher = review.teachers.find((teacher) => teacher.id === targetTeacherId);
      if (!targetTeacher || !targetSubjectId || !targetTeacher.subjectIds.includes(targetSubjectId)) {
        notify("当前老师或可教科目已变更，请刷新后重新确认。");
        return;
      }
    }
    const intent = JSON.stringify([mappingKey, action, targetTeacherId, targetSubjectId, review.teachersVersion]);
    const commandKey = jiaowubaoScheduleMappingCommandKeysRef.current.get(intent) ?? crypto.randomUUID();
    jiaowubaoScheduleMappingCommandKeysRef.current.set(intent, commandKey);
    let commandSaved = false;
    setJiaowubaoScheduleMappingBusyKey(mappingKey);
    try {
      const response = await fetch("/api/jiaowubao-direct-import/schedule-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappingKey, commandKey, action, targetTeacherId, targetSubjectId, expectedTeachersVersion: review.teachersVersion }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || (body as Record<string, unknown>).saved !== true) throw new Error("教务宝映射确认失败。");
      commandSaved = true;
      await Promise.all([refreshJiaowubaoScheduleMappingReview(), refreshJiaowubaoScheduleMappingPriorityReview()]);
      jiaowubaoScheduleMappingCommandKeysRef.current.delete(intent);
      notify(action === "confirm" ? "教务宝老师与课程映射已确认。" : "教务宝老师与课程映射已撤销。");
    } catch {
      setJiaowubaoScheduleMappingReview(null);
      setJiaowubaoScheduleMappingError(true);
      setJiaowubaoScheduleMappingPriorityReview(null);
      setJiaowubaoScheduleMappingPriorityError(true);
      notify(commandSaved ? "教务宝映射已保存，但当前候选无法刷新；请重新打开同步与导入核对。" : "教务宝来源或老师科目资料可能已变更，请重新打开同步与导入后再确认。");
    } finally {
      setJiaowubaoScheduleMappingBusyKey(null);
    }
  };

  const saveJiaowubaoScheduleMappingPriority = async (
    mappingKey: string,
    action: "confirm" | "revoke",
    targetTeacherId: string | null,
    targetSubjectId: string | null,
  ) => {
    const review = jiaowubaoScheduleMappingPriorityReview;
    if (!canUseAdminScope || !isAdminView || active !== "sync" || jiaowubaoScheduleMappingBusyKey
      || jiaowubaoScheduleMappingPriorityBusyKey || !review || review.state !== "complete"
      || review.teachersVersion === null || !review.candidates.some((candidate) => candidate.mappingKey === mappingKey)) return;
    if (action === "confirm") {
      const targetTeacher = review.teachers.find((teacher) => teacher.id === targetTeacherId);
      if (!targetTeacher || !targetSubjectId || !targetTeacher.subjectIds.includes(targetSubjectId)) {
        notify("当前老师或可教科目已变更，请刷新后重新确认。");
        return;
      }
    }
    const intent = JSON.stringify(["priority", review.runToken, review.window.startsAt, review.window.endsAt, mappingKey, action, targetTeacherId, targetSubjectId, review.teachersVersion]);
    const commandKey = jiaowubaoScheduleMappingPriorityCommandKeysRef.current.get(intent) ?? crypto.randomUUID();
    jiaowubaoScheduleMappingPriorityCommandKeysRef.current.set(intent, commandKey);
    let commandSaved = false;
    setJiaowubaoScheduleMappingPriorityBusyKey(mappingKey);
    try {
      const response = await fetch("/api/jiaowubao-direct-import/schedule-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappingKey, commandKey, action, targetTeacherId, targetSubjectId, expectedTeachersVersion: review.teachersVersion }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || (body as Record<string, unknown>).saved !== true) throw new Error("当前教务宝映射确认失败。");
      commandSaved = true;
      await Promise.all([refreshJiaowubaoScheduleMappingPriorityReview(), refreshJiaowubaoScheduleMappingReview()]);
      jiaowubaoScheduleMappingPriorityCommandKeysRef.current.delete(intent);
      notify(action === "confirm" ? "当前教务宝老师与课程映射已确认。" : "该组合已从待核对队列移除，可在历史组合中重新确认。");
    } catch {
      setJiaowubaoScheduleMappingPriorityReview(null);
      setJiaowubaoScheduleMappingPriorityError(true);
      setJiaowubaoScheduleMappingReview(null);
      setJiaowubaoScheduleMappingError(true);
      notify(commandSaved ? "教务宝映射已保存，但当前候选无法刷新；请重新打开同步与导入核对。" : "教务宝来源或老师科目资料可能已变更，请重新打开同步与导入后再确认。");
    } finally {
      setJiaowubaoScheduleMappingPriorityBusyKey(null);
    }
  };

  const clearStudentModalTarget = useCallback(() => {
    setStudentModalTargetId("");
    setStudentModalTargetWasArchived(false);
  }, []);

  // The callback is intentionally stable because the scope-drift effect calls
  // it after authoritative student state changes.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const closeInvalidStudentModal = useCallback(() => {
    setModal(null);
    clearStudentModalTarget();
    setExamDraft(null);
    notify("学生资料已变化，请重新打开");
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [clearStudentModalTarget, notify]);

  const openStudentBoundModal = (nextModal: StudentBoundModalKind, studentId: string) => {
    const target = readableScopedStudents.find((student) => student.id === studentId);
    if (!target) {
      notify("当前身份无权查看该学生档案");
      return false;
    }
    const requiresActiveStudent = nextModal !== "studentRecords";
    if (requiresActiveStudent && (!scopedActiveStudentIds.has(target.id) || target.importArchived === true)) {
      notify("当前身份只能操作当前范围的活跃学生");
      return false;
    }
    setSelectedStudentId(target.id);
    setStudentModalTargetId(target.id);
    setStudentModalTargetWasArchived(target.importArchived === true);
    setModal(nextModal);
    return true;
  };

  const requireStudentModalTarget = (requiresActiveStudent = true) => {
    const target = studentModalTargetId
      ? readableScopedStudents.find((student) => student.id === studentModalTargetId)
      : undefined;
    const archivedStateChanged = target
      ? Boolean(target.importArchived) !== studentModalTargetWasArchived
      : false;
    if (!target
      || archivedStateChanged
      || (requiresActiveStudent && (!scopedActiveStudentIds.has(target.id) || target.importArchived === true))) {
      closeInvalidStudentModal();
      return null;
    }
    return target;
  };

  useEffect(() => {
    if (!modal || !STUDENT_BOUND_MODAL_KINDS.has(modal as StudentBoundModalKind)) return;
    const target = studentModalTargetId
      ? readableScopedStudents.find((student) => student.id === studentModalTargetId)
      : undefined;
    const archivedStateChanged = target
      ? Boolean(target.importArchived) !== studentModalTargetWasArchived
      : false;
    const requiresActiveStudent = modal !== "studentRecords";
    if (!target
      || archivedStateChanged
      || (requiresActiveStudent && (!scopedActiveStudentIds.has(target.id) || target.importArchived === true))) {
      // Defer the close until after React has committed the authoritative
      // snapshot. Rendering is already gated by studentModalTargetIsValid, so
      // a stale dialog cannot remain visible during the handoff.
      const frame = window.requestAnimationFrame(closeInvalidStudentModal);
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [closeInvalidStudentModal, modal, readableScopedStudents, scopedActiveStudentIds, studentModalTargetId, studentModalTargetWasArchived]);

  const refreshTeacherAvailabilitySubmissions = useCallback(async () => {
    setTeacherAvailabilityInboxBusy(true);
    try {
      const response = await fetch("/api/teacher-availability/review", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "AVA 待审列表读取失败");
      setTeacherAvailabilitySubmissions(Array.isArray(body.submissions) ? body.submissions : []);
      setTeacherAvailabilityReviewVersion(
        Number.isSafeInteger(body.teacherVersion) ? body.teacherVersion : teachersShared.version,
      );
      setTeacherAvailabilityReviewError("");
    } catch (error) {
      setTeacherAvailabilityReviewError(
        error instanceof Error ? error.message : "AVA 待审列表读取失败",
      );
    } finally {
      setTeacherAvailabilityInboxBusy(false);
    }
  }, [teachersShared.version]);

  useEffect(() => {
    if (!canUseAdminScope) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Starts one authenticated external inbox read when the admin session or teacher version changes.
    void refreshTeacherAvailabilitySubmissions();
  }, [canUseAdminScope, refreshTeacherAvailabilitySubmissions]);

  const requestConfirmation = (request: ConfirmRequest) => {
    setConfirmRequest(request);
  };

  const writeRulesVersion = async (payload: Rules, expectedVersion: number) => {
    const response = await fetch("/api/app-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "rules", payload, expectedVersion }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body.current) {
      rulesShared.applyRemote(body.current as RemoteStateRow<Rules>);
      throw new Error("规则已被其他人更新，请载入最新规则后再保存");
    }
    if (!response.ok || !body.row) throw new Error(body.error || "规则保存失败");
    const row = body.row as RemoteStateRow<Rules>;
    rulesShared.applyRemote(row);
    setRulesDraft(normalizeRules(row.payload));
    setRulesDraftTouched(false);
    setRulesDraftBaseVersion(row.version);
    return row;
  };

  const confirmRequestedAction = async () => {
    if (!confirmRequest || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await confirmRequest.onConfirm();
      setConfirmRequest(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setConfirmBusy(false);
    }
  };

  const saveLegacyTaskDeadline = async (melbourneDateTime: string) => {
    const task = legacyTaskDeadlineDraft;
    if (!task || legacyTaskDeadlineBusy || !canUseAdminScope || !isAdminView) return;
    if (!melbourneDateTime) {
      notify("请选择准确的墨尔本截止日期和时间");
      return;
    }
    const action = "set" as const;
    const commandIntent = JSON.stringify({
      action,
      taskId: task.id,
      ...(melbourneDateTime ? { melbourneDateTime } : {}),
    });
    const commandKey = legacyTaskDeadlineCommandKeysRef.current.get(commandIntent)
      ?? `legacy-task-deadline:${crypto.randomUUID()}`;
    legacyTaskDeadlineCommandKeysRef.current.set(commandIntent, commandKey);
    setLegacyTaskDeadlineBusy(true);
    try {
      const response = await fetch("/api/tasks/legacy-deadline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandKey,
          action,
          taskId: task.id,
          ...(melbourneDateTime ? { melbourneDateTime } : {}),
          expectedVersions: {
            students: studentsShared.version,
            tasks: tasksShared.version,
          },
        }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || !body || body.committed !== true || !body.taskRow) {
        if (response.status === 409 && body?.taskRow) {
          tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
          // This response proves the command did not commit. A post-refresh
          // correction must receive a fresh idempotency key.
          legacyTaskDeadlineCommandKeysRef.current.delete(commandIntent);
        }
        throw new Error(typeof body?.error === "string" ? body.error : "历史任务截止时间保存失败");
      }
      tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
      // Delete only after a confirmed response. An uncertain transport result
      // keeps the same command key so the server can return its audit receipt.
      legacyTaskDeadlineCommandKeysRef.current.delete(commandIntent);
      setLegacyTaskDeadlineDraft(null);
      setModal(null);
      if (body.applied === false) {
        notify(body.unchanged === true ? "截止时间没有变化" : "截止时间写入已确认，系统没有重复保存");
      } else {
        notify("已记录准确的墨尔本截止日期和时间");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "历史任务截止时间保存失败；可重试");
    } finally {
      setLegacyTaskDeadlineBusy(false);
    }
  };

  const submitLegacyTaskDeadline = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const melbourneDateTime = String(new FormData(event.currentTarget).get("melbourneDateTime") ?? "").trim();
    void saveLegacyTaskDeadline(melbourneDateTime);
  };

  const mutateManagedExamFollowUp = async (
    task: Task,
    action: "complete" | "undo",
    completionCommandKey?: string,
  ) => {
    const scope = `${action}:${task.id}`;
    if (examFollowUpBusyRef.current.has(scope)) throw new Error("这项考试提醒正在处理中");
    const stored = examFollowUpCommandRef.current.get(scope)
      ?? readPendingExamFollowUp(sessionOperator, action, task.id);
    const pending = stored
      && stored.completionCommandKey === completionCommandKey
      ? stored
      : {
          action,
          taskId: task.id,
          commandKey: `exam-follow-up:${crypto.randomUUID()}`,
          ...(completionCommandKey ? { completionCommandKey } : {}),
        } satisfies PendingExamFollowUp;
    examFollowUpCommandRef.current.set(scope, pending);
    writePendingExamFollowUp(sessionOperator, pending);
    examFollowUpBusyRef.current.add(scope);
    try {
      const response = await fetch("/api/exams/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandKey: pending.commandKey,
          action,
          taskId: task.id,
          expectedVersions: examFollowUpVersionsRef.current,
          ...(completionCommandKey ? { completionCommandKey } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.committed || !body.studentRow || !body.taskRow) {
        throw new Error(body.error || "考试提醒保存失败");
      }
      studentsShared.applyRemote(body.studentRow as RemoteStateRow<Student[]>);
      tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
      examFollowUpVersionsRef.current = {
        students: Number(body.studentRow.version),
        tasks: Number(body.taskRow.version),
      };
      if (action === "complete") {
        examCompletionCommandKeysRef.current.set(task.id, body.completionCommandKey);
        setExamCompletionCommandKeys((current) => ({ ...current, [task.id]: body.completionCommandKey }));
      } else {
        examCompletionCommandKeysRef.current.delete(task.id);
        setExamCompletionCommandKeys((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      }
      examFollowUpCommandRef.current.delete(scope);
      clearPendingExamFollowUp(sessionOperator, action, task.id);
      return body as {
        action: "complete" | "undo";
        applied: boolean;
        commandKey: string;
        completionCommandKey: string;
        studentRow: RemoteStateRow<Student[]>;
        taskRow: RemoteStateRow<Task[]>;
      };
    } finally {
      examFollowUpBusyRef.current.delete(scope);
    }
  };

  const completeManagedExamFollowUp = async (task: Task) => {
    try {
      const completed = await mutateManagedExamFollowUp(task, "complete");
      const completionCommandKey = completed.completionCommandKey;
      const undo = async () => {
        try {
          await mutateManagedExamFollowUp(task, "undo", completionCommandKey);
          notify("已原子撤销考试提醒完成状态");
        } catch (error) {
          notify(
            error instanceof Error ? `${error.message}；可重试撤销` : "考试提醒撤销状态未知；可重试",
            () => { void undo(); },
          );
        }
      };
      notify(
        completed.applied === false
          ? "考试提醒完成状态已确认，系统没有重复写入"
          : "考试提醒与学生考试状态已同步完成",
        () => { void undo(); },
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "考试提醒保存失败");
    }
  };

  const undoManagedExamFollowUp = async (task: Task) => {
    const completionCommandKey = examCompletionCommandKeysRef.current.get(task.id);
    if (!completionCommandKey) {
      notify("这项考试提醒缺少可安全撤销的完成凭证，请从原完成提示中撤销");
      return;
    }
    try {
      await mutateManagedExamFollowUp(task, "undo", completionCommandKey);
      notify("已原子撤销考试提醒完成状态");
    } catch (error) {
      notify(error instanceof Error ? `${error.message}；可重试撤销` : "考试提醒撤销状态未知；可重试");
    }
  };

  const mutateManagedTrialPayment = useCallback(async (
    taskId: string,
    action: "complete" | "reopen",
    recovering = false,
  ) => {
    if (trialPaymentBusyRef.current.has(taskId)) return;
    const storage = browserSessionStorage();
    const scope = `${action}:${taskId}`;
    const actionLabel = action === "complete" ? "确认付款" : "恢复未付费";
    let pending = trialPaymentCommandKeysRef.current.get(scope);
    if (!pending) {
      pending = {
        action,
        taskId,
        commandKey: `trial-payment-${action}:${crypto.randomUUID()}`,
        expectedVersions: {
          bookings: getCurrentBookingsVersion(),
          students: getCurrentStudentsVersion(),
          lpItems: getCurrentLpItemsVersion(),
          tasks: getCurrentTasksVersion(),
          teachers: getCurrentTeachersVersion(),
        },
      };
      trialPaymentCommandKeysRef.current = upsertTrialPaymentPendingCommand(
        trialPaymentCommandKeysRef.current.values(),
        pending,
      );
      persistTrialPaymentPendingCommands(
        storage,
        sessionOperator,
        trialPaymentCommandKeysRef.current.values(),
      );
    }
    if (!pending) return;
    let currentPending: TrialPaymentPendingCommand = pending;

    const clearPending = () => {
      trialPaymentCommandKeysRef.current = removeTrialPaymentPendingCommand(
        trialPaymentCommandKeysRef.current.values(),
        action,
        taskId,
      );
      persistTrialPaymentPendingCommands(
        storage,
        sessionOperator,
        trialPaymentCommandKeysRef.current.values(),
      );
    };

    trialPaymentBusyRef.current.add(taskId);
    try {
      // Recovery is intentionally serialized by the caller, and a stale OCC
      // response is rebased once to the latest locally authoritative versions.
      // The command key/task id never changes, so the retry remains idempotent.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        let body: unknown;
        try {
          const received = await fetchJsonWithTimeout(fetch, "/api/tasks/trial-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(currentPending),
          }, SHARED_STATE_REQUEST_TIMEOUT_MS);
          response = received.response;
          body = received.body;
        } catch {
          if (!recovering) notify(`试听${actionLabel}结果未知；已保留原命令，刷新后可安全恢复`);
          return;
        }
        const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        let receipt: ReturnType<typeof parseManagedTrialPaymentLifecycleReceipt> | null = null;
        if (response.ok) {
          try {
            receipt = parseManagedTrialPaymentLifecycleReceipt(
              body,
              currentPending.taskId,
              currentPending.action,
              sessionOperator,
              isAdminSession ? "admin" : "staff",
            );
          } catch {
            // A 2xx without both authoritative rows (or an explicit receipt-only
            // shape) is not enough evidence to discard the original command.
            receipt = null;
          }
        }
        const latestExpectedVersions = {
          bookings: getCurrentBookingsVersion(),
          students: getCurrentStudentsVersion(),
          lpItems: getCurrentLpItemsVersion(),
          tasks: getCurrentTasksVersion(),
          teachers: getCurrentTeachersVersion(),
        };
        const expectedVersionsChanged = (Object.keys(latestExpectedVersions) as Array<keyof typeof latestExpectedVersions>)
          .some((entity) => latestExpectedVersions[entity] !== currentPending.expectedVersions[entity]);
        const disposition = trialPaymentPendingDisposition({
          status: response.status,
          code: typeof bodyRecord.code === "string" ? bodyRecord.code : undefined,
          expectedVersionsChanged,
          committed: receipt?.committed === true,
          receiptOnly: receipt?.receiptOnly === true,
          hasAuthoritativeTaskRow: receipt?.taskRow !== null && receipt?.taskRow !== undefined,
          hasAuthoritativeProjection: receipt?.managedTrialPaymentSnapshot !== null
            && receipt?.managedTrialPaymentSnapshot !== undefined,
        });
        if (disposition === "retry" && attempt === 0) {
          currentPending = { ...currentPending, expectedVersions: latestExpectedVersions };
          trialPaymentCommandKeysRef.current = upsertTrialPaymentPendingCommand(
            trialPaymentCommandKeysRef.current.values(),
            currentPending,
          );
          persistTrialPaymentPendingCommands(
            storage,
            sessionOperator,
            trialPaymentCommandKeysRef.current.values(),
          );
          continue;
        }
        if (disposition === "clear") clearPending();

        if (!response.ok) {
          if ([403, 404].includes(response.status) || (response.status === 409 && disposition === "clear")) {
            clearManagedTrialPaymentProjection();
          }
          const errorMessage = typeof bodyRecord.error === "string"
            ? bodyRecord.error
            : `试听${actionLabel}暂时无法提交`;
          if (!recovering || disposition === "clear") {
            notify(disposition === "clear" ? errorMessage : `${errorMessage}；已保留原命令`);
          }
          return;
        }
        if (!receipt) {
          if (!recovering) notify(`试听${actionLabel}回执不完整；已保留原命令等待恢复`);
          return;
        }
        if (receipt.receiptOnly) {
          clearManagedTrialPaymentProjection();
          notify(`试听${actionLabel}已提交；当前负责范围已变化，未载入学生资料`);
          return;
        }
        const snapshot = receipt.managedTrialPaymentSnapshot;
        const taskRow = receipt.taskRow;
        if (!snapshot || !taskRow) return;
        const latestVersions = {
          bookings: getCurrentBookingsVersion(),
          students: getCurrentStudentsVersion(),
          lpItems: getCurrentLpItemsVersion(),
          tasks: getCurrentTasksVersion(),
        };
        if (managedTrialPaymentSnapshotCanReplace(snapshot, latestVersions)) {
          applyRemoteTrialPaymentTasks(taskRow as unknown as RemoteStateRow<Task[]>);
          replaceManagedTrialPaymentProjection(snapshot);
        } else {
          // The receipt is final, but a newer poll already won locally. Preserve
          // the newer rows and force a fresh, version-bound projection read.
          clearManagedTrialPaymentProjection();
        }
        notify(receipt.applied
          ? action === "complete"
            ? "已确认试听付款，LP 与收费提醒已同步"
            : "已恢复未付费，LP 与收费提醒已同步"
          : `试听${actionLabel}回执已恢复，系统没有重复写入`);
        return;
      }
    } finally {
      trialPaymentBusyRef.current.delete(taskId);
    }
  }, [
    clearManagedTrialPaymentProjection,
    getCurrentBookingsVersion,
    getCurrentLpItemsVersion,
    getCurrentStudentsVersion,
    getCurrentTasksVersion,
    getCurrentTeachersVersion,
    notify,
    replaceManagedTrialPaymentProjection,
    sessionOperator,
    applyRemoteTrialPaymentTasks,
    isAdminSession,
  ]);

  useEffect(() => {
    if (trialPaymentRecoveryActorRef.current === sessionOperator) return;
    trialPaymentRecoveryActorRef.current = sessionOperator;
    const pending = readTrialPaymentPendingCommands(browserSessionStorage(), sessionOperator);
    trialPaymentCommandKeysRef.current = pending;
    let cancelled = false;
    void (async () => {
      for (const entry of pending.values()) {
        if (cancelled) return;
        await mutateManagedTrialPayment(entry.taskId, entry.action, true);
      }
    })();
    return () => { cancelled = true; };
  }, [mutateManagedTrialPayment, sessionOperator]);

  const completeTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === "done") return;
    if (task.ruleKey === TRIAL_PENDING_SCHEDULING_RULE_KEY) {
      notify("试听待排课只能由教务宝真实排课自动完成");
      return;
    }
    if (isManagedTrialPaymentTask(task)) {
      const plannerCanComplete = initialRole === "staff"
        && currentOperator === sessionOperator
        && isManagedTrialPaymentTaskRecipient(task, sessionOperator);
      const adminCanComplete = isAdminSession && isAdminView && currentOperator === sessionOperator;
      if (!plannerCanComplete && !adminCanComplete) {
        notify("只有任务指定的规划老师可以确认试听付款");
        return;
      }
      void mutateManagedTrialPayment(task.id, "complete");
      return;
    }
    const examRule = task.ruleKey?.match(/^exam:([^:]+):(planning|care|recall|results)$/);
    if (task.category === "考试" && examRule && task.anchorBookingId === `exam:${examRule[1]}`) {
      void completeManagedExamFollowUp(task);
      return;
    }
    const completedAt = new Date();
    void tasksShared.mutateAndCommit((current) => completeTrialTaskWithHandbookFollowUps(current, {
      taskId,
      completedAt,
    }))
      .then(() => {
        addAudit("完成强提醒任务", `${task.title} · ${studentById(task.studentId)?.name ?? "未关联学生"}`, "green");
        notify("已完成并写入操作记录", () => {
          void tasksShared.mutateAndCommit((current) => reopenTrialTaskWithHandbookFollowUps(current, {
            taskId,
            reopenedAt: new Date(),
            timeZone: taskDeadlineTimeZone,
          }))
            .then(() => addAudit("撤销完成强提醒任务", `${task.title} · 恢复为待处理`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "任务完成保存失败"));
  };

  const taskUsesDedicatedLifecycle = (task: Task) => Boolean(
    task.category === "考试" && task.ruleKey?.match(/^exam:([^:]+):(planning|care|recall|results)$/),
  );

  const cannotDoTask = (taskId: string, reason: string) => {
    const task = tasks.find((item) => item.id === taskId);
    const note = reason.trim();
    if (!task || task.status === "done" || !note) return;
    if (taskUsesDedicatedLifecycle(task)) {
      notify("该任务由专用业务流程管理，不能直接标记为无法完成");
      return;
    }
    const closedAt = new Date().toISOString();
    void tasksShared.mutateAndCommit((current) => current.map((item) => item.id === taskId ? {
      ...item,
      status: "done" as const,
      tone: "red" as const,
      closedAt,
      result: `无法完成：${note}`,
      completionOutcome: "cannot_do" as const,
      completionNote: note,
    } : item)).then(() => {
      addAudit("记录任务无法完成", `${task.title} · ${note}`, "red");
      notify("已移入 Can’t Do，并保留原因");
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "无法完成原因保存失败"));
  };

  const reopenTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status !== "done") return;
    if (taskUsesDedicatedLifecycle(task)) {
      notify("该任务需要从对应业务流程撤销，不能直接恢复");
      return;
    }
    if (isManagedTrialPaymentTask(task) && task.completionOutcome !== "cannot_do") {
      if (!isManagedTrialPaymentConfirmationTask(task)) {
        notify("自动关闭的收费提醒请在试听复盘台账修改是否付费状态");
        return;
      }
      const plannerCanReopen = initialRole === "staff"
        && currentOperator === sessionOperator
        && isManagedTrialPaymentTaskRecipient(task, sessionOperator);
      const adminCanReopen = isAdminSession && isAdminView && currentOperator === sessionOperator;
      if (!plannerCanReopen && !adminCanReopen) {
        notify("只有任务指定的规划老师可以恢复试听未付费状态");
        return;
      }
      void mutateManagedTrialPayment(task.id, "reopen");
      return;
    }
    // Can't Do records whether the reminder itself could be executed; it is
    // not payment evidence and therefore must not mutate the LP paid flag.
    if (!task.dueAt) {
      notify("该历史任务没有准确截止时间，不能恢复为可执行任务");
      return;
    }
    void tasksShared.mutateAndCommit((current) => reopenTrialTaskWithHandbookFollowUps(current, {
      taskId,
      reopenedAt: new Date(),
      timeZone: taskDeadlineTimeZone,
    })).then(() => {
      addAudit("恢复任务到 To Do", task.title, "amber");
      notify("任务已恢复到 To Do");
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "任务恢复失败"));
  };

  const updateTaskNote = (taskId: string, note: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (taskUsesDedicatedLifecycle(task)) {
      notify("该任务由专用业务流程管理，暂不能直接修改备注");
      return;
    }
    const trimmed = note.trim();
    const cannotDo = task.status === "done" && task.completionOutcome === "cannot_do";
    if (cannotDo && !trimmed) {
      notify("无法完成原因不能为空");
      return;
    }
    void tasksShared.mutateAndCommit((current) => current.map((item) => item.id === taskId
      ? {
          ...item,
          completionNote: trimmed || undefined,
          ...(cannotDo ? { result: `无法完成：${trimmed}` } : {}),
        }
      : item)).then(() => notify(trimmed ? "任务备注已保存" : "任务备注已清除"))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "任务备注保存失败"));
  };

  const recordTrialParentReply = (task: Task) => {
    if (!task.anchorBookingId) return;
    const before = tasks.filter((item) => item.studentId === task.studentId
      && item.anchorBookingId === task.anchorBookingId
      && (isTrialEscalationTaskRule(item.ruleKey) || item.id === task.id));
    const repliedAt = new Date();
    void tasksShared.mutateAndCommit((current) => closeTrialEscalationTasks(
      current.map((item) => item.id === task.id && item.status !== "done"
        ? { ...item, status: "done" as const, tone: "green" as const, result: "家长已回复", closedAt: repliedAt.toISOString() }
        : item),
      { anchorBookingId: task.anchorBookingId!, studentId: task.studentId, closedAt: repliedAt },
    ))
      .then(() => {
        addAudit("记录试听家长回复", `${studentById(task.studentId)?.name ?? task.studentId} · 未回复升级链已关闭`, "green");
        notify("已记录家长回复，后续未回复升级任务已关闭", () => {
          const beforeById = new Map(before.map((item) => [item.id, item]));
          void tasksShared.mutateAndCommit((current) => current.map((item) => beforeById.get(item.id) ?? item))
            .then(() => addAudit("撤销试听家长回复", `${studentById(task.studentId)?.name ?? task.studentId} · 恢复升级任务`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "家长回复保存失败"));
  };

  const recordTrialTeacherReply = (task: Task) => {
    if (!task.anchorBookingId || !isTrialTeacherReplyTaskRule(task.ruleKey)) return;
    const before = tasks.filter((item) => item.studentId === task.studentId
      && item.anchorBookingId === task.anchorBookingId
      && isTrialTeacherReplyTaskRule(item.ruleKey));
    const repliedAt = new Date();
    void tasksShared.mutateAndCommit((current) => closeTrialTeacherReplyTasks(current, { task, repliedAt }))
      .then(() => {
        addAudit("记录试听老师回复", `${studentById(task.studentId)?.name ?? task.studentId} · 4/8 小时提醒链已关闭`, "green");
        notify("已记录老师回复，后续老师回复提醒已关闭", () => {
          const beforeById = new Map(before.map((item) => [item.id, item]));
          void tasksShared.mutateAndCommit((current) => current.map((item) => beforeById.get(item.id) ?? item))
            .then(() => addAudit("撤销试听老师回复", `${studentById(task.studentId)?.name ?? task.studentId} · 恢复老师回复提醒`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "老师回复保存失败"));
  };

  const visibleTasks = useMemo(() => {
    const now = taskRefreshKey ? new Date(taskRefreshKey) : new Date();
    return sortTasksByDueAt(scopedTasks
      .filter((task) => !isTrialAcceptanceFixtureTask(task, taskStudentNames.get(task.studentId)))
      .map((task) => refreshTaskStatus(task, now, taskDeadlineTimeZone)));
  }, [scopedTasks, taskDeadlineTimeZone, taskRefreshKey, taskStudentNames]);

  const switchOperator = (operator: string, accountRole?: DemoSessionRole) => {
    const teacherView = accountRole ? accountRole === "teacher" : teacherOperatorNames.has(operator);
    const adminScope = accountRole
      ? accountRole === "admin" || accountRole === "limited-admin"
      : operator === "Nixon" || operator === DEMO_LIMITED_ADMIN_USER;
    const teacher = teacherView ? recordTeachers.find((item) => item.name.trim().toLocaleLowerCase() === operator.trim().toLocaleLowerCase()) : undefined;
    const teacherStudentIds = new Set(teacher ? bookings.filter((booking) => booking.teacherId === teacher.id).map((booking) => booking.studentId) : []);
    const allowedStudents = adminScope ? recordStudents : teacherView ? recordStudents.filter((student) => student.teacher.trim().toLocaleLowerCase() === operator.trim().toLocaleLowerCase() || teacherStudentIds.has(student.id)) : recordStudents.filter((student) => student.owner === operator);
    setCurrentOperator(operator);
    setTaskFilter("all");
    setStudentView(adminScope || teacherView ? "all" : "mine");
    setStudentOwner("all");
    setStudentPage(1);
    setSelectedStudentIds([]);
    const firstOwnedStudent = allowedStudents[0];
    const allowedStudentIds = new Set(allowedStudents.map((student) => student.id));
    if (firstOwnedStudent) setSelectedStudentId(firstOwnedStudent.id);
    else setSelectedStudentId("");
    if (teacher) setSelectedTeacherId(teacher.id);
    const firstBooking = bookings.find((booking) => teacher ? booking.teacherId === teacher.id : allowedStudentIds.has(booking.studentId));
    const firstMessage = messages.find((message) => allowedStudentIds.has(message.studentId));
    const firstOperation = operations.find((operation) => allowedStudentIds.has(operation.studentId));
    if (firstBooking) selectBookingRecord(firstBooking);
    else {
      setSelectedBookingId("");
      setSelectedBookingDate(null);
      setSelectedBookingDateId(null);
      setSelectedBookingOccurrenceKey(null);
      setSelectedBookingSourceDate(null);
    }
    if (firstMessage) setSelectedMessageId(firstMessage.id);
    else setSelectedMessageId("");
    if (firstOperation) setSelectedOperationId(firstOperation.id);
    else setSelectedOperationId("");
    if (!adminScope && !(teacherView ? teacherSectionIds : staffSectionIds).has(active)) setActive("dashboard");
    if (operator === DEMO_LIMITED_ADMIN_USER && active === "payroll") setActive("dashboard");
    notify(adminScope ? "已切换到全局管理视图" : teacherView ? `已切换到 ${operator} 的老师视图` : `已切换到 ${operator} 的个人工作视图`);
  };

  const requestOperatorSwitch = (operator: string) => {
    if (!canUseAdminScope && operator !== sessionOperator) return;
    switchOperator(operator);
  };

  const logout = async () => {
    setLogoutBusy(true);
    try {
      const response = await fetch("/api/demo-logout", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.serverSessionRevoked === true) {
        window.location.reload();
        return;
      }
      if (body.localLogout === true) {
        window.sessionStorage.setItem(
          LOGOUT_RETRY_NOTICE_KEY,
          typeof body.error === "string" ? body.error : "本机已退出；服务器会话撤销将在后台重试。",
        );
        window.location.reload();
        return;
      }
      throw new Error(typeof body.error === "string" ? body.error : "退出失败，请重试。");
    } catch (error) {
      setLogoutBusy(false);
      notify(error instanceof Error ? error.message : "退出失败，请重试。");
    }
  };

  const sharedVersionsRef = useRef<Record<string, number>>({});
  const remoteHandlersRef = useRef<Record<string, (row: RemoteStateRow) => void>>({});

  useEffect(() => {
    sharedVersionsRef.current = {
      students: studentsShared.version,
      teachers: teachersShared.version,
      tasks: tasksShared.version,
      bookings: bookingsShared.version,
      courses: coursesShared.version,
      lpItems: lpShared.version,
      operations: operationsShared.version,
      renewals: renewalsShared.version,
      payroll: payrollShared.version,
      messages: messagesShared.version,
      files: filesShared.version,
      audit: auditShared.version,
      rules: rulesShared.version,
      dataSnapshot: dataSnapshotShared.version,
    };
    remoteHandlersRef.current = {
      students: studentsShared.applyRemote as (row: RemoteStateRow) => void,
      teachers: teachersShared.applyRemote as (row: RemoteStateRow) => void,
      tasks: tasksShared.applyRemote as (row: RemoteStateRow) => void,
      bookings: bookingsShared.applyRemote as (row: RemoteStateRow) => void,
      courses: coursesShared.applyRemote as (row: RemoteStateRow) => void,
      lpItems: lpShared.applyRemote as (row: RemoteStateRow) => void,
      operations: operationsShared.applyRemote as (row: RemoteStateRow) => void,
      renewals: renewalsShared.applyRemote as (row: RemoteStateRow) => void,
      payroll: payrollShared.applyRemote as (row: RemoteStateRow) => void,
      messages: messagesShared.applyRemote as (row: RemoteStateRow) => void,
      files: filesShared.applyRemote as (row: RemoteStateRow) => void,
      audit: auditShared.applyRemote as (row: RemoteStateRow) => void,
      rules: rulesShared.applyRemote as (row: RemoteStateRow) => void,
      dataSnapshot: dataSnapshotShared.applyRemote as (row: RemoteStateRow) => void,
    };
  }, [auditShared.applyRemote, auditShared.version, bookingsShared.applyRemote, bookingsShared.version, coursesShared.applyRemote, coursesShared.version, dataSnapshotShared.applyRemote, dataSnapshotShared.version, filesShared.applyRemote, filesShared.version, lpShared.applyRemote, lpShared.version, messagesShared.applyRemote, messagesShared.version, operationsShared.applyRemote, operationsShared.version, payrollShared.applyRemote, payrollShared.version, renewalsShared.applyRemote, renewalsShared.version, rulesShared.applyRemote, rulesShared.version, studentsShared.applyRemote, studentsShared.version, tasksShared.applyRemote, tasksShared.version, teachersShared.applyRemote, teachersShared.version]);

  useEffect(() => {
    let stopped = false;
    const poller = createSharedStatePoller({
      canRun: () => !document.hidden,
      onError: (error) => {
        clearManagedExamProjection();
        clearManagedTrialPaymentProjection();
        reportSharedSync(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : "同步暂时不可用");
      },
      run: async (signal) => {
        const { response: versionResponse, body: receivedVersions } = await fetchJsonWithTimeout(fetch, "/api/app-state?mode=versions", { cache: "no-store", signal });
        const versionBody = receivedVersions ?? {};
        if (!versionResponse.ok) throw new Error(versionBody.error || "共享状态检查失败");
        if (!Array.isArray(versionBody.versions)) throw new Error("共享状态版本响应无效");
        const versionRows = versionBody.versions as RemoteStateRow[];
        const advertisedManagedExamVersions = parseManagedExamAuthorityVersions(versionRows);
        const currentManagedExamVersions = {
          students: getCurrentStudentsVersion(),
          tasks: getCurrentTasksVersion(),
        };
        if (!managedExamSnapshotCanReplace(
          { versions: advertisedManagedExamVersions, students: [] },
          currentManagedExamVersions,
        )) throw new Error("考试提醒权威版本发生回退");
        const advertisedManagedTrialPaymentVersions = parseManagedTrialPaymentAuthorityVersions(versionRows);
        const currentManagedTrialPaymentVersions = {
          bookings: getCurrentBookingsVersion(),
          students: getCurrentStudentsVersion(),
          lpItems: getCurrentLpItemsVersion(),
          tasks: getCurrentTasksVersion(),
        };
        if (!managedTrialPaymentSnapshotCanReplace(
          { versions: advertisedManagedTrialPaymentVersions, students: [] },
          currentManagedTrialPaymentVersions,
        )) throw new Error("试听收费提醒权威版本发生回退");
        const changed = versionRows
          .filter((row) => row.version > (sharedVersionsRef.current[row.entity] ?? 0))
          .map((row) => row.entity)
          .filter((entity) => Boolean(remoteHandlersRef.current[entity]));

        const authorityChanged = changed.some((entity) => (MANAGED_EXAM_AUTHORITY_ENTITIES as readonly string[]).includes(entity));
        const refreshManagedExamSnapshot = managedExamRefreshRequiredRef.current
          || authorityChanged
          || !managedExamSnapshotIsCurrent(managedExamProjectionRef.current, currentManagedExamVersions)
          || !managedExamSnapshotIsCurrent(managedExamProjectionRef.current, advertisedManagedExamVersions);
        const trialPaymentAuthorityChanged = changed.some((entity) =>
          (MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES as readonly string[]).includes(entity));
        const refreshManagedTrialPaymentSnapshot = managedTrialPaymentRefreshRequiredRef.current
          || trialPaymentAuthorityChanged
          || !managedTrialPaymentSnapshotIsCurrent(
            managedTrialPaymentProjectionRef.current,
            currentManagedTrialPaymentVersions,
          )
          || !managedTrialPaymentSnapshotIsCurrent(
            managedTrialPaymentProjectionRef.current,
            advertisedManagedTrialPaymentVersions,
          );
        const requestedEntities = new Set(changed);
        if (refreshManagedExamSnapshot) {
          MANAGED_EXAM_AUTHORITY_ENTITIES.forEach((entity) => requestedEntities.add(entity));
        }
        if (refreshManagedTrialPaymentSnapshot) {
          MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES.forEach((entity) => requestedEntities.add(entity));
        }

        if (requestedEntities.size && !stopped) {
          const query = new URLSearchParams({ entities: [...requestedEntities].join(",") });
          if (refreshManagedExamSnapshot) query.set("includeManagedExamSnapshot", "1");
          if (refreshManagedTrialPaymentSnapshot) query.set("includeManagedTrialPaymentSnapshot", "1");
          const { response: stateResponse, body: receivedState } = await fetchJsonWithTimeout(fetch, `/api/app-state?${query.toString()}`, { cache: "no-store", signal });
          const stateBody = receivedState ?? {};
          if (!stateResponse.ok) throw new Error(stateBody.error || "共享资料刷新失败");
          if (!Array.isArray(stateBody.rows)) throw new Error("共享资料刷新响应无效");
          const responseRows = stateBody.rows as RemoteStateRow[];
          let nextManagedExamSnapshot: ManagedExamProjectionSnapshot | null = null;
          let nextManagedTrialPaymentSnapshot: ManagedTrialPaymentProjectionSnapshot | null = null;
          if (refreshManagedExamSnapshot) {
            const authorityVersions = parseManagedExamAuthorityVersions(responseRows);
            nextManagedExamSnapshot = parseManagedExamProjectionSnapshot(
              stateBody.managedExamSnapshot,
              authorityVersions,
            );
            const latestClientVersions = {
              students: getCurrentStudentsVersion(),
              tasks: getCurrentTasksVersion(),
            };
            if (!managedExamSnapshotIsCurrent(nextManagedExamSnapshot, advertisedManagedExamVersions)) {
              throw new Error("考试提醒刷新快照与版本探针不一致");
            }
            if (!managedExamSnapshotCanReplace(nextManagedExamSnapshot, latestClientVersions)) {
              throw new Error("考试提醒刷新快照已过期");
            }
          }
          if (refreshManagedTrialPaymentSnapshot) {
            const authorityVersions = parseManagedTrialPaymentAuthorityVersions(responseRows);
            nextManagedTrialPaymentSnapshot = parseManagedTrialPaymentProjectionSnapshot(
              stateBody.managedTrialPaymentSnapshot,
              authorityVersions,
            );
            const latestClientVersions = {
              bookings: getCurrentBookingsVersion(),
              students: getCurrentStudentsVersion(),
              lpItems: getCurrentLpItemsVersion(),
              tasks: getCurrentTasksVersion(),
            };
            if (!managedTrialPaymentSnapshotIsCurrent(
              nextManagedTrialPaymentSnapshot,
              advertisedManagedTrialPaymentVersions,
            )) {
              throw new Error("试听收费提醒刷新快照与版本探针不一致");
            }
            if (!managedTrialPaymentSnapshotCanReplace(nextManagedTrialPaymentSnapshot, latestClientVersions)) {
              throw new Error("试听收费提醒刷新快照已过期");
            }
          }
          responseRows.forEach((row) => remoteHandlersRef.current[row.entity]?.(row));
          if (nextManagedExamSnapshot) replaceManagedExamProjection(nextManagedExamSnapshot);
          if (nextManagedTrialPaymentSnapshot) {
            replaceManagedTrialPaymentProjection(nextManagedTrialPaymentSnapshot);
          }
        } else if (!stopped && navigator.onLine) {
          reportSharedSync("synced", "已同步");
        }
      },
    });
    const wake = () => { void poller.wake(); };
    const onVisible = () => { if (!document.hidden) wake(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    wake();
    return () => {
      stopped = true;
      poller.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [
    clearManagedExamProjection,
    clearManagedTrialPaymentProjection,
    getCurrentBookingsVersion,
    getCurrentLpItemsVersion,
    getCurrentStudentsVersion,
    getCurrentTasksVersion,
    replaceManagedExamProjection,
    replaceManagedTrialPaymentProjection,
    reportSharedSync,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const hasBlockingOverlay = Boolean(modal || confirmRequest || globalSearchOpen || displayPreferencesOpen || mobileMenuOpen);
        if (!hasBlockingOverlay && !((modal === "exam" && examSubmissionBusy) || (modal === "legacyTaskDeadline" && legacyTaskDeadlineBusy))) openGlobalSearch();
        return;
      }
      if (event.key === "Escape") {
        if (confirmRequest) {
          if (!confirmBusy) setConfirmRequest(null);
          return;
        }
        if (globalSearchOpen) { closeGlobalSearch(); return; }
        if (displayPreferencesOpen) { setDisplayPreferencesOpen(false); return; }
        if (mobileMenuOpen) { setMobileMenuOpen(false); return; }
        if (modal) {
          if ((modal === "exam" && examSubmissionBusy) || (modal === "lessonPackage" && lessonPackageBusy) || (modal === "legacyTaskDeadline" && legacyTaskDeadlineBusy)) return;
          setModal(null);
          return;
        }
        if (mobilePreview) { setMobilePreview(null); return; }
        setOperatorMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeGlobalSearch, confirmBusy, confirmRequest, displayPreferencesOpen, examSubmissionBusy, lessonPackageBusy, globalSearchOpen, legacyTaskDeadlineBusy, mobileMenuOpen, mobilePreview, modal, openGlobalSearch]);

  useLayoutEffect(() => {
    const overlayOpen = Boolean(modal || confirmRequest || globalSearchOpen || displayPreferencesOpen || mobileMenuOpen);
    if (!overlayOpen) return;

    // Keep the launcher separately because overlays move focus after the
    // commit. Text fields are preferred only on desktop/fine-pointer devices;
    // phones start on the dialog's close control so opening a sheet never
    // summons the software keyboard unexpectedly.
    const overlayFocusOrigin = globalSearchOpen ? null : overlayFocusOriginRef.current;
    const focusOrigin = globalSearchOpen
      ? document.querySelector<HTMLElement>("[data-global-search-origin='true']")
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      : overlayFocusOrigin?.element
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousOverflow = document.body.style.overflow;
    const inertTargets = [
      document.querySelector<HTMLElement>(".sidebar"),
      document.querySelector<HTMLElement>(".main-stage"),
      document.querySelector<HTMLElement>(".mobile-bottom-nav"),
    ].filter((target): target is HTMLElement => Boolean(target));
    inertTargets.forEach((target) => { target.inert = true; });
    document.body.style.overflow = "hidden";

    const visibleSurface = () => {
      const prioritySelectors = [
        ".confirm-backdrop [aria-modal='true']",
        ".global-search-backdrop [aria-modal='true']",
        ".display-preferences-backdrop [aria-modal='true']",
        ".mobile-nav-backdrop [aria-modal='true']",
      ];
      for (const selector of prioritySelectors) {
        const surface = document.querySelector<HTMLElement>(selector);
        if (surface?.getClientRects().length) return surface;
      }
      return Array.from(document.querySelectorAll<HTMLElement>("[aria-modal='true']"))
        .filter((surface) => surface.getClientRects().length > 0)
        .at(-1) ?? null;
    };
    const focusableElements = (surface: HTMLElement) => Array.from(surface.querySelectorAll<HTMLElement>(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])",
    )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
    const isRestorableFocusOrigin = (element: HTMLElement | null): element is HTMLElement => Boolean(
      element
      && element !== document.body
      && element !== document.documentElement
      && element.isConnected
      && element.getClientRects().length > 0
      && !element.matches(":disabled, [aria-hidden='true']")
      && !element.closest("[inert], [aria-hidden='true']"),
    );

    const focusFrame = window.requestAnimationFrame(() => {
      const surface = visibleSurface();
      if (!surface || surface.contains(document.activeElement)) return;
      const prefersTextInput = window.matchMedia("(min-width: 761px) and (pointer: fine)").matches;
      const preferred = prefersTextInput
        ? surface.querySelector<HTMLElement>("[data-dialog-autofocus='true']")
        : null;
      (preferred ?? focusableElements(surface)[0] ?? surface).focus({ preventScroll: true });
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const surface = visibleSurface();
      if (!surface) return;
      const focusable = focusableElements(surface);
      if (!focusable.length) {
        event.preventDefault();
        surface.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!surface.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      inertTargets.forEach((target) => { target.inert = false; });
      document.body.style.overflow = previousOverflow;
      // Inert has already been removed. Generic dialogs schedule restoration
      // in a microtask so React can detach the closing surface first without
      // waiting for a background-throttled animation frame.
      const restoreFocus = () => {
        if (document.querySelector("[aria-modal='true']")) return;
        if (overlayFocusOriginRef.current === overlayFocusOrigin) overlayFocusOriginRef.current = null;
        const originStillMatches = !overlayFocusOrigin
          || overlayFocusOrigin.signature === globalSearchOriginSignature(overlayFocusOrigin.element);
        if (!isRestorableFocusOrigin(focusOrigin)
          || !originStillMatches
          || (focusOrigin?.hasAttribute("data-global-search-origin") && !isCurrentGlobalSearchOrigin(focusOrigin))) {
          const mainContent = document.querySelector<HTMLElement>("#main-content");
          if (isRestorableFocusOrigin(mainContent)) mainContent.focus({ preventScroll: true });
          return;
        }
        focusOrigin.focus({ preventScroll: true });
      };
      if (overlayFocusOrigin) {
        queueMicrotask(restoreFocus);
      } else {
        restoreFocus();
      }
    };
  }, [confirmRequest, displayPreferencesOpen, globalSearchOpen, mobileMenuOpen, modal]);

  useEffect(() => {
    if (!operatorMenuOpen) return;
    const closeOperatorMenu = (event: MouseEvent) => {
      if (!operatorMenuRef.current?.contains(event.target as Node)) setOperatorMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOperatorMenu);
    return () => document.removeEventListener("mousedown", closeOperatorMenu);
  }, [operatorMenuOpen]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active]);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const frame = window.requestAnimationFrame(() => setScheduleMode("agenda"));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const studentListSource = studentView === "archived" ? scopedArchivedStudents : scopedStudents;
  const filteredStudents = useMemo(() => sortStudentsByName(studentListSource.filter((student) => {
    const haystack = `${student.name} ${student.course} ${student.grade ?? ""} ${student.location ?? ""} ${student.owner} ${student.planner ?? ""} ${student.teacher}`.toLowerCase();
    const matchesSearch = haystack.includes(search.trim().toLowerCase());
    if (!matchesSearch || !matchesOperationsOwnerFilter(studentOwner, student.owner)) return false;
    if (studentView === "mine") return isTeacherView || student.owner === currentOperator;
    if (studentView === "trial") return student.segment === "试听" || student.status === "在读 + 加课待排";
    if (studentView === "enrolled") return student.segment === "已报名" && isActiveStudent(student);
    if (studentView === "lp") return requiresLp(student);
    if (studentView === "renewal") return student.status === "活跃 + 无课时" || student.status === "活跃 + 有课时";
    if (studentView === "paused") return student.status === "不活跃 + 有课时" || student.status === "不活跃 + 无课时";
    if (studentView === "archived") return student.importArchived === true;
    return true;
  }), studentNameSort), [currentOperator, isTeacherView, search, studentListSource, studentNameSort, studentOwner, studentView]);

  const pageSize = 12;
  const safeStudentPage = Math.min(studentPage, Math.max(1, Math.ceil(filteredStudents.length / pageSize)));
  const pagedStudents = filteredStudents.slice((safeStudentPage - 1) * pageSize, safeStudentPage * pageSize);
  // Booking course labels are fine-grained and are not an authority mapping to
  // Tencent's 23 teacher subject sheets.  Matching therefore requires an
  // explicit sheet category and never derives a percentage from course text.
  const teacherSubjectMatch = (teacher: Teacher) =>
    teacherSubject !== "all" && teacher.subjects.includes(teacherSubject);
  const teacherSchedulingReadiness = (teacher: Teacher) => projectTeacherSchedulingReadiness({
    teacherId: teacher.id,
    availabilityWindows: teacher.availabilityWindows,
    availabilitySourceText: teacher.availabilitySourceText,
    newStudentCapacity: teacher.newStudentCapacity,
    capacitySourceText: teacher.capacitySourceText,
    acceptsStudents: teacher.acceptsStudents,
    now: new Date(),
  });
  const filteredTeachers = recordTeachers.filter((teacher) => {
    const matchesSearch = `${teacher.name} ${teacher.subjects.join(" ")} ${teacher.subjectDetail ?? ""} ${teacher.location ?? ""} ${teacher.timezone}`.toLowerCase().includes(teacherQuery.trim().toLowerCase());
    if (!matchesSearch || (teacherSubject !== "all" && !teacher.subjects.includes(teacherSubject))) return false;
    if (teacherDay !== "all" && !(teacher.availabilityWindows ?? []).some((window) => window.day === Number(teacherDay))) return false;
    const readiness = teacherSchedulingReadiness(teacher);
    if (teacherView === "available") return readiness.readyForNewStudentMatching;
    if (teacherView === "capacity") return readiness.capacity.status === "ready" && (readiness.capacity.remaining ?? 0) > 0;
    if (teacherView === "matched") return teacherSubjectMatch(teacher);
    if (teacherView === "review") return readiness.reviewReasons.length > 0;
    return true;
  }).sort((a, b) => Number(teacherSubjectMatch(b)) - Number(teacherSubjectMatch(a)) || a.name.localeCompare(b.name));
  const teacherPageSize = 8;
  const safeTeacherPage = Math.min(teacherPage, Math.max(1, Math.ceil(filteredTeachers.length / teacherPageSize)));
  const pagedTeachers = filteredTeachers.slice((safeTeacherPage - 1) * teacherPageSize, safeTeacherPage * teacherPageSize);

  const globalResults = globalQuery.trim() ? [
    ...readableScopedStudents.filter((student) => `${student.name} ${student.course}`.toLowerCase().includes(globalQuery.trim().toLowerCase())).slice(0, 6).map((student) => ({ id: student.id, type: student.importArchived ? "历史归档" : "学生", title: student.name, detail: `${student.course}${student.importArchived ? " · 历史归档" : ""}`, action: () => closeGlobalSearch(() => goToStudent(student.id)) })),
    ...(!isTeacherView ? recordTeachers.filter((teacher) => `${teacher.name} ${teacher.subjects.join(" ")}`.toLowerCase().includes(globalQuery.trim().toLowerCase())).slice(0, 4).map((teacher) => ({ id: teacher.id, type: "老师", title: teacher.name, detail: teacher.subjects.join("、"), action: () => closeGlobalSearch(() => { setSelectedTeacherId(teacher.id); setActive("teachers"); }) })) : []),
  ] : [];

  const goToStudent = (studentId: string, section: Section = "students") => {
    if (!readableScopedStudentIds.has(studentId)) {
      notify("当前身份无权查看该学生档案");
      return;
    }
    setSelectedStudentId(studentId);
    if (section === "students") {
      const targetStudent = studentById(studentId);
      const targetList = targetStudent?.importArchived ? scopedArchivedStudents : scopedStudents;
      const sortedIndex = sortStudentsByName(targetList, studentNameSort).findIndex((student) => student.id === studentId);
      if (sortedIndex >= 0) {
        setSearch("");
        setStudentView(targetStudent?.importArchived ? "archived" : "all");
        setStudentPage(Math.floor(sortedIndex / pageSize) + 1);
      }
    }
    setActive(section);
    if (section === "students") setMobilePreview("student");
  };

  const openStudentPreview = (studentId: string) => {
    if (!readableScopedStudentIds.has(studentId)) {
      notify("当前身份无权查看该学生档案");
      return;
    }
    setSelectedStudentId(studentId);
    setMobilePreview("student");
  };

  const openStudentRecord = (studentId: string, section: StudentRecordPanelSection) => {
    if (!openStudentBoundModal("studentRecords", studentId)) return;
    setStudentRecordKind(section);
    setMobilePreview(null);
  };

  const openCourseStudentPackage = (studentId: string) => {
    if (!coursePackageCatalogScope.activeStudentIds.has(studentId)) {
      notify("当前身份无权查看该学生课包");
      return;
    }
    openStudentRecord(studentId, "lessonPackages");
  };

  const addStudentRecord = (section: StudentRecordPanelSection) => {
    const target = studentModalTargetStudent;
    if (!target || !scopedActiveStudentIds.has(target.id)) {
      notify("当前身份暂无可操作的活跃学生");
      return;
    }
    if (isTeacherView || target.importArchived) {
      notify(target.importArchived ? "历史归档学生仅供查看" : "老师账号只能查看学生资料");
      return;
    }
    setStudentRecordKind(section);
    if (section === "report") openStudentBoundModal("studentReport", target.id);
    else if (section === "fu") openStudentBoundModal("studentEvidence", target.id);
    else if (section === "followUp") openStudentBoundModal("studentFollowUp", target.id);
    else if (section === "lessonPackages") openStudentBoundModal("lessonPackage", target.id);
    else if (section === "exams") {
      setExamDraft(null);
      openStudentBoundModal("exam", target.id);
    }
    else {
      setSelectedStudentId(target.id);
      setFileStorageMode("link");
      setModal("file");
    }
  };

  const navigateMobile = (section: Section) => {
    setActive(section);
    setMobileMenuOpen(false);
    setMobilePreview(null);
  };

  const scheduleConflict = (studentId: string, teacherId: string, date: string, start: string, duration: number, inputTimezone: string, excludeBookingId?: string) => {
    const requestedStart = zonedDateTimeToUtc(date, start, inputTimezone).getTime();
    const requestedEnd = requestedStart + duration * 60000;

    return bookings.some((booking) => {
      if (booking.id === excludeBookingId) return false;
      if (booking.studentId !== studentId && booking.teacherId !== teacherId) return false;
      return bookingOccurrencesWithinRange(booking, date, date).some((occurrence) => {
        const bookingStart = bookingInstant(occurrence).getTime();
        const bookingEnd = bookingStart + occurrence.duration * 60000;
        return requestedStart < bookingEnd && bookingStart < requestedEnd;
      });
    });
  };

  const assignTeacher = (teacher: Teacher) => {
    if (!selectedStudent) return;
    if (!teacherSubjectMatch(teacher)) {
      notify("请先选择老师可教科目，系统不会从课程名称猜测");
      return;
    }
    const beforeTeacher = selectedStudent.teacher;
    const beforeNext = selectedStudent.next;
    const beforeTone = selectedStudent.nextTone;
    setSelectedTeacherId(teacher.id);
    void studentsShared.mutateAndCommit((current) => current.map((student) => student.id === selectedStudent.id
      ? { ...student, teacher: teacher.name, next: "确认试听排课", nextTone: "amber" }
      : student))
      .then(() => {
        addAudit("选择候选老师", `${selectedStudent.name} → ${teacher.name}，等待排课确认`, "green");
        notify(`${teacher.name} 已选为候选老师`, () => {
          void studentsShared.mutateAndCommit((current) => current.map((student) => student.id === selectedStudent.id
            ? { ...student, teacher: beforeTeacher, next: beforeNext, nextTone: beforeTone }
            : student))
            .then(() => addAudit("撤销候选老师", `${selectedStudent.name}：恢复为 ${beforeTeacher}`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "候选老师保存失败"));
  };

  const updateStudentStatus = (student: Student, status: Student["status"]) => {
    if (student.status === status) return;
    const previousStatus = student.status;
    requestConfirmation({
      title: "确认修改学生状态",
      detail: `${student.name} 将从「${previousStatus}」调整为「${status}」。`,
      items: ["状态会影响低课时、续课和考试提醒范围", "不会删除学生、课表或历史记录"],
      confirmLabel: `调整为 ${status}`,
      onConfirm: async () => {
        await studentsShared.mutateAndCommit((current) => current.map((entry) => entry.id === student.id ? { ...entry, status } : entry));
        addAudit("更新学生状态", `${student.name}：${previousStatus} → ${status}`, "blue");
        notify("学生状态已更新", () => {
          void studentsShared.mutateAndCommit((current) => current.map((entry) => entry.id === student.id ? { ...entry, status: previousStatus } : entry))
            .then(() => addAudit("撤销学生状态更新", `${student.name}：${status} → ${previousStatus}`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      },
    });
  };

  const toggleTeacherAvailability = (teacher: Teacher) => {
    const nextAccepts = !teacher.acceptsStudents;
    const nextStatus = nextAccepts ? "可接新生" : "暂停接新";
    if (nextAccepts && (!Number.isSafeInteger(teacher.newStudentCapacity) || (teacher.newStudentCapacity ?? 0) <= 0)) {
      notify("请先录入大于 0 的可接新生数量，再开放接新");
      return;
    }
    requestConfirmation({
      title: nextAccepts ? "确认开放接新" : "确认暂停接新",
      detail: `${teacher.name} 的接新状态将改为「${nextStatus}」。`,
      items: [nextAccepts ? "该老师会重新进入可接新老师筛选" : "该老师将不再用于新的试听排课", "既有排课不会改变"],
      confirmLabel: nextStatus,
      onConfirm: async () => {
        await teachersShared.mutateAndCommit((current) => current.map((entry) => entry.id === teacher.id ? { ...entry, acceptsStudents: nextAccepts, availabilityStatus: nextStatus } : entry));
        addAudit("更新老师接新状态", `${teacher.name}：${nextStatus}`, "blue");
        notify("老师接新状态已更新", () => {
          void teachersShared.mutateAndCommit((current) => current.map((entry) => entry.id === teacher.id ? { ...entry, acceptsStudents: teacher.acceptsStudents, availabilityStatus: teacher.availabilityStatus } : entry))
            .then(() => addAudit("撤销老师接新状态更新", `${teacher.name}：恢复原状态`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      },
    });
  };

  const submitTeacherCapacity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!teacherCapacityDraft) return;
    if (!isAdminView) {
      notify("可接新生数量需要管理员调整");
      return;
    }
    const data = new FormData(event.currentTarget);
    const capacity = Number(data.get("newStudentCapacity"));
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      notify("可接新生数量必须是 0 或正整数");
      return;
    }
    const previous = teacherCapacityDraft.newStudentCapacity;
    try {
      await teachersShared.mutateAndCommit((current) => current.map((teacher) => teacher.id === teacherCapacityDraft.id ? {
        ...teacher,
        newStudentCapacity: capacity,
        acceptsStudents: capacity > 0 ? teacher.acceptsStudents : false,
        availabilityStatus: capacity > 0 ? teacher.availabilityStatus : "暂停接新",
      } : teacher));
      addAudit("调整可接新生数量", `${teacherCapacityDraft.name}：${previous ?? "待录入"} → ${capacity}`, capacity === 0 ? "amber" : "blue");
      setTeacherCapacityDraft(null);
      setModal(null);
      notify("可接新生数量已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "可接新生数量保存失败");
    }
  };

  const toggleStudentSelection = (studentId: string) => {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((idValue) => idValue !== studentId) : [...current, studentId]);
  };

  const bulkAssignStudents = (owner: string) => {
    if (!selectedStudentIds.length) return;
    const targetIds = [...selectedStudentIds];
    const before = students.filter((student) => targetIds.includes(student.id)).map((student) => ({ id: student.id, owner: student.owner }));
    requestConfirmation({
      title: "确认批量分配负责人",
      detail: `将 ${targetIds.length} 位学生的负责教务改为 ${owner}。`,
      items: before.slice(0, 6).map((entry) => `${studentById(entry.id)?.name ?? entry.id}：${entry.owner} → ${owner}`),
      confirmLabel: `确认分配给 ${owner}`,
      onConfirm: async () => {
        await studentsShared.mutateAndCommit((current) => current.map((student) => targetIds.includes(student.id) ? { ...student, owner } : student));
        addAudit("批量分配学生", `${targetIds.length} 位学生 → ${owner}`, "blue");
        setSelectedStudentIds([]);
        notify(`已将 ${targetIds.length} 位学生分配给 ${owner}`, () => {
          const previousOwners = new Map(before.map((entry) => [entry.id, entry.owner]));
          void studentsShared.mutateAndCommit((current) => current.map((student) => previousOwners.has(student.id) ? { ...student, owner: previousOwners.get(student.id)! } : student))
            .then(() => addAudit("撤销批量分配学生", `${targetIds.length} 位学生恢复原负责人`, "amber"))
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      },
    });
  };

  const showLpStageView = (stage: LpStage) => {
    const stageViews: Partial<Record<LpStage, string>> = {
      "待资料": "waiting",
      "待审核": "review",
      "需修改": "revision",
      "待备课确认": "waiting",
    };
    setLpFilter((current) => {
      if (stage === "完成") return "complete";
      return current === "all" || current === "active" || current === stageViews[stage] ? current : "active";
    });
  };

  const showCommittedLpView = (lpItemId: unknown) => {
    const item = lpShared.getCurrentValue().find((entry) => entry.id === lpItemId);
    if (item) showLpStageView(item.stage);
  };

  const advanceLp = (item: LpItem) => {
    const currentIndex = lpStages.indexOf(item.stage);
    const nextStage = lpStages[Math.min(currentIndex + 1, lpStages.length - 1)];
    if (nextStage === item.stage) return;
    setLpStage(item, nextStage);
  };

  const setLpStage = (item: LpItem, stage: LpItem["stage"]) => {
    if (stage === item.stage) return;
    const previousStage = item.stage;
    requestConfirmation({
      title: stage === "完成" ? "确认完成 LP" : "确认调整 LP 阶段",
      detail: `${item.title} 将从「${previousStage}」调整为「${stage}」。`,
      items: stage === "完成" ? ["完成后会离开进行中队列", "相关提醒不会被自动删除"] : undefined,
      confirmLabel: `调整为 ${stage}`,
      onConfirm: async () => {
        const changedAt = new Date().toISOString();
        const saved = await lpShared.mutateAndCommit((current) => current.map((entry) => {
          if (entry.id !== item.id) return entry;
          const changed = changeLpStage({
            id: entry.id,
            type: entry.workflowType ?? "试听 LP",
            stage: entry.stage,
            fields: entry.fields ?? {},
            revisionNumber: entry.revisionNumber ?? 1,
            revisions: entry.revisions ?? [],
            audit: entry.stageAudit ?? [],
          }, stage, { id: id("LPA"), at: changedAt, actor: operatorLabel(sessionOperator) });
          return { ...entry, stage: changed.stage, stageAudit: [...changed.audit] };
        }));
        if (!saved.payload.some((entry) => entry.id === item.id && entry.stage === stage)) {
          throw new Error("LP 阶段已变化，请刷新后重试");
        }
        showLpStageView(stage);
        addAudit("调整 LP 阶段", `${item.title}：${previousStage} → ${stage}`, stage === "完成" ? "green" : "blue");
        notify(`LP 已调整到「${stage}」`, () => {
          const revertedAt = new Date().toISOString();
          void lpShared.mutateAndCommit((current) => current.map((entry) => {
            if (entry.id !== item.id || entry.stage !== stage) return entry;
            const reverted = changeLpStage({
              id: entry.id,
              type: entry.workflowType ?? "试听 LP",
              stage: entry.stage,
              fields: entry.fields ?? {},
              revisionNumber: entry.revisionNumber ?? 1,
              revisions: entry.revisions ?? [],
              audit: entry.stageAudit ?? [],
            }, previousStage, { id: id("LPA"), at: revertedAt, actor: operatorLabel(sessionOperator) });
            return { ...entry, stage: reverted.stage, stageAudit: [...reverted.audit] };
          }))
            .then((saved) => {
              if (!saved.payload.some((entry) => entry.id === item.id && entry.stage === previousStage)) {
                throw new Error("LP 阶段已变化，请刷新后重试");
              }
              showLpStageView(previousStage);
              addAudit("撤销 LP 阶段调整", `${item.title}：${stage} → ${previousStage}`, "amber");
            })
            .catch((error: unknown) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销失败，请重试"));
        });
      },
    });
  };

  const saveTrialLedgerFieldAtomic = async (
    item: LpItem,
    field: TrialLedgerField,
    rawValue: TrialLedgerFieldValue | undefined,
  ) => {
    const expectedValue = trialLedgerStoredValue(item, field);
    const value = normalizeTrialLedgerFieldValue(field, rawValue);
    if (Object.is(expectedValue, value)) return;
    const savingKey = `${item.id}:${field}`;
    const commandKey = crypto.randomUUID();
    setTrialLedgerSaving((current) => ({ ...current, [savingKey]: true }));
    try {
      let received: Awaited<ReturnType<typeof fetchJsonWithTimeout>> | undefined;
      let lastNetworkError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          received = await fetchJsonWithTimeout(fetch, "/api/operations/trial-ledger", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandKey,
              lpItemId: item.id,
              field,
              expectedValue: expectedValue ?? null,
              value: value ?? null,
            }),
          }, BOOKING_MUTATION_CLIENT_TIMEOUT_MS);
          break;
        } catch (error) {
          lastNetworkError = error;
        }
      }
      if (!received) throw lastNetworkError instanceof Error ? lastNetworkError : new Error("试听台账请求失败");
      const { response, body: receivedBody } = received;
      const body = (receivedBody ?? {}) as {
        error?: string;
        lpItemsRow?: RemoteStateRow<LpItem[]>;
      };
      if (!response.ok) throw new Error(body.error || "试听台账保存失败");
      if (!body.lpItemsRow) throw new Error("试听台账已确认，但没有返回权威 LP 状态");
      lpShared.applyRemote(body.lpItemsRow);
      addAudit("更新试听复盘台账", `${item.title} · ${field}`, "blue");
      notify("试听台账已保存");
    } finally {
      setTrialLedgerSaving((current) => {
        const next = { ...current };
        delete next[savingKey];
        return next;
      });
    }
  };

  const setLpResult = (item: LpItem, resultStatus: LpResultStatus | undefined) => {
    if (item.resultStatus === resultStatus) return;
    if (isTrialLedgerWorkflow(item)) {
      void saveTrialLedgerFieldAtomic(item, "resultStatus", resultStatus)
        .catch((error: unknown) => notify(error instanceof Error ? error.message : "LP 业务结果保存失败"));
      return;
    }
    const previous = item.resultStatus;
    const changedAt = new Date().toISOString();
    void lpShared.mutateAndCommit((current) => current.map((entry) => {
      if (entry.id !== item.id) return entry;
      const changed = changeLpResultStatus({
        id: entry.id,
        type: entry.workflowType ?? "试听 LP",
        stage: entry.stage,
        resultStatus: entry.resultStatus,
        fields: entry.fields ?? {},
        revisionNumber: entry.revisionNumber ?? 1,
        revisions: entry.revisions ?? [],
        audit: entry.stageAudit ?? [],
        resultAudit: entry.resultAudit ?? [],
      }, resultStatus, { id: id("LPR-AUD"), at: changedAt, actor: operatorLabel(sessionOperator) });
      return { ...entry, resultStatus: changed.resultStatus, resultAudit: [...(changed.resultAudit ?? [])] };
    }))
      .then(() => {
        addAudit("更新 LP 业务结果", `${item.title}：${previous ? lpResultStatusLabel(previous) : "未设置"} → ${resultStatus ? lpResultStatusLabel(resultStatus) : "未设置"}`, "blue");
        notify(`LP 业务结果已保存${resultStatus ? `：${lpResultStatusLabel(resultStatus)}` : ""}`);
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "LP 业务结果保存失败"));
  };

  const { applyRemote: applyBookingProjectionBookingsRemote, version: bookingProjectionBookingsVersion } = bookingsShared;
  const { version: bookingProjectionStudentsVersion } = studentsShared;
  const { version: bookingProjectionLpVersion } = lpShared;
  const { version: bookingProjectionTasksVersion } = tasksShared;
  const { applyRemote: applyBookingProjectionTeachersRemote, version: bookingProjectionTeachersVersion } = teachersShared;
  const writeBookingCapacityMutation = useCallback(async (input: {
    action: "upsert" | "delete" | "cancel_occurrence" | "update_occurrence" | "bind_classroom";
    bookingId: string;
    booking?: Booking;
    occurrenceId?: string;
    occurrence?: Readonly<{ date: string; start: string; duration: number; status: "confirmed" }>;
    classroom?: Readonly<{ meetingId: string; status: "ready" | "running" | "ended" }>;
  }) => {
    if (bookingProjectionBusyRef.current) throw new Error("上一条排课命令仍在确认，请稍后重试");
    const bookingCommand = input.booking ? {
      studentId: input.booking.studentId,
      teacherId: input.booking.teacherId,
      date: input.booking.date,
      start: input.booking.start,
      duration: input.booking.duration,
      kind: input.booking.kind,
      timezone: input.booking.timezone,
      recurring: Boolean(input.booking.recurring),
      ...(input.booking.repeatCount !== undefined ? { repeatCount: input.booking.repeatCount } : {}),
      ...(input.booking.recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays: input.booking.recurrenceIntervalDays } : {}),
      ...(input.booking.recurrenceEndDate !== undefined ? { recurrenceEndDate: input.booking.recurrenceEndDate } : {}),
      ...(input.booking.packageId ? { packageId: input.booking.packageId } : {}),
      subjectId: input.booking.course,
      teacherSubjectId: input.booking.teacherSubjectId,
    } : undefined;
    const intentValue = {
      action: input.action,
      bookingId: input.bookingId,
      ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}),
      ...(input.occurrence ? { occurrence: input.occurrence } : {}),
      ...(input.classroom ? { classroom: input.classroom } : {}),
      ...(bookingCommand ? { booking: bookingCommand } : {}),
    };
    const intent = JSON.stringify(intentValue);
    const previous = bookingProjectionCommandKeysRef.current.get(intent);
    const expectedVersions = previous?.expectedVersions ?? {
      bookings: bookingProjectionBookingsVersion,
      students: bookingProjectionStudentsVersion,
      lpItems: bookingProjectionLpVersion,
      tasks: bookingProjectionTasksVersion,
      teachers: bookingProjectionTeachersVersion,
    };
    const pending = prepareBookingProjectionPendingCommand({
      intentValue,
      expectedVersions,
      previous,
    });
    bookingProjectionCommandKeysRef.current = upsertBookingProjectionPendingCommand(
      bookingProjectionCommandKeysRef.current.values(),
      pending,
    );
    persistBookingProjectionPendingCommands(
      directEnrollmentStorage,
      sessionOperator,
      bookingProjectionCommandKeysRef.current.values(),
    );
    bookingProjectionBusyRef.current = true;
    try {
      const { response, body: receivedBody } = await bookingMutationFetch("/api/bookings/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pending.command,
      });
      const body = (receivedBody ?? {}) as Record<string, unknown>;
      if (!response.ok || body.committed !== true) {
        if (response.status === 409) {
          bookingProjectionCommandKeysRef.current = removeBookingProjectionPendingCommand(
            bookingProjectionCommandKeysRef.current.values(),
            intent,
          );
          persistBookingProjectionPendingCommands(
            directEnrollmentStorage,
            sessionOperator,
            bookingProjectionCommandKeysRef.current.values(),
          );
        }
        throw new Error(typeof body.error === "string" ? body.error : "排课保存失败，请刷新后安全重试");
      }
      if (!body.bookingRow || !body.studentRow || !body.taskRow || !body.teacherRow) {
        throw new Error("排课已确认；权威状态行暂不可用，请刷新后安全恢复");
      }
      applyBookingProjectionBookingsRemote(body.bookingRow as RemoteStateRow<Booking[]>);
      applyStudentsRemote(body.studentRow as RemoteStateRow<Student[]>);
      applyTasksRemote(body.taskRow as RemoteStateRow<Task[]>);
      applyBookingProjectionTeachersRemote(body.teacherRow as RemoteStateRow<Teacher[]>);
      bookingProjectionCommandKeysRef.current = removeBookingProjectionPendingCommand(
        bookingProjectionCommandKeysRef.current.values(),
        intent,
      );
      if (bookingProjectionCommandKeysRef.current.size) {
        persistBookingProjectionPendingCommands(
          directEnrollmentStorage,
          sessionOperator,
          bookingProjectionCommandKeysRef.current.values(),
        );
      } else {
        clearBookingProjectionPendingCommands(directEnrollmentStorage, sessionOperator);
      }
      return body as {
        action: "create" | "update" | "delete";
        requestedAction?: "upsert" | "delete" | "cancel_occurrence" | "update_occurrence" | "bind_classroom";
        applied: boolean;
        bookingId: string;
        bookingRow: RemoteStateRow<Booking[]>;
        studentRow: RemoteStateRow<Student[]>;
        taskRow: RemoteStateRow<Task[]>;
        teacherRow: RemoteStateRow<Teacher[]>;
      };
    } finally {
      bookingProjectionBusyRef.current = false;
    }
  }, [
    applyBookingProjectionBookingsRemote,
    bookingProjectionBookingsVersion,
    directEnrollmentStorage,
    bookingProjectionLpVersion,
    sessionOperator,
    applyStudentsRemote,
    bookingProjectionStudentsVersion,
    applyTasksRemote,
    bookingProjectionTasksVersion,
    applyBookingProjectionTeachersRemote,
    bookingProjectionTeachersVersion,
  ]);

  const retreatLp = (item: LpItem) => {
    const currentIndex = lpStages.indexOf(item.stage);
    if (currentIndex <= 0) return;
    setLpStage(item, lpStages[currentIndex - 1]);
  };

  const openBookingEditor = (booking: Booking) => {
    if (!scopedActiveStudentIds.has(booking.studentId)) {
      notify("当前身份只能编辑当前范围的活跃学生排课。");
      return;
    }
    setBookingDraft(booking);
    setBookingPrefillTeacherId(booking.teacherId);
    setBookingFormStudentId(booking.studentId);
    setBookingFormKind(booking.kind);
    setBookingFormSubjectId(booking.course ?? studentById(booking.studentId)?.course ?? "");
    const interval = booking.recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS;
    setBookingFrequency(!booking.recurring ? "single" : interval === 1 ? "daily" : interval === 2 ? "every_other_day" : interval === LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS ? "weekly" : interval === 14 ? "biweekly" : "custom");
    setSelectedStudentId(booking.studentId);
    setSelectedTeacherId(booking.teacherId);
    setModal("booking");
  };

  const openBookingOccurrenceEditor = (booking: BookingOccurrence) => {
    if (!scopedActiveStudentIds.has(booking.studentId)) {
      notify("当前身份只能编辑当前范围的活跃学生课次。");
      return;
    }
    if (["completed", "abnormal", "leave"].includes(booking.occurrenceStatus)) {
      notify("已完成、异常或请假课次必须使用对应的结算/异常流程处理");
      return;
    }
    setBookingOccurrenceDraft(booking);
    setModal("bookingOccurrence");
  };

  const submitBookingOccurrence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bookingOccurrenceDraft) return;
    if (!scopedActiveStudentIds.has(bookingOccurrenceDraft.studentId)) {
      notify("当前身份只能修改当前范围的活跃学生课次。");
      return;
    }
    const data = new FormData(event.currentTarget);
    const date = String(data.get("date") ?? "");
    const start = String(data.get("start") ?? "");
    const duration = Number(data.get("duration") ?? 60);
    const teacherId = bookingOccurrenceDraft.teacherId;
    const status = String(data.get("status") ?? bookingOccurrenceDraft.occurrenceStatus) as LessonOccurrenceStatus;
    if (status !== "confirmed" && status !== "cancelled") {
      notify("请使用结算、异常或请假流程更新本节状态");
      return;
    }
    if (!date || !start || !teacherById(teacherId) || !isLessonDuration(duration)) {
      notify("请填写有效的日期、时间、时长和老师");
      return;
    }
    if (status !== "cancelled") {
      const conflict = scheduleConflict(
        bookingOccurrenceDraft.studentId,
        teacherId,
        date,
        start,
        duration,
        bookingOccurrenceDraft.timezone,
        bookingOccurrenceDraft.id,
      );
      if (conflict) {
        notify("该时段的学生或老师已有课程");
        return;
      }
      const teacher = teacherById(teacherId)!;
      if (!teacherAvailableAt(teacher, date, start, duration, bookingOccurrenceDraft.timezone)) {
        notify(`${teacher.name} 在该时段没有已确认的月度 AVA`);
        return;
      }
    }
    try {
      const singleLesson = bookingOccurrenceDraft.recurring !== true
        || bookingOccurrenceDraft.repeatCount === 1;
      if (status === "cancelled") {
        await writeBookingCapacityMutation({
          action: singleLesson ? "delete" : "cancel_occurrence",
          bookingId: bookingOccurrenceDraft.id,
          ...(!singleLesson ? { occurrenceId: bookingOccurrenceDraft.occurrenceKey } : {}),
        });
        addAudit(
          singleLesson ? "取消单次课程" : "取消周期课次",
          `${studentById(bookingOccurrenceDraft.studentId)?.name ?? bookingOccurrenceDraft.studentId} · ${bookingOccurrenceDraft.occurrenceKey} · 已原子重算容量与任务`,
          "amber",
        );
        if (singleLesson) setSelectedBookingId(bookings.find((booking) => booking.id !== bookingOccurrenceDraft.id)?.id ?? "");
        setSelectedBookingDate(null);
        setSelectedBookingDateId(null);
        setSelectedBookingOccurrenceKey(null);
        setSelectedBookingSourceDate(null);
        setBookingOccurrenceDraft(null);
        setModal(null);
        notify(singleLesson ? "单次课程已取消，相关容量与任务已原子更新" : "本节周期课已取消，其他课次不受影响");
        return;
      }
      await writeBookingCapacityMutation({
        action: "update_occurrence",
        bookingId: bookingOccurrenceDraft.id,
        occurrenceId: bookingOccurrenceDraft.occurrenceKey,
        occurrence: { date, start, duration, status: "confirmed" },
      });
      addAudit("修改单节课程", `${studentById(bookingOccurrenceDraft.studentId)?.name ?? bookingOccurrenceDraft.studentId} · ${bookingOccurrenceDraft.occurrenceKey} · ${date} ${start} · confirmed`, "blue");
      setBookingOccurrenceDraft(null);
      setModal(null);
      notify("本节课程已原子更新，其他周期课不受影响");
    } catch (error) {
      notify(error instanceof Error ? error.message : "本节课程修改失败");
    }
  };

  const openNewBooking = (studentId?: string, teacherId?: string) => {
    const requestedStudentId = typeof studentId === "string" ? studentId.trim() : "";
    const targetStudentId = requestedStudentId || selectedScopedActiveStudent?.id;
    if (!targetStudentId || !coursePackageCatalogScope.activeStudentIds.has(targetStudentId)) {
      const requestedStudent = requestedStudentId ? studentById(requestedStudentId) : undefined;
      notify(requestedStudent?.importArchived ? "历史归档学生不能新建排课" : "当前身份暂无可操作的活跃学生");
      return;
    }
    const bookingStudent = studentById(targetStudentId);
    if (!bookingStudent || bookingStudent.importArchived === true) {
      notify(bookingStudent?.importArchived ? "历史归档学生不能新建排课" : "当前身份暂无可操作的活跃学生");
      return;
    }
    setBookingDraft(null);
    setBookingPrefillTeacherId(teacherId ?? null);
    setBookingFormStudentId(targetStudentId);
    setBookingFormKind("常规课");
    setBookingFormSubjectId(bookingStudent.course ?? "");
    setBookingFrequency("single");
    setModal("booking");
  };

  const openBookingOperation = (booking: Booking, type: Operation["type"]) => {
    if (!scopedActiveStudentIds.has(booking.studentId)) {
      notify("当前身份只能为当前范围的活跃学生记录课程异常。");
      return;
    }
    setSelectedStudentId(booking.studentId);
    setSelectedTeacherId(booking.teacherId);
    setOperationDraft({
      studentId: booking.studentId,
      teacherId: booking.teacherId,
      type,
      eventStart: booking.date,
      eventEnd: booking.date,
      sourceBookingId: booking.id,
      detail: `${type} · ${booking.date} ${booking.start} · ${studentById(booking.studentId)?.name ?? booking.studentId}`,
    });
    setModal("operation");
  };

  const toggleBookingSelection = (bookingId: string) => {
    setSelectedBookingIds((current) => current.includes(bookingId) ? current.filter((idValue) => idValue !== bookingId) : [...current, bookingId]);
  };

  const bulkUpdateBookingStatus = (status: Booking["status"]) => {
    if (!selectedBookingIds.length) return;
    if (status === "已完成") {
      notify("完成课程请按具体课次处理，不能整组完成周期课");
      return;
    }
    const targetIds = [...selectedBookingIds];
    const before = bookings.filter((booking) => targetIds.includes(booking.id)).map((booking) => ({ id: booking.id, status: booking.status }));
    requestConfirmation({
      title: "确认批量更新课程系列",
      detail: `${targetIds.length} 个课程系列将统一改为「${status}」。周期课会整组更新。`,
      confirmLabel: `整组设为${status}`,
      tone: "primary",
      onConfirm: () => {
        setBookings((current) => current.map((booking) => targetIds.includes(booking.id) ? { ...booking, status } : booking));
        addAudit("批量更新课程", `${targetIds.length} 个课程系列 → ${status}`, "blue");
        setSelectedBookingIds([]);
        notify(`已更新 ${targetIds.length} 个课程系列`, () => {
          const previous = new Map(before.map((entry) => [entry.id, entry.status]));
          setBookings((current) => current.map((booking) => previous.has(booking.id) ? { ...booking, status: previous.get(booking.id)! } : booking));
          addAudit("撤销批量更新课程", `${targetIds.length} 个课程系列恢复原状态`, "amber");
        });
      },
    });
  };

  const confirmBookingStatus = (booking: Booking, status: Booking["status"]) => {
    if (booking.status === status) return;
    if (status === "已完成") {
      notify("完成课程必须按具体课次结算，不能直接修改系列状态");
      return;
    }
    const previousStatus = booking.status;
    const student = studentById(booking.studentId);
    requestConfirmation({
      title: "确认课程状态",
      detail: `${student?.name ?? booking.studentId} · ${booking.date} ${booking.start} 将从「${previousStatus}」调整为「${status}」。`,
      items: ["不会修改上课时间或在线教室链接"],
      confirmLabel: `调整为 ${status}`,
      tone: "primary",
      onConfirm: () => {
        setBookings((current) => current.map((entry) => entry.id === booking.id ? { ...entry, status } : entry));
        addAudit("更新课程状态", `${student?.name ?? booking.studentId}：${previousStatus} → ${status}`, "blue");
        notify("课程状态已更新", () => {
          setBookings((current) => current.map((entry) => entry.id === booking.id ? { ...entry, status: previousStatus } : entry));
          addAudit("撤销课程状态更新", `${student?.name ?? booking.studentId}：${status} → ${previousStatus}`, "amber");
        });
      },
    });
  };

  const deleteBookingSeries = (booking: Booking) => {
    if (isTeacherView) {
      notify("老师账号不能删除排课，请联系负责教务处理");
      return;
    }
    const student = studentById(booking.studentId);
    requestConfirmation({
      title: booking.recurring ? "确认删除整个课程系列" : "确认删除课程",
      detail: `${student?.name ?? booking.studentId} · ${booking.date} ${booking.start}`,
      items: booking.recurring ? ["整个周期课程系列都会删除", "已完成的试听提醒会保留，未完成提醒会关闭"] : ["未完成的试听提醒会同时关闭"],
      confirmLabel: booking.recurring ? "删除整个系列" : "删除课程",
      tone: "danger",
      onConfirm: async () => {
        await writeBookingCapacityMutation({ action: "delete", bookingId: booking.id });
        addAudit("删除排课", `${student?.name ?? booking.studentId} · ${booking.recurring ? "整个系列" : "单次课程"}`, "amber");
        setSelectedBookingId(bookings.find((entry) => entry.id !== booking.id)?.id ?? "");
        setSelectedBookingDate(null);
        setSelectedBookingDateId(null);
        setSelectedBookingOccurrenceKey(null);
        setSelectedBookingSourceDate(null);
        notify("排课已删除");
      },
    });
  };

  const editTeacherAvailability = async (action: TeacherAvailabilityEditAction) => {
    if (!isAdminView) {
      notify("修改 AVA 需要管理员处理");
      return;
    }
    try {
      const teacher = teacherById(action.teacherId);
      if (!teacher) throw new Error("找不到老师档案");
      const windows = teacher.availabilityWindows ?? [];
      let availabilityWindows: TeacherAvailabilityWindow[];
      if (action.scope === "date") {
        availabilityWindows = editAvailabilityDate(windows, action);
      } else {
        const target = windows.find((window) => window.id === action.windowId);
        if (!target) throw new Error("找不到需要修改的 AVA 时段");
        if (action.scope === "all") {
          availabilityWindows = windows.map((window) => window.id === target.id ? {
            ...window,
            start: action.start,
            end: action.end,
            overrides: window.overrides.filter((override) => override.date !== action.date),
          } : window);
        } else {
          const weekDay = new Date(`${action.date}T12:00:00Z`).getUTCDay();
          const monday = shiftIsoDate(action.date, -((weekDay + 6) % 7));
          const sunday = shiftIsoDate(monday, 6);
          availabilityWindows = windows.map((window) => {
            if (window.id !== target.id) return window;
            const overrides = [...window.overrides.filter((entry) => entry.date < monday || entry.date > sunday)];
            for (let date = monday; date <= sunday; date = shiftIsoDate(date, 1)) {
              if (date < window.validFrom || date > window.validTo || new Date(`${date}T12:00:00Z`).getUTCDay() !== window.day) continue;
              overrides.push({ id: `${window.id}:override:${date}`, date, start: action.start, end: action.end });
            }
            return {
              ...window,
              excludedDates: window.excludedDates.filter((date) => date < monday || date > sunday),
              overrides: overrides.sort((left, right) => left.date.localeCompare(right.date)),
            };
          });
        }
        assertValidTeacherAvailability(availabilityWindows);
      }
      await teachersShared.mutateAndCommit((current) => current.map((entry) => entry.id === action.teacherId
        ? { ...entry, availabilityWindows, availabilityUpdated: `手动修改 · 今天 ${nowLabel()}` }
        : entry));
      addAudit("修改老师 AVA", `${teacher.name} · ${action.date} · ${action.scope}`, "blue");
      notify("AVA 已更新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "AVA 修改失败");
    }
  };

  const deleteTeacherAvailability = (action: TeacherAvailabilityAction) => {
    if (!isAdminView) {
      notify("删除 AVA 需要管理员处理");
      return;
    }
    const teacher = teacherById(action.teacherId);
    if (!teacher) return;
    let availabilityWindows: TeacherAvailabilityWindow[];
    try {
      const windows = teacher.availabilityWindows ?? [];
      availabilityWindows = action.scope === "date"
        ? deleteAvailabilityDate(windows, action)
        : action.scope === "week"
          ? deleteAvailabilityWeek(windows, { teacherId: action.teacherId, weekOf: action.date })
          : deleteAllTeacherAvailability(windows, action.teacherId);
    } catch (error) {
      notify(error instanceof Error ? error.message : "AVA 删除失败");
      return;
    }
    requestConfirmation({
      title: "确认删除 AVA",
      detail: `${teacher.name} · ${action.date}`,
      items: ["不会删除已经排好的课程"],
      confirmLabel: "删除",
      tone: "danger",
      onConfirm: async () => {
        await teachersShared.mutateAndCommit((current) => current.map((entry) => entry.id === action.teacherId
          ? { ...entry, availabilityWindows, availabilityUpdated: `手动修改 · 今天 ${nowLabel()}` }
          : entry));
        addAudit("删除老师 AVA", `${teacher.name} · ${action.date} · ${action.scope}`, "amber");
        notify("AVA 已删除");
      },
    });
  };

  const promoteLegacyTeacherAvailability = (teacherId: string, month: string) => {
    if (!isAdminView) {
      notify("采用旧 AVA 需要管理员处理");
      return;
    }
    const teacher = teacherById(teacherId);
    if (!teacher) {
      notify("找不到老师档案");
      return;
    }
    const legacySlots = teacher.availabilitySlots ?? [];
    let promoted: TeacherAvailabilityWindow[];
    try {
      const template = normalizeLegacyAvailability(
        teacher.id,
        cleanTimezone(teacher.availabilityTimezone ?? teacher.timezone),
        legacySlots as AvailabilitySlotInput[],
      );
      promoted = promoteLegacyAvailabilityForMonth(template, month);
      const rangeStart = `${month}-01`;
      const rangeEnd = promoted[0]?.validTo ?? rangeStart;
      const retained = (teacher.availabilityWindows ?? []).filter(
        (window) => window.validTo < rangeStart || window.validFrom > rangeEnd,
      );
      assertValidTeacherAvailability([...retained, ...promoted]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "旧 AVA 无法采用");
      return;
    }
    const rangeStart = `${month}-01`;
    const rangeEnd = promoted[0]?.validTo ?? rangeStart;
    requestConfirmation({
      title: "确认采用旧 AVA",
      detail: `${teacher.name} · ${month} · ${legacySlots.length} 个固定时段`,
      items: ["只写入所选月份", "其他月份 AVA 保持不变"],
      confirmLabel: "采用到该月",
      onConfirm: async () => {
        await teachersShared.mutateAndCommit((current) => current.map((entry) => {
          if (entry.id !== teacherId) return entry;
          const retained = (entry.availabilityWindows ?? []).filter(
            (window) => window.validTo < rangeStart || window.validFrom > rangeEnd,
          );
          return {
            ...entry,
            availabilityWindows: [...retained, ...promoted],
            availabilityUpdated: `旧 AVA 已确认 · ${month}`,
          };
        }));
        addAudit("采用旧 AVA", `${teacher.name} · ${month} · ${legacySlots.length} 个固定时段`, "amber");
        notify("旧 AVA 已写入所选月份");
      },
    });
  };

  const reviewTeacherAvailabilitySubmission = async (
    submission: TeacherAvailabilitySubmission,
    decision: "approved" | "rejected",
  ) => {
    if (!canUseAdminScope || teacherAvailabilityReviewBusy) return;
    setTeacherAvailabilityReviewBusy(submission.id);
    setTeacherAvailabilityReviewError("");
    try {
      const response = await fetch("/api/teacher-availability/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: Number(submission.id),
          decision,
          expectedTeacherVersion: teacherAvailabilityReviewVersion,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.teacherRow) {
        throw new Error(body.error || "AVA 审批失败");
      }
      teachersShared.applyRemote(body.teacherRow as RemoteStateRow<Teacher[]>);
      setTeacherAvailabilityReviewVersion(body.teacherRow.version);
      setTeacherAvailabilitySubmissions((current) => current.filter(
        ({ submission: item }) => item.id !== submission.id,
      ));
      notify(decision === "approved" ? "AVA 已通过并写入老师档案" : "AVA 已拒绝");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AVA 审批失败";
      setTeacherAvailabilityReviewError(message);
      notify(message);
    } finally {
      setTeacherAvailabilityReviewBusy(null);
    }
  };

  const recordMessage = (messageOrEvent?: Message | React.MouseEvent<HTMLButtonElement>) => {
    const visibleMessages = scopedMessages.filter((entry) => {
      const matchesQuery = `${entry.kind} ${entry.recipient} ${studentById(entry.studentId)?.name ?? ""}`.toLowerCase().includes(messageQuery.trim().toLowerCase());
      if (!matchesQuery) return false;
      if (messageFilter === "open") return entry.status !== "已记录发送";
      if (messageFilter === "confirm") return entry.status === "待人工确认";
      if (messageFilter === "sent") return entry.status === "已记录发送";
      if (messageFilter === "internal") return entry.status === "仅内部";
      return true;
    });
    const explicitMessage = messageOrEvent && "kind" in messageOrEvent ? messageOrEvent : undefined;
    const message = explicitMessage ?? visibleMessages.find((entry) => entry.id === selectedMessageState?.id) ?? visibleMessages[0];
    if (!message) return;
    if (message.status === "已记录发送") return;
    if (!scopedActiveStudentIds.has(message.studentId)) {
      notify("关联学生已不在当前活跃范围，不能修改消息记录");
      return;
    }
    const recipient = message.recipient.trim();
    if (!recipient || /待关联|待确认|未知/.test(recipient)) {
      notify("收件对象尚未映射，不能记录为已发送");
      return;
    }
    requestConfirmation({
      title: "确认记录为已发送",
      detail: `${message.kind} → ${recipient}`,
      items: ["系统不会实际发送企业微信消息", "此操作只记录人工已经完成发送"],
      confirmLabel: "确认已人工发送",
      onConfirm: async () => {
        try {
          await messagesShared.mutateAndCommit((current) => current.map((entry) => entry.id === message.id ? { ...entry, status: "已记录发送" } : entry));
          addAudit("记录消息发送", `${message.kind} → ${recipient}`, "green");
          notify("已记录为人工发送", () => {
            void messagesShared.mutateAndCommit((current) => current.map((entry) => entry.id === message.id ? { ...entry, status: message.status } : entry))
              .then(() => addAudit("撤销消息发送记录", `${message.kind} → ${recipient}`, "amber"))
              .catch((error) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销消息发送记录失败"));
          });
        } catch (error) {
          notify(error instanceof Error ? `消息发送记录保存失败：${error.message}` : "消息发送记录保存失败");
        }
      },
    });
  };

  const resetDemo = () => {
    requestConfirmation({
      title: "重新载入共享资料",
      detail: rulesDraftTouched
        ? "当前规则草稿尚未保存，重新载入后会丢失。"
        : "页面会重新读取 Supabase 中最近保存的共享资料。",
      items: [
        "不会清空 Supabase 资料",
        "当前尚未提交的表单和筛选状态会被清除",
      ],
      confirmLabel: "重新载入",
      tone: rulesDraftTouched ? "danger" : "primary",
      onConfirm: () => window.location.reload(),
    });
  };

  const refreshSourceStatus = async () => {
    if (syncRefreshBusy) return;
    setSyncRefreshBusy(true);
    try {
      const payload = await fetchSupabaseSnapshot();
      const nextSources = Array.isArray(payload.syncSources) ? payload.syncSources : [];
      setSyncSources(nextSources);
      const nextGroups = partitionOpsSources(nextSources);
      const staleCount = nextGroups.active.filter((source) => opsSourceIsStale(source)).length;
      addAudit(
        "检查外部只读来源",
        `${nextGroups.active.length} 个当前来源 · ${nextGroups.archived.length} 个历史来源 · ${staleCount} 个超过 36 小时未读取`,
        staleCount ? "amber" : "green",
      );
      notify(staleCount
        ? `状态已刷新：${staleCount} 个当前来源数据已过期`
        : nextGroups.active.length
          ? "来源状态已刷新，页面资料没有被覆盖"
          : `状态已刷新：${nextGroups.archived.length} 个历史来源已归档，当前数据由专用导入管线维护`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "来源状态刷新失败");
    } finally {
      setSyncRefreshBusy(false);
    }
  };

  const submitStudentImportSource = async (
    sourceKind: StudentImportSourceKind,
    rawJson: string,
  ) => {
    if (studentImportSourceBusy) return;
    const meta = studentImportSourceMeta[sourceKind];
    if (!meta.sourceId.trim() || !meta.revision.trim()) {
      notify("请先填写来源 ID 和 revision");
      return;
    }
    if (new Blob([rawJson]).size > 8 * 1024 * 1024) {
      notify("来源 JSON 不能超过 8 MB");
      return;
    }
    setStudentImportSourceBusy(sourceKind);
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const normalizedRows = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && "rows" in parsed
          ? (parsed as { rows?: unknown }).rows
          : null;
      const rawJwb = sourceKind === "jwb";
      if (rawJwb && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("教务宝安全字段 JSON 必须包含 students、contracts 和 courseBalances");
      }
      if (rawJwb) {
        throw new Error("教务宝原始快照必须通过分块 staging 导入；此页面不接受一次性上传。");
      }
      if (!rawJwb && !Array.isArray(normalizedRows)) {
        throw new Error("标准 JSON 必须是 rows 数组或包含 rows 数组的对象");
      }
      const sourcePayload = rawJwb
        ? {
            ...(parsed as Record<string, unknown>),
            sourceKind: "jwb" as const,
            sourceFormat: "jiaowubao-api-v2" as const,
            sourceId: meta.sourceId.trim(),
            revision: meta.revision.trim(),
            negativeAdjustmentPolicy: studentJwbNegativePolicy,
          }
        : {
            sourceKind,
            sourceId: meta.sourceId.trim(),
            revision: meta.revision.trim(),
            rows: normalizedRows,
          };
      const response = await fetch("/api/student-import/source-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourcePayload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.source) throw new Error(body.error || "学生来源录入失败");
      const source = body.source as StudentImportSourceIngestResult;
      setStudentImportSourceStatus((current) => ({ ...current, [sourceKind]: source }));
      setStudentImportPreview(null);
      setStudentIdentityReviewCandidates(null);
      setStudentIdentityManualReview(null);
      setStudentIdentityReviewClearKey(null);
      setStudentIdentityAnnotationPreview(null);
      notify(source.unchanged ? "该 revision 内容未变化" : "来源已保存，请继续录入另一来源或重新预检");
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生来源录入失败");
    } finally {
      setStudentImportSourceBusy(null);
    }
  };

  const ingestStudentImportSourceFile = async (
    sourceKind: StudentImportSourceKind,
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || studentImportSourceBusy) return;
    if (file.size > 8 * 1024 * 1024) {
      notify("来源 JSON 不能超过 8 MB");
      return;
    }
    const rawJson = await file.text();
    setStudentImportSourceJson((current) => ({ ...current, [sourceKind]: rawJson }));
    await submitStudentImportSource(sourceKind, rawJson);
  };

  const refreshStudentIdentityReview = async (announce = true, alreadyBusy = false) => {
    if (studentIdentityLinkBusy && !alreadyBusy) return;
    if (!alreadyBusy) setStudentIdentityLinkBusy(true);
    try {
      const response = await fetch("/api/student-import/identity-links", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok
        || !Array.isArray(body.candidates)
        || !Number.isSafeInteger(body.identityLinkCount)
        || typeof body.clearKey !== "string"
        || !body.manualReview
        || !Array.isArray(body.manualReview.masters)
        || !Array.isArray(body.manualReview.jwb)
        || !Array.isArray(body.manualReview.existing)) {
        throw new Error(body.error || "学生身份审核候选读取失败");
      }
      setStudentIdentityReviewCandidates(body.candidates as StudentIdentityReviewCandidate[]);
      setStudentIdentityReviewClearKey(body.clearKey);
      const manualReview = body.manualReview as StudentIdentityManualReview;
      setStudentIdentityManualReview(manualReview);
      setStudentIdentityManualMasterToken((current) =>
        manualReview.masters.some((item) => item.token === current) ? current : "");
      setStudentIdentityManualJwbToken((current) =>
        manualReview.jwb.some((item) => item.token === current) ? current : "");
      setStudentIdentityManualExistingToken((current) =>
        manualReview.existing.some((item) => item.token === current) ? current : "");
      setStudentIdentityLinkStatus({ count: body.identityLinkCount, unchanged: true });
      if (announce) notify(`已读取 ${body.candidates.length} 条姓名候选和 ${manualReview.masters.length} 条待手工配对记录`);
    } catch (error) {
      if (announce) notify(error instanceof Error ? error.message : "学生身份审核候选读取失败");
    } finally {
      if (!alreadyBusy) setStudentIdentityLinkBusy(false);
    }
  };

  const refreshStudentIdentityAnnotationReview = async (announce = true) => {
    if (studentIdentityAnnotationBusy) return;
    setStudentIdentityAnnotationBusy(true);
    try {
      const response = await fetch("/api/student-import/identity-links/annotation", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok
        || typeof body.confirmationKey !== "string"
        || !Number.isSafeInteger(body.candidateCount)
        || !Number.isSafeInteger(body.pendingCount)
        || !Number.isSafeInteger(body.alreadyLinkedCount)
        || !Number.isSafeInteger(body.currentLinkCount)
        || !Number.isSafeInteger(body.resultingLinkCount)
        || typeof body.canSubmit !== "boolean") {
        throw new Error(body.error || "教务宝括号备注身份预检失败");
      }
      const preview = body as StudentIdentityAnnotationReviewPreview;
      setStudentIdentityAnnotationPreview(preview);
      if (announce) {
        notify(preview.candidateCount
          ? `已找到 ${preview.candidateCount} 条严格一对一的教务宝括号备注候选`
          : "当前没有可安全确认的教务宝括号备注候选");
      }
    } catch (error) {
      if (announce) notify(error instanceof Error ? error.message : "教务宝括号备注身份预检失败");
    } finally {
      setStudentIdentityAnnotationBusy(false);
    }
  };

  const confirmStudentIdentityAnnotationReview = async () => {
    const preview = studentIdentityAnnotationPreview;
    if (studentIdentityAnnotationBusy || studentImportBusy || !preview?.canSubmit) return;
    setStudentIdentityAnnotationBusy(true);
    try {
      const response = await fetch("/api/student-import/identity-links/annotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationKey: preview.confirmationKey }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Number.isSafeInteger(body.count)) {
        throw new Error(body.error || "教务宝括号备注身份审核保存失败");
      }
      setStudentIdentityLinkStatus({ count: body.count, unchanged: body.unchanged === true });
      setStudentImportPreview(null);
      setStudentIdentityAnnotationPreview(null);
      await refreshStudentIdentityReview(false);
      notify(body.unchanged
        ? "该批括号备注身份关联已保存"
        : `已保存 ${body.newlyAppliedCount} 条高置信身份关联，请重新预检正式导入`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "教务宝括号备注身份审核保存失败");
    } finally {
      setStudentIdentityAnnotationBusy(false);
    }
  };

  const requestStudentIdentityAnnotationReview = () => {
    const preview = studentIdentityAnnotationPreview;
    if (!preview?.canSubmit || studentIdentityAnnotationBusy) return;
    requestConfirmation({
      title: "确认保存教务宝括号备注身份关联",
      detail: `将保存 ${preview.pendingCount} 条严格一对一候选。`,
      items: [
        "仅接受教务宝姓名末尾一个纯英文括号备注，例如（VIC）",
        "总表姓名不能含括号；去掉备注后必须与总表完整姓名一致",
        "总表、教务宝及现有学生的去备注姓名都必须全局唯一；其余记录不会被本操作关联",
      ],
      confirmLabel: "确认保存高置信关联",
      onConfirm: confirmStudentIdentityAnnotationReview,
    });
  };

  const previewStudentImport = async () => {
    if (studentImportBusy) return;
    setStudentImportBusy(true);
    try {
      const response = await fetch("/api/student-import", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "学生导入预检失败");
      setStudentImportPreview(body as StudentImportPreview);
      const summary = (body as StudentImportPreview).summary;
      addAudit("预检学生正式导入", `新增 ${summary.insert} · 更新 ${summary.update} · 逐课包 ${summary.importedPackages} · 暂无可核对课包账本 ${summary.studentsMissingPackageData}`, summary.ambiguous || summary.studentsMissingPackageData ? "amber" : "blue");
      await refreshStudentIdentityReview(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生导入预检失败");
    } finally {
      setStudentImportBusy(false);
    }
  };

  const clearStudentIdentityLinks = async () => {
    const clearKey = studentIdentityReviewClearKey;
    if (studentIdentityLinkBusy || !clearKey) {
      if (!clearKey) notify("请先读取最新身份审核列表再清空");
      return;
    }
    setStudentIdentityLinkBusy(true);
    try {
      const response = await fetch("/api/student-import/identity-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionKey: clearKey, decision: "clear" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.count !== "number") {
        throw new Error(body.error || "旧身份链接清除失败");
      }
      setStudentImportPreview(null);
      await refreshStudentIdentityReview(false, true);
      notify(body.unchanged ? "当前链接为空；旧审核选项也已全部作废" : "身份链接已清除，旧审核选项已作废");
    } catch (error) {
      notify(error instanceof Error ? error.message : "旧身份链接清除失败");
    } finally {
      setStudentIdentityLinkBusy(false);
    }
  };

  const requestClearStudentIdentityLinks = () => {
    if (studentIdentityLinkBusy) return;
    if (!studentIdentityReviewClearKey) {
      notify("请先读取最新身份审核列表再清空");
      return;
    }
    requestConfirmation({
      title: "确认清空全部学生身份链接",
      detail: `当前已保存 ${studentIdentityLinkStatus?.count ?? 0} 条人工审核链接。`,
      items: ["清空后仅失去教务宝资料补充关联", "腾讯总表学生仍可建档；未关联的课时和课包保持为空"],
      confirmLabel: "确认清空全部链接",
      tone: "danger",
      onConfirm: clearStudentIdentityLinks,
    });
  };

  const confirmStudentIdentityReview = async (
    resolutionKey: string,
    decision: "merge" | "create",
  ) => {
    if (studentIdentityLinkBusy || studentImportBusy) return;
    setStudentIdentityLinkBusy(true);
    try {
      const response = await fetch("/api/student-import/identity-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionKey, decision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.count !== "number") {
        throw new Error(body.error || "学生身份审核保存失败");
      }
      setStudentIdentityLinkStatus({ count: body.count, unchanged: body.unchanged === true });
      setStudentImportPreview(null);
      await refreshStudentIdentityReview(false, true);
      notify(body.unchanged ? "该身份审核决定已保存" : "身份审核决定已保存，请继续审核或重新预检");
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生身份审核保存失败");
    } finally {
      setStudentIdentityLinkBusy(false);
    }
  };

  const confirmStudentIdentityManualPair = async () => {
    if (studentIdentityLinkBusy || studentImportBusy
      || !studentIdentityManualMasterToken || !studentIdentityManualJwbToken
      || (studentIdentityManualDecision === "merge" && !studentIdentityManualExistingToken)) return;
    setStudentIdentityLinkBusy(true);
    try {
      const response = await fetch("/api/student-import/identity-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          masterToken: studentIdentityManualMasterToken,
          jwbToken: studentIdentityManualJwbToken,
          decision: studentIdentityManualDecision,
          ...(studentIdentityManualDecision === "merge"
            ? { existingToken: studentIdentityManualExistingToken }
            : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.count !== "number") {
        throw new Error(body.error || "学生身份手工配对保存失败");
      }
      setStudentIdentityLinkStatus({ count: body.count, unchanged: body.unchanged === true });
      setStudentImportPreview(null);
      await refreshStudentIdentityReview(false, true);
      notify(body.unchanged ? "该手工配对已经保存" : "手工配对已保存，请继续处理剩余记录");
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生身份手工配对保存失败");
    } finally {
      setStudentIdentityLinkBusy(false);
    }
  };

  const confirmStudentMasterResolution = async (
    resolutionKey: string,
    decision: "select" | "ignore",
  ) => {
    if (studentMasterResolutionBusy || studentImportBusy) return;
    setStudentMasterResolutionBusy(resolutionKey);
    try {
      const response = await fetch("/api/student-import/master-resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionKey, decision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "学生总表重复项确认失败");
      setStudentImportPreview(null);
      notify("重复项选择已保存，请重新预检");
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生总表重复项确认失败");
    } finally {
      setStudentMasterResolutionBusy(null);
    }
  };

  const commitStudentImport = () => {
    const preview = studentImportPreview;
    if (!preview || !preview.canCommit) {
      notify("请先解决歧义并重新预检");
      return;
    }
    requestConfirmation({
      title: "确认正式导入学生资料",
      detail: `腾讯学生总表 ${preview.sources.master.rowCount} 行为唯一建档来源 · 教务宝 ${preview.sources.jwb.rowCount} 行仅补充课时、课包和首笔课时日期`,
      items: [
        `新增 ${preview.summary.insert} · 更新 ${preview.summary.update} · 保留 ${preview.summary.unchanged}`,
        `来源处理后不纳入 ${preview.summary.excluded} · 保留手工试听 ${preview.summary.preservedManualTrials}`,
        `历史引用只读归档 ${preview.summary.preservedReferencedArchived}`,
        `未安全关联教务宝补充资料 ${preview.summary.unmatched} · 总表学生仍会建档 · 歧义 ${preview.summary.ambiguous}`,
        `逐课包 ${preview.summary.importedPackages} · ${preview.summary.studentsMissingPackageData} 位暂无可核对课包账本`,
        `未安全关联教务宝的新学生，学号使用正式导入日期 ${preview.formalImportDate}`,
      ],
      confirmLabel: "原子提交导入",
      tone: "danger",
      onConfirm: async () => {
        setStudentImportBusy(true);
        try {
          const response = await fetch("/api/student-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              planFingerprint: preview.planFingerprint,
              expectedStudentVersion: preview.expectedStudentVersion,
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "学生正式导入失败");
          addAudit("完成学生正式导入", `学生资料版本 ${body.studentVersion} · 新增 ${preview.summary.insert} · 更新 ${preview.summary.update}${body.replayed === true ? " · 已恢复既有提交结果" : ""}`, "green");
          setStudentImportPreview(null);
          notify("学生正式导入已提交，正在载入最新共享资料");
          window.setTimeout(() => window.location.reload(), 700);
        } finally {
          setStudentImportBusy(false);
        }
      },
    });
  };

  const submitTeacherImportSource = async (
    workbook: TeacherImportSourceKind,
    rawJson: string,
  ) => {
    if (teacherImportSourceBusy) return;
    if (new Blob([rawJson]).size > 16 * 1024 * 1024) {
      notify("老师来源 JSON 不能超过 16 MB");
      return;
    }
    setTeacherImportSourceBusy(workbook);
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("老师来源必须是完整工作簿 JSON 对象");
      }
      const payload = { ...(parsed as Record<string, unknown>), workbook };
      const response = await fetch("/api/teacher-import/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.source) throw new Error(body.error || "老师来源录入失败");
      const source = body.source as TeacherImportSourceIngestResult;
      setTeacherImportSourceStatus((current) => ({ ...current, [workbook]: source }));
      setTeacherImportPreview(null);
      notify(source.unchanged ? "该老师来源 revision 内容未变化" : "老师来源已保存，请继续录入另一份来源或重新预检");
    } catch (error) {
      notify(error instanceof Error ? error.message : "老师来源录入失败");
    } finally {
      setTeacherImportSourceBusy(null);
    }
  };

  const ingestTeacherImportSourceFile = async (
    workbook: TeacherImportSourceKind,
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || teacherImportSourceBusy) return;
    if (file.size > 16 * 1024 * 1024) {
      notify("老师来源 JSON 不能超过 16 MB");
      return;
    }
    const rawJson = await file.text();
    setTeacherImportSourceJson((current) => ({ ...current, [workbook]: rawJson }));
    await submitTeacherImportSource(workbook, rawJson);
  };

  const previewTeacherImport = async () => {
    if (teacherImportBusy) return;
    setTeacherImportBusy(true);
    try {
      const response = await fetch("/api/teacher-import", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "老师导入预检失败");
      const preview = body as TeacherImportPreview;
      setTeacherImportPreview(preview);
      addAudit(
        "预检老师正式导入",
        `新增 ${preview.summary.insert} · 更新 ${preview.summary.update} · 阻断 ${preview.summary.blocked} · 人工确认 ${preview.summary.unstructuredAvailability + preview.summary.unstructuredCapacity}`,
        preview.summary.blocked ? "red" : preview.summary.issues ? "amber" : "blue",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "老师导入预检失败");
    } finally {
      setTeacherImportBusy(false);
    }
  };

  const confirmTeacherIdentityResolution = async (
    resolutionKey: string,
    decision: "merge" | "separate" | "assign" | "ignore",
  ) => {
    if (teacherIdentityResolutionBusy || teacherImportBusy) return;
    const busyKey = `${resolutionKey}:${decision}` as const;
    setTeacherIdentityResolutionBusy(busyKey);
    try {
      const response = await fetch("/api/teacher-import/identity-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionKey, decision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "老师身份确认失败");
      notify(body.unchanged ? "该教师身份决策此前已确认" : "身份决策已保存，正在重新预检");
      await previewTeacherImport();
    } catch (error) {
      notify(error instanceof Error ? error.message : "老师身份确认失败");
    } finally {
      setTeacherIdentityResolutionBusy(null);
    }
  };

  const commitTeacherImport = () => {
    const preview = teacherImportPreview;
    if (!preview || !preview.canCommit) {
      notify("请先解决阻断项并重新预检");
      return;
    }
    requestConfirmation({
      title: "确认正式导入老师资料",
      detail: `中小学 ${preview.sources.k12.rosterRowCount} 位 · 大学 ${preview.sources.university.rosterRowCount} 位`,
      items: [
        `新增 ${preview.summary.insert} · 更新 ${preview.summary.update} · 无需修改 ${preview.summary.unchanged}`,
        `身份或科目阻断 ${preview.summary.blocked}`,
        `AVA 原文待确认 ${preview.summary.unstructuredAvailability} · 容量原文待确认 ${preview.summary.unstructuredCapacity}`,
        "已确认的月度 AVA 和可接新生人数会保留",
      ],
      confirmLabel: "原子提交老师导入",
      tone: "danger",
      onConfirm: async () => {
        setTeacherImportBusy(true);
        try {
          const response = await fetch("/api/teacher-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              planFingerprint: preview.planFingerprint,
              expectedTeacherVersion: preview.expectedTeacherVersion,
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "老师正式导入失败");
          addAudit("完成老师正式导入", `老师资料版本 ${body.teacherVersion} · 新增 ${body.summary?.insert ?? 0} · 更新 ${body.summary?.update ?? 0}`, "green");
          setTeacherImportPreview(null);
          notify("老师正式导入已提交，正在载入最新共享资料");
          window.setTimeout(() => window.location.reload(), 700);
        } finally {
          setTeacherImportBusy(false);
        }
      },
    });
  };

  const exportDemo = () => {
    const payload = { meta: { schemaVersion: 3, dataSnapshot }, students, teachers, tasks, bookings, courses, lpItems, operations, renewals, payroll: payrollState, messages, files, audit, rules };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "yinling-education-ops-data.json";
    link.click();
    URL.revokeObjectURL(url);
    addAudit("导出当前业务数据", "已下载 JSON 副本", "blue");
    notify("已导出当前业务数据");
  };

  const exportAudit = (entries: readonly AuditEntry[]) => {
    const exportedAt = new Date().toISOString();
    const payload = {
      meta: {
        schemaVersion: 1,
        exportedAt,
        filter: auditFilter,
        query: auditQuery.trim(),
      },
      audit: entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `yinling-education-ops-audit-${exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    addAudit("导出操作审计", `${entries.length} 条当前筛选记录`, "blue");
    notify("已导出当前筛选的操作审计");
  };

  const exportReport = () => {
    if (!canUseAdminScope || !isAdminView) return;
    const generatedAt = new Date();
    const report = buildOperationsReportExport({
      ownerFilter: reportOwner,
      tasks,
      students: recordStudents,
      teachers: recordTeachers,
      bookings,
      filesIndexed: files.length > 0,
      generatedAt,
    });
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = operationsReportFilename(report.meta.ownerFilter, generatedAt);
    link.click();
    URL.revokeObjectURL(url);
    addAudit(
      "导出运营报表",
      `${report.meta.ownerFilter === "all" ? "全部负责人" : report.meta.ownerFilter} · ${report.metrics.tasks.total} 项任务 · ${report.metrics.students.total} 位学生`,
      "blue",
    );
    notify("已导出当前运营报表");
  };

  const classroomRequest = async (body: { action: "create" | "teacher-join" | "student-link" | "end" | "whiteboard"; bookingId: string; occurrenceId: string; sourceDate: string }) => {
    const { response, body: receivedBody } = await classroomFetch("/api/classroom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = receivedBody ?? {};
    if (!response.ok) throw new Error(result.error || "在线教室操作失败");
    return result;
  };

  const temporaryClassroomRequest = async (body: Record<string, unknown>) => {
    const { response, body: receivedBody } = await classroomFetch("/api/classroom/temporary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = receivedBody ?? {};
    if (!response.ok) throw new Error(result.error || "临时课堂创建失败");
    return result;
  };

  const persistClassroom = useCallback(async (occurrence: BookingOccurrence, meetingId: string, status: "ready" | "running" | "ended") => {
    const statusRank = { ready: 1, running: 2, ended: 3 };
    if (occurrence.classroom?.meetingId === meetingId
      && statusRank[occurrence.classroom.status] >= statusRank[status]) return;
    // Classroom state is a narrow booking projection command. The server
    // derives occurrenceId/createdAt and applies monotonic status semantics;
    // this function resolves only after the authoritative five-table receipt
    // has been merged by writeBookingCapacityMutation.
    return writeBookingCapacityMutation({
      action: "bind_classroom",
      bookingId: occurrence.id,
      occurrenceId: occurrence.occurrenceKey,
      classroom: { meetingId, status },
    });
  }, [writeBookingCapacityMutation]);

  const refreshClassroom = async (booking: BookingOccurrence, quiet = false) => {
    try {
      const { response, body: receivedBody } = await classroomFetch(`/api/classroom?bookingId=${encodeURIComponent(booking.id)}&occurrenceId=${encodeURIComponent(booking.occurrenceKey)}&sourceDate=${encodeURIComponent(booking.sourceDate)}`, { cache: "no-store" });
      const result = receivedBody ?? {};
      if (!response.ok) throw new Error(result.error || "无法读取教室状态");
      const runtime = classroomRuntimeResponse(result);
      const { recordings } = runtime;
      const nextStatus = runtime.running
        ? "running"
        : booking.classroom?.status === "running" || recordings.length
          ? "ended"
          : "ready";
      setClassroomRuntime(runtime);
      if (!result.closing && !result.ended && (booking.classroom?.meetingId === runtime.meetingId || provisionedClassrooms[booking.occurrenceKey] === runtime.meetingId || runtime.running || recordings.length)) {
        void persistClassroom(booking, runtime.meetingId, nextStatus).catch(() => {
          reportSharedSync("error", "课堂记录尚未同步");
        });
      }
      if (!quiet) notify(result.closing ? "结束请求已保存，系统正在确认教室关闭" : result.ended ? "课堂已结束，录播正在处理或已就绪" : runtime.running ? `教室进行中，当前 ${runtime.participantCount} 人在线` : recordings.length ? "课堂已结束，录播正在处理或已就绪" : "教室已创建，尚未开始");
      return runtime;
    } catch (error) {
      if (!quiet) notify(error instanceof Error ? error.message : "无法读取教室状态");
      return null;
    }
  };

  const provisionClassroom = async (booking: BookingOccurrence, announce: boolean) => {
    const result = await classroomRequest({ action: "create", bookingId: booking.id, occurrenceId: booking.occurrenceKey, sourceDate: booking.sourceDate });
    const meetingId = String(result.meeting?.meetingId || "");
    if (!meetingId) throw new Error("在线教室没有返回会议 ID");
    selectBookingRecord(booking);
    setActive("classroom");
    setMobilePreview(null);
    setProvisionedClassrooms((current) => ({ ...current, [booking.occurrenceKey]: meetingId }));
    setClassroomRuntime((current) => current?.meetingId === meetingId
      ? current
      : { meetingId, running: false, participantCount: 0, moderatorCount: 0, recordings: [] });
    void persistClassroom(booking, meetingId, "ready").catch(() => {
      reportSharedSync("error", "课堂记录尚未同步");
      notify("课堂已创建，排课记录暂未同步");
    });
    if (announce) {
      addAudit("创建在线教室", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "green");
      notify(result.meeting?.duplicate ? "已读取现有在线教室" : "在线教室已创建，可发送学生链接");
    }
    return meetingId;
  };

  const createClassroom = async (booking: BookingOccurrence) => {
    if (isPastBooking(booking)) {
      notify("历史课程不能新建网上教室，请创建新的排课");
      return "";
    }
    setClassroomBusy(true);
    try {
      return await provisionClassroom(booking, true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "在线教室创建失败");
      return "";
    } finally {
      setClassroomBusy(false);
    }
  };

  const joinTeacherClassroom = async (booking: BookingOccurrence) => {
    if (!canJoinTeacherClassroom) {
      notify("只有当前签名的授课老师可以进入教室");
      return;
    }
    if (isPastBooking(booking)) {
      notify("历史课程不能重新开课，请创建新的排课");
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      const useEnglishInterface = displayPreferences.language === "en-AU";
      popup.opener = null;
      popup.document.title = useEnglishInterface ? "Entering online classroom" : "正在进入网上教室";
      popup.document.documentElement.lang = useEnglishInterface ? "en-AU" : "zh-CN";
      popup.document.body.innerHTML = `
        <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#f4fbfa;color:#163b37;font-family:Arial,sans-serif">
          <section style="width:min(420px,calc(100vw - 40px));text-align:center">
            <div style="width:44px;height:44px;margin:0 auto 20px;border:4px solid #c8ebe8;border-top-color:#277f77;border-radius:50%;animation:spin 1s linear infinite"></div>
            <h1 style="font-size:22px;margin:0 0 10px">${useEnglishInterface ? "Connecting to online classroom" : "正在连接网上教室"}</h1>
            <p style="font-size:15px;line-height:1.6;margin:0;color:#55746f">${
              useEnglishInterface
                ? "This usually takes 10–30 seconds. Keep this page open, then allow microphone and camera access when prompted."
                : "通常需要 10–30 秒，请不要关闭此页面。进入后请允许浏览器使用麦克风和摄像头。"
            }</p>
          </section>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        </main>`;
    }
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "teacher-join", bookingId: booking.id, occurrenceId: booking.occurrenceKey, sourceDate: booking.sourceDate });
      if (!result.url) throw new Error("无法生成老师进入链接");
      const meetingId = String(result.meetingId || booking.classroom?.meetingId || "");
      if (meetingId) {
        setProvisionedClassrooms((current) => ({ ...current, [booking.occurrenceKey]: meetingId }));
        void persistClassroom(booking, meetingId, "ready").catch(() => {
          reportSharedSync("error", "课堂记录尚未同步");
          notify("课堂已打开，排课记录暂未同步");
        });
      }
      if (popup) {
        popup.location.replace(result.url);
        notify("课堂已在新标签页打开；首次进入请允许浏览器使用麦克风和摄像头");
      } else {
        window.location.assign(result.url);
      }
      addAudit("老师进入在线教室", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "blue");
      window.setTimeout(() => void refreshClassroom(booking, true), 2500);
    } catch (error) {
      popup?.close();
      notify(error instanceof Error ? error.message : "无法进入在线教室");
    } finally {
      setClassroomBusy(false);
    }
  };

  const copyStudentClassroomLink = async (booking: BookingOccurrence) => {
    if (isPastBooking(booking)) {
      notify("历史课程不能生成新的学生进入链接");
      return;
    }
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "student-link", bookingId: booking.id, occurrenceId: booking.occurrenceKey, sourceDate: booking.sourceDate });
      if (!result.url) throw new Error("无法生成学生进入链接");
      // Issuing a time-gated link does not provision a room or change its status.
      setTemporaryClassroomLink({ occurrenceId: booking.occurrenceKey, url: String(result.url) });
      addAudit("复制学生教室链接", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "blue");
      try {
        await Promise.race([
          navigator.clipboard.writeText(result.url),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 1500)),
        ]);
        notify("学生进入链接已复制");
      } catch {
        notify("学生链接已生成，请从页面复制或直接打开学生端");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生链接生成失败");
    } finally {
      setClassroomBusy(false);
    }
  };

  const submitTemporaryClassroom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? "").trim();
    const selectedTeacherId = String(data.get("teacherId") ?? "").trim();
    const teacherId = isTeacherView ? (currentTeacher?.id ?? "") : selectedTeacherId;
    const duration = Number(data.get("duration") ?? 60);
    const subjectId = String(data.get("subjectId") ?? "").trim();
    const teacherSubjectId = String(data.get("teacherSubjectId") ?? "").trim();
    const packageId = String(data.get("packageId") ?? "").trim();
    const hasRecordDetails = temporaryClassroomRecordLesson;

    if (hasRecordDetails && studentId && !scopedActiveStudentIds.has(studentId)) {
      notify("当前身份只能为当前范围的活跃学生创建临时课堂。");
      return;
    }

    if (hasRecordDetails) {
      const student = studentById(studentId);
      const teacher = teacherById(teacherId);
      if (!student || !teacher) {
        notify("要保存课堂记录，请完整选择学生和老师。");
        return;
      }
      if (!teacherSubjectId || !teacher.subjects.some((subject) => subject.trim() === teacherSubjectId)) {
        notify(`要保存课堂记录，请选择 ${teacher.name} 可教的老师科目。`);
        return;
      }
      const lessonPackage = student.lessonPackages?.find((entry) => entry.id === packageId);
      if (!subjectId || !lessonPackage || !lessonPackage.subjectIds.includes(subjectId)) {
        notify("要保存课堂记录，请选择该学生科目对应的课包。");
        return;
      }

      if (![60, 90, 120].includes(duration)) {
        notify("课堂时长必须是 60、90 或 120 分钟。");
        return;
      }

      // Date/start are generated once for a new intent. They intentionally do
      // not participate in the stable intent match: a retry after reload or a
      // minute boundary must reuse the original wall-clock payload.
      const requestIntent = normalizeTemporaryClassroomIntent({
        mode: "recorded",
        studentId,
        teacherId,
        subjectId,
        teacherSubjectId,
        packageId,
        duration,
        timezone: scheduleTimezone,
      });
      const stored = temporaryClassroomPendingRef.current.find((entry) => entry.intent === requestIntent);
      const pending = stored?.actor === sessionOperator
        && stored.mode === "recorded"
        && stored.intent === requestIntent
        ? stored
        : null;
      const recordedPayload: TemporaryClassroomRecordedPayload = pending?.payload.mode === "recorded"
        ? pending.payload
        : (() => {
          const parts = zonedParts(new Date(), scheduleTimezone);
          return {
            mode: "recorded" as const,
            studentId,
            teacherId,
            subjectId,
            teacherSubjectId,
            packageId,
            duration: duration as 60 | 90 | 120,
            date: `${parts.year}-${parts.month}-${parts.day}`,
            start: `${parts.hour}:${parts.minute}`,
            timezone: scheduleTimezone,
          };
        })();
      if (scheduleConflict(
        recordedPayload.studentId,
        recordedPayload.teacherId,
        recordedPayload.date,
        recordedPayload.start,
        recordedPayload.duration,
        recordedPayload.timezone,
      )) {
        notify("学生或老师当前已有重叠课程，请先调整现有排课。");
        return;
      }

      const requestKey = pending?.requestKey ?? newTemporaryClassroomRequestKey();
      if (!requestKey) {
        notify("浏览器无法生成安全的课堂请求编号，请更换浏览器后重试。");
        return;
      }
      const nextPending = pending ?? createTemporaryClassroomPending({
        actor: sessionOperator,
        requestKey,
        payload: recordedPayload,
      });
      if (!nextPending) {
        notify("课堂请求内容无效，请重新选择后重试。");
        return;
      }
      if (!pending) {
        if (!writeTemporaryClassroomPending(nextPending)) {
          notify("浏览器无法安全保存课堂重试编号，请启用此站点存储后重试。");
          return;
        }
        temporaryClassroomPendingRef.current = [nextPending, ...temporaryClassroomPendingRef.current.filter((entry) => entry.intent !== nextPending.intent)]
          .slice(0, TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES);
        temporaryClassroomRequestKeyRef.current = nextPending.requestKey;
        temporaryClassroomRequestIntentRef.current = nextPending.intent;
      }

      setClassroomBusy(true);
      setTemporaryClassroomLink(null);
      setTemporaryTestClassroom(null);
      try {
        const result = await temporaryClassroomRequest({
          requestKey,
          studentId: recordedPayload.studentId,
          teacherId: recordedPayload.teacherId,
          subjectId: recordedPayload.subjectId,
          teacherSubjectId: recordedPayload.teacherSubjectId,
          packageId: recordedPayload.packageId,
          duration: recordedPayload.duration,
          date: recordedPayload.date,
          start: recordedPayload.start,
          timezone: recordedPayload.timezone,
        });
        const viewerUrl = String(result.viewerUrl || "");
        if (!result.bookingRow || !result.studentRow || !result.taskRow || !result.teacherRow || !viewerUrl) {
          throw new Error("课堂已创建；权威排课状态暂不可用，请稍后刷新恢复。");
        }
        const committedBookingRow = result.bookingRow as RemoteStateRow<Booking[]>;
        bookingsShared.applyRemote(committedBookingRow);
        studentsShared.applyRemote(result.studentRow as RemoteStateRow<Student[]>);
        tasksShared.applyRemote(result.taskRow as RemoteStateRow<Task[]>);
        teachersShared.applyRemote(result.teacherRow as RemoteStateRow<Teacher[]>);
        const bookingId = String(result.bookingId || "");
        const occurrenceId = String(result.occurrenceId || `${bookingId}:${recordedPayload.date}`);
        const savedBooking = committedBookingRow.payload.find((entry) => entry.id === bookingId);
        if (!savedBooking) throw new Error("课堂已创建，但服务器没有返回新课次。");
        const occurrence: BookingOccurrence = {
          ...savedBooking,
          occurrenceId,
          sourceDate: recordedPayload.date,
          occurrenceKey: occurrenceId,
          occurrenceStatus: "confirmed",
        };
        selectBookingRecord(occurrence, "classroom");
        setClassroomView("upcoming");
        setClassroomRuntime(null);
        setTemporaryClassroomLink({ occurrenceId, url: viewerUrl });
        setModal(null);
        setActive("classroom");
        clearTemporaryClassroomPending(sessionOperator, requestIntent ?? undefined);
        temporaryClassroomPendingRef.current = temporaryClassroomPendingRef.current.filter((entry) => entry.intent !== requestIntent);
        temporaryClassroomRequestKeyRef.current = null;
        temporaryClassroomRequestIntentRef.current = null;
        notify(result.duplicate ? "已恢复现有临时课堂记录" : "临时课堂已创建，学生进入链接已生成");
      } catch (error) {
        notify(error instanceof Error ? error.message : "临时课堂创建失败");
      } finally {
        setClassroomBusy(false);
      }
      return;
    }

    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.title = "正在进入网上教室";
      popup.document.documentElement.lang = "zh-CN";
      popup.document.body.innerHTML = `
        <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#f4fbfa;color:#163b37;font-family:Arial,sans-serif">
          <section style="width:min(420px,calc(100vw - 40px));text-align:center">
            <div style="width:44px;height:44px;margin:0 auto 20px;border:4px solid #c8ebe8;border-top-color:#277f77;border-radius:50%;animation:spin 1s linear infinite"></div>
            <h1 style="font-size:22px;margin:0 0 10px">正在创建网上教室</h1>
            <p style="font-size:15px;line-height:1.6;margin:0;color:#55746f">连接完成后会自动进入课堂。</p>
          </section>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        </main>`;
    }
    setClassroomBusy(true);
    setTemporaryTestClassroom(null);
    try {
      const requestIntent = normalizeTemporaryClassroomIntent({ mode: "test" });
      const stored = temporaryClassroomPendingRef.current.find((entry) => entry.intent === requestIntent);
      const pending = stored?.actor === sessionOperator
        && stored.mode === "test"
        && stored.intent === requestIntent
        ? stored
        : null;
      const requestKey = pending?.requestKey ?? newTemporaryClassroomRequestKey();
      if (!requestKey) throw new Error("浏览器无法生成安全的课堂请求编号，请更换浏览器后重试。");
      const nextPending = pending ?? createTemporaryClassroomPending({
        actor: sessionOperator,
        requestKey,
        payload: { mode: "test" },
      });
      if (!nextPending) throw new Error("课堂请求内容无效，请重新尝试。");
      if (!pending) {
        if (!writeTemporaryClassroomPending(nextPending)) {
          throw new Error("浏览器无法安全保存课堂重试编号，请启用此站点存储后重试。");
        }
        temporaryClassroomPendingRef.current = [nextPending, ...temporaryClassroomPendingRef.current.filter((entry) => entry.intent !== nextPending.intent)]
          .slice(0, TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES);
        temporaryClassroomRequestKeyRef.current = nextPending.requestKey;
        temporaryClassroomRequestIntentRef.current = nextPending.intent;
      }
      const result = await temporaryClassroomRequest({ requestKey });
      const meetingId = String(result.meetingId ?? "");
      const moderatorUrl = String(result.moderatorUrl ?? "");
      const viewerUrl = String(result.viewerUrl ?? "");
      if (!meetingId || !moderatorUrl || !viewerUrl) throw new Error("临时课堂没有返回完整的进入链接。");
      setTemporaryTestClassroom({ meetingId, viewerUrl });
      clearTemporaryClassroomPending(sessionOperator, requestIntent ?? undefined);
      temporaryClassroomPendingRef.current = temporaryClassroomPendingRef.current.filter((entry) => entry.intent !== requestIntent);
      temporaryClassroomRequestKeyRef.current = null;
      temporaryClassroomRequestIntentRef.current = null;
      if (popup) {
        popup.location.replace(moderatorUrl);
      } else {
        window.location.assign(moderatorUrl);
      }
      notify("临时课堂已打开；复制下方链接即可邀请参与者进入。");
    } catch (error) {
      popup?.close();
      notify(error instanceof Error ? error.message : "临时课堂创建失败");
    } finally {
      setClassroomBusy(false);
    }
  };

  const endClassroom = async (booking: BookingOccurrence) => {
    requestConfirmation({
      title: "确认结束在线课堂",
      detail: `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.date} ${booking.start}`,
      items: ["所有在线参与者会立即离开", "结束教室不会直接把课程判为完成", "系统取得双方出勤时长后才可结算课时与薪资"],
      confirmLabel: "结束课堂",
      tone: "danger",
      onConfirm: async () => {
        setClassroomBusy(true);
        try {
          const result = await classroomRequest({ action: "end", bookingId: booking.id, occurrenceId: booking.occurrenceKey, sourceDate: booking.sourceDate });
          if (result.ended === true) {
            setClassroomRuntime((current) => current ? { ...current, running: false, participantCount: 0, moderatorCount: 0 } : current);
            notify("课堂已结束，正在等待出勤证据结算");
          } else {
            notify("结束请求已保存，系统正在确认教室关闭；请稍后刷新状态。");
          }
        } catch (error) {
          notify(error instanceof Error ? error.message : "在线教室结束失败");
        } finally {
          setClassroomBusy(false);
        }
      },
    });
  };

  const openLessonSettlement = (occurrence: BookingOccurrence) => {
    if (!scopedActiveStudentIds.has(occurrence.studentId)) {
      notify("当前身份只能结算当前范围的活跃学生课次。");
      return;
    }
    setLessonSettlementDraft(occurrence);
    setLessonSettlementError("");
    setModal("lessonSettlement");
  };

  const submitLessonSettlement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lessonSettlementDraft) return;
    if (!scopedActiveStudentIds.has(lessonSettlementDraft.studentId)) {
      setLessonSettlementError("当前身份只能结算当前范围的活跃学生课次。");
      return;
    }
    const data = new FormData(event.currentTarget);
    const overrideReason = String(data.get("overrideReason") ?? "").trim();
    if (overrideReason.length < 8) {
      setLessonSettlementError("覆盖原因至少填写 8 个字符。");
      return;
    }
    setLessonSettlementBusy(true);
    setLessonSettlementError("");
    try {
      const response = await fetch("/api/lesson-occurrences/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          occurrenceId: lessonSettlementDraft.occurrenceKey,
          expectedVersion: bookingsShared.version,
          overrideReason,
          manualAdjustment: { actualMinutes: Number(data.get("actualMinutes")), studentMinutes: Number(data.get("studentMinutes")), teacherMinutes: Number(data.get("teacherMinutes")) },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "课次结算失败。");
      setModal(null);
      setLessonSettlementDraft(null);
      notify(body.applied === false ? "该课次已经结算，正在刷新最新资料" : "课次已结算，正在刷新最新资料");
      window.location.reload();
    } catch (error) {
      setLessonSettlementError(error instanceof Error ? error.message : "课次结算失败。");
    } finally {
      setLessonSettlementBusy(false);
    }
  };

  useEffect(() => {
    if (active !== "classroom" || !selectedClassroomBookingId || !selectedClassroomOccurrenceKey || !selectedClassroomSourceDate || !selectedClassroomMeetingId) return;
    let selected = true;
    const poll = async (signal: AbortSignal) => {
      const occurrenceKey = selectedClassroomOccurrenceKey;
      const series = scopedBookings.find((candidate) => candidate.id === selectedClassroomBookingId);
      const booking = series ? bookingOccurrenceByStableKey(series, occurrenceKey, selectedClassroomSourceDate) : undefined;
      if (!booking) return;
      const { response, body: receivedBody } = await classroomFetch(`/api/classroom?bookingId=${encodeURIComponent(selectedClassroomBookingId)}&occurrenceId=${encodeURIComponent(occurrenceKey)}&sourceDate=${encodeURIComponent(selectedClassroomSourceDate)}`, {
        cache: "no-store",
        signal,
      });
      if (signal.aborted) return;
      const result = receivedBody && typeof receivedBody === "object" ? receivedBody : {};
      if (!response.ok || signal.aborted) return;
      const runtime = classroomRuntimeResponse(result);
      const { recordings } = runtime;
      const currentClassroom = booking.classroom;
      const nextStatus: NonNullable<Booking["classroom"]>["status"] = runtime.running
        ? "running"
        : currentClassroom?.status === "running" || recordings.length
          ? "ended"
          : "ready";
      // Polling is also a persistence path. Keep the exact command in the
      // shared pending envelope when the response is unknown, and do not
      // manufacture a local createdAt/status before the atomic receipt.
      if (!signal.aborted) setClassroomRuntime(runtime);
      if (!result.closing && !result.ended) {
        await persistClassroom(booking, runtime.meetingId, nextStatus);
      }
    };
    const poller = createSharedStatePoller({
      canRun: () => selected,
      errorDelayMs: 15_000,
      onError: () => {
        // A transient classroom read is retried without replacing the last runtime.
      },
      run: poll,
    });
    void poller.wake();
    return () => {
      selected = false;
      poller.stop();
    };
  }, [active, persistClassroom, scopedBookings, selectedClassroomBookingId, selectedClassroomOccurrenceKey, selectedClassroomMeetingId, selectedClassroomSourceDate]);

  const openDashboardLesson = (booking: BookingOccurrence) => {
    if (!selectBookingRecord(booking, "booking")) return;
    // A stale month, page, or teacher filter must not replace this exact
    // occurrence with the first visible lesson when the schedule renders.
    setScheduleMode("month");
    setScheduleMonth(isoDateInTimezone(bookingInstant(booking), displayPreferences.timezone).slice(0, 7));
    setScheduleFilter("all");
    setScheduleTeacherFilter("all");
    setScheduleDay("all");
    setSchedulePage(1);
    setActive("schedule");
  };

  const renderTeacherDashboard = () => {
    const english = displayPreferences.language === "en-AU";
    const teacherToday = isoDateInTimezone(new Date(), displayPreferences.timezone);
    const teacherOccurrences = scopedBookings
      .flatMap((booking) => bookingOccurrencesWithinRange(
        booking,
        shiftIsoDate(teacherToday, -366),
        shiftIsoDate(teacherToday, 366),
      ))
      .filter((booking) => currentTeacherIds.has(booking.teacherId));
    const pendingBookings = teacherOccurrences.filter(
      (booking) => booking.status === "待确认" && !isPastBooking(booking),
    );
    const upcomingTeacherBookings = teacherOccurrences
      .filter((booking) => !isPastBooking(booking))
      .sort(
        (left, right) =>
          bookingInstant(left).getTime() - bookingInstant(right).getTime(),
      );
    const totalMinutes = teacherOccurrences.reduce((sum, booking) => sum + booking.duration, 0);
    const todayLabel = dateTimeFormat(localeFor(displayPreferences.language), { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: displayPreferences.timezone }).format(new Date());
    return <>
      <ViewHeading eyebrow={todayLabel} showContext title={english ? "My teaching workspace" : "我的教学工作台"} actions={<><button className="secondary-button" type="button" onClick={() => { teacherAvailabilitySubmissionKey.current = crypto.randomUUID(); setModal("teacherAvailabilitySubmit"); }}><Clock3 size={17} /> {english ? "Submit availability" : "提交月度 AVA"}</button><button className="secondary-button" type="button" onClick={() => setActive("students")}><Users size={17} /> {english ? "My students" : "我的学生"}</button><button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> {english ? "New booking" : "新建约课"}</button></>} />
      <TeacherLeavePanel teacherId={currentTeacher?.id} />
      <section className="metric-grid teacher-metric-grid" aria-label={english ? "My teaching overview" : "我的教学概览"}>
        <Metric tone="green" icon={<Users size={21} />} value={scopedStudents.length.toString()} label={english ? "My students" : "我的学生"} detail={english ? "Students linked to this teacher only" : "仅显示当前老师关联学生"} onClick={() => setActive("students")} />
        <Metric tone="blue" icon={<CalendarDays size={21} />} value={teacherOccurrences.length.toString()} label={english ? "Lesson records" : "课程记录"} detail={english ? "Occurrences assigned to this teacher" : "当前老师实际授课的课次"} onClick={() => setActive("schedule")} />
        <Metric tone="amber" icon={<Clock3 size={21} />} value={pendingBookings.length.toString()} label={english ? "Pending" : "待确认"} detail={english ? "Lessons needing confirmation" : "需要确认的课程"} onClick={() => setActive("schedule")} />
        <Metric tone="purple" icon={<Video size={21} />} value={`${Math.round(totalMinutes / 60)}h`} label={english ? "Scheduled time" : "排课时长"} detail={english ? "Based on the current lesson records" : "按当前课程记录汇总"} onClick={() => setActive("classroom")} />
      </section>
      <section className="teacher-dashboard-grid">
        <article className="panel teacher-roster-panel"><div className="panel-header"><div><h2>{english ? "My students" : "我的学生"}</h2></div><IconButton label={english ? "Open students" : "打开学生列表"} onClick={() => setActive("students")}><Users size={18} /></IconButton></div><div className="teacher-student-list">{scopedStudents.slice(0, 8).map((student) => <button type="button" key={student.id} onClick={() => goToStudent(student.id)}><Avatar initials={student.initials} tone={statusTone(student.status)} /><span><strong>{student.name}</strong><small>{student.course} · {displayTerm(student.status, displayPreferences.language)}</small></span><ChevronRight size={16} /></button>)}{!scopedStudents.length && <EmptyState title={english ? "No linked students" : "暂无关联学生"} detail={english ? "Students appear here after they are linked by an administrator or their lessons are imported." : "管理员为老师关联学生或导入排课后，这里会自动出现。"} />}</div></article>
        <article className="panel today-panel"><div className="panel-header"><div><h2>{english ? "Upcoming lessons" : "接下来课程"}</h2></div><IconButton label={english ? "Open schedule" : "打开排课"} onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div>{upcomingTeacherBookings.length ? <ScheduleList bookings={upcomingTeacherBookings} studentById={studentById} teacherById={teacherById} preferences={displayPreferences} onViewAll={() => setActive("schedule")} onOpen={openDashboardLesson} /> : <EmptyState title={english ? "No upcoming lessons" : "暂无未来排课"} detail={english ? "Use New booking to schedule a future lesson for one of your students." : "点击“新建约课”为自己的学生安排未来课程。"} />}<button className="text-button" type="button" onClick={() => setActive("classroom")}><Video size={16} /> {english ? "Manage online classrooms" : "管理在线教室"}</button></article>
      </section>
    </>;
  };

  const renderDashboard = () => {
    if (isTeacherView) return renderTeacherDashboard();
    const operatorStudents = scopedStudents;
    const operatorStudentIds = new Set(operatorStudents.map((student) => student.id));
    const operatorBookings = currentOperator === "Nixon" ? bookings : bookings.filter((booking) => operatorStudentIds.has(booking.studentId));
    const todayDate = isoDateInTimezone(new Date(), displayPreferences.timezone);
    const operatorTodayBookings = dashboardLessonsForDay(
      operatorBookings.flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(todayDate, -1), shiftIsoDate(todayDate, 1))),
      bookingInstant,
      displayPreferences.timezone,
      todayDate,
    );
    const operatorExamStudents = examReminderStudents;
    const operatorDstBookings = dstRiskBookings.filter((booking) => operatorStudentIds.has(booking.studentId));
    const nearestExam = operatorExamStudents[0];
    const nearestExamRecord = nearestExam
      ? examRecordsForStudent(nearestExam).find((exam) => exam.examDate) ?? examRecordsForStudent(nearestExam)[0]
      : undefined;
    // Only the server-validated completion reader can contribute an AVA risk
    // count. It distinguishes missing from invalid structured AVA and never
    // treats legacy text or an arbitrary month-overlap as current coverage.
    const authoritativeAvaInbox = isAdminView && canUseAdminScope
      ? teacherAvailabilityCompletion
      : null;
    const authoritativeAvaSummary = authoritativeAvaInbox?.summary ?? null;
    const authoritativeAvaIssueCount = authoritativeAvaSummary
      ? authoritativeAvaSummary.missing + authoritativeAvaSummary.invalid
      : 0;
    const operatorRiskCount = operatorTodayBookings.filter((booking) => booking.occurrenceStatus === "abnormal").length
      + operatorExamStudents.length
      + operatorDstBookings.length
      + authoritativeAvaIssueCount;
    const todayLabel = dateTimeFormat(localeFor(displayPreferences.language), { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: displayPreferences.timezone }).format(new Date());
    return <>
      <ViewHeading eyebrow={todayLabel} showContext title="工作台" actions={<><button className="secondary-button" type="button" onClick={() => setActive("schedule")}><CalendarDays size={17} /> 查看排课</button><button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button></>} />
      <section className="dashboard-grid">
        <div><ToDoList tasks={visibleTasks} key={currentOperator} deadlineTimeZone={taskDeadlineTimeZone} deadlineTimeZoneLabel={taskDeadlineTimeZoneLabel} deadlineTimeFormat={displayPreferences.timeFormat} taskTitle={trialTaskTitle} taskSchedule={trialTaskSchedule} studentName={(studentId) => taskStudentNames.get(studentId)} filter={taskFilter} onFilterChange={setTaskFilter} onComplete={completeTask} onCannotDo={cannotDoTask} onReopen={reopenTask} canReopen={(task) => !isManagedTrialPaymentTask(task) || task.completionOutcome === "cannot_do" || isManagedTrialPaymentConfirmationTask(task)} onUpdateNote={updateTaskNote} onRepairDeadline={canUseAdminScope && isAdminView ? (task) => { const currentTask = tasks.find((candidate) => candidate.id === task.id); if (!currentTask) return; setLegacyTaskDeadlineDraft(currentTask); setModal("legacyTaskDeadline"); } : undefined} canRepairDeadline={(task) => !Object.hasOwn(task, "ruleKey") && !Object.hasOwn(task, "anchorBookingId") && task.status !== "done"} onParentReplied={recordTrialParentReply} onTeacherReplied={recordTrialTeacherReply} onOpen={(task) => goToStudent(task.studentId)} canOpen={(task) => !managedExamStudentIds.has(task.studentId) && !managedTrialPaymentStudentIds.has(task.studentId)} /><button className="text-button" type="button" onClick={() => setModal("task")}><Plus size={16} /> 添加内部任务</button></div>
        <article className="panel today-panel"><div className="panel-header"><div><h2>今日课程</h2></div><IconButton label="打开排课" onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div><ScheduleList bookings={operatorTodayBookings} studentById={studentById} teacherById={teacherById} preferences={displayPreferences} onViewAll={() => setActive("schedule")} onOpen={openDashboardLesson} /></article>
        <article className="panel risk-panel">
          <div className="panel-header">
            <div><h2>风险与缺口</h2></div>
            <StatusPill tone="amber">{operatorRiskCount} 项</StatusPill>
          </div>
          {operatorRiskCount > 0 ? <>
            {operatorTodayBookings.filter((booking) => booking.occurrenceStatus === "abnormal").map((booking) => <RiskRow key={booking.occurrenceKey} tone="red" title={`${studentById(booking.studentId)?.name ?? booking.studentId} 课堂出勤异常`} detail={`${booking.date} ${booking.start} · 待人工复核`} action={() => { selectBookingRecord(booking); setActive("schedule"); }} />)}
            {nearestExam ? <RiskRow tone="amber" title={`${nearestExam.name} 的考试进入 ${rules.examDays} 天窗口`} detail={`${nearestExamRecord?.subject ?? "考试"} · ${nearestExamRecord?.examDate ?? "待确认"}`} action={managedExamStudentIds.has(nearestExam.id) ? undefined : () => goToStudent(nearestExam.id)} /> : null}
            {operatorDstBookings.length ? <RiskRow tone="purple" title={`${operatorDstBookings.length} 节长期课受夏令时影响`} detail="学生与老师时差会变化" action={() => setActive("schedule")} /> : null}
            {authoritativeAvaInbox && authoritativeAvaSummary && authoritativeAvaIssueCount > 0 ? <RiskRow
              tone={authoritativeAvaSummary.invalid > 0 ? "red" : "blue"}
              title={`${authoritativeAvaIssueCount} 位老师本月 AVA 待补齐`}
              detail={`${authoritativeAvaInbox.month} · 缺少 ${authoritativeAvaSummary.missing}，需修正 ${authoritativeAvaSummary.invalid}${authoritativeAvaSummary.pendingReview ? ` · ${authoritativeAvaSummary.pendingReview} 份待审核` : ""}`}
              action={() => setActive("teachers")}
            /> : null}
          </> : teacherAvailabilityCompletionLoading ? (
            <div className="empty-inline" role="status" aria-live="polite"><RefreshCw size={20} /> 正在读取风险资料…</div>
          ) : teacherAvailabilityCompletionError ? (
            <div className="empty-inline" role="alert"><CircleAlert size={20} /> 老师 AVA 风险暂时无法读取。<button className="text-button" type="button" onClick={() => setActive("teachers")}>打开老师管理</button></div>
          ) : (
            <div className="empty-inline" role="status" aria-live="polite"><CheckCircle2 size={20} /> 当前没有待处理风险</div>
          )}
        </article>
      </section>
    </>;
  };

  const renderStudents = () => {
    const english = displayPreferences.language === "en-AU";
    const viewItems = [
      { id: "all", label: isTeacherView && displayPreferences.language === "en-AU" ? "My students" : isAdminView ? "全部学生" : isTeacherView ? "我的学生" : "我负责的学生", count: scopedStudents.length },
      { id: "trial", label: isTeacherView && displayPreferences.language === "en-AU" ? "Trials / to schedule" : "试听与待排课", count: scopedStudents.filter((student) => student.segment === "试听" || student.status === "在读 + 加课待排").length },
      { id: "enrolled", label: isTeacherView && displayPreferences.language === "en-AU" ? "Enrolled and active" : "已报名在读", count: scopedStudents.filter((student) => student.segment === "已报名" && isActiveStudent(student)).length },
      { id: "lp", label: isTeacherView && displayPreferences.language === "en-AU" ? "Needs LP" : "需要 LP", count: scopedStudents.filter(requiresLp).length },
      { id: "renewal", label: isTeacherView && displayPreferences.language === "en-AU" ? "Renewal due" : "续课关注", count: scopedStudents.filter((student) => student.status === "活跃 + 无课时" || student.status === "活跃 + 有课时").length },
      { id: "paused", label: isTeacherView && displayPreferences.language === "en-AU" ? "Inactive" : "不活跃", count: scopedStudents.filter((student) => student.status === "不活跃 + 有课时" || student.status === "不活跃 + 无课时").length },
      { id: "archived", label: isTeacherView && displayPreferences.language === "en-AU" ? "Historical archive" : "历史归档", count: scopedArchivedStudents.length },
    ];
    const pageIds = pagedStudents.map((student) => student.id);
    const pageSelected = pageIds.length > 0 && pageIds.every((studentId) => selectedStudentIds.includes(studentId));
    const visibleSelectedStudent = pagedStudents.find((student) => student.id === selectedStudentId) ?? pagedStudents[0];
    return <>
      <ViewHeading eyebrow={isTeacherView ? (english ? "Teacher workspace" : "老师工作台") : "学生档案"} title={isTeacherView && english ? "My students" : isTeacherView ? "我的学生" : "学生档案"} actions={<><button className="secondary-button" type="button" data-global-search-trigger onClick={(event) => openGlobalSearch(event.currentTarget)}><Search size={17} /> {isTeacherView && english ? "Find a student" : "查找学生"}</button>{!isTeacherView && studentView !== "archived" && <button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button>}</>} />
      <section className="panel collection-shell student-collection">
        <ViewTabs value={studentView} items={viewItems} onChange={(value) => { setStudentView(value); setStudentPage(1); setSelectedStudentIds([]); }} label="学生保存视图" />
        <ListToolbar query={search} onQuery={(value) => { setSearch(value); setStudentPage(1); }} placeholder={isTeacherView && english ? "Search name, course, or teacher" : "搜索姓名、课程或老师"} count={filteredStudents.length ? `${filteredStudents.length} ${isTeacherView && english ? "students" : "位学生"}` : ""}>
          {isAdminView && <select className="filter-select" value={studentOwner} onChange={(event) => { setStudentOwner(event.target.value); setStudentPage(1); }} aria-label="按负责教务筛选"><option value="all">全部教务</option>{ownerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select>}
          <button className="toolbar-button" type="button" onClick={() => { setSearch(""); setStudentOwner("all"); setStudentView("all"); setStudentPage(1); }}><Filter size={15} /> 清除筛选</button>
          <button
            className="toolbar-button"
            type="button"
            aria-label={studentNameSort === "asc" ? "姓名当前升序，切换为降序" : "姓名当前降序，切换为升序"}
            aria-pressed={studentNameSort === "desc"}
            title={studentNameSort === "asc" ? "按姓名升序排列" : "按姓名降序排列"}
            onClick={() => {
              setStudentNameSort((current) => current === "asc" ? "desc" : "asc");
              setStudentPage(1);
              setMobilePreview(null);
            }}
          ><ArrowUpDown size={15} /> {isTeacherView && english ? `Name: ${studentNameSort === "asc" ? "A–Z" : "Z–A"}` : `姓名排序：${studentNameSort === "asc" ? "升序" : "降序"}`}</button>
        </ListToolbar>
        {studentView === "archived" && <div className="archive-readonly-banner" role="status"><ShieldCheck size={17} /><span><strong>历史归档只读</strong><small>保留历史排课、资料与跟进记录；不能编辑、上传、排课或创建新业务。</small></span></div>}
        {studentView !== "archived" && selectedStudentIds.length > 0 && <div className="bulk-bar"><strong>已选 {selectedStudentIds.length} 位</strong><span>批量分配负责人</span>{teamOwnerOptions.map((owner) => <button type="button" key={owner} onClick={() => bulkAssignStudents(owner)}>{owner}</button>)}<button className="bulk-clear" type="button" onClick={() => setSelectedStudentIds([])}>取消选择</button></div>}
        <div className="master-detail-layout">
          <article className="collection-main">
            <div className="collection-head student-grid">
              <label className="selection-control">
                <input type="checkbox" disabled={!isAdminView || studentView === "archived"} checked={studentView === "archived" ? false : pageSelected} aria-label={english ? "Select students on this page" : "选择本页学生"} onChange={() => setSelectedStudentIds(pageSelected ? selectedStudentIds.filter((studentId) => !pageIds.includes(studentId)) : Array.from(new Set([...selectedStudentIds, ...pageIds])))} />
              </label>
              <span>{isTeacherView && english ? "Student" : "学生"}</span>
              <span>{isTeacherView && english ? "Status / teacher" : "学员状态 / 老师"}</span>
              <span>{isTeacherView && english ? "Next step" : "下一步"}</span>
            </div>
            <div className="collection-viewport">
              {pagedStudents.length ? pagedStudents.map((student) => (
                <div className={`collection-row student-grid ${visibleSelectedStudent?.id === student.id ? "selected" : ""} ${student.importArchived ? "archived-row" : ""}`} key={student.id}>
                  <label className="selection-control">
                    <input type="checkbox" disabled={!isAdminView || student.importArchived === true} checked={student.importArchived ? false : selectedStudentIds.includes(student.id)} aria-label={`${english ? "Select" : "选择"} ${student.name}`} onChange={() => toggleStudentSelection(student.id)} />
                  </label>
                  <button className="row-primary table-person" type="button" title={student.name} onClick={() => openStudentPreview(student.id)}><Avatar initials={student.initials} tone={student.importArchived ? "neutral" : statusTone(student.status)} /><span><strong>{student.name}</strong></span></button>
                  <button className="row-cell stacked" type="button" title={`${displayTerm(student.status, displayPreferences.language)} · ${student.teacher}`} onClick={() => openStudentPreview(student.id)}>{student.importArchived ? <StatusPill tone="neutral">历史归档 · 只读</StatusPill> : <StatusPill tone={statusTone(student.status)}>{displayTerm(student.segment ?? "已报名", displayPreferences.language)} · {displayTerm(student.status, displayPreferences.language)}</StatusPill>}<small>{student.teacher}</small></button>
                  <button className="row-cell" type="button" title={student.next} onClick={() => openStudentPreview(student.id)}><StatusPill tone={student.nextTone}>{student.importArchived ? "保留历史记录" : student.next}</StatusPill></button>
                </div>
              )) : <EmptyState title={isTeacherView && english ? "No matching students" : "没有符合条件的学生"} detail={studentView === "archived" ? "没有当前身份可查看的历史归档学生。" : isTeacherView && english ? "Adjust your search or switch the saved view and try again." : "调整搜索或切换保存视图后再试。"} />}
            </div>
            <Pagination page={safeStudentPage} total={filteredStudents.length} pageSize={pageSize} onPage={(page) => { setStudentPage(page); setMobilePreview(null); }} />
          </article>
          {visibleSelectedStudent ? <StudentDetail student={visibleSelectedStudent} tasks={visibleSelectedStudent.importArchived ? readableScopedTasks : scopedTasks} bookings={visibleSelectedStudent.importArchived ? readableScopedBookings : scopedBookings} lpItems={visibleSelectedStudent.importArchived ? readableScopedLpItems : scopedLpItems} operations={visibleSelectedStudent.importArchived ? readableScopedOperations : scopedOperations} renewals={visibleSelectedStudent.importArchived ? readableScopedRenewals : scopedRenewals} messages={visibleSelectedStudent.importArchived ? readableScopedMessages : scopedMessages} files={visibleSelectedStudent.importArchived ? readableScopedFiles : scopedFiles} completedLessonItems={jiaowubaoCompletedLessonsByStudentId.get(visibleSelectedStudent.id) ?? []} completedLessonMonth={jiaowubaoCompletedLessonFeed?.state === "complete" ? jiaowubaoCompletedLessonFeed.month : null} studentById={studentById} teacherById={teacherById} preferences={displayPreferences} taskDeadlineTimeZone={taskDeadlineTimeZone} taskTitle={trialTaskTitle} lowHoursThreshold={Number(rules.lowHours)} mobileOpen={mobilePreview === "student"} readOnly={visibleSelectedStudent.importArchived === true} canEditStatus={!isTeacherView && visibleSelectedStudent.importArchived !== true} onClose={() => setMobilePreview(null)} onRecord={(section) => openStudentRecord(visibleSelectedStudent.id, section)} onSchedule={() => { setMobilePreview(null); openNewBooking(visibleSelectedStudent.id); }} onEdit={() => { openStudentBoundModal("studentEdit", visibleSelectedStudent.id); }} onEvidence={() => { openStudentBoundModal("studentEvidence", visibleSelectedStudent.id); }} onStatus={(status) => updateStudentStatus(visibleSelectedStudent, status)} /> : <aside className="record-preview"><EmptyState title="没有可显示的学生" detail="调整筛选条件后再选择学生。" /></aside>}
        </div>
      </section>
    </>;
  };

  const renderTeachers = () => {
    const viewItems = [
      { id: "available", label: "可接新生", count: recordTeachers.filter((teacher) => teacherSchedulingReadiness(teacher).readyForNewStudentMatching).length },
      { id: "matched", label: "科目符合", count: recordTeachers.filter(teacherSubjectMatch).length },
      { id: "capacity", label: "容量充足", count: recordTeachers.filter((teacher) => {
        const readiness = teacherSchedulingReadiness(teacher);
        return readiness.capacity.status === "ready" && (readiness.capacity.remaining ?? 0) > 0;
      }).length },
      { id: "review", label: "待结构化", count: recordTeachers.filter((teacher) => teacherSchedulingReadiness(teacher).reviewReasons.length > 0).length },
      { id: "all", label: "全部老师", count: recordTeachers.length },
    ];
    const visibleSelectedTeacher = pagedTeachers.find((teacher) => teacher.id === selectedTeacherId) ?? pagedTeachers[0];
    const visibleSelectedTeacherReadiness = visibleSelectedTeacher
      ? teacherSchedulingReadiness(visibleSelectedTeacher)
      : null;
    const visibleSelectedTeacherCompletedLessons = visibleSelectedTeacher
      ? jiaowubaoCompletedLessonsByTeacherId.get(visibleSelectedTeacher.id)
      : undefined;
    return <>
      <ViewHeading eyebrow="老师资源库" title="老师资源库" actions={<button className="primary-button" type="button" disabled={!teacherMatching || !visibleSelectedTeacher || !teacherSubjectMatch(visibleSelectedTeacher)} onClick={() => openNewBooking(undefined, visibleSelectedTeacher?.id)}><CalendarPlus size={17} /> 用当前候选排课</button>} />
      <section className="matching-context"><div><strong>{teacherMatching ? selectedStudent.name : "浏览全部老师"}</strong><small>{teacherMatching ? `${selectedStudent.course} · ${timezoneLabel(selectedStudent.timezone, displayPreferences.language)}` : "按姓名、科目、星期和接新状态筛选"}</small></div><button type="button" onClick={() => setTeacherMatching((value) => !value)}>{teacherMatching ? "退出学生匹配" : `为 ${selectedStudent.name} 匹配`}</button>{teacherMatching && <button type="button" onClick={() => setActive("students")}>更换学生 <ChevronRight size={15} /></button>}</section>
      {visibleSelectedTeacher ? <>
        {isAdminView ? <div className="heading-actions"><button className="secondary-button" type="button" onClick={() => setModal("ava")}><Plus size={16} /> 录入月度 AVA</button></div> : null}
        <TeacherAvailabilityPanel
          key={visibleSelectedTeacher.id}
          teacherId={visibleSelectedTeacher.id}
          teacherName={visibleSelectedTeacher.name}
          windows={visibleSelectedTeacher.availabilityWindows ?? []}
          occupations={scopedBookings.filter((booking) => bookingHasEffectiveTeacher(booking, new Set([visibleSelectedTeacher.id]))).flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate((visibleSelectedTeacher.availabilityWindows ?? []).reduce((date, window) => window.validFrom < date ? window.validFrom : date, isoDateInTimezone(new Date(), scheduleTimezone)), -1), shiftIsoDate((visibleSelectedTeacher.availabilityWindows ?? []).reduce((date, window) => window.validTo > date ? window.validTo : date, isoDateInTimezone(new Date(), scheduleTimezone)), 1))).filter((booking) => booking.teacherId === visibleSelectedTeacher.id).map((booking) => ({ id: booking.occurrenceId, teacherId: booking.teacherId, startsAt: bookingInstant(booking).toISOString(), endsAt: new Date(bookingInstant(booking).getTime() + booking.duration * 60000).toISOString(), label: `${studentById(booking.studentId)?.name ?? "已占用"} · ${booking.course}` }))}
          legacySlots={visibleSelectedTeacher.availabilitySlots ?? []}
          submissions={teacherAvailabilitySubmissions}
          reviewingSubmissionId={teacherAvailabilityReviewBusy}
          reviewInboxBusy={teacherAvailabilityInboxBusy}
          reviewError={teacherAvailabilityReviewError}
          displayTimezone={scheduleTimezone}
          timezoneOptions={timezoneOptions.map((option) => ({ value: option.id, label: displayPreferences.language === "en-AU" ? option.en : option.zh }))}
          referenceDate={isoDateInTimezone(new Date(), scheduleTimezone)}
          onDisplayTimezoneChange={(timezone) => updateDisplayPreferences({ timezone: cleanTimezone(timezone) })}
          onEdit={editTeacherAvailability}
          onDelete={deleteTeacherAvailability}
          onPromoteLegacy={(month) => promoteLegacyTeacherAvailability(visibleSelectedTeacher.id, month)}
          onApproveSubmission={(submission) => void reviewTeacherAvailabilitySubmission(submission, "approved")}
          onRejectSubmission={(submission) => void reviewTeacherAvailabilitySubmission(submission, "rejected")}
          onRefreshSubmissions={() => void refreshTeacherAvailabilitySubmissions()}
        />
      </> : <section className="panel"><EmptyState title="没有可显示的老师 AVA" detail="调整筛选条件后再选择老师。" /></section>}
      <section className="panel collection-shell">
        <ViewTabs value={teacherView} items={viewItems} onChange={(value) => { setTeacherView(value); setTeacherPage(1); }} label="老师保存视图" />
        <ListToolbar query={teacherQuery} onQuery={(value) => { setTeacherQuery(value); setTeacherPage(1); }} placeholder="搜索老师、科目或时区" count={`${filteredTeachers.length} 位老师`}>
          <select className="filter-select" value={teacherSubject} onChange={(event) => { setTeacherSubject(event.target.value); setTeacherPage(1); }} aria-label="按科目筛选"><option value="all">先选科目（匹配必选）</option>{teacherSubjectOptions.map((subject) => <option key={subject}>{subject}</option>)}</select>
          <select className="filter-select" value={teacherDay} onChange={(event) => { setTeacherDay(event.target.value); setTeacherPage(1); }} aria-label="按星期可排筛选"><option value="all">全部星期</option><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select>
          <button className="toolbar-button" type="button" onClick={() => { setTeacherQuery(""); setTeacherSubject("all"); setTeacherDay("all"); setTeacherView("available"); }}><Filter size={15} /> 清除筛选</button>
        </ListToolbar>
        <div className="master-detail-layout teacher-layout">
          <article className="collection-main">
            <div className="collection-head teacher-grid-row"><span>老师 / 科目</span><span>匹配</span><span>已排 / 容量</span><span>AVA</span><span>状态</span></div>
            <div className="collection-viewport">
              {pagedTeachers.length ? pagedTeachers.map((teacher) => {
                const ava = availabilitySummary(teacher);
                const capacity = teacherCapacitySummary(teacher);
                return <button className={`collection-row teacher-grid-row ${visibleSelectedTeacher?.id === teacher.id ? "selected" : ""}`} type="button" key={teacher.id} onClick={() => { setSelectedTeacherId(teacher.id); setMobilePreview("teacher"); }}><span className="table-person"><Avatar initials={teacher.initials} tone={teacher.acceptsStudents ? "green" : "neutral"} /><span><strong>{teacher.name}</strong><small>{teacher.subjects.slice(0, 2).join(" · ")}</small></span></span><strong className="match-score">{teacherSubject === "all" ? "待选科目" : teacherSubjectMatch(teacher) ? "科目符合" : "不符合"}</strong><span className="teacher-load"><strong className={teacher.newStudentCapacity === 0 ? "low-hours" : ""}>{capacity.value}</strong><small>{capacity.detail}</small></span><span className={`teacher-availability ${ava.raw ? "raw" : ""}`}><strong>{ava.title}</strong><small>{ava.detail}</small></span><StatusPill tone={teacher.acceptsStudents ? "green" : teacher.availabilityStatus === "待确认" ? "amber" : "neutral"}>{teacher.availabilityStatus ?? (teacher.acceptsStudents ? "可接新生" : "暂停接新")}</StatusPill></button>;
              }) : <EmptyState title="没有匹配的老师" detail="切换视图或清除搜索条件。" />}
            </div>
            <Pagination page={safeTeacherPage} total={filteredTeachers.length} pageSize={teacherPageSize} onPage={(page) => { setTeacherPage(page); setMobilePreview(null); }} />
          </article>
          {visibleSelectedTeacher ? <aside className={`record-preview teacher-preview ${mobilePreview === "teacher" ? "mobile-detail-open" : ""}`}><button className="mobile-preview-close" type="button" aria-label="关闭老师详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回老师列表</button><div className="detail-top"><Avatar initials={visibleSelectedTeacher.initials} tone={visibleSelectedTeacher.acceptsStudents ? "green" : "neutral"} /><div><h2>{visibleSelectedTeacher.name}</h2><StatusPill tone={visibleSelectedTeacher.acceptsStudents ? "green" : visibleSelectedTeacher.availabilityStatus === "待确认" ? "amber" : "neutral"}>{visibleSelectedTeacher.availabilityStatus ?? (visibleSelectedTeacher.acceptsStudents ? "可接新生" : "暂停接新")}</StatusPill></div></div><div className="match-hero"><span>科目匹配</span><strong>{teacherSubject === "all" ? "请先选择科目" : teacherSubjectMatch(visibleSelectedTeacher) ? `符合：${teacherSubject}` : `不符合：${teacherSubject}`}</strong></div>{visibleSelectedTeacherCompletedLessons && jiaowubaoCompletedLessonFeed?.state === "complete" ? <div className="detail-section"><span>{jiaowubaoCompletedLessonFeed.month} 教务宝已消课（只读核对）</span><strong>{visibleSelectedTeacherCompletedLessons.sourceHours === null ? "课时待核对" : formatHours(visibleSelectedTeacherCompletedLessons.sourceHours)} · {visibleSelectedTeacherCompletedLessons.sourceLessonCount} 节课</strong><p>{visibleSelectedTeacherCompletedLessons.studentLineCount} 条学生明细；老师课时仅来自已消课排课角色字段，不按小组学生数重复计薪。{visibleSelectedTeacherCompletedLessons.unresolvedLessonCount > 0 || visibleSelectedTeacherCompletedLessons.unresolvedTrialLessonCount > 0 ? " 该老师仍有来源待核对，不能锁定薪资。" : ""}</p></div> : null}<div className="detail-section"><span>可教科目</span><div className="teacher-tags">{visibleSelectedTeacher.subjects.map((subject) => <span key={subject}>{subject}</span>)}</div>{visibleSelectedTeacher.subjectDetail ? <p>{visibleSelectedTeacher.subjectDetail}</p> : null}</div><div className="detail-section split"><div><span>地区 / 时区</span><strong>{visibleSelectedTeacher.location ?? "待确认"} · {timezoneLabel(visibleSelectedTeacher.timezone, displayPreferences.language)}</strong></div><div><span>已排 / 可接总数</span><strong className={visibleSelectedTeacher.newStudentCapacity === 0 ? "low-hours" : ""}>{teacherCapacitySummary(visibleSelectedTeacher).value}</strong><p>{teacherCapacitySummary(visibleSelectedTeacher).detail}</p></div></div>{visibleSelectedTeacherReadiness && !visibleSelectedTeacherReadiness.readyForNewStudentMatching ? <div className="form-notice"><CircleAlert size={16} /> 当前不能进入新生匹配：{visibleSelectedTeacherReadiness.reviewReasons.map((reason) => ({ availability_missing: "缺少结构化 AVA", availability_expired: "AVA 已过期", availability_invalid: "AVA 数据无效", capacity_missing: "容量未配置", capacity_invalid: "AVA 数据无效", accepting_status_missing: "接新状态待确认" })[reason]).join("、") || "当前暂停接新或容量为 0"}</div> : null}<button className="primary-button full" type="button" disabled={!teacherMatching || !visibleSelectedTeacherReadiness?.readyForNewStudentMatching || !teacherSubjectMatch(visibleSelectedTeacher)} onClick={() => assignTeacher(visibleSelectedTeacher)}><Check size={16} /> 选择为候选老师</button>{isAdminView && <><button className="secondary-button full" type="button" onClick={() => { setTeacherCapacityDraft(visibleSelectedTeacher); setModal("teacherCapacity"); }}>调整可接新生数量</button><button className="secondary-button full" type="button" onClick={() => toggleTeacherAvailability(visibleSelectedTeacher)}>{visibleSelectedTeacher.acceptsStudents ? "暂停接新" : "开放接新"}</button></>}</aside> : <aside className="record-preview"><EmptyState title="没有可显示的老师" detail="调整筛选条件后再选择老师。" /></aside>}
        </div>
      </section>
    </>;
  };

  const renderCourses = () => {
    const normalizedQuery = courseQuery.trim().toLowerCase();
    const filteredCourses = coursePackageCatalogScope.catalog.filter((course) => course.name.toLowerCase().includes(normalizedQuery));
    const hasActiveCourseBookingStudent = coursePackageCatalogScope.activeStudentIds.size > 0;
    const pageSize = 12;
    const safePage = Math.min(coursePage, Math.max(1, Math.ceil(filteredCourses.length / pageSize)));
    const pagedCourses = filteredCourses.slice((safePage - 1) * pageSize, safePage * pageSize);
    const selectedCourse = pagedCourses.find((course) => course.id === selectedCourseId) ?? pagedCourses[0];
    return <>
      <ViewHeading eyebrow="课程与课包" title="课程与课包" />
      <section className="panel collection-shell">
        <ListToolbar query={courseQuery} onQuery={(value) => { setCourseQuery(value); setCoursePage(1); }} placeholder="搜索课程名称" count={`${filteredCourses.length} 门可见课程`}>
          <button className="toolbar-button" type="button" onClick={() => { setCourseQuery(""); setCoursePage(1); }}><Filter size={15} /> 清除筛选</button>
        </ListToolbar>
        <div className="master-detail-layout course-layout">
          <article className="collection-main">
            <div className="collection-head course-grid-row"><span>课程名称</span><span>排课</span></div>
            <div className="collection-viewport">{pagedCourses.map((course) => <button
              className={`collection-row course-grid-row ${selectedCourse?.id === course.id ? "selected" : ""}`}
              type="button"
              title={course.name}
              key={course.id}
              onClick={(event) => { courseDetailOpener.current = event.currentTarget; setSelectedCourseId(course.id); setMobilePreview("course"); }}
            >
              <span><strong>{course.name}</strong></span>
              <strong>{course.bookingCount} 节</strong>
            </button>)}</div>
            <Pagination page={safePage} total={filteredCourses.length} pageSize={pageSize} onPage={setCoursePage} />
          </article>
          {selectedCourse ? <aside className={`record-preview course-preview ${mobilePreview === "course" ? "mobile-detail-open" : ""}`} aria-label="课程与课包详情">
            <MobileDetailBackButton open={mobilePreview === "course"} opener={courseDetailOpener} onClose={() => setMobilePreview(null)}>返回课程列表</MobileDetailBackButton>
            <div className="preview-header"><div><h2>{selectedCourse.name}</h2></div></div>
            <CoursePackageSummary course={selectedCourse} onOpenStudentPackage={openCourseStudentPackage} />
            {selectedCourse.bookingCount > 0
              ? <button className="primary-button full" type="button" onClick={() => setActive("schedule")}><CalendarDays size={16} /> 查看可见排课</button>
              : hasActiveCourseBookingStudent
              ? <button className="secondary-button full" type="button" onClick={() => openNewBooking()}><CalendarPlus size={16} /> 新建排课</button>
              : <p className="form-notice">当前身份暂无可操作的活跃学生，不能新建排课。</p>}
          </aside> : <EmptyState title="没有课程记录" detail="清除搜索条件后重试。" />}
        </div>
      </section>
    </>;
  };

  const [scheduleMinute, setScheduleMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    if (active !== "schedule" && active !== "classroom") return;
    let timer = 0;
    const tick = () => {
      const now = Date.now();
      setScheduleMinute(Math.floor(now / 60_000));
      timer = window.setTimeout(tick, 60_000 - now % 60_000 + 25);
    };
    timer = window.setTimeout(tick, 60_000 - Date.now() % 60_000 + 25);
    return () => window.clearTimeout(timer);
  }, [active]);
  const scheduleProjection = useMemo(() => {
    if (active !== "schedule") return null;
    const now = new Date(scheduleMinute * 60_000);
    const todayInScheduleTimezone = isoDateInTimezone(now, scheduleTimezone);
    const attendanceMonthWindow = scheduleMonthWindow(todayInScheduleTimezone.slice(0, 7));
    const lastSevenDaysStart = shiftIsoDate(todayInScheduleTimezone, -6);
    const attendanceRangeStart = lastSevenDaysStart < attendanceMonthWindow.monthStart
      ? lastSevenDaysStart
      : attendanceMonthWindow.monthStart;
    const effectiveAttendanceTeacherId = isTeacherView
      ? currentTeacher?.id ?? ""
      : scheduleTeacherFilter;
    const visibleToSignedTeacher = (booking: BookingOccurrence) => !isTeacherView
      || currentTeacherIds.has(booking.teacherId);
    const attendanceOccurrences = scopedBookings
      .flatMap((booking) => bookingOccurrencesWithinRange(
        booking,
        shiftIsoDate(attendanceRangeStart, -1),
        shiftIsoDate(attendanceMonthWindow.monthEnd, 1),
        true,
      ))
      .filter((booking) => visibleToSignedTeacher(booking)
        && (effectiveAttendanceTeacherId === "all"
          || booking.teacherId === effectiveAttendanceTeacherId))
      .map((booking) => ({
        occurrenceId: booking.occurrenceKey,
        date: booking.date,
        start: booking.start,
        timezone: booking.timezone,
        studentId: booking.studentId,
        status: booking.occurrenceStatus,
      }));
    const lastSevenDaysAttendance = summarizeScheduleAttendance(attendanceOccurrences, {
      rangeStart: lastSevenDaysStart,
      rangeEnd: todayInScheduleTimezone,
      now,
      reportingTimezone: scheduleTimezone,
    });
    const monthAttendance = summarizeScheduleAttendance(attendanceOccurrences, {
      rangeStart: attendanceMonthWindow.monthStart,
      rangeEnd: attendanceMonthWindow.monthEnd,
      now,
      reportingTimezone: scheduleTimezone,
    });
    const weekDays = weekDatesForTimezone(scheduleTimezone, displayPreferences);
    const weekRangeLabel = `${formatDisplayDate(new Date(`${weekDays[0]?.date}T12:00:00Z`), scheduleTimezone, displayPreferences)} - ${formatDisplayDate(new Date(`${weekDays.at(-1)?.date}T12:00:00Z`), scheduleTimezone, displayPreferences)}`;
    const weekDateSet = new Set(weekDays.map((day) => day.date));
    const weekOccurrences = scheduleMode === "month" ? [] : scopedBookings
      .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(weekDays[0].date, -1), shiftIsoDate(weekDays.at(-1)!.date, 1)))
      .filter(visibleToSignedTeacher)
      .filter((booking) => {
        const local = zonedParts(bookingInstant(booking), scheduleTimezone);
        return weekDateSet.has(`${local.year}-${local.month}-${local.day}`);
      });
    const monthWindow = scheduleMonthWindow(scheduleMonth);
    const monthOccurrences = scheduleMode !== "month" ? [] : scopedBookings.flatMap((booking) => bookingOccurrencesWithinRange(
      booking,
      shiftIsoDate(monthWindow.gridStart, -1),
      shiftIsoDate(monthWindow.gridEnd, 1),
    )).filter(visibleToSignedTeacher);
    const scheduleTeacher = scheduleTeacherFilter === "all"
      ? undefined
      : recordTeachers.find((teacher) => teacher.id === scheduleTeacherFilter);
    const monthTeacherBookings = scheduleTeacher
      ? monthOccurrences.filter((booking) => booking.teacherId === scheduleTeacher.id && !["cancelled", "leave"].includes(booking.occurrenceStatus))
      : [];
    const monthJiaowubaoAvailabilityBlocks = jiaowubaoImportedScheduleLoading
      ? []
      : jiaowubaoImportedAvailabilityBlocksForTeacher(currentJiaowubaoImportedSchedule, scheduleTeacher?.id);
    let monthAvailability: ScheduleMonthAvailability[] = [];
    if (scheduleTeacher && scheduleMode === "month") {
      try {
        const confirmedAvailability = expandTeacherAvailability(scheduleTeacher.availabilityWindows ?? [], {
          from: monthWindow.gridStart,
          to: monthWindow.gridEnd,
          displayTimezone: scheduleTimezone,
        });
        const freeAvailability = subtractBookedFromAvailability(
          confirmedAvailability.map((entry) => ({ id: entry.id, startsAt: entry.startsAt, endsAt: entry.endsAt })),
          monthTeacherBookings.map((booking) => ({
            id: booking.occurrenceKey,
            startsAt: bookingInstant(booking).toISOString(),
            endsAt: new Date(bookingInstant(booking).getTime() + booking.duration * 60_000).toISOString(),
          })).concat(monthJiaowubaoAvailabilityBlocks),
          scheduleTimezone,
        );
        monthAvailability = freeAvailability.map((entry) => ({
          occurrenceId: entry.occurrenceId,
          date: entry.date,
          displayTime: `${formatClock(new Date(entry.startsAt), scheduleTimezone, displayPreferences)}–${formatClock(new Date(entry.endsAt), scheduleTimezone, displayPreferences)}`,
        }));
      } catch {
        monthAvailability = [];
      }
    }
    const sourceOccurrences = scheduleMode === "month" ? monthOccurrences : weekOccurrences;
    const startTimes = new Map(sourceOccurrences.map((booking) => [booking.occurrenceKey, bookingInstant(booking).getTime()]));
    const dstRiskIds = new Set(dstRiskBookings.map((booking) => booking.id));
    const filteredBookings = sourceOccurrences.filter((booking) => {
      const matchesTeacher = scheduleTeacherFilter === "all" || booking.teacherId === scheduleTeacherFilter;
      const matchesStatus = scheduleFilter === "pending" ? booking.status === "待确认" : scheduleFilter === "trial" ? booking.kind === "试听" : scheduleFilter === "dst" ? dstRiskIds.has(booking.id) : true;
      if (!matchesTeacher || !matchesStatus || scheduleMode === "month" || scheduleDay === "all") return matchesTeacher && matchesStatus;
      const local = zonedParts(bookingInstant(booking), scheduleTimezone);
      return `${local.year}-${local.month}-${local.day}` === scheduleDay;
    }).sort((a, b) => startTimes.get(a.occurrenceKey)! - startTimes.get(b.occurrenceKey)!);
    const monthLessons: ScheduleMonthLesson[] = filteredBookings.map((booking) => ({
      occurrenceId: booking.occurrenceKey,
      date: booking.date,
      start: booking.start,
      timezone: booking.timezone,
      studentId: booking.studentId,
      status: booking.occurrenceStatus,
      studentName: studentsById.get(booking.studentId)?.name ?? booking.studentId,
      teacherName: teachersById.get(booking.teacherId)?.name ?? booking.teacherId,
      courseLabel: booking.course ?? booking.kind,
      displayTime: formatClock(bookingInstant(booking), scheduleTimezone, displayPreferences),
    }));
    return { todayInScheduleTimezone, lastSevenDaysAttendance, monthAttendance, weekDays, weekRangeLabel, scheduleTeacher, monthAvailability, filteredBookings, monthLessons };
  }, [active, scheduleMinute, scheduleTimezone, scheduleMonth, scheduleMode, scheduleTeacherFilter, scheduleFilter, scheduleDay, isTeacherView, currentTeacher, currentTeacherIds, scopedBookings, recordTeachers, displayPreferences, dstRiskBookings, jiaowubaoImportedScheduleLoading, currentJiaowubaoImportedSchedule, studentsById, teachersById]);

  const renderSchedule = () => {
    if (!scheduleProjection) return null;
    const { todayInScheduleTimezone, lastSevenDaysAttendance, monthAttendance, weekDays, weekRangeLabel, scheduleTeacher, monthAvailability, filteredBookings, monthLessons } = scheduleProjection;
    const schedulePageSize = 10;
    const safeSchedulePage = Math.min(schedulePage, Math.max(1, Math.ceil(filteredBookings.length / schedulePageSize)));
    const pagedScheduleBookings = filteredBookings.slice((safeSchedulePage - 1) * schedulePageSize, safeSchedulePage * schedulePageSize);
    const visibleWeekDays = scheduleDay === "all" ? weekDays : weekDays.filter((day) => day.date === scheduleDay);
    const currentScheduleScope = scheduleMode === "agenda" ? pagedScheduleBookings : filteredBookings;
    const fallbackScheduleSeries = isTeacherView ? undefined : selectedBookingSeries ?? scopedBookings[0];
    const fallbackScheduleOccurrence = scheduleMode === "month" && fallbackScheduleSeries
      ? bookingOccurrencesWithinRange(fallbackScheduleSeries, fallbackScheduleSeries.date, shiftIsoDate(fallbackScheduleSeries.date, fallbackScheduleSeries.recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS))[0]
      : undefined;
    const displayedBooking = (selectedBookingOccurrenceKey
      ? currentScheduleScope.find((booking) => booking.occurrenceKey === selectedBookingOccurrenceKey)
      : undefined) ?? currentScheduleScope[0] ?? fallbackScheduleOccurrence;
    const displayedBookingSeries = displayedBooking ? scopedBookings.find((booking) => booking.id === displayedBooking.id) ?? displayedBooking : undefined;
    const englishSchedule = displayPreferences.language === "en-AU";
    const monthLabel = dateTimeFormat(localeFor(displayPreferences.language), {
      year: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${scheduleMonth}-01T12:00:00.000Z`));
    const scheduleToolbar = (
      <div className="calendar-toolbar">
        <div className="segmented">
          <button className={scheduleMode === "month" ? "active" : ""} type="button" onClick={() => { setScheduleMode("month"); setScheduleDay("all"); }}>{englishSchedule ? "Month" : "月视图"}</button>
          <button className={scheduleMode === "week" ? "active" : ""} type="button" onClick={() => setScheduleMode("week")}>{englishSchedule ? "Week" : "周视图"}</button>
          <button className={scheduleMode === "agenda" ? "active" : ""} type="button" onClick={() => { setScheduleMode("agenda"); setSchedulePage(1); }}>{englishSchedule ? "List" : "日程列表"}</button>
        </div>
        <strong>{scheduleMode === "month" ? monthLabel : weekRangeLabel}</strong>
        <div className="toolbar-actions">
          {scheduleMode === "month" ? (
            <div className="month-navigation">
              <button className="icon-button" type="button" aria-label={englishSchedule ? "Previous month" : "上个月"} onClick={() => setScheduleMonth((current) => shiftScheduleMonth(current, -1))}><ChevronLeft size={16} /></button>
              <button type="button" onClick={() => setScheduleMonth(todayInScheduleTimezone.slice(0, 7))}>{englishSchedule ? "Today" : "本月"}</button>
              <button className="icon-button" type="button" aria-label={englishSchedule ? "Next month" : "下个月"} onClick={() => setScheduleMonth((current) => shiftScheduleMonth(current, 1))}><ChevronRight size={16} /></button>
            </div>
          ) : (
            <select className="filter-select" value={scheduleDay} onChange={(event) => { setScheduleDay(event.target.value); setSchedulePage(1); }} aria-label={englishSchedule ? "Schedule date" : "排课日期筛选"}>
              <option value="all">{englishSchedule ? "All dates" : "全部日期"}</option>
              {weekDays.map((day) => <option value={day.date} key={day.date}>{day.label}</option>)}
            </select>
          )}
          {scheduleMode === "week" ? <select className="filter-select" value={scheduleDensity} onChange={(event) => updateDisplayPreferences({ density: event.target.value as DisplayPreferences["density"] })} aria-label={englishSchedule ? "Week view density" : "周视图显示密度"}><option value="comfortable">{englishSchedule ? "Comfortable" : "放大显示"}</option><option value="compact">{englishSchedule ? "Compact" : "紧凑显示"}</option></select> : null}
          <select className="filter-select" value={scheduleTimezone} onChange={(event) => { updateDisplayPreferences({ timezone: cleanTimezone(event.target.value) }); setSchedulePage(1); }} aria-label={englishSchedule ? "Schedule timezone" : "排课显示时区"}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{englishSchedule ? `Time zone: ${option.en}` : `时区：${option.zh}`}</option>)}</select>
          <select className="filter-select" value={scheduleTeacherFilter} onChange={(event) => { setScheduleTeacherFilter(event.target.value); setSchedulePage(1); }} aria-label={englishSchedule ? "Teacher schedule and availability" : "按老师查看课表与空余 AVA"}><option value="all">{englishSchedule ? "All teachers" : "全部老师"}</option>{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name}</option>)}</select>
          <select className="filter-select" value={scheduleFilter} onChange={(event) => { setScheduleFilter(event.target.value); setSchedulePage(1); }} aria-label={englishSchedule ? "Schedule filter" : "排课筛选"}><option value="all">{englishSchedule ? "All lessons" : "全部课程"}</option><option value="pending">{englishSchedule ? "Pending" : "待确认"}</option><option value="trial">{englishSchedule ? "Trials only" : "仅试听"}</option><option value="dst">{englishSchedule ? "DST review" : "夏令时需复核"}</option></select>
        </div>
      </div>
    );
    const scheduleAttendancePanel = (
      <section className="schedule-attendance-strip" aria-label={englishSchedule ? "Attendance summary" : "出勤率统计"}>
        {[
          { label: englishSchedule ? "Last 7 days" : "近 7 天", summary: lastSevenDaysAttendance },
          { label: englishSchedule ? "This month" : "本月", summary: monthAttendance },
        ].map(({ label, summary }) => <article key={label}>
          <span>{label}</span>
          <strong>{summary.rate === null ? "—" : `${summary.rate}%`}</strong>
          <small>{englishSchedule ? `Present ${summary.present} / scheduled ${summary.scheduled}` : `出勤 ${summary.present} / 应到 ${summary.scheduled}`}</small>
          {summary.unresolved > 0 ? <em>{englishSchedule ? `${summary.unresolved} lesson${summary.unresolved === 1 ? "" : "s"} pending review` : `${summary.unresolved} 节待核对`}</em> : null}
        </article>)}
      </section>
    );
    const importedSchedulePanel = (
      <JiaowubaoImportedSchedulePanel
        feed={currentJiaowubaoImportedSchedule}
        loading={jiaowubaoImportedScheduleLoading}
        error={jiaowubaoImportedScheduleErrorCode ?? jiaowubaoImportedScheduleError}
        timezone={scheduleTimezone}
        language={displayPreferences.language}
        studentNameForId={(studentId) => studentById(studentId)?.name}
        teacherNameForId={(teacherId) => teacherById(teacherId)?.name}
      />
    );
    if (!scopedBookings.length) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "我的排课" : "排课"} title={isTeacherView ? "我的排课" : "排课"} actions={<button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button>} />
        <section className="panel schedule-shell">{scheduleToolbar}{scheduleAttendancePanel}{importedSchedulePanel}{!jiaowubaoImportedScheduleLoading ? <EmptyState title="暂无排课" detail="新建约课后会显示在这里。" /> : null}</section>
      </>;
    }
    if (!displayedBooking || !displayedBookingSeries) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "我的排课" : "排课"} title={isTeacherView ? "我的排课" : "排课"} actions={<><button className="secondary-button" type="button" onClick={() => { setScheduleFilter("all"); setScheduleDay("all"); setSchedulePage(1); }}>清除排课筛选</button><button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button></>} />
        <section className="panel schedule-shell">{scheduleToolbar}{scheduleAttendancePanel}{importedSchedulePanel}{!jiaowubaoImportedScheduleLoading ? <EmptyState title="当前筛选下没有排课" detail="清除筛选后再试。" /> : null}</section>
      </>;
    }
    const bookingStudent = studentById(displayedBooking.studentId);
    const bookingTeacher = teacherById(displayedBooking.teacherId);
    if (!bookingStudent || !bookingTeacher) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "我的排课" : "排课"} title={isTeacherView ? "我的排课" : "排课"} actions={<button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button>} />
        <section className="panel schedule-shell">{scheduleToolbar}{scheduleAttendancePanel}{importedSchedulePanel}<EmptyState title="课程关联资料不完整" detail="课程缺少有效的学生或老师关联，请先修复后再排课。" /></section>
      </>;
    }
    const selectedInstant = bookingInstant(displayedBooking);
    const selectedDstRisk = bookingHasDstRisk(displayedBookingSeries, bookingStudent, bookingTeacher);
    const historicalBooking = isPastBooking(displayedBooking);
    const openMonthLesson = (lesson: ScheduleMonthLesson) => {
      const booking = filteredBookings.find((entry) => entry.occurrenceKey === lesson.occurrenceId);
      if (!booking) return;
      selectBookingRecord(booking, "booking");
    };
    return <>
      <ViewHeading eyebrow={isTeacherView ? "我的排课" : "排课"} title={isTeacherView ? "我的排课" : "排课"} actions={<button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button>} />
      <section className="panel schedule-shell">
        {scheduleToolbar}
        {scheduleAttendancePanel}
        {dstRiskBookings.length ? <div className="timezone-audit warning"><Clock3 size={17} /><span><strong>{dstRiskBookings.length} 节长期课的师生时差会在未来 140 天内变化</strong></span></div> : null}
        <div className="master-detail-layout schedule-layout">
          <article className="collection-main schedule-main">
            {scheduleMode === "month" ? (
              <ScheduleMonthView
                month={scheduleMonth}
                displayTimezone={scheduleTimezone}
                language={displayPreferences.language}
                lessons={monthLessons}
                availability={monthAvailability}
                availabilityTeacherName={scheduleTeacher?.name}
                selectedOccurrenceId={displayedBooking.occurrenceKey}
                onSelect={openMonthLesson}
              />
            ) : scheduleMode === "week" ? (
              <div className={`week-board ${scheduleDensity} ${visibleWeekDays.length === 1 ? "single-day" : ""}`}>
                {visibleWeekDays.map((day) => {
                  const dayBookings = filteredBookings.filter((booking) => {
                    const local = zonedParts(bookingInstant(booking), scheduleTimezone);
                    return `${local.year}-${local.month}-${local.day}` === day.date;
                  });

                  return (
                    <section className="week-day" key={day.date}>
                      <header>
                        <span><strong>{day.label}</strong><small>{timezoneLabel(scheduleTimezone, displayPreferences.language)}</small></span>
                        <b>{dayBookings.length} {displayPreferences.language === "en-AU" ? "lessons" : "节"}</b>
                      </header>
                      <div className="week-day-events">
                        {dayBookings.length ? dayBookings.map((booking) => {
                          const student = studentById(booking.studentId);
                          const teacher = teacherById(booking.teacherId);
                          const displayTime = formatClock(bookingInstant(booking), scheduleTimezone, displayPreferences);

                          return (
                            <button
                              className={`week-event ${displayedBooking.id === booking.id && displayedBooking.date === booking.date ? "selected" : ""} ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`}
                              key={booking.occurrenceKey}
                              type="button"
                              onClick={() => { selectBookingRecord(booking, "booking"); }}
                            >
                              <span><strong>{displayTime}</strong><small>{booking.duration} {displayPreferences.language === "en-AU" ? "min" : "分钟"}</small></span>
                              <b>{student?.name}</b>
                              <small>{booking.course ?? booking.kind}</small>
                              <em>{teacher?.name}</em>
                            </button>
                          );
                        }) : <div className="week-day-empty">{displayPreferences.language === "en-AU" ? "No matching lessons today" : "当天没有符合条件的课程"}</div>}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="agenda-list">
                {selectedBookingIds.length > 0 && <div className="bulk-bar"><strong>已选 {selectedBookingIds.length} 个课程系列</strong><button type="button" onClick={() => bulkUpdateBookingStatus("待确认")}>设为待确认</button><button type="button" onClick={() => bulkUpdateBookingStatus("已确认")}>设为已确认</button><button className="bulk-clear" type="button" onClick={() => setSelectedBookingIds([])}>取消选择</button></div>}
                <div className="collection-head agenda-select-grid">
                  <label className="selection-control">
                    <input type="checkbox" aria-label="选择本页全部课程系列；周期课会整组更新" checked={pagedScheduleBookings.length > 0 && pagedScheduleBookings.every((booking) => selectedBookingIds.includes(booking.id))} onChange={(event) => setSelectedBookingIds((current) => event.target.checked ? Array.from(new Set([...current, ...pagedScheduleBookings.map((booking) => booking.id)])) : current.filter((idValue) => !pagedScheduleBookings.some((booking) => booking.id === idValue)))} />
                  </label>
                  <span>显示时间</span><span>学生 / 课程</span><span>老师</span><span>类型</span><span>状态</span>
                </div>
                <div className="collection-viewport">
                  {pagedScheduleBookings.length ? pagedScheduleBookings.map((booking) => {
                    const student = studentById(booking.studentId);
                    const teacher = teacherById(booking.teacherId);
                    const instant = bookingInstant(booking);
                    const bookingSeries = scopedBookings.find((entry) => entry.id === booking.id) ?? booking;
                    const hasRisk = student && teacher ? bookingHasDstRisk(bookingSeries, student, teacher) : false;

                    return <div className={`collection-row agenda-select-row ${displayedBooking.id === booking.id && displayedBooking.date === booking.date ? "selected" : ""}`} key={booking.occurrenceKey}>
                      <label className="selection-control">
                        <input type="checkbox" aria-label={`选择 ${student?.name ?? "课程"} 的整个课程系列`} title={booking.recurring ? "周期课状态按整个系列更新" : "选择该课程"} checked={selectedBookingIds.includes(booking.id)} onChange={() => toggleBookingSelection(booking.id)} />
                      </label>
                      <button className="agenda-row-main" type="button" onClick={() => { selectBookingRecord(booking, "booking"); }}>
                        <span><strong>{formatInstant(instant, scheduleTimezone, displayPreferences)}</strong><small>{timezoneLabel(scheduleTimezone, displayPreferences.language)} · {booking.duration} {displayPreferences.language === "en-AU" ? "min" : "分钟"}</small></span>
                        <span><strong>{student?.name}</strong><small>{booking.course ?? student?.course}</small></span>
                        <span>{teacher?.name}<small>{timezoneLabel(teacher?.timezone ?? "Australia/Melbourne", displayPreferences.language)}</small></span>
                        <StatusPill tone={booking.kind === "试听" ? "blue" : hasRisk ? "purple" : "green"}>{hasRisk ? "时差复核" : booking.kind}</StatusPill>
                        <StatusPill tone={booking.status === "待确认" ? "amber" : "green"}>{booking.status}</StatusPill>
                      </button>
                    </div>;
                  }) : !jiaowubaoImportedScheduleLoading ? <EmptyState title="当前筛选下没有排课" detail="切换日期或清除课程筛选后再试。" /> : null}
                </div>
                <Pagination page={safeSchedulePage} total={filteredBookings.length} pageSize={schedulePageSize} onPage={setSchedulePage} />
              </div>
            )}
          </article>
          <aside className={`record-preview booking-panel ${mobilePreview === "booking" ? "mobile-detail-open" : ""}`}>
            <button className="mobile-preview-close" type="button" aria-label="关闭课程详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回课程列表</button>
            <div className="panel-header"><div><p className="eyebrow">{historicalBooking ? "历史课程 · 只读" : "课程预览"}</p><h2>{bookingStudent.name}</h2><small>{displayedBooking.course ?? bookingStudent.course}</small></div><StatusPill tone={displayedBooking.occurrenceStatus === "abnormal" ? "red" : historicalBooking ? "blue" : displayedBooking.status === "待确认" ? "amber" : "green"}>{displayedBooking.occurrenceStatus === "abnormal" ? "出勤异常" : historicalBooking ? "已归档" : displayedBooking.status}</StatusPill></div>
            {displayedBooking.occurrenceStatus === "abnormal" ? <div className="check-list warning"><span><CircleAlert size={16} /> 本节双方出勤时长不足或证据缺失，未扣学生课时，也未计老师薪资。</span></div> : null}
            <TimeLine label={`${displayPreferences.language === "en-AU" ? "Student time" : "学生时间"} · ${timezoneLabel(bookingStudent.timezone, displayPreferences.language)}`} time={formatInstant(selectedInstant, bookingStudent.timezone, displayPreferences)} detail={cleanTimezone(bookingStudent.timezone)} />
            <TimeLine label={`${displayPreferences.language === "en-AU" ? "Teacher time" : "老师时间"} · ${timezoneLabel(bookingTeacher.timezone, displayPreferences.language)}`} time={formatInstant(selectedInstant, bookingTeacher.timezone, displayPreferences)} detail={bookingTeacher.name} />
            {selectedDstRisk ? <div className="check-list warning"><span><CircleAlert size={16} /> 长期课未来会发生相对时差变化，需教务复核</span></div> : null}
            {!historicalBooking && displayedBooking.status === "待确认" && <button className="primary-button full" type="button" onClick={() => confirmBookingStatus(displayedBookingSeries, "已确认")}>确认课程</button>}
            {!historicalBooking && <div className="booking-action-grid">
              <button className="secondary-button" type="button" onClick={() => openBookingOccurrenceEditor(displayedBooking)}><Pencil size={15} /> 仅修改本节</button>
              <button className="secondary-button" type="button" onClick={() => openBookingEditor(displayedBookingSeries)}><Pencil size={15} /> 编辑整个课程系列</button>
              {!isTeacherView && <><button className="secondary-button" type="button" onClick={() => openBookingOperation(displayedBooking, "学生请假")}><UserRoundX size={15} /> 学生请假</button>
              <button className="secondary-button" type="button" onClick={() => openBookingOperation(displayedBooking, "老师请假")}><CalendarOff size={15} /> 老师请假</button>
              <button className="secondary-button" type="button" onClick={() => openBookingOperation(displayedBooking, "代课")}><RefreshCw size={15} /> 启动代课</button>
              {!isTeacherView && <button className="danger-button" type="button" onClick={() => deleteBookingSeries(displayedBookingSeries)}><X size={15} /> {displayedBookingSeries.recurring ? "删除整个系列" : "删除课程"}</button>}</>}
            </div>}
            {canViewClassroom ? (historicalBooking ? null : !displayedBooking.classroom?.meetingId ? <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void createClassroom(displayedBooking)}><Video size={16} /> {classroomBusy ? "正在创建…" : "创建在线教室"}</button> : displayedBooking.classroom.status === "ended" ? <button className="secondary-button full" type="button" onClick={() => { setActive("classroom"); setMobilePreview(null); }}><Video size={16} /> 查看录播与课堂记录</button> : <>
              <button className="primary-button full" type="button" disabled={classroomBusy || !canJoinTeacherClassroom} onClick={() => void joinTeacherClassroom(displayedBooking)}><ExternalLink size={16} /> {classroomBusy ? "正在处理…" : canJoinTeacherClassroom ? "老师进入教室" : "等待授课老师进入"}</button>
              <button className="secondary-button full" type="button" disabled={classroomBusy} onClick={() => void copyStudentClassroomLink(displayedBooking)}><Link2 size={16} /> {classroomBusy ? "正在处理…" : "复制学生链接"}</button>
              <button className="secondary-button full" type="button" onClick={() => { setActive("classroom"); setMobilePreview(null); }}><Video size={16} /> 查看教室与录播</button>
            </> ) : null}
            <button className="secondary-button full" type="button" onClick={() => goToStudent(bookingStudent.id)}>{bookingStudent.importArchived ? "查看历史归档档案" : "打开学生档案"}</button>
          </aside>
        </div>
        {importedSchedulePanel}
      </section>
    </>;
  };

  const renderLp = () => {
    const visibleLp = scopedLpItems.filter((item) => lpFilter === "review" ? item.stage === "待审核" : lpFilter === "revision" ? item.stage === "需修改" : lpFilter === "waiting" ? item.stage === "待资料" || item.stage === "待备课确认" : lpFilter === "complete" ? item.stage === "完成" : lpFilter === "active" ? item.stage !== "完成" : true);
    const viewItems = [{ id: "active", label: "进行中", count: scopedLpItems.filter((item) => item.stage !== "完成").length }, { id: "review", label: "待审核", count: scopedLpItems.filter((item) => item.stage === "待审核").length }, { id: "revision", label: "需修改", count: scopedLpItems.filter((item) => item.stage === "需修改").length }, { id: "waiting", label: "等待资料/确认", count: scopedLpItems.filter((item) => item.stage === "待资料" || item.stage === "待备课确认").length }, { id: "complete", label: "已完成", count: scopedLpItems.filter((item) => item.stage === "完成").length }, { id: "all", label: "全部", count: scopedLpItems.length }];
    const stageTone = (stage: LpItem["stage"]): Tone => (stage === "完成" || stage === "备课完成") ? "green" : stage === "需修改" ? "red" : stage === "待审核" ? "amber" : stage === "已发老师" ? "blue" : "purple";
    const openLpCreate = () => {
      setLpDraftStudentId(selectedStudent.id);
      setModal("lp");
    };
    const emptyLpDetail = lpFilter === "active"
      ? "当前身份没有进行中的 LP；可以直接创建一条新的 LP。"
      : "当前保存视图没有符合条件的 LP；可以直接创建一条新的 LP。";
    const stageControls = (item: LpItem, compact = false) => (
      <div className={compact ? "lp-row-actions" : "lp-card-actions"}>
        <button className="icon-button" type="button" disabled={item.stage === lpStages[0]} aria-label="退回上一阶段" title="退回上一阶段" onClick={() => retreatLp(item)}><ChevronLeft size={15} /></button>
        <select className="lp-stage-select" value={item.stage} aria-label={`${item.title} 当前阶段`} onChange={(event) => setLpStage(item, event.target.value as LpItem["stage"])}>
          {lpStages.map((stage) => <option value={stage} key={stage}>{stage}</option>)}
        </select>
        <button className="icon-button" type="button" disabled={item.stage === lpStages.at(-1)} aria-label="推进下一阶段" title="推进下一阶段" onClick={() => advanceLp(item)}><ChevronRight size={15} /></button>
        <button className="icon-button" type="button" aria-label="新增 LP 修订版本" title="新增 LP 修订版本" onClick={() => { setLpRevisionDraft(item); setModal("lpRevision"); }}><Pencil size={15} /></button>
      </div>
    );
    const resultControl = (item: LpItem) => {
      const options = allowedLpResultStatuses(item.workflowType ?? "试听 LP");
      const value = effectiveTrialResultStatus(item) ?? item.resultStatus ?? "";
      return options.length ? <select className="lp-result-select" value={value} aria-label={`${item.title} 业务结果`} onChange={(event) => setLpResult(item, event.target.value ? event.target.value as LpResultStatus : undefined)}>{value ? null : <option value="">业务结果</option>}{options.map((status) => <option value={status} key={status}>{lpResultStatusLabel(status)}</option>)}</select> : null;
    };
    const trialLedgerItems = scopedLpItems.filter((item) => item.workflowType && LP_WORKFLOW_TYPES.includes(item.workflowType));
    const trialLedgerViewInteractive = trialLedgerViewReady && trialLedgerViewOwner === sessionOperator;
    const activeTrialLedgerView = trialLedgerViewInteractive
      ? trialLedgerView
      : defaultTrialLedgerViewState();
    const trialLedgerEntries = trialLedgerItems.map((item) => {
      const student = studentById(item.studentId);
      const liveMatch = trialScheduleMatchByLpId.get(item.id);
      const schedule = liveMatch?.link ?? item.trialSchedule;
      const requestAt = item.trialIntake?.requestSentAt ?? item.requestedAt;
      const resultOptions = allowedLpResultStatuses(item.workflowType ?? "试听 LP");
      const automaticStudentName = liveMatch?.studentName || schedule?.studentName
        || item.trialIntake?.studentName || student?.name || "";
      const automaticGuardianWechat = student?.guardianWechat || student?.guardian || "";
      const automaticScheduledAt = schedule?.startsAt ?? "";
      const effectiveScheduledAt = String(trialLedgerStoredValue(item, "scheduledAt") ?? automaticScheduledAt);
      const automaticLessonMonth = effectiveScheduledAt
        ? isoDateInTimezone(new Date(effectiveScheduledAt), "Australia/Melbourne").slice(0, 7)
        : "";
      const automaticPlanner = item.trialIntake?.planner || String(item.fields?.planner ?? student?.planner ?? "");
      const automaticSubject = String(item.fields?.subject ?? student?.course ?? "");
      const automaticTeacher = schedule?.teacherName || String(item.fields?.assignedTeacher ?? item.fields?.newTeacher ?? item.fields?.substituteTeacher ?? item.fields?.teacher ?? student?.teacher ?? "");
      const automaticPaid = ["付费试听（已付费）", "在读学生付费试听"]
        .includes(String(item.fields?.trialPaymentMethod ?? ""));
      const storedPaid = trialLedgerStoredValue(item, "trialPaid");
      return {
        item,
        schedule,
        requestAt,
        resultOptions,
        automaticStudentName,
        automaticGuardianWechat,
        automaticScheduledAt,
        automaticLessonMonth,
        automaticPlanner,
        automaticSubject,
        automaticTeacher,
        automaticPaid,
        storedPaid,
        row: {
          id: item.id,
          studentName: String(trialLedgerStoredValue(item, "studentName") ?? automaticStudentName),
          guardianWechat: String(trialLedgerStoredValue(item, "guardianWechat") ?? automaticGuardianWechat),
          workflowType: String(trialLedgerStoredValue(item, "workflowType") ?? item.workflowType ?? "试听 LP"),
          lessonMonth: String(trialLedgerStoredValue(item, "lessonMonth") ?? automaticLessonMonth),
          requestedAt: String(trialLedgerStoredValue(item, "requestedAt") ?? requestAt ?? ""),
          scheduledAt: effectiveScheduledAt,
          scheduledDate: effectiveScheduledAt
            ? isoDateInTimezone(new Date(effectiveScheduledAt), "Australia/Melbourne")
            : "",
          operationsOwner: String(trialLedgerStoredValue(item, "operationsOwner") ?? item.owner),
          planner: String(trialLedgerStoredValue(item, "planner") ?? automaticPlanner),
          subject: String(trialLedgerStoredValue(item, "subject") ?? automaticSubject),
          teacher: String(trialLedgerStoredValue(item, "teacher") ?? automaticTeacher),
          resultStatus: isTrialLedgerWorkflow(item) ? effectiveTrialResultStatus(item) ?? "试听未进行" : item.resultStatus ?? "",
          paid: typeof storedPaid === "boolean" ? storedPaid : automaticPaid,
          note: String(trialLedgerStoredValue(item, "trialLedgerNote") ?? (isTrialLedgerWorkflow(item) ? "" : item.fields?.specialNotes ?? item.fields?.modificationRequirements ?? item.fields?.handoverNotes ?? item.fields?.enrollmentHandoverNotes ?? "")),
        },
      };
    });
    const trialLedgerEntryById = new Map(trialLedgerEntries.map((entry) => [entry.item.id, entry]));
    const filteredTrialLedgerRows = filterAndSortTrialLedgerRows(
      trialLedgerEntries.map((entry) => entry.row),
      activeTrialLedgerView,
    );
    const visibleTrialLedgerEntries = filteredTrialLedgerRows
      .map((row) => trialLedgerEntryById.get(row.id))
      .filter((entry): entry is (typeof trialLedgerEntries)[number] => Boolean(entry));
    const trialLedgerStats = trialLedgerViewStats(filteredTrialLedgerRows);
    const trialLedgerFilterOptions = (
      key: "lessonMonth" | "operationsOwner" | "planner" | "subject" | "teacher",
    ) => trialLedgerViewFilterOptions(trialLedgerEntries.map((entry) => entry.row), activeTrialLedgerView, key);
    const updateTrialLedgerView = (patch: Partial<TrialLedgerViewState>) => {
      setTrialLedgerView((current) => parseTrialLedgerViewState({ ...current, ...patch }));
    };
    const clearTrialLedgerDraft = (...keys: string[]) => setTrialLedgerDrafts((current) => {
      if (!keys.some((key) => Object.hasOwn(current, key))) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
    const saveTrialLedgerDraft = async (
      item: LpItem,
      field: TrialLedgerField,
      key: string,
      rawValue: string,
      timezone?: string,
    ) => {
      let value: TrialLedgerFieldValue | undefined = rawValue.trim() || undefined;
      if (value && timezone) {
        const [date, time] = String(value).split("T");
        if (!date || !time) throw new Error("请选择完整日期和时间");
        value = zonedDateTimeToUtc(date, time, timezone).toISOString();
      }
      try {
        await saveTrialLedgerFieldAtomic(item, field, value);
        clearTrialLedgerDraft(key);
      } catch (error) {
        notify(error instanceof Error ? error.message : "试听台账保存失败");
      }
    };
    const ledgerTextCell = (input: {
      item: LpItem;
      field: TrialLedgerField;
      automaticValue: string;
      label: string;
      type?: "text" | "month" | "datetime-local";
      timezone?: string;
      list?: string;
      placeholder?: string;
      sourceLabel?: string;
      openStudent?: boolean;
    }) => {
      const stored = trialLedgerStoredValue(input.item, input.field);
      const manual = stored !== undefined;
      const effectiveValue = String(stored ?? input.automaticValue ?? "");
      const inputValue = input.type === "datetime-local" && effectiveValue
        ? dateTimeValueInTimezone(new Date(effectiveValue), input.timezone ?? displayPreferences.timezone)
        : effectiveValue;
      const key = `${input.item.id}:${input.field}`;
      const drafted = Object.hasOwn(trialLedgerDrafts, key);
      const busy = trialLedgerSaving[key] === true;
      return <div className={`ledger-edit-cell ${manual ? "manual" : "automatic"}`}>
        <input
          aria-label={input.label}
          className="ledger-cell-input"
          disabled={busy}
          list={input.list}
          placeholder={input.placeholder}
          type={input.type ?? "text"}
          value={trialLedgerDrafts[key] ?? inputValue}
          onChange={(event) => setTrialLedgerDrafts((current) => ({ ...current, [key]: event.target.value }))}
          onBlur={(event) => { if (drafted || event.target.value !== inputValue) void saveTrialLedgerDraft(input.item, input.field, key, event.target.value, input.timezone); }}
        />
        <span className="ledger-cell-meta">
          <small>{busy ? "保存中…" : manual ? "手动值" : input.sourceLabel ?? "自动填充"}</small>
          {manual && <button type="button" disabled={busy} onClick={() => {
            void saveTrialLedgerFieldAtomic(input.item, input.field, undefined)
              .then(() => clearTrialLedgerDraft(key))
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "恢复自动值失败"));
          }}>恢复自动</button>}
          {input.openStudent && <button type="button" onClick={() => goToStudent(input.item.studentId)}>查看档案 <ExternalLink size={10} /></button>}
        </span>
      </div>;
    };
    const ledgerSelectCell = (input: {
      item: LpItem;
      field: TrialLedgerField;
      automaticValue: string;
      label: string;
      options: readonly string[];
    }) => {
      const stored = trialLedgerStoredValue(input.item, input.field);
      const key = `${input.item.id}:${input.field}`;
      const busy = trialLedgerSaving[key] === true;
      return <div className={`ledger-edit-cell ${stored === undefined ? "automatic" : "manual"}`}>
        <select
          aria-label={input.label}
          className="ledger-cell-input"
          disabled={busy}
          value={stored === undefined ? "" : String(stored)}
          onChange={(event) => {
            void saveTrialLedgerFieldAtomic(input.item, input.field, event.target.value || undefined)
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "试听台账保存失败"));
          }}
        >
          <option value="">自动 · {input.automaticValue || "待填写"}</option>
          {input.options.map((option) => <option value={option} key={option}>{option}</option>)}
        </select>
        <span className="ledger-cell-meta"><small>{busy ? "保存中…" : stored === undefined ? "自动填充" : "手动值"}</small></span>
      </div>;
    };
    const ledgerSchedulePartCell = (input: {
      item: LpItem;
      automaticValue: string;
      part: "date" | "time";
      label: string;
      sourceLabel: string;
    }) => {
      const stored = trialLedgerStoredValue(input.item, "scheduledAt");
      const effectiveValue = String(stored ?? input.automaticValue ?? "");
      const localValue = effectiveValue
        ? dateTimeValueInTimezone(new Date(effectiveValue), "Australia/Melbourne")
        : "";
      const [automaticDate = "", automaticTime = ""] = localValue.split("T");
      const dateKey = `${input.item.id}:scheduledAt:date`;
      const timeKey = `${input.item.id}:scheduledAt:time`;
      const key = input.part === "date" ? dateKey : timeKey;
      const automaticPart = input.part === "date" ? automaticDate : automaticTime;
      const busy = trialLedgerSaving[`${input.item.id}:scheduledAt`] === true;
      const manual = stored !== undefined;
      const savePart = (rawValue: string) => {
        const date = input.part === "date"
          ? rawValue
          : trialLedgerDrafts[dateKey] ?? automaticDate;
        const time = input.part === "time"
          ? rawValue
          : trialLedgerDrafts[timeKey] ?? automaticTime;
        if (!date || !time) return;
        const value = zonedDateTimeToUtc(date, time, "Australia/Melbourne").toISOString();
        void saveTrialLedgerFieldAtomic(input.item, "scheduledAt", value)
          .then(() => clearTrialLedgerDraft(dateKey, timeKey))
          .catch((error: unknown) => notify(error instanceof Error ? error.message : "试听台账保存失败"));
      };
      return <div className={`ledger-edit-cell ${manual ? "manual" : "automatic"}`}>
        <input
          aria-label={input.label}
          className="ledger-cell-input"
          disabled={busy}
          step={input.part === "time" ? 60 : undefined}
          type={input.part}
          value={trialLedgerDrafts[key] ?? automaticPart}
          onChange={(event) => setTrialLedgerDrafts((current) => ({ ...current, [key]: event.target.value }))}
          onBlur={(event) => savePart(event.target.value)}
        />
        <span className="ledger-cell-meta">
          <small>{busy ? "保存中…" : manual ? "手动值" : input.sourceLabel}</small>
          {manual && input.part === "time" && <button type="button" disabled={busy} onClick={() => {
            void saveTrialLedgerFieldAtomic(input.item, "scheduledAt", undefined)
              .then(() => clearTrialLedgerDraft(dateKey, timeKey))
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "恢复自动值失败"));
          }}>恢复自动</button>}
        </span>
      </div>;
    };
    const trialScreenshotAllowed = (item: LpItem) => item.workflowType === "试听 LP" && !isTeacherView && item.stage !== "完成" && item.resultStatus !== "已取消" && Boolean(studentById(item.studentId)) && !studentById(item.studentId)?.importArchived;
    const pendingScheduleLabel = (item: LpItem) => {
      const student = studentById(item.studentId);
      const fields = item.fields ?? {};
      return trialSchedulePendingLabel({
        archived: student?.importArchived,
        stage: item.stage,
        resultStatus: item.resultStatus,
        studentNameConfirmed: [
          student?.jwbMatchStatus === "matched",
          item.trialIntake?.studentName,
          fields.studentNameKnown === true && fields.studentName,
        ].some(Boolean),
        requestAt: item.trialIntake?.requestSentAt ?? item.requestedAt,
        windowStartsAt: trialScheduleWindow.startsAt,
        loading: jiaowubaoImportedScheduleLoading,
        sourceState: currentJiaowubaoImportedSchedule?.state,
      });
    };
    const trialIntakeDetails = (item: LpItem) => {
      if (item.workflowType !== "试听 LP" && item.workflowType !== "换老师试听") return null;
      return <details className="trial-intake-details">
        <summary>查看试听交接详情</summary>
        {trialScreenshotAllowed(item) && <button className="secondary-button" type="button" onClick={() => setTrialScreenshotItem(item)}>补全教务宝小课表</button>}
        <LpWorkflowDetails type={item.workflowType} fields={item.fields ?? {}} />
        <TrialScheduleDetails schedule={trialScheduleMatchByLpId.get(item.id)?.link ?? item.trialSchedule} pendingLabel={pendingScheduleLabel(item)} />
        {item.trialIntake ? <dl>
          <div><dt>规划老师</dt><dd>{item.trialIntake.planner}</dd></div>
          <div><dt>交接时间</dt><dd>{formatInstant(new Date(item.trialIntake.requestSentAt), displayPreferences.timezone, displayPreferences)}</dd></div>
          <div><dt>对接对象</dt><dd>{[item.trialIntake.contactParents ? "家长" : "", item.trialIntake.contactStudent ? "学生本人" : ""].filter(Boolean).join("、")}{item.trialIntake.contactNote ? ` · ${item.trialIntake.contactNote}` : ""}</dd></div>
          <div><dt>写作</dt><dd>{item.trialIntake.writingRequired ? "需要" : "不需要"}{item.trialIntake.writingNote ? ` · ${item.trialIntake.writingNote}` : ""}</dd></div>
          <div><dt>试卷</dt><dd>{item.trialIntake.paperRequired ? "需要发卷并收卷" : "不需要"}{item.trialIntake.paperNote ? ` · ${item.trialIntake.paperNote}` : ""}</dd></div>
          <div><dt>交接试听时长</dt><dd>{item.trialIntake.trialDurationMinutes} 分钟{item.trialIntake.trialDurationNote ? ` · ${item.trialIntake.trialDurationNote}` : ""}</dd></div>
        </dl> : item.workflowType === "试听 LP" ? <p>历史试听 LP 未包含新版手册字段。</p> : null}
      </details>;
    };

    return <>
      <ViewHeading eyebrow="试听与 LP" title="试听与 LP" actions={<>
        {isAdminView && <a className="secondary-button" href="/handover-review">群交接待核对</a>}
        <a className="secondary-button" href={TENCENT_TRIAL_LEDGER_URL} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 腾讯复盘台账</a>
        <button className="secondary-button" type="button" disabled={jiaowubaoImportedScheduleLoading || trialScheduleSyncing} onClick={() => void syncTrialSchedulesFromJiaowubao()}><RefreshCw size={16} /> {trialScheduleSyncing ? "正在核对任务…" : jiaowubaoImportedScheduleLoading ? "正在读取教务宝…" : `后台自动同步 · 立即核对${trialScheduleMatches.length ? ` (${trialScheduleMatches.length})` : ""}`}</button>
        <button className="primary-button" type="button" onClick={openLpCreate}><Plus size={17} /> 创建 LP</button>
      </>} />
      {!isTeacherView && (isAdminView || currentOperator === sessionOperator) && <Suspense fallback={null}><WecomLpDraftWorkspace
        key={sessionOperator}
        timeDisplay={{ timezone: scheduleTimezone, label: timezoneLabel(scheduleTimezone, displayPreferences.language), formatTime: (value) => formatInstant(new Date(value), scheduleTimezone, displayPreferences) }}
        students={readableScopedStudents}
        expectedVersions={{ students: studentsShared.version, lpItems: lpShared.version, tasks: tasksShared.version, files: filesShared.version }}
        fieldOptions={{
          responsibleOperationsOptions: operationsOwnerFormOptions(currentOperator).map((value) => ({ value })),
          teacherOptions: recordTeachers.map((teacher) => ({ value: teacher.name, label: teacher.name })),
          subjectOptions: courses.map((course) => ({ value: course.name })),
          timezoneOptions: timezoneOptions.map((option) => ({ value: option.id, label: option.label })),
          plannerOptions: [{ value: "Tara", label: "龙老师" }, { value: "Eileen" }, { value: "Abby" }],
        }}
        Dialog={Dialog}
        notify={notify}
        onCommitted={(body) => {
          studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
          lpShared.applyRemote(body.lpItemsRow as RemoteStateRow<LpItem[]>);
          tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
          filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
          showCommittedLpView(body.lpItemId);
          setSelectedStudentId(body.studentId);
        }}
      /></Suspense>}
      {trialScreenshotItem && !isTeacherView && scopedLpItems.some((item) => item.id === trialScreenshotItem.id && trialScreenshotAllowed(item)) && <Suspense fallback={null}><TrialScreenshotConfirmWorkspace
        key={`${sessionOperator}:${trialScreenshotItem.id}`}
        item={trialScreenshotItem}
        studentName={studentById(trialScreenshotItem.studentId)?.name ?? "姓名待补"}
        expectedVersions={{ students: studentsShared.version, lpItems: lpShared.version, tasks: tasksShared.version }}
        Dialog={Dialog}
        notify={notify}
        onClose={() => setTrialScreenshotItem(null)}
        onCommitted={(body) => {
          lpShared.applyRemote(body.lpItemsRow as RemoteStateRow<LpItem[]>);
          tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
        }}
      /></Suspense>}
      <section className="panel trial-ledger-panel" aria-labelledby="trial-ledger-title">
        <header className="panel-header trial-ledger-header"><div><h2 id="trial-ledger-title">LP 交接台账</h2></div><div className="trial-ledger-status"><StatusPill tone={currentJiaowubaoImportedSchedule?.state === "complete" ? "green" : currentJiaowubaoImportedSchedule?.state === "stale" ? "amber" : "purple"}>{jiaowubaoImportedScheduleLoading ? "读取教务宝" : currentJiaowubaoImportedSchedule?.state === "complete" ? "真实课表已连接" : currentJiaowubaoImportedSchedule?.state === "stale" ? "快照已过期" : "等待真实课表"}</StatusPill><span>{trialLedgerStats.total === trialLedgerItems.length ? `${trialLedgerItems.length} 条记录` : `${trialLedgerStats.total} / ${trialLedgerItems.length} 条记录`}</span></div></header>
        {trialLedgerItems.length ? <>
          <section className="trial-ledger-tools" aria-label="LP 台账筛选与排序">
            <div className="trial-ledger-filter-grid">
              <label className="trial-ledger-query"><span>搜索</span><input disabled={!trialLedgerViewInteractive} type="search" value={activeTrialLedgerView.query} placeholder="学生、家长微信、科目、老师或备注" onChange={(event) => updateTrialLedgerView({ query: event.target.value })} /></label>
              <label><span>LP 类型</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.workflowType} onChange={(event) => updateTrialLedgerView({ workflowType: event.target.value })}><option value="all">全部类型</option>{LP_WORKFLOW_TYPES.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>上课月份</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.lessonMonth} onChange={(event) => updateTrialLedgerView({ lessonMonth: event.target.value })}><option value="all">全部月份</option>{trialLedgerFilterOptions("lessonMonth").map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>上课日期从</span><input disabled={!trialLedgerViewInteractive} type="date" value={activeTrialLedgerView.scheduledFrom} onChange={(event) => updateTrialLedgerView({ scheduledFrom: event.target.value })} /></label>
              <label><span>上课日期至</span><input disabled={!trialLedgerViewInteractive} type="date" value={activeTrialLedgerView.scheduledTo} onChange={(event) => updateTrialLedgerView({ scheduledTo: event.target.value })} /></label>
              <label><span>教务</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.operationsOwner} onChange={(event) => updateTrialLedgerView({ operationsOwner: event.target.value })}><option value="all">全部教务</option>{trialLedgerFilterOptions("operationsOwner").map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>课程规划老师</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.planner} onChange={(event) => updateTrialLedgerView({ planner: event.target.value })}><option value="all">全部规划老师</option>{trialLedgerFilterOptions("planner").map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>科目</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.subject} onChange={(event) => updateTrialLedgerView({ subject: event.target.value })}><option value="all">全部科目</option>{trialLedgerFilterOptions("subject").map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>老师</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.teacher} onChange={(event) => updateTrialLedgerView({ teacher: event.target.value })}><option value="all">全部老师</option>{trialLedgerFilterOptions("teacher").map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>业务结果</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.resultStatus} onChange={(event) => updateTrialLedgerView({ resultStatus: event.target.value })}><option value="all">全部状态</option>{LP_RESULT_STATUSES.map((value) => <option value={value} key={value}>{lpResultStatusLabel(value)}</option>)}</select></label>
              <label><span>是否付费</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.paid} onChange={(event) => updateTrialLedgerView({ paid: event.target.value as TrialLedgerViewState["paid"] })}><option value="all">全部</option><option value="paid">是</option><option value="unpaid">否</option></select></label>
              <label><span>排序字段</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.sortKey} onChange={(event) => updateTrialLedgerView({ sortKey: event.target.value as TrialLedgerViewState["sortKey"] })}><option value="scheduledAt">上课日期/时间</option><option value="requestedAt">请求日期/时间</option><option value="lessonMonth">上课月份</option><option value="studentName">学生姓名</option></select></label>
              <label><span>排序方向</span><select disabled={!trialLedgerViewInteractive} value={activeTrialLedgerView.sortDirection} onChange={(event) => updateTrialLedgerView({ sortDirection: event.target.value as TrialLedgerViewState["sortDirection"] })}><option value="desc">降序（最新优先）</option><option value="asc">升序（最早优先）</option></select></label>
            </div>
            <div className="trial-ledger-tool-footer">
              <span><Filter size={14} aria-hidden="true" />筛选只保存在当前登录账号，不影响其他人。</span>
              <button className="secondary-button" type="button" disabled={!trialLedgerViewInteractive || !trialLedgerViewHasFilters(activeTrialLedgerView)} onClick={() => setTrialLedgerView(defaultTrialLedgerViewState())}>清除筛选</button>
            </div>
          </section>
          <div className="trial-ledger-stats" role="status" aria-live="polite">
            <span className="trial-ledger-stat-total"><small>筛选结果</small><strong>{trialLedgerStats.total}</strong></span>
            {LP_RESULT_STATUSES.map((status) => <span key={status}><small>{lpResultStatusLabel(status)}</small><strong>{trialLedgerStats.byStatus[status] ?? 0}</strong></span>)}
            <span className="trial-ledger-success-rate" title="成功率只计算已明确为成功或失败的试听"><small>成功率</small><strong>{trialLedgerStats.successRate === null ? "—" : `${trialLedgerStats.successRate}%`}</strong><em>成功 {trialLedgerStats.successful} / 已出结果 {trialLedgerStats.resolved}</em></span>
          </div>
          {visibleTrialLedgerEntries.length ? <div className="trial-ledger-scroll">
          <table className="trial-ledger-table">
            <caption className="visually-hidden">LP 交接台账</caption>
            <thead><tr><th scope="col">学生姓名</th><th scope="col">家长微信名</th><th scope="col">LP 类型</th><th scope="col">上课月份</th><th scope="col">请求日期/时间</th><th scope="col">上课日期</th><th scope="col">上课时间（墨尔本）</th><th scope="col">教务</th><th scope="col">课程规划老师</th><th scope="col">科目</th><th scope="col">老师</th><th scope="col">业务结果</th><th scope="col">是否付费</th><th scope="col">备注</th><th scope="col">教务宝小课表</th></tr></thead>
            <tbody>{visibleTrialLedgerEntries.map((entry) => {
              const { item, schedule, requestAt, resultOptions, automaticStudentName, automaticGuardianWechat, automaticScheduledAt, automaticLessonMonth, automaticPlanner, automaticSubject, automaticTeacher, automaticPaid, storedPaid } = entry;
              const paidKey = `${item.id}:trialPaid`;
              const resultKey = `${item.id}:resultStatus`;
              if (!isTrialLedgerWorkflow(item)) return <tr key={item.id}>
                <td>{entry.row.studentName || "—"}</td>
                <td>{entry.row.guardianWechat || "—"}</td>
                <td>{entry.row.workflowType}</td>
                <td>{entry.row.lessonMonth || "—"}</td>
                <td>{requestAt ? formatInstant(new Date(requestAt), displayPreferences.timezone, displayPreferences) : "—"}</td>
                <td>—</td>
                <td>—</td>
                <td>{entry.row.operationsOwner || "—"}</td>
                <td>{automaticPlanner || "—"}</td>
                <td>{automaticSubject || "—"}</td>
                <td>{automaticTeacher || "—"}</td>
                <td>{item.resultStatus ? lpResultStatusLabel(item.resultStatus) : item.stage}</td>
                <td>—</td>
                <td>{entry.row.note || "—"}</td>
                <td>—</td>
              </tr>;
              return <tr key={item.id}>
                <td>{ledgerTextCell({ item, field: "studentName", automaticValue: automaticStudentName, label: `${automaticStudentName || item.id} 学生姓名`, list: "trial-ledger-student-options", placeholder: "未提到", openStudent: true })}</td>
                <td>{ledgerTextCell({ item, field: "guardianWechat", automaticValue: automaticGuardianWechat, label: `${automaticStudentName || item.id} 家长微信名`, list: "trial-ledger-guardian-options", placeholder: "待填写" })}</td>
                <td>{ledgerSelectCell({ item, field: "workflowType", automaticValue: item.workflowType ?? "试听 LP", label: `${automaticStudentName || item.id} LP 类型`, options: TRIAL_LEDGER_WORKFLOW_TYPES })}</td>
                <td>{ledgerTextCell({ item, field: "lessonMonth", automaticValue: automaticLessonMonth, label: `${automaticStudentName || item.id} 上课月份`, type: "month", placeholder: "待排课", sourceLabel: "按墨尔本排课自动生成" })}</td>
                <td>{ledgerTextCell({ item, field: "requestedAt", automaticValue: requestAt ?? "", label: `${automaticStudentName || item.id} 请求日期和时间`, type: "datetime-local", timezone: displayPreferences.timezone, placeholder: "待填写" })}</td>
                <td>{ledgerSchedulePartCell({ item, automaticValue: automaticScheduledAt, part: "date", label: `${automaticStudentName || item.id} 上课日期`, sourceLabel: schedule?.source === "jiaowubao-open-api" ? "教务宝真实数据" : "等待排课" })}</td>
                <td>{ledgerSchedulePartCell({ item, automaticValue: automaticScheduledAt, part: "time", label: `${automaticStudentName || item.id} 上课时间（墨尔本）`, sourceLabel: schedule?.source === "jiaowubao-open-api" ? "教务宝真实数据" : "等待排课" })}</td>
                <td>{ledgerSelectCell({ item, field: "operationsOwner", automaticValue: item.owner, label: `${automaticStudentName || item.id} 教务`, options: TRIAL_OPERATIONS })}</td>
                <td>{ledgerSelectCell({ item, field: "planner", automaticValue: automaticPlanner, label: `${automaticStudentName || item.id} 课程规划老师`, options: TRIAL_LEDGER_PLANNERS })}</td>
                <td>{ledgerTextCell({ item, field: "subject", automaticValue: automaticSubject, label: `${automaticStudentName || item.id} 科目`, list: "trial-ledger-subject-options", placeholder: "待填写" })}</td>
                <td>{ledgerTextCell({ item, field: "teacher", automaticValue: automaticTeacher, label: `${automaticStudentName || item.id} 老师`, list: "trial-ledger-teacher-options", placeholder: "待匹配", sourceLabel: schedule?.teacherName ? "教务宝真实数据" : "自动填充" })}</td>
                <td><div className={`ledger-edit-cell ${item.resultStatus ? "manual" : "automatic"}`}><select className="ledger-cell-input" disabled={trialLedgerSaving[resultKey] === true} value={effectiveTrialResultStatus(item) ?? ""} aria-label={`${automaticStudentName || item.id} 试听状态`} onChange={(event) => setLpResult(item, event.target.value as LpResultStatus)}>{resultOptions.map((status) => <option value={status} key={status}>{lpResultStatusLabel(status)}</option>)}</select><span className="ledger-cell-meta"><small>{trialLedgerSaving[resultKey] ? "保存中…" : item.resultStatus ? "人工结果" : "新建默认值"}</small></span></div></td>
                <td><div className={`ledger-edit-cell ${storedPaid === undefined ? "automatic" : "manual"}`}><select className="ledger-cell-input" disabled={trialLedgerSaving[paidKey] === true} value={storedPaid === undefined ? "" : storedPaid ? "true" : "false"} aria-label={`${automaticStudentName || item.id} 是否付费`} onChange={(event) => { const value = event.target.value === "" ? undefined : event.target.value === "true"; void saveTrialLedgerFieldAtomic(item, "trialPaid", value).catch((error: unknown) => notify(error instanceof Error ? error.message : "试听台账保存失败")); }}><option value="">自动 · {automaticPaid ? "是" : "否"}</option><option value="true">是</option><option value="false">否</option></select><span className="ledger-cell-meta"><small>{trialLedgerSaving[paidKey] ? "保存中…" : storedPaid === undefined ? "按付费方式自动判断" : "手动值"}</small></span></div></td>
                <td>{ledgerTextCell({ item, field: "trialLedgerNote", automaticValue: "", label: `${automaticStudentName || item.id} 试听备注`, placeholder: "补充备注" })}</td>
                <td><TrialScheduleDetails schedule={schedule} pendingLabel={pendingScheduleLabel(item)} onComplete={trialScreenshotAllowed(item) ? () => setTrialScreenshotItem(item) : undefined} /></td>
              </tr>;
            })}</tbody>
          </table>
          <datalist id="trial-ledger-student-options">{scopedStudents.map((student) => <option value={student.name} key={student.id} />)}</datalist>
          <datalist id="trial-ledger-guardian-options">{Array.from(new Set(scopedStudents.map((student) => student.guardianWechat || student.guardian).filter(Boolean))).map((guardian) => <option value={guardian} key={guardian} />)}</datalist>
          <datalist id="trial-ledger-subject-options">{Array.from(new Set([...courses.map((course) => course.name), ...scopedStudents.map((student) => student.course)].filter(Boolean))).map((subject) => <option value={subject} key={subject} />)}</datalist>
          <datalist id="trial-ledger-teacher-options">{recordTeachers.map((teacher) => <option value={teacher.name} key={teacher.id} />)}</datalist>
        </div> : <div className="empty-inline trial-ledger-filter-empty">当前筛选没有符合条件的交接记录；清除筛选即可查看全部 {trialLedgerItems.length} 条。</div>}
        </> : <div className="empty-inline">还没有 LP 交接记录；创建后会自动进入台账。</div>}
      </section>
      <section className="panel collection-shell">
        <div className="view-bar">
          <ViewTabs value={lpFilter} items={viewItems} onChange={setLpFilter} label="LP 保存视图" />
          <div className="segmented"><button className={lpMode === "board" ? "active" : ""} type="button" onClick={() => setLpMode("board")}>看板</button><button className={lpMode === "table" ? "active" : ""} type="button" onClick={() => setLpMode("table")}>表格</button></div>
        </div>
        {visibleLp.length === 0 ? <EmptyState title="当前视图没有 LP" detail={emptyLpDetail} action={<button className="primary-button" type="button" onClick={openLpCreate}><Plus size={16} /> 创建 LP</button>} /> : lpMode === "board" ? (
          <section className="kanban-board">
            {lpStages.filter((stage) => lpFilter !== "complete" || stage === "完成").map((stage) => (
              <article key={stage}>
                <header><span className={`kanban-dot ${stageTone(stage)}`} aria-hidden="true" /><h2>{stage}</h2><strong>{visibleLp.filter((item) => item.stage === stage).length}</strong></header>
                {visibleLp.filter((item) => item.stage === stage).map((item) => {
                  const student = studentById(item.studentId);
                  const publishedDay = lpPublishedDay(item);
                  return <div className="kanban-card" key={item.id}>
                    <p>{student?.name}</p>
                    <h3>{item.title}</h3>
                    <span>{item.workflowType ?? "历史 LP"} · 截止：{item.due}</span>
                    <div className="card-tags"><StatusPill tone={stageTone(item.stage)}>{item.stage}</StatusPill>{item.resultStatus && <StatusPill tone={item.resultStatus.includes("成功") ? "green" : item.resultStatus.includes("失败") ? "red" : "amber"}>{lpResultStatusLabel(item.resultStatus)}</StatusPill>}{publishedDay && <StatusPill tone="purple">{publishedDay}</StatusPill>}{item.needsParentFollowUp && <StatusPill tone="red">家长跟进</StatusPill>}{item.needsTeacherPrep && <StatusPill tone="blue">老师备课</StatusPill>}</div>
                    {trialIntakeDetails(item)}
                    {resultControl(item)}
                    {stageControls(item)}
                  </div>;
                })}
              </article>
            ))}
          </section>
        ) : (
          <div className="collection-main">
            <div className="collection-head lp-grid-row"><span>学生 / 计划</span><span>类型</span><span>阶段</span><span>截止时间</span><span>操作</span></div>
            <div className="collection-viewport">
              {visibleLp.map((item) => {
                const student = studentById(item.studentId);
                const publishedDay = lpPublishedDay(item);
                return <div className="collection-row lp-grid-row" key={item.id}>
                  <button className="row-primary table-person" type="button" onClick={() => goToStudent(item.studentId)}><Avatar initials={student?.initials ?? "?"} tone={statusTone(student?.status ?? "在读 + 加课待排")} /><span><strong>{student?.name}</strong><small>{item.title}</small></span></button>
                  <span>{item.workflowType ?? "历史 LP"}{publishedDay && <small className="inline-meta">{publishedDay}</small>}</span>
                  <StatusPill tone={stageTone(item.stage)}>{item.stage}</StatusPill>
                  <span>{item.due}</span>
                  <div>{resultControl(item)}{stageControls(item, true)}</div>
                </div>;
              })}
            </div>
          </div>
        )}
      </section>
    </>;
  };

  const renderOperations = () => {
    const isLeaveOperation = (operation: Operation) =>
      ["请假", "学生请假", "老师请假", "代课", "停课", "老师离职"].includes(
        operation.type,
      );
    const visibleOperations = scopedOperations.filter((operation) =>
      operationFilter === "open"
        ? operation.status === "待处理"
        : operationFilter === "confirmed"
          ? operation.status === "已确认"
          : operationFilter === "leave"
            ? isLeaveOperation(operation)
            : true,
    );
    const selectedOperation =
      visibleOperations.find(
        (operation) => operation.id === selectedOperationState?.id,
      ) ?? visibleOperations[0];
    if (!selectedOperation) {
      return (
        <>
        <ViewHeading
            eyebrow="异常管理"
            title="调课与代课"
            actions={
              <button
                className="primary-button"
                type="button"
                onClick={() => setModal("operation")}
              >
                <CalendarPlus size={17} /> 批量记录老师异常
              </button>
            }
          />
          <TeacherLeavePanel onProcess={(request) => { clearTeacherAbsencePreview(); setOperationDraft({ type: "老师请假", teacherId: request.teacher_id, eventStart: request.start_date, eventEnd: request.end_date, detail: request.reason }); setModal("operation"); }} />
          <section className="panel collection-shell">
            <ViewTabs
              value={operationFilter}
              items={[
                {
                  id: "open",
                  label: "待处理",
                  count: scopedOperations.filter(
                    (item) => item.status === "待处理",
                  ).length,
                },
                {
                  id: "confirmed",
                  label: "已确认",
                  count: scopedOperations.filter(
                    (item) => item.status === "已确认",
                  ).length,
                },
                {
                  id: "leave",
                  label: "请假、代课与离职",
                  count: scopedOperations.filter(isLeaveOperation).length,
                },
                { id: "all", label: "全部", count: scopedOperations.length },
              ]}
              onChange={setOperationFilter}
              label="异常保存视图"
            />
            <EmptyState
              title="当前视图没有异常记录"
              detail="切换上方状态标签，或新建一条异常处理记录。"
            />
          </section>
        </>
      );
    }
    const operationStudent = studentById(selectedOperation.studentId);
    if (!operationStudent)
      return (
        <section className="panel collection-shell">
          <EmptyState
            title="异常记录缺少学生关联"
            detail="请联系管理员核对关联学生后再处理。"
          />
        </section>
      );
    const operationTeacher = selectedOperation.teacherId
      ? teacherById(selectedOperation.teacherId)
      : undefined;
    const recommendedTeachers = (selectedOperation.recommendedTeacherIds ?? [])
      .map((teacherId) => teacherById(teacherId))
      .filter((teacher): teacher is Teacher => Boolean(teacher));
    return (
      <>
        <ViewHeading
          eyebrow="异常管理"
          title="调课与代课"
          actions={
            <button
              className="primary-button"
              type="button"
              onClick={() => setModal("operation")}
            >
              <CalendarPlus size={17} /> 批量记录老师异常
            </button>
          }
        />
        <TeacherLeavePanel onProcess={(request) => { clearTeacherAbsencePreview(); setOperationDraft({ type: "老师请假", teacherId: request.teacher_id, eventStart: request.start_date, eventEnd: request.end_date, detail: request.reason }); setModal("operation"); }} />
        <section className="panel collection-shell">
          <ViewTabs
            value={operationFilter}
            items={[
              {
                id: "open",
                label: "待处理",
                count: scopedOperations.filter(
                  (item) => item.status === "待处理",
                ).length,
              },
              {
                id: "confirmed",
                label: "已确认",
                count: scopedOperations.filter(
                  (item) => item.status === "已确认",
                ).length,
              },
              {
                id: "leave",
                label: "请假、代课与离职",
                count: scopedOperations.filter(isLeaveOperation).length,
              },
              { id: "all", label: "全部", count: scopedOperations.length },
            ]}
            onChange={setOperationFilter}
            label="异常保存视图"
          />
          <div className="master-detail-layout operations-layout">
            <article className="collection-main">
              <div className="collection-head operation-grid-row">
                <span>记录</span>
                <span>学生</span>
                <span>状态</span>
              </div>
              <div className="collection-viewport">
                {visibleOperations.length ? (
                  visibleOperations.map((operation) => {
                    const student = studentById(operation.studentId);
                    return (
                      <button
                        className={`collection-row operation-grid-row ${selectedOperation.id === operation.id ? "selected" : ""}`}
                        type="button"
                        key={operation.id}
                        onClick={() => {
                          if (!scopedActiveStudentIds.has(operation.studentId)) {
                            notify("当前身份无权打开该学生的教务记录");
                            return;
                          }
                          setSelectedOperationId(operation.id);
                          setSelectedStudentId(operation.studentId);
                          setMobilePreview("operation");
                        }}
                      >
                        <span>
                          <strong>{operation.type}</strong>
                          <small>{operation.detail}</small>
                        </span>
                        <span>{student?.name}</span>
                        <StatusPill
                          tone={
                            operation.status === "已确认" ? "green" : "amber"
                          }
                        >
                          {operation.status}
                        </StatusPill>
                      </button>
                    );
                  })
                ) : (
                  <EmptyState
                    title="当前视图没有异常记录"
                    detail="切换视图或新建一条异常处理记录。"
                  />
                )}
              </div>
            </article>
            <aside
              className={`record-preview ${mobilePreview === "operation" ? "mobile-detail-open" : ""}`}
            >
              <button
                className="mobile-preview-close"
                type="button"
                aria-label="关闭异常详情"
                onClick={() => setMobilePreview(null)}
              >
                <ChevronLeft size={20} /> 返回异常列表
              </button>
              <div className="preview-header">
                <div>
                  <h2>
                    {selectedOperation.type} · {operationStudent.name}
                  </h2>
                </div>
                <StatusPill
                  tone={
                    selectedOperation.status === "已确认" ? "green" : "amber"
                  }
                >
                  {selectedOperation.status}
                </StatusPill>
              </div>
              <div className="detail-section">
                <span>处理说明</span>
                <strong>{selectedOperation.detail}</strong>
              </div>
              {operationTeacher && (
                <div className="detail-section">
                  <span>原老师与影响范围</span>
                  <strong>
                    {operationTeacher.name} ·{" "}
                    {selectedOperation.affectedLessonCount ?? 0} 节受影响课程
                  </strong>
                  <p>
                    首节 {selectedOperation.firstAffectedAt || "待确认"} · {selectedOperation.eventStart || "日期待确认"} 至{" "}
                    {selectedOperation.eventEnd || "日期待确认"}
                  </p>
                </div>
              )}
              {operationTeacher && (
                <div className="detail-section">
                  <span>{selectedOperation.type === "老师离职" ? "永久接替老师" : "代课候选"}</span>
                  {selectedOperation.type === "老师离职" && selectedOperation.status === "待处理" ? <>
                    <button className="secondary-button" type="button" disabled={departureCandidateRefresh?.busy} onClick={async () => {
                      const operationId = selectedOperation.id;
                      setDepartureCandidateRefresh({ operationId, busy: true });
                      try {
                        const response = await fetch("/api/operations/departure/candidates", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ operationId, expectedVersions: { bookings: bookingsShared.version, operations: operationsShared.version, students: studentsShared.version, teachers: teachersShared.version } }),
                        });
                        const body = await response.json();
                        if (!response.ok || !body.operationRow) throw new Error(body.error || "候选老师检查失败");
                        operationsShared.applyRemote(body.operationRow);
                        setDepartureCandidateRefresh(null);
                      } catch (error) {
                        setDepartureCandidateRefresh({ operationId, error: error instanceof Error ? error.message : "候选老师检查失败" });
                      }
                    }}><RefreshCw size={15} /> {departureCandidateRefresh?.operationId === selectedOperation.id && departureCandidateRefresh.busy ? "正在重新匹配…" : "重新匹配老师"}</button>
                    {departureCandidateRefresh?.operationId === selectedOperation.id && departureCandidateRefresh.error ? <p role="alert">{departureCandidateRefresh.error}</p> : null}
                  </> : null}
                  {recommendedTeachers.length ? (
                    <div className="operation-recommendations">
                      {recommendedTeachers.map((teacher) => (
                        <button
                          className={
                            selectedOperation.chosenTeacherId === teacher.id
                              ? "selected-choice"
                              : "choice-button"
                          }
                          type="button"
                          key={teacher.id}
                          onClick={() => {
                            const previousTeacherId =
                              selectedOperation.chosenTeacherId;
                            if (previousTeacherId === teacher.id) return;
                            requestConfirmation({
                              title: selectedOperation.type === "老师离职" ? "确认选择永久接替老师" : "确认选择代课候选",
                              detail: `${operationStudent.name} · ${teacher.name}`,
                              items: selectedOperation.type === "老师离职"
                                ? [
                                    "确认异常处理时会从离职生效日起调整全部未来常规课次，不局限于当前预览范围",
                                    "学生主档老师、原老师与新老师容量会在同一事务中更新",
                                  ]
                                : [
                                    "确认异常处理时会把所选日期范围内的具体课次改给该老师",
                                    "正式提交前仍需学生、原老师和代课老师确认",
                                  ],
                              confirmLabel: "记录此候选",
                              onConfirm: () => {
                                setOperations((current) =>
                                  current.map((entry) =>
                                    entry.id === selectedOperation.id
                                      ? {
                                          ...entry,
                                          chosenTeacherId: teacher.id,
                                        }
                                      : entry,
                                  ),
                                );
                                addAudit(
                                  selectedOperation.type === "老师离职" ? "选择永久接替老师" : "选择代课推荐老师",
                                  `${operationStudent.name} · ${teacher.name}`,
                                  "green",
                                );
                                notify(
                                  `${teacher.name} 已选为${selectedOperation.type === "老师离职" ? "永久接替" : "代课"}老师`,
                                  () => {
                                    setOperations((current) =>
                                      current.map((entry) =>
                                        entry.id === selectedOperation.id
                                          ? {
                                              ...entry,
                                              chosenTeacherId:
                                                previousTeacherId,
                                            }
                                          : entry,
                                      ),
                                    );
                                    addAudit(
                                      "撤销代课候选选择",
                                      `${operationStudent.name} · ${teacher.name}`,
                                      "amber",
                                    );
                                  },
                                );
                              },
                            });
                          }}
                        >
                          <span>
                            <strong>{teacher.name}</strong>
                            <small>
                              {teacher.subjects.slice(0, 2).join(" · ")}
                            </small>
                          </span>
                          {selectedOperation.chosenTeacherId === teacher.id ? (
                            <Check size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>没有找到符合科目和可用时间的候选老师。请先补全 AVA 后再选择。</p>
                  )}
                </div>
              )}
              {selectedOperation.status === "待处理" && (
                <button
                  className="primary-button full"
                  type="button"
                  onClick={() => {
                    requestConfirmation({
                      title: "确认异常处理已完成",
                      detail: `${selectedOperation.type} · ${operationStudent.name}`,
                      items: [
                        `${selectedOperation.eventStart || "开始日期待确认"} 至 ${selectedOperation.eventEnd || "结束日期待确认"}`,
                        `${selectedOperation.affectedLessonCount ?? 0} 节课程可能受影响`,
                        selectedOperation.chosenTeacherId
                          ? `${selectedOperation.type === "老师离职" ? "永久接替" : "代课"}候选：${teacherById(selectedOperation.chosenTeacherId)?.name ?? selectedOperation.chosenTeacherId}`
                          : `尚未选择${selectedOperation.type === "老师离职" ? "永久接替" : "代课"}候选`,
                        ...(selectedOperation.type === "老师离职"
                          ? ["会从离职生效日起调整未来常规课、学生资料与老师容量"]
                          : []),
                      ],
                      confirmLabel: "确认处理完成",
                      onConfirm: async () => {
                        const permanentReplacement = selectedOperation.type === "老师离职";
                        const response = await fetch(permanentReplacement
                          ? "/api/operations/permanent-replacement"
                          : "/api/operations/confirm", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            operationId: selectedOperation.id,
                            ...(selectedOperation.chosenTeacherId ? { chosenTeacherId: selectedOperation.chosenTeacherId } : {}),
                            expectedVersions: {
                              bookings: bookingsShared.version,
                              operations: operationsShared.version,
                              teachers: teachersShared.version,
                              ...(permanentReplacement ? { students: studentsShared.version } : {}),
                            },
                          }),
                        });
                        const body = await response.json().catch(() => ({}));
                        if (!response.ok || !body.bookingRow || !body.operationRow) {
                          throw new Error(body.error || "异常确认失败");
                        }
                        bookingsShared.applyRemote(body.bookingRow as RemoteStateRow<Booking[]>);
                        operationsShared.applyRemote(body.operationRow as RemoteStateRow<Operation[]>);
                        if (permanentReplacement) {
                          if (!body.teacherRow || !body.studentRow) throw new Error("永久换师提交缺少老师或学生原子结果");
                          teachersShared.applyRemote(body.teacherRow as RemoteStateRow<Teacher[]>);
                          studentsShared.applyRemote(body.studentRow as RemoteStateRow<Student[]>);
                        }
                        const affectedCount = Array.isArray(body.affectedOccurrenceIds) ? body.affectedOccurrenceIds.length : 0;
                        notify(affectedCount ? `已原子更新 ${affectedCount} 节具体课程，后续任务仍保留` : "已确认，后续任务仍保留在工作台");
                      },
                    });
                  }}
                  disabled={selectedOperation.type === "老师离职" && !selectedOperation.chosenTeacherId}
                >
                  {selectedOperation.type === "老师离职" ? "确认永久换师" : "确认处理"}
                </button>
              )}
              <button
                className="secondary-button full"
                type="button"
                onClick={() => goToStudent(operationStudent.id)}
              >
                查看学生档案
              </button>
            </aside>
          </div>
        </section>
      </>
    );
  };

  const renderRenewals = () => {
    type ExamDisplayRow = {
      student: Student;
      managedOnly: boolean;
      exam: StudentExamRecord;
      statuses: Record<ExamTaskKind, ExamDisplayStatus>;
      resultDate: string | null;
      resultDateIsOverride: boolean;
      tasks: Partial<Record<"exam_month_planning" | "exam_care" | "exam_recall" | "exam_results_follow_up", Task>>;
    };
    const examRows: ExamDisplayRow[] = examStudents.flatMap((student) => examRecordsForStudent(student).map((exam) => {
      const definitions = deriveExamFollowUpStatuses(exam);
      const examTasks = scopedTasks.filter((task) => task.studentId === student.id
        && task.category === "考试"
        && task.anchorBookingId === `exam:${exam.id}`
        && task.ruleKey?.match(/^exam:[^:]+:(planning|care|recall|results)$/));
      const taskByKind = Object.fromEntries(examTasks.map((task) => {
        const suffix = task.ruleKey?.split(":").pop();
        const kind = suffix === "planning" ? "exam_month_planning" : suffix === "care" ? "exam_care" : suffix === "recall" ? "exam_recall" : "exam_results_follow_up";
        return [kind, task];
      })) as ExamDisplayRow["tasks"];
      const statusFor = (kind: ExamTaskKind): ExamDisplayStatus => {
        const task = taskByKind[kind];
        if (task) return task.status === "done" ? "completed" : "pending";
        return definitions[kind] as ExamDisplayStatus;
      };
      const statuses = {
        exam_month_planning: statusFor("exam_month_planning"),
        exam_care: statusFor("exam_care"),
        exam_recall: statusFor("exam_recall"),
        exam_results_follow_up: statusFor("exam_results_follow_up"),
      } satisfies Record<ExamTaskKind, ExamDisplayStatus>;
      const estimatedResultDate = estimateExamResultDate(exam) ?? (exam.resultDateOverride ?? null);
      return {
        student,
        managedOnly: managedExamStudentIds.has(student.id),
        exam,
        statuses,
        resultDate: estimatedResultDate,
        resultDateIsOverride: Boolean(exam.resultDateOverride),
        tasks: taskByKind,
      };
    }));
    const examMonthOptions = Array.from(new Set(examRows.map((row) => row.exam.examMonth))).sort();
    const examRowsForMonth = examRows
      .filter((row) => examMonthSelection === "all" || row.exam.examMonth === examMonthSelection);
    const visibleExamRows = examRowsForMonth
      .filter((row) => {
        const planningPending = row.statuses.exam_month_planning === "pending";
        const careRecallPending = row.statuses.exam_care === "pending" || row.statuses.exam_recall === "pending";
        const resultsPending = row.statuses.exam_results_follow_up === "pending";
        const completed = Object.values(row.statuses).every((status) => status === "completed" || status === "not_required");
        return examFilter === "planning" ? planningPending : examFilter === "care" ? careRecallPending : examFilter === "results" ? resultsPending : examFilter === "completed" ? completed : true;
      })
      .sort((left, right) => left.exam.examMonth.localeCompare(right.exam.examMonth)
        || (left.exam.examDate ? 1 : -1) - (right.exam.examDate ? 1 : -1)
        || (left.exam.examDate ?? "").localeCompare(right.exam.examDate ?? "")
        || left.student.name.localeCompare(right.student.name)
        || left.exam.id.localeCompare(right.exam.id));
    const examStatusCount = (filter: "planning" | "care" | "results" | "completed") => examRowsForMonth.filter((row) => {
      const planningPending = row.statuses.exam_month_planning === "pending";
      const careRecallPending = row.statuses.exam_care === "pending" || row.statuses.exam_recall === "pending";
      const resultsPending = row.statuses.exam_results_follow_up === "pending";
      const completed = Object.values(row.statuses).every((status) => status === "completed" || status === "not_required");
      return filter === "planning" ? planningPending : filter === "care" ? careRecallPending : filter === "results" ? resultsPending : completed;
    }).length;
    const today = isoDateInTimezone(new Date(), "Australia/Melbourne");
    const now = new Date();
    const projectionEnd = shiftIsoDate(today, 365);
    type RenewalDisplayRow = RenewalDraft & { packageName?: string; subjectLabel?: string; teacherName?: string };
    const renewalRows: RenewalDisplayRow[] = scopedStudents.flatMap((student) => {
      const packages = student.lessonPackages ?? [];
      const projectedOccurrences = scopedBookings
        .filter((booking) => booking.studentId === student.id && booking.packageId)
        .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(today, -1), projectionEnd))
        .filter((occurrence) => bookingInstant(occurrence).getTime() >= now.getTime())
        .flatMap((occurrence) => {
          const lessonPackage = packages.find((entry) => entry.id === occurrence.packageId);
          const subjectId = occurrence.course ?? student.course;
          if (!lessonPackage || !lessonPackage.subjectIds.includes(subjectId)) return [];
          return [{
            id: occurrence.occurrenceKey,
            packageId: occurrence.packageId,
            subjectId,
            date: occurrence.date,
            start: occurrence.start,
            timezone: occurrence.timezone,
            duration: occurrence.duration,
            status: occurrence.status,
          }];
        });
      let estimates: ReturnType<typeof mapLessonPackageDepletionEstimates> = [];
      try {
        estimates = mapLessonPackageDepletionEstimates(packages, projectedOccurrences);
      } catch {
        estimates = [];
      }
      const estimateByPackage = new Map(estimates.map((estimate) => [estimate.packageId, estimate]));
      const structuredRows = packages.flatMap((lessonPackage): RenewalDisplayRow[] => {
        const estimate = estimateByPackage.get(lessonPackage.id);
        const remaining = getLessonPackageBalance(lessonPackage).remainingHours;
        const needsAttention = isActiveStudent(student)
          && Boolean(estimate?.depletionDate || remaining < Number(rules.lowHours || 5));
        const packageExact = scopedRenewals.find((renewal) => renewal.studentId === student.id
          && renewal.packageId === lessonPackage.id
          && !renewal.subjectId);
        const legacySubjectRows = scopedRenewals.filter((renewal) => renewal.studentId === student.id
          && renewal.packageId === lessonPackage.id
          && Boolean(renewal.subjectId));
        const subjectLegacy = legacySubjectRows.length === 1 ? legacySubjectRows[0] : undefined;
        const studentLegacy = packages.length === 1
          ? scopedRenewals.find((renewal) => renewal.studentId === student.id && !renewal.packageId && !renewal.subjectId)
          : undefined;
        const existing = packageExact ?? subjectLegacy ?? studentLegacy;
        if (!existing && !needsAttention) return [];
        const packageOccurrences = projectedOccurrences
          .filter((occurrence) => occurrence.packageId === lessonPackage.id)
          .sort((left, right) => left.date.localeCompare(right.date) || left.start.localeCompare(right.start) || left.id.localeCompare(right.id));
        const depletionIndex = estimate?.occurrenceId
          ? packageOccurrences.findIndex((occurrence) => occurrence.id === estimate.occurrenceId)
          : -1;
        const depletionOccurrence = depletionIndex >= 0 ? packageOccurrences[depletionIndex] : undefined;
        const nextScheduled = packageOccurrences[0];
        const nextAfterDepletion = depletionIndex >= 0 ? packageOccurrences[depletionIndex + 1] : undefined;
        const depletionInstant = depletionOccurrence
          ? zonedDateTimeToUtc(depletionOccurrence.date, depletionOccurrence.start, depletionOccurrence.timezone)
          : null;
        const afterInstant = nextAfterDepletion
          ? zonedDateTimeToUtc(nextAfterDepletion.date, nextAfterDepletion.start, nextAfterDepletion.timezone)
          : null;
        const automaticRenewalDateNote = buildRenewalDateNote({
          depletionSubjectId: estimate?.subjectId,
          remainingHours: remaining,
          depletionLessonHours: depletionOccurrence ? depletionOccurrence.duration / 60 : undefined,
          nextScheduledLesson: nextScheduled ? {
            subjectId: nextScheduled.subjectId,
            date: nextScheduled.date,
            start: nextScheduled.start,
            hours: nextScheduled.duration / 60,
          } : null,
          nextLessonAfterDepletion: nextAfterDepletion && depletionInstant && afterInstant ? {
            subjectId: nextAfterDepletion.subjectId,
            date: nextAfterDepletion.date,
            start: nextAfterDepletion.start,
            withinSevenDays: afterInstant.getTime() - depletionInstant.getTime() < 7 * 24 * 60 * 60 * 1000,
          } : null,
        });
        const nextBookingOccurrence = nextScheduled
          ? scopedBookings
              .filter((booking) => booking.studentId === student.id && booking.packageId === lessonPackage.id)
              .flatMap((booking) => bookingOccurrencesWithinRange(booking, today, projectionEnd))
              .find((occurrence) => occurrence.occurrenceKey === nextScheduled.id)
          : undefined;
        const anchor = renewalTaskAnchor(student.id, lessonPackage.id);
        return [{
          ...(existing ?? {
            id: `REN-AUTO:${anchor}`,
            studentId: student.id,
            status: "待跟进" as const,
            businessStatus: "not_renewed_active" as const,
            owner: student.owner,
          }),
          packageId: lessonPackage.id,
          packageName: lessonPackage.name,
          subjectId: undefined,
          subjectLabel: estimate?.subjectId ? `耗尽科目：${estimate.subjectId}` : lessonPackage.subjectIds.join(" / "),
          teacherName: nextBookingOccurrence ? teacherById(nextBookingOccurrence.teacherId)?.name ?? "待确认" : "待确认",
          remaining,
          estimate: estimate?.depletionDate ?? existing?.estimate ?? "待确认",
          // Keep the persisted manual note separate from the calculated,
          // read-only depletion evidence shown alongside it.
          renewalDateNote: existing?.renewalDateNote,
          automaticRenewalDateNote: automaticRenewalDateNote || undefined,
          businessStatus: renewalStatusForPackage(existing ? [{
            ...existing,
            subjectId: undefined,
            status: existing.businessStatus ?? normalizeRenewalBusinessStatus(existing.status),
          }] : [], {
            studentId: student.id, packageId: lessonPackage.id, packageCount: packages.length,
            cycleStartedAt: latestRenewalPurchaseAt(lessonPackage.purchaseRecords),
            remainingHours: remaining,
          }) as RenewalBusinessStatus | undefined ?? "not_renewed_active",
        }];
      });
      const representedRenewalIds = new Set(structuredRows.map((row) => row.id));
      const representedPackageIds = new Set(structuredRows.map((row) => row.packageId).filter(Boolean));
      const legacyRows = scopedRenewals
        .filter((renewal) => renewal.studentId === student.id
          && !representedRenewalIds.has(renewal.id)
          && (!renewal.packageId || !representedPackageIds.has(renewal.packageId)))
        .map((renewal): RenewalDisplayRow => {
          const linkedPackage = packages.find((lessonPackage) => lessonPackage.id === renewal.packageId);
          return {
            ...renewal,
            packageName: linkedPackage?.name ?? (packages.length ? "未关联课包" : "历史课时"),
            subjectLabel: renewal.subjectId ?? linkedPackage?.subjectIds.join(" / ") ?? student.course,
            teacherName: student.teacher || "待确认",
            remaining: linkedPackage ? getLessonPackageBalance(linkedPackage).remainingHours : student.remainingHours ?? renewal.remaining,
            estimate: renewal.estimate ?? student.renewalDate ?? student.renewalMonth ?? "待确认",
            businessStatus: renewal.businessStatus ?? normalizeRenewalBusinessStatus(renewal.status),
          };
        });
      return [...structuredRows, ...legacyRows];
    });
    const businessStatusFor = (renewal: Renewal) => renewal.businessStatus ?? normalizeRenewalBusinessStatus(renewal.status);
    const visibleRenewals = renewalRows.filter((renewal) => (!isAdminView || matchesOperationsOwnerFilter(renewalOwnerFilter, renewal.owner)) && (renewalFilter === "attention"
      ? businessStatusFor(renewal) !== "renewed"
      : renewalFilter === "renewed"
        ? businessStatusFor(renewal) === "renewed"
        : renewalFilter === "inactive"
          ? businessStatusFor(renewal) === "not_renewed_inactive" || businessStatusFor(renewal) === "not_renewed_exam_finished"
          : true));
    const renewalPageSize = 10;
    const safeRenewalPage = Math.min(renewalPage, Math.max(1, Math.ceil(visibleRenewals.length / renewalPageSize)));
    const pagedRenewals = visibleRenewals.slice((safeRenewalPage - 1) * renewalPageSize, safeRenewalPage * renewalPageSize);
    const firstActiveRenewalStudent = scopedActiveStudents[0];
    const activeRenewalStudentWithPackage = scopedActiveStudents.find((student) => (student.lessonPackages?.length ?? 0) > 0);
    const renewalEmptyState = () => {
      if (!scopedActiveStudents.length) {
        return <EmptyState
          title="还没有可跟进的活跃学生"
          detail={isTeacherView ? "管理员完成学生关联后，续课记录会显示在这里。" : "续课记录必须关联活跃学生；先新建学生或导入权威名单。"}
          action={isTeacherView ? undefined : <>
            <button className="primary-button" type="button" onClick={() => { setActive("students"); setSelectedStudentId(""); setModal("student"); }}><UserPlus size={17} /> 先新建学生</button>
            {isAdminView ? <button className="secondary-button" type="button" onClick={() => setActive("sync")}><Database size={17} /> 去同步与导入</button> : null}
          </>}
        />;
      }
      if (!activeRenewalStudentWithPackage) {
        return <EmptyState
          title="还没有可用于续课的课包"
          detail="先为活跃学生录入真实课包和课时。"
          action={!isTeacherView && firstActiveRenewalStudent ? <button className="primary-button" type="button" onClick={() => { setStudentRecordKind("lessonPackages"); openStudentBoundModal("lessonPackage", firstActiveRenewalStudent.id); }}><BookOpen size={17} /> 先录入课包</button> : undefined}
        />;
      }
      if (!renewalRows.length) {
        return <EmptyState
          title="当前没有需要续课的课包"
          detail="活跃学生和课包已存在，但目前没有低课时或预计耗尽记录。"
          action={<button className="secondary-button" type="button" onClick={() => setActive("courses")}><BookOpen size={17} /> 查看课程与课包</button>}
        />;
      }
      return <EmptyState
        title="当前筛选没有续课记录"
        detail={isAdminView ? "切换续课状态或负责教务后再试。" : "切换续课状态后再试。"}
        action={<button className="secondary-button" type="button" onClick={() => { setRenewalFilter("all"); setRenewalOwnerFilter("all"); setRenewalPage(1); }}>清除续课筛选</button>}
      />;
    };
    return <>
      <ViewHeading eyebrow="学生档案联动" title="考试与续课" actions={<button className="secondary-button" type="button" onClick={() => setModal("task")}><Plus size={17} /> 添加任务</button>} />
      {examReminderStudents.length ? <section className="exam-reminder-strip"><div><span className="risk-icon amber"><CalendarDays size={17} /></span><span><strong>{examReminderStudents.length} 位学生进入考试提醒窗口</strong></span></div>{examReminderStudents.slice(0, 4).map((student) => { const exam = examRecordsForStudent(student).find((record) => record.examDate) ?? examRecordsForStudent(student)[0]; const content = <><strong>{student.name}</strong><small>{exam?.subject ?? "考试"} · {exam ? examDateOrMonthLabel(exam, displayPreferences) : "待确认"}</small></>; return managedExamStudentIds.has(student.id) ? <span className="managed-exam-reminder" key={student.id}>{content}</span> : <button type="button" key={student.id} onClick={() => goToStudent(student.id)}>{content}<ChevronRight size={15} /></button>; })}</section> : null}
      <section className="panel collection-shell exam-collection">
        <div className="panel-header"><div><h2>考试关注</h2></div></div>
        <div className="exam-toolbar">
          <label>月份<select className="filter-select" value={examMonthSelection} onChange={(event) => setExamMonthSelection(event.target.value)}><option value="all">全部月份</option>{examMonthOptions.map((month) => <option value={month} key={month}>{examMonthLabel(month, displayPreferences)}</option>)}</select></label>
          <ViewTabs value={examFilter} items={[{ id: "all", label: "全部", count: examRows.length }, { id: "planning", label: "待月度规划", count: examStatusCount("planning") }, { id: "care", label: "待关心 / 回忆", count: examStatusCount("care") }, { id: "results", label: "待出分关心", count: examStatusCount("results") }, { id: "completed", label: "已完成", count: examStatusCount("completed") }]} onChange={setExamFilter} label="考试状态筛选" />
        </div>
        <div className="collection-main">
          <div className="collection-head exam-grid-row"><span>学生</span><span>科目 / 类型</span><span>考试日期 / 月份</span><span>出分日期</span><span>关心 / 回忆</span><span>出分关心</span><span>操作</span></div>
          <div className="collection-viewport">
            {visibleExamRows.length ? visibleExamRows.map((row) => {
              const planningTask = row.tasks.exam_month_planning;
              const careTask = row.tasks.exam_care;
              const recallTask = row.tasks.exam_recall;
              const resultTask = row.tasks.exam_results_follow_up;
              const pendingTask = row.statuses.exam_month_planning === "pending" ? planningTask
                : row.statuses.exam_care === "pending" ? careTask
                : row.statuses.exam_recall === "pending" ? recallTask
                  : row.statuses.exam_results_follow_up === "pending" ? resultTask
                    : undefined;
              const completedTask = [planningTask, careTask, recallTask, resultTask].find((task) => task?.status === "done" && Boolean(examCompletionCommandKeys[task.id]));
              const careLabel = `${examFollowUpStatusLabel(row.statuses.exam_care)}${row.exam.includeRecall === false ? "" : ` / ${examFollowUpStatusLabel(row.statuses.exam_recall)}`}`;
              const careTone = row.statuses.exam_care === "pending" || row.statuses.exam_recall === "pending" ? "amber" : row.statuses.exam_care === "completed" ? "green" : "neutral";
              const resultTone = examFollowUpStatusTone(row.statuses.exam_results_follow_up);
              return <div className="collection-row exam-grid-row" key={`${row.student.id}:${row.exam.id}`}>
                {row.managedOnly
                  ? <span className="row-primary table-person"><Avatar initials={row.student.initials} tone={careTone} /><span><strong>{row.student.name}</strong></span></span>
                  : <button className="row-primary table-person" type="button" onClick={() => goToStudent(row.student.id)}><Avatar initials={row.student.initials} tone={careTone} /><span><strong>{row.student.name}</strong></span></button>}
                <span><strong>{row.exam.subject}</strong><small>{row.exam.examType} · {resolveExamVariant(row.exam)}</small></span>
                <span><strong>{examDateOrMonthLabel(row.exam, displayPreferences)}</strong>{!row.exam.examDate ? <small>考试日期待确认</small> : null}</span>
                <span><strong>{row.resultDate ?? "待补充"}</strong>{row.resultDate ? <small>{row.resultDateIsOverride ? "覆盖日期" : "预计"}</small> : null}</span>
                <span><StatusPill tone={careTone}>{careLabel}</StatusPill></span>
                <span><StatusPill tone={resultTone}>{examFollowUpStatusLabel(row.statuses.exam_month_planning)} 规划</StatusPill><StatusPill tone={resultTone}>{examFollowUpStatusLabel(row.statuses.exam_results_follow_up)}</StatusPill></span>
                <span className="exam-row-actions">{pendingTask ? <button className="compact-button" type="button" onClick={() => completeTask(pendingTask.id)}>完成</button> : null}{completedTask ? <button className="compact-button" type="button" onClick={() => { void undoManagedExamFollowUp(completedTask); }}>撤销</button> : null}{!pendingTask && !completedTask && !row.exam.examDate ? <small>补充日期后生成任务</small> : null}</span>
              </div>;
            }) : <EmptyState title="当前筛选没有考试记录" detail="可切换月份或状态；月份记录会排在具体考试日期之前。" />}
          </div>
        </div>
      </section>
      <section className="panel collection-shell renewal-collection">
        <ViewTabs
          value={renewalFilter}
          items={[
            { id: "attention", label: "需要关注", count: renewalRows.filter((item) => businessStatusFor(item) !== "renewed").length },
            { id: "renewed", label: "已续课", count: renewalRows.filter((item) => businessStatusFor(item) === "renewed").length },
            { id: "inactive", label: "不活跃", count: renewalRows.filter((item) => businessStatusFor(item) === "not_renewed_inactive" || businessStatusFor(item) === "not_renewed_exam_finished").length },
            { id: "all", label: "全部", count: renewalRows.length },
          ]}
          onChange={(value) => { setRenewalFilter(value); setRenewalPage(1); }}
          label="续课保存视图"
        />
        {isAdminView ? <div className="list-toolbar"><select className="filter-select" value={renewalOwnerFilter} onChange={(event) => { setRenewalOwnerFilter(event.target.value); setRenewalPage(1); }} aria-label="按负责教务筛选续课"><option value="all">全部负责教务</option>{operationsOwnerFilterOptions(renewalRows.map((renewal) => renewal.owner)).map((owner) => <option value={owner} key={owner}>{owner}</option>)}</select></div> : null}
        <div className="collection-main">
          <div className="collection-head renewal-grid-row"><span>学生 / 课包</span><span>剩余课时</span><span>预计续课</span><span>老师</span><span>状态 / 时间</span><span>操作</span></div>
          <div className="collection-viewport">
            {pagedRenewals.length ? pagedRenewals.map((renewal) => {
              const student = studentById(renewal.studentId);
              const renewalTeacher = renewal.teacherName ?? student?.teacher ?? "待确认";
              const lowHours = renewal.remaining < Number(rules.lowHours || 5);
              const latestFollowUp = getLatestStudentFollowUp(student?.followUpHistory ?? []);
              const lastContactedAt = latestFollowUp?.followedUpAt ?? renewal.lastContactedAt ?? (/^\d{4}-\d{2}-\d{2}$/.test(student?.followUp ?? "") ? student?.followUp : undefined);
              const businessStatus = businessStatusFor(renewal);
              const displayStatus = RENEWAL_STATUS_LABELS[businessStatus];
              const businessTone: Tone = businessStatus === "renewed" ? "green" : businessStatus === "not_renewed_active" ? "amber" : "neutral";
              const rowKey = renewal.packageId
                ? renewalCycleTaskAnchor({ studentId: renewal.studentId, packageId: renewal.packageId,
                    cycleStartedAt: latestRenewalPurchaseAt(student?.lessonPackages?.find((entry) => entry.id === renewal.packageId)?.purchaseRecords ?? []) })
                : `renewal-record:${renewal.id}`;
              return <div className="collection-row renewal-grid-row" key={rowKey}>
                <button className="row-primary table-person" type="button" onClick={() => goToStudent(renewal.studentId)}><Avatar initials={student?.initials ?? "?"} tone={lowHours ? "red" : businessTone} /><span><strong>{student?.name}</strong><small>{renewal.packageName ?? "未关联课包"} · {renewal.subjectLabel ?? student?.course}</small></span></button>
                <strong className={lowHours ? "low-hours" : ""}>{renewal.remaining} 小时</strong>
                <span><strong>{renewal.estimate}</strong>{renewal.automaticRenewalDateNote ? <small>自动提示：{renewal.automaticRenewalDateNote}</small> : null}{renewal.renewalDateNote ? <small>人工备注：{renewal.renewalDateNote}</small> : null}</span>
                <span>{renewalTeacher}</span>
                <span className="renewal-status-cell"><StatusPill tone={businessTone}>{displayStatus}</StatusPill><small>{renewal.lastAttemptAt ? `本次 ${formatFollowUpTime(renewal.lastAttemptAt, displayPreferences)}` : `上次成功 ${formatFollowUpTime(lastContactedAt, displayPreferences)}`}</small>{renewal.status === "本次未跟进" && <small>上次成功 {formatFollowUpTime(lastContactedAt, displayPreferences)}</small>}</span>
                <button className="compact-button" type="button" onClick={() => { setRenewalDraft({ ...renewal, lastContactedAt }); setModal("renewal"); }}>记录跟进</button>
              </div>;
            }) : renewalEmptyState()}
          </div>
          <Pagination page={safeRenewalPage} total={visibleRenewals.length} pageSize={renewalPageSize} onPage={setRenewalPage} />
        </div>
      </section>
    </>;
  };

  const renderPayroll = () => {
    const visiblePayroll = monthPayroll.filter((row) => {
      const matchesStatus =
        payrollFilter === "review"
          ? row.status === "需核对"
          : payrollFilter === "ready"
            ? row.status === "可审核"
            : payrollFilter === "locked"
              ? row.status === "已锁定"
              : true;
      const matchesCurrency =
        payrollCurrency === "all" || row.currency === payrollCurrency;
      return matchesStatus && matchesCurrency;
    });
    const payrollPageSize = 10;
    const safePayrollPage = Math.min(
      payrollPage,
      Math.max(1, Math.ceil(visiblePayroll.length / payrollPageSize)),
    );
    const pagedPayroll = visiblePayroll.slice(
      (safePayrollPage - 1) * payrollPageSize,
      safePayrollPage * payrollPageSize,
    );
    const selectedPayroll =
      pagedPayroll.find((row) => row.viewKey === selectedPayrollKey) ??
      pagedPayroll[0];
    const hasReadyJiaowubaoEvidenceForPayrollMonth = jiaowubaoCompletedMonthEvidenceReadyForPayrollLock({
      feed: jiaowubaoCompletedLessonFeed,
      month: activePayrollMonth,
      loading: jiaowubaoCompletedLessonLoading,
      error: jiaowubaoCompletedLessonError,
      syncing: jiaowubaoCompletedLessonSyncing,
    });
    const hasCollectablePayrollDates = activePayrollMonth < melbourneExamMonth
      || activePayrollMonth === melbourneExamMonth && !isoDateInTimezone(new Date(), "Australia/Melbourne").endsWith("-01");
    const canExportCurrentPayroll = jiaowubaoCompletedMonthEvidenceReadyForExport({
      feed: jiaowubaoCompletedLessonFeed, month: activePayrollMonth,
      loading: jiaowubaoCompletedLessonLoading, error: jiaowubaoCompletedLessonError,
      syncing: jiaowubaoCompletedLessonSyncing,
    })
      && !jiaowubaoCompletedLessonExporting
      && (monthPayroll.length > 0 || unmatchedJiaowubaoPayrollExportRows.length > 0);
    const cnyTotal = monthPayroll
      .filter((row) => row.currency === "CNY")
      .reduce((total, row) => total + row.amount, 0);
    const audTotal = monthPayroll
      .filter((row) => row.currency !== "CNY")
      .reduce((total, row) => total + row.amount, 0);
    const totalHours = monthPayroll.reduce(
      (total, row) =>
        total + (row.teacherTotalHours ?? row.lessons + row.trialLessons),
      0,
    );
    const jiaowubaoPayrollSourceLockBlockReason = (
      row: PayrollRow,
      feed: JiaowubaoCompletedLessonFeed | null,
    ) => {
      if (feed?.state !== "complete" || feed.month !== row.month) {
        return "该月份的教务宝双源资料尚未完整读取；请先完成同步并核对后再锁定。";
      }
      const source = jiaowubaoCompletedLessonEvidenceByTeacherMonth.get(
        payrollTeacherMonthKey(row.teacherId, row.month),
      );
      if (!source) {
        return "该老师没有当前月份的教务宝来源资料，不能锁定或付款。";
      }
      if (!jiaowubaoPayrollSourceVersionIsCurrent({
        persistedSourceRevision: row.sourceRevision,
        persistedProjectionRevision: row.sourceProjectionRevision,
        currentSourceRevision: feed.revision,
        currentProjectionRevision: feed.projectionRevision,
      })) {
        return `${JIAOWUBAO_PAYROLL_SOURCE_VERSION_REVIEW_REASON}，不能锁定或付款。`;
      }
      return !jiaowubaoCompletedLessonCanGeneratePayroll(source.summary)
        ? "该老师的教务宝课时或试听分类仍待核对，不能锁定或付款。"
        : null;
    };
    const jiaowubaoPayrollLockBlockReason = (row: PayrollDisplayRow) => {
      if (!hasReadyJiaowubaoEvidenceForPayrollMonth || row.month !== activePayrollMonth) {
        return "该月份的教务宝双源资料尚未完整读取；请先完成同步并核对后再锁定。";
      }
      const sourceBlockReason = jiaowubaoPayrollSourceLockBlockReason(row, jiaowubaoCompletedLessonFeed);
      if (sourceBlockReason) return sourceBlockReason;
      return row.paymentReviewOnly
        ? "该老师当前只有待核对来源资料，不能锁定或付款。"
        : null;
    };
    const revalidateJiaowubaoPayrollLock = async (rows: readonly PayrollRow[]) => {
      const reviewedFeed = jiaowubaoCompletedLessonFeed;
      if (reviewedFeed?.state !== "complete" || reviewedFeed.month !== activePayrollMonth) {
        notify("该月份的教务宝双源资料尚未完整读取；请先完成同步并核对后再锁定。");
        return null;
      }
      let freshFeed: JiaowubaoCompletedLessonFeed;
      try {
        freshFeed = await loadAllJiaowubaoCompletedLessonPages({ month: activePayrollMonth });
      } catch {
        notify("锁定前无法读取最新教务宝双源资料；本次未锁定，请稍后重试。");
        return null;
      }
      if (!jiaowubaoCompletedMonthEvidenceMatchesExportVersion({
        current: reviewedFeed,
        fresh: freshFeed,
        month: activePayrollMonth,
      })) {
        setJiaowubaoCompletedLessonFeed(freshFeed);
        setJiaowubaoCompletedLessonError(false);
        notify("教务宝来源或姓名映射已更新；页面已刷新，请核对最新资料后再锁定。");
        return null;
      }
      const sourceBlockReason = rows
        .map((row) => jiaowubaoPayrollSourceLockBlockReason(row, freshFeed))
        .find((reason) => reason !== null);
      if (sourceBlockReason) {
        notify(sourceBlockReason);
        return null;
      }
      return freshFeed;
    };
    const hasUnresolvedJiaowubaoEvidence = (row: PayrollDisplayRow) => {
      return jiaowubaoPayrollLockBlockReason(row) !== null;
    };
    const lockPayrollRow = (target: PayrollDisplayRow) => {
      const lockBlockReason = jiaowubaoPayrollLockBlockReason(target);
      if (lockBlockReason) {
        notify(lockBlockReason);
        return;
      }
      const sourceIndex = target.sourceIndex;
      if (sourceIndex === null) {
        const automatic = automaticPayrollRows.find((item) => item.id === target.id);
        if (automatic) {
          setPayrollDraft(automatic);
          setPayrollDraftSourceIndex(null);
          setModal("payrollEdit");
          notify("请先核对费率和金额，再锁定薪资");
        }
        return;
      }
      const row = payroll[sourceIndex];
      if (!row) {
        notify("薪资列表已变化，请刷新后重试");
        return;
      }
      if (row.status === "已锁定") return;
      const teacherName = row
        ? (teacherById(row.teacherId)?.name ?? row.teacherName ?? row.teacherId)
        : "未知老师";
      requestConfirmation({
        title: "确认锁定老师薪资",
        detail: `${teacherName} · ${formatMoney(row.amount, row.currency)} · ${row.month ?? "月份待确认"}`,
        items: [
          "请先确认课时、费率和学生明细",
          "锁定记录会保留实际登录管理员和时间",
        ],
        confirmLabel: "确认锁定",
        onConfirm: async () => {
          const freshFeed = await revalidateJiaowubaoPayrollLock([row]);
          if (!freshFeed) return;
          const currentRows = getCurrentPayrollState()
            .filter((item): item is PayrollRow => !("kind" in item));
          if (!payrollLockSnapshotIsCurrent(currentRows[sourceIndex], row)) {
            notify("薪资资料已更新，请核对后重试。");
            return;
          }
          try {
            const lockedAt = new Date().toISOString();
            let lockReceipts: PayrollLockReceipt<PayrollRow>[] = [];
            await mutatePayrollAndCommit((current) => {
              const currentRow = current[sourceIndex];
              if (!payrollLockSnapshotIsCurrent(currentRow, row)) throw new Error("薪资资料已更新，请核对后重试");
              const sourceBlockReason = jiaowubaoPayrollSourceLockBlockReason(currentRow, freshFeed);
              if (sourceBlockReason) throw new Error(sourceBlockReason);
              const next = current.map<PayrollRow>((item, index) =>
                index === sourceIndex ? {
                    ...item,
                    status: "已锁定",
                    lockedBy: operatorLabel(sessionOperator),
                    lockedAt,
                    note: item.note.includes("已锁定")
                      ? item.note
                      : `${item.note}；已由 ${operatorLabel(sessionOperator)} 人工锁定`,
                  }
                  : item,
              );
              lockReceipts = [{ before: { ...currentRow }, after: { ...next[sourceIndex] } }];
              return next;
            });
            addAudit(
              "锁定薪资记录",
              `${teacherName} · ${formatMoney(row.amount, row.currency)}`,
              "green",
            );
            notify("已锁定本月薪资记录", () => {
              void mutatePayrollAndCommit((current) => undoPayrollLocks(current, lockReceipts))
                .then(() => addAudit(
                  "撤销锁定薪资记录",
                  `${teacherName} · ${formatMoney(row.amount, row.currency)}`,
                  "amber",
                ))
                .catch((error) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销锁定薪资记录失败"));
            });
          } catch (error) {
            notify(error instanceof Error ? `薪资锁定保存失败：${error.message}` : "薪资锁定保存失败");
          }
        },
      });
    };

    const lockAllReadyPayroll = () => {
      const readyRows = monthPayroll.filter((row) => row.status === "可审核");
      if (!readyRows.length) return;
      if (!hasReadyJiaowubaoEvidenceForPayrollMonth) {
        notify("该月份的教务宝双源资料尚未完整读取；请先完成同步并核对后再锁定。");
        return;
      }
      const unresolvedCount = readyRows.filter(hasUnresolvedJiaowubaoEvidence).length;
      if (unresolvedCount) {
        notify(`${unresolvedCount} 条可审核薪资仍有教务宝来源待核对，不能批量锁定。`);
        return;
      }
      const readyTargets = readyRows.flatMap((row) => row.sourceIndex === null
        ? []
        : [{ sourceIndex: row.sourceIndex, row: payroll[row.sourceIndex] }])
        .filter((target): target is { sourceIndex: number; row: PayrollRow } => Boolean(target.row));
      if (readyTargets.length !== readyRows.length) {
        notify("自动课时记录需要先核对费率，不能直接批量锁定");
        return;
      }
      requestConfirmation({
        title: "确认批量锁定可审核薪资",
        detail: `${readyRows.length} 位老师 · ${activePayrollMonth}`,
        items: [
          "只锁定状态为“可审核”的记录",
          "需核对记录不会被锁定",
          "锁定后仍可在 12 秒内撤销",
        ],
        confirmLabel: `锁定 ${readyRows.length} 条`,
        onConfirm: async () => {
          const expectedRows = readyTargets.map((target) => target.row);
          const freshFeed = await revalidateJiaowubaoPayrollLock(expectedRows);
          if (!freshFeed) return;
          const currentRows = getCurrentPayrollState()
            .filter((item): item is PayrollRow => !("kind" in item));
          if (readyTargets.some((target) => !payrollLockSnapshotIsCurrent(currentRows[target.sourceIndex], target.row))) {
            notify("薪资资料已更新，请核对后重试。");
            return;
          }
          const readyIndexes = new Set(readyTargets.map((target) => target.sourceIndex));
          try {
            const lockedAt = new Date().toISOString();
            let lockReceipts: PayrollLockReceipt<PayrollRow>[] = [];
            await mutatePayrollAndCommit((current) => {
              for (const target of readyTargets) {
                const currentRow = current[target.sourceIndex];
                if (!payrollLockSnapshotIsCurrent(currentRow, target.row)) {
                  throw new Error("薪资资料已更新，请核对后重试");
                }
                const sourceBlockReason = jiaowubaoPayrollSourceLockBlockReason(currentRow, freshFeed);
                if (sourceBlockReason) throw new Error(sourceBlockReason);
              }
              const next = current.map<PayrollRow>((row, index) =>
                readyIndexes.has(index) ? {
                    ...row,
                    status: "已锁定",
                    lockedBy: operatorLabel(sessionOperator),
                    lockedAt,
                    note: row.note.includes("批量锁定")
                      ? row.note
                      : `${row.note}；已批量锁定`,
                  }
                  : row,
              );
              lockReceipts = readyTargets.map(({ sourceIndex }) => ({ before: { ...current[sourceIndex] }, after: { ...next[sourceIndex] } }));
              return next;
            });
            addAudit("批量锁定薪资", `${readyRows.length} 条可审核记录`, "green");
            notify(`已锁定 ${readyRows.length} 条可审核记录`, () => {
              void mutatePayrollAndCommit((current) => undoPayrollLocks(current, lockReceipts))
                .then(() => addAudit(
                  "撤销批量锁定薪资",
                  `${readyRows.length} 条记录恢复原状态`,
                  "amber",
                ))
                .catch((error) => notify(error instanceof Error ? `撤销失败：${error.message}` : "撤销批量锁定薪资失败"));
            });
          } catch (error) {
            notify(error instanceof Error ? `批量锁定薪资保存失败：${error.message}` : "批量锁定薪资保存失败");
          }
        },
      });
    };

    const exportCurrentPayroll = async () => {
      if (jiaowubaoCompletedLessonExportRunRef.current) return;
      if (!canExportCurrentPayroll || !jiaowubaoCompletedLessonFeed) {
        notify("该月份的教务宝双源资料尚未完整读取，不能导出完整版。");
        return;
      }
      const month = activePayrollMonth;
      const reviewedFeed = jiaowubaoCompletedLessonFeed;
      const renderedPayrollPayload = JSON.stringify(payrollState);
      const payrollPayloadAtStart = JSON.stringify(getCurrentPayrollState());
      const payrollVersionAtStart = getCurrentPayrollVersion();
      if (payrollPayloadAtStart !== renderedPayrollPayload) {
        notify("薪资资料已更新，请核对后重试。");
        return;
      }
      const payrollSnapshotStillCurrent = () => (
        getCurrentPayrollVersion() === payrollVersionAtStart
        && JSON.stringify(getCurrentPayrollState()) === payrollPayloadAtStart
      );
      jiaowubaoCompletedLessonExportRunRef.current = true;
      setJiaowubaoCompletedLessonExporting(true);
      try {
        let freshFeed: JiaowubaoCompletedLessonFeed;
        try {
          freshFeed = await loadAllJiaowubaoCompletedLessonPages({ month });
        } catch {
          notify("导出前无法读取最新教务宝双源资料；本次未下载，请稍后重试。");
          return;
        }
        if (!payrollSnapshotStillCurrent()) {
          notify("薪资资料已更新，请核对后重试。");
          return;
        }
        if (!jiaowubaoCompletedMonthEvidenceMatchesExportVersion({
          current: reviewedFeed,
          fresh: freshFeed,
          month,
        })) {
          setJiaowubaoCompletedLessonFeed(freshFeed);
          setJiaowubaoCompletedLessonError(false);
          notify(freshFeed.state === "complete"
            ? "教务宝来源或姓名映射已更新；页面已刷新，请核对最新资料后重新导出。"
            : "该月份目前没有完整已发布的教务宝快照，不能导出完整版。");
          return;
        }
        try {
          const unmatchedSourceRows = unmatchedJiaowubaoPayrollExportRows;
          const exportRows: PayrollExportRow[] = [
            ...monthPayroll.map((row): PayrollExportRow => {
              const source = jiaowubaoCompletedLessonEvidenceByTeacherMonth.get(
                payrollTeacherMonthKey(row.teacherId, row.month),
              );
              const currentEvidence = currentJiaowubaoPayrollExportEvidence(source);
              const sourceVersionIsCurrent = jiaowubaoPayrollSourceVersionIsCurrent({
                persistedSourceRevision: row.sourceRevision,
                persistedProjectionRevision: row.sourceProjectionRevision,
                currentSourceRevision: freshFeed.revision,
                currentProjectionRevision: freshFeed.projectionRevision,
              });
              const paymentMode = freshFeed.provisional || row.paymentReviewOnly || !source || !sourceVersionIsCurrent
                || !jiaowubaoCompletedLessonCanGeneratePayroll(source.summary) || row.status === "需核对"
                ? "review_only"
                : "payable";
              return {
                teacherKey: source?.summary.identityKey ?? `internal:${row.teacherId}`,
                teacherId: row.teacherId,
                sourceTeacherId: source?.summary.sourceTeacherId,
                teacherName: teacherById(row.teacherId)?.name ?? row.teacherName ?? row.teacherId,
                month: row.month ?? month,
                section: row.section ?? "教师薪资",
                currency: row.currency ?? "AUD",
                status: paymentMode === "review_only" ? "需核对" : row.status,
                payrollHours: paymentMode === "review_only" ? 0 : row.teacherTotalHours ?? row.lessons + row.trialLessons,
                sourceHours: currentEvidence.sourceHours,
                sourceLessonCount: currentEvidence.sourceLessonCount,
                amount: paymentMode === "review_only" ? 0 : row.amount,
                bankName: paymentMode === "review_only" ? undefined : row.bankName,
                bankAccount: paymentMode === "review_only" ? undefined : row.bankAccount,
                paymentNote: paymentMode === "review_only" ? undefined : row.paymentNote ?? row.note,
                lockedBy: paymentMode === "review_only" ? undefined : row.lockedBy,
                lockedAt: paymentMode === "review_only" ? undefined : row.lockedAt,
                paymentMode,
                lines: currentEvidence.lines,
              };
            }),
            ...unmatchedSourceRows,
          ];
          const teacherLessonSourceKeysByTeacher = new Map(
            [...freshFeed.teacherEvidenceSourceKeys.entries()].map(([teacherKey, sourceKeys]) => [
              teacherKey,
              [...sourceKeys].sort(),
            ] as const),
          );
          // Persisted/internal review-only rows may have no current JWB role.
          // Give each one an explicit empty expectation so the workbook can
          // still require a unique row and reject any stale student evidence.
          for (const row of exportRows) {
            if (!teacherLessonSourceKeysByTeacher.has(row.teacherKey)) {
              teacherLessonSourceKeysByTeacher.set(row.teacherKey, []);
            }
          }
          const teacherLessonSourceKeys = [...teacherLessonSourceKeysByTeacher.entries()]
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([teacherKey, sourceKeys]) => ({ teacherKey, sourceKeys }));
          if (!payrollSnapshotStillCurrent()) {
            notify("薪资资料已更新，请核对后重试。");
            return;
          }
          downloadPayrollExcel({
            month,
            generatedAt: new Date().toISOString(),
            exportMode: "hours_complete",
            rows: exportRows,
            evidence: {
              revision: freshFeed.revision,
              projectionRevision: freshFeed.projectionRevision,
              publishedAt: freshFeed.publishedAt,
              dataThrough: freshFeed.dataThrough,
              provisional: freshFeed.provisional,
              lessonRowCount: freshFeed.rowCount,
              scheduleRowCount: freshFeed.scheduleRowCount,
              teacherLessonSourceKeys,
              matchCounts: {
                matchedStudents: freshFeed.matchedStudentCount,
                unmatchedStudents: freshFeed.unmatchedStudentCount,
                ambiguousStudents: freshFeed.ambiguousStudentCount,
                matchedTeachers: freshFeed.matchedTeacherCount,
                unmatchedTeachers: freshFeed.unmatchedTeacherCount,
                ambiguousTeachers: freshFeed.ambiguousTeacherCount,
              },
              lessons: freshFeed.items,
              schedules: freshFeed.scheduleEvents,
            },
          });
          addAudit("导出月度课时 XLSX", `${month} · ${exportRows.length} 位老师`, "blue");
        } catch {
          notify("薪资工作簿校验或下载准备失败；本次未下载，请核对重复老师和来源明细后重试。");
        }
      } finally {
        jiaowubaoCompletedLessonExportRunRef.current = false;
        setJiaowubaoCompletedLessonExporting(false);
      }
    };

    return (
      <>
        <ViewHeading
          eyebrow="薪资管理"
          title="课时与薪资"
          actions={
            <>
              <label className="payroll-month-picker">
                <span>薪资月份</span>
                <input
                  type="month"
                  value={activePayrollMonth}
                  disabled={jiaowubaoCompletedLessonExporting}
                  onChange={(event) => {
                    setPayrollMonthSelection(event.target.value);
                    setPayrollPage(1);
                    setSelectedPayrollKey("");
                  }}
                  aria-label="薪资月份"
                />
              </label>
              <button className="secondary-button" type="button" disabled={!canExportCurrentPayroll} onClick={() => void exportCurrentPayroll()}>
                <Download size={17} /> {jiaowubaoCompletedLessonExporting ? "校验来源…" : "导出本月 Excel"}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={jiaowubaoCompletedLessonLoading || jiaowubaoCompletedLessonSyncing || jiaowubaoCompletedLessonExporting || !hasCollectablePayrollDates}
                title={!hasCollectablePayrollDates ? "该月份暂无截至昨日的课时" : undefined}
                onClick={() => void syncJiaowubaoCompletedLessons()}
              >
                <RefreshCw size={17} /> {jiaowubaoCompletedLessonSyncing ? "正在同步已消课…" : "同步教务宝已消课"}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={jiaowubaoCompletedLessonExporting}
                onClick={() => setModal("payrollNew")}
              >
                <UserPlus size={17} /> 新增老师薪资
              </button>
            </>
          }
        />
        {jiaowubaoCompletedLessonLoading ? (
          <div className="form-notice" role="status"><RefreshCw size={16} /> 正在读取 {activePayrollMonth} 的教务宝已消课快照…</div>
        ) : jiaowubaoCompletedLessonError ? (
          <div className="form-notice" role="status"><CircleAlert size={16} /> 教务宝已消课快照暂时不可用；不会用空资料覆盖现有薪资记录。</div>
        ) : jiaowubaoCompletedLessonFeed?.state === "complete" ? (
          <div className="form-notice" role="status"><Database size={16} /><span><strong>最近成功更新：{jiaowubaoCompletedLessonFeed.publishedAt ? <time dateTime={jiaowubaoCompletedLessonFeed.publishedAt}>{formatInstant(new Date(jiaowubaoCompletedLessonFeed.publishedAt), "Australia/Melbourne", displayPreferences)}</time> : "待确认"}（墨尔本时间）</strong><br />数据截至 {jiaowubaoCompletedLessonFeed.dataThrough}（{jiaowubaoCompletedLessonFeed.provisional ? "月中核对版" : "完整月份"}）。已接入 {jiaowubaoCompletedLessonFeed.rowCount} 条学生已消课明细和 {jiaowubaoCompletedLessonFeed.scheduleRowCount} 条已消课排课角色资料（均为 over=1）。学生明细补齐姓名；老师课时只取排课角色字段。{jiaowubaoCompletedLessonFeed.unmatchedStudentCount + jiaowubaoCompletedLessonFeed.ambiguousStudentCount} 条学生待核对，{jiaowubaoCompletedLessonFeed.teachers.reduce((count, teacher) => count + teacher.unresolvedLessonCount + teacher.unresolvedTrialLessonCount, 0)} 个老师来源项目待核对；待核对项目会作为只读来源明细附在 Excel 中，不写入薪资或付款资料。</span></div>
        ) : jiaowubaoCompletedLessonFeed?.state === "absent" ? (
          <div className="form-notice" role="status"><CircleAlert size={16} /> {activePayrollMonth} 尚未成功更新，暂无已发布的课时资料。</div>
        ) : null}
        {sourceOnlyPayrollTeachers.length > 0 ? (
          <section className="panel" aria-label="教务宝待核对老师">
            <div className="panel-header"><div><h2>教务宝待核对老师</h2></div></div>
            <div className="payroll-line-list">
              {sourceOnlyPayrollTeachers.map((summary) => (
                <div className="payroll-line" key={summary.identityKey}>
                  <span><strong>{summary.sourceTeacherName ?? summary.teacherName ?? "未命名老师"}</strong></span>
                  <span>{summary.sourceHours === null ? "课时待核对" : formatHours(summary.sourceHours)}</span>
                  <span>{summary.sourceLessonCount} 节课</span>
                  <span>{jiaowubaoCompletedLessonSourceReviewLabel(summary)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section className="metric-grid payroll-metrics">
          <Metric
            tone="blue"
            icon={<FileText size={21} />}
            value={formatHours(totalHours)}
            label="薪资表课时"
            detail={`${monthPayroll.reduce((total, row) => total + (row.lineCount ?? row.lines?.length ?? 0), 0)} 条学生明细`}
          />
          <Metric
            tone="amber"
            icon={<CircleAlert size={21} />}
            value={`${monthPayroll.filter((row) => row.status === "需核对").length}`}
            label="需要核对"
            detail="姓名、课时或费率例外"
          />
          <Metric
            tone="green"
            icon={<Wallet size={21} />}
            value={formatMoney(cnyTotal, "CNY")}
            label="人民币薪资"
            detail="国内教师合计"
          />
          <Metric
            tone="purple"
            icon={<ShieldCheck size={21} />}
            value={formatMoney(audTotal, "AUD")}
            label="澳币薪资"
            detail={`${monthPayroll.filter((row) => row.status === "已锁定").length} 条已锁定`}
          />
        </section>
        <section className="panel collection-shell">
          <div className="view-bar">
            <ViewTabs
              value={payrollFilter}
              items={[
                { id: "all", label: "全部", count: monthPayroll.length },
                {
                  id: "review",
                  label: "需核对",
                  count: monthPayroll.filter((item) => item.status === "需核对")
                    .length,
                },
                {
                  id: "ready",
                  label: "可审核",
                  count: monthPayroll.filter((item) => item.status === "可审核")
                    .length,
                },
                {
                  id: "locked",
                  label: "已锁定",
                  count: monthPayroll.filter((item) => item.status === "已锁定")
                    .length,
                },
              ]}
              onChange={(value) => {
                setPayrollFilter(value);
                setPayrollPage(1);
              }}
              label="薪资保存视图"
            />
            <div className="toolbar-actions">
              <select
                className="filter-select"
                value={payrollCurrency}
                onChange={(event) => {
                  setPayrollCurrency(event.target.value);
                  setPayrollPage(1);
                }}
                aria-label="薪资币种筛选"
              >
                <option value="all">全部币种</option>
                <option value="CNY">人民币</option>
                <option value="AUD">澳币</option>
              </select>
              <button
                className="secondary-button"
                type="button"
                disabled={jiaowubaoCompletedLessonExporting || !hasReadyJiaowubaoEvidenceForPayrollMonth || !monthPayroll.some((row) => row.status === "可审核")}
                onClick={lockAllReadyPayroll}
              >
                <ShieldCheck size={16} /> 批量锁定可审核
              </button>
            </div>
          </div>
          {monthPayroll.length ? (
            <div className="master-detail-layout payroll-layout">
              <article className="collection-main">
                <div className="collection-head payroll-grid-row">
                  <span>老师</span>
                  <span>薪资表课时</span>
                  <span>教务宝课时</span>
                  <span>建议金额</span>
                  <span>状态</span>
                </div>
                <div className="collection-viewport">
                  {pagedPayroll.length ? (
                    pagedPayroll.map((row) => {
                      const teacher = teacherById(row.teacherId);
                      const teacherName =
                        teacher?.name ?? row.teacherName ?? row.teacherId;
                      const salaryHours =
                        row.teacherTotalHours ?? row.lessons + row.trialLessons;
                      const hasVariance =
                        row.hourVariance !== null &&
                        row.hourVariance !== undefined &&
                        Math.abs(row.hourVariance) > 0.01;
                      return (
                        <button
                          className={`collection-row payroll-grid-row ${selectedPayroll?.viewKey === row.viewKey ? "selected" : ""}`}
                          type="button"
                          key={row.viewKey}
                          onClick={() => setSelectedPayrollKey(row.viewKey)}
                        >
                          <span className="table-person">
                            <Avatar
                              initials={
                                teacher?.initials ?? initials(teacherName)
                              }
                              tone={row.status === "需核对" ? "amber" : "blue"}
                            />
                            <span>
                              <strong>{teacherName}</strong>
                              <small>
                                {payrollCurrencyLabel(row.currency)}
                              </small>
                            </span>
                          </span>
                          <span>
                            <strong>{formatHours(salaryHours)}</strong>
                            <small>
                              {(row.lineCount ?? row.lines?.length ?? 0) > 0 ? `${row.lineCount ?? row.lines?.length ?? 0} 条明细` : null}
                            </small>
                          </span>
                          <span className={hasVariance ? "low-hours" : ""}>
                            {row.sourceHours === null || row.sourceHours === undefined ? "待核对" : formatHours(row.sourceHours)}
                            <small>
                              {hasVariance
                                ? `差异 ${formatHours(row.hourVariance)}`
                                : row.sourceHours === null ||
                                    row.sourceHours === undefined
                                  ? "来源待核对"
                                  : "已匹配"}
                            </small>
                          </span>
                          <strong>
                            {formatMoney(row.amount, row.currency)}
                          </strong>
                          <StatusPill tone={statusTone(row.status)}>
                            {row.status}
                          </StatusPill>
                        </button>
                      );
                    })
                  ) : (
                    <EmptyState
                      title="当前筛选下没有薪资记录"
                      detail="切换状态或币种筛选查看其他记录。"
                    />
                  )}
                </div>
                <Pagination
                  page={safePayrollPage}
                  total={visiblePayroll.length}
                  pageSize={payrollPageSize}
                  onPage={setPayrollPage}
                />
              </article>
              {selectedPayroll && (
                <aside className="record-preview payroll-preview">
                  <div className="preview-header">
                    <div>
                      <p className="eyebrow">
                        {selectedPayroll.month ?? "薪资月份待确认"} ·{" "}
                        {selectedPayroll.section ?? "教师薪资"}
                      </p>
                      <h2>
                        {teacherById(selectedPayroll.teacherId)?.name ??
                          selectedPayroll.teacherName ??
                          selectedPayroll.teacherId}
                      </h2>
                    </div>
                    <StatusPill tone={statusTone(selectedPayroll.status)}>
                      {selectedPayroll.status}
                    </StatusPill>
                  </div>
                  <div className="student-facts payroll-facts">
                    <span>
                      <small>薪资表课时</small>
                      <strong>
                        {formatHours(
                          selectedPayroll.teacherTotalHours ??
                            selectedPayroll.lessons +
                              selectedPayroll.trialLessons,
                        )}
                      </strong>
                      <em>
                        常规 {formatHours(selectedPayroll.lessons)} · 试听{" "}
                        {formatHours(selectedPayroll.trialLessons)}
                      </em>
                    </span>
                    <span>
                      <small>教务宝课时</small>
                      <strong>
                        {selectedPayroll.sourceHours === null || selectedPayroll.sourceHours === undefined ? "待核对" : formatHours(selectedPayroll.sourceHours)}
                      </strong>
                      <em>
                        {selectedPayroll.sourceLessonCount === null ||
                        selectedPayroll.sourceLessonCount === undefined
                          ? "来源待核对"
                          : `${selectedPayroll.sourceLessonCount} 节课`}
                      </em>
                    </span>
                    <span>
                      <small>建议金额</small>
                      <strong>
                        {formatMoney(
                          selectedPayroll.amount,
                          selectedPayroll.currency,
                        )}
                      </strong>
                      <em>{payrollCurrencyLabel(selectedPayroll.currency)}</em>
                    </span>
                    <span>
                      <small>付款信息</small>
                      <strong>
                        {maskAccount(selectedPayroll.bankAccount)}
                      </strong>
                      <em>{selectedPayroll.bankName || "银行待确认"}</em>
                    </span>
                  </div>
                  <div className="detail-section">
                    <span>费率与说明</span>
                    <strong>
                      {selectedPayroll.rateRange?.length
                        ? selectedPayroll.rateRange
                            .map((rate) =>
                              formatMoney(rate, selectedPayroll.currency),
                            )
                            .join("、")
                        : "费率待确认"}
                    </strong>
                    <p>{selectedPayroll.paymentNote || selectedPayroll.note}</p>
                  </div>
                  <div className="detail-section">
                    <span>学生明细</span>
                    <div className="payroll-line-list">
                      {(selectedPayroll.lines ?? [])
                        .slice(0, 12)
                        .map((line) => (
                          <div
                            className="payroll-line"
                            key={`${line.studentName}-${line.sourceRow}`}
                          >
                            <span>
                              <strong>{line.studentName}</strong>
                              <small>
                                {line.note ||
                                  (line.isTrial ? "试听" : "常规课")}
                              </small>
                            </span>
                            <span>{line.hours === null ? "课时待核对" : formatHours(line.hours)}</span>
                            <span>
                              {line.evidenceOnly
                                ? "来源明细"
                                : formatMoney(line.rate, selectedPayroll.currency)}
                            </span>
                            <strong>
                              {line.evidenceOnly
                                ? "不分摊"
                                : formatMoney(
                                  line.subtotal,
                                  selectedPayroll.currency,
                                )}
                            </strong>
                          </div>
                        ))}
                      {(selectedPayroll.lines?.length ?? 0) > 12 && (
                        <p className="muted-cell">
                          还有 {(selectedPayroll.lines?.length ?? 0) - 12} 条明细
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    className="secondary-button full"
                    type="button"
                    disabled={jiaowubaoCompletedLessonExporting}
                    onClick={() => {
                      const persisted = selectedPayroll.sourceIndex === null
                        ? automaticPayrollRows.find((row) => row.id === selectedPayroll.id)
                        : payroll[selectedPayroll.sourceIndex];
                      if (!persisted) {
                        notify("薪资列表已变化，请刷新后重试");
                        return;
                      }
                      const source = jiaowubaoCompletedLessonEvidenceByTeacherMonth.get(
                        payrollTeacherMonthKey(persisted.teacherId, persisted.month),
                      );
                      if (source && !jiaowubaoCompletedLessonCanGeneratePayroll(source.summary)) {
                        notify(`请先处理${jiaowubaoCompletedLessonSourceReviewLabel(source.summary)}，再设置薪资费率。`);
                        return;
                      }
                      const sourceHours = source?.summary.sourceHours ?? null;
                      const trialHours = source?.summary.trialSourceHours ?? null;
                      const draft = source && sourceHours !== null && trialHours !== null
                        ? {
                          ...overlayPersistedPayrollWithJiaowubaoEvidence(persisted, {
                            sourceHours,
                            sourceLessonCount: source.summary.sourceLessonCount,
                            sourceNoShowHours: null,
                            lines: source.lines,
                          }),
                          lessons: Number(Math.max(0, sourceHours - trialHours).toFixed(4)),
                          trialLessons: trialHours,
                          teacherTotalHours: sourceHours,
                          sourceHours,
                          hourVariance: 0,
                          source: "jiaowubao-completed-lessons",
                          sourceRevision: jiaowubaoCompletedLessonFeed?.revision ?? undefined,
                          sourceProjectionRevision: jiaowubaoCompletedLessonFeed?.projectionRevision ?? undefined,
                        }
                        : persisted;
                      setPayrollDraft(draft);
                      setPayrollDraftSourceIndex(selectedPayroll.sourceIndex);
                      setModal("payrollEdit");
                    }}
                  >
                    <Pencil size={16} /> 编辑老师与费率
                  </button>
                  {selectedPayroll.status !== "已锁定" ? (
                    <>
                    {jiaowubaoPayrollLockBlockReason(selectedPayroll) ? <div className="form-notice"><CircleAlert size={16} /> {jiaowubaoPayrollLockBlockReason(selectedPayroll)}</div> : null}
                    <button
                      className="primary-button full"
                      type="button"
                      disabled={jiaowubaoCompletedLessonExporting || Boolean(jiaowubaoPayrollLockBlockReason(selectedPayroll))}
                      onClick={() => lockPayrollRow(selectedPayroll)}
                    >
                      <ShieldCheck size={16} /> 人工锁定此老师薪资
                    </button>
                    </>
                  ) : null}
                </aside>
              )}
            </div>
          ) : (
            <EmptyState
              title="该月份暂无薪资记录"
              detail="可以新增老师薪资记录，或先载入该月份的课时数据。"
            />
          )}
        </section>
      </>
    );
  };

  const hasScopedActiveStudentRecords = scopedActiveStudents.length > 0;
  const openStudentAssociationSetup = () => {
    setActive("students");
    setSelectedStudentId("");
    setMobilePreview(null);
    setModal("student");
  };
  const studentAssociationActions = () => {
    if (isTeacherView) return undefined;
    return <>
      <button className="primary-button" type="button" onClick={openStudentAssociationSetup}>
        <UserPlus size={17} /> 先新建学生
      </button>
      {isAdminView ? <button className="secondary-button" type="button" onClick={() => setActive("sync")}>
        <Database size={17} /> 去同步与导入
      </button> : null}
    </>;
  };
  const studentAssociationDetail = (recordLabel: string) => isTeacherView
    ? `${recordLabel}必须关联当前范围的活跃学生；管理员完成学生关联后才可创建，系统不会保存未关联记录。`
    : `${recordLabel}必须关联当前范围的活跃学生，系统不会保存未关联记录。请先新建学生${isAdminView ? "或前往同步与导入" : ""}。`;
  const studentAssociationNotice = (recordLabel: string) => !hasScopedActiveStudentRecords
    ? <div className="form-notice" role="status"><CircleAlert size={16} /> {studentAssociationDetail(recordLabel)}</div>
    : null;
  const messageHeadingActions = () => hasScopedActiveStudentRecords
    ? <button className="primary-button" type="button" onClick={() => setModal("template")}>
      <Plus size={17} /> 新建消息
    </button>
    : studentAssociationActions();

  const renderMessages = () => {
    const visibleMessages = scopedMessages.filter((message) => {
      const matchesQuery =
        `${message.kind} ${message.recipient} ${studentById(message.studentId)?.name ?? ""}`
          .toLowerCase()
          .includes(messageQuery.trim().toLowerCase());
      if (!matchesQuery) return false;
      if (messageFilter === "open") return message.status !== "已记录发送";
      if (messageFilter === "confirm") return message.status === "待人工确认";
      if (messageFilter === "sent") return message.status === "已记录发送";
      if (messageFilter === "internal") return message.status === "仅内部";
      return true;
    });
    const selectedMessage =
      visibleMessages.find(
        (message) => message.id === selectedMessageState?.id,
      ) ?? visibleMessages[0];
    if (!selectedMessage && !scopedMessages.length) {
      return (
        <>
          <ViewHeading
            eyebrow="消息管理"
            title="消息队列"
            actions={messageHeadingActions()}
          />
          <section className="panel collection-shell">
            <EmptyState
              title={hasScopedActiveStudentRecords ? "暂无消息记录" : "先关联一位活跃学生"}
              detail={hasScopedActiveStudentRecords ? "新建消息后会在这里显示。" : studentAssociationDetail("消息")}
              action={!hasScopedActiveStudentRecords ? studentAssociationActions() : undefined}
            />
          </section>
        </>
      );
    }
    if (!selectedMessage) {
      return (
        <>
          <ViewHeading
            eyebrow="消息管理"
            title="消息队列"
            actions={messageHeadingActions()}
          />
          <section className="panel collection-shell">
            <ViewTabs
              value={messageFilter}
              items={[
                { id: "open", label: "待处理", count: scopedMessages.filter((item) => item.status !== "已记录发送").length },
                { id: "confirm", label: "待人工确认", count: scopedMessages.filter((item) => item.status === "待人工确认").length },
                { id: "internal", label: "仅内部", count: scopedMessages.filter((item) => item.status === "仅内部").length },
                { id: "sent", label: "已记录发送", count: scopedMessages.filter((item) => item.status === "已记录发送").length },
                { id: "all", label: "全部", count: scopedMessages.length },
              ]}
              onChange={setMessageFilter}
              label="消息保存视图"
            />
            <ListToolbar
              query={messageQuery}
              onQuery={setMessageQuery}
              placeholder="搜索学生、消息类型或收件对象"
              count=""
            />
            <EmptyState
              title="没有符合条件的消息"
              detail={hasScopedActiveStudentRecords ? "切换状态视图或清除搜索，不会显示筛选范围以外的旧详情。" : studentAssociationDetail("消息")}
              action={!hasScopedActiveStudentRecords ? studentAssociationActions() : undefined}
            />
          </section>
        </>
      );
    }
    const recipientUnresolved =
      !selectedMessage.recipient.trim() ||
      /待关联|待确认|未知/.test(selectedMessage.recipient);
    const selectedMessageStudentActive = scopedActiveStudentIds.has(selectedMessage.studentId);
    return (
      <>
        <ViewHeading
          eyebrow="消息管理"
          title="消息队列"
          actions={messageHeadingActions()}
        />
        {studentAssociationNotice("消息")}
        <section className="panel collection-shell">
          <ViewTabs
            value={messageFilter}
            items={[
              {
                id: "open",
                label: "待处理",
                count: scopedMessages.filter(
                  (item) => item.status !== "已记录发送",
                ).length,
              },
              {
                id: "confirm",
                label: "待人工确认",
                count: scopedMessages.filter(
                  (item) => item.status === "待人工确认",
                ).length,
              },
              {
                id: "internal",
                label: "仅内部",
                count: scopedMessages.filter((item) => item.status === "仅内部")
                  .length,
              },
              {
                id: "sent",
                label: "已记录发送",
                count: scopedMessages.filter(
                  (item) => item.status === "已记录发送",
                ).length,
              },
              { id: "all", label: "全部", count: scopedMessages.length },
            ]}
            onChange={setMessageFilter}
            label="消息保存视图"
          />
          <ListToolbar
            query={messageQuery}
            onQuery={setMessageQuery}
            placeholder="搜索学生、消息类型或收件对象"
            count={`${visibleMessages.length} 条消息`}
          />
          <div className="master-detail-layout message-layout">
            <article className="collection-main">
              <div className="collection-viewport message-list">
                {visibleMessages.length ? (
                  visibleMessages.map((message) => {
                    const student = studentById(message.studentId);
                    return (
                      <button
                        className={`message-list-row ${selectedMessage.id === message.id ? "selected" : ""}`}
                        type="button"
                        key={message.id}
                        onClick={() => {
                          setSelectedMessageId(message.id);
                          setMobilePreview("message");
                        }}
                      >
                        <span
                          className={`route-icon ${message.status === "待人工确认" ? "amber" : "blue"}`}
                        >
                          <MessageCircle size={18} />
                        </span>
                        <span>
                          <strong>{message.kind}</strong>
                          <small>
                            {student?.name} · {message.recipient}
                          </small>
                          <em>{message.body}</em>
                        </span>
                        <span>
                          <StatusPill
                            tone={
                              message.status === "待人工确认"
                                ? "amber"
                                : message.status === "已记录发送"
                                  ? "green"
                                  : "blue"
                            }
                          >
                            {message.status}
                          </StatusPill>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <EmptyState
                    title="没有符合条件的消息"
                    detail="切换视图或清除搜索。"
                  />
                )}
              </div>
              <div className="send-log"><p><CircleAlert size={15} /> 外部发送需人工确认。</p></div>
            </article>
            <aside
              className={`record-preview message-preview ${mobilePreview === "message" ? "mobile-detail-open" : ""}`}
            >
              <button
                className="mobile-preview-close"
                type="button"
                aria-label="关闭消息详情"
                onClick={() => setMobilePreview(null)}
              >
                <ChevronLeft size={20} /> 返回消息列表
              </button>
              <div className="preview-header">
                <div>
                  <h2>{selectedMessage.kind}</h2>
                </div>
                <StatusPill
                  tone={
                    selectedMessage.status === "待人工确认"
                      ? "amber"
                      : selectedMessage.status === "已记录发送"
                        ? "green"
                        : "blue"
                  }
                >
                  {selectedMessage.status}
                </StatusPill>
              </div>
              <div className="route-summary">
                <span>
                  关联学生
                  <strong>
                    {studentById(selectedMessage.studentId)?.name}
                  </strong>
                </span>
                <span>
                  收件对象<strong>{selectedMessage.recipient}</strong>
                </span>
              </div>
              <div className="message-bubble">{selectedMessage.body}</div>
              <button
                className="primary-button full"
                type="button"
                disabled={
                  selectedMessage.status === "已记录发送" ||
                  recipientUnresolved ||
                  !selectedMessageStudentActive
                }
                onClick={recordMessage}
              >
                <Send size={16} />{" "}
                {selectedMessage.status === "已记录发送"
                  ? "已记录发送"
                  : recipientUnresolved
                    ? "先关联收件对象"
                    : !selectedMessageStudentActive
                      ? "关联学生已不活跃"
                      : "记录为已发送"}
              </button>
            </aside>
          </div>
        </section>
      </>
    );
  };

  const renderFiles = () => {
    const visibleFiles = scopedFiles.filter((file) => {
      const matchesQuery =
        `${file.title} ${file.type} ${studentById(file.studentId)?.name ?? ""}`
          .toLowerCase()
          .includes(fileQuery.trim().toLowerCase());
      return matchesQuery && (fileFilter === "all" || file.type === fileFilter);
    });
    return (
      <>
        <ViewHeading
          eyebrow="学生资料"
          title="文件中心"
          actions={hasScopedActiveStudentRecords && !isTeacherView ?
            <button
              className="primary-button"
              type="button"
              onClick={() => { setFileStorageMode("link"); setFileUploadType("Report 资料"); setModal("file"); }}
            >
              <FilePlus2 size={17} /> 添加资料
            </button>
          : !hasScopedActiveStudentRecords ? studentAssociationActions() : undefined}
        />
        {studentAssociationNotice("资料")}
        <section className="panel collection-shell">
          <ViewTabs
            value={fileFilter}
            items={[
              { id: "all", label: "全部", count: scopedFiles.length },
              {
                id: "Learning Plan",
                label: "Learning Plan",
                count: scopedFiles.filter(
                  (item) => item.type === "Learning Plan",
                ).length,
              },
              {
                id: "成绩单",
                label: "成绩单",
                count: scopedFiles.filter((item) => item.type === "成绩单")
                  .length,
              },
              {
                id: "课堂反馈",
                label: "课堂反馈",
                count: scopedFiles.filter((item) => item.type === "课堂反馈")
                  .length,
              },
              {
                id: "续课 FU",
                label: "续课 FU",
                count: scopedFiles.filter((item) => item.type === "续课 FU")
                  .length,
              },
              {
                id: "资料链接",
                label: "资料链接",
                count: scopedFiles.filter((item) => item.type === "资料链接")
                  .length,
              },
            ]}
            onChange={setFileFilter}
            label="文件保存视图"
          />
          <ListToolbar
            query={fileQuery}
            onQuery={setFileQuery}
            placeholder="搜索资料名、学生或类型"
            count={visibleFiles.length ? `${visibleFiles.length} 项资料` : ""}
          />
          <div className="collection-main">
            <div className="collection-head file-grid-row">
              <span>资料</span>
              <span>关联学生</span>
              <span>类型</span>
            </div>
            <div className="collection-viewport">
              {visibleFiles.length ? (
                visibleFiles.map((file) => {
                  const student = studentById(file.studentId);
                  const linkedSource =
                    file.source.startsWith("/") ||
                    /^https?:\/\//.test(file.source);
                  return (
                    <div className="collection-row file-grid-row" key={file.id}>
                      <span className="file-title">
                        <span className="file-icon">
                          <FileText size={17} />
                        </span>
                        {linkedSource ? (
                          <a
                            className="inline-link file-source-link"
                            href={file.source}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {file.title} <ExternalLink size={13} />
                          </a>
                        ) : <strong>{file.title}</strong>}
                      </span>
                      <button
                        className="inline-link"
                        type="button"
                        onClick={() => goToStudent(file.studentId)}
                      >
                        {student?.name} <ChevronRight size={14} />
                      </button>
                      <StatusPill
                        tone={
                          file.type === "Learning Plan"
                            ? "blue"
                            : file.type === "续课 FU"
                              ? "green"
                              : "neutral"
                        }
                      >
                        {file.type}
                      </StatusPill>
                    </div>
                  );
                })
              ) : (
                <EmptyState
                  title={hasScopedActiveStudentRecords ? "没有找到资料" : "先关联一位活跃学生"}
                  detail={hasScopedActiveStudentRecords ? "调整类型视图或搜索关键词。" : studentAssociationDetail("资料")}
                  action={!hasScopedActiveStudentRecords ? studentAssociationActions() : undefined}
                />
              )}
            </div>
          </div>
        </section>
      </>
    );
  };

  const renderSync = () => (
    <>
      <ViewHeading
        eyebrow="数据管理"
        title="同步与导入"
        actions={
          <>
            <button
              className="primary-button"
              type="button"
              disabled={syncRefreshBusy}
              onClick={() => void refreshSourceStatus()}
            >
              <RefreshCw size={17} />
              {syncRefreshBusy ? "正在检查来源…" : "检查来源状态"}
            </button>
          </>
        }
      />
      <section className="sync-workspace">
        {canUseAdminScope ? <JiaowubaoAuthorityStatusPanel status={jiaowubaoAuthorityStatus} /> : null}
        {canUseAdminScope ? <section className="panel import-preview-panel">
          <div className="panel-header">
            <div><h2>学生正式导入</h2></div>
            <div className="toolbar-actions">
              <button className="secondary-button" type="button" disabled={studentImportBusy} onClick={() => void previewStudentImport()}>{studentImportBusy ? "正在预检…" : "读取最新总表与教务宝"}</button>
              <button className="primary-button" type="button" disabled={studentImportBusy || !studentImportPreview?.canCommit} onClick={commitStudentImport}>确认正式导入</button>
            </div>
          </div>
          <div className="student-source-ingest-grid">
            {(["master", "jwb"] as const).map((sourceKind) => {
              const sourceLabel = sourceKind === "master" ? "学生总表" : "教务宝";
              const status = studentImportSourceStatus[sourceKind];
              return <article className="student-source-ingest-card" key={sourceKind}>
                <div><strong>{sourceLabel}</strong>{status ? <StatusPill tone="green">{status.rowCount} 行已保存</StatusPill> : <StatusPill tone="amber">待选择文件</StatusPill>}</div>
                {sourceKind === "master" ? <div className="fixed-source-format"><small>建档依据</small><strong>有姓名且非“不活跃 + 无课时”的学生</strong></div> : null}
                {sourceKind === "jwb" ? <div className="form-notice"><CircleAlert size={16} /> 教务宝资料导入后可在这里预检。</div> : <>
                  <label>来源 ID<input value={studentImportSourceMeta[sourceKind].sourceId} maxLength={160} onChange={(event) => setStudentImportSourceMeta((current) => ({ ...current, [sourceKind]: { ...current[sourceKind], sourceId: event.target.value } }))} /></label>
                  <label>revision<input value={studentImportSourceMeta[sourceKind].revision} maxLength={240} placeholder="例如 2026-08-13T12:00Z" onChange={(event) => setStudentImportSourceMeta((current) => ({ ...current, [sourceKind]: { ...current[sourceKind], revision: event.target.value } }))} /></label>
                  <label>JSON 内容<textarea value={studentImportSourceJson[sourceKind]} rows={4} placeholder='[{"sourceRow":1,"name":"..."}]' onChange={(event) => setStudentImportSourceJson((current) => ({ ...current, [sourceKind]: event.target.value }))} /></label>
                  <div className="toolbar-actions">
                    <button className="secondary-button" type="button" disabled={Boolean(studentImportSourceBusy) || !studentImportSourceJson[sourceKind].trim()} onClick={() => void submitStudentImportSource(sourceKind, studentImportSourceJson[sourceKind])}>{studentImportSourceBusy === sourceKind ? "正在保存…" : "校验并保存粘贴内容"}</button>
                    <input id={`student-source-${sourceKind}`} className="visually-hidden" type="file" accept="application/json,.json" disabled={Boolean(studentImportSourceBusy)} onChange={(event) => void ingestStudentImportSourceFile(sourceKind, event)} />
                    <label className="secondary-button" aria-disabled={Boolean(studentImportSourceBusy)} htmlFor={`student-source-${sourceKind}`}>选择 JSON 文件</label>
                  </div>
                </>}
                {status ? <small>{status.sourceId} · {status.revision}</small> : null}
              </article>;
            })}
          </div>
          <div className="student-identity-link-bar">
            <div>
              <strong>教务宝资料人工关联（可选补充）</strong>
              <small>{studentIdentityLinkStatus ? `当前已保存 ${studentIdentityLinkStatus.count} 条；仅用于补充课时、课包和首笔课时日期，不影响总表学生建档` : "可为总表学生补充教务宝资料；未关联教务宝的总表学生仍会建档"}</small>
            </div>
            <div className="toolbar-actions">
              <button className="secondary-button" type="button" disabled={studentIdentityLinkBusy} onClick={() => void refreshStudentIdentityReview()}>{studentIdentityLinkBusy ? "正在读取…" : "读取人工审核候选"}</button>
              <button className="secondary-button" type="button" disabled={studentIdentityLinkBusy || !studentIdentityReviewClearKey} onClick={requestClearStudentIdentityLinks}>{studentIdentityLinkBusy ? "正在处理…" : "清空全部身份链接"}</button>
            </div>
          </div>
          <div className="student-identity-link-bar">
            <div>
              <strong>教务宝英文括号备注高置信关联（可选补充）</strong>
              <small>{studentIdentityAnnotationPreview
                ? `候选 ${studentIdentityAnnotationPreview.candidateCount} 条；待保存 ${studentIdentityAnnotationPreview.pendingCount} 条`
                : "只处理教务宝姓名末尾单个纯英文括号备注；关联仅补充教务宝资料，不影响总表学生建档"}</small>
            </div>
            <div className="toolbar-actions">
              <button className="secondary-button" type="button" disabled={studentIdentityAnnotationBusy} onClick={() => void refreshStudentIdentityAnnotationReview()}>{studentIdentityAnnotationBusy ? "正在预检…" : "预检高置信候选"}</button>
              <button className="primary-button" type="button" disabled={studentIdentityAnnotationBusy || studentImportBusy || !studentIdentityAnnotationPreview?.canSubmit} onClick={requestStudentIdentityAnnotationReview}>{studentIdentityAnnotationBusy ? "正在保存…" : "确认保存候选"}</button>
            </div>
          </div>
          {studentIdentityReviewCandidates?.length ? <section className="teacher-identity-resolution-list" aria-labelledby="student-identity-review-title">
            <div>
              <h3 id="student-identity-review-title">学生身份逐条人工确认</h3>
            </div>
            {studentIdentityReviewCandidates.map((candidate) => <article key={candidate.candidateKey}>
              <div>
                <strong>学生总表：{candidate.master.name}</strong>
                <small>学生总表来源行 {String(candidate.master.sourceRow)}</small>
                <strong>教务宝：{candidate.jwb.name}</strong>
                <small>教务宝来源行 {String(candidate.jwb.sourceRow)}</small>
                {candidate.existing ? <small>现有系统记录：{candidate.existing.name}{candidate.existing.sourceRow !== undefined ? ` · 来源行 ${String(candidate.existing.sourceRow)}` : " · 无来源行标记"}</small> : <small>现有系统：没有唯一同键记录</small>}
                {candidate.existingMatchCount > 1 ? <small>现有系统共有 {candidate.existingMatchCount} 条同键记录；自动候选不会猜测要合并哪一条。</small> : null}
                {candidate.blockedReason ? <small>当前不可提交：{
                  candidate.blockedReason === "existing_identity_ambiguous"
                    ? "现有系统有多条同键记录"
                    : candidate.blockedReason === "identity_already_used"
                      ? "现有身份已被其他审核链接占用"
                      : "待创建的稳定身份已存在冲突"
                }</small> : null}
              </div>
              <div className="teacher-identity-resolution-actions">
                {candidate.options.map((option) => <button
                  className="primary-button"
                  type="button"
                  key={option.resolutionKey}
                  disabled={studentIdentityLinkBusy || studentImportBusy}
                  onClick={() => void confirmStudentIdentityReview(option.resolutionKey, option.decision)}
                >{studentIdentityLinkBusy ? "正在确认…" : option.label}</button>)}
              </div>
            </article>)}
          </section> : studentIdentityReviewCandidates ? <div className="form-notice"><Link2 size={16} /> 当前没有可提交的人工身份审核候选。</div> : null}
          {studentIdentityManualReview ? <section className="teacher-identity-resolution-list" aria-labelledby="student-identity-manual-title">
            <div>
              <h3 id="student-identity-manual-title">剩余教务宝资料手工配对（可选）</h3>
            </div>
            <article>
              <div>
                <label>学生总表记录
                  <select value={studentIdentityManualMasterToken} disabled={studentIdentityLinkBusy || !studentIdentityManualReview.masters.length} onChange={(event) => setStudentIdentityManualMasterToken(event.target.value)}>
                    <option value="">请选择待配对学生</option>
                    {studentIdentityManualReview.masters.map((item) => <option value={item.token} key={item.token}>{item.name} · 来源行 {String(item.sourceRow)} · {item.status}</option>)}
                  </select>
                </label>
                <label>教务宝记录
                  <select value={studentIdentityManualJwbToken} disabled={studentIdentityLinkBusy || !studentIdentityManualReview.jwb.length} onChange={(event) => setStudentIdentityManualJwbToken(event.target.value)}>
                    <option value="">请选择对应教务宝记录</option>
                    {studentIdentityManualReview.jwb.map((item) => <option value={item.token} key={item.token}>{item.name} · 来源行 {String(item.sourceRow)}</option>)}
                  </select>
                </label>
                <label>处理方式
                  <select value={studentIdentityManualDecision} disabled={studentIdentityLinkBusy} onChange={(event) => setStudentIdentityManualDecision(event.target.value as "create" | "merge")}>
                    <option value="create">确认为新学生身份</option>
                    <option value="merge">合并到现有系统学生</option>
                  </select>
                </label>
                {studentIdentityManualDecision === "merge" ? <label>现有系统学生
                  <select value={studentIdentityManualExistingToken} disabled={studentIdentityLinkBusy || !studentIdentityManualReview.existing.length} onChange={(event) => setStudentIdentityManualExistingToken(event.target.value)}>
                    <option value="">请选择可辨识的现有学生</option>
                    {studentIdentityManualReview.existing.map((item) => <option value={item.token} key={item.token}>{[
                      item.name,
                      item.sourceRow !== undefined ? `来源行 ${String(item.sourceRow)}` : undefined,
                      item.status,
                      item.segment,
                    ].filter(Boolean).join(" · ")}</option>)}
                  </select>
                </label> : null}
              </div>
              <div className="teacher-identity-resolution-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={studentIdentityLinkBusy || studentImportBusy
                    || !studentIdentityManualMasterToken || !studentIdentityManualJwbToken
                    || (studentIdentityManualDecision === "merge" && !studentIdentityManualExistingToken)}
                  onClick={() => void confirmStudentIdentityManualPair()}
                >{studentIdentityLinkBusy ? "正在确认…" : "确认这组手工配对"}</button>
              </div>
            </article>
            <small>待配对：学生总表 {studentIdentityManualReview.masters.length} 条 · 教务宝 {studentIdentityManualReview.jwb.length} 条。可见证据完全相同的现有学生不会出现在合并选项中。</small>
          </section> : null}
          {studentImportPreview ? <>
            <section className="sync-summary">
              <SummaryCard icon={<UserPlus size={19} />} tone="green" title={`${studentImportPreview.summary.insert} 新增 · ${studentImportPreview.summary.update} 更新`} text={`${studentImportPreview.summary.unchanged} 位无需修改`} />
              <SummaryCard icon={<UserRoundX size={19} />} tone="amber" title={`${studentImportPreview.summary.excluded} 位按规则排除`} text={`${studentImportPreview.summary.preservedManualTrials} 位手工试听保留 · ${studentImportPreview.summary.preservedReferencedArchived} 位历史归档`} />
              <SummaryCard icon={<CircleAlert size={19} />} tone={studentImportPreview.summary.ambiguous ? "red" : "blue"} title={`${studentImportPreview.summary.ambiguous} 个歧义`} text={`${studentImportPreview.summary.unmatched} 条教务宝补充资料未安全关联`} />
              <SummaryCard icon={<BookOpen size={19} />} tone={studentImportPreview.summary.studentsMissingPackageData ? "amber" : "green"} title={`${studentImportPreview.summary.importedPackages} 个逐课包`} text={`${studentImportPreview.summary.studentsMissingPackageData} 位暂无可核对课包账本`} />
              <SummaryCard icon={<Link2 size={19} />} tone="blue" title="腾讯总表学生独立建档" text={studentImportPreview.unmatched.filter((item) => item.source === "master").length ? `${studentImportPreview.unmatched.filter((item) => item.source === "master").length} 位总表学生未安全关联教务宝，仍会导入` : "教务宝仅作补充，不影响学生建档"} />
            </section>
            {studentImportPreview.masterDuplicateResolutions?.length ? <section className="teacher-identity-resolution-list" aria-labelledby="student-master-resolution-title">
              <div>
                <h3 id="student-master-resolution-title">学生总表重复记录待确认</h3>
                <small>只可选择一个来源行为正式记录，或明确忽略整组；不接受手工填写。</small>
              </div>
              {studentImportPreview.masterDuplicateResolutions.map((candidate) => <article key={candidate.candidateKey}>
                <div>
                  <strong>同名来源记录</strong>
                  {candidate.sourceRows.map((row) => {
                    const evidence = [
                      `来源行 ${String(row.sourceRow)}`,
                      row.status,
                      row.attributes?.location,
                      row.attributes?.year,
                      row.attributes?.owner,
                      row.attributes?.planner,
                    ].filter(Boolean).join(" · ");
                    return <small key={String(row.sourceRow)}>{evidence}</small>;
                  })}
                </div>
                <div className="teacher-identity-resolution-actions">
                  {candidate.options.map((option) => <button
                    className={option.decision === "ignore" ? "secondary-button" : "primary-button"}
                    type="button"
                    key={option.resolutionKey}
                    disabled={Boolean(studentMasterResolutionBusy) || studentImportBusy}
                    onClick={() => void confirmStudentMasterResolution(option.resolutionKey, option.decision)}
                  >
                    {studentMasterResolutionBusy === option.resolutionKey ? "正在确认…" : option.label}
                  </button>)}
                </div>
              </article>)}
            </section> : null}
            {studentImportPreview.ambiguous.length ? <div className="form-notice"><CircleAlert size={16} /> 有歧义的总表来源记录仍需先在来源中处理；教务宝资料关联不会阻止其他总表学生建档。</div> : null}
          </> : <EmptyState title="尚未预检" detail="先保存两份来源，再读取最新资料进行预检。" />}
        </section> : null}
        {canUseAdminScope ? <section className="panel import-preview-panel">
          <div className="panel-header">
            <div><h2>老师正式导入</h2></div>
            <div className="toolbar-actions">
              <button className="secondary-button" type="button" disabled={teacherImportBusy} onClick={() => void previewTeacherImport()}>{teacherImportBusy ? "正在预检…" : "预检两份教师来源"}</button>
              <button className="primary-button" type="button" disabled={teacherImportBusy || !teacherImportPreview?.canCommit} onClick={commitTeacherImport}>确认正式导入</button>
            </div>
          </div>
          <div className="student-source-ingest-grid">
            {(["k12", "university"] as const).map((workbook) => {
              const label = workbook === "k12" ? "中小学教师表" : "大学教师表";
              const status = teacherImportSourceStatus[workbook];
              return <article className="student-source-ingest-card" key={workbook}>
                <div><strong>{label} JSON</strong>{status ? <StatusPill tone="green">{status.rosterRowCount} 位 · {status.subjectRowCount} 条科目</StatusPill> : <StatusPill tone="amber">待选择文件</StatusPill>}</div>
                <label>完整工作簿来源
                  <textarea value={teacherImportSourceJson[workbook]} rows={4} placeholder='{"sourceId":"腾讯文档 file id","revision":"...","sheetNames":[],"rosterRows":[],"subjectRows":[]}' onChange={(event) => setTeacherImportSourceJson((current) => ({ ...current, [workbook]: event.target.value }))} />
                </label>
                <div className="toolbar-actions">
                  <button className="secondary-button" type="button" disabled={Boolean(teacherImportSourceBusy) || !teacherImportSourceJson[workbook].trim()} onClick={() => void submitTeacherImportSource(workbook, teacherImportSourceJson[workbook])}>{teacherImportSourceBusy === workbook ? "正在保存…" : "校验并保存"}</button>
                  <input id={`teacher-source-${workbook}`} className="visually-hidden" type="file" accept="application/json,.json" disabled={Boolean(teacherImportSourceBusy)} onChange={(event) => void ingestTeacherImportSourceFile(workbook, event)} />
                  <label className="secondary-button" aria-disabled={Boolean(teacherImportSourceBusy)} htmlFor={`teacher-source-${workbook}`}>选择 JSON 文件</label>
                </div>
                {status ? <small>{status.sourceId} · {status.revision}</small> : null}
              </article>;
            })}
          </div>
          {teacherImportPreview ? <>
            <section className="sync-summary">
              <SummaryCard icon={<UserPlus size={19} />} tone="green" title={`${teacherImportPreview.summary.insert} 新增 · ${teacherImportPreview.summary.update} 更新`} text={`${teacherImportPreview.summary.unchanged} 位无需修改`} />
              <SummaryCard
                icon={<CircleAlert size={19} />}
                tone={teacherImportPreview.canCommit ? "green" : "red"}
                title={teacherImportPreview.canCommit ? "预检可提交" : "存在来源阻断"}
                text={`${teacherImportPreview.summary.blocked} 位身份阻断 · ${teacherImportPreview.summary.issues} 条来源检查`}
              />
              <SummaryCard icon={<CalendarDays size={19} />} tone="amber" title={`${teacherImportPreview.summary.unstructuredAvailability} 条 AVA 待确认`} text="保留原文，不生成月度时段" />
              <SummaryCard icon={<Users size={19} />} tone="amber" title={`${teacherImportPreview.summary.unstructuredCapacity} 条容量待确认`} text="保留原文，不猜可接人数" />
            </section>
            {teacherImportPreview.identityResolutions.length ? <section className="teacher-identity-resolution-list" aria-labelledby="teacher-identity-resolution-title">
              <div>
                <h3 id="teacher-identity-resolution-title">同名教师身份待确认</h3>
                <p>跨表与同表重名都必须逐项选择合并或分开。系统不会按姓名自动决定。</p>
              </div>
              {teacherImportPreview.identityResolutions.map((resolution) => <article key={resolution.resolutionKey}>
                <div>
                  <strong>{resolution.name}</strong>
                  <small>{resolution.kind === "same_workbook_identity" ? "同一工作簿" : "跨工作簿"} · {resolution.sourceRefs.map((reference) => `${reference.workbook === "k12" ? "中小学" : "大学"} · 来源行 ${reference.sourceRow}`).join(" ↔ ")}</small>
                </div>
                <div className="teacher-identity-resolution-actions">
                  {resolution.options.map((option) => <button
                    className="secondary-button"
                    type="button"
                    key={option.resolutionKey}
                    disabled={Boolean(teacherIdentityResolutionBusy) || teacherImportBusy}
                    onClick={() => void confirmTeacherIdentityResolution(option.resolutionKey, option.decision)}
                  >
                    {teacherIdentityResolutionBusy === `${option.resolutionKey}:${option.decision}` ? "正在确认…" : option.label}
                  </button>)}
                </div>
              </article>)}
            </section> : null}
            {teacherImportPreview.subjectResolutions?.length ? <section className="teacher-identity-resolution-list" aria-labelledby="teacher-subject-resolution-title">
              <div>
                <h3 id="teacher-subject-resolution-title">科目行归属待确认</h3>
              </div>
              {teacherImportPreview.subjectResolutions.map((resolution) => <article key={`${resolution.workbook}:${resolution.subjectRef.sourceRow}:${resolution.sheetName}`}>
                <div>
                  <strong>{resolution.name} · {resolution.sheetName}</strong>
                  <small>{resolution.workbook === "k12" ? "中小学" : "大学"}科目来源行 {resolution.subjectRef.sourceRow}</small>
                </div>
                <form className="teacher-subject-resolution-actions" onSubmit={(event) => {
                  event.preventDefault();
                  const resolutionKey = String(new FormData(event.currentTarget).get("resolutionKey") ?? "");
                  const option = resolution.options.find((candidate) => candidate.resolutionKey === resolutionKey);
                  if (option) void confirmTeacherIdentityResolution(option.resolutionKey, option.decision);
                }}>
                  <label>
                    <span className="visually-hidden">选择 roster 归属或明确忽略</span>
                    <select name="resolutionKey" defaultValue="" required disabled={Boolean(teacherIdentityResolutionBusy) || teacherImportBusy}>
                      <option value="" disabled>请选择 roster 归属或明确忽略</option>
                      {resolution.options.map((option) => <option value={option.resolutionKey} key={option.resolutionKey}>{option.label}</option>)}
                    </select>
                  </label>
                  <button className="secondary-button" type="submit" disabled={Boolean(teacherIdentityResolutionBusy) || teacherImportBusy}>
                    {teacherIdentityResolutionBusy ? "正在确认…" : "确认硬性选择"}
                  </button>
                </form>
              </article>)}
            </section> : null}
            {teacherImportPreview.issues.length ? <div className="import-issue-list" role="list">
              {teacherImportPreview.issues.slice(0, 12).map((issue, index) => <div className="record" role="listitem" key={`${issue.code}-${issue.workbook ?? "all"}-${issue.name ?? issue.sheetName ?? index}`}>
                <div><strong>{issue.name ?? issue.sheetName ?? issue.code}</strong><small>{issue.workbook === "k12" ? "中小学" : issue.workbook === "university" ? "大学" : "两份来源"} · {issue.detail}</small></div>
                <StatusPill tone={issue.code === "unstructured_availability" || issue.code === "unstructured_capacity" ? "amber" : "red"}>{issue.code}</StatusPill>
              </div>)}
            </div> : null}
          </> : <EmptyState title="尚未预检" detail="先保存两份教师来源，再读取最新资料进行预检。" />}
        </section> : null}
        {isAdminView && canUseAdminScope ? <>
          <JiaowubaoScheduleMappingPriorityReviewPanel
            review={jiaowubaoScheduleMappingPriorityReview}
            loading={jiaowubaoScheduleMappingPriorityLoading}
            loadingMore={jiaowubaoScheduleMappingPriorityLoadingMore}
            error={jiaowubaoScheduleMappingPriorityError}
            isAdmin
            timezone={scheduleTimezone}
            busyMappingKey={jiaowubaoScheduleMappingPriorityBusyKey}
            onConfirm={({ mappingKey, teacherId, subjectId }) => {
              void saveJiaowubaoScheduleMappingPriority(mappingKey, "confirm", teacherId, subjectId);
            }}
            onDismiss={(mappingKey) => {
              requestConfirmation({
                title: "标记为无需映射",
                detail: "该老师与课程组合会从当前待核对队列移除，并保留审计记录。之后仍可在历史组合中重新确认。",
                items: ["不会创建排课或修改老师资料", "不会删除教务宝来源记录"],
                confirmLabel: "移出队列",
                tone: "primary",
                onConfirm: () => {
                  void saveJiaowubaoScheduleMappingPriority(mappingKey, "revoke", null, null);
                },
              });
            }}
            onLoadMore={() => {
              void loadMoreJiaowubaoScheduleMappingPriority();
            }}
            onViewHistory={() => {
              document.getElementById("jiaowubao-schedule-mapping-review-title")?.scrollIntoView({
                behavior: displayPreferences.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                block: "start",
              });
            }}
          />
          <JiaowubaoScheduleMappingReviewPanel
            review={jiaowubaoScheduleMappingReview}
            loading={jiaowubaoScheduleMappingLoading}
            loadingMore={jiaowubaoScheduleMappingLoadingMore}
            error={jiaowubaoScheduleMappingError}
            isAdmin
            busyMappingKey={jiaowubaoScheduleMappingBusyKey}
            onConfirm={({ mappingKey, teacherId, subjectId }) => {
              void saveJiaowubaoScheduleMapping(mappingKey, "confirm", teacherId, subjectId);
            }}
            onRevoke={(mappingKey) => {
              void saveJiaowubaoScheduleMapping(mappingKey, "revoke", null, null);
            }}
            onDismiss={(mappingKey) => {
              requestConfirmation({
                title: "标记为无需映射",
                detail: "该历史组合会标记为已撤销，不再计入待确认；之后仍可重新选择老师和科目。",
                items: ["保留来源证据与审计记录", "不会创建排课或修改老师资料"],
                confirmLabel: "标记无需映射",
                tone: "primary",
                onConfirm: () => {
                  void saveJiaowubaoScheduleMapping(mappingKey, "revoke", null, null);
                },
              });
            }}
            onLoadMore={() => {
              void loadMoreJiaowubaoScheduleMappings();
            }}
          />
        </> : null}
        {(recordStudents.length > 0 || recordTeachers.length > 0 || syncSources.length > 0) ? <section className="sync-summary source-summary">
          {recordStudents.length > 0 ? <SummaryCard
            icon={<Users size={19} />}
            tone="green"
            title={`${recordStudents.length} 位有效学生`}
            text="当前工作区学生档案"
          /> : null}
          {recordTeachers.length > 0 ? <SummaryCard
            icon={<GraduationCap size={19} />}
            tone="blue"
            title={`${recordTeachers.length} 位去重老师`}
            text="已载入教师与可用时间"
          /> : null}
          {syncSources.length > 0 ? <SummaryCard
            icon={<RefreshCw size={19} />}
            tone={staleSources.length ? "amber" : activeSources.length ? "green" : "blue"}
            title={sourceFreshnessLabel}
            text={activeSources.length
              ? `${activeSources.length} 个当前来源${archivedSources.length ? ` · ${archivedSources.length} 个历史记录` : ""}`
              : "当前资料由专用导入与教务宝管线维护"}
          /> : null}
        </section> : null}
        <section className="sync-layout">
          <aside className="panel source-panel">
            <div className="panel-header">
              <div>
                <h2>当前管线与历史记录</h2>
              </div>
              <StatusPill
                tone={
                  !syncSources.length || staleSources.length
                    ? "amber"
                    : activeSources.length ? "green" : "blue"
                }
              >
                {syncSources.length
                  ? staleSources.length
                    ? `${staleSources.length} 个已过期`
                    : activeSources.length
                      ? `${activeSources.length} 个来源正常`
                      : `${archivedSources.length} 个历史来源`
                  : "等待首次读取"}
              </StatusPill>
            </div>
            {syncSources.length ? (
              <div className="source-list">
                {syncSources.map((source) => (
                  <div className="source-row" key={source.source_id}>
                    <span>
                      <strong>{source.title}</strong>
                      <small>
                        {source.row_count} 行 · {formatSourceTime(source.synced_at, displayPreferences)}
                      </small>
                    </span>
                    <StatusPill
                      tone={
                        source.status === "archived"
                          ? "blue"
                          : source.status === "synced" && !opsSourceIsStale(source)
                          ? "green"
                          : "amber"
                      }
                    >
                      {source.status === "archived"
                        ? "已归档"
                        : opsSourceIsStale(source)
                        ? "数据已过期"
                        : source.status === "synced"
                          ? "已读取"
                        : source.status}
                    </StatusPill>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="尚未读取外部来源"
                detail="完成读取后会在这里显示来源和时间。"
              />
            )}
          </aside>
        </section>
      </section>
    </>
  );
  const renderReports = () => {
    const reportOwnerOptions = operationsReportOwnerOptions(ownerOptions, tasks);
    const reportTasks = tasks.filter(
      (task) => matchesOperationsOwnerFilter(reportOwner, task.owner),
    );
    const reportStudents = recordStudents.filter(
      (student) => matchesOperationsOwnerFilter(reportOwner, student.owner),
    );
    const completed = reportTasks.filter(
      (task) => task.status === "done",
    ).length;
    const trialCount = reportStudents.filter(
      (student) => student.segment === "试听",
    ).length;
    const activeTeachers = recordTeachers.filter(
      (teacher) => teacher.acceptsStudents,
    ).length;
    const pendingReportTasks = reportTasks.filter((task) => task.status !== "done");
    const pendingTaskWorkload = pendingOperationsTaskWorkload(pendingReportTasks);
    const hasFileIndex = files.length > 0;
    const missingFiles = hasFileIndex
      ? reportStudents.filter((student) => student.files < 5).length
      : 0;
    const payrollExceptionCount = payroll.filter((row) => row.status === "需核对").length;
    const pendingBookingCount = bookings.filter((booking) => booking.status === "待确认").length;
    const hasReportIssues = !hasFileIndex || missingFiles > 0 || (canViewPayroll && payrollExceptionCount > 0) || sharedSyncState === "conflict" || pendingBookingCount > 0;
    return (
      <>
        <ViewHeading
          eyebrow="运营数据"
          title="运营报表"
          actions={
            <>
              <select
                className="filter-select header-filter"
                value={reportOwner}
                onChange={(event) => setReportOwner(event.target.value)}
                aria-label="报表负责人"
              >
                <option value="all">全部负责人</option>
                {reportOwnerOptions.map((owner) => (
                  <option key={owner}>{owner}</option>
                ))}
              </select>
              <button
                className="secondary-button"
                type="button"
                onClick={exportReport}
              >
                <Download size={17} /> 导出数据
              </button>
            </>
          }
        />
        <section className="report-grid">
          <ReportCard
            value={`${completed}/${reportTasks.length}`}
            label="任务完成"
            tone="green"
          />
          <ReportCard
            value={`${trialCount}`}
            label="进行中的试听"
            tone="amber"
          />
          <ReportCard
            value={`${activeTeachers}/${recordTeachers.length}`}
            label="可接新老师"
            tone="blue"
          />
          <ReportCard
            value={hasFileIndex ? `${missingFiles}` : "待接入"}
            label={hasFileIndex ? "资料待补" : "文件索引"}
            tone={hasFileIndex ? "red" : "amber"}
          />
        </section>
        <section className="two-column">
          <article className="panel chart-panel">
            <div className="panel-header">
              <div><h2>待处理任务</h2></div>
            </div>
            {pendingTaskWorkload.length ? pendingTaskWorkload.map(({ owner, count, widthPercent }) => (
                <div className="bar-row" key={owner}>
                  <span>{owner}</span>
                  <div>
                    <i style={{ width: `${widthPercent}%` }} />
                  </div>
                  <strong>{count} 项</strong>
                </div>
              )) : (
              <EmptyState
                title="当前筛选下没有待处理任务"
                detail="切换负责人可查看其他范围。"
              />
            )}
          </article>
          {hasReportIssues && <article className="panel chart-panel">
            <div className="panel-header">
              <div><h2>数据质量</h2></div>
            </div>
            {(!hasFileIndex || missingFiles > 0) && <DataIssue
              title={hasFileIndex ? "试听资料缺少索引" : "文件索引尚未接入"}
              count={hasFileIndex ? `${missingFiles} 位学生` : "未生成缺失结论"}
              tone={hasFileIndex ? "red" : "amber"}
            />}
            {canViewPayroll && payrollExceptionCount > 0 && (
              <DataIssue
                title="薪资规则例外"
                count={`${payrollExceptionCount} 条记录`}
                tone="amber"
              />
            )}
            {sharedSyncState === "conflict" && <DataIssue title="同步冲突" count="需重新载入" tone="blue" />}
            {pendingBookingCount > 0 && <DataIssue
              title="未确认排课"
              count={`${pendingBookingCount} 节`}
              tone="purple"
            />}
          </article>}
        </section>
      </>
    );
  };

  const renderSettings = () => {
    const fixedRules = [
      { label: "家长指定内容", value: FIXED_REMINDER_RULES.parentSpecifiedContentDaysAfterRequest === 0 ? "需求当天" : `需求后 ${FIXED_REMINDER_RULES.parentSpecifiedContentDaysAfterRequest} 天` },
      { label: "LP 审核与发送", value: `试听前 N-${FIXED_REMINDER_RULES.lpReviewDaysBeforeTrial}` },
      { label: "老师备课确认", value: `试听前 N-${FIXED_REMINDER_RULES.preparationDaysBeforeTrial}` },
      { label: "最低完成底线", value: `试听前 N-${FIXED_REMINDER_RULES.minimumDaysBeforeTrial}` },
      { label: "排课反馈", value: `需求后 ${FIXED_REMINDER_RULES.schedulingFeedbackHoursAfterRequest} 小时` },
    ];

    return (
    <>
      <ViewHeading
        eyebrow="系统规则"
        title="规则设置"
        actions={
          <button
            className="secondary-button"
            type="button"
            onClick={resetDemo}
          >
            <RefreshCw size={17} /> 重新载入数据
          </button>
        }
      />
      <section className="panel settings-shell">
        <ViewTabs
          value={settingsTab}
          items={[
            { id: "reminders", label: "提醒规则" },
            { id: "data", label: "数据与备份" },
            { id: "integrations", label: "外部集成" },
          ]}
          onChange={setSettingsTab}
          label="设置分类"
        />
        {settingsTab === "reminders" && (
          <article className="settings-panel settings-form">
            <div className="settings-intro">
              <div><h2>固定时间节点</h2></div>
            </div>
            <div className="fixed-rule-grid" aria-label="不可编辑的固定提醒规则">
              {fixedRules.map((rule) => (
                <div key={rule.label}>
                  <span>{rule.label}</span>
                  <strong>{rule.value}</strong>
                </div>
              ))}
            </div>
            <div className="settings-fields">
              <label>
                低课时提醒阈值
                <select
                  value={displayedRules.lowHours}
                  onChange={(event) => {
                    updateRulesDraft({
                      ...displayedRules,
                      lowHours: event.target.value as Rules["lowHours"],
                    });
                  }}
                >
                  {RULE_OPTIONS.lowHours.map((value) => <option value={value} key={value}>{value} 节</option>)}
                </select>
              </label>
              <label>
                考试关注窗口
                <select
                  value={displayedRules.examDays}
                  onChange={(event) => {
                    updateRulesDraft({
                      ...displayedRules,
                      examDays: event.target.value as Rules["examDays"],
                    });
                  }}
                >
                  {RULE_OPTIONS.examDays.map((value) => <option value={value} key={value}>{value} 天</option>)}
                </select>
              </label>
            </div>
            <button
              className="primary-button settings-save"
              type="button"
              disabled={!rulesDraftTouched || rulesDraftStale}
              onClick={() => {
                if (rulesDraftStale) return;
                const previousRules = normalizeRules(rules);
                requestConfirmation({
                  title: "确认更新全局提醒规则",
                  detail: `低课时 ${displayedRules.lowHours} 节 · 考试关注 ${displayedRules.examDays} 天`,
                  items: [
                    "保存后会影响所有在线教务看到的提醒结果",
                    "固定时间节点不会被修改",
                    "保存后可在 12 秒内撤销",
                  ],
                  confirmLabel: "保存全局规则",
                  onConfirm: async () => {
                    const saved = await writeRulesVersion(displayedRules, rulesDraftBaseVersion);
                    addAudit(
                      "保存强提醒规则",
                      `低课时 ${displayedRules.lowHours} 节、考试关注 ${displayedRules.examDays} 天`,
                      "green",
                    );
                    notify("规则已保存", () => {
                      void writeRulesVersion(previousRules, saved.version)
                        .then(() => addAudit("撤销强提醒规则更新", "恢复上一个规则版本", "amber"))
                        .catch((error: unknown) => notify(error instanceof Error ? error.message : "规则撤销失败"));
                    });
                  },
                });
              }}
            >
              <Check size={17} />
              {rulesDraftStale ? "规则已被他人更新" : rulesDraftTouched ? "保存规则" : "规则未修改"}
            </button>
            {rulesDraftStale ? <button className="secondary-button settings-save" type="button" onClick={() => {
              const latest = normalizeRules(rules);
              setRulesDraft(latest);
              setRulesDraftTouched(false);
              setRulesDraftBaseVersion(rulesShared.version);
            }}><RefreshCw size={17} /> 载入最新规则</button> : null}
          </article>
        )}
        {settingsTab === "data" && (
          <article className="settings-panel">
            <div className="settings-intro">
              <div><h2>数据与备份</h2></div>
            </div>
            <div className="button-row">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setActive("sync")}
              >
                <FilePlus2 size={16} /> 打开导入
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={exportDemo}
              >
                <Download size={16} /> 导出当前数据
              </button>
            </div>
          </article>
        )}
        {settingsTab === "integrations" && (
          <article className="settings-panel">
            <div className="settings-intro">
              <div><h2>外部系统</h2></div>
            </div>
            <div className="integration-list">
              <OwnershipRow
                title="企业微信"
                tone="amber"
                label="会话存档接入端已就绪"
              />
              <OwnershipRow
                title="教务宝"
                tone="green"
                label="只读已接入"
              />
              <OwnershipRow
                title="腾讯表格"
                tone="green"
                label="只读已接入"
              />
              <OwnershipRow
                title="BiggerBlueButton"
                tone="green"
                label="已接入"
              />
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setActive("sync")}
            >
              <RefreshCw size={16} /> 查看同步状态
            </button>
          </article>
        )}
      </section>
    </>
    );
  };

  const renderAudit = () => {
    const { filtered: filteredAudit, paged: pagedAudit, counts, safePage, pageSize: auditPageSize } =
      buildAuditView(audit, auditQuery, auditFilter, auditPage, operatorLabel);
    return (
      <>
        <ViewHeading
          eyebrow="审计"
          title="操作审计"
          actions={
            <button
              className="secondary-button"
              type="button"
              onClick={() => exportAudit(filteredAudit)}
            >
              <Download size={17} /> 导出审计
            </button>
          }
        />
        <section className="panel collection-shell">
          <ViewTabs
            value={auditFilter}
            items={[
              { id: "all", label: "全部", count: counts.all },
              {
                id: "manual",
                label: "人工操作",
                count: counts.manual,
              },
              {
                id: "system",
                label: "系统事件",
                count: counts.system,
              },
              {
                id: "amber",
                label: "需关注",
                count: counts.amber,
              },
            ]}
            onChange={(value) => {
              setAuditFilter(value);
              setAuditPage(1);
            }}
            label="审计保存视图"
          />
          <ListToolbar
            query={auditQuery}
            onQuery={(value) => {
              setAuditQuery(value);
              setAuditPage(1);
            }}
            placeholder="搜索操作者、动作或详情"
            count={filteredAudit.length ? `${filteredAudit.length} 条记录` : ""}
          />
          <div className="collection-main">
            <div className="collection-head audit-grid-row">
              <span>时间</span>
              <span>操作者</span>
              <span>动作</span>
              <span>详情</span>
            </div>
            <div className="collection-viewport">
              {pagedAudit.length ? (
                pagedAudit.map((entry) => (
                  <div className="collection-row audit-grid-row" key={entry.id}>
                    <span>{formatAuditTime(entry.time, displayPreferences)}</span>
                    <span>{operatorLabel(entry.actor)}</span>
                    <span>
                      <StatusPill tone={entry.tone}>{entry.action}</StatusPill>
                    </span>
                    <span>{entry.detail}</span>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="没有审计记录"
                  detail="调整筛选或搜索条件。"
                />
              )}
            </div>
            <Pagination
              page={safePage}
              total={filteredAudit.length}
              pageSize={auditPageSize}
              onPage={setAuditPage}
            />
          </div>
        </section>
      </>
    );
  };

  const classroomToday = isoDateInTimezone(new Date(scheduleMinute * 60_000), scheduleTimezone);
  const classroomMinute = scheduleMinute;
  const classroomLists = useMemo(() => {
    if (active !== "classroom") return { upcomingBookings: [], historicalBookings: [] };
    const now = classroomMinute * 60_000;
    const dated = scopedBookings.flatMap((booking) =>
      bookingOccurrencesWithinRange(booking, shiftIsoDate(classroomToday, -366), shiftIsoDate(classroomToday, 366)),
    ).filter((booking) => !isTeacherView || currentTeacherIds.has(booking.teacherId))
      .map((booking) => ({ booking, startsAt: bookingInstant(booking).getTime() }));
    return {
      upcomingBookings: dated.filter(({ booking, startsAt }) => startsAt + Math.max(1, booking.duration || 0) * 60_000 >= now)
        .sort((a, b) => a.startsAt - b.startsAt).map(({ booking }) => booking),
      historicalBookings: dated.filter(({ booking, startsAt }) => startsAt + Math.max(1, booking.duration || 0) * 60_000 < now)
        .sort((a, b) => b.startsAt - a.startsAt).map(({ booking }) => booking),
    };
  }, [active, classroomToday, classroomMinute, scopedBookings, isTeacherView, currentTeacherIds]);
  const [classroomPage, setClassroomPage] = useState(1);
  const renderClassroom = () => {
    const { upcomingBookings, historicalBookings } = classroomLists;
    const visibleClassrooms = classroomView === "upcoming" ? upcomingBookings : historicalBookings;
    const roomPageCount = Math.max(1, Math.ceil(visibleClassrooms.length / 12));
    const selectedRoomIndex = selectedBookingOccurrenceKey
      ? visibleClassrooms.findIndex((booking) => booking.id === selectedBookingId && booking.occurrenceKey === selectedBookingOccurrenceKey)
      : -1;
    const safeRoomPage = selectedRoomIndex >= 0
      ? Math.floor(selectedRoomIndex / 12) + 1
      : Math.min(classroomPage, roomPageCount);
    const changeClassroomPage = (page: number) => {
      const first = visibleClassrooms[(page - 1) * 12];
      if (!first) return;
      setClassroomPage(page);
      selectBookingRecord(first);
      setClassroomRuntime(null);
      setMobilePreview(null);
    };
    const pageClassrooms = visibleClassrooms.slice((safeRoomPage - 1) * 12, safeRoomPage * 12);
    const selectedRoomBooking = selectedBookingOccurrenceKey
      ? visibleClassrooms.find((booking) => booking.id === selectedBookingId && booking.occurrenceKey === selectedBookingOccurrenceKey)
      : undefined;
    const legacyRoomCandidates = !selectedBookingOccurrenceKey && selectedBookingDate
      ? visibleClassrooms.filter((booking) => booking.id === selectedBookingId && booking.date === selectedBookingDate)
      : [];
    const roomBooking = selectedRoomBooking
      ?? (legacyRoomCandidates.length === 1 ? legacyRoomCandidates[0] : undefined)
      ?? (selectedBookingOccurrenceKey || !selectedBookingDate
        ? pageClassrooms[0]
        : undefined);
    const classroomMeetingIdFor = (booking: BookingOccurrence) => booking.classroom?.meetingId ?? provisionedClassrooms[booking.occurrenceKey];
    const roomMeetingId = roomBooking ? classroomMeetingIdFor(roomBooking) : undefined;
    const roomRuntime = roomMeetingId && roomMeetingId === classroomRuntime?.meetingId
      ? classroomRuntime : null;
    const roomClosed = roomBooking?.classroom?.status === "ended" || roomRuntime?.closing || roomRuntime?.ended;
    const historicalRoom = roomBooking ? isPastBooking(roomBooking) : false;
    const roomStudent = roomBooking
      ? studentById(roomBooking.studentId)
      : undefined;
    const roomTeacher = roomBooking
      ? teacherById(roomBooking.teacherId)
      : undefined;
    const classroomStatus = roomRuntime?.running
      ? { label: "课堂进行中", tone: "green" as Tone }
      : roomRuntime?.recordings.some((recording) => recording.playbackUrl)
        ? { label: "录播已就绪", tone: "blue" as Tone }
        : roomClosed
          ? { label: "课堂已结束", tone: "neutral" as Tone }
          : roomMeetingId
            ? { label: "待开课", tone: "amber" as Tone }
            : { label: "未创建", tone: "neutral" as Tone };
    const playback = roomRuntime?.recordings.find(
      (recording) => recording.playbackUrl,
    );
    return (
      <>
        <ViewHeading
          eyebrow="网上教室"
          title="网上教室"
          actions={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={classroomBusy || !canUseAdminScope || !isAdminView}
                onClick={() => {
                  setTemporaryClassroomStudentId("");
                  setTemporaryClassroomSubjectId("");
                  setTemporaryClassroomRecordLesson(false);
                  setTemporaryClassroomTeacherId("");
                  setTemporaryClassroomTeacherSubjectId("");
                  setTemporaryTestClassroom(null);
                  setModal("temporaryClassroom");
                }}
              >
                <Video size={17} /> 立即开临时课堂
              </button>
              {roomBooking ? (
                historicalRoom ? (
                  roomBooking.classroom?.meetingId ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={classroomBusy}
                      onClick={() => void refreshClassroom(roomBooking)}
                    >
                      <RefreshCw size={17} /> 刷新历史录播
                    </button>
                  ) : null
                ) : !roomMeetingId ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={classroomBusy}
                    onClick={() => void createClassroom(roomBooking)}
                  >
                    <Video size={17} />{" "}
                    {classroomBusy ? "正在连接课堂…" : "创建在线教室"}
                  </button>
                ) : roomClosed ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={classroomBusy}
                    onClick={() => void refreshClassroom(roomBooking)}
                  >
                    <RefreshCw size={17} /> 刷新录播
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={classroomBusy || !canJoinTeacherClassroom}
                    onClick={() => void joinTeacherClassroom(roomBooking)}
                  >
                    <ExternalLink size={17} />{" "}
                    {classroomBusy ? "正在处理…" : canJoinTeacherClassroom ? "老师进入教室" : "等待授课老师进入"}
                  </button>
                )
              ) : (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => openNewBooking()}
                >
                  <CalendarPlus size={17} /> 先创建约课
                </button>
              )}
            </>
          }
        />
        <section className="panel classroom-hub">
          <ViewTabs
            value={classroomView}
            items={[
              {
                id: "upcoming",
                label: "待开课与进行中",
                count: upcomingBookings.length,
              },
              {
                id: "history",
                label: "历史与录播",
                count: historicalBookings.length,
              },
            ]}
            onChange={(value) => {
              const nextView = value as "upcoming" | "history";
              const nextBooking =
                nextView === "upcoming"
                  ? upcomingBookings[0]
                  : historicalBookings[0];
              setClassroomView(nextView);
              setClassroomPage(1);
              if (nextBooking) {
                selectBookingRecord(nextBooking);
              }
              setClassroomRuntime(null);
              setMobilePreview(null);
            }}
            label="课堂保存视图"
          />
          {visibleClassrooms.length ? (
            <div className="classroom-hub-layout">
              <article className="classroom-room-list">
                <div className="collection-head classroom-grid-row">
                  <span>课程</span>
                  <span>时间</span>
                  <span>教室</span>
                </div>
                {pageClassrooms.map((booking) => {
                  const student = studentById(booking.studentId);
                  const status =
                    booking.classroom?.status === "running"
                      ? "进行中"
                      : booking.classroom?.status === "ended"
                        ? "已结束"
                        : classroomMeetingIdFor(booking)
                          ? "待开课"
                          : "未创建";
                  return (
                    <button
                      className={`collection-row classroom-grid-row ${roomBooking?.occurrenceKey === booking.occurrenceKey ? "selected" : ""}`}
                      type="button"
                      key={booking.occurrenceKey}
                      onClick={() => {
                        selectBookingRecord(booking);
                        setClassroomRuntime(null);
                        setMobilePreview("classroom");
                      }}
                    >
                      <span>
                        <strong>{student?.name ?? booking.studentId}</strong>
                        <small>
                          {booking.course ?? student?.course ?? booking.kind}
                        </small>
                      </span>
                      <span>
                        <strong>
                          {formatInstant(
                            bookingInstant(booking),
                            scheduleTimezone,
                            displayPreferences,
                          )}
                        </strong>
                        <small>{timezoneLabel(scheduleTimezone, displayPreferences.language)}</small>
                      </span>
                      <StatusPill
                        tone={
                          status === "进行中"
                            ? "green"
                            : status === "待开课"
                              ? "amber"
                              : status === "已结束"
                                ? "blue"
                                : "neutral"
                        }
                      >
                        {status}
                      </StatusPill>
                    </button>
                  );
                })}
                <div className="pagination" aria-label="教室列表分页">
                  <span>共 {visibleClassrooms.length} 节 · 第 {safeRoomPage} / {roomPageCount} 页</span>
                  <button type="button" disabled={safeRoomPage <= 1} onClick={() => changeClassroomPage(safeRoomPage - 1)}>上一页</button>
                  <button type="button" disabled={safeRoomPage >= roomPageCount} onClick={() => changeClassroomPage(safeRoomPage + 1)}>下一页</button>
                </div>
              </article>
              {roomBooking && (
                <aside
                  className={`classroom-room-preview ${mobilePreview === "classroom" ? "mobile-detail-open" : ""}`}
                >
                  <button
                    className="mobile-preview-close"
                    type="button"
                    aria-label="关闭课堂详情"
                    onClick={() => setMobilePreview(null)}
                  >
                    <ChevronLeft size={20} /> 返回课堂列表
                  </button>
                  <div className="preview-header">
                    <div>
                      <p className="eyebrow">{roomTeacher?.name ?? "老师待关联"}</p>
                      <h2>{roomStudent?.name ?? "学生"}</h2>
                    </div>
                    <StatusPill tone={classroomStatus.tone}>
                      {classroomStatus.label}
                    </StatusPill>
                  </div>
                  <Suspense fallback={null}>
                    <ClassroomLessonTools section="details" runtime={roomRuntime} invitationUrl={temporaryClassroomLink?.occurrenceId === roomBooking.occurrenceKey ? temporaryClassroomLink.url : undefined} scheduledTime={formatInstant(bookingInstant(roomBooking), scheduleTimezone, displayPreferences)} timezone={timezoneLabel(scheduleTimezone, displayPreferences.language)} duration={roomBooking.duration} durationUnit={displayPreferences.language === "en-AU" ? "min" : "分钟"} formatTime={(value) => formatInstant(new Date(value), scheduleTimezone, displayPreferences)} notify={notify} />
                  </Suspense>
                  <Suspense fallback={null}>
                    <ClassroomLessonTools section="controls" historical={historicalRoom} hasMeeting={Boolean(roomMeetingId)} closed={Boolean(roomClosed)} busy={classroomBusy} canJoin={canJoinTeacherClassroom} canEnd={Boolean(roomBooking.classroom?.meetingId)} running={Boolean(roomRuntime?.running || roomBooking.classroom?.status === "running")} hasSavedMeeting={Boolean(roomBooking.classroom?.meetingId)} create={() => void createClassroom(roomBooking)} join={() => void joinTeacherClassroom(roomBooking)} copyStudentLink={() => void copyStudentClassroomLink(roomBooking)} refresh={() => void refreshClassroom(roomBooking)} end={() => void endClassroom(roomBooking)} />
                  </Suspense>
                  <Suspense fallback={null}>
                    <ClassroomLessonTools section="actions" playbackUrl={playback?.playbackUrl} recordingPending={Boolean(roomMeetingId && !historicalRoom && roomClosed)} canOpenWhiteboard={Boolean(roomRuntime?.running && !historicalRoom && !roomClosed)} busy={classroomBusy} setBusy={setClassroomBusy} openWhiteboard={() => classroomRequest({ action: "whiteboard", bookingId: roomBooking.id, occurrenceId: roomBooking.occurrenceKey, sourceDate: roomBooking.sourceDate })} notify={notify} />
                  </Suspense>
                  {historicalRoom && isAdminView && roomBooking.occurrenceStatus !== "completed" && (
                    <button
                      className="primary-button full"
                      type="button"
                      disabled={lessonSettlementBusy}
                      onClick={() => openLessonSettlement(roomBooking)}
                    >
                      <CheckCircle2 size={16} /> 人工结算本节
                    </button>
                  )}
                  {classroomBusy && <Suspense fallback={null}><ClassroomLessonTools section="connecting" /></Suspense>}
                </aside>
              )}
            </div>
          ) : (
            <EmptyState
              title={
                classroomView === "upcoming"
                  ? "没有待开课课程"
                  : "没有历史课堂记录"
              }
              detail={
                classroomView === "upcoming"
                  ? "先为学生创建未来排课，系统会从排课生成对应的在线教室。"
                  : "已结束课程及其录播会显示在这里。"
              }
            />
          )}
        </section>
        <Suspense fallback={<section className="panel" aria-busy="true">正在加载教材库…</section>}>
          <ClassroomMaterialsPanel teachers={teachers.map(({ id, name }) => ({ id, name }))} selectedClassroom={roomBooking && !historicalRoom && !roomClosed ? { bookingId: roomBooking.id, occurrenceId: roomBooking.occurrenceKey, sourceDate: roomBooking.sourceDate } : undefined} notify={notify} />
        </Suspense>
      </>
    );
  };

  const renderAccounts = () => (
    <>
      <ViewHeading eyebrow="账号与安全" title={isAdminSession ? "账号与权限" : "账号安全"} />
      <AccountLifecycleWorkspace
        currentUser={sessionOperator}
        currentRole={initialRole}
        canManageAccounts={isAdminSession}
        refreshVersion={accountLifecycleRefreshVersion}
        onChangePassword={() => setModal("accountPasswordChange")}
        onResetPassword={(account: AccountDirectoryRecord) => {
          setAccountPasswordResetTarget({
            accountId: account.account_id,
            label: account.account_name,
            login: account.account_role === "staff" ? `${account.account_name} 教务` : account.account_name,
            expectedCredentialVersion: account.credential_version ?? 0,
          });
          setAccountPasswordResetError("");
          accountPasswordResetCommandRef.current = null;
          setModal("accountPasswordReset");
        }}
        onViewAccount={(account: AccountDirectoryRecord) => switchOperator(account.account_name, account.account_role)}
      />
    </>
  );

  const renderView = () => {
    if (!canViewPayroll && active === "payroll") return renderDashboard();
    if (
      !isAdminView &&
      !(isTeacherView ? teacherSectionIds : staffSectionIds).has(active)
    )
      return renderDashboard();
    switch (active) {
      case "dashboard":
        return renderDashboard();
      case "students":
        return renderStudents();
      case "teachers":
        return renderTeachers();
      case "schedule":
        return renderSchedule();
      case "classroom":
        return renderClassroom();
      case "courses":
        return renderCourses();
      case "lp":
        return renderLp();
      case "operations":
        return renderOperations();
      case "ava-calendar":
        return canOpenAvaCalendar ? <><ViewHeading eyebrow={avaCalendarLabel} title={avaCalendarLabel} /><Suspense fallback={<p role="status">正在读取…</p>}><AvaCalendarLiveClient displayTimezone={scheduleTimezone} onDisplayTimezoneChange={(timezone) => { if (timezoneOptions.some((option) => option.id === timezone)) updateDisplayPreferences({ timezone }); }} /></Suspense></> : renderDashboard();
      case "renewals":
        return renderRenewals();
      case "payroll":
        return renderPayroll();
      case "messages":
        return renderMessages();
      case "files":
        return renderFiles();
      case "sync":
        return renderSync();
      case "reports":
        return renderReports();
      case "settings":
        return renderSettings();
      case "accounts":
        return renderAccounts();
      case "audit":
        return renderAudit();
    }
  };

  const removeStudentCreationPending = useCallback((intent: string) => {
    studentCreationCommandKeysRef.current = removeStudentCreationPendingCommand(
      studentCreationCommandKeysRef.current.values(),
      intent,
    );
    if (studentCreationCommandKeysRef.current.size) {
      persistStudentCreationPendingCommands(
        browserSessionStorage(),
        sessionOperator,
        studentCreationCommandKeysRef.current.values(),
      );
    } else {
      clearStudentCreationPendingCommands(browserSessionStorage(), sessionOperator);
    }
  }, [sessionOperator]);

  const submitStudentCommand = useCallback(async (pending: StudentCreationPendingCommand, recovering = false) => {
    if (studentCreationBusyRef.current) return;
    let command: { studentFields: Record<string, unknown>; expectedVersions: StudentCreationPendingCommand["expectedVersions"] };
    try {
      const parsed = JSON.parse(pending.commandIntent) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("学生创建命令格式无效");
      const candidate = parsed as { studentFields?: unknown; expectedVersions?: unknown };
      if (!candidate.studentFields || typeof candidate.studentFields !== "object" || Array.isArray(candidate.studentFields)
        || !candidate.expectedVersions || typeof candidate.expectedVersions !== "object" || Array.isArray(candidate.expectedVersions)) {
        throw new Error("学生创建命令格式无效");
      }
      command = {
        studentFields: candidate.studentFields as Record<string, unknown>,
        expectedVersions: candidate.expectedVersions as StudentCreationPendingCommand["expectedVersions"],
      };
    } catch (error) {
      removeStudentCreationPending(pending.intent);
      if (!recovering) notify(error instanceof Error ? error.message : "学生创建命令格式无效");
      return;
    }

    studentCreationBusyRef.current = true;
    try {
      let response: Response;
      try {
        response = await fetch("/api/operations/students/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandKey: pending.commandKey, ...command }),
        });
      } catch {
        if (!recovering) notify("学生创建结果未知；已保留原命令，刷新后可安全恢复");
        return;
      }
      const rawBody = await response.json().catch(() => null) as unknown;
      const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? rawBody as Record<string, unknown>
        : {};
      const hasAuthoritativeRows = Boolean(body.studentsRow && body.tasksRow);
      const disposition = studentCreationPendingDisposition({
        status: response.status,
        committed: body.committed === true,
        receiptOnly: body.receiptOnly === true,
        hasAuthoritativeRows,
      });
      if (!response.ok || body.committed !== true) {
        if (disposition === "clear") removeStudentCreationPending(pending.intent);
        const message = typeof body.error === "string" ? body.error : "学生创建失败；已保留原命令等待恢复";
        if (!recovering || disposition === "clear") notify(message);
        return;
      }
      if (body.receiptOnly === true) {
        removeStudentCreationPending(pending.intent);
        if (!recovering) notify("学生创建已确认；当前负责范围已变化，未载入学生资料");
        return;
      }
      if (!hasAuthoritativeRows) {
        if (!recovering) notify("学生创建已确认；权威状态行暂不可用，已保留原命令等待恢复");
        return;
      }
      const studentsRow = body.studentsRow as RemoteStateRow<Student[]>;
      const tasksRow = body.tasksRow as RemoteStateRow<Task[]>;
      applyStudentsRemote(studentsRow);
      applyTasksRemote(tasksRow);
      removeStudentCreationPending(pending.intent);
      const visibleStudentMatches = typeof body.studentId === "string" && Array.isArray(studentsRow.payload)
        ? studentsRow.payload.filter((value): value is Student => Boolean(value) && typeof value === "object" && !Array.isArray(value) && value.id === body.studentId)
        : [];
      if (visibleStudentMatches.length === 1) setSelectedStudentId(visibleStudentMatches[0].id);
      if (!recovering) {
        setModal(null);
        setActive("students");
        notify(body.applied === false ? "学生创建已确认，系统没有重复写入" : "学生档案和首个任务已创建");
      }
    } finally {
      studentCreationBusyRef.current = false;
    }
  }, [setActive, setSelectedStudentId, applyStudentsRemote, applyTasksRemote, notify, removeStudentCreationPending]);

  const submitStudent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (studentCreationBusyRef.current) return;
    const data = new FormData(event.currentTarget);
    const studentFields = {
      name: String(data.get("name") ?? "").trim(),
      course: String(data.get("course") ?? "").trim(),
      segment: String(data.get("segment") ?? "试听") as StudentSegment,
      guardianWechat: String(data.get("guardianWechat") ?? "").trim(),
      lpNeed: String(data.get("lpNeed") ?? "试听LP") as LpNeed,
      owner: String(data.get("owner") ?? "").trim(),
      planner: String(data.get("planner") ?? "待分配").trim(),
      grade: String(data.get("grade") ?? "待确认").trim() || "待确认",
      location: String(data.get("location") ?? "VIC").trim() || "VIC",
      timezone: cleanTimezone(data.get("timezone")),
      notes: String(data.get("notes") ?? "无特殊备注").trim() || "无特殊备注",
      ...(String(data.get("remainingHours") ?? "").trim() ? { remainingHours: Number(data.get("remainingHours")) } : {}),
    };
    if (!studentFields.course) {
      notify("课程 / 年级不能为空");
      return;
    }
    if (!studentFields.owner) {
      notify("请选择负责教务");
      return;
    }
    const expectedVersions = {
      students: getCurrentStudentsVersion(),
      tasks: getCurrentTasksVersion(),
    };
    const intentValue = { studentFields };
    const intent = JSON.stringify(intentValue);
    const previous = studentCreationCommandKeysRef.current.get(intent);
    const pending = previous ?? {
      intent,
      commandIntent: JSON.stringify({ ...intentValue, expectedVersions }),
      commandKey: `student-create:${crypto.randomUUID()}`,
      expectedVersions,
    } satisfies StudentCreationPendingCommand;
    studentCreationCommandKeysRef.current = upsertStudentCreationPendingCommand(
      studentCreationCommandKeysRef.current.values(),
      pending,
    );
    persistStudentCreationPendingCommands(
      directEnrollmentStorage,
      sessionOperator,
      studentCreationCommandKeysRef.current.values(),
    );
    await submitStudentCommand(pending);
  };

  useEffect(() => {
    if (studentCreationRecoveryActorRef.current === sessionOperator) return;
    studentCreationRecoveryActorRef.current = sessionOperator;
    const pending = readStudentCreationPendingCommands(browserSessionStorage(), sessionOperator);
    studentCreationCommandKeysRef.current = pending;
    if (!pending.size) return;
    let cancelled = false;
    void (async () => {
      for (const entry of pending.values()) {
        if (cancelled) return;
        await submitStudentCommand(entry, true);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionOperator, submitStudentCommand]);

  const submitStudentEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = requireStudentModalTarget(true);
    if (!target) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const course = String(data.get("course") ?? "").trim();
    if (!course) {
      notify("课程 / 年级不能为空");
      return;
    }
    const guardianWechat = String(data.get("guardianWechat") ?? "").trim();
    const trialStudent = target.segment === "试听";
    const nameResolution = resolveStudentDisplayName({
      segment: trialStudent ? "试听" : "已报名",
      name,
      guardianWechat,
    });
    if (!nameResolution.ok) {
      notify(nameResolution.message);
      return;
    }
    const displayName = nameResolution.displayName;
    const before = target;
    try {
      await studentsShared.mutateAndCommit((current) =>
        current.map((student) =>
          student.id === target.id
            ? {
                ...student,
                name: displayName,
                initials: initials(displayName),
                course,
                grade: String(data.get("grade") ?? "待确认"),
                owner: isAdminView
                  ? String(data.get("owner") ?? student.owner)
                  : student.owner,
                planner: String(
                  data.get("planner") ?? student.planner ?? "待分配",
                ),
                guardianWechat: nameResolution.guardianWechat,
                notes: String(data.get("notes") ?? "无特殊备注"),
                location: String(
                  data.get("location") ?? student.location ?? "VIC",
                ),
                timezone: cleanTimezone(data.get("timezone")),
              }
            : student,
        ),
      );
      addAudit(
        "编辑学生档案",
        `${before.name}（${before.id}）· ${isAdminView ? "姓名/课程/负责人" : "姓名/课程"}资料已更新`,
        "blue",
      );
      setModal(null);
      notify("学生档案已更新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生档案保存失败");
    }
  };

  const submitStudentEvidence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (evidenceUploadBusy) return;
    const target = requireStudentModalTarget(true);
    if (!target) return;
    const data = new FormData(event.currentTarget);
    const attachment = data.get("attachment");
    const fuCategory = String(data.get("fuCategory") ?? "parent_communication") as FuAttachmentCategory;
    if (!FU_ATTACHMENT_CATEGORIES.includes(fuCategory)) {
      notify("请选择有效的 FU 分类");
      return;
    }
    const title = String(data.get("title") ?? FU_ATTACHMENT_CATEGORY_LABELS[fuCategory]).trim() || FU_ATTACHMENT_CATEGORY_LABELS[fuCategory];
    if (!(attachment instanceof File) || attachment.size === 0) {
      notify("请选择需要归档的图片");
      return;
    }
    setEvidenceUploadBusy(true);
    try {
      const upload = new FormData();
      upload.set("commandKey", commandKeyForAttachment("evidence", target.id, attachment, [title, fuCategory]));
      upload.set("studentId", target.id);
      upload.set("file", attachment);
      upload.set("fileTitle", title);
      upload.set("fileType", fuCategory === "renewal_update" ? "续课 FU" : "FU");
      upload.set("fuCategory", fuCategory);
      const response = await fetch("/api/fu-attachments", {
        method: "POST",
        body: upload,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.id || !body.url)
        throw new Error(body.error || "沟通截图上传失败");
      if (!body.filesRow || !body.studentsRow) throw new Error("附件已保存但服务器未返回文件索引。");
      filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
      studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
      clearAttachmentCommandKey("evidence", target.id);
      addAudit(
        "归档学生沟通截图",
        `${target.name} · ${title} · ${body.fileName || attachment.name}`,
        "green",
      );
      setModal(null);
      notify("沟通截图已归档到学生档案");
    } catch (error) {
      notify(error instanceof Error ? error.message : "沟通截图上传失败");
    } finally {
      setEvidenceUploadBusy(false);
    }
  };

  const submitStudentReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reportUploadBusy) return;
    const target = requireStudentModalTarget(true);
    if (!target) return;
    const data = new FormData(event.currentTarget);
    const attachment = data.get("attachment");
    const title = String(data.get("title") ?? "Report 资料").trim() || "Report 资料";
    if (!(attachment instanceof File) || !attachment.size) {
      notify("请选择需要归档的 PDF");
      return;
    }
    setReportUploadBusy(true);
    try {
      const upload = new FormData();
      upload.set("commandKey", commandKeyForAttachment("report", target.id, attachment, [title]));
      upload.set("studentId", target.id);
      upload.set("file", attachment);
      upload.set("fileTitle", title);
      upload.set("fileType", "Report 资料");
      const response = await fetch("/api/fu-attachments", { method: "POST", body: upload });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.kind !== "report" || !body.id || !body.url) {
        throw new Error(body.error || "Report PDF 上传失败");
      }
      if (!body.filesRow || !body.studentsRow) throw new Error("附件已保存但服务器未返回文件索引。");
      filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
      studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
      clearAttachmentCommandKey("report", target.id);
      addAudit("上传 Report PDF", `${target.name} · ${body.fileName || attachment.name}`, "green");
      setModal(null);
      notify("Report PDF 已归档到学生资料");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Report PDF 上传失败");
    } finally {
      setReportUploadBusy(false);
    }
  };

  const submitStudentFollowUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = requireStudentModalTarget(true);
    if (!target) return;
    try {
      const parsed = parseFollowUpFormData(new FormData(event.currentTarget));
      const followUp: StudentFollowUp = { id: id("FUH"), followedUpAt: parsed.followedUpAt, note: parsed.note, recordedBy: operatorLabel(sessionOperator) };
      await studentsShared.mutateAndCommit((current) => current.map((student) => student.id === target.id ? {
        ...student,
        followUp: followUp.followedUpAt,
        followUpHistory: appendStudentFollowUp(student.followUpHistory ?? [], followUp),
      } : student));
      addAudit("记录学生跟进", `${target.name} · ${formatFollowUpTime(followUp.followedUpAt, displayPreferences)}${followUp.note ? ` · ${followUp.note}` : ""}`, "green");
      setModal(null);
      notify("跟进日期已追加到历史");
    } catch (error) {
      notify(error instanceof Error ? error.message : "跟进记录无效");
    }
  };

  const reconcilePendingExamSubmission = async (pending: PendingExamSubmission) => {
    const recovery = pendingExamRecoveryCommand(pending);
    if (!recovery) throw new Error("上一次考试提交记录已损坏，不能安全覆盖");
    const response = await fetch("/api/exams/submit/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recovery),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.resolved !== true
      || body.commandKey !== recovery.commandKey
      || body.studentId !== recovery.studentId
      || body.examId !== recovery.exam.id) {
      throw new Error(body.error || "上一次考试提交结果仍无法确认，请稍后重试");
    }
    if (body.committed === true) {
      if (!body.studentRow || !body.taskRow) {
        throw new Error("上一次考试提交结果不完整，请稍后重试");
      }
      studentsShared.applyRemote(body.studentRow as RemoteStateRow<Student[]>);
      tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
      examSubmissionRef.current = null;
      clearPendingExamSubmission(sessionOperator);
      return { committed: true as const, recovery };
    }
    return { committed: false as const, recovery };
  };

  const submitExam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (examSubmissionBusy) return;
    const target = requireStudentModalTarget(true);
    if (!target) return;
    try {
      const parsed = parseExamFormData(new FormData(event.currentTarget));
      const recovered = examSubmissionRef.current ?? readPendingExamSubmission(sessionOperator);
      const examDraftWithoutId = {
        subject: parsed.subject,
        examType: parsed.examType,
        examVariant: parsed.examVariant,
        examMonth: parsed.examMonth,
        ...(parsed.examDate ? { examDate: parsed.examDate } : {}),
        ...(parsed.resultDateOverride ? { resultDateOverride: parsed.resultDateOverride } : {}),
        includeRecall: parsed.includeRecall,
      };
      const recoveredMatchesDraft = pendingExamMatchesDraft(
        recovered,
        target.id,
        examDraftWithoutId,
      ) && (!parsed.examId || parsed.examId === recovered?.examId);
      if (recovered && !recoveredMatchesDraft) {
        // Never replace an unresolved actor-level command with a different
        // student or draft. First perform a read-only ledger lookup. A missing
        // entry restores the exact old intent for a same-key retry; a committed
        // entry is applied and cleared, but this new draft is never submitted.
        const recovery = pendingExamRecoveryCommand(recovered);
        if (recovery && recovery.studentId !== target.id) {
          const recoveryTarget = readableScopedStudents.find((student) => student.id === recovery.studentId);
          if (!recoveryTarget || !scopedActiveStudentIds.has(recoveryTarget.id) || recoveryTarget.importArchived === true) {
            closeInvalidStudentModal();
            return;
          }
          // This is an explicit retry recovery, not a fallback selection: the
          // exact pending command owns its original student and is surfaced to
          // the operator before any new submit can occur.
          setSelectedStudentId(recoveryTarget.id);
          setStudentModalTargetId(recoveryTarget.id);
          setStudentModalTargetWasArchived(false);
        }
        examSubmissionRef.current = recovered;
        setExamSubmissionBusy(true);
        const reconciled = await reconcilePendingExamSubmission(recovered);
        if (reconciled.committed) {
          setExamDraft(null);
          setModal(null);
          notify("上一次考试提交已确认；当前新内容尚未提交，请重新录入");
        } else {
          setSelectedStudentId(reconciled.recovery.studentId);
          setExamDraft(reconciled.recovery.exam as StudentExamRecord);
          setExamFormResetToken((current) => current + 1);
          notify("上一次考试尚未确认，已恢复原内容；请再次保存以沿用原编号");
        }
        return;
      }
      const examId = parsed.examId
        ?? recovered?.examId
        ?? `EXM-${crypto.randomUUID()}`;
      const exam = { id: examId, ...examDraftWithoutId };
      const intent = JSON.stringify([target.id, exam]);
      if (!recovered || recovered.intent !== intent) {
        examSubmissionRef.current = {
          intent,
          examId,
          commandKey: `exam-submit:${crypto.randomUUID()}`,
        };
      } else {
        examSubmissionRef.current = recovered;
      }
      writePendingExamSubmission(sessionOperator, examSubmissionRef.current);
      setExamSubmissionBusy(true);
      const response = await fetch("/api/exams/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandKey: examSubmissionRef.current.commandKey,
          studentId: target.id,
          exam,
          expectedVersions: {
            students: studentsShared.version,
            tasks: tasksShared.version,
          },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.committed || !body.studentRow || !body.taskRow) {
        throw new Error(body.error || "考试保存失败");
      }
      studentsShared.applyRemote(body.studentRow as RemoteStateRow<Student[]>);
      tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
      const previousExam = target.exams?.find((entry) => entry.id === exam.id);
      examSubmissionRef.current = null;
      clearPendingExamSubmission(sessionOperator);
      setExamDraft(null);
      setModal(null);
      if (body.applied === false) {
        notify("考试提交已确认，系统没有重复写入");
        return;
      }
      addAudit(previousExam ? "更新学生考试" : "记录学生考试", `${target.name} · ${exam.subject} · ${exam.examDate ?? exam.examMonth}`, "amber");
      const unresolvedRoles = Array.isArray(body.unresolvedRoleLabels) ? body.unresolvedRoleLabels : [];
      const routingNotice = unresolvedRoles.length ? `；${unresolvedRoles.join("、")}账号待配置，未生成对应任务` : "";
      const generatedTaskCount = Number(body.generatedTaskCount ?? 0);
      notify(generatedTaskCount ? `考试已保存，并生成 ${generatedTaskCount} 项提醒${routingNotice}` : `考试已保存；确定日期及收件账号后再生成提醒${routingNotice}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "考试内容无效");
    } finally {
      setExamSubmissionBusy(false);
    }
  };

  const submitTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id).trim();
    if (!scopedActiveStudentIds.has(studentId)) {
      notify("当前身份只能为当前范围的活跃学生创建任务。");
      return;
    }
    const title = String(data.get("title") ?? "").trim();
    if (!title) return;
    const dueInput = String(data.get("dueAt") ?? "").trim();
    const dueParts = dueInput.match(/^(\d{4}-\d{2}-\d{2})T([0-2]\d:[0-5]\d)$/);
    const parsedDue = dueParts ? zonedDateTimeToUtc(dueParts[1], dueParts[2], "Australia/Melbourne") : null;
    if (!parsedDue || Number.isNaN(parsedDue.getTime())) {
      notify("请选择准确的截止日期和时间");
      return;
    }
    const task: Task = {
      id: id("TSK"),
      title,
      owner: String(data.get("owner") ?? DEMO_LIMITED_ADMIN_USER),
      ...taskRecipients(String(data.get("owner") ?? DEMO_LIMITED_ADMIN_USER)),
      studentId,
      due: formatInstant(parsedDue, "Australia/Melbourne", displayPreferences),
      dueAt: parsedDue.toISOString(),
      status: statusForDueAt(parsedDue, new Date()),
      tone: "blue",
      category: String(data.get("category") ?? "资料") as TaskCategory,
      trigger: "人工创建",
    };
    try {
      await tasksShared.mutateAndCommit((current) => sortTasksByDueAt([...current, task]));
      addAudit(
        "创建内部任务",
        `${title} · ${studentById(studentId)?.name}`,
        "blue",
      );
      setModal(null);
      notify("任务已加入强提醒队列");
    } catch (error) {
      notify(error instanceof Error ? `任务保存失败：${error.message}` : "任务保存失败");
    }
  };

  const submitNewPayroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const teacherId = String(data.get("teacherId") ?? "").trim();
    const month = String(data.get("month") ?? payrollMonthSelection).trim();
    const currency = String(data.get("currency") ?? "AUD") as PayrollRow["currency"];
    const rate = Number(data.get("rate") ?? 0);
    if (!month || !teacherId) {
      notify("请选择现有老师和薪资月份");
      return;
    }
    if (!Number.isFinite(rate) || rate < 0) {
      notify("请填写有效的课时费");
      return;
    }
    const teacherName = teacherById(teacherId)?.name;
    if (!teacherId || !teacherName) {
      notify("没有找到所选老师");
      return;
    }
    if (payroll.some((row) => row.teacherId === teacherId && row.month === month)) {
      notify("该老师在所选月份已经有薪资记录");
      return;
    }
    const payrollRow: PayrollRow = {
      id: id("PAY"),
      teacherId,
      teacherName,
      month,
      section: String(data.get("section") ?? "教师薪资").trim() || "教师薪资",
      currency,
      lessons: 0,
      trialLessons: 0,
      teacherTotalHours: 0,
      amount: 0,
      teacherTotalAmount: 0,
      status: "需核对",
      note: "手动新增，待导入或核对本月课时明细",
      paymentNote: String(data.get("paymentNote") ?? "").trim(),
      bankName: String(data.get("bankName") ?? "").trim(),
      bankAccount: String(data.get("bankAccount") ?? "").trim(),
      rateRange: rate > 0 ? [rate] : [],
      sourceHours: null,
      sourceLessonCount: null,
      sourceNoShowHours: null,
      hourVariance: null,
      lineCount: 0,
      lines: [],
      source: "薪资页面手动新增",
    };
    try {
      await mutatePayrollAndCommit((current) => [payrollRow, ...current]);
      setPayrollMonthSelection(month);
      setSelectedPayrollKey(payrollDisplayKey("persisted", payrollRow.id, 0));
      setPayrollPage(1);
      addAudit("新增老师薪资记录", `${teacherName} · ${month} · ${currency}`, "green");
      setModal(null);
      notify("老师薪资记录已新增，待导入或核对本月课时");
    } catch (error) {
      notify(error instanceof Error ? `老师薪资保存失败：${error.message}` : "老师薪资保存失败");
    }
  };

  const submitPayrollEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!payrollDraft) return;
    const data = new FormData(event.currentTarget);
    const teacherName = String(data.get("teacherName") ?? "").trim();
    const month = String(data.get("month") ?? "").trim();
    const currency = String(data.get("currency") ?? payrollDraft.currency ?? "AUD") as PayrollRow["currency"];
    const fallbackRate = Number(data.get("defaultRate") ?? 0);
    if (!teacherName || !month || !Number.isFinite(fallbackRate) || fallbackRate < 0) {
      notify("请填写有效的老师姓名、薪资月份和课时费");
      return;
    }
    if (payroll.some((row) => row.id !== payrollDraft.id && row.teacherId === payrollDraft.teacherId && row.month === month)) {
      notify("该老师在所选月份已经有薪资记录");
      return;
    }
    const sourceEvidenceOnly = (payrollDraft.lines?.length ?? 0) > 0
      && (payrollDraft.lines ?? []).every((line) => line.evidenceOnly === true);
    const updatedLines = (payrollDraft.lines ?? []).map((line, index) => {
      if (sourceEvidenceOnly) {
        return { ...line, evidenceOnly: true, rate: 0, subtotal: 0 };
      }
      const submittedRate = Number(data.get(`lineRate-${index}`) ?? line.rate);
      const rate = Number.isFinite(submittedRate) && submittedRate >= 0 ? submittedRate : line.rate;
      if (line.hours === null) throw new Error("学生课时待核对，不能生成薪资。");
      return { ...line, rate, subtotal: Number((line.hours * rate).toFixed(2)) };
    });
    const payrollHours = payrollDraft.teacherTotalHours ?? payrollDraft.lessons + payrollDraft.trialLessons;
    const amount = sourceEvidenceOnly
      ? Number((payrollHours * fallbackRate).toFixed(2))
      : updatedLines.length
      ? Number(updatedLines.reduce((total, line) => total + line.subtotal, 0).toFixed(2))
      : Number((payrollHours * fallbackRate).toFixed(2));
    const rateRange = sourceEvidenceOnly
      ? (fallbackRate > 0 ? [fallbackRate] : [])
      : Array.from(new Set((updatedLines.length ? updatedLines.map((line) => line.rate) : [fallbackRate]).filter((rate) => rate > 0))).sort((a, b) => a - b);
    const wasLocked = payrollDraft.status === "已锁定";
    const draftSourceIndex = payrollDraftSourceIndex;
    try {
      await mutatePayrollAndCommit((current) => {
        let targetIndex = -1;
        let persistedDraft = payrollDraft;
        if (draftSourceIndex !== null) {
          if (current[draftSourceIndex]?.id !== payrollDraft.id) {
            throw new Error("薪资列表已变化，请刷新后重试");
          }
          targetIndex = draftSourceIndex;
          persistedDraft = current[targetIndex];
        } else {
          targetIndex = current.findIndex((row) => row.id === payrollDraft.id);
          if (targetIndex >= 0) persistedDraft = current[targetIndex];
        }
        const updated: PayrollRow = {
          ...persistedDraft,
          teacherName,
          month,
          currency,
          section: String(data.get("section") ?? persistedDraft.section ?? "教师薪资").trim() || "教师薪资",
          bankName: String(data.get("bankName") ?? "").trim(),
          bankAccount: String(data.get("bankAccount") ?? "").trim(),
          paymentNote: String(data.get("paymentNote") ?? "").trim(),
          rateRange,
          lessons: payrollDraft.lessons,
          trialLessons: payrollDraft.trialLessons,
          teacherTotalHours: payrollDraft.teacherTotalHours,
          sourceHours: payrollDraft.sourceHours,
          sourceLessonCount: payrollDraft.sourceLessonCount,
          sourceNoShowHours: payrollDraft.sourceNoShowHours,
          hourVariance: payrollDraft.hourVariance,
          source: payrollDraft.source,
          sourceRevision: payrollDraft.sourceRevision,
          sourceProjectionRevision: payrollDraft.sourceProjectionRevision,
          lines: updatedLines,
          lineCount: updatedLines.length,
          amount,
          teacherTotalAmount: amount,
          ...(sourceEvidenceOnly ? { lineAmount: undefined } : {}),
          status: "需核对",
          lockedBy: undefined,
          lockedAt: undefined,
        };
        return targetIndex >= 0
          ? current.map((row, index) => index === targetIndex ? updated : row)
          : [updated, ...current];
      });
      addAudit(
        "修改老师薪资与费率",
        `${teacherName} · ${month} · ${formatMoney(amount, currency)}${wasLocked ? " · 原锁定记录已重置" : ""}`,
        "amber",
      );
      setPayrollMonthSelection(month);
      if (draftSourceIndex === null) {
        setSelectedPayrollKey(payrollDisplayKey("persisted", payrollDraft.id, 0));
      }
      setPayrollDraft(null);
      setPayrollDraftSourceIndex(null);
      setModal(null);
      notify(wasLocked ? "薪资已更新并重置为需核对" : "薪资与费率已更新，等待重新核对");
    } catch (error) {
      notify(error instanceof Error ? `薪资修改保存失败：${error.message}` : "薪资修改保存失败");
    }
  };

  const submitLp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let parsedLp: ReturnType<typeof parseLpWorkflowFormData>;
    try {
      parsedLp = (await import("@/app/lp-workflow-fields")).parseLpWorkflowFormData(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : "LP 表单内容无效");
      return;
    }
    const provisional = data.get("provisional") === "on";
    let studentId = String(data.get("studentId") ?? lpDraftStudentId).trim();
    const workflowType = parsedLp.workflowType;
    let trialIntake: TrialIntake | undefined;
    if (workflowType === "试听 LP") {
      try {
        trialIntake = trialIntakeFromFields(parsedLp.fields as LpFieldValues);
      } catch (error) {
        notify(error instanceof Error ? error.message : "试听信息交接字段无效");
        return;
      }
    }
    const existingStudent = studentById(studentId);
    if (provisional && workflowType !== "试听 LP") {
      notify("只有试听 LP 可以创建无姓名临时档案");
      return;
    }
    const owner = isAdminView ? parsedLp.fields.responsibleOperations : existingStudent?.owner ?? "";
    const planner = String(
      trialIntake?.planner ?? data.get("provisionalPlanner") ?? existingStudent?.planner ?? "Tara",
    );
    let provisionalIntake: { course: string; guardianWechat: string; owner: string; planner: string } | undefined;
    const workflowStudent: Student | undefined = existingStudent;
    if (provisional) {
      if (!isAdminView) {
        notify("无姓名临时建档需要管理员处理，避免出现未保存的学生记录");
        return;
      }
      const provisionalCourse = String(
        data.get("provisionalCourse") ?? "",
      ).trim();
      const provisionalGuardianWechat = String(data.get("provisionalGuardianWechat") ?? "").trim();
      if (!provisionalCourse) {
        notify("暂未有姓名时，至少要填写科目/课程");
        return;
      }
      const nameResolution = resolveStudentDisplayName({
        segment: "试听",
        name: "",
        guardianWechat: provisionalGuardianWechat,
      });
      if (!nameResolution.ok) {
        notify(nameResolution.message);
        return;
      }
      provisionalIntake = {
        course: provisionalCourse,
        guardianWechat: provisionalGuardianWechat,
        owner,
        planner,
      };
      studentId = "";
    } else {
      if (workflowType === "学生直报（无试听）") {
        if (!workflowStudent || directEnrollmentBusyRef.current) {
          if (!workflowStudent) notify("没有找到该学生，未创建 LP 工作流");
          return;
        }
        const directFields = parsedLp.fields as Record<string, unknown>;
        const {
          subject: parsedSubject,
          purchasedHours: parsedPurchasedHours,
          bonusHours: parsedBonusHours,
          ...rawLpFields
        } = directFields;
        const lpFields = {
          ...rawLpFields,
          specialNotes: typeof rawLpFields.specialNotes === "string" ? rawLpFields.specialNotes : "",
          universityMajor: typeof rawLpFields.universityMajor === "string" ? rawLpFields.universityMajor : "",
          universityYear: typeof rawLpFields.universityYear === "string" ? rawLpFields.universityYear : "",
          preferredTime: typeof rawLpFields.preferredTime === "string" ? rawLpFields.preferredTime : "",
        };
        const subject = String(parsedSubject ?? "").trim();
        const purchasedHours = Number(parsedPurchasedHours);
        const bonusHours = Number(parsedBonusHours);
        const expectedVersions = {
          students: studentsShared.version,
          lpItems: lpShared.version,
          tasks: tasksShared.version,
        };
        const commandScope = JSON.stringify({ studentId, workflowType, fields: lpFields, purchasedHours, bonusHours, subject });
        const pendingCommand = directEnrollmentCommandKeysRef.current.get(commandScope);
        const commandKey = pendingCommand?.commandKey ?? crypto.randomUUID();
        const commandExpectedVersions = pendingCommand?.expectedVersions ?? expectedVersions;
        const commandIntent = JSON.stringify({
          studentId,
          workflowType,
          fields: lpFields,
          purchasedHours,
          bonusHours,
          subject,
          expectedVersions: commandExpectedVersions,
        });
        const pending = { intent: commandScope, commandIntent, commandKey, expectedVersions: commandExpectedVersions } satisfies DirectEnrollmentPendingCommand;
        directEnrollmentCommandKeysRef.current = upsertDirectEnrollmentPendingCommand(directEnrollmentCommandKeysRef.current.values(), pending);
        persistDirectEnrollmentPendingCommands(directEnrollmentStorage, sessionOperator, directEnrollmentCommandKeysRef.current.values());
        directEnrollmentBusyRef.current = true;
        try {
          const response = await fetch("/api/operations/direct-enrollment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandKey,
              studentId,
              workflowType,
              fields: lpFields,
              purchasedHours,
              bonusHours,
              subject,
              expectedVersions: commandExpectedVersions,
            }),
          });
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (!response.ok || body.committed !== true) {
            if (response.status === 409) {
              directEnrollmentCommandKeysRef.current = removeDirectEnrollmentPendingCommand(directEnrollmentCommandKeysRef.current.values(), commandScope);
              if (directEnrollmentCommandKeysRef.current.size) {
                persistDirectEnrollmentPendingCommands(directEnrollmentStorage, sessionOperator, directEnrollmentCommandKeysRef.current.values());
              } else {
                clearDirectEnrollmentPendingCommands(directEnrollmentStorage, sessionOperator);
              }
            }
            throw new Error(typeof body.error === "string" ? body.error : "学生直报保存失败");
          }
          // A replay is already committed even when a transiently missing
          // authoritative state row prevents this response from carrying all
          // three snapshots. Keep the same command key so the next retry can
          // replay again; never turn that receipt into a second local write.
          if (!body.studentsRow || !body.lpItemsRow || !body.tasksRow) {
            notify("学生直报已确认；共享状态行暂不可用，请刷新后安全重试");
            return;
          }
          studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
          lpShared.applyRemote(body.lpItemsRow as RemoteStateRow<LpItem[]>);
          tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
          directEnrollmentCommandKeysRef.current = removeDirectEnrollmentPendingCommand(directEnrollmentCommandKeysRef.current.values(), commandScope);
          if (directEnrollmentCommandKeysRef.current.size) {
            persistDirectEnrollmentPendingCommands(directEnrollmentStorage, sessionOperator, directEnrollmentCommandKeysRef.current.values());
          } else {
            clearDirectEnrollmentPendingCommands(directEnrollmentStorage, sessionOperator);
          }
          addAudit("创建学生直报 LP", `${workflowStudent.name} · ${subject} · ${purchasedHours}+${bonusHours}`, "green");
          showCommittedLpView(body.lpItemId);
          setSelectedStudentId(studentId);
          setModal(null);
          setActive("lp");
          notify(body.applied === false ? "学生直报已确认，系统没有重复保存" : "已原子创建直报 LP、课包购买记录和强提醒");
        } catch (error) {
          notify(error instanceof Error ? error.message : "学生直报保存失败；可安全重试");
        } finally {
          directEnrollmentBusyRef.current = false;
        }
        return;
      }
    }
    if (!provisionalIntake && !workflowStudent) {
      notify("没有找到该学生，未创建 LP 工作流");
      return;
    }
      if (lpAtomicBusyRef.current) return;
      const fields = parsedLp.fields as LpFieldValues;
      const expectedVersions = {
        students: studentsShared.version,
        lpItems: lpShared.version,
        tasks: tasksShared.version,
        files: filesShared.version,
      };
      const intent = JSON.stringify(provisionalIntake
        ? { operation: "create", provisionalIntake, workflowType, fields }
        : { operation: "create", studentId, workflowType, fields });
      const previous = lpAtomicCommandKeysRef.current.get(intent);
      const commandKey = previous?.commandKey ?? crypto.randomUUID();
      const commandExpectedVersions = previous?.expectedVersions ?? expectedVersions;
      const commandInput = provisionalIntake
        ? { commandKey, operation: "create" as const, workflowType, fields, provisionalIntake, expectedVersions: commandExpectedVersions }
        : { commandKey, operation: "create" as const, studentId, workflowType, fields, expectedVersions: commandExpectedVersions };
      let parsedCommand: ReturnType<typeof parseLpAtomicCommand>;
      try { parsedCommand = parseLpAtomicCommand(commandInput); } catch (error) { notify(error instanceof Error ? error.message : "LP 表单内容无效"); return; }
      const commandIntent = JSON.stringify(lpAtomicIntent(parsedCommand));
      const pending: LpAtomicPendingEntry = { intent, commandIntent, commandKey, expectedVersions: commandExpectedVersions };
      lpAtomicCommandKeysRef.current = upsertLpAtomicPendingCommand(lpAtomicCommandKeysRef.current.values(), pending);
      persistLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator, lpAtomicCommandKeysRef.current.values());
      lpAtomicBusyRef.current = true;
      try {
        const response = await fetch("/api/operations/lp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commandInput) });
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok || body.committed !== true) {
          if (response.status === 409) {
            lpAtomicCommandKeysRef.current = removeLpAtomicPendingCommand(lpAtomicCommandKeysRef.current.values(), intent);
            persistLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator, lpAtomicCommandKeysRef.current.values());
          }
          throw new Error(typeof body.error === "string" ? body.error : "LP 保存失败");
        }
        if (!body.studentsRow || !body.lpItemsRow || !body.tasksRow || !body.filesRow) {
          notify("LP 已确认；共享状态行暂不可用，请刷新后安全重试");
          return;
        }
        studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
        lpShared.applyRemote(body.lpItemsRow as RemoteStateRow<LpItem[]>);
        tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
        filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
        const committedStudentId = typeof body.studentId === "string" ? body.studentId : studentId;
        lpAtomicCommandKeysRef.current = removeLpAtomicPendingCommand(lpAtomicCommandKeysRef.current.values(), intent);
        persistLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator, lpAtomicCommandKeysRef.current.values());
        showCommittedLpView(body.lpItemId);
        setSelectedStudentId(committedStudentId);
        setModal(null);
        setActive("lp");
        addAudit("创建 LP 工作流", `${workflowStudent?.name ?? provisionalIntake?.guardianWechat ?? committedStudentId} · ${workflowType}`, "green");
        notify(body.applied === false ? "LP 已确认，系统没有重复保存" : workflowType === "试听 LP" ? "试听 LP 和所需任务已保存" : "已原子创建 LP 和对应强提醒");
      } catch (error) {
        notify(error instanceof Error ? error.message : "LP 保存失败；可安全重试");
      } finally { lpAtomicBusyRef.current = false; }
      return;
  };

  const submitLpRevision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lpRevisionDraft) return;
    const data = new FormData(event.currentTarget);
    const documentUrl = String(data.get("documentUrl") ?? "").trim();
    const revisionNote = String(data.get("revisionNote") ?? "").trim();
    if (!documentUrl) {
      notify("请填写本次 LP 版本的腾讯文档链接");
      return;
    }
    try {
      const parsed = new URL(documentUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    } catch {
      notify("请填写完整的 http 或 https 链接");
      return;
    }
    if (lpAtomicBusyRef.current) return;
    const expectedVersions = { students: studentsShared.version, lpItems: lpShared.version, tasks: tasksShared.version, files: filesShared.version };
    const fields = { documentUrl };
    const intent = JSON.stringify({ operation: "revise", studentId: lpRevisionDraft.studentId, lpItemId: lpRevisionDraft.id, fields, ...(revisionNote ? { revisionNote } : {}) });
    const previous = lpAtomicCommandKeysRef.current.get(intent);
    const commandKey = previous?.commandKey ?? crypto.randomUUID();
    const commandExpectedVersions = previous?.expectedVersions ?? expectedVersions;
    const commandInput = { commandKey, operation: "revise" as const, studentId: lpRevisionDraft.studentId, lpItemId: lpRevisionDraft.id, fields, revisionNote };
    const requestBody = { ...commandInput, expectedVersions: commandExpectedVersions };
    let parsedCommand: ReturnType<typeof parseLpAtomicCommand>;
    try { parsedCommand = parseLpAtomicCommand(requestBody); } catch (error) { notify(error instanceof Error ? error.message : "LP 修订内容无效"); return; }
    const commandIntent = JSON.stringify(lpAtomicIntent(parsedCommand));
    const pending: LpAtomicPendingEntry = { intent, commandIntent, commandKey, expectedVersions: commandExpectedVersions };
    lpAtomicCommandKeysRef.current = upsertLpAtomicPendingCommand(lpAtomicCommandKeysRef.current.values(), pending);
    persistLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator, lpAtomicCommandKeysRef.current.values());
    lpAtomicBusyRef.current = true;
    try {
      const response = await fetch("/api/operations/lp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || body.committed !== true) {
        if (response.status === 409) { lpAtomicCommandKeysRef.current = removeLpAtomicPendingCommand(lpAtomicCommandKeysRef.current.values(), intent); persistLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator, lpAtomicCommandKeysRef.current.values()); }
        throw new Error(typeof body.error === "string" ? body.error : "LP 修订保存失败");
      }
      if (!body.studentsRow || !body.lpItemsRow || !body.tasksRow || !body.filesRow) { notify("LP 修订已确认；共享状态行暂不可用，请刷新后安全重试"); return; }
      studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
      lpShared.applyRemote(body.lpItemsRow as RemoteStateRow<LpItem[]>);
      tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
      filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
      lpAtomicCommandKeysRef.current = removeLpAtomicPendingCommand(lpAtomicCommandKeysRef.current.values(), intent);
      persistLpAtomicPendingCommands(directEnrollmentStorage, sessionOperator, lpAtomicCommandKeysRef.current.values());
      addAudit("修订 LP", `${lpRevisionDraft.title} · 版本 ${(lpRevisionDraft.revisionNumber ?? 1) + 1}${revisionNote ? ` · ${revisionNote}` : ""}`, "purple");
      setLpRevisionDraft(null); setModal(null); notify(body.applied === false ? "LP 修订已确认，系统没有重复保存" : "LP 新版本和修订历史已保存");
    } catch (error) { notify(error instanceof Error ? error.message : "LP 修订保存失败；可安全重试"); }
    finally { lpAtomicBusyRef.current = false; }
  };

  const submitTeacherAvailability = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isTeacherView || !currentTeacher || teacherAvailabilitySubmitBusy) return;
    const data = new FormData(event.currentTarget);
    const slots = [1, 2, 3, 4, 5, 6, 0].flatMap((day) => {
      if (data.get(`slot-${day}`) !== "on") return [];
      const start = String(data.get(`start-${day}`) ?? "").trim();
      const end = String(data.get(`end-${day}`) ?? "").trim();
      return [{ day, start, end }];
    });
    if (!slots.length) {
      notify("请至少选择一个可约星期和时间段");
      return;
    }
    if (slots.some((slot) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.end)
      || slot.end === slot.start)) {
      notify("请检查每个已选时段的开始和结束时间");
      return;
    }
    setTeacherAvailabilitySubmitBusy(true);
    try {
      const response = await fetch("/api/teacher-availability/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionKey: teacherAvailabilitySubmissionKey.current ??= crypto.randomUUID(),
          month: String(data.get("month") ?? ""),
          timezone: cleanTimezone(data.get("timezone")),
          additionalStudents: Number(data.get("additionalStudents") ?? 0),
          slots,
          notes: String(data.get("notes") ?? "").trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.submitted) throw new Error(body.error || "月度 AVA 提交失败");
      teacherAvailabilitySubmissionKey.current = null;
      setModal(null);
      notify(body.unchanged ? "这份 AVA 已经提交，仍在等待教务审核" : "月度 AVA 已提交，教务审核后才会用于排课");
    } catch (error) {
      notify(error instanceof Error ? error.message : "月度 AVA 提交失败");
    } finally {
      setTeacherAvailabilitySubmitBusy(false);
    }
  };

  const submitAva = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAdminView) {
      notify("录入 AVA 需要管理员处理");
      return;
    }
    const data = new FormData(event.currentTarget);
    const teacherId = String(data.get("teacherId") ?? selectedTeacher.id);
    const month = String(data.get("month") ?? isoDateInTimezone(new Date(), "Australia/Melbourne").slice(0, 7));
    const day = Number(data.get("day") ?? 1);
    const start = String(data.get("start") ?? "16:00");
    const end = String(data.get("end") ?? "18:00");
    const teacher = teacherById(teacherId);
    if (!teacher) {
      notify("请从老师清单中选择需要录入 AVA 的老师");
      return;
    }
    let availabilityWindows: TeacherAvailabilityWindow[];
    try {
      const added = createMonthlyAvailabilityWindows({
        teacherId,
        month,
        timezone: cleanTimezone(teacher.availabilityTimezone ?? teacher.timezone),
        slots: [{ day, start, end }],
        idSeed: id("AVA"),
        source: "manual",
      });
      availabilityWindows = [...(teacher.availabilityWindows ?? []), ...added];
      assertValidTeacherAvailability(availabilityWindows);
      await teachersShared.mutateAndCommit((current) => current.map((entry) => entry.id === teacherId
        ? { ...entry, availabilityWindows, availabilityUpdated: `手动录入 · 今天 ${nowLabel()}` }
        : entry));
      setSelectedTeacherId(teacherId);
      addAudit("录入老师 AVA", `${teacher.name} · ${month} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day]} ${start}-${end}`, "green");
      setModal(null);
      notify("月度 AVA 已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "AVA 保存失败");
    }
  };

  const applyRecoveredBookingRow = bookingsShared.applyRemote;
  const applyRecoveredStudentRow = studentsShared.applyRemote;
  const applyRecoveredTaskRow = tasksShared.applyRemote;
  const applyRecoveredTeacherRow = teachersShared.applyRemote;
  useEffect(() => {
    let cancelled = false;
    const storage = browserSessionStorage();
    const pending = readBookingProjectionPendingCommands(storage, sessionOperator);
    bookingProjectionCommandKeysRef.current = pending;
    if (!pending.size || bookingProjectionBusyRef.current) return () => { cancelled = true; };
    bookingProjectionBusyRef.current = true;
    void (async () => {
      try {
        for (const entry of pending.values()) {
          let received: Awaited<ReturnType<typeof bookingMutationFetch>>;
          try {
            received = await bookingMutationFetch("/api/bookings/mutate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: entry.command,
            });
          } catch {
            break;
          }
          const { response, body: receivedBody } = received;
          const body = (receivedBody ?? {}) as Record<string, unknown>;
          if (cancelled) return;
          if (response.ok && body.committed === true
            && body.bookingRow && body.studentRow && body.taskRow && body.teacherRow) {
            applyRecoveredBookingRow(body.bookingRow as RemoteStateRow<Booking[]>);
            applyRecoveredStudentRow(body.studentRow as RemoteStateRow<Student[]>);
            applyRecoveredTaskRow(body.taskRow as RemoteStateRow<Task[]>);
            applyRecoveredTeacherRow(body.teacherRow as RemoteStateRow<Teacher[]>);
            bookingProjectionCommandKeysRef.current = removeBookingProjectionPendingCommand(
              bookingProjectionCommandKeysRef.current.values(),
              entry.intent,
            );
            continue;
          }
          // A definitive validation/authorization/OCC rejection cannot have
          // committed this actor-bound command. Unknown 5xx/network outcomes
          // retain the exact original command for the next reload.
          if ([400, 403, 404, 409].includes(response.status)) {
            bookingProjectionCommandKeysRef.current = removeBookingProjectionPendingCommand(
              bookingProjectionCommandKeysRef.current.values(),
              entry.intent,
            );
          }
        }
      } finally {
        if (bookingProjectionCommandKeysRef.current.size) {
          persistBookingProjectionPendingCommands(
            storage,
            sessionOperator,
            bookingProjectionCommandKeysRef.current.values(),
          );
        } else {
          clearBookingProjectionPendingCommands(storage, sessionOperator);
        }
        bookingProjectionBusyRef.current = false;
        if (!cancelled && !bookingProjectionCommandKeysRef.current.size) {
          reportSharedSync("synced", "已恢复未确认的排课事务结果");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [
    applyRecoveredBookingRow,
    applyRecoveredStudentRow,
    applyRecoveredTaskRow,
    applyRecoveredTeacherRow,
    reportSharedSync,
    sessionOperator,
  ]);

  const submitBooking = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? "").trim();
    const teacherId = isTeacherView
      ? (currentTeacher?.id ?? "")
      : String(data.get("teacherId") ?? "").trim();
    const date = String(data.get("date") ?? "");
    const start = String(data.get("start") ?? "");
    const duration = Number(data.get("duration") ?? 60);
    const inputTimezone = cleanTimezone(data.get("timezone"));
    const kind = String(data.get("kind") ?? "常规课") as Booking["kind"];
    const packageId = String(data.get("packageId") ?? bookingDraft?.packageId ?? "").trim();
    const subjectId = String(data.get("subjectId") ?? bookingDraft?.course ?? "").trim();
    const teacherSubjectId = String(data.get("teacherSubjectId") ?? bookingDraft?.teacherSubjectId ?? "").trim();
    const frequency = String(data.get("frequency") ?? (bookingDraft?.recurring ? "weekly" : "single")) as BookingRecurrenceFrequency;
    const recurring = frequency !== "single";
    const customIntervalDays = Number(data.get("recurrenceIntervalDays") ?? bookingDraft?.recurrenceIntervalDays ?? 0);
    const repeatCountRaw = String(data.get("repeatCount") ?? "").trim();
    const parsedRepeatCount = Number(repeatCountRaw);
    const repeatCount: number | undefined = recurring
      ? repeatCountRaw && Number.isFinite(parsedRepeatCount)
        ? parsedRepeatCount
        : bookingDraft?.recurring && bookingDraft.repeatCount == null
          ? undefined
          : undefined
      : 1;
    let recurrenceIntervalDays: number | undefined;
    try {
      recurrenceIntervalDays = recurrenceIntervalForFrequency(frequency, customIntervalDays);
    } catch (error) {
      notify(error instanceof Error ? error.message : "排课频率或节数无效。");
      return;
    }
    const submittedAt = new Date();
    const student = studentById(studentId);
    const teacher = teacherById(teacherId);
    if (!scopedActiveStudentIds.has(studentId)) {
      notify("当前身份只能为当前范围的活跃学生安排课程。");
      return;
    }
    if (!student) {
      notify("请从学生清单选择需要排课的学生。");
      return;
    }
    if (!teacher) {
      notify("请从老师清单选择需要排课的老师。");
      return;
    }
    if (!teacherId) {
      notify("当前老师账号没有匹配到老师档案，请联系管理员。");
      return;
    }
    if (!date || !start) {
      notify("请填写课程日期和开始时间。");
      return;
    }
    const bookingDraftDerivedEndDate = recurrenceEndDateDerivedFromCount(bookingDraft);
    const submittedEndDateField = String(data.get("recurrenceEndDate") ?? "").trim();
    const recurrenceEndDate = recurring
      ? submittedEndDateField && submittedEndDateField !== bookingDraftDerivedEndDate
        ? submittedEndDateField
        : bookingDraft?.recurrenceEndDate && !bookingDraftDerivedEndDate
          ? bookingDraft.recurrenceEndDate
          : undefined
      : undefined;
    const legacyUnbounded = Boolean(bookingDraft?.recurring && bookingDraft.repeatCount == null && !bookingDraft.recurrenceEndDate);
    if (legacyUnbounded && recurring && (recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS) !== LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS && !recurrenceEndDate) {
      notify("旧版长期课程改为非每周频率时，必须填写本轮节数或结束日期。");
      return;
    }
    try {
      validateBookingRecurrence({
        startDate: date,
        recurring,
        ...(recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays } : {}),
        ...(repeatCount !== undefined ? { repeatCount } : {}),
        ...(recurrenceEndDate ? { recurrenceEndDate } : {}),
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "排课频率或节数无效。");
      return;
    }
    const authoritativeRecurrenceEndDate = recurring
      ? recurrenceSourceEndDate({
          startDate: date,
          recurring,
          ...(recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays } : {}),
          ...(repeatCount !== undefined ? { repeatCount } : {}),
          ...(recurrenceEndDate ? { recurrenceEndDate } : {}),
        })
      : undefined;
    if (!subjectId) {
      notify("请选择本节课程科目。");
      return;
    }
    if (!teacherSubjectId || !teacher.subjects.includes(teacherSubjectId)) {
      notify(`请按腾讯老师子表为 ${teacher.name} 选择其可教的科目分类。`);
      return;
    }
    const studentPackages = student.lessonPackages ?? [];
    const studentSubjectIds = Array.from(new Set([
      student.course,
      ...studentPackages.flatMap((item) => item.subjectIds),
    ].filter(Boolean)));
    if (!studentSubjectIds.includes(subjectId)) {
      notify("所选科目未绑定到该学生。");
      return;
    }
    if (kind !== "试听") {
      const lessonPackage = studentPackages.find((item) => item.id === packageId);
      if (!lessonPackage) {
        notify("非试听课程必须选择本节课使用的课包。");
        return;
      }
      if (!lessonPackage.subjectIds.includes(subjectId)) {
        notify(`课包“${lessonPackage.name}”未绑定 ${subjectId}。`);
        return;
      }
    }
    const firstTeacherStudentBooking = !bookingDraft && !bookings.some((item) => item.kind !== "代课" && item.teacherId === teacherId && item.studentId === studentId);
    const movingTeacherOrStudent = Boolean(bookingDraft && (bookingDraft.teacherId !== teacherId || bookingDraft.studentId !== studentId));
    const newTeacherStudentBooking = movingTeacherOrStudent && !bookings.some((item) => item.id !== bookingDraft?.id && item.kind !== "代课" && item.teacherId === teacherId && item.studentId === studentId);
    const establishesTeacherStudentRelationship = kind !== "代课" && !bookings.some(
      (item) => item.kind !== "代课" && item.teacherId === teacherId && item.studentId === studentId,
    );
    const targetCapacityConfigured = Number.isSafeInteger(teacher.newStudentCapacity) && (teacher.newStudentCapacity as number) >= 0;
    const targetCapacityAvailable = targetCapacityConfigured && (teacher.newStudentCapacity as number) > 0;
    if (kind !== "代课" && firstTeacherStudentBooking && !targetCapacityConfigured) {
      notify(`${teacher.name} 尚未录入可接新生数量，请先在老师档案中录入容量。`);
      return;
    }
    if (kind !== "代课" && firstTeacherStudentBooking && !targetCapacityAvailable) {
      notify(`${teacher.name} 的可接新生数量为 0，请先选择其他老师或由教务调整数量。`);
      return;
    }
    if (bookingDraft && movingTeacherOrStudent && !isAdminView) {
      notify("更换老师或学生需要管理员处理，以保持可接新生数量准确。");
      return;
    }
    if (bookingDraft && kind !== "代课" && newTeacherStudentBooking && !targetCapacityConfigured) {
      notify(`${teacher.name} 尚未录入可接新生数量，请先在老师档案中录入容量。`);
      return;
    }
    if (bookingDraft && kind !== "代课" && newTeacherStudentBooking && !targetCapacityAvailable) {
      notify(`${teacher.name} 的可接新生数量为 0，请先选择其他老师或由教务调整数量。`);
      return;
    }
    if (establishesTeacherStudentRelationship && !teacher.acceptsStudents) {
      notify(`${teacher.name} 当前暂停接新，不能建立新的师生关系。已有师生关系可继续排课。`);
      return;
    }
    if (
      recurring &&
      repeatCount == null &&
      !(bookingDraft?.recurring && bookingDraft.repeatCount == null)
    ) {
      notify("固定课程必须明确填写本轮节数，系统不会自动假设 12 节。");
      return;
    }
    const validationCount = recurring
      ? recurrenceOccurrenceCount({
          startDate: date,
          recurring: true,
          ...(recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays } : {}),
          ...(repeatCount !== undefined ? { repeatCount } : {}),
          ...(authoritativeRecurrenceEndDate ? { recurrenceEndDate: authoritativeRecurrenceEndDate } : {}),
        }) ?? 104
      : 1;
    const proposedDates = Array.from({ length: validationCount }, (_, index) =>
      shiftIsoDate(date, index * (recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS)),
    ).filter((occurrenceDate) => !authoritativeRecurrenceEndDate || occurrenceDate <= authoritativeRecurrenceEndDate);
    const conflictDate = proposedDates.find((occurrenceDate) =>
      scheduleConflict(
        studentId,
        teacherId,
        occurrenceDate,
        start,
        duration,
        inputTimezone,
        bookingDraft?.id,
      ),
    );
    if (conflictDate) {
      notify(`${conflictDate} 的学生或老师已有重叠课程，请调整本轮排课。`);
      return;
    }
    const unavailableDate = proposedDates.find(
      (occurrenceDate) =>
        !teacherAvailableAt(
          teacher,
          occurrenceDate,
          start,
          duration,
          inputTimezone,
        ),
    );
    if (unavailableDate) {
      notify(
        `${unavailableDate} 不在 ${teacher.name} 的结构化 AVA 内，请调整本轮排课。`,
      );
      return;
    }
    const bookingId = bookingDraft?.id ?? id("LES");
    const booking: Booking = {
      id: bookingId,
      studentId,
      teacherId,
      date,
      start,
      duration,
      kind,
      status: "待确认",
      timezone: inputTimezone,
      recurring,
      repeatCount,
      ...(recurrenceIntervalDays !== undefined ? { recurrenceIntervalDays } : {}),
      ...(recurrenceEndDate !== undefined ? { recurrenceEndDate } : {}),
      requestedAt: bookingDraft?.requestedAt ?? submittedAt.toISOString(),
      packageId: packageId || undefined,
      course: subjectId,
      teacherSubjectId,
    };
    if (isPastBooking(booking) && !bookingDraft) {
      notify("不能创建已经过去的课程，请检查日期、时间和录入时区。");
      return;
    }
    if (kind === "试听" && bookingInstant(booking).getTime() <= submittedAt.getTime()) {
      notify("试听开始时间必须晚于当前时间，才能生成准确提醒。");
      return;
    }
    if (bookingDraft && isPastBooking(bookingDraft)) {
      notify("历史课程已经归档，不能再编辑课程系列。");
      return;
    }
    const scheduleSummary = `${student.name} · ${date} ${start} · ${teacher.name} · ${recurring ? `${proposedDates.length} 节固定课` : "单次课"}`;
    requestConfirmation({
      title: bookingDraft ? "确认修改整个课程系列" : "确认创建排课",
      detail: scheduleSummary,
      items: [
        `录入时区：${timezoneLabel(inputTimezone)}；每节 ${duration} 分钟`,
        recurring
          ? `会创建或更新 ${proposedDates.length} 个、每 ${recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS} 天一次的时段${authoritativeRecurrenceEndDate ? `，最晚至 ${authoritativeRecurrenceEndDate}` : ""}`
          : "只创建 1 个课程时段",
        bookingDraft
          ? "会重新检查整组课程的冲突与老师 AVA"
          : isTeacherView
            ? "创建后等待教务确认"
            : "创建后会生成 LP、N-2 和课后检查任务",
      ],
      confirmLabel: bookingDraft ? "保存整个系列" : "确认创建",
      onConfirm: async () => {
        await writeBookingCapacityMutation({ action: "upsert", bookingId: booking.id, booking });
        if (bookingDraft) {
          addAudit("编辑排课", scheduleSummary, "blue");
          notify("课程已更新并重新完成冲突检查");
        } else {
          addAudit("创建排课", scheduleSummary, "green");
          notify(
            isTeacherView
              ? "约课已创建，等待教务确认"
              : kind === "试听" ? "试听排课已创建，准确提醒时间已生成" : "排课已创建",
          );
        }
        const savedOccurrence = bookingOccurrenceByStableKey(booking, `${booking.id}:${booking.date}`);
        if (savedOccurrence) selectBookingRecord(savedOccurrence);
        else selectBookingRecord(booking);
        setBookingDraft(null);
        setBookingPrefillTeacherId(null);
        setModal(null);
        setActive("schedule");
      },
    });
  };

  const clearTeacherAbsencePreview = useCallback(() => {
    teacherAbsencePreviewAbortRef.current?.abort();
    teacherAbsencePreviewAbortRef.current = null;
    teacherAbsencePreviewRequestRef.current += 1;
    setTeacherAbsencePreview(null);
  }, []);

  const previewTeacherAbsence = async (form: HTMLFormElement) => {
    if (operationDraft?.sourceBookingId) return;
    const data = new FormData(form);
    const sourceTeacherId = String(data.get("teacherId") ?? "").trim();
    const eventStart = String(data.get("eventStart") ?? "").trim();
    const eventEnd = String(data.get("eventEnd") ?? "").trim();
    const detail = String(data.get("detail") ?? "").trim();
    const type = String(data.get("type") ?? "老师请假");
    if (!teacherById(sourceTeacherId) || !/^\d{4}-\d{2}-\d{2}$/.test(eventStart) || !/^\d{4}-\d{2}-\d{2}$/.test(eventEnd) || eventStart > eventEnd || !detail) {
      clearTeacherAbsencePreview();
      return;
    }
    const requestId = ++teacherAbsencePreviewRequestRef.current;
    teacherAbsencePreviewAbortRef.current?.abort();
    const controller = new AbortController();
    teacherAbsencePreviewAbortRef.current = controller;
    const departure = type === "老师离职";
    try {
      const response = await fetch(departure ? "/api/operations/departure/create" : "/api/operations/teacher-absence/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(departure
          ? {
              preview: true,
              commandKey: `teacher-departure-create:${crypto.randomUUID()}`,
              sourceTeacherId,
              effectiveDate: eventEnd,
              detail,
              expectedVersions: { bookings: bookingsShared.version, operations: operationsShared.version, students: studentsShared.version, tasks: tasksShared.version, teachers: teachersShared.version },
            }
          : {
              preview: true,
              commandKey: `teacher-absence-create:${crypto.randomUUID()}`,
              sourceTeacherId,
              eventStart,
              eventEnd,
              type,
              detail,
              expectedVersions: { bookings: bookingsShared.version, operations: operationsShared.version, students: studentsShared.version, tasks: tasksShared.version, teachers: teachersShared.version },
            }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { if (requestId === teacherAbsencePreviewRequestRef.current) setTeacherAbsencePreview(null); return; }
      if (requestId === teacherAbsencePreviewRequestRef.current) setTeacherAbsencePreview(body as typeof teacherAbsencePreview extends infer T ? Exclude<T, null> : never);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId === teacherAbsencePreviewRequestRef.current) setTeacherAbsencePreview(null);
    } finally {
      if (teacherAbsencePreviewAbortRef.current === controller) teacherAbsencePreviewAbortRef.current = null;
    }
  };

  const removeLegacyOperationTaskPending = useCallback((intent: string) => {
    legacyOperationTaskCommandKeysRef.current = removeLegacyOperationTaskPendingCommand(
      legacyOperationTaskCommandKeysRef.current.values(),
      intent,
    );
    if (legacyOperationTaskCommandKeysRef.current.size) {
      persistLegacyOperationTaskPendingCommands(
        browserSessionStorage(),
        sessionOperator,
        legacyOperationTaskCommandKeysRef.current.values(),
      );
    } else {
      clearLegacyOperationTaskPendingCommands(browserSessionStorage(), sessionOperator);
    }
  }, [sessionOperator]);

  const submitLegacyOperationTaskCommand = useCallback(async (pending: LegacyOperationTaskPendingCommand, recovering = false) => {
    if (legacyOperationTaskBusyRef.current) return;
    let command: Record<string, unknown>;
    try {
      const parsed = JSON.parse(pending.commandIntent) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("教务异常命令格式无效");
      command = parsed as Record<string, unknown>;
    } catch (error) {
      removeLegacyOperationTaskPending(pending.intent);
      if (!recovering) notify(error instanceof Error ? error.message : "教务异常命令格式无效");
      return;
    }

    legacyOperationTaskBusyRef.current = true;
    try {
      let response: Response;
      try {
        response = await fetch("/api/operations/legacy/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandKey: pending.commandKey, ...command, expectedVersions: pending.expectedVersions }),
        });
      } catch {
        if (!recovering) notify("教务异常结果未知；已保留原命令，刷新后可安全恢复");
        return;
      }
      const rawBody = await response.json().catch(() => null) as unknown;
      const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? rawBody as Record<string, unknown>
        : {};
      const hasAuthoritativeRows = Boolean(body.operationRow && body.taskRow);
      const disposition = legacyOperationTaskPendingDisposition({
        status: response.status,
        committed: body.committed === true,
        receiptOnly: body.receiptOnly === true,
        hasAuthoritativeRows,
      });
      if (!response.ok || body.committed !== true) {
        if (disposition === "clear") removeLegacyOperationTaskPending(pending.intent);
        const message = typeof body.error === "string" ? body.error : "教务异常保存失败；已保留原命令等待恢复";
        if (!recovering || disposition === "clear") notify(message);
        return;
      }
      if (body.receiptOnly === true) {
        removeLegacyOperationTaskPending(pending.intent);
        if (!recovering) notify("教务异常已确认；当前负责范围已变化，未载入业务资料");
        return;
      }
      if (!hasAuthoritativeRows) {
        if (!recovering) notify("教务异常已确认；权威状态行暂不可用，已保留原命令等待恢复");
        return;
      }
      applyOperationsRemote(body.operationRow as RemoteStateRow<Operation[]>);
      applyTasksRemote(body.taskRow as RemoteStateRow<Task[]>);
      removeLegacyOperationTaskPending(pending.intent);
      const operationIds = Array.isArray(body.operationIds) ? body.operationIds : [];
      const affectedStudentIds = Array.isArray(body.affectedStudentIds) ? body.affectedStudentIds : [];
      const operationId = operationIds.find((value): value is string => typeof value === "string");
      const affectedStudentId = affectedStudentIds.find((value): value is string => typeof value === "string" && scopedActiveStudentIds.has(value));
      if (operationId) setSelectedOperationId(operationId);
      if (affectedStudentId) setSelectedStudentId(affectedStudentId);
      if (!recovering) {
        clearTeacherAbsencePreview();
        setOperationDraft(null);
        setModal(null);
        setActive("operations");
        const createdOperationCount = operationIds.length;
        const createdTaskCount = typeof body.generatedTaskCount === "number" ? body.generatedTaskCount : 0;
        notify(body.applied === false
          ? "教务异常已确认，系统没有重复写入"
          : `已原子创建 ${createdOperationCount} 条异常记录与 ${createdTaskCount} 项任务`);
      }
    } finally {
      legacyOperationTaskBusyRef.current = false;
    }
  }, [setActive, setSelectedStudentId, applyOperationsRemote, applyTasksRemote, clearTeacherAbsencePreview, notify, removeLegacyOperationTaskPending, scopedActiveStudentIds]);

  const submitOperation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTeacherView) {
      notify("老师账号不能创建教务异常，请联系负责教务处理");
      return;
    }
    const data = new FormData(event.currentTarget);
    const operationHasSourceBooking = Boolean(operationDraft?.sourceBookingId);
    const submittedStudentId = String(data.get("studentId") ?? "").trim();
    // A lesson-originated operation is scoped to the one displayed occurrence.
    // A teacher absence/departure opened from Operations is intentionally a
    // batch flow and must not inherit whichever student happens to be selected.
    const studentId = submittedStudentId || (operationHasSourceBooking ? selectedStudent.id : "");
    const type = String(data.get("type") ?? "调课") as Operation["type"];
    const detail = String(data.get("detail") ?? "").trim();
    const teacherId = String(data.get("teacherId") ?? "").trim();
    const eventStart = String(data.get("eventStart") ?? "");
    const eventEnd = String(data.get("eventEnd") ?? "");
    const operationRequiresTeacherAndDates = !operationHasSourceBooking || type !== "学生请假";
    if (!detail) return;
    if (operationRequiresTeacherAndDates && (!teacherById(teacherId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(eventStart)
      || !/^\d{4}-\d{2}-\d{2}$/.test(eventEnd)
      || eventStart > eventEnd)) {
      notify("批量老师请假、代课或离职必须填写有效的老师、影响起始日期和影响结束日期");
      return;
    }

    if (type === "老师离职") {
      if (teacherDepartureCreationBusy) return;
      const effectiveDateValue = new Date(`${eventEnd}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventEnd)
        || Number.isNaN(effectiveDateValue.valueOf())
        || effectiveDateValue.toISOString().slice(0, 10) !== eventEnd) {
        notify("请填写有效的离职生效日期");
        return;
      }
      const intent = JSON.stringify([teacherId, eventEnd, detail]);
      if (teacherDepartureCreationRef.current?.intent !== intent) {
        teacherDepartureCreationRef.current = {
          intent,
          commandKey: `teacher-departure-create:${crypto.randomUUID()}`,
        };
      }
      setTeacherDepartureCreationBusy(true);
      try {
        const response = await fetch("/api/operations/departure/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandKey: teacherDepartureCreationRef.current.commandKey,
            sourceTeacherId: teacherId,
            effectiveDate: eventEnd,
            detail,
            expectedVersions: {
              bookings: bookingsShared.version,
              operations: operationsShared.version,
              students: studentsShared.version,
              tasks: tasksShared.version,
              teachers: teachersShared.version,
            },
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.operationRow || !body.taskRow) {
          throw new Error(body.error || "老师离职流程创建失败");
        }
        operationsShared.applyRemote(body.operationRow as RemoteStateRow<Operation[]>);
        tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
        if (Array.isArray(body.operationIds) && typeof body.operationIds[0] === "string") {
          setSelectedOperationId(body.operationIds[0]);
        }
        if (Array.isArray(body.affectedStudentIds) && typeof body.affectedStudentIds[0] === "string" && scopedActiveStudentIds.has(body.affectedStudentIds[0])) {
          setSelectedStudentId(body.affectedStudentIds[0]);
        }
        teacherDepartureCreationRef.current = null;
        setOperationDraft(null);
        setModal(null);
        setActive("operations");
        notify(`已原子创建 ${body.operationIds?.length ?? 0} 条离职记录与 ${body.generatedTaskCount ?? 0} 项交接任务`);
      } catch (error) {
        notify(error instanceof Error ? error.message : "老师离职流程创建失败");
      } finally {
        setTeacherDepartureCreationBusy(false);
      }
      return;
    }

    if (type === "老师请假" || type === "请假" || type === "代课") {
      if (teacherDepartureCreationBusy) return;
      // A lesson-originated teacher action is still the same batch workflow.
      // Its source occurrence narrows the authority window to that displayed
      // occurrence date; it never falls back to local operations/tasks writes.
      const absenceEventStart = operationHasSourceBooking
        ? String(operationDraft?.eventStart ?? eventStart)
        : eventStart;
      const absenceEventEnd = operationHasSourceBooking
        ? String(operationDraft?.eventEnd ?? operationDraft?.eventStart ?? eventEnd)
        : eventEnd;
      if (!teacherById(teacherId) || !/^\d{4}-\d{2}-\d{2}$/.test(absenceEventStart) || !/^\d{4}-\d{2}-\d{2}$/.test(absenceEventEnd) || absenceEventStart > absenceEventEnd) {
        notify("请填写有效的老师和影响日期");
        return;
      }
      const intent = JSON.stringify({
        sourceTeacherId: teacherId,
        eventStart: absenceEventStart,
        eventEnd: absenceEventEnd,
        type,
        detail,
      });
      const currentVersions = {
        bookings: bookingsShared.version,
        operations: operationsShared.version,
        students: studentsShared.version,
        tasks: tasksShared.version,
        teachers: teachersShared.version,
      };
      const recovered = teacherAbsenceCommandKeysRef.current.get(intent);
      const pending = {
        intent,
        commandKey: recovered?.commandKey ?? `teacher-absence-create:${crypto.randomUUID()}`,
        expectedVersions: recovered?.expectedVersions ?? currentVersions,
      } satisfies TeacherAbsencePendingCommand;
      teacherAbsenceCommandKeysRef.current = upsertTeacherAbsencePendingCommand(
        teacherAbsenceCommandKeysRef.current.values(),
        pending,
      );
      persistTeacherAbsencePendingCommands(
        directEnrollmentStorage,
        sessionOperator,
        teacherAbsenceCommandKeysRef.current.values(),
      );
      const removePending = () => {
        teacherAbsenceCommandKeysRef.current = removeTeacherAbsencePendingCommand(
          teacherAbsenceCommandKeysRef.current.values(),
          intent,
        );
        if (teacherAbsenceCommandKeysRef.current.size) {
          persistTeacherAbsencePendingCommands(
            directEnrollmentStorage,
            sessionOperator,
            teacherAbsenceCommandKeysRef.current.values(),
          );
        } else {
          clearTeacherAbsencePendingCommands(directEnrollmentStorage, sessionOperator);
        }
      };
      setTeacherDepartureCreationBusy(true);
      try {
        const response = await fetch("/api/operations/teacher-absence/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandKey: pending.commandKey,
            sourceTeacherId: teacherId,
            eventStart: absenceEventStart,
            eventEnd: absenceEventEnd,
            type,
            detail,
            expectedVersions: pending.expectedVersions,
          }),
        });
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        const pendingDisposition = teacherAbsencePendingDisposition({
          status: response.status,
          committed: body.committed === true,
          hasAuthoritativeRows: Boolean(body.operationRow && body.taskRow),
        });
        if (!response.ok || body.committed !== true) {
          if (pendingDisposition === "clear") removePending();
          throw new Error(typeof body.error === "string" ? body.error : "老师请假流程创建失败");
        }
        // A committed replay may temporarily lack rows visible under today's
        // scope. Keep the exact key/versions so another retry can obtain them;
        // never turn the receipt into an optimistic local write.
        if (!body.operationRow || !body.taskRow) {
          notify("老师请假/代课流程已确认；共享状态行暂不可用，请刷新后安全重试");
          return;
        }
        operationsShared.applyRemote(body.operationRow as RemoteStateRow<Operation[]>);
        tasksShared.applyRemote(body.taskRow as RemoteStateRow<Task[]>);
        if (Array.isArray(body.operationIds) && typeof body.operationIds[0] === "string") setSelectedOperationId(body.operationIds[0]);
        if (Array.isArray(body.affectedStudentIds) && typeof body.affectedStudentIds[0] === "string" && scopedActiveStudentIds.has(body.affectedStudentIds[0])) setSelectedStudentId(body.affectedStudentIds[0]);
        if (pendingDisposition === "clear") removePending();
        clearTeacherAbsencePreview();
        setOperationDraft(null);
        setModal(null);
        setActive("operations");
        const createdOperationCount = Array.isArray(body.operationIds) ? body.operationIds.length : 0;
        const createdTaskCount = typeof body.generatedTaskCount === "number" ? body.generatedTaskCount : 0;
        notify(`已原子创建 ${createdOperationCount} 条请假/代课记录与 ${createdTaskCount} 项任务`);
      } catch (error) { notify(error instanceof Error ? error.message : "老师请假流程创建失败"); }
      finally { setTeacherDepartureCreationBusy(false); }
      return;
    }

    if (!(["学生请假", "停课", "换老师"] as string[]).includes(type)) {
      notify("此类教务异常必须使用对应的原子流程");
      return;
    }
    if (!operationHasSourceBooking) {
      notify("学生请假、停课或换老师必须从具体课次进入");
      return;
    }
    const commandStudentId = String(operationDraft?.studentId ?? studentId).trim();
    const commandTeacherId = String(operationDraft?.teacherId ?? teacherId).trim();
    const commandEventStart = String(operationDraft?.eventStart ?? eventStart).trim();
    const commandEventEnd = String(operationDraft?.eventEnd ?? eventEnd).trim();
    const sourceBookingId = String(operationDraft?.sourceBookingId ?? "").trim();
    if (!scopedActiveStudentIds.has(commandStudentId)) {
      notify("当前身份不能操作该学生，请刷新后从当前范围的活跃学生重新进入");
      return;
    }
    if (!sourceBookingId || !/^\d{4}-\d{2}-\d{2}$/.test(commandEventStart) || !/^\d{4}-\d{2}-\d{2}$/.test(commandEventEnd) || commandEventStart > commandEventEnd) {
      notify("请填写有效的影响起止日期和来源课次");
      return;
    }
    if (type === "换老师" && !teacherById(commandTeacherId)) {
      notify("换老师必须选择当前课次的老师");
      return;
    }
    const intentValue = {
      type,
      detail,
      studentId: commandStudentId,
      ...(commandTeacherId ? { teacherId: commandTeacherId } : {}),
      eventStart: commandEventStart,
      eventEnd: commandEventEnd,
      sourceBookingId,
    };
    const intent = JSON.stringify(intentValue);
    const previous = legacyOperationTaskCommandKeysRef.current.get(intent);
    const pending = previous ?? {
      intent,
      commandIntent: intent,
      commandKey: `operation-task-create:${crypto.randomUUID()}`,
      expectedVersions: {
        bookings: getCurrentBookingsVersion(),
        operations: operationsShared.version,
        students: getCurrentStudentsVersion(),
        tasks: getCurrentTasksVersion(),
        teachers: getCurrentTeachersVersion(),
      },
    } satisfies LegacyOperationTaskPendingCommand;
    legacyOperationTaskCommandKeysRef.current = upsertLegacyOperationTaskPendingCommand(
      legacyOperationTaskCommandKeysRef.current.values(),
      pending,
    );
    persistLegacyOperationTaskPendingCommands(
      directEnrollmentStorage,
      sessionOperator,
      legacyOperationTaskCommandKeysRef.current.values(),
    );
    await submitLegacyOperationTaskCommand(pending);
  };

  useEffect(() => {
    if (legacyOperationTaskRecoveryActorRef.current === sessionOperator) return;
    legacyOperationTaskRecoveryActorRef.current = sessionOperator;
    const pending = readLegacyOperationTaskPendingCommands(browserSessionStorage(), sessionOperator);
    legacyOperationTaskCommandKeysRef.current = pending;
    if (!pending.size) return;
    let cancelled = false;
    void (async () => {
      for (const entry of pending.values()) {
        if (cancelled) return;
        await submitLegacyOperationTaskCommand(entry, true);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionOperator, submitLegacyOperationTaskCommand]);

  const submitRenewalFollowUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renewalDraft || renewalUploadBusy) return;

    const data = new FormData(event.currentTarget);
    const student = studentById(renewalDraft.studentId);
    if (!student) {
      notify("未找到关联学生，未保存本次跟进");
      return;
    }

    const result = String(data.get("result") ?? "已跟进") as RenewalStatus;
    const businessStatus = String(data.get("businessStatus") ?? "not_renewed_active") as RenewalBusinessStatus;
    const note = String(data.get("note") ?? "").trim();
    const renewalDateNote = String(data.get("renewalDateNote") ?? "").trim();
    const attemptedAtInput = String(data.get("attemptedAt") ?? currentDateTimeValueInTimezone(displayPreferences.timezone));
    const attemptedAtParts = attemptedAtInput.match(/^(\d{4}-\d{2}-\d{2})T([0-2]\d:[0-5]\d)$/);
    if (!attemptedAtParts) {
      notify("请选择有效的本次操作时间");
      return;
    }
    const attemptedAt = zonedDateTimeToUtc(attemptedAtParts[1], attemptedAtParts[2], displayPreferences.timezone).toISOString();
    const attachment = data.get("attachment");
    const attachmentTitle = attachment instanceof File && attachment.size > 0
      ? `续课 FU · ${formatFollowUpTime(attemptedAt, displayPreferences)}`
      : "";
    const commandMetadata = [
      renewalDraft.id,
      renewalDraft.studentId,
      renewalDraft.packageId ?? "",
      attemptedAt,
      businessStatus,
      result,
      note,
      renewalDateNote,
      attachment instanceof File ? attachment.name : "",
      attachment instanceof File ? String(attachment.size) : "",
      attachment instanceof File ? String(attachment.lastModified) : "",
      attachment instanceof File ? attachment.type : "",
    ];
    const commandKey = attachment instanceof File && attachment.size > 0
      ? commandKeyForAttachment("renewal", renewalDraft.studentId, attachment, commandMetadata)
      : commandKeyForRenewalFollowUp(renewalDraft.studentId, renewalDraft.id, commandMetadata);
    const expectedVersions = {
      files: filesShared.version,
      renewals: renewalsShared.version,
      students: studentsShared.version,
      tasks: tasksShared.version,
    };

    setRenewalUploadBusy(true);
    try {
      const upload = new FormData();
      upload.set("commandKey", commandKey);
      upload.set("renewalId", renewalDraft.id);
      upload.set("studentId", renewalDraft.studentId);
      if (renewalDraft.packageId) upload.set("packageId", renewalDraft.packageId);
      upload.set("businessStatus", businessStatus);
      upload.set("result", result);
      upload.set("attemptedAt", attemptedAt);
      upload.set("note", note);
      upload.set("renewalDateNote", renewalDateNote);
      upload.set("expectedVersions", JSON.stringify(expectedVersions));
      if (attachment instanceof File && attachment.size > 0) {
        upload.set("fileTitle", attachmentTitle);
        upload.set("attachment", attachment);
      }
      const response = await fetch("/api/renewals/follow-up", { method: "POST", body: upload });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.committed !== true || body.commandKey !== commandKey
        || !body.renewalsRow || !body.studentsRow || !body.filesRow || !body.tasksRow) {
        throw new Error(body.error || "续课跟进保存失败");
      }
      renewalsShared.applyRemote(body.renewalsRow as RemoteStateRow<Renewal[]>);
      studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
      filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
      tasksShared.applyRemote(body.tasksRow as RemoteStateRow<Task[]>);
      clearAttachmentCommandKey("renewal", renewalDraft.studentId);
      clearRenewalFollowUpCommandKey(renewalDraft.studentId, renewalDraft.id);
      addAudit(
        "记录续课跟进",
        `${student.name} · ${renewalDraft.packageName ?? renewalDraft.packageId ?? "未关联课包"} · ${RENEWAL_STATUS_LABELS[businessStatus]} · ${result} · ${formatFollowUpTime(attemptedAt, displayPreferences)}${body.attachment?.file_name ? ` · 已归档截图 ${body.attachment.file_name}` : ""}${note ? ` · ${note}` : ""}`,
        result === "本次未跟进" ? "amber" : businessStatus === "renewed" ? "green" : "blue",
      );
      setModal(null);
      setRenewalDraft(null);
      notify(body.attachment?.file_name ? "跟进结果和聊天截图已保存到学生 FU 档案" : "跟进结果和时间已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "续课跟进保存失败");
    } finally {
      setRenewalUploadBusy(false);
    }
  };

  const closeAccountPasswordReset = () => {
    if (accountPasswordResetBusy) return;
    setModal(null);
    setAccountPasswordResetTarget(null);
    setAccountPasswordResetError("");
    accountPasswordResetCommandRef.current = null;
  };

  const submitAccountPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAdminSession || !accountPasswordResetTarget || accountPasswordResetBusy) return;
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    setAccountPasswordResetError("");
    if (newPassword !== confirmation) {
      setAccountPasswordResetError("两次输入的新密码不一致。");
      return;
    }
    const intent = JSON.stringify([
      accountPasswordResetTarget.accountId,
      accountPasswordResetTarget.expectedCredentialVersion,
      newPassword,
    ]);
    const commandKey = accountPasswordResetCommandRef.current?.intent === intent
      ? accountPasswordResetCommandRef.current.commandKey
      : `account-password:${crypto.randomUUID()}`;
    accountPasswordResetCommandRef.current = { intent, commandKey };
    setAccountPasswordResetBusy(true);
    try {
      const response = await fetch("/api/accounts/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandKey,
          accountId: accountPasswordResetTarget.accountId,
          expectedCredentialVersion: accountPasswordResetTarget.expectedCredentialVersion,
          newPassword,
        }),
      });
      const body = await response.json().catch(() => null) as { error?: string; reset?: boolean } | null;
      if (!response.ok || !body?.reset) {
        setAccountPasswordResetError(body?.error || "密码重置失败，请稍后重试。");
        return;
      }
      const label = accountPasswordResetTarget.label;
      accountPasswordResetCommandRef.current = null;
      setAccountLifecycleRefreshVersion((current) => current + 1);
      setAccountPasswordResetTarget(null);
      setModal(null);
      notify(`${label} 的密码已重置；可在账号页查看并复制，不强制首次登录改密`);
    } catch {
      setAccountPasswordResetError("网络暂时不可用，请保持窗口打开后重试。");
    } finally {
      setAccountPasswordResetBusy(false);
    }
  };

  const submitFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTeacherView) { notify("老师账号只能查看学生资料"); return; }
    const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id).trim();
    if (!scopedActiveStudentIds.has(studentId)) { notify("当前身份只能为当前范围的活跃学生登记资料。"); return; }
    const title = String(data.get("title") ?? "").trim(); if (!title) return;
    const fileType = String(data.get("type") ?? "其他").trim() as FileRecord["type"];
    let requestStarted = false;
    setFileLinkBusy(true);
    try {
      if (fileStorageMode === "upload") {
        const attachment = data.get("attachment");
        if (!(attachment instanceof File) || !attachment.size) throw new Error("请选择需要上传的文件");
        const fuCategory = fileType === "续课 FU"
          ? "renewal_update"
          : fileType === "FU" ? String(data.get("fuCategory") ?? "parent_communication") : "";
        const flow = fileType === "Report 资料" ? "report" : "evidence";
        const upload = new FormData();
        upload.set("commandKey", commandKeyForAttachment(flow, studentId, attachment, [title, fileType, fuCategory, "file-center"]));
        upload.set("studentId", studentId);
        upload.set("file", attachment);
        upload.set("fileTitle", title);
        upload.set("fileType", fileType);
        if (fuCategory) upload.set("fuCategory", fuCategory);
        requestStarted = true;
        const response = await fetch("/api/fu-attachments", { method: "POST", body: upload });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.id || !body.filesRow || !body.studentsRow) {
          throw new Error(body.error || "资料上传失败");
        }
        filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
        studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
        clearAttachmentCommandKey(flow, studentId);
        addAudit("上传学生资料", `${title} · ${studentById(studentId)?.name}`, "green");
        setModal(null);
        notify("文件已安全归档到学生资料");
        return;
      }

      const source = String(data.get("source") ?? "").trim();
      let parsedSource: URL;
      try {
        parsedSource = new URL(source);
      } catch {
        throw new Error("请输入完整的 HTTPS 云盘或腾讯文档链接");
      }
      if (parsedSource.protocol !== "https:") throw new Error("资料链接必须使用 HTTPS");
      const commandKey = commandKeyForFileLink(studentId, [title, fileType, parsedSource.href]);
      const expectedVersions = { files: filesShared.version, students: studentsShared.version };
      requestStarted = true;
      const response = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandKey,
          studentId,
          fileTitle: title,
          fileType,
          source: parsedSource.href,
          expectedVersions,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.committed !== true || body.commandKey !== commandKey || !body.fileRecord) {
        throw new Error(body.error || "资料登记失败");
      }
      if (!body.filesRow || !body.studentsRow) throw new Error("资料已保存但服务器未返回文件和学生权威回执。");
      // Do not construct local records or counters. The dedicated RPC owns
      // both projections and these are the authoritative rows for this actor.
      filesShared.applyRemote(body.filesRow as RemoteStateRow<FileRecord[]>);
      studentsShared.applyRemote(body.studentsRow as RemoteStateRow<Student[]>);
      clearFileLinkCommandKey(studentId);
      addAudit("登记资料链接", `${title} · ${studentById(studentId)?.name}`, "blue");
      setModal(null);
      notify("已在文件索引中登记资料");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "资料保存失败";
      notify(`${detail}${requestStarted ? "；结果未确认时可安全重试，系统会复用同一命令" : ""}`);
    } finally {
      setFileLinkBusy(false);
    }
  };

  const submitTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id).trim();
    if (!scopedActiveStudentIds.has(studentId)) { notify("当前身份只能为当前范围的活跃学生创建消息。"); return; }
    const kind = String(data.get("kind") ?? "内部提醒"); const body = String(data.get("body") ?? "").trim(); if (!body) return;
    const message: Message = { id: id("MSG"), studentId, kind, recipient: String(data.get("recipient") ?? "内部负责人"), body, status: "待人工确认", createdAt: `今天 ${nowLabel()}` };
    try {
      await messagesShared.mutateAndCommit((current) => [message, ...current]);
      setSelectedMessageId(message.id);
      addAudit("创建消息待确认", `${kind} · ${studentById(studentId)?.name}`, "blue");
      setModal(null);
      setActive("messages");
      notify("消息已加入队列，等待人工确认");
    } catch (error) {
      notify(error instanceof Error ? `消息保存失败：${error.message}` : "消息保存失败");
    }
  };

  const operationHasSourceBooking = Boolean(operationDraft?.sourceBookingId);
  const operationFormType = operationDraft?.type ?? (operationHasSourceBooking ? "学生请假" : "老师请假");
  const operationRequiresTeacherAndDates = !operationHasSourceBooking || operationFormType !== "学生请假";
  const operationDialogTitle = operationHasSourceBooking
    ? "处理本节课程"
    : "批量老师请假、代课或离职";
  const sidebarToggleLabel = sidebarCollapsed
    ? (displayPreferences.language === "en-AU" ? "Expand sidebar" : "展开侧栏")
    : (displayPreferences.language === "en-AU" ? "Collapse sidebar" : "收起侧栏");

  return (
    <div ref={interfaceRootRef}
      data-input-method="keyboard"
      onPointerDownCapture={(event) => { if (event.currentTarget.dataset.inputMethod !== "pointer") event.currentTarget.dataset.inputMethod = "pointer"; }}
      onKeyDownCapture={(event) => { if (event.currentTarget.dataset.inputMethod !== "keyboard") event.currentTarget.dataset.inputMethod = "keyboard"; }}
      className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`} data-interface-language={displayPreferences.language} data-text-size={displayPreferences.textSize} data-list-density={displayPreferences.density} data-motion-preference={displayPreferences.motion}>
      <a
        className={`skip-link${skipLinkFocused ? " is-focused" : ""}`}
        href="#main-content"
        onBlur={() => setSkipLinkFocused(false)}
        onFocus={() => setSkipLinkFocused(true)}
        style={skipLinkFocused ? { transform: "translateY(0)" } : undefined}
      >{displayPreferences.language === "en-AU" ? "Skip to main content" : "跳到主要内容"}</a>
      <aside className={`sidebar${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
        <div className="sidebar-header">
          <div className="brand"><span className="brand-mark">吟</span><div><strong>吟领教务</strong></div></div>
          <button className="sidebar-toggle" data-sidebar-toggle type="button" aria-label={sidebarToggleLabel} aria-pressed={sidebarCollapsed} title={sidebarToggleLabel} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>{sidebarCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>
        </div>
        <nav id="primary-navigation" aria-label="主要导航">
          {visibleNavigation.filter((item) => item.group === "work").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" aria-label={item.label} title={item.label} aria-current={active === item.id ? "page" : undefined} key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span>{item.id === "dashboard" && <b>{scopedTasks.filter((task) => task.status !== "done").length}</b>}</button>;
          })}
          {visibleNavigation.filter((item) => item.group === "support").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" aria-label={item.label} title={item.label} aria-current={active === item.id ? "page" : undefined} key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span></button>;
          })}
        </nav>
      </aside>
      <section className="main-stage">
        <header className="topbar">
          <div className="breadcrumb" aria-hidden="true" />
          <div className="top-actions">
            <button className="top-search" type="button" data-global-search-trigger onClick={(event) => openGlobalSearch(event.currentTarget)}><Search size={16} /> {interfaceText.search} <kbd>Cmd K</kbd></button>
            <IconButton label={displayPreferences.language === "en-AU" ? "View reminders" : "查看提醒"} onClick={() => setActive("dashboard")}><ListTodo size={18} /></IconButton>
            {sharedSyncState !== "synced" ? <span
              className={`live-sync ${sharedSyncState}`}
              role={sharedSyncState === "conflict" || sharedSyncState === "error" || sharedSyncState === "offline" ? "alert" : "status"}
              aria-live={sharedSyncState === "conflict" || sharedSyncState === "error" || sharedSyncState === "offline" ? "assertive" : "polite"}
              aria-atomic="true"
              aria-label={sharedSyncMessage}
              title={sharedSyncMessage}
            ><i />{sharedSyncState === "saving" ? interfaceText.syncing : sharedSyncState === "conflict" ? interfaceText.conflict : interfaceText.offline}</span> : null}
            <div className="operator-menu-wrap" ref={operatorMenuRef}>
              <button className="operator" type="button" aria-haspopup="menu" aria-expanded={operatorMenuOpen} onClick={() => setOperatorMenuOpen((open) => !open)}>
                <Avatar initials={isAdminView ? "AD" : currentOperator.slice(0, 2).toUpperCase()} tone={operatorProfile(currentOperator, teacherOperatorNames).tone} />
                <span className="operator-copy"><small>{operatorProfile(currentOperator, teacherOperatorNames).role}</small><strong>{operatorLabel(currentOperator)}</strong></span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {operatorMenuOpen ? <section className="operator-menu" role="menu" aria-label={interfaceText.switchView}>
                <header><span>{interfaceText.switchView}</span></header>
                <div className="operator-menu-list">
                  {operatorOptions.map((operator) => {
                    const profile = operatorProfile(operator, teacherOperatorNames);
                    const selected = operator === currentOperator;
                    return <button className={selected ? "operator-menu-item selected" : "operator-menu-item"} type="button" role="menuitemradio" aria-checked={selected} key={operator} onClick={() => { requestOperatorSwitch(operator); setOperatorMenuOpen(false); }}>
                      <Avatar initials={operator === "Nixon" || operator === DEMO_LIMITED_ADMIN_USER ? "AD" : operator.slice(0, 2).toUpperCase()} tone={profile.tone} />
                      <span className="operator-menu-copy"><strong>{operatorLabel(operator)}</strong><small>{profile.role}</small></span>
                      {selected ? <Check size={15} aria-hidden="true" /> : null}
                    </button>;
                  })}
                </div>
                <footer className="operator-menu-footer">
                  <button className="operator-password" type="button" onClick={() => { setModal("accountPasswordChange"); setOperatorMenuOpen(false); }}><KeyRound size={15} aria-hidden="true" />{displayPreferences.language === "en-AU" ? "Change password" : "修改密码"}</button>
                  <button className="operator-preferences" type="button" onClick={() => { setDisplayPreferencesOpen(true); setOperatorMenuOpen(false); }}><Settings size={15} aria-hidden="true" />{interfaceText.profilePreferences}</button>
                  <button className="operator-logout" type="button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={15} aria-hidden="true" />{logoutBusy ? (displayPreferences.language === "en-AU" ? "Signing out" : "正在退出") : interfaceText.logOut}</button>
                </footer>
              </section> : null}
            </div>
          </div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>{renderView()}</main>
      </section>
      <nav className="mobile-bottom-nav" aria-label="手机主导航">
        {visibleMobileNavigation.map((item) => {
          const Icon = item.icon;
          return <button className={active === item.id ? "active" : ""} type="button" aria-current={active === item.id ? "page" : undefined} key={item.id} onClick={() => navigateMobile(item.id)}><Icon size={21} /><span>{item.id === "students" ? (displayPreferences.language === "en-AU" ? "Students" : "学生") : item.id === "messages" ? (displayPreferences.language === "en-AU" ? "Messages" : "消息") : item.label}</span></button>;
        })}
        <button className={mobileMenuOpen || !visibleMobileNavigation.some((item) => item.id === active) ? "active" : ""} type="button" aria-expanded={mobileMenuOpen} aria-controls="mobile-function-menu" onClick={() => setMobileMenuOpen(true)}><MoreHorizontal size={22} /><span>{displayPreferences.language === "en-AU" ? "More" : "更多"}</span></button>
      </nav>

      {mobileMenuOpen && <div className="mobile-nav-backdrop" role="presentation" onMouseDown={() => setMobileMenuOpen(false)}>
        <section className="mobile-nav-drawer" id="mobile-function-menu" role="dialog" aria-modal="true" aria-label={displayPreferences.language === "en-AU" ? "All functions" : "全部功能"} onMouseDown={(event) => event.stopPropagation()}>
          <header><div><h2>{displayPreferences.language === "en-AU" ? "Where to work" : "去哪里处理工作"}</h2></div><IconButton label={displayPreferences.language === "en-AU" ? "Close menu" : "关闭功能菜单"} onClick={() => setMobileMenuOpen(false)}><X size={19} /></IconButton></header>
          <label className="mobile-operator-picker"><span>{interfaceText.currentView}</span><select value={currentOperator} onChange={(event) => requestOperatorSwitch(event.target.value)} aria-label={displayPreferences.language === "en-AU" ? "Switch current operator" : "切换当前操作人"}>{operatorOptions.map((operator) => <option value={operator} key={operator}>{operatorLabel(operator)} · {operatorProfile(operator, teacherOperatorNames).role}</option>)}</select></label>
          <div className="mobile-nav-grid">
            {visibleNavigation.map((item) => {
              const Icon = item.icon;
              return <button className={active === item.id ? "active" : ""} type="button" aria-label={item.id === "ava-calendar" ? item.label : undefined} aria-current={active === item.id ? "page" : undefined} key={item.id} onClick={() => navigateMobile(item.id)}><Icon size={20} /><span><strong>{item.label}</strong></span><ChevronRight size={16} /></button>;
            })}
          </div>
          <button className="mobile-password-button" type="button" onClick={() => { setModal("accountPasswordChange"); setMobileMenuOpen(false); }}><KeyRound size={18} aria-hidden="true" />{displayPreferences.language === "en-AU" ? "Change password" : "修改密码"}</button>
          <button className="mobile-preferences-button" type="button" onClick={() => { setDisplayPreferencesOpen(true); setMobileMenuOpen(false); }}><Settings size={18} aria-hidden="true" />{interfaceText.profilePreferences}</button>
          <button className="mobile-logout-button" type="button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={18} aria-hidden="true" />{logoutBusy ? (displayPreferences.language === "en-AU" ? "Signing out" : "正在退出") : interfaceText.logOut}</button>
        </section>
      </div>}

      {displayPreferencesOpen && <div className="dialog-backdrop display-preferences-backdrop" role="presentation" onMouseDown={() => setDisplayPreferencesOpen(false)}>
        <section className="dialog display-preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="display-preferences-title" onMouseDown={(event) => event.stopPropagation()}>
          <header className="dialog-header"><div><h2 id="display-preferences-title">{interfaceText.profilePreferences}</h2></div><IconButton label={interfaceText.close} onClick={() => setDisplayPreferencesOpen(false)}><X size={18} /></IconButton></header>
          <div className="display-preferences-grid">
            <label>{interfaceText.language}<select value={displayPreferences.language} onChange={(event) => updateDisplayPreferences({ language: event.target.value as DisplayPreferences["language"] })}><option value="zh-CN">{interfaceText.chinese}</option><option value="en-AU">{interfaceText.english}</option></select></label>
            <label>{interfaceText.timezone}<select value={displayPreferences.timezone} onChange={(event) => updateDisplayPreferences({ timezone: cleanTimezone(event.target.value) })}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{displayPreferences.language === "en-AU" ? option.en : option.zh}</option>)}</select></label>
            <label>{interfaceText.textSize}<select value={displayPreferences.textSize} onChange={(event) => updateDisplayPreferences({ textSize: event.target.value as DisplayPreferences["textSize"] })}><option value="default">{interfaceText.normal}</option><option value="large">{interfaceText.large}</option><option value="extra-large">{interfaceText.extraLarge}</option></select></label>
            <label>{interfaceText.timeFormat}<select value={displayPreferences.timeFormat} onChange={(event) => updateDisplayPreferences({ timeFormat: event.target.value as DisplayPreferences["timeFormat"] })}><option value="24h">24-hour (14:30)</option><option value="12h">12-hour (2:30 pm)</option></select></label>
            <label>{interfaceText.dateFormat}<select value={displayPreferences.dateFormat} onChange={(event) => updateDisplayPreferences({ dateFormat: event.target.value as DisplayPreferences["dateFormat"] })}><option value="dmy">DD/MM/YYYY</option><option value="ymd">YYYY/MM/DD</option></select></label>
            <label>{interfaceText.density}<select value={displayPreferences.density} onChange={(event) => updateDisplayPreferences({ density: event.target.value as DisplayPreferences["density"] })}><option value="comfortable">{interfaceText.comfortable}</option><option value="compact">{interfaceText.compact}</option></select></label>
            <label className="span-2">{interfaceText.motion}<select value={displayPreferences.motion} onChange={(event) => updateDisplayPreferences({ motion: event.target.value as DisplayPreferences["motion"] })}><option value="standard">{interfaceText.standardMotion}</option><option value="reduced">{interfaceText.reducedMotion}</option></select></label>
          </div>
          <footer className="display-preferences-actions"><button className="secondary-button" type="button" onClick={() => updateDisplayPreferences(defaultAccountDisplayPreferences(sessionOperator, initialRole))}>{interfaceText.reset}</button><button className="primary-button" type="button" onClick={() => setDisplayPreferencesOpen(false)}>{interfaceText.close}</button></footer>
        </section>
      </div>}
      {toast && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={17} /><span>{toast.message}</span>{toast.onAction && <button className="toast-action" type="button" onClick={() => { const action = toast.onAction; setToast(null); action?.(); }}>{toast.actionLabel ?? "撤销"}</button>}</div>}

      {confirmRequest && <div className="dialog-backdrop confirm-backdrop" role="presentation" onMouseDown={() => { if (!confirmBusy) setConfirmRequest(null); }}>
        <section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-detail" onMouseDown={(event) => event.stopPropagation()}>
          <header className="dialog-header"><div><h2 id="confirm-title">{confirmRequest.title}</h2></div><IconButton label="取消操作" onClick={() => { if (!confirmBusy) setConfirmRequest(null); }}><X size={18} /></IconButton></header>
          <form onSubmit={(event) => { event.preventDefault(); void confirmRequestedAction(); }}>
            <div className="confirm-body"><p id="confirm-detail">{confirmRequest.detail}</p>{confirmRequest.items?.length ? <ul className="confirm-impact-list">{confirmRequest.items.map((item) => <li key={item}>{item}</li>)}</ul> : null}</div>
            <footer className="confirm-actions"><button className="secondary-button" type="button" disabled={confirmBusy} onClick={() => setConfirmRequest(null)}>取消</button><button className={confirmRequest.tone === "danger" ? "danger-button" : "primary-button"} type="submit" disabled={confirmBusy}>{confirmBusy ? "正在处理…" : confirmRequest.confirmLabel}</button></footer>
          </form>
        </section>
      </div>}

      {globalSearchOpen && <div className="global-search-backdrop" role="presentation" onMouseDown={() => closeGlobalSearch()}>
        <section className="global-search-dialog" role="dialog" aria-modal="true" aria-label="全局搜索" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><h2>快速搜索</h2></div>
            <IconButton label="关闭搜索" onClick={() => closeGlobalSearch()}><X size={18} /></IconButton>
          </header>
          <label className="global-search-input"><span className="visually-hidden">搜索学生、老师或课程</span><Search size={19} aria-hidden="true" /><input data-dialog-autofocus="true" name="global-search" type="search" autoComplete="off" aria-label="搜索学生、老师或课程" value={globalQuery} onChange={(event) => setGlobalQuery(event.target.value)} placeholder="输入学生姓名、老师姓名或课程" /><kbd>Esc</kbd></label>
          {globalQuery.trim() ? <div className="global-result-list">
            {globalResults.length ? globalResults.map((result) => <button type="button" key={`${result.type}-${result.id}`} className="global-result" onClick={result.action}>
              <span className={`global-result-badge ${result.type === "学生" ? "green" : "blue"}`}>{result.type}</span>
              <span><strong>{result.title}</strong><small>{result.detail}</small></span>
              <ChevronRight size={17} />
            </button>) : <EmptyState title="没有找到匹配记录" detail="可以尝试姓名或课程。" />}
          </div> : <div className="global-quick-links">
            <div>
              <button type="button" onClick={() => closeGlobalSearch(() => setActive("students"))}>学生档案</button>
              <button type="button" onClick={() => closeGlobalSearch(() => setActive("schedule"))}>排课中心</button>
              <button type="button" onClick={() => closeGlobalSearch(() => setActive(isTeacherView ? "classroom" : "operations"))}>{isTeacherView ? "网上教室" : "运营队列"}</button>
            </div>
          </div>}
        </section>
      </div>}

      {modal === "student" && <Dialog title="新建学生档案" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudent}>
          <label>学生姓名<input name="name" data-dialog-autofocus="true" placeholder="试听姓名未知可留空" /></label>
          <label>课程 / 年级<input name="course" placeholder="例如 Year 10 English" required /></label>
          <label>学员类型<select name="segment"><option>试听</option><option>已报名</option></select></label>
          <label>当前年级<input name="grade" placeholder="例如 Year 8" /></label>
          <label>负责人<select name="owner" defaultValue={isAdminView ? teamOwnerOptions[0] ?? currentOperator : currentOperator}>{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
          <label>规划老师<select name="planner"><option>待分配</option><option value="Tara">龙老师</option><option>Eileen</option><option>Abby</option></select></label>
          <label>所在地<select name="location"><option value="VIC">VIC</option><option value="NSW">NSW</option><option value="SA">SA</option><option value="QLD">QLD</option><option value="WA">WA</option><option value="CHN">中国</option></select></label>
          <label>学生时区<select name="timezone">{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>LP 类型<select name="lpNeed"><option>试听LP</option><option>新生LP</option><option>老生新LP</option><option>代课LP</option><option>LP修改</option><option>无需LP</option></select></label>
          <label>剩余课时<input name="remainingHours" type="number" step="0.5" placeholder="未导入可留空" /></label>
          <label>家长微信名<input name="guardianWechat" placeholder="例如 Daisy" /></label>
          <label className="span-2">注意事项<textarea name="notes" rows={3} placeholder="特殊安排、Report 或跟进时需要注意的内容" /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><UserPlus size={16} /> 创建档案</button></footer>
        </form>
      </Dialog>}

      {modal === "studentEdit" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title="编辑学生档案" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentEdit}>
          <label>学生姓名<input name="name" data-dialog-autofocus="true" defaultValue={studentModalTargetStudent.name} /></label>
          <label>课程 / 年级<input name="course" defaultValue={studentModalTargetStudent.course} required /></label>
          <label>当前年级<input name="grade" defaultValue={studentModalTargetStudent.grade ?? ""} /></label>
          <label>负责人<select name="owner" defaultValue={studentModalTargetStudent.owner} disabled={!isAdminView}>{!teamOwnerOptions.includes(studentModalTargetStudent.owner) && <option value={studentModalTargetStudent.owner} disabled>{studentModalTargetStudent.owner}（历史负责人）</option>}{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select>{!isAdminView && <small>负责人调整需由管理员处理</small>}</label>
          <label>规划老师<select name="planner" defaultValue={studentModalTargetStudent.planner ?? "待分配"}><option>待分配</option><option value="Tara">龙老师</option><option>Eileen</option><option>Abby</option></select></label>
          <label>所在地<select name="location" defaultValue={studentModalTargetStudent.location ?? "VIC"}><option value="VIC">VIC</option><option value="NSW">NSW</option><option value="SA">SA</option><option value="QLD">QLD</option><option value="WA">WA</option><option value="CHN">中国</option></select></label>
          <label>学生时区<select name="timezone" defaultValue={cleanTimezone(studentModalTargetStudent.timezone)}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>家长微信名<input name="guardianWechat" defaultValue={studentModalTargetStudent.guardianWechat ?? ""} /></label>
          <label className="span-2">注意事项<textarea name="notes" rows={3} defaultValue={studentModalTargetStudent.notes ?? ""} /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存修改</button></footer>
        </form>
      </Dialog>}

      {modal === "studentEvidence" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title="上传沟通或家长反馈" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentEvidence}>
          <label>关联学生<input value={studentModalTargetStudent.name} disabled /></label>
          <label>FU 分类<select name="fuCategory" defaultValue="parent_communication">{FU_ATTACHMENT_CATEGORIES.map((category) => <option value={category} key={category}>{FU_ATTACHMENT_CATEGORY_LABELS[category]}</option>)}</select></label>
          <label className="span-2">记录名称<input name="title" defaultValue="家长沟通记录" required /></label>
          <label className="span-2 upload-field">图片文件<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp" required /><small>支持 PNG、JPG、WebP，最多 4MB。</small></label>
          <footer><button className="secondary-button" type="button" disabled={evidenceUploadBusy} onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit" disabled={evidenceUploadBusy}><FilePlus2 size={16} /> {evidenceUploadBusy ? "正在上传…" : "上传并归档"}</button></footer>
        </form>
      </Dialog>}

      {modal === "studentReport" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title="上传 Report PDF" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentReport}>
          <label>关联学生<input value={`${studentModalTargetStudent.name} · ${studentModalTargetStudent.id}`} disabled /></label>
          <label>资料名称<input name="title" defaultValue={`${studentModalTargetStudent.name} Report`} required /></label>
          <label className="span-2 upload-field">PDF 文件<input name="attachment" type="file" accept="application/pdf" required /><small>仅支持 PDF，最多 4MB。</small></label>
          <footer><button className="secondary-button" type="button" disabled={reportUploadBusy} onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit" disabled={reportUploadBusy}><FilePlus2 size={16} /> {reportUploadBusy ? "正在上传…" : "上传并归档"}</button></footer>
        </form>
      </Dialog>}

      {modal === "studentRecords" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title={`${studentModalTargetStudent.name} · 学生资料`} onClose={() => setModal(null)} wide>
        <StudentRecordsPanel student={studentModalTargetStudent} files={studentModalTargetStudent.importArchived ? readableScopedFiles : scopedFiles} initialSection={studentRecordKind} canAdd={!isTeacherView && studentModalTargetStudent.importArchived !== true} callbacks={{
          onAdd: (section) => addStudentRecord(section),
          onOpenFile: (file) => { if (/^https?:\/\//.test(file.source) || file.source.startsWith("/api/")) window.open(file.source, "_blank", "noopener,noreferrer"); },
          onEditExam: isTeacherView || studentModalTargetStudent.importArchived ? undefined : (exam) => { setExamDraft(exam); openStudentBoundModal("exam", studentModalTargetStudent.id); },
        }} />
      </Dialog>}

      {modal === "studentFollowUp" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title="记录最近跟进" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentFollowUp}><FollowUpForm initialFollowedUpAt={new Date().toISOString()} /><footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存跟进</button></footer></form>
      </Dialog>}

      {modal === "lessonPackage" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title="录入课包与课时" onClose={() => { if (!lessonPackageBusy) setModal(null); }}>
        <LessonPackagePurchaseForm key={`${sessionOperator}:${studentModalTargetStudent.id}`} actor={sessionOperator} studentId={studentModalTargetStudent.id} packages={studentModalTargetStudent.lessonPackages ?? []} existingPackages={(studentModalTargetStudent.lessonPackages ?? []).map((lessonPackage) => ({ value: lessonPackage.id, label: lessonPackage.name }))} subjectOptions={getStudentSubjectOptions({ studentId: studentModalTargetStudent.id, course: studentModalTargetStudent.course, lessonPackages: studentModalTargetStudent.lessonPackages, bookings: readableScopedBookings }).map((value) => ({ value }))} initialSubjectIds={[studentModalTargetStudent.course]} onBusyChange={setLessonPackageBusy} onClose={() => setModal(null)} onSaved={(studentRow) => { if (studentRow) studentsShared.applyRemote(studentRow as RemoteStateRow<Student[]>); setModal(null); notify("课包与购买记录已确认保存"); }} />
      </Dialog>}

      {modal === "exam" && studentModalTargetStudent && studentModalTargetIsValid && <Dialog title={examDraft ? "编辑学生考试" : "记录学生考试"} onClose={() => { if (examSubmissionBusy) return; setExamDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitExam}><ExamForm key={`${studentModalTargetStudent.id}:${examDraft?.id ?? "new"}:${examFormResetToken}`} initialExamId={examDraft?.id} subjectOptions={getStudentSubjectOptions({ studentId: studentModalTargetStudent.id, course: studentModalTargetStudent.course, lessonPackages: studentModalTargetStudent.lessonPackages, bookings: readableScopedBookings, existingSubject: examDraft?.subject }).map((value) => ({ value }))} initialSubject={examDraft?.subject ?? studentModalTargetStudent.course} initialType={examDraft?.examType} initialVariant={examDraft?.examVariant} initialMonth={examDraft?.examMonth ?? new Date().toISOString().slice(0, 7)} initialDate={examDraft?.examDate} initialResultDateOverride={examDraft?.resultDateOverride} initialIncludeRecall={examDraft?.includeRecall} /><footer><button className="secondary-button" type="button" disabled={examSubmissionBusy} onClick={() => { if (examSubmissionBusy) return; setExamDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit" disabled={examSubmissionBusy}><CalendarPlus size={16} /> {examSubmissionBusy ? "保存中…" : "保存考试"}</button></footer></form>
      </Dialog>}

      {modal === "task" && <Dialog title="添加内部任务" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTask}>
          <label className="span-2">任务内容<input name="title" data-dialog-autofocus="true" placeholder="例如确认家长是否收到上课链接" required /></label>
          <label>关联学生<input name="studentId" list="task-student-options" defaultValue={selectedStudent.id} placeholder="输入学生姓名搜索" /><datalist id="task-student-options">{scopedActiveStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          <label>负责人<select name="owner">{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
          <label>截止时间（墨尔本）<input name="dueAt" type="datetime-local" defaultValue={currentDateTimeValueInTimezone("Australia/Melbourne")} required /></label>
          <label>任务分类<select name="category"><option>资料</option><option>试听</option><option>LP</option><option>排课</option><option>课后</option><option>续课</option><option>考试</option><option>请假代课</option><option>薪资</option></select></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Plus size={16} /> 加入队列</button></footer>
        </form>
      </Dialog>}

      {modal === "legacyTaskDeadline" && legacyTaskDeadlineDraft && <Dialog title={legacyTaskDeadlineDraft.dueAt ? "调整待办截止时间" : "补充待办截止时间"} onClose={() => { if (!legacyTaskDeadlineBusy) { setLegacyTaskDeadlineDraft(null); setModal(null); } }}>
        <form className="form-grid" onSubmit={submitLegacyTaskDeadline}>
          <div className="form-notice span-2"><CircleAlert size={16} /> 请输入准确截止时间。</div>
          <label className="span-2">任务<input value={legacyTaskDeadlineDraft.title} disabled /></label>
          <label className="span-2">待办截止时间（墨尔本）<input name="melbourneDateTime" type="datetime-local" data-dialog-autofocus="true" defaultValue={legacyTaskDeadlineDraft.dueAt && Number.isFinite(Date.parse(legacyTaskDeadlineDraft.dueAt)) ? dateTimeValueInTimezone(new Date(legacyTaskDeadlineDraft.dueAt), "Australia/Melbourne") : ""} required /></label>
          <footer><button className="secondary-button" type="button" disabled={legacyTaskDeadlineBusy} onClick={() => { setLegacyTaskDeadlineDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit" disabled={legacyTaskDeadlineBusy}><Clock3 size={16} /> {legacyTaskDeadlineBusy ? "正在保存…" : "保存截止时间"}</button></footer>
        </form>
      </Dialog>}

      {modal === "payrollNew" && <Dialog title="新增老师薪资记录" onClose={() => setModal(null)} wide>
        <form className="form-grid" onSubmit={submitNewPayroll}>
          <label>现有老师<select name="teacherId" defaultValue="" required><option value="">请选择现有老师</option>{[...teachers].sort((a, b) => a.name.localeCompare(b.name)).map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name}</option>)}</select></label>
          <label>薪资月份<input name="month" type="month" defaultValue={activePayrollMonth} required /></label>
          <label>教师类别<input name="section" defaultValue="教师薪资" placeholder="例如 国内教师" /></label>
          <label>币种<select name="currency" defaultValue="AUD"><option value="AUD">澳币</option><option value="CNY">人民币</option></select></label>
          <label>初始课时费<input name="rate" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>银行名称<input name="bankName" placeholder="可稍后补充" /></label>
          <label>银行账户<input name="bankAccount" placeholder="可稍后补充" /></label>
          <label className="span-2">付款说明<textarea name="paymentNote" rows={3} placeholder="费率规则、线下课程或其他说明" /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><UserPlus size={16} /> 添加薪资记录</button></footer>
        </form>
      </Dialog>}

      {modal === "payrollEdit" && payrollDraft && <Dialog title="编辑老师与费率" onClose={() => { setPayrollDraft(null); setPayrollDraftSourceIndex(null); setModal(null); }} wide>
        <form className="form-grid" onSubmit={submitPayrollEdit}>
          <label>薪资显示姓名<input name="teacherName" data-dialog-autofocus="true" defaultValue={teacherById(payrollDraft.teacherId)?.name ?? payrollDraft.teacherName ?? payrollDraft.teacherId} required /></label>
          <label>薪资月份<input name="month" type="month" defaultValue={payrollDraft.month ?? activePayrollMonth} required /></label>
          <label>教师类别<input name="section" defaultValue={payrollDraft.section ?? "教师薪资"} /></label>
          <label>币种<select name="currency" defaultValue={payrollDraft.currency ?? "AUD"}><option value="AUD">澳币</option><option value="CNY">人民币</option></select></label>
          <label>默认课时费<input name="defaultRate" type="number" min="0" step="0.01" defaultValue={payrollDraft.rateRange?.[0] ?? payrollDraft.lines?.[0]?.rate ?? 0} required /></label>
          <label>银行名称<input name="bankName" defaultValue={payrollDraft.bankName ?? ""} /></label>
          <label>银行账户<input name="bankAccount" defaultValue={payrollDraft.bankAccount ?? ""} /></label>
          <label className="span-2">付款说明<textarea name="paymentNote" rows={3} defaultValue={payrollDraft.paymentNote ?? payrollDraft.note} /></label>
          {(payrollDraft.lines?.length ?? 0) > 0 && <div className="span-2 payroll-rate-editor"><header><strong>{payrollDraft.lines?.every((line) => line.evidenceOnly === true) ? "教务宝学生明细" : "学生费率"}</strong><small>{payrollDraft.lines?.every((line) => line.evidenceOnly === true) ? "这些是 over=1 已消课的核对证据；共享/小组课不会按学生数重复计薪，系统以老师总课时 × 默认课时费计算金额。" : "修改后系统会重新计算每位学生小计和老师总额。"}</small></header>{payrollDraft.lines?.map((line, index) => <label className="payroll-rate-row" key={`${line.studentName}-${line.sourceRow ?? index}`}><span><strong>{line.studentName}</strong><small>{line.hours === null ? "课时待核对" : formatHours(line.hours)}</small></span><span>{line.isTrial ? "试听" : "常规课"}</span>{line.evidenceOnly ? <span>来源明细（不分摊）</span> : <input name={`lineRate-${index}`} type="number" min="0" step="0.01" defaultValue={line.rate} aria-label={`${line.studentName} 课时费`} />}</label>)}</div>}
          {payrollDraft.status === "已锁定" && <div className="form-notice span-2"><CircleAlert size={16} /> 当前记录已锁定；修改后将清除锁定并重新核对。</div>}
          <footer><button className="secondary-button" type="button" onClick={() => { setPayrollDraft(null); setPayrollDraftSourceIndex(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存薪资修改</button></footer>
        </form>
      </Dialog>}

      {modal === "lp" && <Dialog title="创建 LP 工作流" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitLp}>
          <label>关联学生<input name="studentId" list="lp-student-options" value={lpDraftStudentId} onChange={(event) => setLpDraftStudentId(event.currentTarget.value.trim())} placeholder="输入学生姓名搜索" aria-describedby="lp-student-selection" /><datalist id="lp-student-options">{readableScopedStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist><small id="lp-student-selection">{lpDraftStudent ? `${lpDraftStudent.name} · ${lpDraftStudent.course}` : "请选择学生"}</small></label>
          {isAdminView && lpDraftType === "试听 LP" && <><label>临时档案规划老师<select key={lpDraftStudentId} name="provisionalPlanner" defaultValue={lpDraftStudent?.planner ?? "Tara"}><option value="Tara">龙老师</option><option>Eileen</option><option>Abby</option></select></label><label className="checkbox-field span-2"><input name="provisional" type="checkbox" /> 暂未有学生姓名，先按科目创建临时档案</label>
          <label>家长微信名<input name="provisionalGuardianWechat" placeholder="临时建档时必填，例如 Daisy" /></label>
          <label>科目 / 课程<input name="provisionalCourse" placeholder="临时建档时必填，例如 Year 9 English" /></label></>}
          <LpWorkflowFields
            key={lpDraftStudentId}
            initialType={lpDraftType}
            initialValues={{ responsibleOperations: lpDraftOwner, planner: lpDraftStudent?.planner === "Tara" || lpDraftStudent?.planner === "Eileen" || lpDraftStudent?.planner === "Abby" ? lpDraftStudent.planner : "Tara", assignedTeacher: lpDraftStudent?.teacher === "待匹配" ? "" : lpDraftStudent?.teacher, subject: lpDraftStudent?.course ?? "", locationTimezone: lpDraftStudent?.timezone ?? "", studentNameKnown: Boolean(lpDraftStudent?.name), studentName: lpDraftStudent?.name ?? "", contactParents: true, trialDurationMinutes: 60 }}
            responsibleOperationsOptions={operationsOwnerFormOptions(lpDraftOwner).map((value) => ({ value }))}
            teacherOptions={recordTeachers.map((teacher) => ({ value: teacher.name, label: teacher.name }))}
            subjectOptions={(lpDraftType === "学生直报（无试听）"
              ? getStudentSubjectOptions({
                studentId: lpDraftStudentId,
                course: lpDraftStudent?.course,
                lessonPackages: lpDraftStudent?.lessonPackages,
                bookings: readableScopedBookings,
              })
              : Array.from(new Set([...courses.map((course) => course.name), ...(lpDraftStudent?.course ? [lpDraftStudent.course] : [])])))
              .map((value) => ({ value }))}
            timezoneOptions={timezoneOptions.map((option) => ({ value: option.id, label: option.label }))}
            plannerOptions={[{ value: "Tara", label: "龙老师" }, { value: "Eileen" }, { value: "Abby" }]}
            coursePackageOptions={(lpDraftStudent?.lessonPackages ?? []).map((lessonPackage) => ({ value: lessonPackage.name }))}
            onTypeChange={setLpDraftType}
          />
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><BookOpen size={16} /> 创建 LP</button></footer>
        </form>
      </Dialog>}

      {modal === "lpRevision" && lpRevisionDraft && <Dialog title="新增 LP 修订版本" onClose={() => { setLpRevisionDraft(null); setModal(null); }} wide>
        <form className="form-grid" onSubmit={submitLpRevision}>
          <details className="span-2" open>
            <summary>核对当前完整字段</summary>
            <div className="payroll-line-list side-note"><LpWorkflowDetails type={lpRevisionDraft.workflowType ?? "试听 LP"} fields={lpRevisionDraft.fields ?? {}} /></div>
          </details>
          <label className="span-2">腾讯文档链接<input name="documentUrl" type="url" data-dialog-autofocus="true" defaultValue={typeof lpRevisionDraft.fields?.documentUrl === "string" ? lpRevisionDraft.fields.documentUrl : ""} required /></label>
          <label className="span-2">修订说明<textarea name="revisionNote" rows={3} required /></label>
          <div className="span-2"><LpRevisionHistory revisions={lpRevisionDraft.revisions ?? []} stageAudit={lpRevisionDraft.stageAudit ?? []} /></div>
          <footer><button className="secondary-button" type="button" onClick={() => { setLpRevisionDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存新版本</button></footer>
        </form>
      </Dialog>}

      {modal === "teacherAvailabilitySubmit" && isTeacherView && currentTeacher && <Dialog title="提交下月 AVA 与可接人数" onClose={() => { teacherAvailabilitySubmissionKey.current = null; setModal(null); }} wide>
        <form className="form-grid" onSubmit={submitTeacherAvailability}>
          <div className="form-notice span-2"><CircleAlert size={16} /> 提交后待审核。</div>
          <label>老师<input value={currentTeacher.name} disabled /></label>
          <label>月份<input name="month" type="month" min={isoDateInTimezone(new Date(), currentTeacher.timezone).slice(0, 7)} defaultValue={shiftScheduleMonth(isoDateInTimezone(new Date(), currentTeacher.timezone).slice(0, 7), 1)} required /></label>
          <label>AVA 时区<select name="timezone" defaultValue={cleanTimezone(currentTeacher.availabilityTimezone ?? currentTeacher.timezone)}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>本月额外可接学生数<input name="additionalStudents" type="number" min="0" max="100" step="1" defaultValue={currentTeacher.newStudentCapacity ?? 0} required /></label>
          <div className="span-2 payroll-rate-editor"><header><strong>每周固定可约时段</strong><small>只勾选本人已经确认的时间；跨天时段请拆开提交。</small></header>{[
            [1, "周一"], [2, "周二"], [3, "周三"], [4, "周四"], [5, "周五"], [6, "周六"], [0, "周日"],
          ].map(([day, label]) => <label className="payroll-rate-row" key={day}><span><input name={`slot-${day}`} type="checkbox" /> <strong>{label}</strong></span><input name={`start-${day}`} type="time" defaultValue="16:00" aria-label={`${label}开始时间`} /><input name={`end-${day}`} type="time" defaultValue="20:00" aria-label={`${label}结束时间`} /></label>)}</div>
          <label className="span-2">补充说明<textarea name="notes" rows={3} maxLength={1000} placeholder="考试周、临时不可用日期或其他需要教务复核的说明" /></label>
          <footer><button className="secondary-button" type="button" disabled={teacherAvailabilitySubmitBusy} onClick={() => { teacherAvailabilitySubmissionKey.current = null; setModal(null); }}>取消</button><button className="primary-button" type="submit" disabled={teacherAvailabilitySubmitBusy}><Send size={16} /> {teacherAvailabilitySubmitBusy ? "正在提交…" : "提交教务审核"}</button></footer>
        </form>
      </Dialog>}

      {modal === "ava" && selectedTeacher && <Dialog title="录入月度 AVA" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitAva}>
          <label className="span-2">老师<select name="teacherId" defaultValue={selectedTeacher.id}>{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name}</option>)}</select></label>
          <label>月份<input name="month" type="month" defaultValue={isoDateInTimezone(new Date(), "Australia/Melbourne").slice(0, 7)} required /></label>
          <label>星期<select name="day" defaultValue="1"><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select></label>
          <label>原始 AVA 时区<select name="timezone" defaultValue={cleanTimezone(selectedTeacher.availabilityTimezone ?? selectedTeacher.timezone)} disabled>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>开始时间<input name="start" type="time" defaultValue="16:00" required /></label>
          <label>结束时间<input name="end" type="time" defaultValue="18:00" required /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Clock3 size={16} /> 保存</button></footer>
        </form>
      </Dialog>}

      {modal === "teacherCapacity" && teacherCapacityDraft && <Dialog title="可接新生数量" onClose={() => { setTeacherCapacityDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitTeacherCapacity}>
          <label>老师<input value={teacherCapacityDraft.name} disabled /></label>
          <label>剩余可接人数<input name="newStudentCapacity" type="number" min="0" step="1" defaultValue={teacherCapacityDraft.newStudentCapacity ?? 0} required /></label>
          <footer><button className="secondary-button" type="button" onClick={() => { setTeacherCapacityDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存</button></footer>
        </form>
      </Dialog>}

      {modal === "booking" && <Dialog title={bookingDraft ? "编辑排课" : "新建排课"} onClose={() => { setBookingDraft(null); setBookingPrefillTeacherId(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitBooking}>
          <label>学生<RecordPicker name="studentId" options={scopedActiveStudents.map((student) => ({ id: student.id, name: student.name, detail: student.course }))} value={bookingFormStudentId} onChange={(studentId) => { const student = studentById(studentId); setBookingFormStudentId(studentId); setBookingFormSubjectId(student?.course ?? ""); }} disabled={Boolean(bookingDraft && !isAdminView)} /></label>
          <label>老师<RecordPicker name="teacherId" options={recordTeachers.map((teacher) => ({ id: teacher.id, name: teacher.name, detail: teacher.subjects.join(" / ") }))} initialValue={isTeacherView ? currentTeacher?.id ?? "" : bookingDraft?.teacherId ?? bookingPrefillTeacherId ?? ""} disabled={isTeacherView || Boolean(bookingDraft && !isAdminView)} /></label>
          <label>教学科目<select name="teacherSubjectId" defaultValue={bookingDraft?.teacherSubjectId ?? ""} required><option value="">必须人工选择</option>{teacherSubjectOptions.map((subject) => <option value={subject} key={subject}>{subject}</option>)}</select><small>必须与所选老师可教科目一致</small></label>
          <label>日期<input name="date" type="date" min={bookingDraft ? undefined : isoDateInTimezone(new Date(), scheduleTimezone)} defaultValue={bookingDraft?.date ?? isoDateInTimezone(new Date(), scheduleTimezone)} required /></label>
          <label>开始时间<input name="start" type="time" defaultValue={bookingDraft?.start ?? "16:00"} required /></label>
          <label>录入时区<select name="timezone" defaultValue={bookingDraft?.timezone ?? scheduleTimezone}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>课程类型<select name="kind" value={bookingFormKind} onChange={(event) => setBookingFormKind(event.target.value as Booking["kind"])}><option>常规课</option><option>试听</option><option>代课</option></select></label>
          <label>课程科目<select name="subjectId" value={bookingFormSubjectId} onChange={(event) => setBookingFormSubjectId(event.target.value)} required><option value="">请选择科目</option>{Array.from(new Set([studentById(bookingFormStudentId)?.course, ...(studentById(bookingFormStudentId)?.lessonPackages ?? []).flatMap((lessonPackage) => lessonPackage.subjectIds)].filter((subject): subject is string => Boolean(subject)))).map((subject) => <option value={subject} key={subject}>{subject}</option>)}</select></label>
          <label>课包<select key={`${bookingFormStudentId}:${bookingFormSubjectId}:${bookingFormKind}`} name="packageId" defaultValue={(studentById(bookingFormStudentId)?.lessonPackages ?? []).some((lessonPackage) => lessonPackage.id === bookingDraft?.packageId && (!bookingFormSubjectId || lessonPackage.subjectIds.includes(bookingFormSubjectId)) && (bookingFormKind === "试听" || getLessonPackageBalance(lessonPackage).remainingHours > 0)) ? bookingDraft?.packageId : ""} required={bookingFormKind !== "试听"}><option value="">{bookingFormKind === "试听" ? "试听可不选课包" : "请选择有余额的课包"}</option>{(studentById(bookingFormStudentId)?.lessonPackages ?? []).filter((lessonPackage) => !bookingFormSubjectId || lessonPackage.subjectIds.includes(bookingFormSubjectId)).map((lessonPackage) => { const balance = getLessonPackageBalance(lessonPackage).remainingHours; return <option value={lessonPackage.id} key={lessonPackage.id} disabled={bookingFormKind !== "试听" && balance <= 0}>{lessonPackage.name} · 剩余 {balance} 小时{bookingFormKind !== "试听" && balance <= 0 ? " · 不可排课" : ""}</option>; })}</select></label>
          <label>课程时长<LessonDurationInput initialValue={bookingDraft?.duration ?? 60} /></label>
          <label>排课频率<select name="frequency" value={bookingFrequency} onChange={(event) => setBookingFrequency(event.target.value as BookingRecurrenceFrequency)}>
            <option value="single">单次</option>
            <option value="daily">每天</option>
            <option value="every_other_day">隔天</option>
            <option value="weekly">每周</option>
            <option value="biweekly">隔周</option>
            <option value="custom">自定义（按间隔天数）</option>
          </select></label>
          {bookingFrequency !== "single" && <label>本轮排课节数<input name="repeatCount" type="number" min="1" max="104" defaultValue={bookingDraft ? bookingDraft.repeatCount : 1} placeholder={bookingDraft?.recurring && bookingDraft.repeatCount == null ? "旧版长期" : "1"} /><small>{bookingDraft?.recurring && bookingDraft.repeatCount == null ? "旧版长期课程可留空，系统继续按旧数据展开" : "重复课程必须填写 1-104 节"}</small></label>}
          {bookingFrequency !== "single" && bookingDraft?.recurring && bookingDraft.repeatCount == null && <label>结束日期（可选）<input name="recurrenceEndDate" type="date" defaultValue={bookingDraft.recurrenceEndDate ?? ""} /><small>旧版长期课程改为非每周频率时，须填写节数或结束日期。</small></label>}
          {bookingFrequency === "custom" && <label>间隔天数<input name="recurrenceIntervalDays" type="number" min="1" max="365" defaultValue={bookingDraft?.recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS} required /><small>自定义仅表示每隔 N 天，不是日期列表（1-365）</small></label>}
          <div className="form-notice span-2"><CircleAlert size={16} /> 重复课程按固定间隔展开，提交前检查冲突。</div>
          <footer><button className="secondary-button" type="button" onClick={() => { setBookingDraft(null); setBookingPrefillTeacherId(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><CalendarPlus size={16} /> {bookingDraft ? "检查修改范围" : "检查创建范围"}</button></footer>
        </form>
      </Dialog>}

      {modal === "bookingOccurrence" && bookingOccurrenceDraft && <Dialog title="仅修改本节课程" onClose={() => { setBookingOccurrenceDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitBookingOccurrence}>
          <label className="span-2">学生<input value={studentById(bookingOccurrenceDraft.studentId)?.name ?? "学生待确认"} disabled /></label>
          <label>日期<input name="date" type="date" defaultValue={bookingOccurrenceDraft.date} required /></label>
          <label>开始时间<input name="start" type="time" defaultValue={bookingOccurrenceDraft.start} required /></label>
          <label>老师<input value={teacherById(bookingOccurrenceDraft.teacherId)?.name ?? bookingOccurrenceDraft.teacherId} readOnly /><small>改老师请使用代课或永久换老师流程</small></label>
          <label>时长<LessonDurationInput initialValue={bookingOccurrenceDraft.duration} /></label>
          <label className="span-2">本节状态<select name="status" defaultValue={bookingOccurrenceDraft.occurrenceStatus}><option value="confirmed">已确认</option><option value="cancelled">取消本节</option></select></label>
          <footer><button className="secondary-button" type="button" onClick={() => { setBookingOccurrenceDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存本节</button></footer>
        </form>
      </Dialog>}

      {modal === "temporaryClassroom" && <Dialog title="立即开临时课堂" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTemporaryClassroom}>
          <label className="span-2">课堂记录<select value={temporaryClassroomRecordLesson ? "recorded" : "direct"} disabled={classroomBusy} onChange={(event) => setTemporaryClassroomRecordLesson(event.target.value === "recorded")}><option value="direct">仅开课堂（不登记课时、不录播）</option><option value="recorded">开课堂并登记课时</option></select></label>
          {temporaryClassroomRecordLesson && <>
          <label>学生<select name="studentId" value={temporaryClassroomStudentId} onChange={(event) => { const student = studentById(event.target.value); setTemporaryClassroomStudentId(event.target.value); setTemporaryClassroomSubjectId(student?.course || student?.lessonPackages?.flatMap((entry) => entry.subjectIds)[0] || ""); }}><option value="">请选择学生</option>{scopedActiveStudents.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</select></label>
          {isTeacherView ? <label>老师<input value={currentTeacher?.name ?? currentOperator} disabled /><input name="teacherId" type="hidden" value={currentTeacher?.id ?? ""} /></label> : <label>老师<select name="teacherId" value={temporaryClassroomTeacherId} onChange={(event) => { setTemporaryClassroomTeacherId(event.target.value); setTemporaryClassroomTeacherSubjectId(""); }}><option value="">请选择老师</option>{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name}</option>)}</select></label>}
          <label>教学科目<select name="teacherSubjectId" value={temporaryClassroomTeacherSubjectId} onChange={(event) => setTemporaryClassroomTeacherSubjectId(event.target.value)}><option value="">请选择科目</option>{Array.from(new Set((teacherById(isTeacherView ? currentTeacher?.id ?? "" : temporaryClassroomTeacherId)?.subjects ?? []).map((subject) => subject.trim()).filter(Boolean))).map((subject) => <option value={subject} key={subject}>{subject}</option>)}</select></label>
          <label>课程科目<select name="subjectId" value={temporaryClassroomSubjectId} onChange={(event) => setTemporaryClassroomSubjectId(event.target.value)}><option value="">请选择科目</option>{Array.from(new Set([studentById(temporaryClassroomStudentId)?.course, ...(studentById(temporaryClassroomStudentId)?.lessonPackages ?? []).flatMap((entry) => entry.subjectIds)].filter((subject): subject is string => Boolean(subject)))).map((subject) => <option value={subject} key={subject}>{subject}</option>)}</select></label>
          <label>课包<select key={`${temporaryClassroomStudentId}:${temporaryClassroomSubjectId}`} name="packageId"><option value="">请选择有余额的课包</option>{(studentById(temporaryClassroomStudentId)?.lessonPackages ?? []).filter((entry) => entry.subjectIds.includes(temporaryClassroomSubjectId)).map((entry) => { const balance = getLessonPackageBalance(entry).remainingHours; return <option value={entry.id} key={entry.id} disabled={balance <= 0}>{entry.name} · 剩余 {balance} 小时{balance <= 0 ? " · 不可开课" : ""}</option>; })}</select></label>
          <label>课程时长<select name="duration" defaultValue="60"><option value="60">60 分钟</option><option value="90">90 分钟</option><option value="120">120 分钟</option></select></label>
          </>}
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit" disabled={classroomBusy}><Video size={16} /> {classroomBusy ? "正在创建…" : "创建并生成链接"}</button></footer>
          {temporaryTestClassroom && <div className="classroom-share-link span-2">
            <label>
              参与者链接
              <input aria-label="参与者链接" value={temporaryTestClassroom.viewerUrl} readOnly />
            </label>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void navigator.clipboard.writeText(temporaryTestClassroom.viewerUrl)
                .then(() => notify("参与者链接已复制"))
                .catch(() => notify("复制失败，请手动选择并复制链接"))}
            ><Copy size={16} /> 复制链接</button>
            <a className="secondary-button" href={temporaryTestClassroom.viewerUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 打开参与者端</a>
          </div>}
        </form>
      </Dialog>}

      {modal === "lessonSettlement" && lessonSettlementDraft && <Dialog title="人工结算本节课程" onClose={() => { if (!lessonSettlementBusy) { setLessonSettlementDraft(null); setLessonSettlementError(""); setModal(null); } }}>
        <form className="form-grid" onSubmit={submitLessonSettlement}>
          <label>课程时间<input value={`${lessonSettlementDraft.date} ${lessonSettlementDraft.start} · ${lessonSettlementDraft.duration} 分钟`} readOnly /></label>
          <label>学生<input value={studentById(lessonSettlementDraft.studentId)?.name ?? lessonSettlementDraft.studentId} readOnly /></label>
          <label>老师<input value={teacherById(lessonSettlementDraft.teacherId)?.name ?? lessonSettlementDraft.teacherId} readOnly /></label>
          <label>实际授课（分钟）<input name="actualMinutes" type="number" min="1" max="360" step="1" defaultValue={lessonSettlementDraft.duration} required /></label>
          <label>学生扣课（分钟）<input name="studentMinutes" type="number" min="1" max="360" step="1" defaultValue={lessonSettlementDraft.duration} required /></label>
          <label>教师计薪（分钟）<input name="teacherMinutes" type="number" min="1" max="360" step="1" defaultValue={lessonSettlementDraft.duration} required /></label>
          <label className="span-2">覆盖原因<textarea name="overrideReason" minLength={8} maxLength={350} rows={4} placeholder="至少 8 个字符；此原因会进入操作审计" required /></label>
          {lessonSettlementError && <div className="form-error span-2" role="alert">{lessonSettlementError}</div>}
          <div className="form-notice span-2"><CircleAlert size={16} /> 按上述分钟数扣课及计薪，原排课时长保留。金额差异须写明依据；已结算课次不能重复调整。</div>
          <footer><button className="secondary-button" type="button" disabled={lessonSettlementBusy} onClick={() => { setLessonSettlementDraft(null); setLessonSettlementError(""); setModal(null); }}>取消</button><button className="primary-button" type="submit" disabled={lessonSettlementBusy}><CheckCircle2 size={16} /> {lessonSettlementBusy ? "正在结算…" : "确认人工结算"}</button></footer>
        </form>
      </Dialog>}

      {modal === "operation" && <Dialog title={operationDialogTitle} onClose={() => { if (teacherDepartureCreationBusy) return; teacherDepartureCreationRef.current = null; clearTeacherAbsencePreview(); setOperationDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitOperation} onBlur={(event) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) void previewTeacherAbsence(event.currentTarget); }}>
          {operationHasSourceBooking ? <label>本节学生<input value={studentById(operationDraft?.studentId ?? selectedStudent.id)?.name ?? "学生待确认"} readOnly /><input type="hidden" name="studentId" value={operationDraft?.studentId ?? selectedStudent.id} /></label> : <div className="form-notice span-2"><CircleAlert size={16} /> 按老师和影响日期处理全部受影响课程。</div>}
          <label>类型<select name="type" value={operationFormType} onChange={(event) => setOperationDraft((current) => ({ ...(current ?? {}), type: event.target.value as Operation["type"] }))}>
            {operationHasSourceBooking ? <><option>学生请假</option><option>老师请假</option><option>代课</option><option>换老师</option></> : <><option>老师请假</option><option>代课</option><option>老师离职</option></>}
          </select></label>
          <label>涉及老师{operationRequiresTeacherAndDates ? "（必填）" : "（单节学生请假可不填）"}<input name="teacherId" list="operation-teacher-options" defaultValue={operationDraft?.teacherId ?? ""} placeholder="从老师清单选择" required={operationRequiresTeacherAndDates} /><datalist id="operation-teacher-options">{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.subjects.join("/")}</option>)}</datalist></label>
          <label>影响起始日期<input name="eventStart" type="date" defaultValue={operationDraft?.eventStart ?? isoDateInTimezone(new Date(), "Australia/Melbourne")} required={operationRequiresTeacherAndDates} /></label>
          <label>影响结束 / 离职日<input name="eventEnd" type="date" defaultValue={operationDraft?.eventEnd ?? shiftIsoDate(isoDateInTimezone(new Date(), "Australia/Melbourne"), 1)} required={operationRequiresTeacherAndDates} /></label>
          <label className="span-2">原因与处理说明<textarea name="detail" rows={4} defaultValue={operationDraft?.detail ?? ""} placeholder="记录请假原因、原时间、可选时间或需要的后续确认" required /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> {operationHasSourceBooking ? "影响范围按当前课次处理。" : "系统会列出受影响课程及可用候选。"}</div>
          {!operationHasSourceBooking && teacherAbsencePreview && <div className="form-notice span-2" role="status"><ClipboardCheck size={16} /> 预览：共 {teacherAbsencePreview.affectedOccurrenceCount} 节课、{teacherAbsencePreview.affectedGroups.length} 名学生。{teacherAbsencePreview.affectedGroups.map((group) => <div key={group.studentId}>{studentById(group.studentId)?.name ?? group.studentId} · {group.subjects.join("、")} · 首节 {new Date(group.firstAffectedAt).toLocaleString("zh-CN", { timeZone: "Australia/Melbourne" })} · 候选 {group.candidateTeacherIds.map((id) => teacherById(id)?.name ?? id).join("、") || "待人工确认"}</div>)}</div>}
          <footer><button className="secondary-button" type="button" disabled={teacherDepartureCreationBusy} onClick={() => { teacherDepartureCreationRef.current = null; clearTeacherAbsencePreview(); setOperationDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit" disabled={teacherDepartureCreationBusy}><ClipboardCheck size={16} /> {teacherDepartureCreationBusy ? "正在创建…" : "记录并生成任务"}</button></footer>
        </form>
      </Dialog>}

      {modal === "renewal" && renewalDraft && <Dialog title="记录续课跟进" onClose={() => { setModal(null); setRenewalDraft(null); }}>
        <form className="form-grid renewal-followup-form" onSubmit={submitRenewalFollowUp}>
          <label>学生<input value={studentById(renewalDraft.studentId)?.name ?? renewalDraft.studentId} disabled /></label>
          <label>课包 / 耗尽科目<input value={`${renewalDraft.packageName ?? renewalDraft.packageId ?? "未关联课包"} · ${renewalDraft.automaticRenewalDateNote ?? "耗尽科目待排课确认"}`} disabled /></label>
          <label>续课状态<select name="businessStatus" defaultValue={renewalDraft.businessStatus ?? normalizeRenewalBusinessStatus(renewalDraft.status)}>{Object.entries(RENEWAL_STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>本次结果<select name="result" defaultValue={renewalDraft.status === "本次未跟进" ? "本次未跟进" : renewalDraft.status === "等待家长" ? "等待家长" : "已跟进"}><option>已跟进</option><option>本次未跟进</option><option>等待家长</option></select></label>
          <label>本次操作时间<input name="attemptedAt" type="datetime-local" defaultValue={currentDateTimeValueInTimezone(displayPreferences.timezone)} required /></label>
          <label>上次成功跟进<input value={formatFollowUpTime(renewalDraft.lastContactedAt, displayPreferences)} disabled /></label>
          <label className="span-2">续课日期备注<input name="renewalDateNote" defaultValue={renewalDraft.renewalDateNote ?? ""} placeholder="不足一节、下一节日期或需续费科目" /></label>
          <label className="span-2">跟进说明<textarea name="note" rows={3} defaultValue={renewalDraft.followUpNote ?? ""} placeholder="例如：已联系家长，等待确认下月课时；或本次电话未接通" /></label>
          <label className="span-2 upload-field">聊天记录截图（可选）<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp" /></label>
          <footer><button className="secondary-button" type="button" disabled={renewalUploadBusy} onClick={() => { setModal(null); setRenewalDraft(null); }}>取消</button><button className="primary-button" type="submit" disabled={renewalUploadBusy}><ClipboardCheck size={16} /> {renewalUploadBusy ? "正在保存…" : "保存跟进记录"}</button></footer>
        </form>
      </Dialog>}

      {modal === "accountPasswordChange" && <Dialog title={displayPreferences.language === "en-AU" ? "Change password" : "修改密码"} onClose={() => setModal(null)}>
        <AccountPasswordForm
          accountLabel={operatorLabel(sessionOperator)}
          accountLogin={sessionOperator}
          onChanged={() => {
            setModal(null);
            notify(displayPreferences.language === "en-AU" ? "Password updated. Other signed-in sessions are now invalid." : "密码已更新，其他旧登录状态已失效");
          }}
          onCancel={() => setModal(null)}
        />
      </Dialog>}

      {modal === "accountPasswordReset" && isAdminSession && accountPasswordResetTarget && <Dialog title={`重置 ${accountPasswordResetTarget.label} 的密码`} onClose={closeAccountPasswordReset}>
        <form className="form-grid account-password-reset-form" onSubmit={submitAccountPasswordReset}>
          <PasswordUsernameContext login={accountPasswordResetTarget.login} />
          <div className="form-notice span-2"><KeyRound size={16} /> 登录账号：{accountPasswordResetTarget.login}。重置后，旧密码和旧登录状态都会失效；新密码可直接用于登录，不强制首次改密。</div>
          <label className="span-2">新密码<input name="newPassword" data-dialog-autofocus="true" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <label className="span-2">再次输入新密码<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <p className="form-footnote span-2">至少 12 个字符，同时包含字母和数字，且不能与账号名称相同。重置后可在账号页逐个查看和复制；系统不会自动发送密码。</p>
          {accountPasswordResetError && <div className="form-error span-2" role="alert">{accountPasswordResetError}</div>}
          <footer><button className="secondary-button" type="button" disabled={accountPasswordResetBusy} onClick={closeAccountPasswordReset}>取消</button><button className="primary-button" type="submit" disabled={accountPasswordResetBusy}><KeyRound size={16} /> {accountPasswordResetBusy ? "正在重置…" : "确认重置"}</button></footer>
        </form>
      </Dialog>}

      {modal === "file" && hasScopedActiveStudentRecords && !isTeacherView && <Dialog title="添加资料" onClose={() => setModal(null)}>
        <form className="form-grid file-storage-form" onSubmit={submitFile}>
          <div className="file-storage-picker span-2" role="group" aria-label="资料保存方式">
            <button className={fileStorageMode === "link" ? "active" : ""} type="button" aria-pressed={fileStorageMode === "link"} onClick={() => setFileStorageMode("link")}><Link2 size={16} /> 云盘 / 腾讯文档链接<span>推荐，不占系统空间</span></button>
            <button className={fileStorageMode === "upload" ? "active" : ""} type="button" aria-pressed={fileStorageMode === "upload"} onClick={() => { setFileStorageMode("upload"); setFileUploadType(studentRecordKind === "fu" ? "FU" : "Report 资料"); }}><FilePlus2 size={16} /> 小文件上传<span>仅 PDF 或图片，最大 4MB</span></button>
          </div>
          <div className="form-notice span-2"><CircleAlert size={16} /> {fileStorageMode === "link" ? "推荐沿用现有腾讯文档、Google Drive 或 OneDrive；系统只保存链接，不复制云盘文件。" : "上传文件会存入系统私有数据库，仅适合小型 Report PDF 或 FU 截图。大型文件请改用云盘链接。"}</div>
          <label>关联学生<input name="studentId" list="file-student-options" defaultValue={selectedStudent.id} placeholder="输入学生姓名搜索" required /><datalist id="file-student-options">{scopedActiveStudents.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</datalist></label>
          {fileStorageMode === "link"
            ? <label>资料类型<select name="type" defaultValue={studentRecordKind === "lp" ? "Learning Plan" : studentRecordKind === "report" ? "Report 资料" : studentRecordKind === "fu" ? "FU" : "资料链接"}><option>Learning Plan</option><option>学校资料</option><option>Report 资料</option><option>成绩单</option><option>FU</option><option>课堂反馈</option><option>续课 FU</option><option>资料链接</option><option>其他</option></select></label>
            : <label>资料类型<select name="type" value={fileUploadType} onChange={(event) => setFileUploadType(event.target.value as typeof fileUploadType)}><option>Report 资料</option><option>FU</option><option>续课 FU</option></select></label>}
          <label className="span-2">资料名称<input name="title" data-dialog-autofocus="true" placeholder="例如 2026 Semester 2 Learning Plan" required maxLength={180} /></label>
          {fileStorageMode === "link"
            ? <label className="span-2">HTTPS 资料链接<input name="source" type="url" inputMode="url" autoComplete="url" placeholder="https://docs.qq.com/..." required maxLength={500} /></label>
            : <>
              {fileUploadType === "FU" && <label className="span-2">FU 分类<select name="fuCategory" defaultValue="parent_communication">{FU_ATTACHMENT_CATEGORIES.filter((category) => category !== "renewal_update").map((category) => <option value={category} key={category}>{FU_ATTACHMENT_CATEGORY_LABELS[category]}</option>)}</select></label>}
              <label className="span-2 upload-field">选择文件<input name="attachment" type="file" accept={fileUploadType === "Report 资料" ? "application/pdf" : "image/png,image/jpeg,image/webp"} required /><small>{fileUploadType === "Report 资料" ? "仅 PDF，最大 4MB" : "仅 PNG、JPG 或 WebP，最大 4MB"}</small></label>
            </>}
          <footer><button className="secondary-button" type="button" disabled={fileLinkBusy} onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit" disabled={fileLinkBusy}><FilePlus2 size={16} /> {fileLinkBusy ? "正在保存…" : fileStorageMode === "link" ? "登记链接" : "上传并归档"}</button></footer>
        </form>
      </Dialog>}

      {modal === "template" && hasScopedActiveStudentRecords && <Dialog title="新建消息待确认" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTemplate}>
          <label>关联学生<input name="studentId" list="message-student-options" defaultValue={selectedStudent.id} placeholder="输入学生姓名搜索" /><datalist id="message-student-options">{scopedActiveStudents.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</datalist></label>
          <label>消息类型<input name="kind" defaultValue="内部提醒" required /></label>
          <label className="span-2">收件对象<input name="recipient" defaultValue="内部负责人" required /></label>
          <label className="span-2">消息正文<textarea name="body" rows={5} placeholder="输入需要人工确认的消息内容" required /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 此操作只创建待确认队列，不会通过企业微信向任何人发送消息。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><MessageSquare size={16} /> 创建待确认消息</button></footer>
        </form>
      </Dialog>}
    </div>
  );
}

function ViewHeading({ eyebrow, showContext = false, title, actions }: { eyebrow: string; showContext?: boolean; title: string; copy?: string; actions?: ReactNode }) {
  const showEyebrow = showContext && eyebrow.trim() !== title.trim();
  return <section className="view-heading"><div>{showEyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h1>{title}</h1></div>{actions ? <div className="heading-actions">{actions}</div> : null}</section>;
}
function Metric({ tone, icon, value, label, onClick }: { tone: Tone; icon: ReactNode; value: string; label: string; detail?: string; onClick?: () => void }) { return <button className={`metric-card ${tone}`} type="button" onClick={onClick}><span className="metric-icon">{icon}</span><span><strong>{value}</strong><b>{label}</b></span><ArrowRight size={17} /></button>; }
function ScheduleList({ bookings, studentById, teacherById, preferences, onOpen, onViewAll }: { bookings: BookingOccurrence[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; preferences: DisplayPreferences; onOpen: (booking: BookingOccurrence) => void; onViewAll: () => void }) {
  const english = preferences.language === "en-AU";
  if (!bookings.length) return <div className="empty-inline"><CalendarDays size={20} /> {english ? "No lessons today" : "今天没有课程"}</div>;
  return <>
    <p className="panel-foot">{english ? "Time zone: " : "时区："}{timezoneLabel(preferences.timezone, preferences.language)}</p>
    <div className="schedule-list">{bookings.slice(0, 6).map((booking) => {
      const instant = bookingInstant(booking);
      return <button className="schedule-row" type="button" key={booking.occurrenceKey} onClick={() => onOpen(booking)}><span className="schedule-time"><strong>{formatClock(instant, preferences.timezone, preferences)}</strong><small>{formatDisplayDate(instant, preferences.timezone, preferences)}</small></span><span className={`schedule-line ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`} /><span className="schedule-copy"><strong>{studentById(booking.studentId)?.name}</strong><small>{teacherById(booking.teacherId)?.name} · {displayTerm(booking.kind, preferences.language)} · {displayTerm(booking.status, preferences.language)}</small></span><ChevronRight size={16} /></button>;
    })}</div>
    {bookings.length > 6 ? <button className="text-button panel-foot" type="button" onClick={onViewAll}>{english ? `View all ${bookings.length} lessons` : `查看全部 ${bookings.length} 节课程`}</button> : null}
  </>;
}
function RiskRow({ tone, title, detail, action }: { tone: Tone; title: string; detail: string; action?: () => void }) {
  const content = <><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{detail}</small></span></>;
  return action
    ? <button className="risk-row" type="button" onClick={action}>{content}<ChevronRight size={15} /></button>
    : <div className="risk-row risk-row-static">{content}</div>;
}
function StudentDetail({ student, tasks, bookings, lpItems, operations, renewals, messages, files, completedLessonItems, completedLessonMonth, teacherById, preferences, taskDeadlineTimeZone, taskTitle, lowHoursThreshold, mobileOpen, readOnly = false, canEditStatus = true, onClose, onRecord, onSchedule, onEdit, onEvidence, onStatus }: { student: Student; tasks: Task[]; bookings: Booking[]; lpItems: LpItem[]; operations: Operation[]; renewals: Renewal[]; messages: Message[]; files: FileRecord[]; completedLessonItems: readonly JiaowubaoCompletedLessonFeedItem[]; completedLessonMonth: string | null; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; preferences: DisplayPreferences; taskDeadlineTimeZone: TaskDeadlineTimeZone; taskTitle: (task: OpsTask) => string; lowHoursThreshold: number; mobileOpen: boolean; readOnly?: boolean; canEditStatus?: boolean; onClose: () => void; onRecord: (section: StudentRecordPanelSection) => void; onSchedule: () => void; onEdit: () => void; onEvidence: () => void; onStatus: (status: Student["status"]) => void }) {
  const english = preferences.language === "en-AU";
  const studentTasks = tasks.filter((task) => task.studentId === student.id && isExecutableOpenTask(task));
  const nextBooking = bookings
    .filter(
      (booking) =>
        booking.studentId === student.id && !isPastBooking(booking),
    )
    .sort(
      (left, right) =>
        bookingInstant(left).getTime() - bookingInstant(right).getTime(),
    )[0];
  const historicalBookings = readOnly
    ? bookings
      .filter((booking) => booking.studentId === student.id)
      .flatMap((booking) => bookingOccurrencesWithinRange(
        booking,
        earliestLessonOccurrenceTargetDate(booking.date, booking.occurrenceOverrides),
        shiftIsoDate(isoDateInTimezone(new Date(), student.timezone), 1),
        true,
      ))
      .filter(isPastBooking)
      .sort((left, right) => bookingInstant(right).getTime() - bookingInstant(left).getTime())
    : [];
  const historicalOperations = readOnly ? operations.filter((operation) => operation.studentId === student.id) : [];
  const historicalRenewals = readOnly ? renewals.filter((renewal) => renewal.studentId === student.id) : [];
  const historicalLpItems = readOnly ? lpItems.filter((item) => item.studentId === student.id) : [];
  const historicalMessages = readOnly ? messages.filter((message) => message.studentId === student.id) : [];
  const lowHours = isActiveStudent(student) && student.remainingHours !== undefined && student.remainingHours < lowHoursThreshold;
  const jwbNeedsReview = student.jwbMatchStatus === "ambiguous";
  const hasNoSafeJwb = student.jwbMatchStatus === "unmatched" || jwbNeedsReview;
  const hasHistoricalJwbSnapshot = student.historicalJwbSnapshot !== undefined;
  const hasActiveLessonPackages = Boolean(student.lessonPackages?.length);
  const hasVerifiedActiveJwbPackages = student.jwbMatchStatus === "matched"
    && (student.packageCoverage === "complete" || student.packageCoverage === "partial")
    && hasActiveLessonPackages;
  const hasNoActiveJwbLedger = hasNoSafeJwb || (hasHistoricalJwbSnapshot && !hasVerifiedActiveJwbPackages);
  const jwbHoursValue = hasNoActiveJwbLedger && hasHistoricalJwbSnapshot
    ? (english ? "Historical evidence pending verification" : "历史待核验")
    : hasNoSafeJwb
      ? jwbNeedsReview
        ? (english ? "Multiple Jiaowubao candidates need review" : "多个教务宝候选待核对")
        : (english ? "No linked Jiaowubao data" : "暂无教务宝资料")
      : student.remainingHours === undefined
        ? (english ? "Pending import" : "待导入")
        : `${student.remainingHours} / ${student.contractHours ?? "?"} ${english ? "hours" : "课时"}`;
  const studentRecordData = buildStudentRecordsPanelData(student, files);
  const studentRecordCounts = {
    lp: studentRecordData.files.lp.length,
    report: studentRecordData.files.report.length,
    fu: studentRecordData.files.fu.length,
    followUp: studentRecordData.followUps.length,
  };
  const completedLessonHours = Number(completedLessonItems.reduce((total, item) => total + (item.hours ?? 0), 0).toFixed(4));
  const completedLessonHoursIncomplete = completedLessonItems.some((item) => item.hours === null) || !Number.isFinite(completedLessonHours);
  const completedLessonHoursExceptional = completedLessonItems.some((item) => item.hoursIssue);
  return <aside className={`student-detail ${mobileOpen ? "mobile-detail-open" : ""}`}>
    <button className="mobile-preview-close" type="button" aria-label={english ? "Close student details" : "关闭学生详情"} onClick={onClose}><ChevronLeft size={20} /> {english ? "Back to students" : "返回学生列表"}</button>
    <div className="detail-top"><Avatar initials={student.initials} tone={readOnly ? "neutral" : statusTone(student.status)} /><div><h2>{student.name}</h2>{readOnly ? <StatusPill tone="neutral">{english ? "Historical archive · read only" : "历史归档 · 只读"}</StatusPill> : <StatusPill tone={statusTone(student.status)}>{displayTerm(student.segment ?? "已报名", preferences.language)} · {displayTerm(student.status, preferences.language)}</StatusPill>}</div></div>
    <div className="student-facts"><span><small>{english ? "Location / timezone" : "所在地 / 时区"}</small><strong>{student.location ?? (english ? "To be confirmed" : "待确认")}</strong><em>{timezoneLabel(student.timezone, preferences.language)}</em></span><span><small>{english ? "Lesson hours" : "课时"}</small><strong className={lowHours && !hasNoActiveJwbLedger ? "low-hours" : ""}>{jwbHoursValue}</strong></span></div>
    {completedLessonMonth && completedLessonItems.length ? <div className="detail-section"><span>{completedLessonMonth} 教务宝已消课（只读核对）</span><strong>{!Number.isFinite(completedLessonHours) ? "课时无法合计，待核对" : completedLessonHoursIncomplete ? `已知 ${formatHours(completedLessonHours)}（课时待核对，总计不完整）` : completedLessonHoursExceptional ? `${formatHours(completedLessonHours)}（含异常来源课时，待核对）` : formatHours(completedLessonHours)} · {completedLessonItems.length} 条学生明细</strong><p>{completedLessonItems.filter((item) => item.isTrial).length ? `含 ${completedLessonItems.filter((item) => item.isTrial).length} 条试听；` : ""}来源为已消课 over=1，不会修改课包余额或学生状态。</p></div> : null}
    <div className="detail-section"><span>{english ? "Course and teacher" : "课程与老师"}</span><strong>{student.course}</strong><p>{student.teacher}</p></div>
    <div className="detail-section student-record-entry-grid"><button type="button" onClick={() => onRecord("lp")}><strong>LP / 学校资料</strong>{studentRecordCounts.lp > 0 ? <span>{studentRecordCounts.lp}</span> : null}</button><button type="button" onClick={() => onRecord("report")}><strong>Report 资料</strong>{studentRecordCounts.report > 0 ? <span>{studentRecordCounts.report}</span> : null}</button><button type="button" onClick={() => onRecord("fu")}><strong>FU</strong>{studentRecordCounts.fu > 0 ? <span>{studentRecordCounts.fu}</span> : null}</button><button type="button" onClick={() => onRecord("followUp")}><strong>最近跟进</strong>{studentRecordCounts.followUp > 0 ? <span>{studentRecordCounts.followUp}</span> : null}</button></div>
    <div className="detail-section split"><button className="inline-link" type="button" onClick={() => onRecord("lessonPackages")}>{readOnly ? "查看课时 / 课包" : "录入课时 / 课包"} {student.lessonPackages?.length ?? 0}</button><button className="inline-link" type="button" onClick={() => onRecord("exams")}>考试 {student.exams?.length ?? (student.examDate || student.examSubject ? 1 : 0)}</button></div>
    {readOnly && <div className="detail-section archive-history-section"><span>{english ? "Historical activity" : "历史业务记录"}</span><div className="archive-history-summary"><strong>{historicalBookings.length} 节课</strong><strong>{historicalOperations.length} 条异常处理</strong><strong>{historicalRenewals.length} 条续课</strong><strong>{historicalLpItems.length} 个 LP</strong><strong>{historicalMessages.length} 条消息</strong></div>{historicalBookings.slice(0, 5).map((booking) => <div className="archive-history-row" key={booking.occurrenceKey}><CalendarDays size={14} /><span><strong>{formatInstant(bookingInstant(booking), student.timezone, preferences)}</strong><small>{teacherById(booking.teacherId)?.name ?? booking.teacherId} · {displayTerm(booking.kind, preferences.language)} · {booking.occurrenceStatus}</small></span></div>)}{historicalOperations.slice(0, 3).map((operation) => <div className="archive-history-row" key={operation.id}><CircleAlert size={14} /><span><strong>{operation.type} · {operation.status}</strong><small>{operation.createdAt} · {operation.detail}</small></span></div>)}{historicalRenewals.slice(0, 2).map((renewal) => <div className="archive-history-row" key={renewal.id}><RefreshCw size={14} /><span><strong>{renewal.packageName ?? "续课记录"} · {renewal.status}</strong><small>{renewal.lastAttemptAt ?? renewal.estimate}</small></span></div>)}</div>}
    {student.notes ? <div className="detail-section"><span>特殊备注</span><strong>{student.notes}</strong></div> : null}
    {canEditStatus && <div className="student-detail-actions"><button className="secondary-button" type="button" onClick={onEdit}><UserCog size={15} /> 编辑档案</button><button className="secondary-button" type="button" onClick={onEvidence}><FilePlus2 size={15} /> 上传沟通/反馈</button></div>}
    {canEditStatus ? <label className="status-select">{english ? "Student status" : "学生状态"}<select value={student.status} onChange={(event) => onStatus(event.target.value as Student["status"])}>{["在读", "不活跃 + 无课时", "活跃 + 无课时", "活跃 + 有课时", "不活跃 + 有课时", "在读 + 加课待排"].map((status) => <option value={status} key={status}>{displayTerm(status, preferences.language)}</option>)}</select></label> : <div className="detail-section"><span>{english ? "Student status" : "学生状态"}</span><strong>{displayTerm(student.status, preferences.language)}</strong></div>}
    {(studentTasks.length > 0 || nextBooking) ? <div className="timeline"><div className="timeline-title"><strong>{english ? "Next steps and timeline" : "下一步与时间线"}</strong>{studentTasks.length > 0 ? <small>{studentTasks.length} {english ? "open tasks" : "项待办"}</small> : null}</div>{studentTasks.slice(0, 3).map((task) => {
      const title = taskTitlePresentation(taskTitle(task), task.ruleKey);
      return <div className="timeline-item" key={task.id}><i className={task.tone} /><span><strong>{title.primary}</strong>{title.details.length > 0 ? <small>{title.details.join(" · ")}</small> : null}<small><time dateTime={task.dueAt}>{formatCompactTaskDeadline(task.dueAt, taskDeadlineTimeZone)}</time></small></span></div>;
    })}{nextBooking && <div className="timeline-item"><i className="green" /><span><strong>{english ? "Next lesson" : "下一节"}: {formatInstant(bookingInstant(nextBooking), student.timezone, preferences)}</strong><small>{teacherById(nextBooking.teacherId)?.name} · {displayTerm(nextBooking.kind, preferences.language)}</small></span></div>}</div> : null}
    {!readOnly && <button className="primary-button full" type="button" onClick={onSchedule}><CalendarPlus size={16} /> {english ? "Schedule a lesson for this student" : "为此学生安排课程"}</button>}
  </aside>;
}
function TimeLine({ label, time, detail }: { label: string; time: string; detail: string }) { return <div className="booking-line"><span>{label}</span><strong>{time}</strong><small>{detail}</small></div>; }
function SummaryCard({ icon, tone, title, text }: { icon: ReactNode; tone: Tone; title: string; text: string }) { return <article><span className={`sync-icon ${tone}`}>{icon}</span><span><strong>{title}</strong><small>{text}</small></span></article>; }
function OwnershipRow({ title, tone, label }: { title: string; detail?: string; tone: Tone; label: string }) { return <div className="ownership-row"><strong>{title}</strong><StatusPill tone={tone}>{label}</StatusPill></div>; }
function ReportCard({ value, label, detail, tone }: { value: string; label: string; detail?: string; tone: Tone }) { return <article className={`report-card ${tone}`}><strong>{value}</strong><span>{label}</span>{detail ? <small>{detail}</small> : null}</article>; }
function DataIssue({ title, count, tone }: { title: string; count: string; tone: Tone }) { return <div className="issue-row"><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{count}</small></span></div>; }

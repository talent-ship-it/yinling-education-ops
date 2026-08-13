const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_ONLY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_HOUR_PRECISION = 1_000_000;

function roundHours(value: number) {
  return Math.round(value * MAX_HOUR_PRECISION) / MAX_HOUR_PRECISION;
}

function requireNonEmpty(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required`);
}

function requirePositiveHours(value: number, field = "hours") {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive number`);
  }
}

function requireDateOnly(value: string, field: string) {
  if (!DATE_ONLY_PATTERN.test(value)) throw new Error(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date`);
  }
}

function requireDateTime(value: string, field: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be a valid date or timestamp`);
}

function sameRecord(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type LpDocumentKind = "lp" | "school_document";

export type LpDocumentLink = {
  id: string;
  kind: LpDocumentKind;
  title: string;
  url: string;
  addedAt: string;
  addedBy?: string;
};

function validateDocumentUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("url must use http or https");
  }
}

/** Adds an immutable LP/school-document version without losing older links. */
export function appendLpDocumentLink(history: readonly LpDocumentLink[], link: LpDocumentLink) {
  requireNonEmpty(link.id, "id");
  requireNonEmpty(link.title, "title");
  validateDocumentUrl(link.url);
  requireDateTime(link.addedAt, "addedAt");

  const existing = history.find((item) => item.id === link.id);
  if (existing) {
    if (!sameRecord(existing, link)) throw new Error(`LP document id ${link.id} already exists`);
    return [...history];
  }
  return [...history, { ...link }];
}

export function sortLpDocumentHistory(history: readonly LpDocumentLink[]) {
  return [...history].sort((left, right) => {
    const byDate = Date.parse(right.addedAt) - Date.parse(left.addedAt);
    return byDate || right.id.localeCompare(left.id);
  });
}

export function getLatestLpDocumentLink(history: readonly LpDocumentLink[]) {
  return sortLpDocumentHistory(history)[0] ?? null;
}

export const MAX_REPORT_PDF_BYTES = 4 * 1024 * 1024;

export type ReportPdfMetadata = {
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type ReportPdfValidationError = "empty_name" | "invalid_mime" | "invalid_size" | "file_too_large";

export type ReportPdfValidation =
  | { valid: true; errors: [] }
  | { valid: false; errors: ReportPdfValidationError[] };

export function validateReportPdfMetadata(metadata: ReportPdfMetadata): ReportPdfValidation {
  const errors: ReportPdfValidationError[] = [];
  if (!metadata.name.trim()) errors.push("empty_name");
  if (metadata.mimeType.trim().toLowerCase() !== "application/pdf") errors.push("invalid_mime");
  if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes <= 0) {
    errors.push("invalid_size");
  } else if (metadata.sizeBytes > MAX_REPORT_PDF_BYTES) {
    errors.push("file_too_large");
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}

export const FU_ATTACHMENT_CATEGORIES = [
  "renewal_update",
  "parent_communication",
  "teacher_feedback",
  "complaint",
  "other",
] as const;

export type FuAttachmentCategory = (typeof FU_ATTACHMENT_CATEGORIES)[number];

export const FU_ATTACHMENT_CATEGORY_LABELS: Record<FuAttachmentCategory, string> = {
  renewal_update: "续费前更新",
  parent_communication: "家长沟通",
  teacher_feedback: "老师反馈",
  complaint: "差评或投诉",
  other: "其他",
};

export function isFuAttachmentCategory(value: unknown): value is FuAttachmentCategory {
  return typeof value === "string" && (FU_ATTACHMENT_CATEGORIES as readonly string[]).includes(value);
}

export type StudentFollowUp = {
  id: string;
  followedUpAt: string;
  note?: string;
  recordedBy?: string;
};

export function appendStudentFollowUp(history: readonly StudentFollowUp[], followUp: StudentFollowUp) {
  requireNonEmpty(followUp.id, "id");
  requireDateTime(followUp.followedUpAt, "followedUpAt");
  const existing = history.find((item) => item.id === followUp.id);
  if (existing) {
    if (!sameRecord(existing, followUp)) throw new Error(`follow-up id ${followUp.id} already exists`);
    return [...history];
  }
  return [...history, { ...followUp }];
}

export function sortStudentFollowUpHistory(history: readonly StudentFollowUp[]) {
  return [...history].sort((left, right) => {
    const byDate = Date.parse(right.followedUpAt) - Date.parse(left.followedUpAt);
    return byDate || right.id.localeCompare(left.id);
  });
}

export function getLatestStudentFollowUp(history: readonly StudentFollowUp[]) {
  return sortStudentFollowUpHistory(history)[0] ?? null;
}

/**
 * Kept as the four values already stored by the current form. More specific
 * exam behaviour belongs in `examVariant`, so old records and UI consumers do
 * not need a destructive type migration.
 */
export const LEGACY_EXAM_TYPES = ["scholarship", "selective", "aeas", "other"] as const;
export type ExamType = (typeof LEGACY_EXAM_TYPES)[number];

export const EXAM_VARIANTS = [
  "scholarship",
  "selective",
  "oc",
  "mgs",
  "gate",
  "jmss",
  "aeas",
  "school_interview",
  "australian_university_final",
  "australian_university_assignment",
  "vce",
  "wace",
  "hsc",
  "qce",
  "sace",
  "icas",
  "amc",
  "ielts_paper",
  "ielts_computer",
  "pte",
  "ccl",
  "other",
] as const;

export type ExamVariant = (typeof EXAM_VARIANTS)[number];
export type ExamTaskKind = "exam_care" | "exam_recall" | "exam_results_follow_up";

export const EXAM_FOLLOW_UP_STATUSES = ["pending", "completed", "not_required"] as const;
export type ExamFollowUpStatus = (typeof EXAM_FOLLOW_UP_STATUSES)[number];

export type ExamFollowUpStepState =
  | Readonly<{ status: "pending" | "not_required"; completedAt?: never; completedBy?: never }>
  | Readonly<{ status: "completed"; completedAt: string; completedBy?: string }>;

export type ExamFollowUpState = Readonly<Partial<Record<ExamTaskKind, ExamFollowUpStepState>>>;

export type StudentExamRecord = {
  id: string;
  subject: string;
  examType: ExamType;
  /** Canonical rule selector. Omitted legacy records fall back to examType. */
  examVariant?: ExamVariant;
  examMonth: string;
  examDate?: string;
  /** Per-exam exact date supplied by operations when a result date is known. */
  resultDateOverride?: string;
  /** Whether the operations team should collect an exam recall. Legacy records default to true. */
  includeRecall?: boolean;
  /** Durable completion state that can later be derived from linked Tasks. */
  followUpState?: ExamFollowUpState;
};

function validateExam(record: StudentExamRecord) {
  if (!MONTH_ONLY_PATTERN.test(record.examMonth)) throw new Error("examMonth must use YYYY-MM");
  if (record.includeRecall !== undefined && typeof record.includeRecall !== "boolean") {
    throw new Error("includeRecall must be a boolean");
  }
  if (record.examVariant && !(EXAM_VARIANTS as readonly string[]).includes(record.examVariant)) {
    throw new Error("examVariant is not supported");
  }
  if (record.examDate) {
    requireDateOnly(record.examDate, "examDate");
    if (!record.examDate.startsWith(`${record.examMonth}-`)) {
      throw new Error("examDate must be within examMonth");
    }
  }
  if (record.resultDateOverride) requireDateOnly(record.resultDateOverride, "resultDateOverride");
  Object.entries(record.followUpState ?? {}).forEach(([kind, state]) => {
    if (!["exam_care", "exam_recall", "exam_results_follow_up"].includes(kind)) {
      throw new Error(`unsupported exam follow-up kind ${kind}`);
    }
    if (!state || !(EXAM_FOLLOW_UP_STATUSES as readonly string[]).includes(state.status)) {
      throw new Error(`invalid exam follow-up status for ${kind}`);
    }
    if (state.status === "completed") requireDateTime(state.completedAt, `${kind}.completedAt`);
  });
}

/** Replaces or removes one durable follow-up step without mutating the record. */
export function setExamFollowUpStepState(
  record: StudentExamRecord,
  kind: ExamTaskKind,
  state?: ExamFollowUpStepState,
): StudentExamRecord {
  validateExam(record);
  const followUpState: Partial<Record<ExamTaskKind, ExamFollowUpStepState>> = {
    ...(record.followUpState ?? {}),
  };
  if (state) followUpState[kind] = state;
  else delete followUpState[kind];
  const next = {
    ...record,
    followUpState: Object.keys(followUpState).length ? followUpState : undefined,
  };
  validateExam(next);
  return next;
}

export function compareStudentExams(left: StudentExamRecord, right: StudentExamRecord) {
  validateExam(left);
  validateExam(right);
  const byMonth = left.examMonth.localeCompare(right.examMonth);
  if (byMonth) return byMonth;
  if (!left.examDate && right.examDate) return -1;
  if (left.examDate && !right.examDate) return 1;
  const byDate = (left.examDate ?? "").localeCompare(right.examDate ?? "");
  return byDate || left.id.localeCompare(right.id);
}

export function sortStudentExams(records: readonly StudentExamRecord[]) {
  return [...records].sort(compareStudentExams);
}

export function addCalendarDays(dateOnly: string, days: number) {
  requireDateOnly(dateOnly, "date");
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new RangeError("days must be a non-negative integer");
  }
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Adds whole calendar months and clamps to the target month's final day. */
export function addCalendarMonths(dateOnly: string, months: number) {
  requireDateOnly(dateOnly, "date");
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new RangeError("months must be a non-negative integer");
  }
  const [year, month, day] = dateOnly.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastTargetDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastTargetDay));
  return target.toISOString().slice(0, 10);
}

/** Counts Monday-Friday only. Public holidays are deliberately not inferred. */
export function addWeekdays(dateOnly: string, weekdays: number) {
  requireDateOnly(dateOnly, "date");
  if (!Number.isSafeInteger(weekdays) || weekdays < 0) {
    throw new RangeError("weekdays must be a non-negative integer");
  }
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  let remaining = weekdays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

export type ExamResultDateRule = Readonly<
  | { kind: "calendar_days"; days: number }
  | { kind: "weekdays"; days: number }
  | { kind: "calendar_months"; months: number }
  | { kind: "fixed_date"; date: string }
  | { kind: "explicit_date_required" }
>;

const CALENDAR_DAYS_30 = Object.freeze({ kind: "calendar_days", days: 30 } as const);
const CALENDAR_MONTHS_2 = Object.freeze({ kind: "calendar_months", months: 2 } as const);
const EXPLICIT_DATE_REQUIRED = Object.freeze({ kind: "explicit_date_required" } as const);

/**
 * Default estimates from the operations specification. State exam result dates
 * and `other` deliberately require an explicit current-year date: historical
 * dates such as the document's 2025 examples must never become permanent rules.
 */
export const DEFAULT_EXAM_RESULT_DATE_RULES: Readonly<Record<ExamVariant, ExamResultDateRule>> = Object.freeze({
  scholarship: CALENDAR_DAYS_30,
  selective: CALENDAR_DAYS_30,
  oc: CALENDAR_DAYS_30,
  mgs: CALENDAR_DAYS_30,
  gate: CALENDAR_DAYS_30,
  jmss: CALENDAR_DAYS_30,
  aeas: Object.freeze({ kind: "weekdays", days: 10 }),
  school_interview: Object.freeze({ kind: "calendar_days", days: 3 }),
  australian_university_final: Object.freeze({ kind: "calendar_months", months: 1 }),
  australian_university_assignment: Object.freeze({ kind: "calendar_days", days: 14 }),
  vce: EXPLICIT_DATE_REQUIRED,
  wace: EXPLICIT_DATE_REQUIRED,
  hsc: EXPLICIT_DATE_REQUIRED,
  qce: EXPLICIT_DATE_REQUIRED,
  sace: EXPLICIT_DATE_REQUIRED,
  icas: CALENDAR_MONTHS_2,
  amc: CALENDAR_MONTHS_2,
  ielts_paper: Object.freeze({ kind: "weekdays", days: 10 }),
  ielts_computer: Object.freeze({ kind: "calendar_days", days: 3 }),
  pte: Object.freeze({ kind: "calendar_days", days: 1 }),
  ccl: Object.freeze({ kind: "calendar_days", days: 28 }),
  other: EXPLICIT_DATE_REQUIRED,
});

export type ExamResultDateConfig = Readonly<{
  /** Highest-precedence one-off override for the current calculation. */
  resultDateOverride?: string;
  /** Current, externally maintained fixed dates, commonly for state exams. */
  fixedResultDates?: Readonly<Partial<Record<ExamVariant, string>>>;
  /** Allows a deployment to replace an approximate default without code edits. */
  ruleOverrides?: Readonly<Partial<Record<ExamVariant, ExamResultDateRule>>>;
}>;

export function resolveExamVariant(record: Pick<StudentExamRecord, "examType" | "examVariant">): ExamVariant {
  return record.examVariant ?? record.examType;
}

export function resolveExamResultDateRule(
  record: StudentExamRecord,
  config: ExamResultDateConfig = {},
): ExamResultDateRule {
  validateExam(record);
  const variant = resolveExamVariant(record);
  const exactDate = config.resultDateOverride ?? record.resultDateOverride ?? config.fixedResultDates?.[variant];
  if (exactDate) {
    requireDateOnly(exactDate, "resultDateOverride");
    return { kind: "fixed_date", date: exactDate };
  }
  return config.ruleOverrides?.[variant] ?? DEFAULT_EXAM_RESULT_DATE_RULES[variant];
}

/** Applies a result-date rule without reading the clock or external state. */
export function applyExamResultDateRule(examDate: string, rule: ExamResultDateRule): string | null {
  requireDateOnly(examDate, "examDate");
  if (rule.kind === "explicit_date_required") return null;
  if (rule.kind === "fixed_date") {
    requireDateOnly(rule.date, "fixed result date");
    return rule.date;
  }
  if (rule.kind === "calendar_days") return addCalendarDays(examDate, rule.days);
  if (rule.kind === "weekdays") return addWeekdays(examDate, rule.days);
  return addCalendarMonths(examDate, rule.months);
}

export function estimateExamResultDate(record: StudentExamRecord, config: ExamResultDateConfig = {}) {
  validateExam(record);
  if (!record.examDate) return null;
  return applyExamResultDateRule(record.examDate, resolveExamResultDateRule(record, config));
}

export type ExamTaskAssigneeRole = "academic_coordinator" | "course_planner";

export type ExamTaskDefinition = {
  key: string;
  examId: string;
  kind: ExamTaskKind;
  title: string;
  dueDate: string;
  assigneeRole: ExamTaskAssigneeRole;
  completionStatus: ExamFollowUpStatus;
  completedAt?: string;
  completedBy?: string;
};

export type ExamTaskOptions = ExamResultDateConfig & {
  includeRecall?: boolean;
  /** Legacy call-site override retained for compatibility. */
  resultDate?: string;
};

function followUpFields(record: StudentExamRecord, kind: ExamTaskKind) {
  const state = record.followUpState?.[kind];
  if (!state) return { completionStatus: "pending" as const };
  return state.status === "completed"
    ? { completionStatus: state.status, completedAt: state.completedAt, completedBy: state.completedBy }
    : { completionStatus: state.status };
}

export function buildExamTaskDefinitions(record: StudentExamRecord, options: ExamTaskOptions = {}) {
  validateExam(record);
  if (!record.examDate) return [];
  const includeRecall = options.includeRecall ?? record.includeRecall ?? true;
  const tasks: ExamTaskDefinition[] = [{
    key: `exam:${record.id}:care`,
    examId: record.id,
    kind: "exam_care",
    title: `${record.subject}考试当天关心`,
    dueDate: record.examDate,
    assigneeRole: "academic_coordinator",
    ...followUpFields(record, "exam_care"),
  }];
  if (includeRecall) {
    tasks.push({
      key: `exam:${record.id}:recall`,
      examId: record.id,
      kind: "exam_recall",
      title: `${record.subject}考试回忆`,
      dueDate: record.examDate,
      assigneeRole: "academic_coordinator",
      ...followUpFields(record, "exam_recall"),
    });
  }
  const resultDate = options.resultDate ?? estimateExamResultDate(record, options);
  if (resultDate) {
    requireDateOnly(resultDate, "resultDate");
    tasks.push({
      key: `exam:${record.id}:results`,
      examId: record.id,
      kind: "exam_results_follow_up",
      title: `${record.subject}出分关心`,
      dueDate: resultDate,
      assigneeRole: "course_planner",
      ...followUpFields(record, "exam_results_follow_up"),
    });
  }
  return tasks;
}

export type ExamFollowUpStatuses = Readonly<Record<ExamTaskKind, ExamFollowUpStatus>>;

/** Derives filter-ready completion values from scheduled definitions plus saved state. */
export function deriveExamFollowUpStatuses(
  record: StudentExamRecord,
  options: ExamTaskOptions = {},
): ExamFollowUpStatuses {
  const scheduled = new Set(buildExamTaskDefinitions(record, options).map((task) => task.kind));
  const statusFor = (kind: ExamTaskKind): ExamFollowUpStatus => scheduled.has(kind)
    ? record.followUpState?.[kind]?.status ?? "pending"
    : "not_required";
  return {
    exam_care: statusFor("exam_care"),
    exam_recall: statusFor("exam_recall"),
    exam_results_follow_up: statusFor("exam_results_follow_up"),
  };
}

export type LessonPackagePurchase = {
  id: string;
  purchasedAt: string;
  hours: number;
  note?: string;
};

export type StudentLessonPackage = {
  id: string;
  name: string;
  subjectIds: string[];
  purchaseRecords: LessonPackagePurchase[];
  consumedHours: number;
};

export type LessonPackageBalance = {
  totalHours: number;
  consumedHours: number;
  remainingHours: number;
};

function validatePurchase(purchase: LessonPackagePurchase) {
  requireNonEmpty(purchase.id, "purchase id");
  requireDateTime(purchase.purchasedAt, "purchasedAt");
  requirePositiveHours(purchase.hours, "purchase hours");
}

function validateLessonPackage(lessonPackage: StudentLessonPackage) {
  requireNonEmpty(lessonPackage.id, "package id");
  requireNonEmpty(lessonPackage.name, "package name");
  if (new Set(lessonPackage.subjectIds).size !== lessonPackage.subjectIds.length) {
    throw new Error("package subjects must be unique");
  }
  lessonPackage.subjectIds.forEach((subjectId) => requireNonEmpty(subjectId, "subject id"));
  lessonPackage.purchaseRecords.forEach(validatePurchase);
  if (!Number.isFinite(lessonPackage.consumedHours) || lessonPackage.consumedHours < 0) {
    throw new RangeError("consumedHours must be a non-negative number");
  }
  const total = lessonPackage.purchaseRecords.reduce((sum, purchase) => sum + purchase.hours, 0);
  if (roundHours(lessonPackage.consumedHours) > roundHours(total)) {
    throw new RangeError("consumedHours cannot exceed purchased hours");
  }
}

export function createStudentLessonPackage(input: {
  id: string;
  name: string;
  subjectIds: readonly string[];
  initialPurchase: LessonPackagePurchase;
}): StudentLessonPackage {
  const lessonPackage = {
    id: input.id,
    name: input.name,
    subjectIds: [...input.subjectIds],
    purchaseRecords: [{ ...input.initialPurchase }],
    consumedHours: 0,
  };
  validateLessonPackage(lessonPackage);
  return lessonPackage;
}

export function getLessonPackageBalance(lessonPackage: StudentLessonPackage): LessonPackageBalance {
  validateLessonPackage(lessonPackage);
  const totalHours = roundHours(lessonPackage.purchaseRecords.reduce((sum, purchase) => sum + purchase.hours, 0));
  const consumedHours = roundHours(lessonPackage.consumedHours);
  return { totalHours, consumedHours, remainingHours: roundHours(totalHours - consumedHours) };
}

/** Assigns a subject to one package, removing any older binding to another package. */
export function bindSubjectToLessonPackage(
  packages: readonly StudentLessonPackage[],
  packageId: string,
  subjectId: string,
) {
  requireNonEmpty(subjectId, "subject id");
  if (!packages.some((lessonPackage) => lessonPackage.id === packageId)) {
    throw new Error(`lesson package ${packageId} was not found`);
  }
  const existingBinding = packages.find(
    (lessonPackage) => lessonPackage.id !== packageId && lessonPackage.subjectIds.includes(subjectId),
  );
  if (existingBinding && getLessonPackageBalance(existingBinding).remainingHours > 0) {
    throw new Error(`subject ${subjectId} still has remaining hours in lesson package ${existingBinding.id}`);
  }
  return packages.map((lessonPackage) => {
    validateLessonPackage(lessonPackage);
    const subjectIds = lessonPackage.subjectIds.filter((id) => id !== subjectId);
    if (lessonPackage.id === packageId) subjectIds.push(subjectId);
    return {
      ...lessonPackage,
      subjectIds,
      purchaseRecords: lessonPackage.purchaseRecords.map((record) => ({ ...record })),
    };
  });
}

export function getLessonPackageForSubject(
  packages: readonly StudentLessonPackage[],
  subjectId: string,
) {
  const matches = packages.filter((lessonPackage) => lessonPackage.subjectIds.includes(subjectId));
  if (matches.length > 1) throw new Error(`subject ${subjectId} is bound to multiple lesson packages`);
  return matches[0] ?? null;
}

/** Adds a purchase record and is safe to retry with the same record id and payload. */
export function addLessonPackageHours(lessonPackage: StudentLessonPackage, purchase: LessonPackagePurchase) {
  validateLessonPackage(lessonPackage);
  validatePurchase(purchase);
  const existing = lessonPackage.purchaseRecords.find((record) => record.id === purchase.id);
  if (existing) {
    if (!sameRecord(existing, purchase)) throw new Error(`purchase id ${purchase.id} already exists`);
    return { ...lessonPackage, subjectIds: [...lessonPackage.subjectIds], purchaseRecords: [...lessonPackage.purchaseRecords] };
  }
  return {
    ...lessonPackage,
    subjectIds: [...lessonPackage.subjectIds],
    purchaseRecords: [...lessonPackage.purchaseRecords, { ...purchase }],
  };
}

export type LessonHourDeduction = {
  id: string;
  kind: "deduction";
  lessonId: string;
  packageId: string;
  subjectId: string;
  hours: number;
  occurredAt: string;
};

export type LessonHourReversal = {
  id: string;
  kind: "reversal";
  lessonId: string;
  packageId: string;
  subjectId: string;
  hours: number;
  occurredAt: string;
  reversesEntryId: string;
};

export type LessonHourLedgerEntry = LessonHourDeduction | LessonHourReversal;

export type LessonCompletionInput = {
  entryId: string;
  lessonId: string;
  packageId: string;
  subjectId: string;
  hours: number;
  completedAt: string;
};

export type LessonLedgerResult = {
  packages: StudentLessonPackage[];
  ledger: LessonHourLedgerEntry[];
  entry: LessonHourLedgerEntry;
  applied: boolean;
};

function copyPackages(packages: readonly StudentLessonPackage[]) {
  return packages.map((lessonPackage) => ({
    ...lessonPackage,
    subjectIds: [...lessonPackage.subjectIds],
    purchaseRecords: lessonPackage.purchaseRecords.map((record) => ({ ...record })),
  }));
}

/** A lesson id can create at most one deduction, including after that deduction is reversed. */
export function deductCompletedLesson(
  packages: readonly StudentLessonPackage[],
  ledger: readonly LessonHourLedgerEntry[],
  input: LessonCompletionInput,
): LessonLedgerResult {
  const existing = ledger.find((entry): entry is LessonHourDeduction =>
    entry.kind === "deduction" && entry.lessonId === input.lessonId);
  if (existing) {
    if (
      existing.packageId !== input.packageId
      || existing.subjectId !== input.subjectId
      || existing.hours !== roundHours(input.hours)
      || existing.occurredAt !== input.completedAt
    ) {
      throw new Error(`lesson ${input.lessonId} already has a different deduction`);
    }
    return { packages: copyPackages(packages), ledger: [...ledger], entry: existing, applied: false };
  }

  requireNonEmpty(input.entryId, "entryId");
  requireNonEmpty(input.lessonId, "lessonId");
  requirePositiveHours(input.hours);
  requireDateTime(input.completedAt, "completedAt");
  if (ledger.some((entry) => entry.id === input.entryId)) throw new Error(`ledger id ${input.entryId} already exists`);
  const packageIndex = packages.findIndex((lessonPackage) => lessonPackage.id === input.packageId);
  if (packageIndex < 0) throw new Error(`lesson package ${input.packageId} was not found`);
  const selected = packages[packageIndex];
  validateLessonPackage(selected);
  if (!selected.subjectIds.includes(input.subjectId)) {
    throw new Error(`subject ${input.subjectId} is not bound to package ${input.packageId}`);
  }
  if (getLessonPackageBalance(selected).remainingHours < roundHours(input.hours)) {
    throw new RangeError(`lesson package ${input.packageId} has insufficient hours`);
  }

  const entry: LessonHourDeduction = {
    id: input.entryId,
    kind: "deduction",
    lessonId: input.lessonId,
    packageId: input.packageId,
    subjectId: input.subjectId,
    hours: roundHours(input.hours),
    occurredAt: input.completedAt,
  };
  const nextPackages = copyPackages(packages);
  nextPackages[packageIndex] = {
    ...nextPackages[packageIndex],
    consumedHours: roundHours(nextPackages[packageIndex].consumedHours + entry.hours),
  };
  return { packages: nextPackages, ledger: [...ledger, entry], entry, applied: true };
}

export function reverseLessonDeduction(
  packages: readonly StudentLessonPackage[],
  ledger: readonly LessonHourLedgerEntry[],
  input: { deductionEntryId: string; reversalEntryId: string; reversedAt: string },
): LessonLedgerResult {
  const deduction = ledger.find((entry): entry is LessonHourDeduction =>
    entry.kind === "deduction" && entry.id === input.deductionEntryId);
  if (!deduction) throw new Error(`deduction ${input.deductionEntryId} was not found`);
  const existing = ledger.find((entry): entry is LessonHourReversal =>
    entry.kind === "reversal" && entry.reversesEntryId === deduction.id);
  if (existing) {
    return { packages: copyPackages(packages), ledger: [...ledger], entry: existing, applied: false };
  }
  requireNonEmpty(input.reversalEntryId, "reversalEntryId");
  requireDateTime(input.reversedAt, "reversedAt");
  if (ledger.some((entry) => entry.id === input.reversalEntryId)) {
    throw new Error(`ledger id ${input.reversalEntryId} already exists`);
  }
  const packageIndex = packages.findIndex((lessonPackage) => lessonPackage.id === deduction.packageId);
  if (packageIndex < 0) throw new Error(`lesson package ${deduction.packageId} was not found`);
  const selected = packages[packageIndex];
  validateLessonPackage(selected);
  if (roundHours(selected.consumedHours) < roundHours(deduction.hours)) {
    throw new Error("package balance is inconsistent with the deduction ledger");
  }

  const entry: LessonHourReversal = {
    id: input.reversalEntryId,
    kind: "reversal",
    lessonId: deduction.lessonId,
    packageId: deduction.packageId,
    subjectId: deduction.subjectId,
    hours: deduction.hours,
    occurredAt: input.reversedAt,
    reversesEntryId: deduction.id,
  };
  const nextPackages = copyPackages(packages);
  nextPackages[packageIndex] = {
    ...nextPackages[packageIndex],
    consumedHours: roundHours(nextPackages[packageIndex].consumedHours - entry.hours),
  };
  return { packages: nextPackages, ledger: [...ledger, entry], entry, applied: true };
}

export const RENEWAL_STATUSES = [
  "renewed",
  "not_renewed_active",
  "not_renewed_inactive",
  "not_renewed_exam_finished",
] as const;

export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

export const RENEWAL_STATUS_LABELS: Record<RenewalStatus, string> = {
  renewed: "已续课",
  not_renewed_active: "未续课-活跃",
  not_renewed_inactive: "未续课-不活跃",
  not_renewed_exam_finished: "未续课-不活跃（已考完）",
};

/**
 * Converts legacy renewal/follow-up values into the four business statuses.
 * Inactivity is never inferred: only an explicit inactive status is preserved.
 */
export function normalizeRenewalBusinessStatus(value: unknown): RenewalStatus {
  const status = typeof value === "string" ? value.trim() : "";
  if ((RENEWAL_STATUSES as readonly string[]).includes(status)) return status as RenewalStatus;
  if (status === "已续课" || status === "已确认") return "renewed";
  if (status === "未续课-不活跃") return "not_renewed_inactive";
  if (status === "未续课-不活跃（已考完）") return "not_renewed_exam_finished";
  return "not_renewed_active";
}

export type FutureLessonBooking = {
  id: string;
  packageId: string;
  subjectId: string;
  startsAt: string;
  hours: number;
  status?: "scheduled" | "cancelled";
};

export type PackageDepletionEstimate = {
  date: string;
  bookingId: string;
  packageId: string;
  subjectId: string;
};

/**
 * Finds the scheduled lesson that will consume the last remaining hour.
 * A subject filter provides a subject-only projection for a shared package.
 */
export function estimateLessonPackageDepletion(
  lessonPackage: StudentLessonPackage,
  bookings: readonly FutureLessonBooking[],
  options: { subjectId?: string; asOf?: string } = {},
): PackageDepletionEstimate | null {
  validateLessonPackage(lessonPackage);
  if (options.subjectId && !lessonPackage.subjectIds.includes(options.subjectId)) {
    throw new Error(`subject ${options.subjectId} is not bound to package ${lessonPackage.id}`);
  }
  if (options.asOf) requireDateTime(options.asOf, "asOf");
  let remaining = getLessonPackageBalance(lessonPackage).remainingHours;
  if (remaining <= 0) return null;

  const relevant = bookings
    .filter((booking) => booking.packageId === lessonPackage.id)
    .filter((booking) => booking.status !== "cancelled")
    .filter((booking) => !options.subjectId || booking.subjectId === options.subjectId)
    .filter((booking) => !options.asOf || Date.parse(booking.startsAt) >= Date.parse(options.asOf))
    .map((booking) => {
      requireDateTime(booking.startsAt, "startsAt");
      requirePositiveHours(booking.hours, "booking hours");
      if (!lessonPackage.subjectIds.includes(booking.subjectId)) {
        throw new Error(`subject ${booking.subjectId} is not bound to package ${lessonPackage.id}`);
      }
      return booking;
    })
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt) || left.id.localeCompare(right.id));

  for (const booking of relevant) {
    remaining = roundHours(remaining - booking.hours);
    if (remaining <= 0) {
      return {
        date: booking.startsAt.slice(0, 10),
        bookingId: booking.id,
        packageId: booking.packageId,
        subjectId: booking.subjectId,
      };
    }
  }
  return null;
}

export type LessonPackageBookingOccurrence = {
  id: string;
  packageId?: string;
  subjectId?: string;
  date: string;
  start: string;
  timezone: string;
  duration: number;
  status?: "scheduled" | "cancelled" | "待确认" | "已确认" | "已完成";
};

export type LessonPackageDepletionMapping = {
  packageId: string;
  depletionDate: string | null;
  subjectId: string | null;
  occurrenceId: string | null;
};

const TIME_ONLY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Projects one depletion result per package from expanded booking occurrences.
 * `occurrence.date` is the authoritative local calendar date; timezone conversion
 * must not move the displayed depletion date to the previous or following day.
 */
export function mapLessonPackageDepletionEstimates(
  packages: readonly StudentLessonPackage[],
  occurrences: readonly LessonPackageBookingOccurrence[],
  options: { asOfDate?: string } = {},
): LessonPackageDepletionMapping[] {
  if (options.asOfDate) requireDateOnly(options.asOfDate, "asOfDate");
  const packageIds = new Set<string>();
  packages.forEach((lessonPackage) => {
    validateLessonPackage(lessonPackage);
    if (packageIds.has(lessonPackage.id)) throw new Error(`lesson package ${lessonPackage.id} is duplicated`);
    packageIds.add(lessonPackage.id);
  });

  const scheduled = occurrences
    .map((occurrence) => {
      requireNonEmpty(occurrence.id, "occurrence id");
      requireDateOnly(occurrence.date, "occurrence date");
      if (!TIME_ONLY_PATTERN.test(occurrence.start)) throw new Error("occurrence start must use HH:MM");
      requireNonEmpty(occurrence.timezone, "occurrence timezone");
      requirePositiveHours(occurrence.duration, "occurrence duration");
      return occurrence;
    })
    .filter((occurrence) => occurrence.status !== "cancelled" && occurrence.status !== "已完成")
    .filter((occurrence) => !options.asOfDate || occurrence.date >= options.asOfDate)
    .filter((occurrence) => occurrence.packageId)
    .map((occurrence) => {
      if (!packageIds.has(occurrence.packageId!)) {
        throw new Error(`lesson package ${occurrence.packageId} was not found`);
      }
      if (!occurrence.subjectId?.trim()) throw new Error(`occurrence ${occurrence.id} requires a subject`);
      return occurrence as LessonPackageBookingOccurrence & { packageId: string; subjectId: string };
    })
    .sort((left, right) => left.date.localeCompare(right.date)
      || left.start.localeCompare(right.start)
      || left.id.localeCompare(right.id));

  return packages.map((lessonPackage) => {
    let remaining = getLessonPackageBalance(lessonPackage).remainingHours;
    if (remaining <= 0) {
      return { packageId: lessonPackage.id, depletionDate: null, subjectId: null, occurrenceId: null };
    }
    for (const occurrence of scheduled) {
      if (occurrence.packageId !== lessonPackage.id) continue;
      if (!lessonPackage.subjectIds.includes(occurrence.subjectId)) {
        throw new Error(`subject ${occurrence.subjectId} is not bound to package ${lessonPackage.id}`);
      }
      remaining = roundHours(remaining - occurrence.duration / 60);
      if (remaining <= 0) {
        return {
          packageId: lessonPackage.id,
          depletionDate: occurrence.date,
          subjectId: occurrence.subjectId,
          occurrenceId: occurrence.id,
        };
      }
    }
    return { packageId: lessonPackage.id, depletionDate: null, subjectId: null, occurrenceId: null };
  });
}

import { ASSIGNABLE_DEMO_STAFF_USERS } from "./demo-users";

export const LP_WORKFLOW_TYPES = [
  "试听 LP",
  "老师新 LP",
  "老师 LP 修改",
  "换老师试听",
  "代课 LP",
  "学生直报（无试听）",
  "学生报名交接",
] as const;

export type LpWorkflowType = (typeof LP_WORKFLOW_TYPES)[number];

export const SPECIFIED_CONTENT_STATUSES = ["已指定", "无需指定", "需教务跟进", "需要跟进"] as const;
export type SpecifiedContentStatus = (typeof SPECIFIED_CONTENT_STATUSES)[number];

export const PREPARATION_FOLLOW_UP_OPTIONS = ["是", "否"] as const;
export type PreparationFollowUp = (typeof PREPARATION_FOLLOW_UP_OPTIONS)[number];

export const LP_CONTACT_OPTIONS = ["家长", "学生本人"] as const;
export type LpContact = (typeof LP_CONTACT_OPTIONS)[number];

export const TRIAL_OPERATIONS = ASSIGNABLE_DEMO_STAFF_USERS;
export type TrialOperations = (typeof TRIAL_OPERATIONS)[number];

export const TRIAL_LOCATION_OPTIONS = ["VIC", "NSW", "QLD", "WA", "SA", "NZ", "国内"] as const;

export const TRIAL_PAYMENT_METHODS = [
  "后置付费试听",
  "付费试听（已付费）",
  "付费试听（未付费）",
  "免费试听",
  "在读学生付费试听",
] as const;
export type TrialPaymentMethod = (typeof TRIAL_PAYMENT_METHODS)[number];

export type LpCommonFields = {
  responsibleOperations: string;
  requestSentAt?: string;
  specifiedContentStatus: SpecifiedContentStatus;
  specialNotes?: string;
  preparationFollowUp: PreparationFollowUp;
  isUniversityStudent: boolean;
  universityMajor?: string;
  universityYear?: string;
};

export type TrialLpFields = LpCommonFields & {
  planner: "Tara" | "Eileen" | "Abby";
  requestSentAt: string;
  assignedTeacher: string;
  subject: string;
  oneSentenceDescription: string;
  locationTimezone: string;
  contactPerson: LpContact;
  contactParents: boolean;
  contactStudent: boolean;
  contactNote?: string;
  writingRequired: boolean;
  writingNote?: string;
  paperRequired: boolean;
  paperNote?: string;
  timeMentioned: boolean;
  preferredTime?: string;
  studentNameKnown: boolean;
  studentName?: string;
  preparationNote?: string;
  trialDurationMinutes: 45 | 60;
  trialDurationNote?: string;
  trialPaymentMethod: TrialPaymentMethod;
};

type TrialOnlyFieldKey =
  | "assignedTeacher"
  | "studentNameKnown"
  | "trialPaymentMethod"
  | "planner"
  | "requestSentAt"
  | "contactParents"
  | "contactStudent"
  | "contactNote"
  | "writingRequired"
  | "writingNote"
  | "paperRequired"
  | "paperNote"
  | "studentName"
  | "preparationNote"
  | "trialDurationMinutes"
  | "trialDurationNote";

export type DirectEnrollmentLpFields = Omit<TrialLpFields, TrialOnlyFieldKey> & {
  purchasedHours: number;
  bonusHours: number;
  lessonFrequency: string;
  coursesAndTeachers: string;
};

/** Sections shared by the maintained Tencent LP templates. */
export type TeacherLpFields = LpCommonFields & {
  teacher: string;
  subject: string;
  documentUrl?: string;
  writingRequired?: boolean;
  writingNote?: string;
  paperRequired?: boolean;
  paperNote?: string;
  additionalNotes?: string;
  basicInfo?: string;
  studentFoundation?: string;
  learningGoal?: string;
  recommendedResources?: string;
  teachingLanguage?: string;
  firstLessonContent?: string;
  lessonSchedule?: string;
  comments?: string;
};

export type TeacherLpModificationFields = LpCommonFields & {
  teacher?: string;
  subject: string;
  documentUrl?: string;
  modificationRequirements: string;
};

export type TeacherChangeTrialFields = LpCommonFields & {
  originalTeacher?: string;
  newTeacher: string;
  subject: string;
  changeReason: string;
  trialInformation?: string;
  handoverFromTeacher?: string;
  materialsAndContentTaught?: string;
  recommendedNextContent?: string;
  studentStrengthsAndLearningProfile?: string;
  lastHomework?: string;
  lastLessonRecordingUrl?: string;
};

export type SubstituteTeacherLpFields = LpCommonFields & {
  originalTeacher: string;
  substituteTeacher: string;
  subject: string;
  coverageStartDate: string;
  coverageEndDate: string;
  additionalNotes: string;
  basicInfo: string;
  studentFoundation: string;
  learningGoal: string;
  allocatedLessonContentAndResources: string;
  teachingLanguage: string;
  comments?: string;
  lastHomework: string;
  lastLessonRecordingUrl: string;
  /** Legacy single-note field retained for already-stored workflows. */
  handoverNotes?: string;
};

export type EnrollmentHandoverLpFields = LpCommonFields & {
  planner: string;
  coursePackage: string;
  subject: string;
  purchasedHours: number;
  bonusHours: number;
  lessonFrequency: string;
  preferredTime: string;
  coursesAndTeachers: string;
  enrollmentHandoverNotes?: string;
};

export type LpWorkflowFieldsByType = {
  "试听 LP": TrialLpFields;
  "老师新 LP": LpCommonFields | TeacherLpFields;
  "老师 LP 修改": LpCommonFields | TeacherLpModificationFields;
  "换老师试听": LpCommonFields | TeacherChangeTrialFields;
  "代课 LP": LpCommonFields | SubstituteTeacherLpFields;
  "学生直报（无试听）": DirectEnrollmentLpFields;
  "学生报名交接": LpCommonFields | EnrollmentHandoverLpFields;
};

type LpWorkflowFieldKey = keyof (
  DirectEnrollmentLpFields
  & TeacherLpFields
  & TeacherLpModificationFields
  & TeacherChangeTrialFields
  & SubstituteTeacherLpFields
  & EnrollmentHandoverLpFields
) | "assignedTeacher" | "studentNameKnown" | "trialPaymentMethod"
  | "requestSentAt" | "contactParents" | "contactStudent" | "contactNote"
  | "writingRequired" | "writingNote" | "paperRequired" | "paperNote"
  | "studentName" | "preparationNote" | "trialDurationMinutes" | "trialDurationNote";

export type LpFieldControl = "text" | "textarea" | "select" | "number" | "boolean" | "url" | "date";
export type LpFieldRequirement = "required" | "optional" | "university-only";

export type LpFieldSchema = Readonly<{
  key: LpWorkflowFieldKey;
  label: string;
  control: LpFieldControl;
  requirement: LpFieldRequirement;
  options?: readonly string[];
  min?: number;
  visibleWhen?: Readonly<{ field: "isUniversityStudent"; equals: true }>;
}>;

export type LpWorkflowSchema = Readonly<{
  type: LpWorkflowType;
  fields: readonly LpFieldSchema[];
  /** False means the document names the workflow but defers its extra fields to a missing group template. */
  typeSpecificFieldsDocumented: boolean;
}>;

const universityCondition = Object.freeze({ field: "isUniversityStudent", equals: true } as const);

const commonFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "responsibleOperations", label: "所属教务", control: "text", requirement: "required" }),
  Object.freeze({
    key: "specifiedContentStatus",
    label: "是否要指定内容",
    control: "select",
    requirement: "required",
    options: SPECIFIED_CONTENT_STATUSES,
  }),
  Object.freeze({ key: "specialNotes", label: "特殊备注", control: "textarea", requirement: "optional" }),
  Object.freeze({
    key: "preparationFollowUp",
    label: "是否跟进老师备课内容",
    control: "select",
    requirement: "required",
    options: PREPARATION_FOLLOW_UP_OPTIONS,
  }),
  Object.freeze({ key: "isUniversityStudent", label: "大学学生", control: "boolean", requirement: "required" }),
  Object.freeze({
    key: "universityMajor",
    label: "专业",
    control: "text",
    requirement: "university-only",
    visibleWhen: universityCondition,
  }),
  Object.freeze({
    key: "universityYear",
    label: "年级",
    control: "text",
    requirement: "university-only",
    visibleWhen: universityCondition,
  }),
]);

const trialFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "planner", label: "课程规划老师", control: "select", requirement: "required", options: ["Tara", "Eileen", "Abby"] }),
  Object.freeze({ key: "requestSentAt", label: "试听 LP 交接时间", control: "text", requirement: "required" }),
  Object.freeze({ key: "assignedTeacher", label: "安排老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "oneSentenceDescription", label: "一句话描述", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "locationTimezone", label: "所在地（时区）", control: "text", requirement: "required" }),
  Object.freeze({
    key: "contactPerson",
    label: "对接对象",
    control: "select",
    requirement: "required",
    options: LP_CONTACT_OPTIONS,
  }),
  Object.freeze({ key: "timeMentioned", label: "是否提到时间", control: "boolean", requirement: "required" }),
  Object.freeze({ key: "preferredTime", label: "偏好时间", control: "text", requirement: "optional" }),
  Object.freeze({ key: "studentNameKnown", label: "是否知道学生姓名", control: "boolean", requirement: "required" }),
  Object.freeze({ key: "studentName", label: "学生姓名", control: "text", requirement: "optional" }),
  Object.freeze({ key: "contactParents", label: "对接家长", control: "boolean", requirement: "required" }),
  Object.freeze({ key: "contactStudent", label: "对接学生本人", control: "boolean", requirement: "required" }),
  Object.freeze({ key: "contactNote", label: "对接备注", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "writingRequired", label: "是否要写作", control: "boolean", requirement: "required" }),
  Object.freeze({ key: "writingNote", label: "写作备注", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "paperRequired", label: "是否发试卷、收试卷", control: "boolean", requirement: "required" }),
  Object.freeze({ key: "paperNote", label: "试卷备注", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "preparationNote", label: "备课跟进备注", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "trialDurationMinutes", label: "试听时长（分钟）", control: "number", requirement: "required", min: 45 }),
  Object.freeze({ key: "trialDurationNote", label: "时长备注", control: "textarea", requirement: "optional" }),
  Object.freeze({
    key: "trialPaymentMethod",
    label: "试听付费方式",
    control: "select",
    requirement: "required",
    options: TRIAL_PAYMENT_METHODS,
  }),
]);

const directEnrollmentHoursSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "purchasedHours", label: "购买课时", control: "number", requirement: "required", min: 0 }),
  Object.freeze({ key: "bonusHours", label: "赠送课时", control: "number", requirement: "required", min: 0 }),
  Object.freeze({ key: "lessonFrequency", label: "排课频率", control: "text", requirement: "required" }),
  Object.freeze({ key: "coursesAndTeachers", label: "课程与教师", control: "textarea", requirement: "required" }),
]);

const directEnrollmentTrialSchema = Object.freeze(
  trialFieldSchema.filter((field) => ![
    "assignedTeacher", "studentNameKnown", "trialPaymentMethod", "planner", "requestSentAt",
    "contactParents", "contactStudent", "contactNote", "writingRequired", "writingNote",
    "paperRequired", "paperNote", "studentName", "preparationNote", "trialDurationMinutes",
    "trialDurationNote",
  ].includes(field.key)),
);

const teacherLpFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "requestSentAt", label: "LP 交接时间", control: "text", requirement: "required" }),
  ...trialFieldSchema.filter((field) => ["writingRequired", "writingNote", "paperRequired", "paperNote"].includes(field.key)),
  Object.freeze({ key: "teacher", label: "老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "documentUrl", label: "文档 URL", control: "url", requirement: "optional" }),
  Object.freeze({ key: "additionalNotes", label: "补充注意事项", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "basicInfo", label: "基本信息", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "studentFoundation", label: "学生基础", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "learningGoal", label: "学习目的", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "recommendedResources", label: "建议资料库", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "teachingLanguage", label: "授课语言", control: "text", requirement: "optional" }),
  Object.freeze({ key: "firstLessonContent", label: "试听课 / 首次课内容", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "lessonSchedule", label: "课时计划", control: "text", requirement: "optional" }),
  Object.freeze({ key: "comments", label: "备注", control: "textarea", requirement: "optional" }),
]);

const teacherLpModificationFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "requestSentAt", label: "LP 交接时间", control: "text", requirement: "required" }),
  Object.freeze({ key: "teacher", label: "老师", control: "text", requirement: "optional" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "documentUrl", label: "文档 URL", control: "url", requirement: "optional" }),
  Object.freeze({ key: "modificationRequirements", label: "修改要求", control: "textarea", requirement: "required" }),
]);

const teacherChangeTrialFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "requestSentAt", label: "LP 交接时间", control: "text", requirement: "required" }),
  Object.freeze({ key: "originalTeacher", label: "原老师", control: "text", requirement: "optional" }),
  Object.freeze({ key: "newTeacher", label: "新老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "changeReason", label: "重听原因及注意事项", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "trialInformation", label: "试听信息", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "handoverFromTeacher", label: "交接老师", control: "text", requirement: "optional" }),
  Object.freeze({ key: "materialsAndContentTaught", label: "已使用资料、已教内容", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "recommendedNextContent", label: "建议后续内容与资料", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "studentStrengthsAndLearningProfile", label: "学生强项、进步方向与学习特点", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "lastHomework", label: "上节课作业", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "lastLessonRecordingUrl", label: "上次课录像 URL", control: "url", requirement: "optional" }),
]);

const substituteTeacherFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "originalTeacher", label: "原老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "substituteTeacher", label: "代课老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "coverageStartDate", label: "覆盖开始日期", control: "date", requirement: "required" }),
  Object.freeze({ key: "coverageEndDate", label: "覆盖结束日期", control: "date", requirement: "required" }),
  Object.freeze({ key: "additionalNotes", label: "补充注意事项", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "basicInfo", label: "基本信息", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "studentFoundation", label: "学生基础", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "learningGoal", label: "学习目的", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "allocatedLessonContentAndResources", label: "指定代课内容与资料", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "teachingLanguage", label: "授课语言", control: "text", requirement: "required" }),
  Object.freeze({ key: "comments", label: "备注", control: "textarea", requirement: "optional" }),
  Object.freeze({ key: "lastHomework", label: "上节课作业", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "lastLessonRecordingUrl", label: "上次课录像 URL", control: "url", requirement: "required" }),
]);

const enrollmentHandoverFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "planner", label: "规划老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "coursePackage", label: "课程 / 课包", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "purchasedHours", label: "购买课时", control: "number", requirement: "required", min: 0 }),
  Object.freeze({ key: "bonusHours", label: "赠送课时", control: "number", requirement: "required", min: 0 }),
  Object.freeze({ key: "lessonFrequency", label: "排课频率", control: "text", requirement: "required" }),
  Object.freeze({ key: "preferredTime", label: "已提到的时间", control: "text", requirement: "required" }),
  Object.freeze({ key: "coursesAndTeachers", label: "课程与教师", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "enrollmentHandoverNotes", label: "试听后补充交接", control: "textarea", requirement: "optional" }),
]);

function schema(
  type: LpWorkflowType,
  typeSpecificFieldsDocumented: boolean,
  typeSpecificFields: readonly LpFieldSchema[] = [],
): LpWorkflowSchema {
  return Object.freeze({
    type,
    fields: Object.freeze([
      ...commonFieldSchema.map((field) => type === "老师 LP 修改" && ["specifiedContentStatus", "preparationFollowUp"].includes(field.key)
        ? Object.freeze({ ...field, requirement: "optional" as const })
        : field),
      ...typeSpecificFields,
    ]),
    typeSpecificFieldsDocumented,
  });
}

export const LP_WORKFLOW_SCHEMAS: Readonly<Record<LpWorkflowType, LpWorkflowSchema>> = Object.freeze({
  "试听 LP": schema("试听 LP", true, trialFieldSchema),
  "老师新 LP": schema("老师新 LP", true, teacherLpFieldSchema),
  "老师 LP 修改": schema("老师 LP 修改", true, teacherLpModificationFieldSchema),
  "换老师试听": schema("换老师试听", true, teacherChangeTrialFieldSchema),
  "代课 LP": schema("代课 LP", true, substituteTeacherFieldSchema),
  "学生直报（无试听）": schema(
    "学生直报（无试听）",
    true,
    Object.freeze([...directEnrollmentTrialSchema, ...directEnrollmentHoursSchema]),
  ),
  "学生报名交接": schema("学生报名交接", true, enrollmentHandoverFieldSchema),
});

export function getLpWorkflowSchema(type: LpWorkflowType): LpWorkflowSchema {
  return LP_WORKFLOW_SCHEMAS[type];
}

export const LP_STAGES = ["待资料", "写作中", "待审核", "需修改", "已发老师", "待备课确认", "备课完成", "完成"] as const;
export type LpStage = (typeof LP_STAGES)[number];

/** Business outcome is deliberately independent from the production stage. */
export const TRIAL_LEDGER_RESULT_STATUSES = [
  "试听成功",
  "试听失败",
  "有希望报名",
  "试听未进行",
  "在读试听成功",
  "在读试听失败",
  "被家长取消",
  "NIL",
] as const;

export const LP_RESULT_STATUSES = [
  ...TRIAL_LEDGER_RESULT_STATUSES,
  "已完成",
  "已取消",
] as const;
export type LpResultStatus = (typeof LP_RESULT_STATUSES)[number];

/** Non-trial LPs report whether the workflow itself was completed or cancelled. */
const NON_TRIAL_RESULT_STATUSES = new Set<LpResultStatus>(["已完成", "已取消"]);
const NON_TRIAL_WORKFLOW_TYPES = new Set<LpWorkflowType>([
  "老师新 LP",
  "老师 LP 修改",
  "代课 LP",
  "学生直报（无试听）",
  "学生报名交接",
]);

export function allowedLpResultStatuses(type: LpWorkflowType): readonly LpResultStatus[] {
  if (type === "试听 LP" || type === "换老师试听") return TRIAL_LEDGER_RESULT_STATUSES;
  if (NON_TRIAL_WORKFLOW_TYPES.has(type)) return LP_RESULT_STATUSES.filter((status) => NON_TRIAL_RESULT_STATUSES.has(status));
  return [];
}

export function validateLpResultStatus(type: LpWorkflowType, resultStatus: LpResultStatus | undefined) {
  if (!resultStatus) return;
  if (!allowedLpResultStatuses(type).includes(resultStatus)) {
    throw new Error(`${resultStatus} is not valid for ${type}`);
  }
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type LpFieldValues = Readonly<Record<string, JsonValue>>;

export type LpRevision = Readonly<{
  id: string;
  workflowId: string;
  number: number;
  changedAt: string;
  changedBy: string;
  note?: string;
  before: LpFieldValues;
  after: LpFieldValues;
}>;

export type LpStageAuditEntry = Readonly<{
  id: string;
  workflowId: string;
  action: "stage_changed";
  occurredAt: string;
  actor: string;
  fromStage: LpStage;
  toStage: LpStage;
  note?: string;
}>;

export type LpResultAuditEntry = Readonly<{
  id: string;
  workflowId: string;
  action: "result_status_changed";
  occurredAt: string;
  actor: string;
  fromResultStatus?: LpResultStatus;
  toResultStatus?: LpResultStatus;
  note?: string;
}>;

export type LpWorkflowAuditEntry = LpStageAuditEntry | LpResultAuditEntry;

export type LpWorkflowRecord = Readonly<{
  id: string;
  type: LpWorkflowType;
  stage: LpStage;
  resultStatus?: LpResultStatus;
  fields: LpFieldValues;
  revisionNumber: number;
  revisions: readonly LpRevision[];
  /** Stage history remains compatible with existing consumers. */
  audit: readonly LpStageAuditEntry[];
  /** Business-result history is separate from stage transitions. */
  resultAudit?: readonly LpResultAuditEntry[];
}>;

export type LpChangeMetadata = Readonly<{
  id: string;
  at: string;
  actor: string;
  note?: string;
}>;

function immutableJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableJson(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, immutableJson(item)]),
    );
    return Object.freeze(copy) as T;
  }
  return value;
}

function immutableFields(fields: LpFieldValues): LpFieldValues {
  return immutableJson(fields as { readonly [key: string]: JsonValue }) as LpFieldValues;
}

function requireText(fields: LpFieldValues, key: string) {
  const value = fields[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
}

function optionalText(fields: LpFieldValues, key: string) {
  const value = fields[key];
  if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`${key} must be a non-empty string`);
}

function requireBoolean(fields: LpFieldValues, key: string) {
  if (fields[key] !== true && fields[key] !== false) throw new Error(`${key} must be a boolean`);
}

function requireOneOf(fields: LpFieldValues, key: string, allowed: readonly string[]) {
  requireText(fields, key);
  if (!allowed.includes(String(fields[key]))) throw new Error(`${key} must be one of the allowed options`);
}

function requireNonNegativeHours(fields: LpFieldValues) {
  for (const key of ["purchasedHours", "bonusHours"]) {
    const value = fields[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }
  if (Number(fields.purchasedHours) + Number(fields.bonusHours) <= 0) {
    throw new Error("purchasedHours and bonusHours total must be greater than zero");
  }
}

function validateOptionalHttpUrl(fields: LpFieldValues, key: string) {
  optionalText(fields, key);
  if (typeof fields[key] === "string") validateLpDocumentUrl(fields[key]);
}

function hasAnyField(fields: LpFieldValues, keys: readonly string[]) {
  return keys.some((key) => fields[key] !== undefined);
}

export function validateLpDocumentUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("documentUrl must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("documentUrl must use http or https");
  }
  return parsed.href;
}

export function validateLpDate(value: string, field = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date`);
  }
  return value;
}

/** Validates the minimum system handover fields for a workflow type. */
export function validateLpWorkflowFields(type: LpWorkflowType, fields: LpFieldValues) {
  requireText(fields, "responsibleOperations");
  if (type === "试听 LP") requireOneOf(fields, "responsibleOperations", TRIAL_OPERATIONS);
  if (type !== "老师 LP 修改" || fields.specifiedContentStatus !== undefined) requireOneOf(fields, "specifiedContentStatus", SPECIFIED_CONTENT_STATUSES);
  if (type !== "老师 LP 修改" || fields.preparationFollowUp !== undefined) requireOneOf(fields, "preparationFollowUp", PREPARATION_FOLLOW_UP_OPTIONS);
  requireBoolean(fields, "isUniversityStudent");
  if (fields.isUniversityStudent) {
    requireText(fields, "universityMajor");
    requireText(fields, "universityYear");
  }

  if (type === "试听 LP" || type === "学生直报（无试听）") {
    for (const key of ["subject", "oneSentenceDescription", "locationTimezone", "contactPerson"]) requireText(fields, key);
    requireOneOf(fields, "contactPerson", LP_CONTACT_OPTIONS);
    requireBoolean(fields, "timeMentioned");
    if (fields.timeMentioned) requireText(fields, "preferredTime");
    else optionalText(fields, "preferredTime");
  }
  if (type === "试听 LP") {
    requireText(fields, "assignedTeacher");
    requireBoolean(fields, "studentNameKnown");
    requireOneOf(fields, "trialPaymentMethod", TRIAL_PAYMENT_METHODS);
  }
  if (type === "学生直报（无试听）") {
    requireNonNegativeHours(fields);
    for (const key of ["lessonFrequency", "coursesAndTeachers"]) requireText(fields, key);
  }
  if (["老师新 LP", "老师 LP 修改", "换老师试听"].includes(type) && fields.requestSentAt !== undefined) {
    requireText(fields, "requestSentAt");
    if (!Number.isFinite(new Date(String(fields.requestSentAt)).valueOf())) throw new Error("requestSentAt must be a valid timestamp");
  }
  if (type === "老师新 LP" || type === "老师 LP 修改") {
    if (type === "老师新 LP") requireText(fields, "teacher");
    else optionalText(fields, "teacher");
    requireText(fields, "subject");
    validateOptionalHttpUrl(fields, "documentUrl");
    for (const key of ["additionalNotes", "basicInfo", "studentFoundation", "learningGoal", "recommendedResources", "teachingLanguage", "firstLessonContent", "lessonSchedule", "comments"]) optionalText(fields, key);
    if (type === "老师新 LP") {
      for (const key of ["writingRequired", "paperRequired"]) if (fields[key] !== undefined) requireBoolean(fields, key);
      optionalText(fields, "writingNote");
      optionalText(fields, "paperNote");
    }
    if (type === "老师 LP 修改") optionalText(fields, "modificationRequirements");
  }
  if (type === "换老师试听") {
    for (const key of ["newTeacher", "subject", "changeReason"]) requireText(fields, key);
    for (const key of ["originalTeacher", "trialInformation", "handoverFromTeacher", "materialsAndContentTaught", "recommendedNextContent", "studentStrengthsAndLearningProfile", "lastHomework"]) optionalText(fields, key);
    validateOptionalHttpUrl(fields, "lastLessonRecordingUrl");
  }
  if (type === "代课 LP") {
    for (const key of ["originalTeacher", "substituteTeacher", "subject", "coverageStartDate", "coverageEndDate"]) requireText(fields, key);
    const start = validateLpDate(String(fields.coverageStartDate), "coverageStartDate");
    const end = validateLpDate(String(fields.coverageEndDate), "coverageEndDate");
    if (end < start) throw new Error("coverageEndDate must not be before coverageStartDate");
    const templateKeys = ["additionalNotes", "basicInfo", "studentFoundation", "learningGoal", "allocatedLessonContentAndResources", "teachingLanguage", "lastHomework", "lastLessonRecordingUrl"] as const;
    if (hasAnyField(fields, templateKeys)) {
      for (const key of templateKeys) requireText(fields, key);
      optionalText(fields, "comments");
      validateOptionalHttpUrl(fields, "lastLessonRecordingUrl");
    } else {
      requireText(fields, "handoverNotes");
    }
  }
  if (type === "学生报名交接") {
    for (const key of ["planner", "coursePackage", "subject"]) requireText(fields, key);
    const enrollmentKeys = ["purchasedHours", "bonusHours", "lessonFrequency", "preferredTime", "coursesAndTeachers"] as const;
    if (hasAnyField(fields, enrollmentKeys)) {
      requireNonNegativeHours(fields);
      for (const key of ["lessonFrequency", "preferredTime", "coursesAndTeachers"]) requireText(fields, key);
      optionalText(fields, "enrollmentHandoverNotes");
    } else {
      requireText(fields, "enrollmentHandoverNotes");
    }
  }
  return immutableFields(fields);
}

/**
 * Validates a newly submitted workflow against the complete current form
 * contract. Historical rows use validateLpWorkflowFields so older handover
 * shapes remain readable, but no new API or UI submission may create them.
 */
export function validateCompleteLpWorkflowFields(type: LpWorkflowType, fields: LpFieldValues) {
  const validated = validateLpWorkflowFields(type, fields);
  if (["老师新 LP", "老师 LP 修改", "换老师试听"].includes(type)) requireText(validated, "requestSentAt");
  if (type === "老师新 LP") {
    requireBoolean(validated, "writingRequired");
    requireBoolean(validated, "paperRequired");
  }
  if (type === "老师 LP 修改") requireText(validated, "modificationRequirements");
  if (type === "代课 LP") {
    for (const key of ["additionalNotes", "basicInfo", "studentFoundation", "learningGoal", "allocatedLessonContentAndResources", "teachingLanguage", "lastHomework", "lastLessonRecordingUrl"]) requireText(validated, key);
    optionalText(validated, "comments");
    validateOptionalHttpUrl(validated, "lastLessonRecordingUrl");
  }
  if (type === "学生报名交接") {
    requireNonNegativeHours(validated);
    for (const key of ["lessonFrequency", "preferredTime", "coursesAndTeachers"]) requireText(validated, key);
    optionalText(validated, "enrollmentHandoverNotes");
  }
  return immutableFields(validated);
}

export function createLpRevision(
  workflowId: string,
  number: number,
  before: LpFieldValues,
  after: LpFieldValues,
  metadata: LpChangeMetadata,
): LpRevision {
  return Object.freeze({
    id: metadata.id,
    workflowId,
    number,
    changedAt: metadata.at,
    changedBy: metadata.actor,
    ...(metadata.note ? { note: metadata.note } : {}),
    before: immutableFields(before),
    after: immutableFields(after),
  });
}

/** Applies a top-level field patch and preserves immutable before/after snapshots. */
export function reviseLpWorkflow(
  workflow: LpWorkflowRecord,
  patch: LpFieldValues,
  metadata: LpChangeMetadata,
): LpWorkflowRecord {
  const nextFields = immutableFields({ ...workflow.fields, ...patch });
  const revision = createLpRevision(
    workflow.id,
    workflow.revisionNumber + 1,
    workflow.fields,
    nextFields,
    metadata,
  );

  return Object.freeze({
    ...workflow,
    fields: revision.after,
    revisionNumber: revision.number,
    revisions: Object.freeze([...workflow.revisions, revision]),
    audit: Object.freeze([...workflow.audit]),
  });
}

export function createLpStageAuditEntry(
  workflowId: string,
  fromStage: LpStage,
  toStage: LpStage,
  metadata: LpChangeMetadata,
): LpStageAuditEntry {
  return Object.freeze({
    id: metadata.id,
    workflowId,
    action: "stage_changed",
    occurredAt: metadata.at,
    actor: metadata.actor,
    fromStage,
    toStage,
    ...(metadata.note ? { note: metadata.note } : {}),
  });
}

export function createLpResultAuditEntry(
  workflowId: string,
  fromResultStatus: LpResultStatus | undefined,
  toResultStatus: LpResultStatus | undefined,
  metadata: LpChangeMetadata,
): LpResultAuditEntry {
  return Object.freeze({
    id: metadata.id,
    workflowId,
    action: "result_status_changed",
    occurredAt: metadata.at,
    actor: metadata.actor,
    ...(fromResultStatus ? { fromResultStatus } : {}),
    ...(toResultStatus ? { toResultStatus } : {}),
    ...(metadata.note ? { note: metadata.note } : {}),
  });
}

/** Changes the business result without moving the production stage. */
export function changeLpResultStatus(
  workflow: LpWorkflowRecord,
  toResultStatus: LpResultStatus | undefined,
  metadata: LpChangeMetadata,
): LpWorkflowRecord {
  validateLpResultStatus(workflow.type, toResultStatus);
  if (workflow.resultStatus === toResultStatus) return workflow;
  const auditEntry = createLpResultAuditEntry(workflow.id, workflow.resultStatus, toResultStatus, metadata);
  return Object.freeze({
    ...workflow,
    ...(toResultStatus ? { resultStatus: toResultStatus } : { resultStatus: undefined }),
    fields: immutableFields(workflow.fields),
    revisions: Object.freeze([...workflow.revisions]),
    audit: Object.freeze([...workflow.audit]),
    resultAudit: Object.freeze([...(workflow.resultAudit ?? []), auditEntry]),
  });
}

/** Changes stage without rewriting LP content and appends an auditable transition. */
export function changeLpStage(
  workflow: LpWorkflowRecord,
  toStage: LpStage,
  metadata: LpChangeMetadata,
): LpWorkflowRecord {
  if (workflow.stage === toStage) return workflow;

  const auditEntry = createLpStageAuditEntry(workflow.id, workflow.stage, toStage, metadata);
  return Object.freeze({
    ...workflow,
    stage: toStage,
    fields: immutableFields(workflow.fields),
    revisions: Object.freeze([...workflow.revisions]),
    audit: Object.freeze([...workflow.audit, auditEntry]),
  });
}

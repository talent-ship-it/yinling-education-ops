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

export const SPECIFIED_CONTENT_STATUSES = ["已指定", "无需指定", "需要跟进"] as const;
export type SpecifiedContentStatus = (typeof SPECIFIED_CONTENT_STATUSES)[number];

export const PREPARATION_FOLLOW_UP_OPTIONS = ["是", "否"] as const;
export type PreparationFollowUp = (typeof PREPARATION_FOLLOW_UP_OPTIONS)[number];

export const LP_CONTACT_OPTIONS = ["家长", "学生本人"] as const;
export type LpContact = (typeof LP_CONTACT_OPTIONS)[number];

export type LpCommonFields = {
  responsibleOperations: string;
  specifiedContentStatus: SpecifiedContentStatus;
  specialNotes?: string;
  preparationFollowUp: PreparationFollowUp;
  isUniversityStudent: boolean;
  universityMajor?: string;
  universityYear?: string;
};

export type TrialLpFields = LpCommonFields & {
  assignedTeacher: string;
  subject: string;
  oneSentenceDescription: string;
  locationTimezone: string;
  contactPerson: LpContact;
};

export type DirectEnrollmentLpFields = TrialLpFields & {
  purchasedHours: number;
  bonusHours: number;
};

/** Minimum system handover fields; these do not claim to reproduce any group template. */
export type TeacherLpFields = LpCommonFields & {
  teacher: string;
  subject: string;
  documentUrl?: string;
  modificationRequirements?: string;
};

export type TeacherChangeTrialFields = LpCommonFields & {
  originalTeacher: string;
  newTeacher: string;
  subject: string;
  changeReason: string;
  trialInformation: string;
};

export type SubstituteTeacherLpFields = LpCommonFields & {
  originalTeacher: string;
  substituteTeacher: string;
  subject: string;
  coverageStartDate: string;
  coverageEndDate: string;
  handoverNotes: string;
};

export type EnrollmentHandoverLpFields = LpCommonFields & {
  planner: string;
  coursePackage: string;
  subject: string;
  enrollmentHandoverNotes: string;
};

export type LpWorkflowFieldsByType = {
  "试听 LP": TrialLpFields;
  "老师新 LP": LpCommonFields | TeacherLpFields;
  "老师 LP 修改": LpCommonFields | TeacherLpFields;
  "换老师试听": LpCommonFields | TeacherChangeTrialFields;
  "代课 LP": LpCommonFields | SubstituteTeacherLpFields;
  "学生直报（无试听）": DirectEnrollmentLpFields;
  "学生报名交接": LpCommonFields | EnrollmentHandoverLpFields;
};

type LpWorkflowFieldKey = keyof (
  DirectEnrollmentLpFields
  & TeacherLpFields
  & TeacherChangeTrialFields
  & SubstituteTeacherLpFields
  & EnrollmentHandoverLpFields
);

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
    label: "指定内容",
    control: "select",
    requirement: "required",
    options: SPECIFIED_CONTENT_STATUSES,
  }),
  Object.freeze({ key: "specialNotes", label: "特殊备注", control: "textarea", requirement: "optional" }),
  Object.freeze({
    key: "preparationFollowUp",
    label: "是否需要跟进备课",
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
]);

const directEnrollmentHoursSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "purchasedHours", label: "购买课时", control: "number", requirement: "required", min: 0 }),
  Object.freeze({ key: "bonusHours", label: "赠送课时", control: "number", requirement: "required", min: 0 }),
]);

const teacherLpFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "teacher", label: "老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "documentUrl", label: "文档 URL", control: "url", requirement: "optional" }),
  Object.freeze({ key: "modificationRequirements", label: "修改要求", control: "textarea", requirement: "optional" }),
]);

const teacherChangeTrialFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "originalTeacher", label: "原老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "newTeacher", label: "新老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "changeReason", label: "更换原因", control: "textarea", requirement: "required" }),
  Object.freeze({ key: "trialInformation", label: "试听信息", control: "textarea", requirement: "required" }),
]);

const substituteTeacherFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "originalTeacher", label: "原老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "substituteTeacher", label: "代课老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "coverageStartDate", label: "覆盖开始日期", control: "date", requirement: "required" }),
  Object.freeze({ key: "coverageEndDate", label: "覆盖结束日期", control: "date", requirement: "required" }),
  Object.freeze({ key: "handoverNotes", label: "交接说明", control: "textarea", requirement: "required" }),
]);

const enrollmentHandoverFieldSchema: readonly LpFieldSchema[] = Object.freeze([
  Object.freeze({ key: "planner", label: "规划老师", control: "text", requirement: "required" }),
  Object.freeze({ key: "coursePackage", label: "课程 / 课包", control: "text", requirement: "required" }),
  Object.freeze({ key: "subject", label: "科目", control: "text", requirement: "required" }),
  Object.freeze({ key: "enrollmentHandoverNotes", label: "报名交接说明", control: "textarea", requirement: "required" }),
]);

function schema(
  type: LpWorkflowType,
  typeSpecificFieldsDocumented: boolean,
  typeSpecificFields: readonly LpFieldSchema[] = [],
): LpWorkflowSchema {
  return Object.freeze({
    type,
    fields: Object.freeze([...commonFieldSchema, ...typeSpecificFields]),
    typeSpecificFieldsDocumented,
  });
}

export const LP_WORKFLOW_SCHEMAS: Readonly<Record<LpWorkflowType, LpWorkflowSchema>> = Object.freeze({
  "试听 LP": schema("试听 LP", true, trialFieldSchema),
  "老师新 LP": schema("老师新 LP", true, teacherLpFieldSchema),
  "老师 LP 修改": schema("老师 LP 修改", true, teacherLpFieldSchema),
  "换老师试听": schema("换老师试听", true, teacherChangeTrialFieldSchema),
  "代课 LP": schema("代课 LP", true, substituteTeacherFieldSchema),
  "学生直报（无试听）": schema(
    "学生直报（无试听）",
    true,
    Object.freeze([...trialFieldSchema, ...directEnrollmentHoursSchema]),
  ),
  "学生报名交接": schema("学生报名交接", true, enrollmentHandoverFieldSchema),
});

export function getLpWorkflowSchema(type: LpWorkflowType): LpWorkflowSchema {
  return LP_WORKFLOW_SCHEMAS[type];
}

export const LP_STAGES = ["待资料", "写作中", "待审核", "需修改", "已发老师", "待备课确认", "完成"] as const;
export type LpStage = (typeof LP_STAGES)[number];

/** Business outcome is deliberately independent from the production stage. */
export const LP_RESULT_STATUSES = [
  "试听成功",
  "试听失败",
  "有希望报名",
  "试听未进行",
  "在读试听成功",
  "在读试听失败",
] as const;
export type LpResultStatus = (typeof LP_RESULT_STATUSES)[number];

const TRIAL_RESULT_STATUSES = new Set<LpResultStatus>(["试听成功", "试听失败", "有希望报名", "试听未进行"]);
const ENROLLED_TRIAL_RESULT_STATUSES = new Set<LpResultStatus>(["在读试听成功", "在读试听失败"]);

export function allowedLpResultStatuses(type: LpWorkflowType): readonly LpResultStatus[] {
  if (type === "试听 LP") return LP_RESULT_STATUSES.filter((status) => TRIAL_RESULT_STATUSES.has(status));
  if (type === "换老师试听") return LP_RESULT_STATUSES.filter((status) => ENROLLED_TRIAL_RESULT_STATUSES.has(status));
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
  for (const key of ["responsibleOperations", "specifiedContentStatus", "preparationFollowUp"]) requireText(fields, key);
  if (fields.isUniversityStudent !== true && fields.isUniversityStudent !== false) {
    throw new Error("isUniversityStudent must be a boolean");
  }
  if (fields.isUniversityStudent) {
    requireText(fields, "universityMajor");
    requireText(fields, "universityYear");
  }

  if (type === "试听 LP" || type === "学生直报（无试听）") {
    for (const key of ["assignedTeacher", "subject", "oneSentenceDescription", "locationTimezone", "contactPerson"]) requireText(fields, key);
  }
  if (type === "学生直报（无试听）") {
    for (const key of ["purchasedHours", "bonusHours"]) {
      const value = fields[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
    }
  }
  if (type === "老师新 LP" || type === "老师 LP 修改") {
    requireText(fields, "teacher");
    requireText(fields, "subject");
    optionalText(fields, "documentUrl");
    optionalText(fields, "modificationRequirements");
    if (typeof fields.documentUrl === "string") validateLpDocumentUrl(fields.documentUrl);
  }
  if (type === "换老师试听") {
    for (const key of ["originalTeacher", "newTeacher", "subject", "changeReason", "trialInformation"]) requireText(fields, key);
  }
  if (type === "代课 LP") {
    for (const key of ["originalTeacher", "substituteTeacher", "subject", "coverageStartDate", "coverageEndDate", "handoverNotes"]) requireText(fields, key);
    const start = validateLpDate(String(fields.coverageStartDate), "coverageStartDate");
    const end = validateLpDate(String(fields.coverageEndDate), "coverageEndDate");
    if (end < start) throw new Error("coverageEndDate must not be before coverageStartDate");
  }
  if (type === "学生报名交接") {
    for (const key of ["planner", "coursePackage", "subject", "enrollmentHandoverNotes"]) requireText(fields, key);
  }
  return immutableFields(fields);
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

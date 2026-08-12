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

/**
 * Types whose group templates were not included intentionally expose only the
 * fields confirmed by the requirements document. They can be extended once
 * those templates are available without inventing business fields here.
 */
export type LpWorkflowFieldsByType = {
  "试听 LP": TrialLpFields;
  "老师新 LP": LpCommonFields;
  "老师 LP 修改": LpCommonFields;
  "换老师试听": LpCommonFields;
  "代课 LP": LpCommonFields;
  "学生直报（无试听）": DirectEnrollmentLpFields;
  "学生报名交接": LpCommonFields;
};

export type LpFieldControl = "text" | "textarea" | "select" | "number" | "boolean";
export type LpFieldRequirement = "required" | "optional" | "university-only";

export type LpFieldSchema = Readonly<{
  key: keyof DirectEnrollmentLpFields;
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
  "老师新 LP": schema("老师新 LP", false),
  "老师 LP 修改": schema("老师 LP 修改", false),
  "换老师试听": schema("换老师试听", false),
  "代课 LP": schema("代课 LP", false),
  "学生直报（无试听）": schema(
    "学生直报（无试听）",
    true,
    Object.freeze([...trialFieldSchema, ...directEnrollmentHoursSchema]),
  ),
  "学生报名交接": schema("学生报名交接", false),
});

export function getLpWorkflowSchema(type: LpWorkflowType): LpWorkflowSchema {
  return LP_WORKFLOW_SCHEMAS[type];
}

export const LP_STAGES = ["待资料", "写作中", "待审核", "需修改", "已发老师", "待备课确认", "完成"] as const;
export type LpStage = (typeof LP_STAGES)[number];

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

export type LpWorkflowRecord = Readonly<{
  id: string;
  type: LpWorkflowType;
  stage: LpStage;
  fields: LpFieldValues;
  revisionNumber: number;
  revisions: readonly LpRevision[];
  audit: readonly LpStageAuditEntry[];
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

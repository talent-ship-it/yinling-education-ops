"use client";

import { useId, useState, type ChangeEvent } from "react";

import {
  LP_CONTACT_OPTIONS,
  LP_WORKFLOW_TYPES,
  PREPARATION_FOLLOW_UP_OPTIONS,
  SPECIFIED_CONTENT_STATUSES,
  type DirectEnrollmentLpFields,
  type LpCommonFields,
  type LpRevision,
  type LpStageAuditEntry,
  type LpWorkflowFieldsByType,
  type LpWorkflowType,
  type TrialLpFields,
} from "../lib/lp-workflows";

export const LP_WORKFLOW_FORM_NAMES = Object.freeze({
  workflowType: "workflowType",
  responsibleOperations: "responsibleOperations",
  specifiedContentStatus: "specifiedContentStatus",
  specialNotes: "specialNotes",
  preparationFollowUp: "preparationFollowUp",
  isUniversityStudent: "isUniversityStudent",
  universityMajor: "universityMajor",
  universityYear: "universityYear",
  assignedTeacher: "assignedTeacher",
  subject: "subject",
  oneSentenceDescription: "oneSentenceDescription",
  locationTimezone: "locationTimezone",
  contactPerson: "contactPerson",
  purchasedHours: "purchasedHours",
  bonusHours: "bonusHours",
} as const);

type LpWorkflowFormName = (typeof LP_WORKFLOW_FORM_NAMES)[keyof typeof LP_WORKFLOW_FORM_NAMES];

export type ParsedLpWorkflowForm = {
  [Type in LpWorkflowType]: Readonly<{
    workflowType: Type;
    fields: LpWorkflowFieldsByType[Type];
  }>;
}[LpWorkflowType];

export class LpWorkflowFormDataError extends Error {
  readonly fieldName: LpWorkflowFormName;

  constructor(fieldName: LpWorkflowFormName, message: string) {
    super(message);
    this.name = "LpWorkflowFormDataError";
    this.fieldName = fieldName;
  }
}

function stringValue(formData: FormData, fieldName: LpWorkflowFormName) {
  const value = formData.get(fieldName);
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(formData: FormData, fieldName: LpWorkflowFormName) {
  const value = stringValue(formData, fieldName);
  if (!value) throw new LpWorkflowFormDataError(fieldName, `请填写${fieldName}`);
  return value;
}

function enumValue<const Value extends string>(
  formData: FormData,
  fieldName: LpWorkflowFormName,
  values: readonly Value[],
): Value {
  const value = stringValue(formData, fieldName);
  if (!values.includes(value as Value)) {
    throw new LpWorkflowFormDataError(fieldName, `${fieldName}选项无效`);
  }
  return value as Value;
}

function nonNegativeNumber(formData: FormData, fieldName: LpWorkflowFormName) {
  const source = requiredString(formData, fieldName);
  const value = Number(source);
  if (!Number.isFinite(value) || value < 0) {
    throw new LpWorkflowFormDataError(fieldName, `${fieldName}必须是大于或等于 0 的数字`);
  }
  return value;
}

function checked(formData: FormData, fieldName: LpWorkflowFormName) {
  const value = stringValue(formData, fieldName).toLocaleLowerCase();
  return value === "true" || value === "1" || value === "on" || value === "yes";
}

function parseCommonFields(formData: FormData): LpCommonFields {
  const isUniversityStudent = checked(formData, LP_WORKFLOW_FORM_NAMES.isUniversityStudent);
  const specialNotes = stringValue(formData, LP_WORKFLOW_FORM_NAMES.specialNotes);

  return {
    responsibleOperations: requiredString(formData, LP_WORKFLOW_FORM_NAMES.responsibleOperations),
    specifiedContentStatus: enumValue(
      formData,
      LP_WORKFLOW_FORM_NAMES.specifiedContentStatus,
      SPECIFIED_CONTENT_STATUSES,
    ),
    ...(specialNotes ? { specialNotes } : {}),
    preparationFollowUp: enumValue(
      formData,
      LP_WORKFLOW_FORM_NAMES.preparationFollowUp,
      PREPARATION_FOLLOW_UP_OPTIONS,
    ),
    isUniversityStudent,
    ...(isUniversityStudent
      ? {
          universityMajor: requiredString(formData, LP_WORKFLOW_FORM_NAMES.universityMajor),
          universityYear: requiredString(formData, LP_WORKFLOW_FORM_NAMES.universityYear),
        }
      : {}),
  };
}

function parseTrialFields(formData: FormData, common: LpCommonFields): TrialLpFields {
  return {
    ...common,
    assignedTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.assignedTeacher),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    oneSentenceDescription: requiredString(formData, LP_WORKFLOW_FORM_NAMES.oneSentenceDescription),
    locationTimezone: requiredString(formData, LP_WORKFLOW_FORM_NAMES.locationTimezone),
    contactPerson: enumValue(formData, LP_WORKFLOW_FORM_NAMES.contactPerson, LP_CONTACT_OPTIONS),
  };
}

/** Parses only fields confirmed for the selected workflow type; stale hidden controls are ignored. */
export function parseLpWorkflowFormData(formData: FormData): ParsedLpWorkflowForm {
  const workflowType = enumValue(formData, LP_WORKFLOW_FORM_NAMES.workflowType, LP_WORKFLOW_TYPES);
  const common = parseCommonFields(formData);

  if (workflowType === "试听 LP") {
    return { workflowType, fields: parseTrialFields(formData, common) };
  }

  if (workflowType === "学生直报（无试听）") {
    const fields: DirectEnrollmentLpFields = {
      ...parseTrialFields(formData, common),
      purchasedHours: nonNegativeNumber(formData, LP_WORKFLOW_FORM_NAMES.purchasedHours),
      bonusHours: nonNegativeNumber(formData, LP_WORKFLOW_FORM_NAMES.bonusHours),
    };
    return { workflowType, fields };
  }

  switch (workflowType) {
    case "老师新 LP":
    case "老师 LP 修改":
    case "换老师试听":
    case "代课 LP":
    case "学生报名交接":
      return { workflowType, fields: common };
  }
}

export type LpFormOption = Readonly<{ value: string; label?: string }>;

export type LpWorkflowFieldsProps = Readonly<{
  initialType?: LpWorkflowType;
  initialValues?: Partial<DirectEnrollmentLpFields>;
  responsibleOperationsOptions?: readonly LpFormOption[];
  teacherOptions?: readonly LpFormOption[];
  subjectOptions?: readonly LpFormOption[];
  timezoneOptions?: readonly LpFormOption[];
  onTypeChange?: (type: LpWorkflowType) => void;
}>;

function OptionInput({
  name,
  defaultValue,
  options,
  listId,
  required = true,
}: Readonly<{
  name: LpWorkflowFormName;
  defaultValue?: string;
  options?: readonly LpFormOption[];
  listId: string;
  required?: boolean;
}>) {
  return <>
    <input name={name} defaultValue={defaultValue} list={options?.length ? listId : undefined} required={required} />
    {options?.length ? <datalist id={listId}>
      {options.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}
    </datalist> : null}
  </>;
}

function SelectOrInput({
  name,
  defaultValue,
  options,
}: Readonly<{
  name: LpWorkflowFormName;
  defaultValue?: string;
  options?: readonly LpFormOption[];
}>) {
  if (!options?.length) return <input name={name} defaultValue={defaultValue} required />;
  return <select name={name} defaultValue={defaultValue || options[0]?.value} required>
    {options.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}
  </select>;
}

/** Fields intended to be placed directly inside the existing `.form-grid` form. */
export function LpWorkflowFields({
  initialType = "试听 LP",
  initialValues = {},
  responsibleOperationsOptions,
  teacherOptions,
  subjectOptions,
  timezoneOptions,
  onTypeChange,
}: LpWorkflowFieldsProps) {
  const [workflowType, setWorkflowType] = useState<LpWorkflowType>(initialType);
  const [isUniversityStudent, setIsUniversityStudent] = useState(Boolean(initialValues.isUniversityStudent));
  const generatedId = useId().replaceAll(":", "");
  const showsTrialFields = workflowType === "试听 LP" || workflowType === "学生直报（无试听）";
  const showsHours = workflowType === "学生直报（无试听）";

  const changeWorkflowType = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextType = event.target.value as LpWorkflowType;
    setWorkflowType(nextType);
    onTypeChange?.(nextType);
  };

  return <>
    <label>LP 类型
      <select name={LP_WORKFLOW_FORM_NAMES.workflowType} value={workflowType} onChange={changeWorkflowType}>
        {LP_WORKFLOW_TYPES.map((type) => <option value={type} key={type}>{type}</option>)}
      </select>
    </label>
    <label>所属教务
      <SelectOrInput
        name={LP_WORKFLOW_FORM_NAMES.responsibleOperations}
        defaultValue={initialValues.responsibleOperations}
        options={responsibleOperationsOptions}
      />
    </label>

    {showsTrialFields ? <>
      <label>安排老师
        <OptionInput
          name={LP_WORKFLOW_FORM_NAMES.assignedTeacher}
          defaultValue={initialValues.assignedTeacher}
          options={teacherOptions}
          listId={`${generatedId}-lp-teachers`}
        />
      </label>
      <label>科目
        <OptionInput
          name={LP_WORKFLOW_FORM_NAMES.subject}
          defaultValue={initialValues.subject}
          options={subjectOptions}
          listId={`${generatedId}-lp-subjects`}
        />
      </label>
      <label className="span-2">一句话描述
        <textarea
          name={LP_WORKFLOW_FORM_NAMES.oneSentenceDescription}
          defaultValue={initialValues.oneSentenceDescription}
          rows={3}
          required
        />
      </label>
      <label>所在地（时区）
        <SelectOrInput
          name={LP_WORKFLOW_FORM_NAMES.locationTimezone}
          defaultValue={initialValues.locationTimezone}
          options={timezoneOptions}
        />
      </label>
      <label>对接对象
        <select name={LP_WORKFLOW_FORM_NAMES.contactPerson} defaultValue={initialValues.contactPerson ?? LP_CONTACT_OPTIONS[0]}>
          {LP_CONTACT_OPTIONS.map((option) => <option value={option} key={option}>{option}</option>)}
        </select>
      </label>
    </> : null}

    {showsHours ? <>
      <label>购买课时
        <input
          name={LP_WORKFLOW_FORM_NAMES.purchasedHours}
          type="number"
          min="0"
          step="any"
          defaultValue={initialValues.purchasedHours ?? ""}
          required
        />
      </label>
      <label>赠送课时
        <input
          name={LP_WORKFLOW_FORM_NAMES.bonusHours}
          type="number"
          min="0"
          step="any"
          defaultValue={initialValues.bonusHours ?? 0}
          required
        />
      </label>
    </> : null}

    <label>{showsTrialFields ? "家长指定内容跟进" : "指定内容"}
      <select
        name={LP_WORKFLOW_FORM_NAMES.specifiedContentStatus}
        defaultValue={initialValues.specifiedContentStatus ?? SPECIFIED_CONTENT_STATUSES[2]}
      >
        {SPECIFIED_CONTENT_STATUSES.map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    </label>
    <label>备课跟进
      <select
        name={LP_WORKFLOW_FORM_NAMES.preparationFollowUp}
        defaultValue={initialValues.preparationFollowUp ?? PREPARATION_FOLLOW_UP_OPTIONS[0]}
      >
        {PREPARATION_FOLLOW_UP_OPTIONS.map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    </label>
    <label className="span-2">指定内容备注 / 特殊情况
      <textarea name={LP_WORKFLOW_FORM_NAMES.specialNotes} defaultValue={initialValues.specialNotes} rows={3} />
    </label>
    <label className="checkbox-field span-2">
      <input
        name={LP_WORKFLOW_FORM_NAMES.isUniversityStudent}
        type="checkbox"
        value="true"
        defaultChecked={initialValues.isUniversityStudent}
        onChange={(event) => setIsUniversityStudent(event.target.checked)}
      />
      大学学生
    </label>
    {isUniversityStudent ? <>
      <label>专业
        <input name={LP_WORKFLOW_FORM_NAMES.universityMajor} defaultValue={initialValues.universityMajor} required />
      </label>
      <label>年级
        <input name={LP_WORKFLOW_FORM_NAMES.universityYear} defaultValue={initialValues.universityYear} required />
      </label>
    </> : null}
  </>;
}

export type LpRevisionHistoryProps = Readonly<{
  revisions: readonly LpRevision[];
  stageAudit?: readonly LpStageAuditEntry[];
  timeZone?: string;
}>;

function historyTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function lpRevisionDocumentUrl(revision: LpRevision) {
  const value = revision.after.documentUrl;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Compact, read-only revision and stage audit timeline. */
export function LpRevisionHistory({
  revisions,
  stageAudit = [],
  timeZone = "Australia/Melbourne",
}: LpRevisionHistoryProps) {
  const entries = [
    ...revisions.map((revision) => ({
      id: `revision-${revision.id}`,
      time: revision.changedAt,
      title: `版本 ${revision.number} · ${revision.changedBy}`,
      detail: revision.note || "内容已修订",
      tone: "purple",
      documentUrl: lpRevisionDocumentUrl(revision),
    })),
    ...stageAudit.map((entry) => ({
      id: `stage-${entry.id}`,
      time: entry.occurredAt,
      title: `${entry.fromStage} → ${entry.toStage} · ${entry.actor}`,
      detail: entry.note || "阶段已更新",
      tone: entry.toStage === "需修改" ? "amber" : entry.toStage === "完成" ? "green" : "blue",
      documentUrl: null,
    })),
  ].sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime());

  return <section className="timeline" aria-label="LP 修订历史">
    <div className="timeline-title"><strong>修订历史</strong><small>{entries.length} 条</small></div>
    {entries.length ? entries.map((entry) => <div className="timeline-item" key={entry.id}>
      <i className={entry.tone} aria-hidden="true" />
      <span><strong>{entry.title}</strong><small>{historyTime(entry.time, timeZone)} · {entry.detail}</small>{entry.documentUrl ? <a className="inline-link" href={entry.documentUrl} target="_blank" rel="noreferrer">打开版本文档</a> : null}</span>
    </div>) : <div className="empty-inline">暂无修订记录</div>}
  </section>;
}

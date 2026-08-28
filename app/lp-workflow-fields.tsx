"use client";

import { useState, type ChangeEvent } from "react";

import {
  LP_CONTACT_OPTIONS,
  LP_WORKFLOW_TYPES,
  PREPARATION_FOLLOW_UP_OPTIONS,
  SPECIFIED_CONTENT_STATUSES,
  TRIAL_LOCATION_OPTIONS,
  TRIAL_OPERATIONS,
  TRIAL_PAYMENT_METHODS,
  getLpWorkflowSchema,
  type DirectEnrollmentLpFields,
  type EnrollmentHandoverLpFields,
  type LpCommonFields,
  type LpFieldValues,
  type LpRevision,
  type LpStageAuditEntry,
  type LpWorkflowFieldsByType,
  type LpWorkflowType,
  type SubstituteTeacherLpFields,
  type TeacherChangeTrialFields,
  type TeacherLpFields,
  type TeacherLpModificationFields,
  type TrialLpFields,
  validateCompleteLpWorkflowFields,
} from "../lib/lp-workflows";
import { TRIAL_DURATIONS, TRIAL_PLANNERS } from "../lib/trial-operations";

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
  requestSentAt: "requestSentAt",
  subject: "subject",
  oneSentenceDescription: "oneSentenceDescription",
  locationTimezone: "locationTimezone",
  contactPerson: "contactPerson",
  contactParents: "contactParents",
  contactStudent: "contactStudent",
  contactNote: "contactNote",
  writingRequired: "writingRequired",
  writingNote: "writingNote",
  paperRequired: "paperRequired",
  paperNote: "paperNote",
  timeMentioned: "timeMentioned",
  preferredTime: "preferredTime",
  studentNameKnown: "studentNameKnown",
  studentName: "studentName",
  preparationNote: "preparationNote",
  trialDurationMinutes: "trialDurationMinutes",
  trialDurationNote: "trialDurationNote",
  trialPaymentMethod: "trialPaymentMethod",
  purchasedHours: "purchasedHours",
  bonusHours: "bonusHours",
  lessonFrequency: "lessonFrequency",
  coursesAndTeachers: "coursesAndTeachers",
  teacher: "teacher",
  documentUrl: "documentUrl",
  modificationRequirements: "modificationRequirements",
  additionalNotes: "additionalNotes",
  basicInfo: "basicInfo",
  studentFoundation: "studentFoundation",
  learningGoal: "learningGoal",
  recommendedResources: "recommendedResources",
  teachingLanguage: "teachingLanguage",
  firstLessonContent: "firstLessonContent",
  lessonSchedule: "lessonSchedule",
  comments: "comments",
  originalTeacher: "originalTeacher",
  newTeacher: "newTeacher",
  changeReason: "changeReason",
  trialInformation: "trialInformation",
  handoverFromTeacher: "handoverFromTeacher",
  materialsAndContentTaught: "materialsAndContentTaught",
  recommendedNextContent: "recommendedNextContent",
  studentStrengthsAndLearningProfile: "studentStrengthsAndLearningProfile",
  lastHomework: "lastHomework",
  lastLessonRecordingUrl: "lastLessonRecordingUrl",
  substituteTeacher: "substituteTeacher",
  coverageStartDate: "coverageStartDate",
  coverageEndDate: "coverageEndDate",
  handoverNotes: "handoverNotes",
  allocatedLessonContentAndResources: "allocatedLessonContentAndResources",
  planner: "planner",
  coursePackage: "coursePackage",
  enrollmentHandoverNotes: "enrollmentHandoverNotes",
} as const);

export type LpWorkflowFormName =
  (typeof LP_WORKFLOW_FORM_NAMES)[keyof typeof LP_WORKFLOW_FORM_NAMES];

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

function yesNoValue(formData: FormData, fieldName: LpWorkflowFormName) {
  return enumValue(formData, fieldName, ["是", "否"] as const) === "是";
}

function instantValue(formData: FormData, fieldName: LpWorkflowFormName) {
  const source = requiredString(formData, fieldName);
  const value = new Date(source);
  if (Number.isNaN(value.valueOf())) {
    throw new LpWorkflowFormDataError(fieldName, `${fieldName}时间无效`);
  }
  return value.toISOString();
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
  const timeMentioned = yesNoValue(formData, LP_WORKFLOW_FORM_NAMES.timeMentioned);
  const studentNameKnown = yesNoValue(formData, LP_WORKFLOW_FORM_NAMES.studentNameKnown);
  const contactParents = checked(formData, LP_WORKFLOW_FORM_NAMES.contactParents);
  const contactStudent = checked(formData, LP_WORKFLOW_FORM_NAMES.contactStudent);
  if (!contactParents && !contactStudent) {
    throw new LpWorkflowFormDataError(LP_WORKFLOW_FORM_NAMES.contactParents, "请至少选择家长或学生本人作为对接对象");
  }
  const trialDurationMinutes = Number(requiredString(formData, LP_WORKFLOW_FORM_NAMES.trialDurationMinutes));
  if (!TRIAL_DURATIONS.includes(trialDurationMinutes as 45 | 60)) {
    throw new LpWorkflowFormDataError(LP_WORKFLOW_FORM_NAMES.trialDurationMinutes, "试听时长只能选择 45 或 60 分钟");
  }
  const optional = (fieldName: LpWorkflowFormName) => stringValue(formData, fieldName);
  const contactNote = optional(LP_WORKFLOW_FORM_NAMES.contactNote);
  const writingNote = optional(LP_WORKFLOW_FORM_NAMES.writingNote);
  const paperNote = optional(LP_WORKFLOW_FORM_NAMES.paperNote);
  const preparationNote = optional(LP_WORKFLOW_FORM_NAMES.preparationNote);
  const trialDurationNote = optional(LP_WORKFLOW_FORM_NAMES.trialDurationNote);
  return {
    ...common,
    planner: enumValue(formData, LP_WORKFLOW_FORM_NAMES.planner, TRIAL_PLANNERS),
    requestSentAt: instantValue(formData, LP_WORKFLOW_FORM_NAMES.requestSentAt),
    assignedTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.assignedTeacher),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    oneSentenceDescription: requiredString(formData, LP_WORKFLOW_FORM_NAMES.oneSentenceDescription),
    locationTimezone: requiredString(formData, LP_WORKFLOW_FORM_NAMES.locationTimezone),
    contactPerson: contactParents ? "家长" : "学生本人",
    contactParents,
    contactStudent,
    ...(contactNote ? { contactNote } : {}),
    writingRequired: yesNoValue(formData, LP_WORKFLOW_FORM_NAMES.writingRequired),
    ...(writingNote ? { writingNote } : {}),
    paperRequired: yesNoValue(formData, LP_WORKFLOW_FORM_NAMES.paperRequired),
    ...(paperNote ? { paperNote } : {}),
    timeMentioned,
    ...(timeMentioned
      ? { preferredTime: requiredString(formData, LP_WORKFLOW_FORM_NAMES.preferredTime) }
      : {}),
    studentNameKnown,
    ...(studentNameKnown
      ? { studentName: requiredString(formData, LP_WORKFLOW_FORM_NAMES.studentName) }
      : {}),
    ...(preparationNote ? { preparationNote } : {}),
    trialDurationMinutes: trialDurationMinutes as 45 | 60,
    ...(trialDurationNote ? { trialDurationNote } : {}),
    trialPaymentMethod: enumValue(
      formData,
      LP_WORKFLOW_FORM_NAMES.trialPaymentMethod,
      TRIAL_PAYMENT_METHODS,
    ),
  };
}

function parseDirectEnrollmentBase(formData: FormData, common: LpCommonFields) {
  const timeMentioned = yesNoValue(formData, LP_WORKFLOW_FORM_NAMES.timeMentioned);
  return {
    ...common,
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    oneSentenceDescription: requiredString(formData, LP_WORKFLOW_FORM_NAMES.oneSentenceDescription),
    locationTimezone: requiredString(formData, LP_WORKFLOW_FORM_NAMES.locationTimezone),
    contactPerson: enumValue(formData, LP_WORKFLOW_FORM_NAMES.contactPerson, LP_CONTACT_OPTIONS),
    timeMentioned,
    ...(timeMentioned
      ? { preferredTime: requiredString(formData, LP_WORKFLOW_FORM_NAMES.preferredTime) }
      : {}),
  };
}

function optionalString(formData: FormData, fieldName: LpWorkflowFormName) {
  const value = stringValue(formData, fieldName);
  return value || undefined;
}

function parseTeacherLpFields(formData: FormData, common: LpCommonFields): TeacherLpFields {
  const documentUrl = optionalString(formData, LP_WORKFLOW_FORM_NAMES.documentUrl);
  const comments = optionalString(formData, LP_WORKFLOW_FORM_NAMES.comments);
  return {
    ...common,
    teacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.teacher),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    ...(documentUrl ? { documentUrl } : {}),
    additionalNotes: requiredString(formData, LP_WORKFLOW_FORM_NAMES.additionalNotes),
    basicInfo: requiredString(formData, LP_WORKFLOW_FORM_NAMES.basicInfo),
    studentFoundation: requiredString(formData, LP_WORKFLOW_FORM_NAMES.studentFoundation),
    learningGoal: requiredString(formData, LP_WORKFLOW_FORM_NAMES.learningGoal),
    recommendedResources: requiredString(formData, LP_WORKFLOW_FORM_NAMES.recommendedResources),
    teachingLanguage: requiredString(formData, LP_WORKFLOW_FORM_NAMES.teachingLanguage),
    firstLessonContent: requiredString(formData, LP_WORKFLOW_FORM_NAMES.firstLessonContent),
    lessonSchedule: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lessonSchedule),
    ...(comments ? { comments } : {}),
  };
}

function parseTeacherLpModificationFields(
  formData: FormData,
  common: LpCommonFields,
): TeacherLpModificationFields {
  const documentUrl = optionalString(formData, LP_WORKFLOW_FORM_NAMES.documentUrl);
  return {
    ...common,
    teacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.teacher),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    ...(documentUrl ? { documentUrl } : {}),
    modificationRequirements: requiredString(
      formData,
      LP_WORKFLOW_FORM_NAMES.modificationRequirements,
    ),
  };
}

function parseTeacherChangeTrialFields(
  formData: FormData,
  common: LpCommonFields,
): TeacherChangeTrialFields {
  return {
    ...common,
    originalTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.originalTeacher),
    newTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.newTeacher),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    changeReason: requiredString(formData, LP_WORKFLOW_FORM_NAMES.changeReason),
    trialInformation: requiredString(formData, LP_WORKFLOW_FORM_NAMES.trialInformation),
    handoverFromTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.handoverFromTeacher),
    materialsAndContentTaught: requiredString(formData, LP_WORKFLOW_FORM_NAMES.materialsAndContentTaught),
    recommendedNextContent: requiredString(formData, LP_WORKFLOW_FORM_NAMES.recommendedNextContent),
    studentStrengthsAndLearningProfile: requiredString(
      formData,
      LP_WORKFLOW_FORM_NAMES.studentStrengthsAndLearningProfile,
    ),
    lastHomework: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lastHomework),
    lastLessonRecordingUrl: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lastLessonRecordingUrl),
  };
}

function parseSubstituteTeacherFields(
  formData: FormData,
  common: LpCommonFields,
): SubstituteTeacherLpFields {
  const comments = optionalString(formData, LP_WORKFLOW_FORM_NAMES.comments);
  return {
    ...common,
    originalTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.originalTeacher),
    substituteTeacher: requiredString(formData, LP_WORKFLOW_FORM_NAMES.substituteTeacher),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    coverageStartDate: requiredString(formData, LP_WORKFLOW_FORM_NAMES.coverageStartDate),
    coverageEndDate: requiredString(formData, LP_WORKFLOW_FORM_NAMES.coverageEndDate),
    additionalNotes: requiredString(formData, LP_WORKFLOW_FORM_NAMES.additionalNotes),
    basicInfo: requiredString(formData, LP_WORKFLOW_FORM_NAMES.basicInfo),
    studentFoundation: requiredString(formData, LP_WORKFLOW_FORM_NAMES.studentFoundation),
    learningGoal: requiredString(formData, LP_WORKFLOW_FORM_NAMES.learningGoal),
    allocatedLessonContentAndResources: requiredString(
      formData,
      LP_WORKFLOW_FORM_NAMES.allocatedLessonContentAndResources,
    ),
    teachingLanguage: requiredString(formData, LP_WORKFLOW_FORM_NAMES.teachingLanguage),
    ...(comments ? { comments } : {}),
    lastHomework: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lastHomework),
    lastLessonRecordingUrl: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lastLessonRecordingUrl),
  };
}

function parseEnrollmentHandoverFields(
  formData: FormData,
  common: LpCommonFields,
): EnrollmentHandoverLpFields {
  const enrollmentHandoverNotes = optionalString(
    formData,
    LP_WORKFLOW_FORM_NAMES.enrollmentHandoverNotes,
  );
  const fields: EnrollmentHandoverLpFields = {
    ...common,
    planner: requiredString(formData, LP_WORKFLOW_FORM_NAMES.planner),
    coursePackage: requiredString(formData, LP_WORKFLOW_FORM_NAMES.coursePackage),
    subject: requiredString(formData, LP_WORKFLOW_FORM_NAMES.subject),
    purchasedHours: nonNegativeNumber(formData, LP_WORKFLOW_FORM_NAMES.purchasedHours),
    bonusHours: nonNegativeNumber(formData, LP_WORKFLOW_FORM_NAMES.bonusHours),
    lessonFrequency: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lessonFrequency),
    preferredTime: requiredString(formData, LP_WORKFLOW_FORM_NAMES.preferredTime),
    coursesAndTeachers: requiredString(formData, LP_WORKFLOW_FORM_NAMES.coursesAndTeachers),
    ...(enrollmentHandoverNotes ? { enrollmentHandoverNotes } : {}),
  };
  if (fields.purchasedHours + fields.bonusHours <= 0) {
    throw new LpWorkflowFormDataError(
      LP_WORKFLOW_FORM_NAMES.purchasedHours,
      "购买课时与赠送课时合计必须大于 0",
    );
  }
  return fields;
}

function validateParsedFields<Type extends LpWorkflowType>(
  workflowType: Type,
  fields: LpWorkflowFieldsByType[Type],
): void {
  validateCompleteLpWorkflowFields(workflowType, fields as unknown as LpFieldValues);
}

/** Parses only fields confirmed for the selected workflow type; stale hidden controls are ignored. */
export function parseLpWorkflowFormData(formData: FormData): ParsedLpWorkflowForm {
  const workflowType = enumValue(formData, LP_WORKFLOW_FORM_NAMES.workflowType, LP_WORKFLOW_TYPES);
  const common = parseCommonFields(formData);

  if (workflowType === "试听 LP") {
    const fields = parseTrialFields(formData, common);
    validateParsedFields(workflowType, fields);
    return { workflowType, fields };
  }

  if (workflowType === "学生直报（无试听）") {
    const fields: DirectEnrollmentLpFields = {
      ...parseDirectEnrollmentBase(formData, common),
      purchasedHours: nonNegativeNumber(formData, LP_WORKFLOW_FORM_NAMES.purchasedHours),
      bonusHours: nonNegativeNumber(formData, LP_WORKFLOW_FORM_NAMES.bonusHours),
      lessonFrequency: requiredString(formData, LP_WORKFLOW_FORM_NAMES.lessonFrequency),
      coursesAndTeachers: requiredString(formData, LP_WORKFLOW_FORM_NAMES.coursesAndTeachers),
    };
    if (fields.purchasedHours + fields.bonusHours <= 0) {
      throw new LpWorkflowFormDataError(
        LP_WORKFLOW_FORM_NAMES.purchasedHours,
        "购买课时与赠送课时合计必须大于 0",
      );
    }
    validateParsedFields(workflowType, fields);
    return { workflowType, fields };
  }

  switch (workflowType) {
    case "老师新 LP": {
      const fields = parseTeacherLpFields(formData, common);
      validateParsedFields(workflowType, fields);
      return { workflowType, fields };
    }
    case "老师 LP 修改": {
      const fields = parseTeacherLpModificationFields(formData, common);
      validateParsedFields(workflowType, fields);
      return { workflowType, fields };
    }
    case "换老师试听": {
      const fields = parseTeacherChangeTrialFields(formData, common);
      validateParsedFields(workflowType, fields);
      return { workflowType, fields };
    }
    case "代课 LP": {
      const fields = parseSubstituteTeacherFields(formData, common);
      validateParsedFields(workflowType, fields);
      return { workflowType, fields };
    }
    case "学生报名交接": {
      const fields = parseEnrollmentHandoverFields(formData, common);
      validateParsedFields(workflowType, fields);
      return { workflowType, fields };
    }
  }
}

export type LpFormOption = Readonly<{ value: string; label?: string }>;

const trialOperationsOptions = TRIAL_OPERATIONS.map((value) => Object.freeze({ value }));
const trialLocationOptions = TRIAL_LOCATION_OPTIONS.map((value) => Object.freeze({ value }));

export type LpWorkflowFieldsProps = Readonly<{
  initialType?: LpWorkflowType;
  initialValues?: Partial<TrialLpFields> & Partial<
    DirectEnrollmentLpFields &
    TeacherLpFields &
    TeacherLpModificationFields &
    TeacherChangeTrialFields &
    SubstituteTeacherLpFields &
    EnrollmentHandoverLpFields
  >;
  responsibleOperationsOptions?: readonly LpFormOption[];
  teacherOptions?: readonly LpFormOption[];
  subjectOptions?: readonly LpFormOption[];
  timezoneOptions?: readonly LpFormOption[];
  plannerOptions?: readonly LpFormOption[];
  coursePackageOptions?: readonly LpFormOption[];
  onTypeChange?: (type: LpWorkflowType) => void;
}>;

function SelectOrInput({
  name,
  defaultValue,
  options,
  required = true,
  type = "text",
}: Readonly<{
  name: LpWorkflowFormName;
  defaultValue?: string;
  options?: readonly LpFormOption[];
  required?: boolean;
  type?: "text" | "url" | "date";
}>) {
  if (!options?.length) {
    return <input name={name} type={type} defaultValue={defaultValue} required={required} />;
  }
  return <select name={name} defaultValue={defaultValue || options[0]?.value} required={required}>
    {options.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}
  </select>;
}

function DatalistInput({
  name,
  defaultValue,
  options,
  required = true,
}: Readonly<{
  name: LpWorkflowFormName;
  defaultValue?: string;
  options?: readonly LpFormOption[];
  required?: boolean;
}>) {
  const listId = `lp-options-${name}`;
  return <>
    <input name={name} list={options?.length ? listId : undefined} defaultValue={defaultValue} required={required} />
    {options?.length ? <datalist id={listId}>{options.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}</datalist> : null}
  </>;
}

function localDateTimeDefault(value?: string) {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      const local = new Date(parsed.valueOf() - parsed.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }
  }
  const now = new Date();
  return new Date(now.valueOf() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function TeacherField({
  label,
  name,
  defaultValue,
  teacherOptions,
}: Readonly<{
  label: string;
  name: LpWorkflowFormName;
  defaultValue?: string;
  teacherOptions?: readonly LpFormOption[];
}>) {
  return <label>{label}
    <SelectOrInput name={name} defaultValue={defaultValue} options={teacherOptions} />
  </label>;
}

function SubjectField({
  defaultValue,
  subjectOptions,
}: Readonly<{
  defaultValue?: string;
  subjectOptions?: readonly LpFormOption[];
}>) {
  return <label>科目
    <SelectOrInput
      name={LP_WORKFLOW_FORM_NAMES.subject}
      defaultValue={defaultValue}
      options={subjectOptions}
    />
  </label>;
}

/** Fields intended to be placed directly inside the existing `.form-grid` form. */
export function LpWorkflowFields({
  initialType = "试听 LP",
  initialValues = {},
  responsibleOperationsOptions,
  teacherOptions,
  subjectOptions,
  timezoneOptions,
  plannerOptions,
  coursePackageOptions,
  onTypeChange,
}: LpWorkflowFieldsProps) {
  const [workflowType, setWorkflowType] = useState<LpWorkflowType>(initialType);
  const [isUniversityStudent, setIsUniversityStudent] = useState(Boolean(initialValues.isUniversityStudent));
  const [timeMentioned, setTimeMentioned] = useState(Boolean(initialValues.timeMentioned));
  const [studentNameKnown, setStudentNameKnown] = useState(Boolean(initialValues.studentNameKnown));
  const showsTrialFields = workflowType === "试听 LP" || workflowType === "学生直报（无试听）";
  const showsHours = workflowType === "学生直报（无试听）";
  const showsTeacherLp = workflowType === "老师新 LP" || workflowType === "老师 LP 修改";
  const showsTeacherChange = workflowType === "换老师试听";
  const showsSubstitute = workflowType === "代课 LP";
  const showsEnrollmentHandover = workflowType === "学生报名交接";

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
        options={workflowType === "试听 LP" ? trialOperationsOptions : responsibleOperationsOptions}
      />
    </label>

    {showsTrialFields ? <>
      {workflowType === "试听 LP" ? <>
        <label>课程规划老师
          <select name={LP_WORKFLOW_FORM_NAMES.planner} defaultValue={initialValues.planner ?? TRIAL_PLANNERS[0]} required>
            {TRIAL_PLANNERS.map((option) => <option value={option} key={option}>{option === "Tara" ? "Tara（试听学员 A）" : option === "Eileen" ? "Eileen（试听学员 B）" : "Abby（试听学员 C）"}</option>)}
          </select>
        </label>
        <label>试听 LP 交接时间
          <input name={LP_WORKFLOW_FORM_NAMES.requestSentAt} type="datetime-local" defaultValue={localDateTimeDefault(initialValues.requestSentAt)} required />
        </label>
        <label>安排老师（可自定义）
          <DatalistInput name={LP_WORKFLOW_FORM_NAMES.assignedTeacher} defaultValue={initialValues.assignedTeacher} options={teacherOptions} />
        </label>
        <label>科目（可自定义）
          <DatalistInput name={LP_WORKFLOW_FORM_NAMES.subject} defaultValue={initialValues.subject} options={subjectOptions} />
        </label>
      </> : <SubjectField defaultValue={initialValues.subject} subjectOptions={subjectOptions} />}
      <label className="span-2">一句话描述
        <textarea
          name={LP_WORKFLOW_FORM_NAMES.oneSentenceDescription}
          defaultValue={initialValues.oneSentenceDescription}
          rows={3}
          required
        />
      </label>
      <label>所在地（时区）
        <DatalistInput
          name={LP_WORKFLOW_FORM_NAMES.locationTimezone}
          defaultValue={initialValues.locationTimezone}
          options={workflowType === "试听 LP" ? trialLocationOptions : timezoneOptions}
        />
      </label>
      {workflowType === "试听 LP" ? <fieldset className="span-2 lp-inline-options"><legend>对接对象（可多选）</legend>
        <label className="checkbox-field"><input name={LP_WORKFLOW_FORM_NAMES.contactParents} type="checkbox" defaultChecked={initialValues.contactParents ?? true} /> 家长</label>
        <label className="checkbox-field"><input name={LP_WORKFLOW_FORM_NAMES.contactStudent} type="checkbox" defaultChecked={initialValues.contactStudent} /> 学生本人</label>
      </fieldset> : <label>对接对象
        <select name={LP_WORKFLOW_FORM_NAMES.contactPerson} defaultValue={initialValues.contactPerson ?? LP_CONTACT_OPTIONS[0]}>
          {LP_CONTACT_OPTIONS.map((option) => <option value={option} key={option}>{option}</option>)}
        </select>
      </label>}
      {workflowType === "试听 LP" ? <>
        <label className="span-2">对接备注<textarea name={LP_WORKFLOW_FORM_NAMES.contactNote} defaultValue={initialValues.contactNote} rows={2} /></label>
        <label>需要写作
          <select name={LP_WORKFLOW_FORM_NAMES.writingRequired} defaultValue={initialValues.writingRequired ? "是" : "否"}><option value="否">否</option><option value="是">是</option></select>
        </label>
        <label>写作备注<input name={LP_WORKFLOW_FORM_NAMES.writingNote} defaultValue={initialValues.writingNote} /></label>
        <label>需要发、收试卷
          <select name={LP_WORKFLOW_FORM_NAMES.paperRequired} defaultValue={initialValues.paperRequired ? "是" : "否"}><option value="否">否</option><option value="是">是</option></select>
        </label>
        <label>试卷备注<input name={LP_WORKFLOW_FORM_NAMES.paperNote} defaultValue={initialValues.paperNote} /></label>
      </> : null}
      <label>是否提到时间
        <select
          name={LP_WORKFLOW_FORM_NAMES.timeMentioned}
          value={timeMentioned ? "是" : "否"}
          onChange={(event) => setTimeMentioned(event.target.value === "是")}
        >
          <option value="否">否</option><option value="是">是</option>
        </select>
      </label>
      {timeMentioned ? <label>偏好时间
        <input name={LP_WORKFLOW_FORM_NAMES.preferredTime} defaultValue={initialValues.preferredTime} required />
      </label> : null}
      {workflowType === "试听 LP" ? <>
        <label>是否知道学生姓名
          <select name={LP_WORKFLOW_FORM_NAMES.studentNameKnown} value={studentNameKnown ? "是" : "否"} onChange={(event) => setStudentNameKnown(event.target.value === "是")}>
            <option value="否">否</option><option value="是">是</option>
          </select>
        </label>
        {studentNameKnown ? <label>学生姓名<input name={LP_WORKFLOW_FORM_NAMES.studentName} defaultValue={initialValues.studentName} required /></label> : null}
        <label>试听时长
          <select name={LP_WORKFLOW_FORM_NAMES.trialDurationMinutes} defaultValue={initialValues.trialDurationMinutes ?? 60}>
            <option value="60">1 小时</option><option value="45">45 分钟</option>
          </select>
        </label>
        <label>时长备注<input name={LP_WORKFLOW_FORM_NAMES.trialDurationNote} defaultValue={initialValues.trialDurationNote} /></label>
        <label>试听付费方式
          <select name={LP_WORKFLOW_FORM_NAMES.trialPaymentMethod} defaultValue={initialValues.trialPaymentMethod ?? TRIAL_PAYMENT_METHODS[0]}>
            {TRIAL_PAYMENT_METHODS.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
      </> : null}
    </> : null}

    {showsTeacherLp ? <>
      <TeacherField
        label="老师"
        name={LP_WORKFLOW_FORM_NAMES.teacher}
        defaultValue={initialValues.teacher}
        teacherOptions={teacherOptions}
      />
      <SubjectField defaultValue={initialValues.subject} subjectOptions={subjectOptions} />
      <label className="span-2">文档 URL
        <input
          name={LP_WORKFLOW_FORM_NAMES.documentUrl}
          type="url"
          defaultValue={initialValues.documentUrl}
        />
      </label>
      {workflowType === "老师 LP 修改" ? <label className="span-2">修改要求
        <textarea name={LP_WORKFLOW_FORM_NAMES.modificationRequirements} defaultValue={initialValues.modificationRequirements} rows={4} required />
      </label> : <>
        <label className="span-2">补充注意事项<textarea name={LP_WORKFLOW_FORM_NAMES.additionalNotes} defaultValue={initialValues.additionalNotes} rows={3} required /></label>
        <label className="span-2">基本信息<textarea name={LP_WORKFLOW_FORM_NAMES.basicInfo} defaultValue={initialValues.basicInfo} rows={3} required /></label>
        <label className="span-2">学生基础<textarea name={LP_WORKFLOW_FORM_NAMES.studentFoundation} defaultValue={initialValues.studentFoundation} rows={3} required /></label>
        <label className="span-2">学习目的<textarea name={LP_WORKFLOW_FORM_NAMES.learningGoal} defaultValue={initialValues.learningGoal} rows={3} required /></label>
        <label className="span-2">建议资料库<textarea name={LP_WORKFLOW_FORM_NAMES.recommendedResources} defaultValue={initialValues.recommendedResources} rows={3} required /></label>
        <label>授课语言<input name={LP_WORKFLOW_FORM_NAMES.teachingLanguage} defaultValue={initialValues.teachingLanguage} required /></label>
        <label>课时计划<input name={LP_WORKFLOW_FORM_NAMES.lessonSchedule} defaultValue={initialValues.lessonSchedule} required /></label>
        <label className="span-2">试听课 / 首次课内容<textarea name={LP_WORKFLOW_FORM_NAMES.firstLessonContent} defaultValue={initialValues.firstLessonContent} rows={4} required /></label>
        <label className="span-2">备注<textarea name={LP_WORKFLOW_FORM_NAMES.comments} defaultValue={initialValues.comments} rows={2} /></label>
      </>}
    </> : null}

    {showsTeacherChange ? <>
      <TeacherField
        label="原老师"
        name={LP_WORKFLOW_FORM_NAMES.originalTeacher}
        defaultValue={initialValues.originalTeacher}
        teacherOptions={teacherOptions}
      />
      <TeacherField
        label="新老师"
        name={LP_WORKFLOW_FORM_NAMES.newTeacher}
        defaultValue={initialValues.newTeacher}
        teacherOptions={teacherOptions}
      />
      <SubjectField defaultValue={initialValues.subject} subjectOptions={subjectOptions} />
      <label className="span-2">更换原因
        <textarea
          name={LP_WORKFLOW_FORM_NAMES.changeReason}
          defaultValue={initialValues.changeReason}
          rows={3}
          required
        />
      </label>
      <label className="span-2">试听信息
        <textarea
          name={LP_WORKFLOW_FORM_NAMES.trialInformation}
          defaultValue={initialValues.trialInformation}
          rows={3}
          required
        />
      </label>
      <TeacherField label="交接老师" name={LP_WORKFLOW_FORM_NAMES.handoverFromTeacher} defaultValue={initialValues.handoverFromTeacher} teacherOptions={teacherOptions} />
      <label className="span-2">已使用资料、已教内容<textarea name={LP_WORKFLOW_FORM_NAMES.materialsAndContentTaught} defaultValue={initialValues.materialsAndContentTaught} rows={4} required /></label>
      <label className="span-2">建议后续内容与资料<textarea name={LP_WORKFLOW_FORM_NAMES.recommendedNextContent} defaultValue={initialValues.recommendedNextContent} rows={4} required /></label>
      <label className="span-2">学生强项、进步方向与学习特点<textarea name={LP_WORKFLOW_FORM_NAMES.studentStrengthsAndLearningProfile} defaultValue={initialValues.studentStrengthsAndLearningProfile} rows={4} required /></label>
      <label className="span-2">上节课作业<textarea name={LP_WORKFLOW_FORM_NAMES.lastHomework} defaultValue={initialValues.lastHomework} rows={3} required /></label>
      <label className="span-2">上次课录像 URL<input type="url" name={LP_WORKFLOW_FORM_NAMES.lastLessonRecordingUrl} defaultValue={initialValues.lastLessonRecordingUrl} required /></label>
    </> : null}

    {showsSubstitute ? <>
      <TeacherField
        label="原老师"
        name={LP_WORKFLOW_FORM_NAMES.originalTeacher}
        defaultValue={initialValues.originalTeacher}
        teacherOptions={teacherOptions}
      />
      <TeacherField
        label="代课老师"
        name={LP_WORKFLOW_FORM_NAMES.substituteTeacher}
        defaultValue={initialValues.substituteTeacher}
        teacherOptions={teacherOptions}
      />
      <SubjectField defaultValue={initialValues.subject} subjectOptions={subjectOptions} />
      <label>开始日期
        <input
          name={LP_WORKFLOW_FORM_NAMES.coverageStartDate}
          type="date"
          defaultValue={initialValues.coverageStartDate}
          required
        />
      </label>
      <label>结束日期
        <input
          name={LP_WORKFLOW_FORM_NAMES.coverageEndDate}
          type="date"
          defaultValue={initialValues.coverageEndDate}
          required
        />
      </label>
      <label className="span-2">补充注意事项<textarea name={LP_WORKFLOW_FORM_NAMES.additionalNotes} defaultValue={initialValues.additionalNotes} rows={3} required /></label>
      <label className="span-2">基本信息<textarea name={LP_WORKFLOW_FORM_NAMES.basicInfo} defaultValue={initialValues.basicInfo} rows={3} required /></label>
      <label className="span-2">学生基础<textarea name={LP_WORKFLOW_FORM_NAMES.studentFoundation} defaultValue={initialValues.studentFoundation} rows={3} required /></label>
      <label className="span-2">学习目的<textarea name={LP_WORKFLOW_FORM_NAMES.learningGoal} defaultValue={initialValues.learningGoal} rows={3} required /></label>
      <label className="span-2">指定代课内容与资料<textarea name={LP_WORKFLOW_FORM_NAMES.allocatedLessonContentAndResources} defaultValue={initialValues.allocatedLessonContentAndResources} rows={5} required /></label>
      <label>授课语言<input name={LP_WORKFLOW_FORM_NAMES.teachingLanguage} defaultValue={initialValues.teachingLanguage} required /></label>
      <label className="span-2">备注<textarea name={LP_WORKFLOW_FORM_NAMES.comments} defaultValue={initialValues.comments} rows={2} /></label>
      <label className="span-2">上节课作业<textarea name={LP_WORKFLOW_FORM_NAMES.lastHomework} defaultValue={initialValues.lastHomework} rows={3} required /></label>
      <label className="span-2">上次课录像 URL<input type="url" name={LP_WORKFLOW_FORM_NAMES.lastLessonRecordingUrl} defaultValue={initialValues.lastLessonRecordingUrl} required /></label>
    </> : null}

    {showsEnrollmentHandover ? <>
      <label>规划老师
        <SelectOrInput
          name={LP_WORKFLOW_FORM_NAMES.planner}
          defaultValue={initialValues.planner}
          options={plannerOptions}
        />
      </label>
      <label>课程 / 课包
        <SelectOrInput
          name={LP_WORKFLOW_FORM_NAMES.coursePackage}
          defaultValue={initialValues.coursePackage}
          options={coursePackageOptions}
        />
      </label>
      <SubjectField defaultValue={initialValues.subject} subjectOptions={subjectOptions} />
      <label>购买课时<input name={LP_WORKFLOW_FORM_NAMES.purchasedHours} type="number" min="0" step="any" defaultValue={initialValues.purchasedHours ?? ""} required /></label>
      <label>赠送课时<input name={LP_WORKFLOW_FORM_NAMES.bonusHours} type="number" min="0" step="any" defaultValue={initialValues.bonusHours ?? 0} required /></label>
      <label>排课频率<input name={LP_WORKFLOW_FORM_NAMES.lessonFrequency} defaultValue={initialValues.lessonFrequency} required /></label>
      <label>已提到的时间<input name={LP_WORKFLOW_FORM_NAMES.preferredTime} defaultValue={initialValues.preferredTime} required /></label>
      <label className="span-2">课程与教师<textarea name={LP_WORKFLOW_FORM_NAMES.coursesAndTeachers} defaultValue={initialValues.coursesAndTeachers} rows={3} required /></label>
      <label className="span-2">试听后补充交接（选填）
        <textarea
          name={LP_WORKFLOW_FORM_NAMES.enrollmentHandoverNotes}
          defaultValue={initialValues.enrollmentHandoverNotes}
          rows={3}
        />
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
      <label>排课频率<input name={LP_WORKFLOW_FORM_NAMES.lessonFrequency} defaultValue={initialValues.lessonFrequency} required /></label>
      <label className="span-2">课程与教师<textarea name={LP_WORKFLOW_FORM_NAMES.coursesAndTeachers} defaultValue={initialValues.coursesAndTeachers} rows={3} required /></label>
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
        {SPECIFIED_CONTENT_STATUSES.filter((option) => option !== "需要跟进").map((option) => <option value={option} key={option}>{option}</option>)}
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
    {workflowType === "试听 LP" ? <label className="span-2">备课跟进备注
      <textarea name={LP_WORKFLOW_FORM_NAMES.preparationNote} defaultValue={initialValues.preparationNote} rows={2} />
    </label> : null}
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

export type LpWorkflowDetailsProps = Readonly<{
  type: LpWorkflowType;
  fields: LpFieldValues;
}>;

function httpUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function displayLpFieldValue(value: LpFieldValues[string]) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

/** Read-only, schema-scoped view of the fields saved for one of the seven LP workflows. */
export function LpWorkflowDetails({ type, fields }: LpWorkflowDetailsProps) {
  const entries = getLpWorkflowSchema(type).fields.flatMap((field) => {
    if (field.visibleWhen && fields[field.visibleWhen.field] !== field.visibleWhen.equals) return [];
    if (field.key === "preferredTime" && type !== "学生报名交接" && fields.timeMentioned !== true) return [];
    const value = displayLpFieldValue(fields[field.key]);
    return value === null ? [] : [{ field, value }];
  });
  const visibleEntries = entries.filter(({ field }) => field.key !== LP_WORKFLOW_FORM_NAMES.responsibleOperations);

  return <section aria-label={`${type} 字段`}>
    {visibleEntries.length ? <div className="detail-section split">
      {visibleEntries.map(({ field, value }) => {
        const url = field.control === "url" ? httpUrl(value) : null;
        return <div key={field.key}>
          <span>{field.label}</span>
          <strong>{url
            ? <a className="inline-link" href={url} target="_blank" rel="noreferrer">打开链接</a>
            : value}</strong>
        </div>;
      })}
    </div> : <div className="empty-inline">暂无已保存字段</div>}
  </section>;
}

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
  return httpUrl(revision.after.documentUrl);
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
      title: "已修订",
      detail: revision.note || null,
      tone: "purple",
      documentUrl: lpRevisionDocumentUrl(revision),
    })),
    ...stageAudit.map((entry) => ({
      id: `stage-${entry.id}`,
      time: entry.occurredAt,
      title: `${entry.fromStage} → ${entry.toStage}`,
      detail: entry.note || null,
      tone: entry.toStage === "需修改" ? "amber" : entry.toStage === "完成" ? "green" : "blue",
      documentUrl: null,
    })),
  ].sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime());

  return <section className="timeline" aria-label="LP 修订历史">
    <div className="timeline-title"><strong>修订历史</strong></div>
    {entries.length ? entries.map((entry) => <div className="timeline-item" key={entry.id}>
      <i className={entry.tone} aria-hidden="true" />
      <span><strong>{entry.title}</strong><small>{historyTime(entry.time, timeZone)}{entry.detail ? ` · ${entry.detail}` : ""}</small>{entry.documentUrl ? <a className="inline-link" href={entry.documentUrl} target="_blank" rel="noreferrer">打开版本文档</a> : null}</span>
    </div>) : <div className="empty-inline">暂无修订记录</div>}
  </section>;
}

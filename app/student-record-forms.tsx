"use client";

import { useState, type ChangeEvent } from "react";

import type { ExamType } from "../lib/student-records";

export const STUDENT_RECORD_FORM_NAMES = Object.freeze({
  followedUpAt: "followedUpAt",
  followUpNote: "followUpNote",
  packageMode: "packageMode",
  packageId: "packageId",
  newPackageName: "newPackageName",
  subjectIds: "subjectIds",
  purchasedHours: "purchasedHours",
  bonusHours: "bonusHours",
  purchaseNote: "purchaseNote",
  examSubject: "examSubject",
  examType: "examType",
  examMonth: "examMonth",
  examDate: "examDate",
  includeRecall: "includeRecall",
} as const);

type StudentRecordFormName = (typeof STUDENT_RECORD_FORM_NAMES)[keyof typeof STUDENT_RECORD_FORM_NAMES];

export class StudentRecordFormDataError extends Error {
  readonly fieldName: StudentRecordFormName;

  constructor(fieldName: StudentRecordFormName, message: string) {
    super(message);
    this.name = "StudentRecordFormDataError";
    this.fieldName = fieldName;
  }
}

function stringValue(formData: FormData, fieldName: StudentRecordFormName) {
  const value = formData.get(fieldName);
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(formData: FormData, fieldName: StudentRecordFormName, label: string) {
  const value = stringValue(formData, fieldName);
  if (!value) throw new StudentRecordFormDataError(fieldName, `请填写${label}`);
  return value;
}

function checked(formData: FormData, fieldName: StudentRecordFormName) {
  const value = stringValue(formData, fieldName).toLocaleLowerCase();
  return value === "true" || value === "1" || value === "on" || value === "yes";
}

function nonNegativeNumber(formData: FormData, fieldName: StudentRecordFormName, label: string) {
  const source = requiredString(formData, fieldName, label);
  const value = Number(source);
  if (!Number.isFinite(value) || value < 0) {
    throw new StudentRecordFormDataError(fieldName, `${label}必须是大于或等于 0 的数字`);
  }
  return value;
}

function enumValue<const Value extends string>(
  formData: FormData,
  fieldName: StudentRecordFormName,
  values: readonly Value[],
  label: string,
): Value {
  const value = stringValue(formData, fieldName);
  if (!values.includes(value as Value)) {
    throw new StudentRecordFormDataError(fieldName, `${label}选项无效`);
  }
  return value as Value;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function validDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseLocalDateTime(source: string) {
  const match = LOCAL_DATETIME_PATTERN.exec(source);
  if (!match) return null;
  const [, yearSource, monthSource, daySource, hourSource, minuteSource, secondSource = "0"] = match;
  const year = Number(yearSource);
  const month = Number(monthSource);
  const day = Number(daySource);
  const hour = Number(hourSource);
  const minute = Number(minuteSource);
  const second = Number(secondSource);
  if (!validDateParts(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;

  const localDate = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    localDate.getFullYear() !== year
    || localDate.getMonth() !== month - 1
    || localDate.getDate() !== day
    || localDate.getHours() !== hour
    || localDate.getMinutes() !== minute
    || localDate.getSeconds() !== second
  ) return null;
  return localDate;
}

function validDateOnly(value: string) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  return validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

export type ParsedFollowUpForm = Readonly<{
  followedUpAt: string;
  note?: string;
}>;

/** Converts the browser-local date and time to an exact ISO timestamp. */
export function parseFollowUpFormData(formData: FormData): ParsedFollowUpForm {
  const source = requiredString(formData, STUDENT_RECORD_FORM_NAMES.followedUpAt, "跟进时间");
  const followedUpAt = parseLocalDateTime(source);
  if (!followedUpAt) {
    throw new StudentRecordFormDataError(STUDENT_RECORD_FORM_NAMES.followedUpAt, "跟进时间无效");
  }
  const note = stringValue(formData, STUDENT_RECORD_FORM_NAMES.followUpNote);
  return { followedUpAt: followedUpAt.toISOString(), ...(note ? { note } : {}) };
}

export type LessonPackageMode = "existing" | "new";

type ParsedLessonPackageBase = Readonly<{
  subjectIds: readonly string[];
  purchasedHours: number;
  bonusHours: number;
  totalHours: number;
  purchaseNote?: string;
}>;

export type ParsedLessonPackageForm =
  | (ParsedLessonPackageBase & Readonly<{ packageMode: "existing"; packageId: string }>)
  | (ParsedLessonPackageBase & Readonly<{ packageMode: "new"; newPackageName: string }>);

const LESSON_PACKAGE_MODES = ["existing", "new"] as const;

function subjectIds(formData: FormData) {
  const subjects = formData.getAll(STUDENT_RECORD_FORM_NAMES.subjectIds)
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(/[,，]/))
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(subjects)];
  if (!unique.length) {
    throw new StudentRecordFormDataError(STUDENT_RECORD_FORM_NAMES.subjectIds, "请选择科目");
  }
  return unique;
}

export function parseLessonPackageFormData(formData: FormData): ParsedLessonPackageForm {
  const packageMode = enumValue(
    formData,
    STUDENT_RECORD_FORM_NAMES.packageMode,
    LESSON_PACKAGE_MODES,
    "课包方式",
  );
  const purchasedHours = nonNegativeNumber(
    formData,
    STUDENT_RECORD_FORM_NAMES.purchasedHours,
    "购买课时",
  );
  const bonusHours = nonNegativeNumber(formData, STUDENT_RECORD_FORM_NAMES.bonusHours, "赠送课时");
  const totalHours = purchasedHours + bonusHours;
  if (totalHours <= 0) {
    throw new StudentRecordFormDataError(
      STUDENT_RECORD_FORM_NAMES.purchasedHours,
      "购买课时和赠送课时合计必须大于 0",
    );
  }
  const purchaseNote = stringValue(formData, STUDENT_RECORD_FORM_NAMES.purchaseNote);
  const common = {
    subjectIds: subjectIds(formData),
    purchasedHours,
    bonusHours,
    totalHours,
    ...(purchaseNote ? { purchaseNote } : {}),
  };

  if (packageMode === "existing") {
    return {
      packageMode,
      packageId: requiredString(formData, STUDENT_RECORD_FORM_NAMES.packageId, "课包"),
      ...common,
    };
  }
  return {
    packageMode,
    newPackageName: requiredString(formData, STUDENT_RECORD_FORM_NAMES.newPackageName, "新课包名称"),
    ...common,
  };
}

export const EXAM_TYPES = ["scholarship", "selective", "aeas", "other"] as const satisfies readonly ExamType[];

export type ParsedExamForm = Readonly<{
  subject: string;
  examType: ExamType;
  examMonth: string;
  examDate?: string;
  includeRecall: boolean;
}>;

export function parseExamFormData(formData: FormData): ParsedExamForm {
  const subject = requiredString(formData, STUDENT_RECORD_FORM_NAMES.examSubject, "考试科目");
  const examType = enumValue(formData, STUDENT_RECORD_FORM_NAMES.examType, EXAM_TYPES, "考试类型");
  const examMonth = requiredString(formData, STUDENT_RECORD_FORM_NAMES.examMonth, "考试月份");
  if (!MONTH_PATTERN.test(examMonth)) {
    throw new StudentRecordFormDataError(STUDENT_RECORD_FORM_NAMES.examMonth, "考试月份无效");
  }
  const examDate = stringValue(formData, STUDENT_RECORD_FORM_NAMES.examDate);
  if (examDate) {
    if (!validDateOnly(examDate)) {
      throw new StudentRecordFormDataError(STUDENT_RECORD_FORM_NAMES.examDate, "考试日期无效");
    }
    if (examDate.slice(0, 7) !== examMonth) {
      throw new StudentRecordFormDataError(STUDENT_RECORD_FORM_NAMES.examDate, "考试日期必须属于考试月份");
    }
  }
  return {
    subject,
    examType,
    examMonth,
    ...(examDate ? { examDate } : {}),
    includeRecall: checked(formData, STUDENT_RECORD_FORM_NAMES.includeRecall),
  };
}

function localDateTimeValue(value?: string) {
  if (!value) return "";
  const local = LOCAL_DATETIME_PATTERN.exec(value);
  if (local) return value.slice(0, 16);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const number = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${number(date.getMonth() + 1)}-${number(date.getDate())}T${number(date.getHours())}:${number(date.getMinutes())}`;
}

export type FollowUpFormProps = Readonly<{
  initialFollowedUpAt?: string;
  initialNote?: string;
}>;

/** Place directly inside an existing `.form-grid` form. */
export function FollowUpForm({ initialFollowedUpAt, initialNote }: FollowUpFormProps) {
  return <>
    <label className="span-2">跟进时间
      <input
        name={STUDENT_RECORD_FORM_NAMES.followedUpAt}
        type="datetime-local"
        step="60"
        defaultValue={localDateTimeValue(initialFollowedUpAt)}
        required
      />
    </label>
    <label className="span-2">跟进记录
      <textarea name={STUDENT_RECORD_FORM_NAMES.followUpNote} defaultValue={initialNote} rows={3} />
    </label>
  </>;
}

export type StudentRecordFormOption = Readonly<{ value: string; label?: string }>;

export type LessonPackageFormProps = Readonly<{
  existingPackages?: readonly StudentRecordFormOption[];
  subjectOptions?: readonly StudentRecordFormOption[];
  initialMode?: LessonPackageMode;
  initialPackageId?: string;
  initialNewPackageName?: string;
  initialSubjectIds?: readonly string[];
  initialPurchasedHours?: number;
  initialBonusHours?: number;
  initialPurchaseNote?: string;
}>;

export function LessonPackageForm({
  existingPackages = [],
  subjectOptions = [],
  initialMode,
  initialPackageId,
  initialNewPackageName,
  initialSubjectIds = [],
  initialPurchasedHours,
  initialBonusHours = 0,
  initialPurchaseNote,
}: LessonPackageFormProps) {
  const canUseExisting = existingPackages.length > 0;
  const [packageMode, setPackageMode] = useState<LessonPackageMode>(
    !canUseExisting ? "new" : initialMode ?? "existing",
  );

  const changeMode = (event: ChangeEvent<HTMLSelectElement>) => {
    setPackageMode(event.target.value as LessonPackageMode);
  };

  return <>
    <label>课包方式
      <select name={STUDENT_RECORD_FORM_NAMES.packageMode} value={packageMode} onChange={changeMode}>
        <option value="existing" disabled={!canUseExisting}>已有课包</option>
        <option value="new">新建课包</option>
      </select>
    </label>
    {packageMode === "existing" ? <label>课包
      <select name={STUDENT_RECORD_FORM_NAMES.packageId} defaultValue={initialPackageId ?? ""} required>
        <option value="" disabled>请选择</option>
        {existingPackages.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}
      </select>
    </label> : <label>新课包名称
      <input name={STUDENT_RECORD_FORM_NAMES.newPackageName} defaultValue={initialNewPackageName} required />
    </label>}
    <label className="span-2">科目
      {subjectOptions.length ? <select
        name={STUDENT_RECORD_FORM_NAMES.subjectIds}
        defaultValue={[...initialSubjectIds]}
        multiple
        required
      >
        {subjectOptions.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}
      </select> : <input
        name={STUDENT_RECORD_FORM_NAMES.subjectIds}
        defaultValue={initialSubjectIds.join(", ")}
        required
      />}
    </label>
    <label>购买课时
      <input
        name={STUDENT_RECORD_FORM_NAMES.purchasedHours}
        type="number"
        min="0"
        step="any"
        defaultValue={initialPurchasedHours ?? ""}
        required
      />
    </label>
    <label>赠送课时
      <input
        name={STUDENT_RECORD_FORM_NAMES.bonusHours}
        type="number"
        min="0"
        step="any"
        defaultValue={initialBonusHours}
        required
      />
    </label>
    <label className="span-2">购买备注
      <textarea name={STUDENT_RECORD_FORM_NAMES.purchaseNote} defaultValue={initialPurchaseNote} rows={3} />
    </label>
  </>;
}

const EXAM_TYPE_LABELS: Readonly<Record<ExamType, string>> = Object.freeze({
  scholarship: "奖学金",
  selective: "精英考试",
  aeas: "AEAS",
  other: "其他",
});

export type ExamFormProps = Readonly<{
  subjectOptions?: readonly StudentRecordFormOption[];
  initialSubject?: string;
  initialType?: ExamType;
  initialMonth?: string;
  initialDate?: string;
  initialIncludeRecall?: boolean;
}>;

export function ExamForm({
  subjectOptions = [],
  initialSubject,
  initialType = "other",
  initialMonth,
  initialDate,
  initialIncludeRecall = true,
}: ExamFormProps) {
  return <>
    <label>考试科目
      {subjectOptions.length ? <select
        name={STUDENT_RECORD_FORM_NAMES.examSubject}
        defaultValue={initialSubject ?? ""}
        required
      >
        <option value="" disabled>请选择</option>
        {subjectOptions.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}
      </select> : <input name={STUDENT_RECORD_FORM_NAMES.examSubject} defaultValue={initialSubject} required />}
    </label>
    <label>考试类型
      <select name={STUDENT_RECORD_FORM_NAMES.examType} defaultValue={initialType} required>
        {EXAM_TYPES.map((type) => <option value={type} key={type}>{EXAM_TYPE_LABELS[type]}</option>)}
      </select>
    </label>
    <label>考试月份
      <input name={STUDENT_RECORD_FORM_NAMES.examMonth} type="month" defaultValue={initialMonth} required />
    </label>
    <label>考试日期
      <input name={STUDENT_RECORD_FORM_NAMES.examDate} type="date" defaultValue={initialDate} />
    </label>
    <label className="checkbox-field span-2">
      <input
        name={STUDENT_RECORD_FORM_NAMES.includeRecall}
        type="checkbox"
        value="true"
        defaultChecked={initialIncludeRecall}
      />
      需要考试回忆
    </label>
  </>;
}

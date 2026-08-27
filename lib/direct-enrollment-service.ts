import type { OpsStateRow } from "@/lib/ops-store";
import { getStudentSubjectOptions } from "@/lib/student-subject-options";

export const DIRECT_ENROLLMENT_WORKFLOW = "学生直报（无试听）" as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STUDENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const DIRECT_LP_FIELD_KEYS = [
  "responsibleOperations",
  "specifiedContentStatus",
  "specialNotes",
  "preparationFollowUp",
  "isUniversityStudent",
  "universityMajor",
  "universityYear",
  "oneSentenceDescription",
  "locationTimezone",
  "contactPerson",
  "timeMentioned",
  "preferredTime",
  "lessonFrequency",
  "coursesAndTeachers",
] as const;

type DirectLpFieldKey = (typeof DIRECT_LP_FIELD_KEYS)[number];
type RecordValue = Record<string, unknown>;

export type DirectEnrollmentCommand = Readonly<{
  commandKey: string;
  studentId: string;
  workflowType: typeof DIRECT_ENROLLMENT_WORKFLOW;
  fields: Readonly<Record<DirectLpFieldKey, unknown>>;
  purchasedHours: number;
  bonusHours: number;
  subject: string;
  expectedVersions: Readonly<{ students: number; lpItems: number; tasks: number }>;
}>;

export class DirectEnrollmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string, max = 2_000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new DirectEnrollmentError("invalid_command", `${field} 必须是非空文本。`);
  }
  return value.trim();
}

function finiteNonNegative(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new DirectEnrollmentError("invalid_hours", `${field} 必须是非负有限课时。`);
  }
  return value;
}

function exactKeys(value: RecordValue, expected: readonly string[], field: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new DirectEnrollmentError("invalid_command", `${field} 包含未允许的字段。`);
  }
}

function keysSubset(value: RecordValue, allowed: readonly string[], required: readonly string[], field: string) {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) {
    throw new DirectEnrollmentError("invalid_command", `${field} 包含未允许的字段或缺少必填字段。`);
  }
}

function parseFields(value: unknown): Readonly<Record<DirectLpFieldKey, unknown>> {
  if (!record(value)) throw new DirectEnrollmentError("invalid_command", "LP fields 必须是对象。");
  keysSubset(value, DIRECT_LP_FIELD_KEYS, [
    "responsibleOperations", "specifiedContentStatus", "preparationFollowUp", "isUniversityStudent",
    "oneSentenceDescription", "locationTimezone", "contactPerson", "timeMentioned", "lessonFrequency", "coursesAndTeachers",
  ], "LP fields");
  const textFields: DirectLpFieldKey[] = [
    "responsibleOperations", "specifiedContentStatus", "preparationFollowUp",
    "oneSentenceDescription", "locationTimezone", "contactPerson", "lessonFrequency",
    "coursesAndTeachers",
  ];
  for (const field of textFields) nonEmptyString(value[field], field);
  if (value.isUniversityStudent !== true && value.isUniversityStudent !== false) {
    throw new DirectEnrollmentError("invalid_command", "isUniversityStudent 必须是布尔值。");
  }
  if (typeof value.timeMentioned !== "boolean") {
    throw new DirectEnrollmentError("invalid_command", "timeMentioned 必须是布尔值。");
  }
  if (value.timeMentioned && (typeof value.preferredTime !== "string" || !value.preferredTime.trim())) {
    throw new DirectEnrollmentError("invalid_command", "提到时间时必须填写 preferredTime。");
  }
  for (const field of ["specialNotes", "universityMajor", "universityYear", "preferredTime"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new DirectEnrollmentError("invalid_command", `${field} 必须是文本。`);
    if (typeof value[field] === "string" && value[field].length > 2_000) throw new DirectEnrollmentError("invalid_command", `${field} 过长。`);
  }
  if (value.isUniversityStudent && (!String(value.universityMajor).trim() || !String(value.universityYear).trim())) {
    throw new DirectEnrollmentError("invalid_command", "大学学生必须填写专业和年级。");
  }
  return {
    ...value,
    specialNotes: typeof value.specialNotes === "string" ? value.specialNotes.trim() : "",
    universityMajor: typeof value.universityMajor === "string" ? value.universityMajor.trim() : "",
    universityYear: typeof value.universityYear === "string" ? value.universityYear.trim() : "",
    preferredTime: typeof value.preferredTime === "string" ? value.preferredTime.trim() : "",
  } as Readonly<Record<DirectLpFieldKey, unknown>>;
}

function parseExpectedVersions(value: unknown) {
  if (!record(value)) throw new DirectEnrollmentError("invalid_command", "expectedVersions 必须是对象。");
  exactKeys(value, ["students", "lpItems", "tasks"], "expectedVersions");
  const parsed = {} as { students: number; lpItems: number; tasks: number };
  for (const key of ["students", "lpItems", "tasks"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) {
      throw new DirectEnrollmentError("invalid_command", `${key} 版本号无效。`);
    }
    parsed[key] = value[key] as number;
  }
  return parsed;
}

/** Strictly accepts the narrow browser command; derived arrays are forbidden. */
export function parseDirectEnrollmentCommand(input: unknown): DirectEnrollmentCommand {
  if (!record(input)) throw new DirectEnrollmentError("invalid_command", "直报命令必须是对象。");
  exactKeys(input, ["commandKey", "studentId", "workflowType", "fields", "purchasedHours", "bonusHours", "subject", "expectedVersions"], "command");
  const commandKey = nonEmptyString(input.commandKey, "commandKey", 80);
  if (!UUID_V4.test(commandKey)) throw new DirectEnrollmentError("invalid_command", "commandKey 必须是 UUID v4。");
  const studentId = nonEmptyString(input.studentId, "studentId", 120);
  if (!STUDENT_ID.test(studentId) || studentId.includes("TEMP") || studentId.includes("temp")) {
    throw new DirectEnrollmentError("provisional_not_supported", "学生直报本轮只支持现有学生档案。");
  }
  if (input.workflowType !== DIRECT_ENROLLMENT_WORKFLOW) {
    throw new DirectEnrollmentError("invalid_command", "直报命令 workflowType 不正确。");
  }
  const fields = parseFields(input.fields);
  const purchasedHours = finiteNonNegative(input.purchasedHours, "purchasedHours");
  const bonusHours = finiteNonNegative(input.bonusHours, "bonusHours");
  if (purchasedHours + bonusHours <= 0) throw new DirectEnrollmentError("invalid_hours", "购买课时与赠送课时合计必须大于 0。");
  const subject = nonEmptyString(input.subject, "subject", 240);
  return {
    commandKey,
    studentId,
    workflowType: DIRECT_ENROLLMENT_WORKFLOW,
    fields,
    purchasedHours,
    bonusHours,
    subject,
    expectedVersions: parseExpectedVersions(input.expectedVersions),
  };
}

function payloadRecords(rows: readonly OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  return Array.isArray(payload) ? payload.filter(record) : [];
}

export function directEnrollmentIntent(command: DirectEnrollmentCommand) {
  return {
    studentId: command.studentId,
    workflowType: command.workflowType,
    fields: command.fields,
    purchasedHours: command.purchasedHours,
    bonusHours: command.bonusHours,
    subject: command.subject,
    expectedVersions: command.expectedVersions,
  } as const;
}

export function prepareDirectEnrollmentCommand(input: {
  command: DirectEnrollmentCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  canOperateStudent: boolean;
}) {
  const { command, rows } = input;
  if (!input.canOperateStudent) throw new DirectEnrollmentError("student_scope_forbidden", "当前账号不能操作该学生。");
  const student = payloadRecords(rows, "students").find((candidate) => candidate.id === command.studentId);
  if (!student) throw new DirectEnrollmentError("student_not_found", "学生档案不存在。");
  if (student.importArchived === true) throw new DirectEnrollmentError("student_archived", "已归档学生不能创建直报 LP。");
  const subjects = getStudentSubjectOptions({
    studentId: command.studentId,
    course: typeof student.course === "string" ? student.course : null,
    lessonPackages: Array.isArray(student.lessonPackages) ? student.lessonPackages.filter(record) : [],
    bookings: payloadRecords(rows, "bookings").map((booking) => ({
      studentId: typeof booking.studentId === "string" ? booking.studentId : "",
      teacherSubjectId: typeof booking.teacherSubjectId === "string" ? booking.teacherSubjectId : null,
      course: typeof booking.course === "string" ? booking.course : null,
    })),
  });
  if (!subjects.some((candidate) => candidate.localeCompare(command.subject, undefined, { sensitivity: "accent" }) === 0)) {
    throw new DirectEnrollmentError("subject_not_available", "该科目不属于学生当前可用课程。");
  }
  for (const entity of ["students", "lpItems", "tasks"] as const) {
    const row = rows.find((candidate) => candidate.entity === entity);
    if (!row) throw new DirectEnrollmentError("invalid_shared_state", `${entity} 共享状态缺失。`);
    if (row.version !== command.expectedVersions[entity]) throw new DirectEnrollmentError("version_conflict", "共享资料刚刚发生变化，请刷新后重试。");
  }
  return { ...command, commandIntent: directEnrollmentIntent(command), actor: input.actor } as const;
}

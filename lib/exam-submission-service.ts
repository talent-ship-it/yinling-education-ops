import { createHash } from "node:crypto";

import {
  reconcileExamTasks,
  routeExamTaskRecipients,
} from "@/lib/exam-tasks";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction } from "@/lib/ops-access";
import {
  statusForDueAt,
  type OpsTask,
  type TaskTone,
} from "@/lib/ops-tasks";
import type { OpsStateRow } from "@/lib/ops-store";
import {
  EXAM_VARIANTS,
  LEGACY_EXAM_TYPES,
  buildExamTaskDefinitions,
  estimateExamResultDate,
  sortStudentExams,
  type ExamType,
  type ExamVariant,
  type StudentExamRecord,
} from "@/lib/student-records";
import type { DemoSessionIdentity, DemoSessionRole } from "@/lib/demo-session-token";

type RecordValue = Record<string, unknown>;

const COMMAND_FIELDS = new Set(["commandKey", "studentId", "exam", "expectedVersions"]);
const RECOVERY_COMMAND_FIELDS = new Set(["commandKey", "studentId", "exam"]);
const VERSION_FIELDS = new Set(["students", "tasks"]);
const EXAM_FIELDS = new Set([
  "id",
  "subject",
  "examType",
  "examVariant",
  "examMonth",
  "examDate",
  "resultDateOverride",
  "includeRecall",
]);
const COMMAND_KEY_PATTERN = /^exam-submit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const MELBOURNE_TIME_ZONE = "Australia/Melbourne";

export type ExamSubmissionCommand = Readonly<{
  commandKey: string;
  studentId: string;
  exam: Readonly<{
    id: string;
    subject: string;
    examType: ExamType;
    examVariant: ExamVariant;
    examMonth: string;
    examDate?: string;
    resultDateOverride?: string;
    includeRecall: boolean;
  }>;
  expectedVersions: Readonly<{
    students: number;
    tasks: number;
  }>;
}>;

export type ExamSubmissionIntent = Readonly<{
  studentId: string;
  exam: ExamSubmissionCommand["exam"];
}>;

export type ExamSubmissionRecoveryCommand = Omit<ExamSubmissionCommand, "expectedVersions">;

export type PreparedExamSubmission = Readonly<{
  commandKey: string;
  commandIntent: ExamSubmissionIntent;
  studentId: string;
  examId: string;
  expectedVersions: ExamSubmissionCommand["expectedVersions"];
  students: readonly RecordValue[];
  tasks: readonly RecordValue[];
  preparedAt: string;
  unresolvedRoleLabels: readonly string[];
  generatedTaskCount: number;
  action: "create" | "update";
}>;

export type ExamSubmissionServiceErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "student_not_found"
  | "student_scope_forbidden"
  | "teacher_forbidden"
  | "archived_student_read_only"
  | "exam_identity_conflict";

export class ExamSubmissionServiceError extends Error {
  constructor(readonly code: ExamSubmissionServiceErrorCode, message: string) {
    super(message);
    this.name = "ExamSubmissionServiceError";
  }
}

function fail(code: ExamSubmissionServiceErrorCode, message: string): never {
  throw new ExamSubmissionServiceError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyFields(value: RecordValue, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail("client_fields_forbidden", "Only reviewed exam submission fields may be submitted.");
  }
}

function requiredText(value: unknown, field: string, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength = 200) {
  if (value === undefined) return undefined;
  return requiredText(value, field, maxLength);
}

function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid_request", `${field} must be a positive state version.`);
  }
  return value as number;
}

function assertCalendarDate(value: string, field: string) {
  if (!DATE_PATTERN.test(value)) fail("invalid_request", `${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail("invalid_request", `${field} is not a calendar date.`);
  }
}

export function parseExamSubmissionCommand(value: unknown): ExamSubmissionCommand {
  if (!isRecord(value)) fail("invalid_request", "Exam submission command is missing.");
  assertOnlyFields(value, COMMAND_FIELDS);
  const commandKey = requiredText(value.commandKey, "commandKey", 80);
  if (!COMMAND_KEY_PATTERN.test(commandKey)) fail("invalid_request", "commandKey is invalid.");
  const studentId = requiredText(value.studentId, "studentId", 120);
  if (!ID_PATTERN.test(studentId)) fail("invalid_request", "studentId is invalid.");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertOnlyFields(value.expectedVersions, VERSION_FIELDS);
  const expectedVersions = {
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
  };
  if (!isRecord(value.exam)) fail("invalid_request", "exam is required.");
  assertOnlyFields(value.exam, EXAM_FIELDS);
  const id = requiredText(value.exam.id, "exam.id", 120);
  if (!ID_PATTERN.test(id)) fail("invalid_request", "exam.id is invalid.");
  const subject = requiredText(value.exam.subject, "exam.subject", 200);
  if (!(LEGACY_EXAM_TYPES as readonly unknown[]).includes(value.exam.examType)) {
    fail("invalid_request", "exam.examType is invalid.");
  }
  if (!(EXAM_VARIANTS as readonly unknown[]).includes(value.exam.examVariant)) {
    fail("invalid_request", "exam.examVariant is invalid.");
  }
  const examMonth = requiredText(value.exam.examMonth, "exam.examMonth", 7);
  if (!MONTH_PATTERN.test(examMonth)) fail("invalid_request", "exam.examMonth must use YYYY-MM.");
  const examDate = optionalText(value.exam.examDate, "exam.examDate", 10);
  if (examDate) {
    assertCalendarDate(examDate, "exam.examDate");
    if (!examDate.startsWith(`${examMonth}-`)) {
      fail("invalid_request", "exam.examDate must be within exam.examMonth.");
    }
  }
  const resultDateOverride = optionalText(value.exam.resultDateOverride, "exam.resultDateOverride", 10);
  if (resultDateOverride) assertCalendarDate(resultDateOverride, "exam.resultDateOverride");
  if (typeof value.exam.includeRecall !== "boolean") {
    fail("invalid_request", "exam.includeRecall must be boolean.");
  }
  return {
    commandKey,
    studentId,
    expectedVersions,
    exam: {
      id,
      subject,
      examType: value.exam.examType as ExamType,
      examVariant: value.exam.examVariant as ExamVariant,
      examMonth,
      ...(examDate ? { examDate } : {}),
      ...(resultDateOverride ? { resultDateOverride } : {}),
      includeRecall: value.exam.includeRecall,
    },
  };
}

/** Parses the exact prior intent used by the read-only lost-response lookup. */
export function parseExamSubmissionRecoveryCommand(value: unknown): ExamSubmissionRecoveryCommand {
  if (!isRecord(value)) fail("invalid_request", "Exam recovery command is missing.");
  assertOnlyFields(value, RECOVERY_COMMAND_FIELDS);
  const parsed = parseExamSubmissionCommand({
    ...value,
    expectedVersions: { students: 1, tasks: 1 },
  });
  return {
    commandKey: parsed.commandKey,
    studentId: parsed.studentId,
    exam: parsed.exam,
  };
}

export function examSubmissionIntent(
  command: Pick<ExamSubmissionCommand, "studentId" | "exam">,
): ExamSubmissionIntent {
  return { studentId: command.studentId, exam: command.exam };
}

function payloadRow(rows: readonly OpsStateRow[], entity: "students" | "tasks") {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1
    || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
    fail("invalid_shared_state", `${entity} shared state is unavailable.`);
  }
  const ids = row.payload.map((item) => typeof item.id === "string" ? item.id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("invalid_shared_state", `${entity} shared state contains duplicate or missing ids.`);
  }
  return { ...row, payload: row.payload as RecordValue[] };
}

function existingExams(student: RecordValue) {
  if (student.exams === undefined) return [];
  if (!Array.isArray(student.exams) || !student.exams.every(isRecord)) {
    fail("invalid_shared_state", "Student exam history is invalid.");
  }
  const ids = student.exams.map((exam) => typeof exam.id === "string" ? exam.id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("invalid_shared_state", "Student exam history contains duplicate or missing ids.");
  }
  return student.exams as StudentExamRecord[];
}

function timezoneParts(date: Date, timezone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value])) as Record<string, string>;
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = timezoneParts(date, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    - date.getTime();
}

/** Converts the unambiguous 18:00 Melbourne workflow deadline to an instant. */
function examDueAt(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, 18, 0);
  const first = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), MELBOURNE_TIME_ZONE));
  return new Date(wallClock - timezoneOffsetMs(first, MELBOURNE_TIME_ZONE));
}

function stableManagedTaskId(studentId: string, ruleKey: string) {
  return `TSK-EXAM-${createHash("sha256").update(`${studentId}\u001f${ruleKey}`).digest("hex").slice(0, 24)}`;
}

function taskTone(kind: "exam_care" | "exam_recall" | "exam_month_planning" | "exam_results_follow_up"): TaskTone {
  return kind === "exam_results_follow_up" || kind === "exam_month_planning" ? "purple" : "amber";
}

export function prepareExamSubmission(input: Readonly<{
  command: ExamSubmissionCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  authorization?: DemoSessionIdentity;
  fullAdmin: boolean;
  now?: Date;
}>): PreparedExamSubmission {
  if (input.role === "teacher") fail("teacher_forbidden", "Teacher accounts cannot submit student exams.");
  const studentsRow = payloadRow(input.rows, "students");
  const tasksRow = payloadRow(input.rows, "tasks");
  if (studentsRow.version !== input.command.expectedVersions.students
    || tasksRow.version !== input.command.expectedVersions.tasks) {
    fail("stale_expected_version", "Student or task state changed; refresh before saving the exam.");
  }

  const access = buildOpsAccessContext(
    input.rows as OpsStateRow[],
    input.actor,
    input.fullAdmin,
    input.authorization ?? input.role,
  );
  if (!canWriteOpsTransaction(access, "students", ["students", "tasks"])
      || !canOperateStudent(access, input.command.studentId)) {
    fail("student_scope_forbidden", "The current account cannot submit an exam for this student.");
  }
  const matchingStudents = studentsRow.payload.filter((student) => student.id === input.command.studentId);
  if (matchingStudents.length !== 1) fail("student_not_found", "The student was not found.");
  const student = matchingStudents[0];
  if (student.importArchived === true) {
    fail("archived_student_read_only", "Archived student records are read-only.");
  }

  const duplicateExamOwner = studentsRow.payload.find((candidate) => candidate.id !== input.command.studentId
    && existingExams(candidate).some((exam) => exam.id === input.command.exam.id));
  if (duplicateExamOwner) {
    fail("exam_identity_conflict", "The exam id already belongs to another student.");
  }

  const exams = existingExams(student);
  const previousExam = exams.find((entry) => entry.id === input.command.exam.id);
  const exam: StudentExamRecord = {
    ...input.command.exam,
    ...(previousExam?.followUpState ? { followUpState: previousExam.followUpState } : {}),
  };
  const resultDate = estimateExamResultDate(exam);
  let nextExams: StudentExamRecord[];
  try {
    nextExams = sortStudentExams([...exams.filter((entry) => entry.id !== exam.id), exam]);
  } catch {
    fail("invalid_shared_state", "Student exam history cannot be reconciled.");
  }
  const students = studentsRow.payload.map((candidate) => candidate.id === input.command.studentId
    ? {
      ...candidate,
      exams: nextExams,
      examSubject: exam.subject,
      examDate: exam.examDate,
      resultDate: resultDate ?? undefined,
    }
    : candidate);

  const now = input.now ? new Date(input.now.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) fail("invalid_request", "The submission clock is invalid.");
  const preparedAt = now.toISOString();
  const unresolvedRoleLabels = new Set<string>();
  const incomingTasks: OpsTask[] = buildExamTaskDefinitions(exam, {
    includeRecall: exam.includeRecall,
    resultDate: resultDate ?? undefined,
  }).filter((definition) => definition.completionStatus !== "not_required").flatMap((definition) => {
    const routing = routeExamTaskRecipients(definition.assigneeRoles, {
      owner: typeof student.owner === "string" ? student.owner : undefined,
      planner: typeof student.planner === "string" ? student.planner : undefined,
    });
    routing.unresolvedRoleLabels.forEach((label) => unresolvedRoleLabels.add(label));
    if (!routing.routing) return [];
    const dueAt = examDueAt(definition.dueDate);
    const completed = definition.completionStatus === "completed";
    return [{
      id: stableManagedTaskId(input.command.studentId, definition.key),
      title: definition.title,
      owner: routing.routing.owner,
      assignees: routing.routing.assignees,
      watchers: routing.routing.watchers,
      studentId: input.command.studentId,
      due: `${definition.dueDate} 18:00`,
      dueAt: dueAt.toISOString(),
      status: completed ? "done" : statusForDueAt(dueAt, now, MELBOURNE_TIME_ZONE),
      tone: completed ? "green" : taskTone(definition.kind),
      category: "考试",
      trigger: `${exam.subject} 考试记录 · 收件：${routing.routing.assignees.join("、")}`,
      ...(completed ? {
        result: "考试跟进已完成",
        closedAt: definition.completedAt,
      } : {}),
      ruleKey: definition.key,
      anchorBookingId: `exam:${exam.id}`,
    } satisfies OpsTask];
  });
  let tasks: OpsTask[];
  try {
    tasks = reconcileExamTasks(tasksRow.payload as unknown as OpsTask[], incomingTasks, {
      examId: exam.id,
      closedAt: preparedAt,
    });
  } catch {
    fail("invalid_shared_state", "Managed exam tasks cannot be reconciled.");
  }
  const nextTaskIds = tasks.map((task) => typeof task.id === "string" ? task.id.trim() : "");
  if (nextTaskIds.some((taskId) => !taskId) || new Set(nextTaskIds).size !== nextTaskIds.length) {
    fail("invalid_shared_state", "Managed exam task ids conflict with existing tasks.");
  }
  return {
    commandKey: input.command.commandKey,
    commandIntent: examSubmissionIntent(input.command),
    studentId: input.command.studentId,
    examId: exam.id,
    expectedVersions: input.command.expectedVersions,
    students,
    tasks: tasks as unknown as RecordValue[],
    preparedAt,
    unresolvedRoleLabels: [...unresolvedRoleLabels],
    generatedTaskCount: incomingTasks.length,
    action: previousExam ? "update" : "create",
  };
}

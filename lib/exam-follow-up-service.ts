import { isDeepStrictEqual } from "node:util";

import { DEMO_LIMITED_ADMIN_USER } from "@/lib/demo-users";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import type { OpsStateRow } from "@/lib/ops-store";
import type {
  ExamFollowUpState,
  ExamTaskKind,
  StudentExamRecord,
} from "@/lib/student-records";

type RecordValue = Record<string, unknown>;

const COMMAND_FIELDS = new Set([
  "commandKey",
  "action",
  "taskId",
  "expectedVersions",
  "completionCommandKey",
]);
const VERSION_FIELDS = new Set(["students", "tasks"]);
const COMMAND_KEY_PATTERN = /^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const COMPLETE_RESULT = "已由当前操作员确认完成";

export type ExamFollowUpAction = "complete" | "undo";

export type ExamFollowUpCommand = Readonly<{
  commandKey: string;
  action: ExamFollowUpAction;
  taskId: string;
  expectedVersions: Readonly<{ students: number; tasks: number }>;
  completionCommandKey?: string;
}>;

export type ExamFollowUpIntent = Readonly<{
  action: ExamFollowUpAction;
  taskId: string;
  completionCommandKey?: string;
}>;

export type ExamFollowUpCompletionContext = Readonly<{
  command_key: string;
  task_id: string;
  student_id: string;
  exam_id: string;
  follow_up_kind: ExamTaskKind;
  prior_task: RecordValue;
  prior_follow_up_state_exists: boolean;
  prior_follow_up_state: RecordValue | null;
  committed_task: RecordValue;
  committed_follow_up_state: RecordValue;
}>;

export type ExamFollowUpIdentity = Readonly<{
  taskId: string;
  studentId: string;
  examId: string;
  followUpKind: ExamTaskKind;
}>;

export type PreparedExamFollowUp = Readonly<{
  commandKey: string;
  commandIntent: ExamFollowUpIntent;
  action: ExamFollowUpAction;
  completionCommandKey?: string;
  expectedVersions: ExamFollowUpCommand["expectedVersions"];
  taskId: string;
  studentId: string;
  examId: string;
  followUpKind: ExamTaskKind;
  students: readonly RecordValue[];
  tasks: readonly RecordValue[];
  preparedAt: string;
}>;

export type ExamFollowUpServiceErrorCode =
  | "invalid_request"
  | "client_fields_forbidden"
  | "invalid_shared_state"
  | "stale_expected_version"
  | "task_not_found"
  | "student_not_found"
  | "exam_not_found"
  | "task_identity_conflict"
  | "task_recipient_conflict"
  | "task_scope_forbidden"
  | "teacher_forbidden"
  | "archived_student_read_only"
  | "follow_up_action_conflict"
  | "completion_context_missing"
  | "completion_actor_conflict";

export class ExamFollowUpServiceError extends Error {
  constructor(readonly code: ExamFollowUpServiceErrorCode, message: string) {
    super(message);
    this.name = "ExamFollowUpServiceError";
  }
}

function fail(code: ExamFollowUpServiceErrorCode, message: string): never {
  throw new ExamFollowUpServiceError(code, message);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function same(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}

function requiredText(value: unknown, field: string, maxLength = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function version(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid_request", `${field} must be a positive state version.`);
  }
  return value as number;
}

function assertOnlyFields(value: RecordValue, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail("client_fields_forbidden", "Only the reviewed exam follow-up command fields may be submitted.");
  }
}

export function parseExamFollowUpCommand(value: unknown): ExamFollowUpCommand {
  if (!isRecord(value)) fail("invalid_request", "Exam follow-up command is missing.");
  assertOnlyFields(value, COMMAND_FIELDS);
  const commandKey = requiredText(value.commandKey, "commandKey", 80);
  if (!COMMAND_KEY_PATTERN.test(commandKey)) fail("invalid_request", "commandKey is invalid.");
  if (value.action !== "complete" && value.action !== "undo") {
    fail("invalid_request", "action must be complete or undo.");
  }
  const taskId = requiredText(value.taskId, "taskId");
  if (!ID_PATTERN.test(taskId)) fail("invalid_request", "taskId is invalid.");
  if (!isRecord(value.expectedVersions)) fail("invalid_request", "expectedVersions is required.");
  assertOnlyFields(value.expectedVersions, VERSION_FIELDS);
  const expectedVersions = {
    students: version(value.expectedVersions.students, "expectedVersions.students"),
    tasks: version(value.expectedVersions.tasks, "expectedVersions.tasks"),
  };
  const completionCommandKey = value.completionCommandKey === undefined
    ? undefined
    : requiredText(value.completionCommandKey, "completionCommandKey", 80);
  if (value.action === "complete" && completionCommandKey !== undefined) {
    fail("client_fields_forbidden", "completionCommandKey is only accepted for undo.");
  }
  if (value.action === "undo" && (!completionCommandKey || !COMMAND_KEY_PATTERN.test(completionCommandKey))) {
    fail("invalid_request", "completionCommandKey is required for undo.");
  }
  return {
    commandKey,
    action: value.action,
    taskId,
    expectedVersions,
    ...(completionCommandKey ? { completionCommandKey } : {}),
  };
}

export function examFollowUpIntent(command: ExamFollowUpCommand): ExamFollowUpIntent {
  return {
    action: command.action,
    taskId: command.taskId,
    ...(command.completionCommandKey ? { completionCommandKey: command.completionCommandKey } : {}),
  };
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

function samePerson(left: unknown, right: string) {
  return typeof left === "string"
    && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function configuredRecipient(value: unknown) {
  if (typeof value !== "string") return null;
  const recipient = value.trim();
  return recipient && !/^(?:待分配|待确认|未知|角色待配置[:：])/.test(recipient)
    ? recipient
    : null;
}

function taskIdentity(task: RecordValue): ExamFollowUpIdentity {
  // Legacy contract marker retained for deployed readers:
  // task.ruleKey.match(/^exam:([^:]+):(care|recall|results)$/)
  if (task.category !== "考试" || typeof task.ruleKey !== "string"
    || typeof task.anchorBookingId !== "string" || typeof task.studentId !== "string") {
    fail("task_identity_conflict", "The task is not a managed exam follow-up.");
  }
  const match = task.ruleKey.match(/^exam:([^:]+):(planning|care|recall|results)$/);
  if (!match || task.anchorBookingId !== `exam:${match[1]}`) {
    fail("task_identity_conflict", "The task exam anchor is inconsistent.");
  }
  const followUpKind: ExamTaskKind = match[2] === "planning"
    ? "exam_month_planning"
    : match[2] === "care" ? "exam_care"
      : match[2] === "recall" ? "exam_recall" : "exam_results_follow_up";
  return {
    taskId: String(task.id),
    studentId: task.studentId.trim(),
    examId: match[1],
    followUpKind,
  };
}

function studentExams(student: RecordValue) {
  if (!Array.isArray(student.exams) || !student.exams.every(isRecord)) {
    fail("invalid_shared_state", "Student exam history is invalid.");
  }
  const ids = student.exams.map((exam) => typeof exam.id === "string" ? exam.id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("invalid_shared_state", "Student exam history contains duplicate or missing ids.");
  }
  return student.exams as StudentExamRecord[];
}

function assertTaskProjection(task: RecordValue, student: RecordValue, identity: ExamFollowUpIdentity) {
  const expectedRecipient = configuredRecipient(
    identity.followUpKind === "exam_results_follow_up" || identity.followUpKind === "exam_month_planning"
      ? student.planner : student.owner,
  );
  const assignees = Array.isArray(task.assignees) ? task.assignees : [];
  const watchers = Array.isArray(task.watchers) ? task.watchers : [];
  if (!expectedRecipient
    || !samePerson(task.owner, expectedRecipient)
    || assignees.length !== 1
    || !samePerson(assignees[0], expectedRecipient)
    || watchers.length !== 1
    || !samePerson(watchers[0], DEMO_LIMITED_ADMIN_USER)) {
    fail("task_recipient_conflict", "The managed exam task recipient projection is inconsistent.");
  }
  return expectedRecipient;
}

/**
 * Resolves identity and current authorization without applying action-state
 * rules. This remains usable for a lost-response replay after completion.
 */
export function authorizeExamFollowUpCommand(input: Readonly<{
  command: ExamFollowUpCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  fullAdmin: boolean;
}>): ExamFollowUpIdentity {
  if (input.role === "teacher") fail("teacher_forbidden", "Teacher accounts cannot complete exam follow-ups.");
  const studentsRow = payloadRow(input.rows, "students");
  const tasksRow = payloadRow(input.rows, "tasks");
  const task = tasksRow.payload.find((candidate) => candidate.id === input.command.taskId);
  if (!task) fail("task_not_found", "The exam follow-up task was not found.");
  const identity = taskIdentity(task);
  const students = studentsRow.payload.filter((candidate) => candidate.id === identity.studentId);
  if (students.length !== 1) fail("student_not_found", "The task student was not found.");
  const student = students[0];
  if (student.importArchived === true) {
    fail("archived_student_read_only", "Archived student records are read-only.");
  }
  if (!studentExams(student).some((exam) => exam.id === identity.examId)) {
    fail("exam_not_found", "The task exam was not found on its student.");
  }
  const expectedRecipient = assertTaskProjection(task, student, identity);
  const admin = input.fullAdmin || input.role === "limited-admin";
  if (!admin && !samePerson(expectedRecipient, input.actor)) {
    fail("task_scope_forbidden", "The current account is not the exact assignee for this exam follow-up.");
  }
  return identity;
}

function followUpState(exam: StudentExamRecord) {
  if (exam.followUpState === undefined) return { exists: false, value: {} as ExamFollowUpState };
  if (!isRecord(exam.followUpState)) fail("invalid_shared_state", "Exam follow-up state is invalid.");
  const allowedKinds = new Set(["exam_care", "exam_recall", "exam_month_planning", "exam_results_follow_up"]);
  for (const [kind, step] of Object.entries(exam.followUpState)) {
    if (!allowedKinds.has(kind) || !isRecord(step)
      || !["pending", "completed", "not_required"].includes(String(step.status ?? ""))
      || (step.status === "completed"
        && (typeof step.completedAt !== "string" || !Number.isFinite(Date.parse(step.completedAt))))) {
      fail("invalid_shared_state", "Exam follow-up state is invalid.");
    }
  }
  return { exists: true, value: exam.followUpState };
}

function replaceExamFollowUpState(
  students: readonly RecordValue[],
  identity: ExamFollowUpIdentity,
  next: Readonly<{ exists: boolean; value: ExamFollowUpState }>,
) {
  return students.map((student) => student.id !== identity.studentId ? student : {
    ...student,
    exams: studentExams(student).map((exam) => exam.id !== identity.examId ? exam : (() => {
      const without = { ...exam };
      delete without.followUpState;
      return next.exists ? { ...without, followUpState: next.value } : without;
    })()),
  });
}

export function prepareExamFollowUp(input: Readonly<{
  command: ExamFollowUpCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  fullAdmin: boolean;
  completionContext?: ExamFollowUpCompletionContext;
  now?: Date;
}>): PreparedExamFollowUp {
  const identity = authorizeExamFollowUpCommand(input);
  const studentsRow = payloadRow(input.rows, "students");
  const tasksRow = payloadRow(input.rows, "tasks");
  if (studentsRow.version !== input.command.expectedVersions.students
    || tasksRow.version !== input.command.expectedVersions.tasks) {
    fail("stale_expected_version", "Student or task state changed; refresh before updating the follow-up.");
  }
  const task = tasksRow.payload.find((candidate) => candidate.id === identity.taskId)!;
  const student = studentsRow.payload.find((candidate) => candidate.id === identity.studentId)!;
  const exam = studentExams(student).find((candidate) => candidate.id === identity.examId)!;
  const currentFollowUp = followUpState(exam);
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) fail("invalid_request", "The follow-up clock is invalid.");
  const preparedAt = now.toISOString();
  let students: RecordValue[];
  let tasks: RecordValue[];

  if (input.command.action === "complete") {
    const step = currentFollowUp.value[identity.followUpKind];
    if (!["overdue", "today", "upcoming", "waiting"].includes(String(task.status ?? ""))
      || step?.status === "completed" || step?.status === "not_required") {
      fail("follow_up_action_conflict", "This exam follow-up cannot be completed from its current state.");
    }
    const nextFollowUpState: ExamFollowUpState = {
      ...currentFollowUp.value,
      [identity.followUpKind]: {
        status: "completed",
        completedAt: preparedAt,
        completedBy: input.actor.trim(),
      },
    };
    students = replaceExamFollowUpState(studentsRow.payload, identity, {
      exists: true,
      value: nextFollowUpState,
    });
    tasks = tasksRow.payload.map((candidate) => candidate.id === identity.taskId ? {
      ...candidate,
      status: "done",
      tone: "green",
      closedAt: preparedAt,
      result: COMPLETE_RESULT,
    } : candidate);
  } else {
    const context = input.completionContext;
    if (!context) fail("completion_context_missing", "The completion snapshot is required for undo.");
    if (context.command_key !== input.command.completionCommandKey
      || context.task_id !== identity.taskId
      || context.student_id !== identity.studentId
      || context.exam_id !== identity.examId
      || context.follow_up_kind !== identity.followUpKind) {
      fail("completion_context_missing", "The completion snapshot does not belong to this follow-up.");
    }
    if (!same(task, context.committed_task)
      || !same(currentFollowUp.value, context.committed_follow_up_state)) {
      fail("follow_up_action_conflict", "The completed task or exam follow-up changed after completion.");
    }
    if (!isRecord(context.prior_task)
      || (context.prior_follow_up_state !== null && !isRecord(context.prior_follow_up_state))) {
      fail("completion_context_missing", "The completion snapshot is invalid.");
    }
    students = replaceExamFollowUpState(studentsRow.payload, identity, {
      exists: context.prior_follow_up_state_exists,
      value: (context.prior_follow_up_state ?? {}) as ExamFollowUpState,
    });
    tasks = tasksRow.payload.map((candidate) => candidate.id === identity.taskId
      ? context.prior_task
      : candidate);
  }

  return {
    commandKey: input.command.commandKey,
    commandIntent: examFollowUpIntent(input.command),
    action: input.command.action,
    ...(input.command.completionCommandKey
      ? { completionCommandKey: input.command.completionCommandKey }
      : {}),
    expectedVersions: input.command.expectedVersions,
    ...identity,
    students,
    tasks,
    preparedAt,
  };
}

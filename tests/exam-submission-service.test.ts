import assert from "node:assert/strict";
import test from "node:test";

import {
  ExamSubmissionServiceError,
  examSubmissionIntent,
  parseExamSubmissionCommand,
  prepareExamSubmission,
  type ExamSubmissionCommand,
} from "../lib/exam-submission-service";
import type { OpsStateRow } from "../lib/ops-store";

const COMMAND_KEY = "exam-submit:123e4567-e89b-42d3-a456-426614174000";

function row(entity: string, payload: unknown, version = 3): OpsStateRow {
  return { entity, payload, version, updated_at: "2026-08-15T00:00:00.000Z", updated_by: "Nixon" };
}

function student(overrides: Record<string, unknown> = {}) {
  return {
    id: "STU-1",
    name: "Student One",
    owner: "Abby",
    planner: "Tara",
    status: "在读",
    exams: [],
    ...overrides,
  };
}

function rows(studentOverrides: Record<string, unknown> = {}, tasks: unknown[] = []): OpsStateRow[] {
  return [
    row("students", [student(studentOverrides)]),
    row("tasks", tasks),
    row("teachers", []),
    row("bookings", []),
  ];
}

function command(overrides: Partial<ExamSubmissionCommand> = {}): ExamSubmissionCommand {
  return {
    commandKey: COMMAND_KEY,
    studentId: "STU-1",
    expectedVersions: { students: 3, tasks: 3 },
    exam: {
      id: "EXM-1",
      subject: "Selective",
      examType: "selective",
      examVariant: "selective",
      examMonth: "2026-09",
      examDate: "2026-09-01",
      includeRecall: true,
    },
    ...overrides,
  };
}

function code(error: unknown) {
  return error instanceof ExamSubmissionServiceError ? error.code : "unexpected";
}

test("parses a closed exam command and rejects browser-owned projections", () => {
  const parsed = parseExamSubmissionCommand(command());
  assert.equal(parsed.exam.examVariant, "selective");
  assert.deepEqual(examSubmissionIntent(parsed), { studentId: "STU-1", exam: parsed.exam });
  assert.throws(() => parseExamSubmissionCommand({ ...command(), tasks: [] }), (error) => code(error) === "client_fields_forbidden");
  assert.throws(() => parseExamSubmissionCommand({
    ...command(),
    exam: { ...command().exam, followUpState: {} },
  }), (error) => code(error) === "client_fields_forbidden");
  assert.throws(() => parseExamSubmissionCommand({ ...command(), commandKey: "exam-submit:guessable" }), (error) => code(error) === "invalid_request");
  assert.throws(() => parseExamSubmissionCommand({
    ...command(), commandKey: COMMAND_KEY.toUpperCase(),
  }), (error) => code(error) === "invalid_request");
});

test("derives the student exam and exact owner/planner managed tasks on the server", () => {
  const prepared = prepareExamSubmission({
    command: command(),
    rows: rows(),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.equal(prepared.action, "create");
  assert.equal(prepared.generatedTaskCount, 3);
  assert.deepEqual(prepared.unresolvedRoleLabels, []);
  const savedStudent = prepared.students[0];
  assert.equal(savedStudent.examSubject, "Selective");
  assert.equal(savedStudent.resultDate, "2026-10-01");
  const tasks = prepared.tasks as Record<string, unknown>[];
  assert.deepEqual(tasks.map((task) => task.ruleKey), [
    "exam:EXM-1:care",
    "exam:EXM-1:recall",
    "exam:EXM-1:results",
  ]);
  assert.deepEqual(tasks.map((task) => task.owner), ["Abby", "Abby", "Tara"]);
  assert.deepEqual(tasks.map((task) => task.watchers), [["Ops Admin"], ["Ops Admin"], ["Ops Admin"]]);
  assert.equal(tasks[0].id, "TSK-EXAM-3f7fe3d5d033949ce01f735e");
  assert.equal(tasks[0].anchorBookingId, "exam:EXM-1");
  assert.equal(tasks[0].dueAt, "2026-09-01T08:00:00.000Z");
});

test("matches the SQL C collation for equal-date punctuation ids", () => {
  const prepared = prepareExamSubmission({
    command: command(),
    rows: rows({ exams: [{ ...command().exam, id: "EXM_1" }] }),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(
    (prepared.students[0].exams as Record<string, unknown>[]).map((exam) => exam.id),
    ["EXM-1", "EXM_1"],
  );
});

test("editing preserves server-owned follow-up completion and sticky task identity", () => {
  const completedAt = "2026-08-01T02:00:00.000Z";
  const existingExam = {
    ...command().exam,
    subject: "Old subject",
    followUpState: { exam_care: { status: "completed", completedAt, completedBy: "Abby" } },
  };
  const existingTask = {
    id: "TSK-OLD",
    title: "old",
    owner: "Abby",
    assignees: ["Abby"],
    watchers: ["Ops Admin"],
    studentId: "STU-1",
    due: "2026-09-01 18:00",
    dueAt: "2026-09-01T08:00:00.000Z",
    status: "done",
    tone: "green",
    category: "考试",
    trigger: "old",
    result: "人工已完成",
    closedAt: completedAt,
    ruleKey: "exam:EXM-1:care",
    anchorBookingId: "exam:EXM-1",
  };
  const prepared = prepareExamSubmission({
    command: command({ exam: { ...command().exam, subject: "New subject" } }),
    rows: rows({ exams: [existingExam] }, [existingTask]),
    actor: "Abby",
    role: "staff",
    fullAdmin: false,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.equal(prepared.action, "update");
  const exam = (prepared.students[0].exams as Record<string, unknown>[])[0];
  assert.deepEqual(exam.followUpState, existingExam.followUpState);
  const care = (prepared.tasks as Record<string, unknown>[]).find((task) => task.ruleKey === "exam:EXM-1:care")!;
  assert.equal(care.id, "TSK-OLD");
  assert.equal(care.status, "done");
  assert.equal(care.result, "人工已完成");
  assert.equal(care.title, "New subject考试当天关心");
});

test("fails closed on stale versions, teacher writes, archived students and global exam id conflicts", () => {
  assert.throws(() => prepareExamSubmission({
    command: command({ expectedVersions: { students: 2, tasks: 3 } }),
    rows: rows(), actor: "Nixon", role: "admin", fullAdmin: true,
  }), (error) => code(error) === "stale_expected_version");
  assert.throws(() => prepareExamSubmission({
    command: command(), rows: rows(), actor: "Teacher", role: "teacher", fullAdmin: false,
  }), (error) => code(error) === "teacher_forbidden");
  assert.throws(() => prepareExamSubmission({
    command: command(), rows: rows({ importArchived: true }), actor: "Nixon", role: "admin", fullAdmin: true,
  }), (error) => ["student_scope_forbidden", "archived_student_read_only"].includes(code(error)));
  const conflictRows = rows();
  (conflictRows[0].payload as unknown[]).push(student({ id: "STU-2", exams: [command().exam] }));
  assert.throws(() => prepareExamSubmission({
    command: command(), rows: conflictRows, actor: "Nixon", role: "admin", fullAdmin: true,
  }), (error) => code(error) === "exam_identity_conflict");
});

test("unconfigured planner closes/omits only the results task without guessing a recipient", () => {
  for (const planner of ["待分配", "角色待配置：课程规划"]) {
    const prepared = prepareExamSubmission({
      command: command(),
      rows: rows({ planner }),
      actor: "Nixon",
      role: "admin",
      fullAdmin: true,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    assert.equal(prepared.generatedTaskCount, 2);
    assert.deepEqual(prepared.unresolvedRoleLabels, ["课程规划"]);
    assert.equal((prepared.tasks as Record<string, unknown>[]).some((task) => task.ruleKey === "exam:EXM-1:results"), false);
  }
});

test("fails closed if a deterministic managed task id collides with an unrelated task", () => {
  const first = prepareExamSubmission({
    command: command(), rows: rows(), actor: "Nixon", role: "admin", fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  const collidingId = String(first.tasks[0].id);
  const unrelated = {
    id: collidingId,
    title: "manual",
    owner: "Abby",
    studentId: "STU-1",
    due: "待确认",
    status: "waiting",
    tone: "neutral",
    category: "资料",
    trigger: "人工创建",
  };
  assert.throws(() => prepareExamSubmission({
    command: command(), rows: rows({}, [unrelated]), actor: "Nixon", role: "admin", fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  }), (error) => code(error) === "invalid_shared_state");
});

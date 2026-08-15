import assert from "node:assert/strict";
import test from "node:test";

import {
  ExamFollowUpServiceError,
  authorizeExamFollowUpCommand,
  examFollowUpIntent,
  parseExamFollowUpCommand,
  prepareExamFollowUp,
  type ExamFollowUpCommand,
  type ExamFollowUpCompletionContext,
} from "../lib/exam-follow-up-service";
import type { OpsStateRow } from "../lib/ops-store";

const COMMAND_KEY = "exam-follow-up:123e4567-e89b-42d3-a456-426614174000";
const UNDO_KEY = "exam-follow-up:123e4567-e89b-42d3-a456-426614174001";

function row(entity: string, payload: unknown, version = 7): OpsStateRow {
  return { entity, payload, version, updated_at: "2026-08-15T00:00:00.000Z", updated_by: "Nixon" };
}

function student(overrides: Record<string, unknown> = {}) {
  return {
    id: "STU-1",
    name: "Student One",
    owner: "Abby",
    planner: "Tara",
    status: "在读",
    exams: [{
      id: "EXM-1",
      subject: "Selective",
      examType: "selective",
      examVariant: "selective",
      examMonth: "2026-09",
      examDate: "2026-09-01",
      includeRecall: true,
    }],
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "TSK-1",
    title: "Selective考试当天关心",
    owner: "Abby",
    assignees: ["Abby"],
    watchers: ["Ops Admin"],
    studentId: "STU-1",
    due: "2026-09-01 18:00",
    dueAt: "2026-09-01T08:00:00.000Z",
    status: "upcoming",
    tone: "amber",
    category: "考试",
    trigger: "Selective 考试记录 · 收件：Abby",
    ruleKey: "exam:EXM-1:care",
    anchorBookingId: "exam:EXM-1",
    ...overrides,
  };
}

function rows(studentValue = student(), taskValue = task(), version = 7): OpsStateRow[] {
  return [
    row("students", [studentValue], version),
    row("tasks", [taskValue], version),
  ];
}

function command(overrides: Partial<ExamFollowUpCommand> = {}): ExamFollowUpCommand {
  return {
    commandKey: COMMAND_KEY,
    action: "complete",
    taskId: "TSK-1",
    expectedVersions: { students: 7, tasks: 7 },
    ...overrides,
  };
}

function errorCode(error: unknown) {
  return error instanceof ExamFollowUpServiceError ? error.code : "unexpected";
}

test("parses the narrow follow-up command and excludes all derived browser fields", () => {
  const parsed = parseExamFollowUpCommand(command());
  assert.deepEqual(examFollowUpIntent(parsed), { action: "complete", taskId: "TSK-1" });
  for (const forbidden of ["studentId", "examId", "followUpKind", "completedAt", "students", "tasks", "recipient"]) {
    assert.throws(
      () => parseExamFollowUpCommand({ ...command(), [forbidden]: forbidden }),
      (error) => errorCode(error) === "client_fields_forbidden",
    );
  }
  assert.throws(
    () => parseExamFollowUpCommand({ ...command(), completionCommandKey: COMMAND_KEY }),
    (error) => errorCode(error) === "client_fields_forbidden",
  );
  const undo = parseExamFollowUpCommand({
    ...command(),
    commandKey: UNDO_KEY,
    action: "undo",
    completionCommandKey: COMMAND_KEY,
  });
  assert.deepEqual(examFollowUpIntent(undo), {
    action: "undo",
    taskId: "TSK-1",
    completionCommandKey: COMMAND_KEY,
  });
  assert.throws(
    () => parseExamFollowUpCommand({ ...command(), action: "undo" }),
    (error) => errorCode(error) === "invalid_request",
  );
  assert.throws(
    () => parseExamFollowUpCommand({ ...command(), commandKey: COMMAND_KEY.toUpperCase() }),
    (error) => errorCode(error) === "invalid_request",
  );
});

test("derives exact task and exam-step completion from server state and time", () => {
  const beforeRows = rows();
  const prepared = prepareExamFollowUp({
    command: command(),
    rows: beforeRows,
    actor: "Abby",
    role: "staff",
    fullAdmin: false,
    now: new Date("2026-08-15T01:02:03.000Z"),
  });
  assert.deepEqual(
    prepared.students[0].exams,
    [{
      ...(student().exams as Record<string, unknown>[])[0],
      followUpState: {
        exam_care: {
          status: "completed",
          completedAt: "2026-08-15T01:02:03.000Z",
          completedBy: "Abby",
        },
      },
    }],
  );
  assert.deepEqual(prepared.tasks[0], {
    ...task(),
    status: "done",
    tone: "green",
    closedAt: "2026-08-15T01:02:03.000Z",
    result: "已由当前操作员确认完成",
  });
  assert.equal(prepared.studentId, "STU-1");
  assert.equal(prepared.examId, "EXM-1");
  assert.equal(prepared.followUpKind, "exam_care");
  assert.deepEqual(beforeRows[0].payload, [student()], "the source snapshot must remain immutable");
});

test("permits full/limited admins or the exact derived assignee, never a teacher or watcher", () => {
  assert.doesNotThrow(() => authorizeExamFollowUpCommand({
    command: command(), rows: rows(), actor: "Nixon", role: "admin", fullAdmin: true,
  }));
  assert.doesNotThrow(() => authorizeExamFollowUpCommand({
    command: command(), rows: rows(), actor: "Ops Admin", role: "limited-admin", fullAdmin: false,
  }));
  assert.throws(() => authorizeExamFollowUpCommand({
    command: command(), rows: rows(), actor: "Tara", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "task_scope_forbidden");
  assert.throws(() => authorizeExamFollowUpCommand({
    command: command(), rows: rows(), actor: "Abby", role: "teacher", fullAdmin: false,
  }), (error) => errorCode(error) === "teacher_forbidden");

  const resultsTask = task({
    owner: "Tara",
    assignees: ["Tara"],
    tone: "purple",
    ruleKey: "exam:EXM-1:results",
  });
  const identity = authorizeExamFollowUpCommand({
    command: command(), rows: rows(student(), resultsTask), actor: "Tara", role: "staff", fullAdmin: false,
  });
  assert.equal(identity.followUpKind, "exam_results_follow_up");
});

test("fails closed on stale versions, archive, invalid recipient projection and terminal states", () => {
  assert.throws(() => prepareExamFollowUp({
    command: command({ expectedVersions: { students: 6, tasks: 7 } }),
    rows: rows(), actor: "Abby", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "stale_expected_version");
  assert.throws(() => prepareExamFollowUp({
    command: command(), rows: rows(student({ importArchived: true })),
    actor: "Abby", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "archived_student_read_only");
  assert.throws(() => prepareExamFollowUp({
    command: command(), rows: rows(student(), task({ watchers: ["Someone Else"] })),
    actor: "Abby", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "task_recipient_conflict");
  assert.throws(() => prepareExamFollowUp({
    command: command(), rows: rows(student(), task({ status: "done" })),
    actor: "Abby", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "follow_up_action_conflict");
  const notRequired = student({
    exams: [{ ...(student().exams as Record<string, unknown>[])[0], followUpState: { exam_care: { status: "not_required" } } }],
  });
  assert.throws(() => prepareExamFollowUp({
    command: command(), rows: rows(notRequired), actor: "Abby", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "follow_up_action_conflict");
});

test("undo restores the exact ledger before-image and rejects any post-completion change", () => {
  const completed = prepareExamFollowUp({
    command: command(), rows: rows(), actor: "Abby", role: "staff", fullAdmin: false,
    now: new Date("2026-08-15T01:02:03.000Z"),
  });
  const context: ExamFollowUpCompletionContext = {
    command_key: COMMAND_KEY,
    task_id: "TSK-1",
    student_id: "STU-1",
    exam_id: "EXM-1",
    follow_up_kind: "exam_care",
    prior_task: task(),
    prior_follow_up_state_exists: false,
    prior_follow_up_state: null,
    committed_task: completed.tasks[0],
    committed_follow_up_state: ((completed.students[0].exams as Record<string, unknown>[])[0].followUpState as Record<string, unknown>),
  };
  const undoCommand = command({
    commandKey: UNDO_KEY,
    action: "undo",
    completionCommandKey: COMMAND_KEY,
    expectedVersions: { students: 8, tasks: 8 },
  });
  const committedRows = rows(completed.students[0], completed.tasks[0], 8);
  const undone = prepareExamFollowUp({
    command: undoCommand,
    rows: committedRows,
    actor: "Abby",
    role: "staff",
    fullAdmin: false,
    completionContext: context,
    now: new Date("2026-08-15T01:03:00.000Z"),
  });
  assert.deepEqual(undone.tasks[0], task());
  assert.deepEqual(undone.students[0], student());

  assert.throws(() => prepareExamFollowUp({
    command: undoCommand,
    rows: rows(completed.students[0], { ...completed.tasks[0], title: "changed" }, 8),
    actor: "Abby",
    role: "staff",
    fullAdmin: false,
    completionContext: context,
  }), (error) => errorCode(error) === "follow_up_action_conflict");
});


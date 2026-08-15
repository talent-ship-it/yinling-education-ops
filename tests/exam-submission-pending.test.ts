import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePendingExamSubmission,
  pendingExamMatchesDraft,
  pendingExamRecoveryCommand,
  type PendingExamSubmission,
} from "../lib/exam-submission-pending";

const draft = {
  subject: "Maths",
  examType: "other",
  examVariant: "school_other",
  examMonth: "2026-09",
  examDate: "2026-09-20",
  includeRecall: true,
};

const pending: PendingExamSubmission = {
  commandKey: "exam-submit:123e4567-e89b-42d3-a456-426614174000",
  examId: "EXM-ORIGINAL",
  intent: JSON.stringify(["STU-ORIGINAL", { id: "EXM-ORIGINAL", ...draft }]),
};

test("pending exam recovery preserves the exact original actor-level command", () => {
  assert.deepEqual(pendingExamRecoveryCommand(pending), {
    commandKey: pending.commandKey,
    studentId: "STU-ORIGINAL",
    exam: { id: "EXM-ORIGINAL", ...draft },
  });
  assert.deepEqual(parsePendingExamSubmission(JSON.parse(JSON.stringify(pending))), pending);
});

test("a pending exam never matches a different student or changed draft", () => {
  assert.equal(pendingExamMatchesDraft(pending, "STU-ORIGINAL", draft), true);
  assert.equal(pendingExamMatchesDraft(pending, "STU-OTHER", draft), false);
  assert.equal(pendingExamMatchesDraft(pending, "STU-ORIGINAL", {
    ...draft,
    subject: "English",
  }), false);
});

test("malformed pending storage cannot become a recovery command", () => {
  assert.equal(parsePendingExamSubmission({ ...pending, commandKey: "exam-submit:UPPERCASE" }), null);
  assert.equal(parsePendingExamSubmission({ ...pending, examId: "EXM-DIFFERENT" }), null);
  assert.equal(pendingExamRecoveryCommand({ ...pending, intent: "not-json" }), null);
});

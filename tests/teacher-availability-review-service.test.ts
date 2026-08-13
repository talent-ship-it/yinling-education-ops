import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store.ts";
import {
  buildTeacherAvailabilityReviewInbox,
  hasTeacherAvailabilityReviewAdminAccess,
  parseTeacherAvailabilityReviewRequest,
  prepareTeacherAvailabilityReview,
  TeacherAvailabilityReviewServiceError,
} from "../lib/teacher-availability-review-service.ts";
import { createMonthlyAvailabilityWindows } from "../lib/teacher-availability.ts";

function submission(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    teacher_id: "T-001",
    teacher_name: "Teacher A",
    submission_month: "2026-09",
    availability_timezone: "Australia/Melbourne",
    current_city: "Melbourne",
    additional_students: 2,
    availability_slots: [{ day: 1, start: "09:00", end: "12:00" }],
    notes: "Away 10 September",
    status: "pending",
    submitted_at: "2026-08-12T03:00:00.000Z",
    reviewed_at: null,
    reviewed_by: null,
    review_note: null,
    ...overrides,
  };
}

function teachersRow(version = 9): OpsStateRow {
  return {
    entity: "teachers",
    version,
    updated_at: "2026-08-12T00:00:00.000Z",
    updated_by: "Nixon",
    payload: [{
      id: "T-001",
      name: "Teacher A",
      availabilityWindows: createMonthlyAvailabilityWindows({
        teacherId: "T-001",
        month: "2026-08",
        timezone: "Australia/Melbourne",
        slots: [{ day: 2, start: "13:00", end: "15:00" }],
        idSeed: "august",
      }),
    }],
  };
}

function serviceError(code: TeacherAvailabilityReviewServiceError["code"]) {
  return (error: unknown) => error instanceof TeacherAvailabilityReviewServiceError
    && error.code === code;
}

test("only full or limited administrators can review teacher AVA", () => {
  assert.equal(hasTeacherAvailabilityReviewAdminAccess("Nixon", true), true);
  assert.equal(hasTeacherAvailabilityReviewAdminAccess("Nixon", false), false);
  assert.equal(hasTeacherAvailabilityReviewAdminAccess("Ops Admin", false), true);
  assert.equal(hasTeacherAvailabilityReviewAdminAccess("Abby", false), false);
});

test("strict request accepts no browser-computed availability windows", () => {
  const request = {
    submissionId: 17,
    decision: "approved" as const,
    expectedTeacherVersion: 9,
  };
  assert.deepEqual(parseTeacherAvailabilityReviewRequest(request), request);
  assert.throws(() => parseTeacherAvailabilityReviewRequest({
    ...request,
    availabilityWindows: [],
  }), serviceError("invalid_request"));
  assert.throws(() => parseTeacherAvailabilityReviewRequest({
    ...request,
    reviewNote: "x".repeat(1001),
  }), serviceError("invalid_request"));
});

test("inbox exposes pending normalized submissions with the exact teacher version", () => {
  const inbox = buildTeacherAvailabilityReviewInbox({
    rows: [submission(), submission({ id: 18, status: "approved" })],
    teachersRow: teachersRow(),
  });
  assert.equal(inbox.teacherVersion, 9);
  assert.equal(inbox.submissions.length, 1);
  assert.deepEqual(inbox.submissions[0].submission, {
    id: "17",
    teacherId: "T-001",
    month: "2026-09",
    timezone: "Australia/Melbourne",
    slots: [{ day: 1, start: "09:00", end: "12:00" }],
  });
});

test("approval computes month replacement from database rows and keeps other months", () => {
  const prepared = prepareTeacherAvailabilityReview({
    request: { submissionId: 17, decision: "approved", expectedTeacherVersion: 9 },
    rows: [submission()],
    teachersRow: teachersRow(),
    actor: "Nixon",
    fullAdmin: true,
  });
  assert.equal(prepared.expectedSubmissionStatus, "pending");
  assert.equal(prepared.availabilityWindows?.length, 2);
  const september = prepared.availabilityWindows?.find((window) => window.validFrom === "2026-09-01");
  assert.equal(september?.sourceSubmissionId, "17");
  assert.equal(september?.timezone, "Australia/Melbourne");
  assert.equal(prepared.availabilityWindows?.some((window) => window.validFrom === "2026-08-01"), true);
});

test("rejection performs no teacher-window write while still binding current version", () => {
  const prepared = prepareTeacherAvailabilityReview({
    request: { submissionId: 17, decision: "rejected", expectedTeacherVersion: 9 },
    rows: [submission()],
    teachersRow: teachersRow(),
    actor: "Ops Admin",
    fullAdmin: false,
  });
  assert.equal(prepared.availabilityWindows, null);
  assert.equal(prepared.expectedTeacherVersion, 9);
});

test("invalid IANA timezone, stale version and reviewed rows fail closed", () => {
  assert.throws(() => prepareTeacherAvailabilityReview({
    request: { submissionId: 17, decision: "approved", expectedTeacherVersion: 9 },
    rows: [submission({ availability_timezone: "Melbourne time" })],
    teachersRow: teachersRow(),
    actor: "Nixon",
    fullAdmin: true,
  }), serviceError("invalid_submission"));
  assert.throws(() => prepareTeacherAvailabilityReview({
    request: { submissionId: 17, decision: "approved", expectedTeacherVersion: 8 },
    rows: [submission()],
    teachersRow: teachersRow(),
    actor: "Nixon",
    fullAdmin: true,
  }), serviceError("stale_teacher_version"));
  assert.throws(() => prepareTeacherAvailabilityReview({
    request: { submissionId: 17, decision: "approved", expectedTeacherVersion: 9 },
    rows: [submission({ status: "approved" })],
    teachersRow: teachersRow(),
    actor: "Nixon",
    fullAdmin: true,
  }), serviceError("submission_changed"));
});

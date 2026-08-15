import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store.ts";
import {
  parseTeacherAvailabilitySubmitRequest,
  prepareTeacherAvailabilitySubmission,
  TeacherAvailabilitySubmitError,
} from "../lib/teacher-availability-submission-service.ts";

const submission = {
  submissionKey: "19b65143-b20d-43ab-9eb2-62bce33ef35a",
  month: "2026-09",
  timezone: "Australia/Melbourne",
  additionalStudents: 2,
  slots: [
    { day: 1, start: "09:00", end: "11:00" },
    { day: 3, start: "13:30", end: "15:00" },
  ],
  notes: " School holidays excluded ",
};

function code(expected: TeacherAvailabilitySubmitError["code"]) {
  return (error: unknown) => error instanceof TeacherAvailabilitySubmitError && error.code === expected;
}

function teachersRow(payload: unknown[] = [{ id: "T-1", name: "Helen Ceperkovic" }]): OpsStateRow {
  return { entity: "teachers", payload, version: 25, updated_at: "", updated_by: "" };
}

test("teacher AVA request has an exact narrow shape and normalises only safe text", () => {
  assert.deepEqual(parseTeacherAvailabilitySubmitRequest(submission, new Date("2026-08-15T00:00:00Z")), {
    ...submission,
    notes: "School holidays excluded",
  });
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    currentCity: "Melbourne",
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_request"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    teacherId: "T-1",
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_request"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    availabilitySourceText: "Monday afternoon",
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_request"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    slots: [{ id: "caller-id", day: 1, start: "09:00", end: "11:00" }],
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_slots"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    submissionKey: `teacher-availability-submit:${submission.submissionKey}`,
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_request"));
});

test("teacher AVA request rejects unsafe month, timezone and overlapping slots", () => {
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({ ...submission, month: "2026-07" }, new Date("2026-08-15T00:00:00Z")), code("invalid_month"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({ ...submission, month: "2027-09" }, new Date("2026-08-15T00:00:00Z")), code("invalid_month"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({ ...submission, timezone: "Mars/Olympus" }, new Date("2026-08-15T00:00:00Z")), code("invalid_timezone"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    slots: [{ day: 1, start: "22:00", end: "02:00" }],
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_slots"));
  assert.throws(() => parseTeacherAvailabilitySubmitRequest({
    ...submission,
    slots: [
      { day: 1, start: "22:00", end: "02:00" },
      { day: 2, start: "01:00", end: "03:00" },
    ],
  }, new Date("2026-08-15T00:00:00Z")), code("invalid_slots"));
});

test("server derives one teacher identity from the signed teacher session", () => {
  const request = parseTeacherAvailabilitySubmitRequest(submission, new Date("2026-08-15T00:00:00Z"));
  const prepared = prepareTeacherAvailabilitySubmission({
    request,
    teachersRow: teachersRow(),
    actor: "Helen Ceperkovic",
    role: "teacher",
  });
  assert.equal(prepared.teacherId, "T-1");
  assert.equal(prepared.teacherName, "Helen Ceperkovic");
  assert.equal(prepared.expectedTeacherVersion, 25);

  assert.throws(() => prepareTeacherAvailabilitySubmission({
    request,
    teachersRow: teachersRow(),
    actor: "Helen Ceperkovic",
    role: "staff",
  }), code("teacher_only"));
  assert.throws(() => prepareTeacherAvailabilitySubmission({
    request,
    teachersRow: teachersRow(),
    actor: "Unknown Teacher",
    role: "teacher",
  }), code("teacher_identity_not_found"));
  assert.throws(() => prepareTeacherAvailabilitySubmission({
    request,
    teachersRow: teachersRow([
      { id: "T-1", name: "Helen Ceperkovic" },
      { id: "T-2", name: " helen ceperkovic " },
    ]),
    actor: "Helen Ceperkovic",
    role: "teacher",
  }), code("teacher_identity_ambiguous"));
});

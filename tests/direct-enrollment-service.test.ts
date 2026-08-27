import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_ENROLLMENT_WORKFLOW,
  DirectEnrollmentError,
  parseDirectEnrollmentCommand,
  prepareDirectEnrollmentCommand,
} from "@/lib/direct-enrollment-service";

const fields = {
  responsibleOperations: "Tara",
  specifiedContentStatus: "无需指定",
  specialNotes: "",
  preparationFollowUp: "否",
  isUniversityStudent: false,
  universityMajor: "",
  universityYear: "",
  oneSentenceDescription: "直接报名",
  locationTimezone: "Australia/Melbourne",
  contactPerson: "家长",
  timeMentioned: false,
  preferredTime: "",
  lessonFrequency: "每周一次",
  coursesAndTeachers: "English / 待安排",
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    commandKey: "11111111-1111-4111-8111-111111111111",
    studentId: "STU-1",
    workflowType: DIRECT_ENROLLMENT_WORKFLOW,
    fields,
    purchasedHours: 10,
    bonusHours: 2,
    subject: "English",
    expectedVersions: { students: 3, lpItems: 4, tasks: 5 },
    ...overrides,
  };
}

test("direct enrollment parser accepts only the narrow command", () => {
  const parsed = parseDirectEnrollmentCommand(command());
  assert.equal(parsed.commandKey, "11111111-1111-4111-8111-111111111111");
  assert.equal(parsed.purchasedHours, 10);
});

test("direct enrollment parser rejects provisional IDs and derived arrays", () => {
  assert.throws(() => parseDirectEnrollmentCommand(command({ studentId: "STU-TEMP-1" })), (error: unknown) =>
    error instanceof DirectEnrollmentError && error.code === "provisional_not_supported");
  assert.throws(() => parseDirectEnrollmentCommand({ ...command(), students: [] }), /未允许/);
});

test("direct enrollment parser rejects invalid hours and zero total", () => {
  assert.throws(() => parseDirectEnrollmentCommand(command({ purchasedHours: -1 })), /非负/);
  assert.throws(() => parseDirectEnrollmentCommand(command({ purchasedHours: 0, bonusHours: 0 })), /大于 0/);
});

test("direct enrollment parser keeps conditional LP fields strict", () => {
  assert.throws(() => parseDirectEnrollmentCommand(command({
    fields: { ...fields, timeMentioned: true, preferredTime: "" },
  })), /preferredTime/);
});

test("subject authority includes a booking-only student subject", () => {
  const parsed = parseDirectEnrollmentCommand(command({ subject: "Chemistry" }));
  const rows = [
    { entity: "students", payload: [{ id: "STU-1", course: "English", lessonPackages: [] }], version: 3, updated_at: "", updated_by: "" },
    { entity: "lpItems", payload: [], version: 4, updated_at: "", updated_by: "" },
    { entity: "tasks", payload: [], version: 5, updated_at: "", updated_by: "" },
    { entity: "bookings", payload: [{ id: "B-1", studentId: "STU-1", teacherSubjectId: "Chemistry" }], version: 9, updated_at: "", updated_by: "" },
  ];
  assert.doesNotThrow(() => prepareDirectEnrollmentCommand({ command: parsed, rows, actor: "Tara", canOperateStudent: true }));
});

test("service keeps scope and archive guards fail closed", () => {
  const parsed = parseDirectEnrollmentCommand(command());
  const rows = [
    { entity: "students", payload: [{ id: "STU-1", course: "English", lessonPackages: [], importArchived: true }], version: 3, updated_at: "", updated_by: "" },
    { entity: "lpItems", payload: [], version: 4, updated_at: "", updated_by: "" },
    { entity: "tasks", payload: [], version: 5, updated_at: "", updated_by: "" },
    { entity: "bookings", payload: [], version: 9, updated_at: "", updated_by: "" },
  ];
  assert.throws(() => prepareDirectEnrollmentCommand({ command: parsed, rows, actor: "Tara", canOperateStudent: false }), (error: unknown) => error instanceof DirectEnrollmentError && error.code === "student_scope_forbidden");
  assert.throws(() => prepareDirectEnrollmentCommand({ command: parsed, rows, actor: "Tara", canOperateStudent: true }), (error: unknown) => error instanceof DirectEnrollmentError && error.code === "student_archived");
});

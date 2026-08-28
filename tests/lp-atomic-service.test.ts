import test from "node:test";
import assert from "node:assert/strict";

import { LpAtomicError, lpAtomicIntent, parseLpAtomicCommand, prepareLpAtomicCommand } from "@/lib/lp-atomic-service";
import type { OpsStateRow } from "@/lib/ops-store";

const fields = {
  responsibleOperations: "Abby",
  specifiedContentStatus: "无需指定",
  preparationFollowUp: "否",
  isUniversityStudent: false,
  subject: "English",
  assignedTeacher: "Abby",
  oneSentenceDescription: "trial",
  locationTimezone: "Australia/Melbourne",
  contactPerson: "家长",
  timeMentioned: false,
  studentNameKnown: true,
  trialPaymentMethod: "免费试听",
};
const versions = { students: 2, lpItems: 3, tasks: 4, files: 5 };

test("ordinary LP command is strict and intent excludes derived rows", () => {
  const command = parseLpAtomicCommand({
    commandKey: "11111111-1111-4111-8111-111111111111",
    operation: "create",
    studentId: "STU-1",
    workflowType: "试听 LP",
    fields,
    expectedVersions: versions,
  });
  assert.deepEqual(lpAtomicIntent(command), {
    operation: "create",
    studentId: "STU-1",
    workflowType: "试听 LP",
    fields,
    expectedVersions: versions,
  });
  assert.throws(() => parseLpAtomicCommand({
    commandKey: "11111111-1111-4111-8111-111111111111",
    operation: "create",
    studentId: "STU-1",
    workflowType: "试听 LP",
    fields,
    expectedVersions: versions,
    lpItems: [],
  }));
});

test("ordinary LP parser rejects direct enrollment before the package-bearing transaction can be bypassed", () => {
  assert.throws(() => parseLpAtomicCommand({
    commandKey: "66666666-6666-4666-8666-666666666666",
    operation: "create",
    studentId: "STU-1",
    workflowType: "学生直报（无试听）",
    fields: {
      responsibleOperations: "Abby",
      specifiedContentStatus: "无需指定",
      preparationFollowUp: "否",
      isUniversityStudent: false,
      oneSentenceDescription: "直接报名",
      locationTimezone: "Australia/Melbourne",
      contactPerson: "家长",
      timeMentioned: false,
      lessonFrequency: "每周一次",
      coursesAndTeachers: "English / 待安排",
      purchasedHours: 10,
      bonusHours: 2,
    },
    expectedVersions: versions,
  }), (error: unknown) => error instanceof LpAtomicError && error.code === "direct_enrollment_required");
});

test("provisional trial intake is strict, canonical, and has no browser-generated student id", () => {
  const command = parseLpAtomicCommand({
    commandKey: "33333333-3333-4333-8333-333333333333",
    operation: "create",
    workflowType: "试听 LP",
    fields,
    provisionalIntake: { course: "Year 8 English", guardianWechat: "Daisy", owner: "abby", planner: "tara" },
    expectedVersions: versions,
  });
  assert.equal(command.studentId, undefined);
  assert.deepEqual(command.provisionalIntake, { course: "Year 8 English", guardianWechat: "Daisy", owner: "Abby", planner: "Tara" });
  assert.throws(() => parseLpAtomicCommand({
    commandKey: "33333333-3333-4333-8333-333333333333",
    operation: "create",
    workflowType: "试听 LP",
    fields,
    provisionalIntake: { course: "Year 8 English", guardianWechat: "Daisy", owner: "Abby", planner: "Unknown" },
    expectedVersions: versions,
  }), /当前有效人员/);
});

test("provisional trial intake accepts a canonical approved admin owner", () => {
  const command = parseLpAtomicCommand({
    commandKey: "88888888-8888-4888-8888-888888888888",
    operation: "create",
    workflowType: "试听 LP",
    fields: { ...fields, responsibleOperations: "Nixon" },
    provisionalIntake: { course: "Year 8 English", guardianWechat: "Daisy", owner: "nixon", planner: "tara" },
    expectedVersions: versions,
  });
  assert.deepEqual(command.provisionalIntake, { course: "Year 8 English", guardianWechat: "Daisy", owner: "Nixon", planner: "Tara" });
});

function stateRows(student: Record<string, unknown>): OpsStateRow[] {
  const updated = "2026-08-20T00:00:00.000Z";
  return [
    { entity: "students", payload: [student], version: versions.students, updated_at: updated, updated_by: "seed" },
    { entity: "lpItems", payload: [], version: versions.lpItems, updated_at: updated, updated_by: "seed" },
    { entity: "tasks", payload: [], version: versions.tasks, updated_at: updated, updated_by: "seed" },
    { entity: "files", payload: [], version: versions.files, updated_at: updated, updated_by: "seed" },
  ];
}

test("full admin can create an LP for a student owned by an approved admin account", () => {
  const rows = stateRows({ id: "STU-1", owner: "Nixon", planner: "Tara" });
  const command = parseLpAtomicCommand({
    commandKey: "99999999-9999-4999-8999-999999999999",
    operation: "create",
    studentId: "STU-1",
    workflowType: "试听 LP",
    fields: { ...fields, responsibleOperations: "Nixon" },
    expectedVersions: versions,
  });
  const prepared = prepareLpAtomicCommand({ command, rows, canOperateStudent: true, actor: "Nixon", fullAdmin: true });
  assert.deepEqual(prepared.authorizedAssignment, { owner: "Nixon", planner: "Tara", mayReassign: true });
});

test("ordinary staff cannot transfer LP ownership and handover planner is authoritative", () => {
  const rows = stateRows({ id: "STU-1", owner: "Abby", planner: "Tara" });
  const spoofed = parseLpAtomicCommand({
    commandKey: "44444444-4444-4444-8444-444444444444",
    operation: "create",
    studentId: "STU-1",
    workflowType: "试听 LP",
    fields: { ...fields, responsibleOperations: "Ella" },
    expectedVersions: versions,
  });
  assert.throws(() => prepareLpAtomicCommand({ command: spoofed, rows, canOperateStudent: true, actor: "Abby", fullAdmin: false }), /当前归属/);

  const handover = parseLpAtomicCommand({
    commandKey: "55555555-5555-4555-8555-555555555555",
    operation: "create",
    studentId: "STU-1",
    workflowType: "学生报名交接",
    fields: { responsibleOperations: "Abby", specifiedContentStatus: "无需指定", preparationFollowUp: "否", isUniversityStudent: false, planner: "Tara", coursePackage: "20h", subject: "English", purchasedHours: 20, bonusHours: 0, lessonFrequency: "每周一次", preferredTime: "周六上午", coursesAndTeachers: "English / Helen", enrollmentHandoverNotes: "已完成报名交接" },
    expectedVersions: versions,
  });
  const prepared = prepareLpAtomicCommand({ command: handover, rows, canOperateStudent: true, actor: "Abby", fullAdmin: false });
  assert.deepEqual(prepared.authorizedAssignment, { owner: "Abby", planner: "Tara", mayReassign: false });
});

test("ordinary LP create rejects legacy-minimal handover payloads", () => {
  assert.throws(() => parseLpAtomicCommand({
    commandKey: "77777777-7777-4777-8777-777777777777",
    operation: "create",
    studentId: "STU-1",
    workflowType: "学生报名交接",
    fields: { responsibleOperations: "Abby", specifiedContentStatus: "无需指定", preparationFollowUp: "否", isUniversityStudent: false, planner: "Tara", coursePackage: "20h", subject: "English", enrollmentHandoverNotes: "legacy" },
    expectedVersions: versions,
  }), /purchasedHours/);
});

test("LP revision accepts only a valid document URL and preserves OCC versions", () => {
  const command = parseLpAtomicCommand({
    commandKey: "22222222-2222-4222-8222-222222222222",
    operation: "revise",
    studentId: "STU-1",
    lpItemId: "LP-1",
    fields: { documentUrl: "https://docs.qq.com/doc/abc" },
    revisionNote: "更新目标",
    expectedVersions: versions,
  });
  assert.equal(command.operation, "revise");
  assert.equal(command.fields.documentUrl, "https://docs.qq.com/doc/abc");
  assert.throws(() => parseLpAtomicCommand({
    commandKey: "22222222-2222-4222-8222-222222222222",
    operation: "revise",
    studentId: "STU-1",
    lpItemId: "LP-1",
    fields: { documentUrl: "javascript:alert(1)" },
    revisionNote: "",
    expectedVersions: versions,
  }));
});

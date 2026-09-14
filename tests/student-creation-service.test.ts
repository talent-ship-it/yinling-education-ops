import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeStudentCreationCommand, normalizeStudentCreationCommand, parseStudentCreationCommand, studentCreationIntent } from "../lib/student-creation-service";

const command = {
  commandKey: "student-create:123e4567-e89b-42d3-a456-426614174000",
  studentFields: { name: "Runtime Student", course: "Year 8 English", segment: "试听", guardianWechat: "", lpNeed: "试听LP", owner: "Abby", planner: "待分配", grade: "待确认", location: "VIC", timezone: "Australia/Melbourne", notes: "无特殊备注" },
  expectedVersions: { students: 3, tasks: 4 },
};

test("student creation parser accepts semantic fields and rejects browser-owned arrays", () => {
  const parsed = parseStudentCreationCommand(command);
  assert.equal(parsed.studentFields.name, "Runtime Student");
  assert.deepEqual(studentCreationIntent(parsed), { studentFields: parsed.studentFields, expectedVersions: parsed.expectedVersions });
  assert.throws(() => parseStudentCreationCommand({ ...command, students: [] }), /reviewed student-creation/);
});

test("student creation normalizes guardian identity and rejects forged assignment fields", () => {
  const trial = parseStudentCreationCommand({ ...command, studentFields: { ...command.studentFields, name: "", guardianWechat: "Guardian WX" } });
  assert.equal(normalizeStudentCreationCommand(trial, "Abby", false).studentFields.name, "Guardian WX");
  assert.throws(() => normalizeStudentCreationCommand(parseStudentCreationCommand({ ...command, studentFields: { ...command.studentFields, timezone: "Pacific/Unknown" } }), "Abby", false), /timezone/);
  assert.throws(() => normalizeStudentCreationCommand({ ...command, studentFields: { ...command.studentFields, owner: "Tiffany" } }, "Abby", false), /只能为自己负责/);
});

test("student replay canonicalization is independent of current owner scope", () => {
  const commandWithDifferentCurrentActor = parseStudentCreationCommand({
    ...command,
    studentFields: { ...command.studentFields, owner: "Tiffany" },
  });
  const canonical = canonicalizeStudentCreationCommand(commandWithDifferentCurrentActor);
  assert.equal(canonical.studentFields.owner, "Tiffany");
  assert.equal(canonical.studentFields.name, "Runtime Student");
  assert.throws(() => normalizeStudentCreationCommand(commandWithDifferentCurrentActor, "Abby", false), /只能为自己负责/);
});

test("retired owner remains replayable but cannot receive a new student", () => {
  const retired = parseStudentCreationCommand({ ...command, studentFields: { ...command.studentFields, owner: "思佳" } });
  assert.equal(canonicalizeStudentCreationCommand(retired).studentFields.owner, "思佳");
  assert.throws(() => normalizeStudentCreationCommand(retired, "Nixon", true), /已归档账号不能接收新学生/);
});

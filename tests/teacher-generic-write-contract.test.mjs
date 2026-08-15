import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transition = await readFile(new URL("../lib/ops-state-transition.ts", import.meta.url), "utf8");
const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("generic teacher writes are update-only and freeze imported authority", () => {
  const teacherGuard = transition.slice(
    transition.indexOf("function assertTeachersTransition"),
    transition.indexOf("function packages"),
  );
  assert.match(teacherGuard, /currentById\.size !== nextById\.size/);
  assert.match(teacherGuard, /新增或删除老师必须使用正式教师导入流程/);
  assert.match(teacherGuard, /changed\.some\(\(field\) => !TEACHER_MANUAL_EDIT_FIELDS\.has\(field\)\)/);
  for (const frozenField of [
    "name",
    "initials",
    "subjects",
    "subjectDetail",
    "departments",
    "sourceCategories",
    "teacherSourceRefs",
    "availabilitySourceText",
    "capacitySourceText",
  ]) {
    assert.doesNotMatch(
      transition.slice(transition.indexOf("const TEACHER_MANUAL_EDIT_FIELDS"), transition.indexOf("const TEACHER_AVAILABILITY_STATUSES")),
      new RegExp(`"${frozenField}"`),
    );
  }
});

test("generic teacher writes validate capacity, acceptance and AVA ownership on the server", () => {
  const teacherGuard = transition.slice(
    transition.indexOf("function assertTeachersTransition"),
    transition.indexOf("function packages"),
  );
  assert.match(teacherGuard, /typeof teacher\.acceptsStudents !== "boolean"/);
  assert.match(teacherGuard, /Number\.isSafeInteger\(capacity\)/);
  assert.match(teacherGuard, /capacity === 0 && teacher\.acceptsStudents/);
  assert.match(teacherGuard, /assertValidTeacherAvailability\(windows\)/);
  assert.match(teacherGuard, /window\.teacherId !== teacherId/);
});

test("payroll UI can only select an imported teacher and intake UI blocks zero capacity", () => {
  const submit = client.slice(client.indexOf("const submitNewPayroll"), client.indexOf("const submitPayrollEdit"));
  assert.doesNotMatch(submit, /newTeacherName|setTeachers|id\("TEA"\)/);
  const payrollDialog = client.slice(client.indexOf('{modal === "payrollNew"'), client.indexOf('{modal === "payrollEdit"'));
  assert.doesNotMatch(payrollDialog, /newTeacherName|新老师姓名/);
  assert.match(payrollDialog, /老师档案只能通过正式教师导入建立/);

  const toggle = client.slice(client.indexOf("const toggleTeacherAvailability"), client.indexOf("const submitTeacherCapacity"));
  assert.match(toggle, /Number\.isSafeInteger\(teacher\.newStudentCapacity\)/);
  assert.match(toggle, /可接新生数量，再开放接新/);
});

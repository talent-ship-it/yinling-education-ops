import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../app/operations-client.tsx", import.meta.url);

test("lesson-originated operation is explicitly scoped to the current lesson", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const dialog = source.slice(source.indexOf('{modal === "operation"'), source.indexOf('{modal === "renewal"'));

  assert.match(source, /operationHasSourceBooking = Boolean\(operationDraft\?\.sourceBookingId\)/);
  assert.match(dialog, /title=\{operationDialogTitle\}/);
  assert.match(dialog, /operationHasSourceBooking \? <label>本节学生/);
  assert.match(dialog, /<input value=\{studentById\(operationDraft\?\.studentId/);
  assert.match(dialog, /readOnly/);
  assert.match(dialog, /type="hidden" name="studentId"/);
  assert.match(dialog, /影响范围按当前课次处理/);
});

test("operations-page teacher absence, cover and departure are student-free batch flows", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const submit = source.slice(source.indexOf("const submitOperation ="), source.indexOf("const submitRenewalFollowUp ="));
  const dialog = source.slice(source.indexOf('{modal === "operation"'), source.indexOf('{modal === "renewal"'));

  assert.match(source, /title="调课与代课"/);
  assert.match(source, /批量记录老师异常/);
  assert.match(dialog, /按老师和影响日期处理全部受影响课程/);
  assert.match(dialog, /<option>老师请假<\/option><option>代课<\/option><option>老师离职<\/option>/);
  assert.match(submit, /submittedStudentId = String\(data\.get\("studentId"\) \?\? ""\)\.trim\(\)/);
  assert.match(submit, /studentId = submittedStudentId \|\| \(operationHasSourceBooking \? selectedStudent\.id : ""\)/);
  assert.match(submit, /if \(type === "老师请假" \|\| type === "请假" \|\| type === "代课"\)/);
  assert.match(submit, /operationHasSourceBooking[\s\S]*absenceEventStart/);
  const atomicBranch = submit.slice(submit.indexOf('if (type === "老师请假" || type === "请假" || type === "代课")'), submit.indexOf('if (!(["学生请假"'));
  assert.doesNotMatch(atomicBranch, /setOperations\(|setTasks\(/);
  const studentLegacyBranch = submit.slice(submit.indexOf('if (!(["学生请假"'), submit.indexOf("const submitRenewalFollowUp ="));
  assert.match(source, /\/api\/operations\/legacy\/create/);
  assert.doesNotMatch(studentLegacyBranch, /setOperations\(|setTasks\(/);
});

test("all student-targeting forms and handlers fail closed to scoped active students", async () => {
  const source = await readFile(sourceUrl, "utf8");
  for (const optionId of ["task-student-options", "booking-student-options", "file-student-options", "message-student-options"]) {
    const option = source.slice(source.indexOf(`id="${optionId}"`), source.indexOf(`id="${optionId}"`) + 500);
    assert.match(option, /scopedActiveStudents\.map/);
  }
  const classroomForm = source.slice(source.indexOf('name="studentId" value={temporaryClassroomStudentId}'), source.indexOf('{modal === "lessonSettlement"'));
  assert.match(classroomForm, /scopedActiveStudents\.map/);
  for (const functionName of ["submitTask", "submitBooking", "submitTemporaryClassroom", "submitFile", "submitTemplate"]) {
    const start = source.indexOf(`const ${functionName} =`);
    const body = source.slice(start, start + 10000);
    assert.match(body, /scopedActiveStudentIds\.has\(studentId\)/, functionName);
  }
  assert.doesNotMatch(source, /booking-student-options[\s\S]{0,300}recordStudents\.map/);
});

test("student creation selects only the returned scope-filtered authoritative row", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const command = source.slice(source.indexOf("const submitStudentCommand ="), source.indexOf("const submitStudent ="));
  assert.match(command, /studentsRow\.payload\.filter/);
  assert.match(command, /visibleStudentMatches\.length === 1/);
  assert.doesNotMatch(command, /scopedActiveStudentIds\.has\(body\.studentId\)/);
});

test("trial-payment recovery is strictly serialized", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const recovery = source.slice(source.indexOf("trialPaymentRecoveryActorRef.current === sessionOperator"), source.indexOf("const completeTask =", source.indexOf("trialPaymentRecoveryActorRef.current === sessionOperator")));
  assert.match(recovery, /for \(const entry of pending\.values\(\)\)[\s\S]*await mutateManagedTrialPayment\(entry\.taskId, entry\.action, true\)/);
  assert.doesNotMatch(recovery, /void mutateManagedTrialPayment\(entry\.taskId, entry\.action, true\)/);
});

test("batch preview dispatches to the matching read-only server workflow and ignores stale responses", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const preview = source.slice(source.indexOf("const previewTeacherAbsence ="), source.indexOf("const submitOperation ="));

  assert.match(preview, /type === "老师离职"/);
  assert.match(preview, /"\/api\/operations\/departure\/create"/);
  assert.match(preview, /"\/api\/operations\/teacher-absence\/create"/);
  assert.match(preview, /effectiveDate: eventEnd/);
  assert.match(preview, /teacherAbsencePreviewAbortRef\.current\?\.abort\(\)/);
  assert.match(preview, /signal: controller\.signal/);
  assert.match(preview, /requestId === teacherAbsencePreviewRequestRef\.current/);
});

test("course view keeps scheduling actions without provenance controls", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const courses = source.slice(source.indexOf("const renderCourses = () => {"), source.indexOf("const renderSchedule = () => {"));

  assert.doesNotMatch(courses, /openCourseSource|courseSourceExpanded|当前课程目录来源|查看同步来源/);
  assert.match(courses, /<CoursePackageSummary course=\{selectedCourse\} onOpenStudentPackage=\{openCourseStudentPackage\}/);
  assert.match(courses, /查看可见排课/);
  assert.match(courses, /新建排课/);
});

test("LP board and table use one actionable empty state when the saved view is empty", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const lp = source.slice(source.indexOf("const renderLp = () => {"), source.indexOf("const renderOperations = () => {"));

  assert.match(lp, /const openLpCreate = \(\) => \{[\s\S]*?setModal\("lp"\)/);
  assert.match(lp, /visibleLp\.length === 0 \? <EmptyState title="当前视图没有 LP"/);
  assert.match(lp, /action=\{<button className="primary-button" type="button" onClick=\{openLpCreate\}/);
  assert.match(lp, /当前身份没有进行中的 LP|当前保存视图没有符合条件的 LP/);
});

test("operation form required fields match the batch workflow, preserving single-student leave as the exception", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const submit = source.slice(source.indexOf("const submitOperation ="), source.indexOf("const submitRenewalFollowUp ="));
  const dialog = source.slice(source.indexOf('{modal === "operation"'), source.indexOf('{modal === "renewal"'));

  assert.match(source, /const operationFormType = operationDraft\?\.type \?\? \(operationHasSourceBooking \? "学生请假" : "老师请假"\)/);
  assert.match(dialog, /required=\{operationRequiresTeacherAndDates\}/g);
  assert.match(submit, /const operationRequiresTeacherAndDates = !operationHasSourceBooking \|\| type !== "学生请假"/);
  assert.match(submit, /批量老师请假、代课或离职必须填写有效的老师、影响起始日期和影响结束日期/);
});

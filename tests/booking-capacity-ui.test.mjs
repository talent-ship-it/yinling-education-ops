import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../app/operations-client.tsx", import.meta.url);

test("booking create, edit and delete await the atomic API before dependent writes", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /fetch\("\/api\/bookings\/mutate"/);
  assert.match(source, /bookingsShared\.applyRemote\(body\.bookingRow/);
  assert.match(source, /teachersShared\.applyRemote\(body\.teacherRow/);
  assert.match(source, /onConfirm: async \(\) => \{\s*await writeBookingCapacityMutation\(\{ action: "upsert"/);
  assert.match(source, /onConfirm: async \(\) => \{\s*await writeBookingCapacityMutation\(\{ action: "delete"/);

  const submitStart = source.indexOf("const submitBooking =");
  const submitEnd = source.indexOf("const submitOperation =", submitStart);
  const submitBody = source.slice(submitStart, submitEnd);
  const awaited = submitBody.indexOf("await writeBookingCapacityMutation");
  assert.ok(awaited > 0);
  assert.ok(submitBody.indexOf("setTasks", awaited) > awaited);
  assert.ok(submitBody.indexOf("setStudents", awaited) > awaited);
  assert.doesNotMatch(submitBody.slice(awaited), /setTeachers\(/);
  assert.doesNotMatch(submitBody.slice(awaited), /setBookings\(/);
});

test("booking UI hard-selects a subject and requires a package outside trials", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /<select name="subjectId"[\s\S]*required>/);
  assert.match(source, /required=\{bookingFormKind !== "试听"\}/);
  assert.match(source, /非试听课程必须选择本节课使用的课包/);
  assert.match(source, /课包“\$\{lessonPackage\.name\}”未绑定 \$\{subjectId\}/);
});

test("booking UI blocks a first relationship until capacity is configured", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /const targetCapacityConfigured = Number\.isSafeInteger\(teacher\.newStudentCapacity\)/);
  assert.match(source, /尚未录入可接新生数量，请先在老师档案中录入容量/);
  assert.match(source, /kind !== "代课" && firstTeacherStudentBooking && !targetCapacityConfigured/);
  assert.match(source, /kind !== "代课" && newTeacherStudentBooking && !targetCapacityConfigured/);
  assert.match(source, /const establishesTeacherStudentRelationship = kind !== "代课" && !bookings\.some/);
  assert.match(source, /establishesTeacherStudentRelationship && !teacher\.acceptsStudents/);
  assert.match(source, /已有师生关系可继续排课/);
  assert.doesNotMatch(source, /kind === "试听" && !teacher\.acceptsStudents/);
});

test("booking and temporary-classroom forms require the authoritative teacher subject category", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /teacherSubjectId\?: string/);
  assert.equal(source.match(/name="teacherSubjectId"/g)?.length, 2);
  assert.match(source, /teacherSubjectOptions = \[[\s\S]*"Local English"[\s\S]*"其他科目"[\s\S]*\] as const/);
  assert.match(source, /!teacherSubjectId \|\| !teacher\.subjects\.includes\(teacherSubjectId\)/);
  assert.match(source, /teacherSubjectId: input\.booking\.teacherSubjectId/);
  assert.match(source, /teacherSubjectId,\s*\n\s*};/);
  assert.match(source, /必须与所选老师所在的腾讯子表完全一致/);
});

test("teacher matching uses an explicit Tencent subject category and never invents a percentage", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /const teacherSubjectMatch = \(teacher: Teacher\) =>[\s\S]*teacherSubject !== "all"[\s\S]*teacher\.subjects\.includes\(teacherSubject\)/);
  assert.match(source, /先选腾讯表科目（匹配必选）/);
  assert.match(source, /disabled=\{!visibleSelectedTeacherReadiness\?\.readyForNewStudentMatching \|\| !teacherSubjectMatch\(visibleSelectedTeacher\)\}/);
  assert.match(source, /系统不会从课程名称猜测/);
  assert.doesNotMatch(source, /const teacherMatch =/);
  assert.doesNotMatch(source, /teacherMatch\([^)]*\)\s*>?=\s*85/);
});

test("single occurrence editing cannot settle abnormalities or change teachers and atomically deletes a single lesson", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const handler = source.slice(
    source.indexOf("const openBookingOccurrenceEditor ="),
    source.indexOf("const openNewBooking ="),
  );
  assert.match(handler, /\["completed", "abnormal", "leave"\]\.includes/);
  assert.doesNotMatch(handler, /data\.get\("teacherId"\)/);
  assert.match(handler, /const teacherId = bookingOccurrenceDraft\.teacherId/);
  assert.match(handler, /status === "cancelled" && singleLesson[\s\S]*await writeBookingCapacityMutation\(\{[\s\S]*action: "delete"/);

  const dialog = source.slice(
    source.indexOf('{modal === "bookingOccurrence"'),
    source.indexOf('{modal === "temporaryClassroom"'),
  );
  assert.doesNotMatch(dialog, /name="teacherId"/);
  assert.doesNotMatch(dialog, /value="abnormal"/);
  assert.doesNotMatch(dialog, /value="completed"/);
  assert.match(dialog, /改老师请使用代课或永久换老师流程/);
});

test("teacher departure creation sends only the narrow OCC command to the atomic server route", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const handler = source.slice(
    source.indexOf("const submitOperation ="),
    source.indexOf("const submitRenewalFollowUp ="),
  );
  assert.match(handler, /type === "老师离职"[\s\S]*fetch\("\/api\/operations\/departure\/create"/);
  assert.match(handler, /sourceTeacherId: teacherId,[\s\S]*effectiveDate: eventEnd,[\s\S]*detail,[\s\S]*expectedVersions:/);
  assert.match(handler, /bookings: bookingsShared\.version,[\s\S]*operations: operationsShared\.version,[\s\S]*students: studentsShared\.version,[\s\S]*tasks: tasksShared\.version,[\s\S]*teachers: teachersShared\.version/);
  assert.match(handler, /operationsShared\.applyRemote\(body\.operationRow/);
  assert.match(handler, /tasksShared\.applyRemote\(body\.taskRow/);
  assert.doesNotMatch(handler, /projectTeacherDepartureOccurrences/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

function sourceSection(startMarker, endMarker) {
  const start = client.indexOf(startMarker);
  const end = client.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return client.slice(start, end);
}

test("mounts the course catalogue from active role-scoped students and bookings only", () => {
  assert.match(client, /import \{ CoursePackageSummary \} from "@\/app\/course-package-summary"/);
  assert.match(client, /buildCoursePackageCatalog,[\s\S]*isActiveCoursePackageCatalogStudent,[\s\S]*from "@\/lib\/course-package-catalog"/);

  const scope = sourceSection(
    "const coursePackageCatalogScope = useMemo",
    "const readableScopedLpItems = useMemo",
  );
  assert.match(scope, /scopedStudents\.filter\(isActiveCoursePackageCatalogStudent\)/);
  assert.match(scope, /new Set\(activeStudents\.map\(\(student\) => student\.id\)\)/);
  assert.match(scope, /readableScopedBookings\.filter\(\(booking\) => activeStudentIds\.has\(booking\.studentId\)\)/);
  assert.match(scope, /students: activeStudents/);
  assert.match(scope, /bookings: activeBookings/);
  assert.match(scope, /\.\.\.\(isAdminView \? \{ teachers: recordTeachers, includeTeacherEligibility: true \} : \{\}\)/);
  assert.equal((scope.match(/recordTeachers/g) ?? []).length, 2, "teacher data may appear only in the admin branch and hook dependency");
});

test("renders every course statistic and navigation decision from the scoped catalogue", () => {
  const renderCourses = sourceSection("const renderCourses = () =>", "const renderSchedule = () =>");

  assert.match(renderCourses, /coursePackageCatalogScope\.catalog\.filter/);
  assert.match(renderCourses, /course\.bookingCount/);
  assert.match(renderCourses, /课程名称/);
  assert.match(renderCourses, /排课/);
  assert.match(renderCourses, /查看可见排课/);
  assert.match(renderCourses, /<CoursePackageSummary course=\{selectedCourse\} onOpenStudentPackage=\{openCourseStudentPackage\}/);
  assert.doesNotMatch(renderCourses, /course\.source|来源证据|当前课程目录来源|查看同步来源/);
  assert.doesNotMatch(renderCourses, /\bbookings\.filter\b|selectedCourseBookings|categoryFor/);
  assert.doesNotMatch(renderCourses, /课包与收费规则|待结构化导入|本周排课/);
});

test("course package navigation rechecks the active scope before opening a student record", () => {
  const openPackage = sourceSection(
    "const openCourseStudentPackage = (studentId: string) =>",
    "const addStudentRecord = (section: StudentRecordPanelSection) =>",
  );
  const guard = openPackage.indexOf("coursePackageCatalogScope.activeStudentIds.has(studentId)");
  const open = openPackage.indexOf('openStudentRecord(studentId, "lessonPackages")');

  assert.ok(guard >= 0);
  assert.ok(open > guard, "the active-scope guard must run before opening the record");
  assert.match(openPackage, /当前身份无权查看该学生课包/);
});

test("course booking entry is absent when the current staff scope has no active students", () => {
  const renderCourses = sourceSection("const renderCourses = () =>", "const renderSchedule = () =>");

  assert.match(renderCourses, /const hasActiveCourseBookingStudent = coursePackageCatalogScope\.activeStudentIds\.size > 0/);
  assert.match(renderCourses, /: hasActiveCourseBookingStudent\s*\? <button[\s\S]*?openNewBooking\(\)/);
  assert.match(renderCourses, /当前身份暂无可操作的活跃学生，不能新建排课/);
});

test("booking helper fails closed for an empty or switched staff scope", () => {
  const selectedStudent = sourceSection(
    "const selectedStudentPool =",
    "const lpDraftStudent =",
  );
  const openBooking = sourceSection(
    "const openNewBooking = (studentId?: string, teacherId?: string) =>",
    "const openBookingOperation =",
  );

  assert.match(selectedStudent, /const selectedScopedActiveStudent = scopedStudents\.find/);
  assert.match(openBooking, /const targetStudentId = requestedStudentId \|\| selectedScopedActiveStudent\?\.id/);
  assert.match(openBooking, /coursePackageCatalogScope\.activeStudentIds\.has\(targetStudentId\)/);
  assert.doesNotMatch(openBooking, /recordStudents\[0\]|selectedStudent\.id/);
  assert.match(openBooking, /当前身份暂无可操作的活跃学生/);
});

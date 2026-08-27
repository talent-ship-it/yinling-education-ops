import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("archived students stay readable while active student scope controls writes", async () => {
  const [access, transition] = await Promise.all([
    read("../lib/ops-access.ts"),
    read("../lib/ops-state-transition.ts"),
  ]);
  assert.match(access, /activeStudentIds: Set<string>/);
  assert.match(access, /student\.importArchived !== true/);
  assert.match(access, /export function canOperateStudent/);
  assert.match(access, /canAccessStudent\(context, studentId\) && context\.activeStudentIds\.has\(studentId\)/);
  for (const entity of ["tasks", "lpItems", "operations", "renewals", "messages", "files", "bookings", "payroll"]) {
    assert.match(transition, new RegExp(`"${entity}"`));
  }
  assert.match(transition, /学生导入归档标记只能由正式导入流程修改/);
  assert.match(transition, /existing\?\.importArchived === true && !same\(existing, student\)/);
});

test("dedicated write APIs reject archived students while historical reads remain allowed", async () => {
  const [
    bookingRoute,
    bookingService,
    fuUpload,
    fuDownload,
    classroom,
    operationRoute,
    operationService,
    settlementService,
    bbbService,
  ] = await Promise.all([
    read("../app/api/bookings/mutate/route.ts"),
    read("../lib/booking-capacity-service.ts"),
    read("../app/api/fu-attachments/route.ts"),
    read("../app/api/fu-attachments/[id]/route.ts"),
    read("../app/api/classroom/route.ts"),
    read("../app/api/operations/confirm/route.ts"),
    read("../lib/operation-occurrence-service.ts"),
    read("../lib/lesson-occurrence-service.ts"),
    read("../lib/bbb-analytics-service.ts"),
  ]);
  assert.doesNotMatch(bookingRoute, /canAccessStudent/);
  assert.match(bookingRoute, /canOperateStudent\(access, studentId\)[\s\S]*canOperateStudent\(access, existingStudentId\)/);
  assert.doesNotMatch(bookingService, /canAccessStudent/);
  assert.match(bookingService, /canOperateStudent\(access, targetStudentId\)[\s\S]*canOperateStudent\(access, oldStudentId\)/);
  assert.match(fuUpload, /canOperateStudent\(access, studentId\)/);
  assert.match(fuDownload, /canReadOpsEntity\(access, "files"\)/);
  assert.match(fuDownload, /canAccessStudent\(access, attachment\.student_id\)/);

  const classroomGet = classroom.slice(classroom.indexOf("export async function GET"), classroom.indexOf("export async function POST"));
  const classroomPost = classroom.slice(classroom.indexOf("export async function POST"));
  assert.doesNotMatch(classroomGet, /!context\.operable/);
  assert.match(classroomPost, /!context\.operable/);

  assert.match(operationRoute, /canOperateStudent\(access, visibleOperation\.studentId\)/);
  assert.match(operationService, /canOperateStudent\(access, stateText\(operation, "studentId", "operation"\)\)/);
  assert.match(settlementService, /student\.importArchived === true/);
  assert.match(bbbService, /prepareLessonOccurrenceSettlement/);
});

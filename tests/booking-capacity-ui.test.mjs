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
});

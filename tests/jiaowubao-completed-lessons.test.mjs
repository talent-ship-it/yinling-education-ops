import assert from "node:assert/strict";
import test from "node:test";

const {
  JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT,
  allJiaowubaoCompletedLessonRecords,
  assertJiaowubaoCompletedLessonSnapshotIntegrity,
  collectJiaowubaoCompletedLessonSnapshot,
  projectJiaowubaoCompletedLessonRecord,
  validateJiaowubaoClosedCompletedLessonMonth,
  validateJiaowubaoCompletedLessonMonth,
} = await import("../lib/jiaowubao-completed-lessons.ts");

function sourceRecord(overrides = {}) {
  return {
    branch_id: 10,
    cal_id: 7001,
    mem_id: 201,
    mem_title: "Zachary 张泽睿 (WA)",
    dated: "2026-08-05",
    time_start: 1900,
    time_end: 2000,
    hours: "1",
    type: 3,
    sign: 1,
    sign_title: "已到达",
    course_id: 11,
    course_title: "Zachary - English中文试听",
    team_id: 22,
    team_title: "试听班",
    teacher_id: 90,
    teacher_title: "Crystal Wong",
    over: 1,
    over_time: "2026-08-05 20:01:00",
    price: 999,
    logo: "https://example.invalid/avatar.png",
    note: "never snapshot this",
    ...overrides,
  };
}

test("completed lesson snapshot keeps only the curated, reconciliable evidence fields", async () => {
  const snapshot = await collectJiaowubaoCompletedLessonSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => ({ list: page === 1 ? [sourceRecord()] : [] }),
  );
  assert.equal(snapshot.manifest.format, JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT);
  assert.deepEqual(snapshot.manifest.query, {
    start: "2026-08-01", end: "2026-08-31", sign: -1, over: 1, limit: 100,
  });
  assert.equal(snapshot.manifest.recordCount, 1);
  const [record] = allJiaowubaoCompletedLessonRecords(snapshot);
  assert.deepEqual(record, {
    kind: "lesson",
    sourceKey: "jwb-open-api:lesson:10:7001:201",
    completed: true,
    branchId: "10",
    calendarId: "7001",
    memberId: "201",
    memberName: "Zachary 张泽睿 (WA)",
    lessonDate: "2026-08-05",
    timeTitle: "19:00-20:00",
    hours: 1,
    lessonType: 3,
    isTrial: true,
    attendanceCode: 1,
    attendanceTitle: "已到达",
    courseId: "11",
    courseTitle: "Zachary - English中文试听",
    teamId: "22",
    teamTitle: "试听班",
    teachers: [{ role: "primary", id: "90", name: "Crystal Wong" }],
    completedAt: "2026-08-05 20:01:00",
  });
  assert.equal("price" in record, false);
  assert.equal("logo" in record, false);
  assert.equal("note" in record, false);
  assert.doesNotThrow(() => assertJiaowubaoCompletedLessonSnapshotIntegrity(snapshot));
});

test("source manifest verification rejects a staged record that no longer matches its captured page hash", async () => {
  const snapshot = await collectJiaowubaoCompletedLessonSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => ({ list: page === 1 ? [sourceRecord()] : [] }),
  );
  const originalPage = snapshot.pages[0];
  const tampered = {
    ...snapshot,
    pages: [{
      ...originalPage,
      records: [{ ...originalPage.records[0], hours: 2 }],
    }],
  };
  assert.throws(() => assertJiaowubaoCompletedLessonSnapshotIntegrity(tampered), /散列不一致/);
});

test("completed source must be over=1, in the requested range, and uniquely identified", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ over: 0 }), window), /over=1/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ dated: "2026-09-01" }), window), /日期范围/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: null }), window), /branch_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ cal_id: null }), window), /cal_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_id: null }), window), /mem_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: "branch:one" }), window), /branch_id/);
});

test("an unassigned JWB secondary-teacher sentinel never becomes a phantom teacher", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ teacher_s: 0, teacher_s_title: "", teacher_t: "0", teacher_t_title: "" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  assert.deepEqual(record.teachers, [{ role: "primary", id: "90", name: "Crystal Wong" }]);
});

test("collector fails closed on a duplicate lesson participant rather than double counting it", async () => {
  await assert.rejects(
    collectJiaowubaoCompletedLessonSnapshot(
      { start: "2026-08-01", end: "2026-08-31" },
      async ({ page }) => ({ list: page === 1 ? [sourceRecord(), sourceRecord()] : [] }),
    ),
    /重复课节学员记录/,
  );
});

test("collector continues through a short nonempty page until the documented explicit empty page", async () => {
  const requestedPages = [];
  const snapshot = await collectJiaowubaoCompletedLessonSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => {
      requestedPages.push(page);
      return {
        list: page === 1
          ? [sourceRecord({ cal_id: 7001, mem_id: 201 })]
          : page === 2
            ? [sourceRecord({ cal_id: 7002, mem_id: 202 })]
            : [],
      };
    },
  );
  const records = allJiaowubaoCompletedLessonRecords(snapshot);
  assert.equal(records.length, 2);
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test("collector accepts 60 full data pages only after an empty page 61 probe", async () => {
  const requestedPages = [];
  const snapshot = await collectJiaowubaoCompletedLessonSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => {
      requestedPages.push(page);
      return {
        list: page <= 60
          ? Array.from({ length: 100 }, (_, index) => sourceRecord({
              cal_id: page * 1_000 + index,
              mem_id: page * 1_000 + index,
            }))
          : [],
      };
    },
  );
  assert.equal(snapshot.manifest.pageCount, 60);
  assert.equal(snapshot.manifest.recordCount, 6_000);
  assert.equal(requestedPages.at(-1), 61);
});

test("collector rejects a nonempty page 61 probe", async () => {
  await assert.rejects(
    collectJiaowubaoCompletedLessonSnapshot(
      { start: "2026-08-01", end: "2026-08-31" },
      async ({ page }) => ({
        list: [sourceRecord({ cal_id: page, mem_id: page })],
      }),
    ),
    /超过最大页数/,
  );
});

test("monthly input always resolves to exactly that calendar month", () => {
  assert.deepEqual(validateJiaowubaoCompletedLessonMonth("2026-02"), {
    month: "2026-02", start: "2026-02-01", end: "2026-02-28",
  });
  assert.deepEqual(validateJiaowubaoCompletedLessonMonth("2028-02"), {
    month: "2028-02", start: "2028-02-01", end: "2028-02-29",
  });
  assert.throws(() => validateJiaowubaoCompletedLessonMonth("2026-2"), /YYYY-MM/);
});

test("sync eligibility rejects current and future Melbourne months", () => {
  const now = new Date("2026-09-03T05:00:00.000Z");
  assert.equal(validateJiaowubaoClosedCompletedLessonMonth("2026-08", now).month, "2026-08");
  assert.throws(() => validateJiaowubaoClosedCompletedLessonMonth("2026-09", now), /完整结束/);
  assert.throws(() => validateJiaowubaoClosedCompletedLessonMonth("2026-10", now), /完整结束/);
});

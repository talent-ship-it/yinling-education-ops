import assert from "node:assert/strict";
import test from "node:test";

const {
  allJiaowubaoCompletedScheduleRecords,
  assertJiaowubaoCompletedScheduleSnapshotIntegrity,
  collectJiaowubaoCompletedScheduleSnapshot,
  collectJiaowubaoCompletedScheduleSnapshotWithMemberIds,
  projectJiaowubaoCompletedScheduleRecord,
  readJiaowubaoCompletedScheduleSnapshotRecord,
} = await import("../lib/jiaowubao-completed-schedule.ts");

function sourceRecord(overrides = {}) {
  return {
    cal_id: 7001,
    dated: "2026-08-05",
    time_start: 1900,
    time_end: 2000,
    course_id: 11,
    course_title: "Y9 ICAS English",
    team_id: 22,
    team_title: "Crystal Wong 一对一",
    teacher_id: 90,
    teacher_title: "Crystal Wong",
    teacher_hour: "1",
    teacher_s: 91,
    teacher_s_title: "Assistant Teacher",
    teacher_s_hour: 0.5,
    teacher_t: 0,
    teacher_t_title: "",
    teacher_t_hour: "",
    over: 1,
    over_time: "2026-08-05 20:01:00",
    stu_list: [{ mem_id: 201 }, { mem_id: "202" }],
    ignored_supplier_field: "not retained",
    ...overrides,
  };
}

function thrownMessage(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("expected action to throw");
}

test("completed schedule snapshot keeps one role-specific teacher credit per event", () => {
  const record = projectJiaowubaoCompletedScheduleRecord(
    sourceRecord(),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  assert.deepEqual(record, {
    kind: "schedule",
    sourceKey: "jwb-open-api:schedule:7001",
    completed: true,
    calendarId: "7001",
    lessonDate: "2026-08-05",
    timeTitle: "19:00-20:00",
    courseId: "11",
    courseTitle: "Y9 ICAS English",
    teamId: "22",
    teamTitle: "Crystal Wong 一对一",
    teachers: [
      { role: "primary", id: "90", name: "Crystal Wong", hours: 1 },
      { role: "assistant", id: "91", name: "Assistant Teacher", hours: 0.5 },
    ],
    completedAt: "2026-08-05 20:01:00",
  });
  assert.equal("ignored_supplier_field" in record, false);
});

test("completed schedule drops only the supplier's blank zero-hour teacher sentinel", () => {
  const record = projectJiaowubaoCompletedScheduleRecord(
    sourceRecord({
      teacher_s: 0,
      teacher_s_title: "",
      teacher_s_hour: 0,
      teacher_t: 0,
      teacher_t_title: "",
      teacher_t_hour: 0.5,
    }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  assert.deepEqual(record.teachers, [
    { role: "primary", id: "90", name: "Crystal Wong", hours: 1 },
    // Positive role hours with no identity remain visible and fail closed in
    // reconciliation instead of being silently discarded.
    { role: "third", id: null, name: null, hours: 0.5 },
  ]);
});

test("completed schedule normalizes only the supplier's numeric zero team-title sentinel", async () => {
  const period = { start: "2026-08-01", end: "2026-08-31" };
  const record = projectJiaowubaoCompletedScheduleRecord(sourceRecord({ team_title: 0 }), period);
  assert.equal(record.teamTitle, null);
  assert.deepEqual(readJiaowubaoCompletedScheduleSnapshotRecord(record), record);

  for (const teamTitle of [1, {}, []]) {
    assert.throws(
      () => projectJiaowubaoCompletedScheduleRecord(sourceRecord({ team_title: teamTitle }), period),
      /team_title 无效/,
    );
  }

  assert.throws(
    () => readJiaowubaoCompletedScheduleSnapshotRecord({ ...record, teamTitle: 0 }),
    /teamTitle 无效/,
  );

  const snapshot = await collectJiaowubaoCompletedScheduleSnapshot(
    period,
    async ({ page }) => ({ lists: page === 1 ? [sourceRecord({ team_title: 0 })] : [] }),
  );
  assert.doesNotThrow(() => assertJiaowubaoCompletedScheduleSnapshotIntegrity(snapshot));
});

test("invalid raw team-title diagnostics expose only a fixed structural category", () => {
  const period = { start: "2026-08-01", end: "2026-08-31" };
  const privateMarker = "must-not-reach-the-log";
  const cases = [
    [false, "boolean-false"],
    [true, "boolean-true"],
    [1, "number-nonzero"],
    [[], "array-empty"],
    [[privateMarker], "array-nonempty"],
    [{}, "object-empty"],
    [{ [privateMarker]: privateMarker }, "object-nonempty"],
  ];

  for (const [teamTitle, kind] of cases) {
    const message = thrownMessage(
      () => projectJiaowubaoCompletedScheduleRecord(sourceRecord({ team_title: teamTitle }), period),
    );
    assert.equal(message, `教务宝已结课排课的 team_title 无效（${kind}）。`);
    assert.equal(message.includes(privateMarker), false);
  }
});

test("completed schedule normalizes only blank raw team titles and keeps persisted DTOs strict", () => {
  const period = { start: "2026-08-01", end: "2026-08-31" };
  for (const teamTitle of ["", " ", "\t", "　"]) {
    const record = projectJiaowubaoCompletedScheduleRecord(sourceRecord({ team_title: teamTitle }), period);
    assert.equal(record.teamTitle, null);
    assert.deepEqual(readJiaowubaoCompletedScheduleSnapshotRecord(record), record);
  }

  const record = projectJiaowubaoCompletedScheduleRecord(sourceRecord({ team_title: " Team A " }), period);
  assert.equal(record.teamTitle, "Team A");
  assert.equal(
    thrownMessage(() => projectJiaowubaoCompletedScheduleRecord(
      sourceRecord({ team_title: "Team\u0000A" }),
      period,
    )),
    "教务宝已结课排课的 team_title 无效（string-control）。",
  );
  assert.equal(
    thrownMessage(() => projectJiaowubaoCompletedScheduleRecord(
      sourceRecord({ team_title: "A".repeat(241) }),
      period,
    )),
    "教务宝已结课排课的 team_title 无效（string-overlong）。",
  );
  assert.throws(
    () => readJiaowubaoCompletedScheduleSnapshotRecord({ ...record, teamTitle: " " }),
    /teamTitle 无效/,
  );
});

test("completed schedule collector pins over=1 and only stops after an explicit empty page", async () => {
  const requests = [];
  const snapshot = await collectJiaowubaoCompletedScheduleSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async (query) => {
      requests.push(query);
      return {
        lists: query.page === 1
          ? [sourceRecord({ cal_id: 7001 })]
          : query.page === 2
            ? [sourceRecord({ cal_id: 7002 })]
            : [],
      };
    },
  );
  assert.deepEqual(requests.map((query) => [query.page, query.over, query.order, query.limit]), [
    [1, 1, "asc", 100],
    [2, 1, "asc", 100],
    [3, 1, "asc", 100],
  ]);
  assert.equal(allJiaowubaoCompletedScheduleRecords(snapshot).length, 2);
  assert.doesNotThrow(() => assertJiaowubaoCompletedScheduleSnapshotIntegrity(snapshot));
});

test("completed schedule accepts 60 full data pages only after an empty page 61 probe", async () => {
  const requestedPages = [];
  const snapshot = await collectJiaowubaoCompletedScheduleSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => {
      requestedPages.push(page);
      return {
        lists: page <= 60
          ? Array.from({ length: 100 }, (_, index) => sourceRecord({
              cal_id: page * 1_000 + index,
            }))
          : [],
      };
    },
  );
  assert.equal(snapshot.manifest.pageCount, 60);
  assert.equal(snapshot.manifest.recordCount, 6_000);
  assert.equal(requestedPages.at(-1), 61);
});

test("completed schedule rejects a nonempty page 61 probe", async () => {
  await assert.rejects(
    collectJiaowubaoCompletedScheduleSnapshot(
      { start: "2026-08-01", end: "2026-08-31" },
      async ({ page }) => ({ lists: [sourceRecord({ cal_id: page })] }),
    ),
    /超过最大页数/,
  );
});

test("schedule source manifest verification rejects modified role-hour evidence", async () => {
  const snapshot = await collectJiaowubaoCompletedScheduleSnapshot(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => ({ lists: page === 1 ? [sourceRecord()] : [] }),
  );
  const originalPage = snapshot.pages[0];
  const tampered = {
    ...snapshot,
    pages: [{
      ...originalPage,
      records: [{
        ...originalPage.records[0],
        teachers: [{ ...originalPage.records[0].teachers[0], hours: 2 }],
      }],
    }],
  };
  assert.throws(() => assertJiaowubaoCompletedScheduleSnapshotIntegrity(tampered), /散列不一致/);
});

test("completed schedule freezes a sorted, deduplicated member-ID set outside the published snapshot", async () => {
  const captured = await collectJiaowubaoCompletedScheduleSnapshotWithMemberIds(
    { start: "2026-08-01", end: "2026-08-31" },
    async ({ page }) => ({
      lists: page === 1
        ? [
            sourceRecord({ cal_id: 7001, stu_list: [{ mem_id: 203 }, { mem_id: "201" }] }),
            sourceRecord({ cal_id: 7002, stu_list: [{ mem_id: 202 }, { mem_id: 203 }] }),
          ]
        : [],
    }),
  );
  assert.deepEqual(captured.memberIds, [201, 202, 203]);
  assert.match(captured.memberSetSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal("memberIds" in captured.snapshot, false);
  assert.equal(JSON.stringify(captured.snapshot).includes("stu_list"), false);
});

test("completed schedule member capture rejects a missing or invalid stu_list", async () => {
  await assert.rejects(
    collectJiaowubaoCompletedScheduleSnapshotWithMemberIds(
      { start: "2026-08-01", end: "2026-08-31" },
      async ({ page }) => ({ lists: page === 1 ? [sourceRecord({ stu_list: undefined })] : [] }),
    ),
    /stu_list 无效/,
  );
  await assert.rejects(
    collectJiaowubaoCompletedScheduleSnapshotWithMemberIds(
      { start: "2026-08-01", end: "2026-08-31" },
      async ({ page }) => ({ lists: page === 1 ? [sourceRecord({ stu_list: [{ mem_id: 0 }] })] : [] }),
    ),
    /mem_id 无效/,
  );
});

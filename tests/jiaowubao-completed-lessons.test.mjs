import assert from "node:assert/strict";
import test from "node:test";

const {
  JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT,
  JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT,
  allJiaowubaoCompletedLessonRecords,
  assertJiaowubaoCompletedLessonSnapshotIntegrity,
  buildJiaowubaoCompletedLessonSnapshot,
  buildJiaowubaoCompletedLessonSnapshotEnvelope,
  collectJiaowubaoCompletedLessonMemberPage,
  collectJiaowubaoCompletedLessonSnapshot,
  projectJiaowubaoCompletedLessonRecord,
  readJiaowubaoCompletedLessonSnapshotRecord,
  validateJiaowubaoClosedCompletedLessonMonth,
  validateJiaowubaoCompletedLessonMonth,
} = await import("../lib/jiaowubao-completed-lessons.ts");
const { JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID } = await import("../lib/jiaowubao-completed-lesson-branch.ts");
const {
  buildJiaowubaoCompletedMonthEvidenceEnvelope,
  buildJiaowubaoCompletedMonthEvidenceSnapshot,
} = await import("../lib/jiaowubao-completed-month-evidence.ts");
const { collectJiaowubaoCompletedScheduleSnapshot } = await import("../lib/jiaowubao-completed-schedule.ts");

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

function thrownMessage(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("expected action to throw");
}

function collectionProof() {
  return {
    format: JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT,
    memberSetSha256: `sha256:${"1".repeat(64)}`,
    memberCount: 2,
    catalogRevisionSha256: `sha256:${"2".repeat(64)}`,
    catalogMemberCount: 2,
    scheduleRevision: `sha256:${"3".repeat(64)}`,
    scheduleMemberSetSha256: `sha256:${"4".repeat(64)}`,
    scheduleMemberCount: 2,
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
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ cal_id: null }), window), /cal_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_id: null }), window), /mem_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: "branch:one" }), window), /branch_id/);
});

test("historical missing branch shapes use one reserved marker without weakening calendar or member IDs", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  for (const branchId of [undefined, null, "", " \t ", 0, "0", "000"]) {
    const record = projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: branchId }), window);
    assert.equal(record.branchId, JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID);
    assert.equal(
      record.sourceKey,
      `jwb-open-api:lesson:${JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID}:7001:201`,
    );
    assert.doesNotThrow(() => assertJiaowubaoCompletedLessonSnapshotIntegrity(buildJiaowubaoCompletedLessonSnapshot(
      window,
      [record],
      collectionProof(),
    )));
  }
  assert.throws(
    () => projectJiaowubaoCompletedLessonRecord(
      sourceRecord({ branch_id: JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID }),
      window,
    ),
    /string-reserved/,
  );
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ cal_id: 0 }), window), /cal_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_id: 0 }), window), /mem_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: "0".repeat(161) }), window), /branch_id/);
  assert.throws(() => projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: " ".repeat(161) }), window), /branch_id/);
});

test("invalid source components expose only a fixed structural category", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  const privateMarker = "must-not-reach-the-log";
  const cases = [
    ["branch:one", "string-delimiter"],
    ["A".repeat(161), "string-overlong"],
    ["branch\u0000one", "string-control"],
    [1.5, "number-noninteger"],
    [-1, "number-negative"],
    [false, "boolean-false"],
    [[], "array-empty"],
    [[privateMarker], "array-nonempty"],
    [{}, "object-empty"],
    [{ [privateMarker]: privateMarker }, "object-nonempty"],
  ];
  for (const [branchId, kind] of cases) {
    const message = thrownMessage(
      () => projectJiaowubaoCompletedLessonRecord(sourceRecord({ branch_id: branchId }), window),
    );
    assert.equal(message, `教务宝已消课记录的 branch_id 无效（${kind}）。`);
    assert.equal(message.includes(privateMarker), false);
  }
});

test("legacy unusable member titles keep ID-backed evidence as review-only null names", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  const unusable = [
    undefined,
    null,
    "",
    " \t\r\n ",
    0,
    false,
    [],
    {},
    "A".repeat(241),
    "Student\u0000Name",
    "Student\ud800Name",
  ];
  for (const memTitle of unusable) {
    const record = projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_title: memTitle }), window);
    assert.equal(record.memberName, null);
    assert.equal(record.memberId, "201");
    assert.doesNotThrow(() => readJiaowubaoCompletedLessonSnapshotRecord(record));
  }

  const normalized = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ mem_title: "  Student\t\r\n Name  " }),
    window,
  );
  assert.equal(normalized.memberName, "Student Name");
  assert.throws(
    () => readJiaowubaoCompletedLessonSnapshotRecord({ ...normalized, memberName: " \t " }),
    /memberName 无效/,
  );
});

test("completed lessons normalize raw no-team sentinels while keeping snapshot DTOs strict", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  for (const teamTitle of [0, undefined, null, "", " ", "\t\r\n", "　"]) {
    const record = projectJiaowubaoCompletedLessonRecord(sourceRecord({ team_title: teamTitle }), window);
    assert.equal(record.teamTitle, null);
    assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(record), record);
  }

  const normalized = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ team_title: "  Team   A  " }),
    window,
  );
  assert.equal(normalized.teamTitle, "Team A");
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(normalized), normalized);
  const wrapped = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ team_title: " Team\t\r\n A " }),
    window,
  );
  assert.equal(wrapped.teamTitle, "Team A");
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(wrapped), wrapped);
  for (const legacyWhitespace of ["\t", "\n", "\v", "\f", "\r"]) {
    assert.equal(
      projectJiaowubaoCompletedLessonRecord(
        sourceRecord({ team_title: `Ｔｅａｍ${legacyWhitespace}Ａ` }),
        window,
      ).teamTitle,
      "Team A",
    );
  }
  const stringZero = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ team_title: "0" }),
    window,
  );
  assert.equal(stringZero.teamTitle, "0");
  assert.throws(
    () => readJiaowubaoCompletedLessonSnapshotRecord({ ...normalized, teamTitle: 0 }),
    /teamTitle 无效/,
  );
  assert.throws(
    () => readJiaowubaoCompletedLessonSnapshotRecord({ ...normalized, teamTitle: " " }),
    /teamTitle 无效/,
  );
});

test("invalid raw completed-lesson team-title diagnostics expose only a fixed structural category", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
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
      () => projectJiaowubaoCompletedLessonRecord(sourceRecord({ team_title: teamTitle }), window),
    );
    assert.equal(message, `教务宝已消课记录的 team_title 无效（${kind}）。`);
    assert.equal(message.includes(privateMarker), false);
  }
  for (const control of ["\u0000", "\u0008", "\u000e", "\u007f"]) {
    assert.equal(
      thrownMessage(() => projectJiaowubaoCompletedLessonRecord(
        sourceRecord({ team_title: `Team${control}A` }),
        window,
      )),
      "教务宝已消课记录的 team_title 无效（string-control-other）。",
    );
  }
  assert.equal(
    thrownMessage(() => projectJiaowubaoCompletedLessonRecord(
      sourceRecord({ team_title: "A".repeat(241) }),
      window,
    )),
    "教务宝已消课记录的 team_title 无效（string-overlong）。",
  );
});

test("completed lesson snapshot text remains compatible with historical consecutive spaces", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord(),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const invalid = [undefined, "", " ", " padded", "padded ", "ｅ", "tab\tvalue", "line\nvalue"];
  for (const value of invalid) {
    assert.throws(
      () => readJiaowubaoCompletedLessonSnapshotRecord({ ...record, teamTitle: value }),
      /teamTitle 无效/,
    );
  }
  const historical = { ...record, teamTitle: "Legacy  Team" };
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(historical), historical);
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord({ ...record, teamTitle: null }), {
    ...record,
    teamTitle: null,
  });
});

test("completed lesson generic text preserves consecutive spaces and round-trips", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({
      time_title: "Evening  Session",
      sign_title: "Arrived  Late",
      course_title: "English  Trial",
      teacher_title: "Crystal  Wong",
      over_time: "2026-08-05  20:01:00",
    }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  assert.equal(record.timeTitle, "Evening  Session");
  assert.equal(record.attendanceTitle, "Arrived  Late");
  assert.equal(record.courseTitle, "English  Trial");
  assert.equal(record.teachers[0]?.name, "Crystal  Wong");
  assert.equal(record.completedAt, "2026-08-05  20:01:00");
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(record), record);
  const compatibilityFold = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ course_title: "\u00a8Course" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  assert.equal(compatibilityFold.courseTitle, "\u0308Course");
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(compatibilityFold), compatibilityFold);
  const historical = {
    ...record,
    memberName: "Legacy  Student",
    teamTitle: "Legacy  Team",
    courseTitle: " \u0308Course",
  };
  assert.deepEqual(readJiaowubaoCompletedLessonSnapshotRecord(historical), historical);
  assert.throws(
    () => readJiaowubaoCompletedLessonSnapshotRecord({ ...record, courseTitle: " \u20ddCourse" }),
    /courseTitle 无效/,
  );
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
  await assert.rejects(
    collectJiaowubaoCompletedLessonMemberPage(
      { start: "2026-08-01", end: "2026-08-31" },
      201,
      1,
      null,
      async () => ({
        total: 2,
        list: [sourceRecord({ branch_id: undefined }), sourceRecord({ branch_id: undefined })],
      }),
    ),
    /重复来源键/,
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

test("member-page collector pins mem_id and supplier total without probing an empty page", async () => {
  const requests = [];
  const pageOne = await collectJiaowubaoCompletedLessonMemberPage(
    { start: "2026-08-01", end: "2026-08-31" },
    201,
    1,
    null,
    async (query) => {
      requests.push(query);
      return {
        total: 101,
        list: Array.from({ length: 100 }, (_, index) => sourceRecord({ cal_id: 8_000 + index, mem_id: 201 })),
      };
    },
  );
  const pageTwo = await collectJiaowubaoCompletedLessonMemberPage(
    { start: "2026-08-01", end: "2026-08-31" },
    201,
    2,
    pageOne.total,
    async (query) => {
      requests.push(query);
      return { total: 101, list: [sourceRecord({ cal_id: 8_100, mem_id: 201 })] };
    },
  );
  assert.equal(pageOne.complete, false);
  assert.equal(pageTwo.complete, true);
  assert.deepEqual(requests.map(({ mem_id, page, limit, sign }) => [mem_id, page, limit, sign]), [
    [201, 1, 100, -1],
    [201, 2, 100, -1],
  ]);
});

test("member-page collector fails closed when total changes or another member appears", async () => {
  await assert.rejects(
    collectJiaowubaoCompletedLessonMemberPage(
      { start: "2026-08-01", end: "2026-08-31" },
      201,
      1,
      2,
      async () => ({ total: 1, list: [sourceRecord()] }),
    ),
    /总数在分页期间发生变化/,
  );
  await assert.rejects(
    collectJiaowubaoCompletedLessonMemberPage(
      { start: "2026-08-01", end: "2026-08-31" },
      201,
      1,
      null,
      async () => ({ total: 1, list: [sourceRecord({ mem_id: 202 })] }),
    ),
    /其他学员资料/,
  );
});

test("completed lesson builder is deterministic across member crawl order", () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  const first = projectJiaowubaoCompletedLessonRecord(sourceRecord({ cal_id: 7001, mem_id: 201 }), window);
  const second = projectJiaowubaoCompletedLessonRecord(sourceRecord({ cal_id: 7002, mem_id: 202 }), window);
  const left = buildJiaowubaoCompletedLessonSnapshot(window, [second, first], collectionProof());
  const right = buildJiaowubaoCompletedLessonSnapshot(window, [first, second], collectionProof());
  assert.equal(left.manifest.revision, right.manifest.revision);
  assert.deepEqual(allJiaowubaoCompletedLessonRecords(left), [first, second]);
});

test("legacy unscoped fixtures cannot cross either production publication boundary", async () => {
  const window = { start: "2026-08-01", end: "2026-08-31" };
  const legacyLessons = await collectJiaowubaoCompletedLessonSnapshot(
    window,
    async ({ page }) => ({ list: page === 1 ? [sourceRecord()] : [] }),
  );
  const schedules = await collectJiaowubaoCompletedScheduleSnapshot(
    window,
    async ({ page }) => ({
      lists: page === 1
        ? [{
            cal_id: 7001,
            dated: "2026-08-05",
            time_start: 1900,
            time_end: 2000,
            course_id: 11,
            course_title: "Synthetic English",
            team_id: 22,
            team_title: "Synthetic class",
            teacher_id: 90,
            teacher_title: "Synthetic Teacher",
            teacher_hour: 1,
            teacher_s: 0,
            teacher_s_title: "",
            teacher_s_hour: 0,
            teacher_t: 0,
            teacher_t_title: "",
            teacher_t_hour: 0,
            over: 1,
            over_time: "2026-08-05 20:01:00",
            stu_list: [{ mem_id: 201 }],
          }]
        : [],
    }),
  );
  const composite = buildJiaowubaoCompletedMonthEvidenceSnapshot(legacyLessons, schedules);
  assert.throws(() => buildJiaowubaoCompletedLessonSnapshotEnvelope(legacyLessons, null), /逐学员完整性证明/);
  assert.throws(() => buildJiaowubaoCompletedMonthEvidenceEnvelope(composite, null), /逐学员完整性证明/);
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

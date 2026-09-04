import assert from "node:assert/strict";
import test from "node:test";

const { projectJiaowubaoCompletedLessonRecord } = await import("../lib/jiaowubao-completed-lessons.ts");
const { projectJiaowubaoCompletedLessonRecords } = await import("../lib/jiaowubao-completed-lesson-projection.ts");
const { projectJiaowubaoCompletedScheduleRecord } = await import("../lib/jiaowubao-completed-schedule.ts");

function sourceRecord(overrides = {}) {
  return {
    branch_id: 1,
    cal_id: 900,
    mem_id: 701,
    mem_title: "试听学生A",
    dated: "2026-08-07",
    hours: 1,
    type: 3,
    sign: 1,
    course_title: "English - Fiona周雨霏 试听",
    teacher_id: 80,
    teacher_title: "Crystal Wong",
    over: 1,
    ...overrides,
  };
}

function stateRows() {
  return [
    {
      entity: "students",
      version: 1,
      updated_at: "2026-08-01T00:00:00.000Z",
      updated_by: "test",
      payload: [
        { id: "stu-fiona", name: "Fiona周雨霏" },
        { id: "stu-phyllis", name: "Phyllis嘟嘟" },
        { id: "stu-eric", name: "Eric Hong" },
        // A shared trial account must not become a durable identity proof.
        { id: "stu-wrong", name: "Not Fiona", jwbSourceRow: 701 },
        { id: "stu-rita", name: "Rita Wu", jwbSourceRow: 702 },
      ],
    },
    {
      entity: "teachers",
      version: 1,
      updated_at: "2026-08-01T00:00:00.000Z",
      updated_by: "test",
      payload: [{ id: "teacher-crystal", name: "Crystal Wong" }],
    },
  ];
}

function scheduleSourceRecord(overrides = {}) {
  return {
    cal_id: 900,
    dated: "2026-08-07",
    course_title: "English - Fiona周雨霏 试听",
    teacher_id: 80,
    teacher_title: "Crystal Wong",
    teacher_hour: 1,
    over: 1,
    ...overrides,
  };
}

test("shared A/B/C account resolves only from a narrow course-title name, never its member id", () => {
  const trial = projectJiaowubaoCompletedLessonRecord(sourceRecord(), { start: "2026-08-01", end: "2026-08-31" });
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: stateRows() });
  assert.equal(projection.items[0].studentId, "stu-fiona");
  assert.equal(projection.items[0].studentMatch, "trial_course_title");
  assert.equal(projection.items[0].teachers[0]?.teacherId, "teacher-crystal");
  assert.equal(projection.items[0].teachers[0]?.teacherMatch, "unique_name");
});

test("shared A/B/C label never becomes member-ID identity even when the supplier type is not trial", () => {
  for (const lessonType of [undefined, 1]) {
    const record = projectJiaowubaoCompletedLessonRecord(
      sourceRecord({ type: lessonType }),
      { start: "2026-08-01", end: "2026-08-31" },
    );
    const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], stateRows: stateRows() });
    assert.equal(record.isTrial, false);
    assert.equal(projection.items[0].studentId, "stu-fiona");
    assert.equal(projection.items[0].studentMatch, "trial_course_title");
    assert.notEqual(projection.items[0].studentId, "stu-wrong");
  }
});

test("shared A/B/C account can match a uniquely known name before a course suffix", () => {
  const trial = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ course_title: "Phyllis嘟嘟 - AES 试听" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: stateRows() });
  assert.equal(projection.items[0].studentId, "stu-phyllis");
  assert.equal(projection.items[0].studentMatch, "trial_course_title");
});

test("shared A/B/C account can match a uniquely known name without a title delimiter", () => {
  const trial = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ course_title: "Phyllis嘟嘟 AES 试听" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: stateRows() });
  assert.equal(projection.items[0].studentId, "stu-phyllis");
  assert.equal(projection.items[0].studentMatch, "trial_course_title");
});

test("shared A/B/C account treats whitespace or punctuation as a boundary before an English subject", () => {
  for (const courseTitle of ["Eric Hong AES 试听", "Eric Hong - AES 试听"]) {
    const trial = projectJiaowubaoCompletedLessonRecord(
      sourceRecord({ course_title: courseTitle }),
      { start: "2026-08-01", end: "2026-08-31" },
    );
    const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: stateRows() });
    assert.equal(projection.items[0].studentId, "stu-eric", courseTitle);
    assert.equal(projection.items[0].displayStudentName, "Eric Hong", courseTitle);
  }
});

test("shared A/B/C source title retains a parsed display name without inventing an internal identity", () => {
  const trial = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ course_title: "Course information - New Trial Student试听" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: stateRows() });
  assert.equal(projection.items[0].studentId, null);
  assert.equal(projection.items[0].studentMatch, "unmatched");
  assert.equal(projection.items[0].displayStudentName, "New Trial Student");
});

test("a missing trial account title never turns its shared member ID into student identity", () => {
  const trial = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ mem_title: null }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: stateRows() });
  assert.equal(projection.items[0].studentId, "stu-fiona");
  assert.equal(projection.items[0].studentMatch, "trial_course_title");
  assert.notEqual(projection.items[0].studentId, "stu-wrong");

  const unmatched = projectJiaowubaoCompletedLessonRecords({
    records: [projectJiaowubaoCompletedLessonRecord(
      sourceRecord({ mem_title: null, course_title: null }),
      { start: "2026-08-01", end: "2026-08-31" },
    )],
    scheduleRecords: [projectJiaowubaoCompletedScheduleRecord(
      scheduleSourceRecord({ course_title: null }),
      { start: "2026-08-01", end: "2026-08-31" },
    )],
    stateRows: stateRows(),
  });
  assert.equal(unmatched.items[0].studentId, null);
  assert.equal(unmatched.items[0].studentMatch, "unmatched");
  assert.equal(unmatched.items[0].displayStudentName, null);
  const summary = unmatched.teachers[0];
  assert.equal(summary?.sourceHours, 1, "the reconciled source hours remain visible for review");
  assert.equal(summary?.trialSourceHours, 1);
  assert.equal(summary?.unresolvedLessonCount, 0);
  assert.equal(summary?.unresolvedTrialLessonCount, 0);
  assert.equal(summary?.missingStudentDisplayNameCount, 1);
  assert.equal(
    unmatched.teachers.some((teacher) => (
      teacher.teacherId
      && teacher.sourceHours !== null
      && teacher.trialSourceHours !== null
      && teacher.unresolvedLessonCount === 0
      && teacher.unresolvedTrialLessonCount === 0
      && teacher.missingStudentDisplayNameCount === 0
    )),
    false,
    "a missing learner name alone keeps the otherwise reconciled teacher review-only",
  );
});

test("archived students remain available to a historical completed-month identity lookup", () => {
  const rows = stateRows();
  rows[0].payload.push({ id: "stu-former", name: "Former Learner", importArchived: true });
  const trial = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ course_title: "Course information - Former Learner试听" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [trial], stateRows: rows });
  assert.equal(projection.items[0].studentId, "stu-former");
  assert.equal(projection.items[0].displayStudentName, "Former Learner");
});

test("durable historical JWB member IDs remain valid identity evidence", () => {
  const rows = stateRows();
  rows[0].payload.push({
    id: "stu-historical",
    name: "Historical Learner",
    importArchived: true,
    historicalJwbSnapshot: { retained: { jwbSourceRow: 704 } },
  });
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ mem_id: 704, mem_title: "Historical Learner", type: 1, course_title: "Historical English" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], stateRows: rows });
  assert.equal(projection.items[0].studentId, "stu-historical");
  assert.equal(projection.items[0].studentMatch, "source_id");
});

test("schedule role credits count once while group student evidence stays itemized", () => {
  const records = [
    projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_id: 701, hours: 1 }), { start: "2026-08-01", end: "2026-08-31" }),
    projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_id: 702, mem_title: "试听学员 B 账号", hours: 4 }), { start: "2026-08-01", end: "2026-08-31" }),
    projectJiaowubaoCompletedLessonRecord(sourceRecord({ cal_id: 901, mem_id: 703, mem_title: "Fiona周雨霏", hours: 2, type: 1, course_title: "Y9 ICAS" }), { start: "2026-08-01", end: "2026-08-31" }),
  ];
  const scheduleRecords = [
    projectJiaowubaoCompletedScheduleRecord(scheduleSourceRecord({ cal_id: 900, teacher_hour: 1 }), { start: "2026-08-01", end: "2026-08-31" }),
    projectJiaowubaoCompletedScheduleRecord(scheduleSourceRecord({ cal_id: 901, course_title: "Y9 ICAS", teacher_hour: 2 }), { start: "2026-08-01", end: "2026-08-31" }),
  ];
  const projection = projectJiaowubaoCompletedLessonRecords({ records, scheduleRecords, stateRows: stateRows() });
  assert.equal(projection.items.length, 3);
  assert.deepEqual(projection.teachers, [{
    identityKey: "internal:teacher-crystal",
    sourceTeacherId: "80",
    sourceTeacherName: "Crystal Wong",
    teacherId: "teacher-crystal",
    teacherName: "Crystal Wong",
    teacherMatch: "unique_name",
    sourceHours: 3,
    trialSourceHours: 1,
    sourceLessonCount: 2,
    unresolvedLessonCount: 0,
    unresolvedTrialLessonCount: 0,
    studentLineCount: 3,
    missingStudentDisplayNameCount: 0,
  }]);
  // Student consumption is 1 + 4 + 2, but teacher credit stays at the two
  // documented schedule role values (1 + 2), never the student sum.
  assert.equal(projection.items.reduce((total, item) => total + item.hours, 0), 7);
});

test("missing or ambiguous schedule evidence is review-only rather than a guessed teacher total", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ mem_id: 702, mem_title: "Rita Wu", type: 1, course_title: "Y9 ICAS" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], scheduleRecords: [], stateRows: stateRows() });
  assert.equal(projection.teachers[0]?.sourceHours, null);
  assert.equal(projection.teachers[0]?.trialSourceHours, null);
  assert.ok((projection.teachers[0]?.unresolvedLessonCount ?? 0) > 0);
});

test("a historical lesson with no branch stays review-only even when its schedule otherwise matches", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ branch_id: undefined, mem_id: 702, mem_title: "Rita Wu", type: 1, course_title: "Y9 ICAS" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const schedule = projectJiaowubaoCompletedScheduleRecord(
    scheduleSourceRecord({ course_title: "Y9 ICAS", teacher_hour: 1 }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], scheduleRecords: [schedule], stateRows: stateRows() });
  const teacher = projection.teachers.find((candidate) => candidate.sourceTeacherId === "80");
  assert.equal(teacher?.sourceHours, null);
  assert.equal(teacher?.trialSourceHours, null);
  assert.ok((teacher?.unresolvedLessonCount ?? 0) > 0);
  assert.ok((teacher?.unresolvedTrialLessonCount ?? 0) > 0);
  assert.equal(teacher?.studentLineCount, 1, "the learner evidence remains visible for review");
});

test("an unknown-branch learner with no teacher identity cannot make a separate schedule source fact payable", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({
      branch_id: undefined,
      mem_id: 702,
      mem_title: "Rita Wu",
      type: 1,
      course_title: "Y9 ICAS",
      teacher_id: 0,
      teacher_title: null,
    }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const schedule = projectJiaowubaoCompletedScheduleRecord(
    scheduleSourceRecord({ course_title: "Y9 ICAS", teacher_hour: 1 }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], scheduleRecords: [schedule], stateRows: stateRows() });
  const scheduleTeacher = projection.teachers.find((candidate) => candidate.sourceTeacherId === "80");
  assert.equal(scheduleTeacher?.sourceHours, 1, "the schedule role-hour remains visible only as a source fact");
  assert.ok((scheduleTeacher?.unresolvedLessonCount ?? 0) > 0);
  assert.equal(
    projection.teachers.some((teacher) => (
      teacher.teacherId
      && teacher.sourceHours !== null
      && teacher.trialSourceHours !== null
      && teacher.unresolvedLessonCount === 0
      && teacher.unresolvedTrialLessonCount === 0
      && teacher.missingStudentDisplayNameCount === 0
    )),
    false,
    "no teacher summary satisfies the payroll-release gate",
  );
});

test("an extra schedule role is a source conflict, never an unearned teacher credit", () => {
  const record = projectJiaowubaoCompletedLessonRecord(
    sourceRecord({ mem_id: 702, mem_title: "Rita Wu", type: 1, course_title: "Y9 ICAS" }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const schedule = projectJiaowubaoCompletedScheduleRecord(
    scheduleSourceRecord({
      course_title: "Y9 ICAS",
      teacher_s: 81,
      teacher_s_title: "Assistant Teacher",
      teacher_s_hour: 1,
    }),
    { start: "2026-08-01", end: "2026-08-31" },
  );
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], scheduleRecords: [schedule], stateRows: stateRows() });
  const primary = projection.teachers.find((teacher) => teacher.sourceTeacherId === "80");
  assert.equal(primary?.sourceHours, null);
  assert.ok((primary?.unresolvedLessonCount ?? 0) > 0);
  assert.ok(projection.teachers.some((teacher) => teacher.sourceTeacherId === "81" && (teacher.unresolvedLessonCount ?? 0) > 0));
});

test("conflicting exact source-id and name proofs stay unresolved", () => {
  const record = projectJiaowubaoCompletedLessonRecord(sourceRecord({ mem_id: 702, mem_title: "Fiona周雨霏", type: 1 }), { start: "2026-08-01", end: "2026-08-31" });
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [record], stateRows: stateRows() });
  assert.equal(projection.items[0].studentId, null);
  assert.equal(projection.items[0].studentMatch, "ambiguous");
});

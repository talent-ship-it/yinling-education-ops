import assert from "node:assert/strict";
import test from "node:test";

import {
  completeJiaowubaoCompletedMonthEvidencePages,
  jiaowubaoCompletedMonthEvidenceMatchesExportVersion,
  jiaowubaoCompletedMonthEvidenceReadyForPayrollLock,
  parseJiaowubaoCompletedMonthEvidencePage,
} from "../app/jiaowubao-completed-month-evidence";

const revision = `sha256:${"a".repeat(64)}`;
const projectionRevision = `sha256:${"b".repeat(64)}`;
const publishedAt = "2026-08-31T14:00:00.000Z";

function lessonFeed() {
  return {
    state: "complete",
    source: "lessons",
    month: "2026-08",
    revision,
    rowCount: 1,
    pageIndex: 0,
    pageCount: 1,
    publishedAt,
    projectionRevision,
    items: [{
      sourceKey: "jwb-open-api:lesson:branch-1:cal-1:member-1",
      branchId: "branch-1",
      calendarId: "cal-1",
      memberId: "member-1",
      memberName: "试听学员 A",
      lessonDate: "2026-08-05",
      timeTitle: "19:00-20:00",
      hours: 1,
      isTrial: true,
      attendanceCode: -1,
      attendanceTitle: "已到达",
      courseTitle: "Zachary 张泽富 (WA)",
      teamTitle: null,
      studentId: "stu-1",
      studentName: "Zachary 张泽富",
      displayStudentName: "Zachary 张泽富",
      studentMatch: "trial_course_title",
      teachers: [{
        role: "primary",
        sourceTeacherId: "teacher-1",
        sourceTeacherName: "Crystal Wong",
        teacherId: "tea-1",
        teacherName: "Crystal Wong",
        teacherMatch: "source_id",
      }],
    }],
  };
}

function scheduleFeed() {
  return {
    state: "complete",
    source: "schedules",
    month: "2026-08",
    revision,
    rowCount: 1,
    pageIndex: 0,
    pageCount: 1,
    publishedAt,
    projectionRevision,
    items: [{
      sourceKey: "jwb-open-api:schedule:cal-1",
      calendarId: "cal-1",
      lessonDate: "2026-08-05",
      timeTitle: "19:00-20:00",
      courseTitle: "Zachary 张泽富 (WA)",
      teamTitle: null,
      teachers: [{
        role: "primary",
        sourceTeacherId: "teacher-1",
        sourceTeacherName: "Crystal Wong",
        sourceTeacherHours: 1,
        teacherId: "tea-1",
        teacherName: "Crystal Wong",
        teacherMatch: "source_id",
      }],
    }],
  };
}

function completeEvidence() {
  return completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [parseJiaowubaoCompletedMonthEvidencePage(lessonFeed())],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(scheduleFeed())],
  });
}

test("parses revision-pinned participant and schedule pages before completing a month", () => {
  const parsed = completeEvidence();
  assert.equal(parsed.state, "complete");
  assert.equal(parsed.items[0]?.studentName, "Zachary 张泽富");
  assert.equal(parsed.items[0]?.displayStudentName, "Zachary 张泽富");
  assert.equal(parsed.teachers[0]?.sourceHours, 1);
  assert.equal(parsed.publishedAt, publishedAt);
  assert.equal(parsed.projectionRevision, projectionRevision);
});

test("uses source + mapping revisions as identity, not an informational publication timestamp", () => {
  const laterSchedulePublication = scheduleFeed();
  laterSchedulePublication.publishedAt = "2026-08-31T14:05:00.000Z";
  const completed = completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [parseJiaowubaoCompletedMonthEvidencePage(lessonFeed())],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(laterSchedulePublication)],
  });
  assert.equal(completed.state, "complete");
  assert.equal(completed.publishedAt, publishedAt);

  const changedMapping = scheduleFeed();
  changedMapping.projectionRevision = `sha256:${"c".repeat(64)}`;
  assert.throws(() => completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [parseJiaowubaoCompletedMonthEvidencePage(lessonFeed())],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(changedMapping)],
  }), /来源版本不一致/);
});

test("payroll locking fails closed while a dual-source month is loading, stale, or unresolved", () => {
  const complete = completeEvidence();
  assert.equal(jiaowubaoCompletedMonthEvidenceReadyForPayrollLock({
    feed: complete, month: "2026-08", loading: false, error: false, syncing: false,
  }), true);
  for (const input of [
    { feed: complete, month: "2026-08", loading: true, error: false, syncing: false },
    { feed: complete, month: "2026-08", loading: false, error: true, syncing: false },
    { feed: complete, month: "2026-08", loading: false, error: false, syncing: true },
    { feed: complete, month: "2026-09", loading: false, error: false, syncing: false },
    { feed: null, month: "2026-08", loading: false, error: false, syncing: false },
  ]) {
    assert.equal(jiaowubaoCompletedMonthEvidenceReadyForPayrollLock(input), false);
  }
});

test("export freshness pins month, source revision, mapping revision and both source row counts", () => {
  const current = completeEvidence();
  assert.equal(jiaowubaoCompletedMonthEvidenceMatchesExportVersion({
    current,
    fresh: { ...current, publishedAt: "2026-08-31T14:05:00.000Z" },
    month: "2026-08",
  }), true, "publication time is informational rather than snapshot identity");

  for (const fresh of [
    null,
    { ...current, state: "absent" as const },
    { ...current, month: "2026-07" },
    { ...current, revision: null },
    { ...current, projectionRevision: null },
    { ...current, revision: `sha256:${"c".repeat(64)}` },
    { ...current, projectionRevision: `sha256:${"d".repeat(64)}` },
    { ...current, rowCount: current.rowCount + 1 },
    { ...current, scheduleRowCount: current.scheduleRowCount + 1 },
  ]) {
    assert.equal(jiaowubaoCompletedMonthEvidenceMatchesExportVersion({
      current,
      fresh,
      month: "2026-08",
    }), false);
  }
  assert.equal(jiaowubaoCompletedMonthEvidenceMatchesExportVersion({
    current,
    fresh: current,
    month: "2026-07",
  }), false);
  assert.equal(jiaowubaoCompletedMonthEvidenceMatchesExportVersion({
    current: { ...current, revision: null, projectionRevision: null },
    fresh: { ...current, revision: null, projectionRevision: null },
    month: "2026-08",
  }), false);
});

test("rejects raw supplier fields, mismatched keys, and incomplete page sizes", () => {
  const withRaw = lessonFeed() as Record<string, unknown>;
  withRaw.raw = { secret: "not allowed" };
  assert.throws(() => parseJiaowubaoCompletedMonthEvidencePage(withRaw), /禁止字段/);

  const mismatchedKey = lessonFeed();
  mismatchedKey.items[0]!.sourceKey = "jwb-open-api:lesson:branch-1:cal-1:other-member";
  assert.throws(() => parseJiaowubaoCompletedMonthEvidencePage(mismatchedKey), /sourceKey/);

  const mismatchedCount = lessonFeed();
  mismatchedCount.rowCount = 2;
  assert.throws(() => parseJiaowubaoCompletedMonthEvidencePage(mismatchedCount), /行数/);
});

test("accepts an explicitly empty, unpublished monthly snapshot only", () => {
  const absentPage = {
    state: "absent",
    month: "2026-09",
    revision: null,
    rowCount: 0,
    pageIndex: 0,
    pageCount: 0,
    publishedAt: null,
    projectionRevision: null,
    items: [],
  };
  const absent = completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [parseJiaowubaoCompletedMonthEvidencePage({ ...absentPage, source: "lessons" })],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage({ ...absentPage, source: "schedules" })],
  });
  assert.equal(absent.state, "absent");
  assert.equal(absent.rowCount, 0);
});

test("allows the documented maximum component IDs without truncating a source key", () => {
  const feed = lessonFeed();
  const branchId = `b${"a".repeat(159)}`;
  const calendarId = `c${"a".repeat(159)}`;
  const memberId = `m${"a".repeat(159)}`;
  const item = feed.items[0]!;
  item.branchId = branchId;
  item.calendarId = calendarId;
  item.memberId = memberId;
  item.sourceKey = `jwb-open-api:lesson:${branchId}:${calendarId}:${memberId}`;

  const parsed = parseJiaowubaoCompletedMonthEvidencePage(feed);
  assert.equal(parsed.items[0]?.sourceKey.length, item.sourceKey.length);
  assert.ok(item.sourceKey.length > 240);
});

test("rejects source-key components that could collide with its delimiters", () => {
  const feed = lessonFeed();
  const item = feed.items[0]!;
  item.branchId = "branch:one";
  item.sourceKey = `jwb-open-api:lesson:${item.branchId}:${item.calendarId}:${item.memberId}`;
  assert.throws(() => parseJiaowubaoCompletedMonthEvidencePage(feed), /sourceKey|branchId/);
});

test("accepts only the reserved unknown-branch marker and keeps it review-only", () => {
  const feed = lessonFeed();
  const item = feed.items[0]!;
  item.branchId = "~";
  item.sourceKey = `jwb-open-api:lesson:~:${item.calendarId}:${item.memberId}`;
  const schedule = scheduleFeed();

  const completed = completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [parseJiaowubaoCompletedMonthEvidencePage(feed)],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(schedule)],
  });
  assert.equal(completed.items[0]?.branchId, "~");
  assert.equal(completed.teachers[0]?.sourceHours, null);
  assert.ok((completed.teachers[0]?.unresolvedLessonCount ?? 0) > 0);

  for (const invalid of ["~~", "unknown~branch", "0", "000"]) {
    const malformed = lessonFeed();
    malformed.items[0]!.branchId = invalid;
    malformed.items[0]!.sourceKey = `jwb-open-api:lesson:${invalid}:cal-1:member-1`;
    assert.throws(() => parseJiaowubaoCompletedMonthEvidencePage(malformed), /sourceKey|branchId/);
  }
});

test("only releases teacher credits after both complete source feeds are present", () => {
  const first = lessonFeed();
  first.rowCount = 2;
  first.pageCount = 1;
  first.items.push({
    ...first.items[0]!,
    sourceKey: "jwb-open-api:lesson:branch-1:cal-1:member-2",
    memberId: "member-2",
    memberName: "Rita Wu",
    studentId: "stu-2",
    studentName: "Rita Wu",
    displayStudentName: "Rita Wu",
    studentMatch: "unique_name",
  });
  first.items[0]!.hours = 4;
  const schedule = scheduleFeed();
  const page = parseJiaowubaoCompletedMonthEvidencePage(first);
  const schedulePage = parseJiaowubaoCompletedMonthEvidencePage(schedule);
  const feed = completeJiaowubaoCompletedMonthEvidencePages({ lessonPages: [page], schedulePages: [schedulePage] });
  assert.equal(feed.rowCount, 2);
  assert.equal(feed.teachers.length, 1);
  assert.equal(feed.teachers[0]?.sourceHours, 1);
  assert.equal(feed.teachers[0]?.trialSourceHours, 1);
  assert.equal(feed.teachers[0]?.sourceLessonCount, 1);
  assert.equal(feed.teachers[0]?.studentLineCount, 2);
  assert.equal(feed.items.reduce((total, item) => total + item.hours, 0), 5);

  const incompleteFirst = lessonFeed();
  incompleteFirst.rowCount = 251;
  incompleteFirst.pageCount = 2;
  incompleteFirst.items = Array.from({ length: 250 }, (_, index) => ({
    ...incompleteFirst.items[0]!,
    sourceKey: `jwb-open-api:lesson:branch-1:cal-1:member-${index + 1}`,
    memberId: `member-${index + 1}`,
  }));
  const incompletePage = parseJiaowubaoCompletedMonthEvidencePage(incompleteFirst);
  assert.throws(() => completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [incompletePage],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(scheduleFeed())],
  }), /尚未读取完成/);

  const reset = parseJiaowubaoCompletedMonthEvidencePage({
    state: "reset",
    source: "lessons",
    month: "2026-08",
    revision,
    rowCount: 1,
    pageIndex: 1,
    pageCount: 1,
    publishedAt,
    projectionRevision: null,
    items: [],
  });
  assert.throws(() => completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [reset],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(scheduleFeed())],
  }), /已更新/);
});

test("canonicalizes valid pages by page index before handing evidence to Excel", () => {
  const first = lessonFeed();
  first.rowCount = 251;
  first.pageCount = 2;
  first.items = Array.from({ length: 250 }, (_, index) => ({
    ...first.items[0]!,
    sourceKey: `jwb-open-api:lesson:branch-1:cal-1:member-${index + 1}`,
    memberId: `member-${index + 1}`,
  }));
  const second = {
    ...first,
    pageIndex: 1,
    items: [{
      ...first.items[0]!,
      sourceKey: "jwb-open-api:lesson:branch-1:cal-1:member-251",
      memberId: "member-251",
    }],
  };
  const completed = completeJiaowubaoCompletedMonthEvidencePages({
    lessonPages: [
      parseJiaowubaoCompletedMonthEvidencePage(second),
      parseJiaowubaoCompletedMonthEvidencePage(first),
    ],
    schedulePages: [parseJiaowubaoCompletedMonthEvidencePage(scheduleFeed())],
  });
  assert.equal(completed.items[0]?.memberId, "member-1");
  assert.equal(completed.items.at(-1)?.memberId, "member-251");
});

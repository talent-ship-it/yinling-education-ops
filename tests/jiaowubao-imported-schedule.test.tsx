import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  JiaowubaoImportedSchedulePanel,
  completeJiaowubaoImportedSchedulePages,
  jiaowubaoImportedAvailabilityBlocksForTeacher,
  parseJiaowubaoImportedSchedulePage,
  type JiaowubaoImportedScheduleFeed,
  type JiaowubaoImportedSchedulePage,
} from "../app/jiaowubao-imported-schedule.tsx";

const opaqueCursor = `${"a".repeat(32)}.${"b".repeat(32)}`;

const feed: JiaowubaoImportedScheduleFeed = {
  state: "complete",
  events: [
    {
      eventId: "JWB-EVT-001-opaque",
      sourceDate: "2026-08-19",
      startsAt: "2026-08-19T02:00:00.000Z",
      endsAt: "2026-08-19T03:00:00.000Z",
      courseName: "高考中文",
      teacherId: "TEA-001",
      availabilityEffect: "blocks_teacher_ava",
      visibleStudentIds: ["STU-001"],
      visibleStudentsTruncated: false,
    },
  ],
  invalidTimeEventCount: 2,
  paginationComplete: true,
};

test("renders imported schedule events as a separate, clearly read-only source panel", () => {
  const html = renderToStaticMarkup(<JiaowubaoImportedSchedulePanel
    feed={feed}
    loading={false}
    error={false}
    timezone="Australia/Melbourne"
    language="zh-CN"
    studentNameForId={(studentId) => studentId === "STU-001" ? "王同学" : undefined}
    teacherNameForId={(teacherId) => teacherId === "TEA-001" ? "林老师" : undefined}
  />);

  assert.match(html, /<h2 id="jiaowubao-imported-schedule-title">同步课表<\/h2>/);
  assert.match(html, /jiaowubao-imported-schedule-readonly[\s\S]*只读/);
  assert.match(html, /aria-labelledby="jiaowubao-imported-schedule-title"/);
  assert.match(html, /高考中文/);
  assert.match(html, /王同学/);
  assert.match(html, /林老师/);
  assert.match(html, /占用老师 AVA/);
  assert.doesNotMatch(html, /源课表时间无法核验|未放入日历或 AVA/);
  assert.doesNotMatch(html, /JWB-EVT-001-opaque/);
  assert.doesNotMatch(html, /<button/);
});

test("labels authorised-list truncation and availability-only source time without inventing missing class details", () => {
  const html = renderToStaticMarkup(<JiaowubaoImportedSchedulePanel
    feed={{
      ...feed,
      events: [
        { ...feed.events[0]!, visibleStudentsTruncated: true },
        {
          eventId: "JWB-EVT-availability-only",
          sourceDate: "2026-08-20",
          startsAt: "2026-08-20T02:00:00.000Z",
          endsAt: "2026-08-20T03:00:00.000Z",
          courseName: null,
          teacherId: null,
          availabilityEffect: "blocks_teacher_ava",
          visibleStudentIds: [],
          visibleStudentsTruncated: false,
        },
      ],
    }}
    loading={false}
    error={false}
    timezone="Australia/Melbourne"
    language="zh-CN"
    studentNameForId={(studentId) => studentId === "STU-001" ? "王同学" : undefined}
    teacherNameForId={(teacherId) => teacherId === "TEA-001" ? "林老师" : undefined}
  />);

  assert.match(html, /仅显示前 100 位有权限查看的学员/);
  assert.match(html, /已占用时段/);
  assert.match(html, /老师 AVA 已占用/);
  assert.doesNotMatch(html, /课程待标注/);
  assert.doesNotMatch(html, /老师待匹配/);
});

test("keeps an absent import and a failed read distinguishable without offering actions", () => {
  const absent = renderToStaticMarkup(<JiaowubaoImportedSchedulePanel
    feed={{ state: "absent", events: [], invalidTimeEventCount: 0, paginationComplete: true }}
    loading={false}
    error={false}
    timezone="Australia/Melbourne"
    language="en-AU"
    studentNameForId={() => undefined}
    teacherNameForId={() => undefined}
  />);
  const failed = renderToStaticMarkup(<JiaowubaoImportedSchedulePanel
    feed={null}
    loading={false}
    error
    timezone="Australia/Melbourne"
    language="en-AU"
    studentNameForId={() => undefined}
    teacherNameForId={() => undefined}
  />);

  assert.match(absent, /No completed schedule is available yet/);
  assert.match(failed, /The synced schedule is temporarily unavailable/);
  assert.doesNotMatch(absent, /<button/);
  assert.doesNotMatch(failed, /<button/);
});

test("keeps session and reader failures distinct while stale schedules stay visually quiet", () => {
  const renderState = (error: boolean | "session" | "reader_unavailable" | "unavailable", state: JiaowubaoImportedScheduleFeed["state"] = "complete") => renderToStaticMarkup(
    <JiaowubaoImportedSchedulePanel
      feed={{ state, events: [], invalidTimeEventCount: 0, paginationComplete: true }}
      loading={false}
      error={error}
      timezone="Australia/Melbourne"
      language="en-AU"
      studentNameForId={() => undefined}
      teacherNameForId={() => undefined}
    />,
  );

  assert.match(renderState("session"), /session has expired/i);
  assert.match(renderState("reader_unavailable"), /reader is not available/i);
  assert.match(renderState("unavailable"), /schedule is temporarily unavailable/i);
  assert.match(renderState(false, "stale"), /No classes fall within this calendar window/i);
  assert.doesNotMatch(renderState(false, "stale"), /snapshot is stale/i);
  assert.match(renderState(false, "complete"), /No classes fall within this calendar window/i);
});

test("uses only matching AVA-blocking imported events as direct availability intervals", () => {
  const blocks = jiaowubaoImportedAvailabilityBlocksForTeacher({
    ...feed,
    events: [
      ...feed.events,
      {
        eventId: "JWB-EVT-display-only",
        sourceDate: "2026-08-19",
        startsAt: "2026-08-19T04:00:00.000Z",
        endsAt: "2026-08-19T05:00:00.000Z",
        courseName: "高考数学",
        teacherId: "TEA-001",
        availabilityEffect: "display_only",
        visibleStudentIds: [],
        visibleStudentsTruncated: false,
      },
      {
        eventId: "JWB-EVT-other-teacher",
        sourceDate: "2026-08-19",
        startsAt: "2026-08-19T06:00:00.000Z",
        endsAt: "2026-08-19T07:00:00.000Z",
        courseName: "高考英语",
        teacherId: "TEA-002",
        availabilityEffect: "blocks_teacher_ava",
        visibleStudentIds: [],
        visibleStudentsTruncated: false,
      },
    ],
  }, "TEA-001");

  assert.deepEqual(blocks, [{
    id: "JWB-EVT-001-opaque",
    startsAt: "2026-08-19T02:00:00.000Z",
    endsAt: "2026-08-19T03:00:00.000Z",
  }]);
  assert.deepEqual(jiaowubaoImportedAvailabilityBlocksForTeacher({ state: "absent", events: feed.events, invalidTimeEventCount: 0, paginationComplete: true }, "TEA-001"), []);
  assert.deepEqual(jiaowubaoImportedAvailabilityBlocksForTeacher(feed, undefined), []);
});

test("only produces an AVA-eligible feed after every opaque cursor page is present", () => {
  const firstPage: JiaowubaoImportedSchedulePage = {
    state: "complete",
    events: feed.events,
    invalidTimeEventCount: 2,
    hasMore: true,
    nextCursor: { token: "opaque-page-1" },
  };
  const secondPage: JiaowubaoImportedSchedulePage = {
    state: "complete",
    events: [{
      eventId: "JWB-EVT-002-opaque",
      sourceDate: "2026-08-20",
      startsAt: "2026-08-20T02:00:00.000Z",
      endsAt: "2026-08-20T03:00:00.000Z",
      courseName: "高考数学",
      teacherId: "TEA-001",
      availabilityEffect: "blocks_teacher_ava",
      visibleStudentIds: [],
      visibleStudentsTruncated: false,
    }],
    invalidTimeEventCount: 0,
    hasMore: false,
    nextCursor: null,
  };

  const completed = completeJiaowubaoImportedSchedulePages([firstPage, secondPage]);
  assert.equal(completed.paginationComplete, true);
  assert.equal(completed.invalidTimeEventCount, 2);
  assert.deepEqual(completed.events.map((event) => event.eventId), ["JWB-EVT-001-opaque", "JWB-EVT-002-opaque"]);
  assert.equal(jiaowubaoImportedAvailabilityBlocksForTeacher(completed, "TEA-001").length, 2);
  assert.equal("runToken" in completed, false);
  const staleCompleted = completeJiaowubaoImportedSchedulePages([
    { ...firstPage, state: "stale" },
    { ...secondPage, state: "stale" },
  ]);
  assert.equal(staleCompleted.state, "stale");
  assert.equal(staleCompleted.events.length, 2);
  assert.deepEqual(jiaowubaoImportedAvailabilityBlocksForTeacher(staleCompleted, "TEA-001"), []);
  assert.throws(() => completeJiaowubaoImportedSchedulePages([firstPage]), /尚未读取完成/);
  assert.throws(() => completeJiaowubaoImportedSchedulePages([{ ...firstPage, state: "reset", hasMore: false, nextCursor: null }]), /已重置/);
  assert.throws(() => completeJiaowubaoImportedSchedulePages([firstPage, { ...secondPage, invalidTimeEventCount: 1 }]), /异常时间计数不一致/);
  assert.throws(() => completeJiaowubaoImportedSchedulePages([
    firstPage,
    { ...secondPage, hasMore: true, nextCursor: { token: "opaque-page-1" } },
    secondPage,
  ]), /游标重复或无效/);
  assert.deepEqual(completeJiaowubaoImportedSchedulePages([{
    state: "complete",
    events: [],
    invalidTimeEventCount: 0,
    hasMore: false,
    nextCursor: null,
  }]), {
    state: "complete",
    events: [],
    invalidTimeEventCount: 0,
    paginationComplete: true,
  });
});

test("parses fresh/stale snapshot DTOs and rejects raw source or price fields", () => {
  const page = parseJiaowubaoImportedSchedulePage({
    state: "stale",
    freshness: "stale",
    empty: false,
    events: [{
      eventId: "59970259",
      sourceDate: "2026-08-22",
      startsAt: "2026-08-22T00:00:00.000Z",
      endsAt: "2026-08-22T01:00:00.000Z",
      courseName: "Year 9 Maths",
      teacherId: "TEA-001",
      teacherName: "Zara Baker",
      availabilityEffect: "blocks_teacher_ava",
      visibleStudentIds: ["STU-001"],
      visibleStudentsTruncated: false,
    }],
    invalidTimeEventCount: 0,
    hasMore: true,
    nextCursor: { token: opaqueCursor },
  });
  assert.equal(page.state, "stale");
  assert.equal(page.hasMore, true);
  assert.equal(page.events[0]?.teacherName, "Zara Baker");
  const freshPage = parseJiaowubaoImportedSchedulePage({ ...page, state: "complete", freshness: "fresh" });
  assert.equal(freshPage.state, "complete");
  assert.equal(freshPage.freshness, "fresh");
  assert.throws(() => parseJiaowubaoImportedSchedulePage({
    state: "complete",
    events: [{
      eventId: "59970259",
      sourceDate: "2026-08-22",
      startsAt: "2026-08-22T00:00:00.000Z",
      endsAt: "2026-08-22T01:00:00.000Z",
      courseName: "Year 9 Maths",
      teacherId: "TEA-001",
      availabilityEffect: "display_only",
      visibleStudentIds: [],
      visibleStudentsTruncated: false,
      price: 100,
    }],
    invalidTimeEventCount: 0,
    hasMore: false,
    nextCursor: null,
  }), /禁止字段/);
  assert.throws(() => parseJiaowubaoImportedSchedulePage({
    state: "complete",
    events: [{
      eventId: "59970259",
      sourceDate: "2026-08-22",
      startsAt: "2026-08-22T00:00:00.000Z",
      endsAt: "2026-08-22T01:00:00.000Z",
      courseName: null,
      teacherId: null,
      availabilityEffect: "display_only",
      visibleStudentIds: [],
      visibleStudentsTruncated: false,
      stu_list: [],
    }],
    invalidTimeEventCount: 0,
    hasMore: false,
    nextCursor: null,
  }), /禁止字段/);
  assert.throws(() => parseJiaowubaoImportedSchedulePage({
    state: "complete",
    events: [{
      eventId: "59970259",
      sourceDate: "2026-08-22",
      startsAt: "2026-08-22T00:00:00.000Z",
      endsAt: "2026-08-22T01:00:00.000Z",
      courseName: null,
      teacherId: null,
      availabilityEffect: "display_only",
      visibleStudentIds: [],
      visibleStudentsTruncated: false,
      sourceParticipants: [{ memberId: "JWB-MEM-1", label: "张三" }],
    }],
    invalidTimeEventCount: 0,
    hasMore: false,
    nextCursor: null,
  }), /禁止字段/);
});

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TeacherAvailabilityPanel,
  type TeacherAvailabilityPanelProps,
} from "../app/teacher-availability-panel.tsx";
import { createMonthlyAvailabilityWindows } from "../lib/teacher-availability.ts";

const noOperation = () => undefined;

function props(
  overrides: Partial<TeacherAvailabilityPanelProps> = {},
): TeacherAvailabilityPanelProps {
  return {
    teacherId: "teacher-a",
    teacherName: "Teacher A",
    legacySlots: [],
    windows: createMonthlyAvailabilityWindows({
      teacherId: "teacher-a",
      month: "2026-08",
      timezone: "Australia/Melbourne",
      slots: [{ day: 1, start: "09:00", end: "10:30" }],
      idSeed: "august",
    }),
    submissions: [],
    reviewingSubmissionId: null,
    reviewInboxBusy: false,
    reviewError: "",
    displayTimezone: "Australia/Melbourne",
    timezoneOptions: [
      { value: "Australia/Melbourne", label: "墨尔本" },
      { value: "Asia/Shanghai", label: "上海" },
    ],
    referenceDate: "2026-08-13",
    onDisplayTimezoneChange: noOperation,
    onEdit: noOperation,
    onDelete: noOperation,
    onPromoteLegacy: noOperation,
    onApproveSubmission: noOperation,
    onRejectSubmission: noOperation,
    onRefreshSubmissions: noOperation,
    ...overrides,
  };
}

test("renders month occurrences with month, week and timezone controls", () => {
  const html = renderToStaticMarkup(<TeacherAvailabilityPanel {...props()} />);

  assert.match(html, /Teacher A · 月度 AVA/);
  assert.match(html, />本月</);
  assert.match(html, />下月</);
  assert.match(html, /aria-label="显示范围"/);
  assert.match(html, /aria-label="显示时区"/);
  assert.match(html, />墨尔本</);
  assert.match(html, /9:00/);
  assert.match(html, /09:00–10:30/);
  assert.doesNotMatch(html, /<small[^>]*>[^<]*(?:说明|提示|用于)/);
});

test("states explicitly when the selected month has not been collected", () => {
  const html = renderToStaticMarkup(<TeacherAvailabilityPanel {...props({ windows: [] })} />);

  assert.match(html, /2026-08 未收集/);
  assert.doesNotMatch(html, /暂无可约时段/);
});

test("offers an explicit legacy promotion only for an uncollected month", () => {
  const emptyMonth = renderToStaticMarkup(<TeacherAvailabilityPanel {...props({
    windows: [],
    legacySlots: [{ day: 1, start: "09:00", end: "10:30" }],
  })} />);
  assert.match(emptyMonth, /采用旧 AVA 到 2026-08/);

  const collectedMonth = renderToStaticMarkup(<TeacherAvailabilityPanel {...props({
    legacySlots: [{ day: 1, start: "09:00", end: "10:30" }],
  })} />);
  assert.doesNotMatch(collectedMonth, /采用旧 AVA/);
});

test("renders all three edit and delete scopes", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/teacher-availability-panel.tsx", import.meta.url), "utf8"),
  );

  assert.match(source, /<option value="date">仅此日期<\/option>/);
  assert.match(source, /<option value="week">本周<\/option>/);
  assert.match(source, /<option value="all">全部固定时段<\/option>/);
  assert.match(source, /label="修改范围"/);
  assert.match(source, /label="删除范围"/);
  assert.match(source, /onEdit\(\{/);
  assert.match(source, /onDelete\(\{/);
  assert.match(source, /onPromoteLegacy\(selectedMonth\)/);
});

test("renders pending submission review with approve and reject actions", () => {
  const submission = {
    id: "submission-1",
    teacherId: "teacher-a",
    month: "2026-09",
    timezone: "Australia/Melbourne",
    slots: [{ day: 2, start: "12:00", end: "15:00" }],
  } as const;
  const html = renderToStaticMarkup(<TeacherAvailabilityPanel {...props({
    submissions: [{ submission, submittedAt: "2026-08-12T03:00:00.000Z" }],
  })} />);

  assert.match(html, /待审核提交/);
  assert.match(html, /2026-09/);
  assert.match(html, /1 个时段/);
  assert.match(html, />拒绝</);
  assert.match(html, />通过</);
});

test("the panel accepts data and callbacks only", () => {
  assert.deepEqual(
    Object.keys(props()).sort(),
    [
      "displayTimezone",
      "legacySlots",
      "onApproveSubmission",
      "onDelete",
      "onDisplayTimezoneChange",
      "onEdit",
      "onPromoteLegacy",
      "onRejectSubmission",
      "onRefreshSubmissions",
      "referenceDate",
      "reviewError",
      "reviewInboxBusy",
      "reviewingSubmissionId",
      "submissions",
      "teacherId",
      "teacherName",
      "timezoneOptions",
      "windows",
    ].sort(),
  );
});

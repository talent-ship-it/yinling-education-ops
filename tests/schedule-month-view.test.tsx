import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ScheduleMonthView, type ScheduleMonthLesson } from "../app/schedule-month-view.tsx";

const lessons: ScheduleMonthLesson[] = [
  {
    occurrenceId: "SERIES-A:2026-09-07",
    date: "2026-09-07",
    start: "16:00",
    timezone: "Australia/Melbourne",
    studentId: "STUDENT-A",
    status: "completed",
    studentName: "Alex Chen",
    teacherName: "Shirley Li",
    courseLabel: "Year 10 English",
    displayTime: "16:00",
  },
  {
    occurrenceId: "SERIES-B:2026-09-07",
    date: "2026-09-07",
    start: "18:00",
    timezone: "Australia/Melbourne",
    studentId: "STUDENT-B",
    status: "confirmed",
    studentName: "Bella Wang",
    teacherName: "Shirley Li",
    courseLabel: "IB Mathematics",
    displayTime: "18:00",
  },
];

test("renders a full month grid with concrete occurrence buttons and stable student colours", () => {
  const html = renderToStaticMarkup(<ScheduleMonthView
    month="2026-09"
    displayTimezone="Australia/Melbourne"
    language="zh-CN"
    lessons={lessons}
    availability={[{ occurrenceId: "ava-free-1", date: "2026-09-07", displayTime: "14:00–16:00" }]}
    availabilityTeacherName="Shirley Li"
    selectedOccurrenceId={lessons[0].occurrenceId}
    onSelect={() => {}}
  />);

  assert.equal((html.match(/class="month-day[^\"]*" role="group"/g) ?? []).length, 35);
  assert.doesNotMatch(html, /role="grid"|role="gridcell"|role="columnheader"/);
  assert.match(html, /2026-09 月课表/);
  assert.match(html, /Alex Chen/);
  assert.match(html, /Bella Wang/);
  assert.match(html, /14:00–16:00/);
  assert.match(html, /Shirley Li/);
  assert.match(html, /outside-availability/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /--student-event-bg:hsl\(/);
  assert.doesNotMatch(html, /teacherName/);
});

test("keeps English calendar labels available for teacher views", () => {
  const html = renderToStaticMarkup(<ScheduleMonthView
    month="2026-09"
    displayTimezone="Australia/Melbourne"
    language="en-AU"
    lessons={[]}
    onSelect={() => {}}
  />);
  assert.match(html, /2026-09 month schedule/);
  assert.match(html, />Mon</);
});

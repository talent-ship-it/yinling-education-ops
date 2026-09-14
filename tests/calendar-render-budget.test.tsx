import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleMonthView } from "../app/schedule-month-view";
import { dateTimeFormat } from "../lib/date-time-format";
import { expandLessonOccurrences } from "../lib/lesson-occurrences";

test("dense days expose navigation without mounting every lesson", () => {
  const lessons = Array.from({ length: 2500 }, (_, i) => ({ occurrenceId: `fixture-${i}`, date: "2026-09-14", start: "10:00", timezone: "Australia/Melbourne", studentId: `student-${i}`, status: "confirmed" as const, studentName: `学生 ${i}`, teacherName: "老师", courseLabel: "数学", displayTime: "10:00" }));
  const html = renderToStaticMarkup(<ScheduleMonthView month="2026-09" displayTimezone="Australia/Melbourne" language="zh-CN" lessons={lessons} onSelect={() => {}} />);
  assert.equal((html.match(/class="month-event /g) ?? []).length, 4);
  assert.match(html, /2026-09-14 下一组课程/);
  assert.match(html, /625/);
});

test("formatter reuse preserves timezones, locale and daylight saving", () => {
  const options = { timeZone: "Australia/Melbourne", hour: "2-digit", hourCycle: "h23" } as const;
  assert.equal(dateTimeFormat("en-AU", options), dateTimeFormat("en-AU", { hourCycle: "h23", hour: "2-digit", timeZone: "Australia/Melbourne" }));
  for (const zone of ["Australia/Melbourne", "Australia/Adelaide", "Asia/Shanghai"]) for (const instant of ["2026-04-04T15:30:00Z", "2026-04-04T16:30:00Z", "2026-10-03T15:30:00Z", "2026-10-03T16:30:00Z"]) {
    const config = { ...options, timeZone: zone };
    assert.equal(dateTimeFormat("en-AU", config).format(new Date(instant)), new Intl.DateTimeFormat("en-AU", config).format(new Date(instant)));
  }
  assert.throws(() => dateTimeFormat("en", { timeZone: "invalid/zone" }), RangeError);
});

test("range jumps preserve legacy cadence, finite bounds and overrides", () => {
  const series = { id: "fixture", date: "2000-01-01", start: "10:00", duration: 60, recurring: true, recurrenceIntervalDays: 3 };
  const result = expandLessonOccurrences(series, { rangeStart: "2026-09-01", rangeEnd: "2026-09-10" });
  assert.ok(result.length >= 3);
  for (const item of result) assert.equal((Date.parse(item.sourceDate) - Date.parse(series.date)) / 86400000 % 3, 0);
  assert.deepEqual(expandLessonOccurrences({ ...series, repeatCount: 104 }, { rangeStart: "2026-09-01", rangeEnd: "2026-09-10" }), []);
  const moved = expandLessonOccurrences(series, { rangeStart: result[0].date, rangeEnd: result[0].date, overrides: [{ occurrenceId: result[0].occurrenceId, date: "2026-10-02", teacherId: "substitute" }] });
  assert.equal(moved[0].date, "2026-10-02");
  assert.equal(moved[0].teacherId, "substitute");
});

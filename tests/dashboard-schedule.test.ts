import assert from "node:assert/strict";
import test from "node:test";
import { dashboardDate, dashboardLessonsForDay } from "../lib/dashboard-schedule";

test("today follows the selected timezone at midnight instead of the Melbourne day", () => {
  const lesson = new Date("2026-09-21T15:00:00Z");
  assert.equal(dashboardDate(lesson, "Australia/Melbourne"), "2026-09-22");
  assert.equal(dashboardDate(lesson, "Asia/Shanghai"), "2026-09-21");
  assert.deepEqual(dashboardLessonsForDay([lesson], (value) => value, "Asia/Shanghai", "2026-09-22"), []);
});

test("sorts all matching instants before a six-lesson preview, including the DST transition", () => {
  const ordered = Array.from({ length: 8 }, (_, index) => ({
    id: `lesson-${index}`, instant: new Date(Date.parse("2026-10-03T14:00:00Z") + index * 3600000),
  }));
  const result = dashboardLessonsForDay([...ordered].reverse(), (value) => value.instant, "Australia/Melbourne", "2026-10-04");
  assert.deepEqual(result.slice(0, 6).map((item) => item.id), ordered.slice(0, 6).map((item) => item.id));
  assert.equal(result.length, 8);
});

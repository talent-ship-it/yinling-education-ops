import assert from "node:assert/strict";
import test from "node:test";

import { parseJiaowubaoCompletedLessonCronOperation, readJiaowubaoCompletedLessonPendingMonth } from "../lib/jiaowubao-completed-lesson-cron-request";

const NOW = new Date("2026-09-04T08:00:00.000Z");

test("completed-lesson scheduler accepts only no query or one exact closed-month force operation", () => {
  assert.deepEqual(
    parseJiaowubaoCompletedLessonCronOperation("https://app.example.test/api/cron", NOW),
    { force: false, month: null },
  );
  assert.deepEqual(
    parseJiaowubaoCompletedLessonCronOperation("https://app.example.test/api/cron?force=1&month=2026-08", NOW),
    { force: true, month: "2026-08" },
  );
  assert.deepEqual(
    parseJiaowubaoCompletedLessonCronOperation("https://app.example.test/api/cron?month=2026-08&force=1", NOW),
    { force: true, month: "2026-08" },
  );
});

test("completed-lesson scheduler rejects incomplete, duplicate, extra, malformed, and open-month force queries", () => {
  const invalid = [
    "not a URL",
    "https://app.example.test/api/cron?force=1",
    "https://app.example.test/api/cron?month=2026-08",
    "https://app.example.test/api/cron?force=true&month=2026-08",
    "https://app.example.test/api/cron?force=1&force=1&month=2026-08",
    "https://app.example.test/api/cron?force=1&month=2026-08&month=2026-07",
    "https://app.example.test/api/cron?force=1&month=2026-08&extra=1",
    "https://app.example.test/api/cron?force=1&month=2026-8",
    "https://app.example.test/api/cron?force=1&month=2026-13",
    "https://app.example.test/api/cron?force=1&month=2026-09",
    "https://app.example.test/api/cron?force=1&month=2026-10",
  ];
  for (const url of invalid) {
    assert.equal(parseJiaowubaoCompletedLessonCronOperation(url, NOW), null, url);
  }
});

test("pending monthly collection accepts only an explicit empty queue or a valid month", () => {
  assert.deepEqual(readJiaowubaoCompletedLessonPendingMonth({ month: null }), { month: null });
  assert.deepEqual(readJiaowubaoCompletedLessonPendingMonth({ month: "2026-10" }), { month: "2026-10" });
  for (const value of [undefined, null, {}, "2026-10", { month: 202610 }, { month: ["2026-10"] },
    { month: "2026-13" }, { month: "2026-1" }, { month: "" }]) {
    assert.throws(() => readJiaowubaoCompletedLessonPendingMonth(value), /pending_month_invalid/);
  }
});

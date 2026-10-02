import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canPollAbsentPayrollMonth, createPayrollAbsentMonthWake, previousMelbournePayrollMonth } from "../lib/payroll-month";

test("defaults to the previous Melbourne calendar month across UTC and year boundaries", () => {
  assert.equal(previousMelbournePayrollMonth(new Date("2026-09-30T13:59:00.000Z")), "2026-08");
  assert.equal(previousMelbournePayrollMonth(new Date("2026-09-30T14:01:00.000Z")), "2026-09");
  assert.equal(previousMelbournePayrollMonth(new Date("2026-12-31T13:01:00.000Z")), "2026-12");
  assert.equal(previousMelbournePayrollMonth(new Date("2027-01-01T00:00:00.000Z")), "2026-12");
});

test("payroll view keeps a manually selected month and exports the complete hours template", async () => {
  const source = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
  assert.match(source, /const activePayrollMonth = payrollMonthSelection \|\| previousMelbournePayrollMonth\(new Date\(\)\)/u);
  assert.match(source, /onChange=\{\(event\) => \{\s*setPayrollMonthSelection\(event\.target\.value\)/u);
  assert.match(source, /downloadPayrollExcel\(\{[\s\S]*exportMode: "hours_complete"/u);
});

test("absent-month refresh is read-only and discards a response after month cleanup", async () => {
  const source = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (!canPollAbsentPayrollMonth({");
  const end = source.indexOf("}, [active, activePayrollMonth, canViewPayroll", start);
  const refresh = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(refresh, /feed: jiaowubaoCompletedLessonFeed/u);
  assert.match(refresh, /loadAllJiaowubaoCompletedLessonPages\(\{ month: activePayrollMonth, signal \}\)/u);
  assert.match(refresh, /if \(signal\.aborted\) return;\s*setJiaowubaoCompletedLessonError\(false\);\s*setJiaowubaoCompletedLessonFeed\(feed\)/u);
  assert.match(refresh, /poller\.stop\(\)/u);
  assert.doesNotMatch(refresh, /syncJiaowubaoCompletedLessons|method:\s*"POST"/u);
});

test("absent-month refresh requires a closed month, absent feed and idle payroll view", () => {
  const ready = {
    canView: true, active: "payroll", month: "2026-09", currentMonth: "2026-10",
    feed: { state: "absent", month: "2026-09" }, loading: false, syncing: false, exporting: false,
  };
  assert.equal(canPollAbsentPayrollMonth(ready), true);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, month: "2026-10" }), false);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, feed: { state: "complete", month: "2026-09" } }), false);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, feed: { state: "absent", month: "2026-08" } }), false);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, active: "schedule" }), false);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, loading: true }), false);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, syncing: true }), false);
  assert.equal(canPollAbsentPayrollMonth({ ...ready, exporting: true }), false);
});

test("a hidden in-flight read re-arms the remaining wait when the payroll page becomes visible", () => {
  let now = 0;
  let hidden = false;
  let wakeCount = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const clock = createPayrollAbsentMonthWake({
    wake: () => { wakeCount += 1; },
    isHidden: () => hidden,
    now: () => now,
    schedule: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback: () => { timers.delete(id); callback(); }, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => { timers.delete(timer as unknown as number); },
  });
  now = 60_000;
  clock.markStarted();
  hidden = true;
  now = 65_000;
  hidden = false;
  clock.resume();
  assert.equal(wakeCount, 0);
  assert.equal(timers.get(1)?.delay, 55_000);
  now = 120_000;
  timers.get(1)?.callback();
  assert.equal(wakeCount, 1);
  clock.markError();
  now = 150_000;
  clock.resume();
  assert.equal(timers.get(2)?.delay, 90_000);
  clock.stop();
  assert.equal(timers.size, 0);
});

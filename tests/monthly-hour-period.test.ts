import assert from "node:assert/strict";
import test from "node:test";
import { monthlyHourCollectionPeriod, monthlyHourCoverage, monthlyHourRefreshDue } from "../lib/monthly-hour-period";

test("current-month collection freezes yesterday in Melbourne across DST and UTC boundaries", () => {
  assert.equal(monthlyHourCollectionPeriod("2026-10", new Date("2026-10-03T13:30:00Z")).end, "2026-10-02");
  assert.equal(monthlyHourCollectionPeriod("2026-10", new Date("2026-10-03T14:30:00Z")).end, "2026-10-03");
  assert.equal(monthlyHourCollectionPeriod("2026-10", new Date("2026-10-04T13:30:00Z")).end, "2026-10-04");
  assert.equal(monthlyHourCollectionPeriod("2026-10", new Date("2026-10-04T13:30:00Z"), "2026-10-03").end, "2026-10-03");
});

test("month-end closes naturally while an active partial collection keeps its original cutoff", () => {
  assert.throws(() => monthlyHourCollectionPeriod("2026-10", new Date("2026-09-30T14:30:00Z")));
  assert.deepEqual(monthlyHourCollectionPeriod("2026-09", new Date("2026-09-30T14:30:00Z")), {
    month: "2026-09", start: "2026-09-01", end: "2026-09-30", monthEnd: "2026-09-30", provisional: false,
  });
  assert.equal(monthlyHourCollectionPeriod("2026-09", new Date("2026-10-01T14:30:00Z"), "2026-09-29").provisional, true);
  assert.throws(() => monthlyHourCollectionPeriod("2026-11", new Date("2026-10-07T00:00:00Z")));
  assert.throws(() => monthlyHourCollectionPeriod("2026-10", new Date("2026-10-07T00:00:00Z"), "2026-10-07"));
});

test("coverage rejects contradictory flags, impossible dates and cross-month records", () => {
  assert.equal(monthlyHourCoverage("2024-02").end, "2024-02-29");
  assert.throws(() => monthlyHourCoverage("2026-02", "2026-02-29"));
  assert.throws(() => monthlyHourCoverage("2026-09", "2026-09-15", false));
  assert.throws(() => monthlyHourCoverage("2026-09", "2026-09-30", true));
  assert.throws(() => monthlyHourCoverage("2026-09", "2026-10-01"));
});

test("refresh revisits recent months daily and older months weekly without repeating fresh work", () => {
  const now = new Date("2026-10-07T02:00:00Z");
  const current = { month: "2026-10", dataThrough: "2026-10-06", now };
  assert.equal(monthlyHourRefreshDue({ ...current, publishedAt: "2026-10-07T01:00:00Z" }), false);
  assert.equal(monthlyHourRefreshDue({ ...current, dataThrough: "2026-10-05", publishedAt: "2026-10-07T01:00:00Z" }), true);
  assert.equal(monthlyHourRefreshDue({ month: "2026-09", dataThrough: "2026-09-30", now, publishedAt: "2026-10-06T02:00:00Z" }), true);
  const history = { month: "2026-08", dataThrough: "2026-08-31", now };
  assert.equal(monthlyHourRefreshDue({ ...history, publishedAt: "2026-10-01T02:00:00Z" }), false);
  assert.equal(monthlyHourRefreshDue({ ...history, publishedAt: "2026-09-30T02:00:00Z" }), true);
  assert.equal(monthlyHourRefreshDue({ ...history, publishedAt: null }), true);
  assert.throws(() => monthlyHourRefreshDue({ ...history, publishedAt: "2026-10-08T02:00:00Z" }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { localTimeToInstant } from "../lib/teacher-availability";
import { shiftScheduleDate } from "../lib/schedule-calendar";
import { fixture, serverFixture } from "./ava-calendar-server-fixture";

function firstSourceDay() {
  const state = fixture();
  const source = { start: "2026-10-12", end: "2026-10-12" };
  state.page = { ...state.page, sourceWindow: source };
  state.target.window = source;
  state.sources[0]!.payload.sourceWindow = source;
  const window = {
    start: localTimeToInstant(source.start, "00:00", "Australia/Melbourne", "earlier").toISOString(),
    end: localTimeToInstant(shiftScheduleDate(source.end, 1), "00:00", "Australia/Melbourne", "earlier").toISOString(),
  };
  return { state, window };
}

for (const kind of ["human", "machine"] as const) {
  test(`${kind} the actual first and last Melbourne source day retains proved UTC coverage and green`, async () => {
    const { state, window } = firstSourceDay();
    const response = await serverFixture(state).get(kind, window);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.source.coverage, "complete");
    assert.deepEqual(data.source.window, window);
    assert.equal(data.events.length, 1);
    assert.equal(data.remainingAVA.length, 2);
    assert.deepEqual(data.availabilityStatus, [{ teacherId: "T1", reason: "ready" }]);
  });

  test(`${kind} a real source-date overhang remains partial and never publishes green`, async () => {
    const { state, window } = firstSourceDay();
    const ranges = [
      { ...window, start: new Date(Date.parse(window.start) - 1).toISOString() },
      { ...window, end: new Date(Date.parse(window.end) + 1).toISOString() },
    ];
    for (const range of ranges) {
      const response = await serverFixture(state).get(kind, range);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.source.coverage, "partial");
      assert.deepEqual(data.source.window, window);
      assert.equal(data.events.length, 1);
      assert.deepEqual(data.remainingAVA, []);
    }
  });
}

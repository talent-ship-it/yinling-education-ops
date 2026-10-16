import assert from "node:assert/strict";
import test from "node:test";

const range = { start: "2026-10-11T13:00:00.000Z", end: "2026-10-12T13:00:00.000Z" };

function directory() {
  const teachers = Array.from({ length: 274 }, (_, index) => ({ id: `T${index + 1}`, name: `Teacher ${index + 1}` }));
  const lesson = (teacherId, startsAt, endsAt) => ({ teacherId, startsAt, endsAt, eventId: `${teacherId}:${startsAt}`, students: [], trial: false, teacherName: teacherId, identityPending: false });
  return {
    teachers,
    events: [lesson("T20", "2026-10-11T22:00:00Z", "2026-10-11T22:30:00Z"), lesson("T7", "2026-10-11T21:00:00Z", "2026-10-11T21:30:00Z"), lesson("T21", "2026-10-11T22:00:00Z", "2026-10-11T22:30:00Z"), lesson("T1", range.end, "2026-10-12T14:00:00Z")],
    remainingAVA: [{ id: "A274", teacherId: "T274", startsAt: "2026-10-11T22:30:00Z", endsAt: "2026-10-11T23:30:00Z" }],
    availabilityStates: [],
  };
}

async function presentation() {
  const helpers = await import("../app/ava-calendar/live/calendar-presentation").catch(() => null);
  assert.ok(helpers, "calendar presentation must prioritize current-range activity");
  return helpers;
}

test("274 teachers put current-range lessons and AVA first with stable ties and the full directory intact", async () => {
  const { calendarTeacherColumns } = await presentation();
  const data = directory();
  const original = JSON.stringify(data);
  assert.deepEqual(calendarTeacherColumns(data, range, true).map(({ id }) => id), ["T7", "T20", "T21", "T274"]);
  const all = calendarTeacherColumns(data, range, false);
  assert.equal(all.length, 274);
  assert.deepEqual(all.slice(0, 6).map(({ id }) => id), ["T7", "T20", "T21", "T274", "T1", "T2"]);

  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(calendarTeacherColumns(data, { start: range.end, end: "2026-10-13T13:00:00Z" }, true).map(({ id }) => id), ["T1"]);
  assert.deepEqual(calendarTeacherColumns(data, { start: "2026-11-01T00:00:00Z", end: "2026-11-02T00:00:00Z" }, true), []);
  assert.deepEqual(calendarTeacherColumns(null, range, false), []);
});

test("initial scroll uses the earliest displayed wall time, selected teacher and clipped midnight", async () => {
  const { calendarInitialScrollTime } = await presentation();
  assert.equal(typeof calendarInitialScrollTime, "function");
  const data = directory();
  assert.equal(calendarInitialScrollTime(data, range, "Australia/Melbourne", ""), "08:00:00");
  assert.equal(calendarInitialScrollTime(data, range, "Asia/Shanghai", ""), "05:00:00");
  assert.equal(calendarInitialScrollTime(data, range, "UTC", "T20"), "22:00:00");
  assert.equal(calendarInitialScrollTime(data, range, "Australia/Melbourne", "T274"), "09:30:00");
  assert.equal(calendarInitialScrollTime(data, range, "Australia/Melbourne", "T1"), "09:00:00");
  data.events[0].startsAt = "2026-10-11T12:00:00Z";
  data.events[0].endsAt = "2026-10-11T14:00:00Z";
  assert.equal(calendarInitialScrollTime(data, range, "Australia/Melbourne", ""), "00:00:00");
  assert.equal(calendarInitialScrollTime(null, range, "UTC", ""), "09:00:00");
  const week = { start: range.start, end: "2026-10-18T13:00:00Z" };
  data.events[0].startsAt = "2026-10-13T21:00:00Z";
  data.events[0].endsAt = "2026-10-14T01:00:00Z";
  assert.equal(calendarInitialScrollTime(data, week, "UTC", "T20"), "00:00:00");
});

test("earlier AVA never hides the earliest lesson, with AVA as the no-lesson fallback", async () => {
  const { calendarTeacherColumns, calendarInitialScrollTime } = await presentation();
  const data = directory();
  data.remainingAVA[0].startsAt = range.start;
  data.remainingAVA[0].endsAt = "2026-10-11T14:00:00Z";
  assert.deepEqual(calendarTeacherColumns(data, range, true).map(({ id }) => id), ["T7", "T20", "T21", "T274"]);
  assert.equal(calendarInitialScrollTime(data, range, "Australia/Melbourne", ""), "08:00:00");
  data.events = [];
  assert.equal(calendarInitialScrollTime(data, range, "Australia/Melbourne", ""), "00:00:00");
});

test("column reordering preserves the visible teacher, not the former pixel offset", async () => {
  const { calendarColumnScrollLeft } = await presentation();
  assert.equal(typeof calendarColumnScrollLeft, "function");
  const prior = { key: "day-1", columns: ["T7", "T20", "T1"], width: 340 };
  assert.equal(calendarColumnScrollLeft(prior, { ...prior, columns: ["T20", "T7", "T1"] }, 360), 20);
  assert.equal(calendarColumnScrollLeft(prior, { ...prior, columns: ["T7", "T1"] }, 360), 0);
  assert.equal(calendarColumnScrollLeft(prior, { ...prior, key: "day-2" }, 360), 0);
  assert.equal(calendarColumnScrollLeft(prior, { ...prior, width: 300 }, 360), 320);
  assert.equal(calendarColumnScrollLeft(null, prior, 0), 0);
  assert.equal(calendarColumnScrollLeft({ ...prior, width: 0 }, { ...prior, key: "day-2", width: 0 }, 280), 280);
});

test("filtering never removes an authorized empty self calendar or mutates the teacher directory", async () => {
  const { calendarTeacherColumns } = await presentation();
  const data = directory();
  assert.deepEqual(calendarTeacherColumns(data, range, true, "T1").map(({ id }) => id), ["T7", "T20", "T21", "T274", "T1"]);
  assert.equal(calendarTeacherColumns(data, null, false).length, 274);
});

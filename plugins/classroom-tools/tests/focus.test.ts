import test from "node:test";
import assert from "node:assert/strict";
import { VisibilityReporter, isVisibilityReport, toggleClassroomFullscreen, type VisibilityReport } from "../src/focus";

test("fullscreen is requested synchronously from the click route and propagates browser rejection", async () => {
  const calls: string[] = [];
  const document = { fullscreenElement: null as Element | null, documentElement: { requestFullscreen: () => { calls.push("enter"); return Promise.resolve(); } }, exitFullscreen: () => { calls.push("exit"); return Promise.resolve(); } };
  const entering = toggleClassroomFullscreen(document);
  assert.deepEqual(calls, ["enter"]);
  await entering;
  document.fullscreenElement = {} as Element;
  await toggleClassroomFullscreen(document);
  assert.deepEqual(calls, ["enter", "exit"]);
  await assert.rejects(toggleClassroomFullscreen({ fullscreenElement: null, documentElement: {} }), /不支持/);
  await assert.rejects(toggleClassroomFullscreen({ fullscreenElement: null, documentElement: { requestFullscreen: () => Promise.reject(new Error("permission denied")) } }), /permission denied/);
});

test("visibility transitions notify once, bound repeated departure reports and always remind the returning student", () => {
  const reports: VisibilityReport[] = [];
  let reminders = 0;
  const reporter = new VisibilityReporter((report) => reports.push(report), () => { reminders++; });
  reporter.observe(false, 0);
  reporter.observe(true, 1000);
  reporter.observe(true, 2000);
  reporter.observe(false, 3000);
  assert.deepEqual(reports, [{ version: 1, state: "hidden" }, { version: 1, state: "visible" }]);
  reporter.observe(true, 4000);
  reporter.observe(false, 5000);
  assert.equal(reports.length, 2);
  assert.equal(reminders, 2);
  reporter.observe(true, 12000);
  assert.equal(reports.length, 3);
  assert.equal(isVisibilityReport({ version: 1, state: "hidden" }), true);
  assert.equal(isVisibilityReport({ version: 1, state: "punish" }), false);
  assert.equal(isVisibilityReport(null), false);
});

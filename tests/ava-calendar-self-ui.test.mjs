import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function calendarOptions(writable) {
  const file = "app/ava-calendar/live/calendar-client.tsx";
  const syntax = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constructor = syntax.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "createCalendar");
  const compiled = ts.transpileModule(constructor.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const create = runInNewContext(`${compiled}\ncreateCalendar;`, { Calendar: class { constructor(host, options) { this.options = options; } }, timeGridPlugin: {}, dayGridPlugin: {}, interactionPlugin: {}, luxonPlugin: {}, zhCnLocale: {}, renderLesson() {}, mountLesson() {} });
  const intervals = [];
  const points = [];
  return { options: create({}, { zone: "UTC", view: "timeGridDay", writable }, () => {}, () => {}, { select: (start, end) => intervals.push([start, end]), point: (date, instance) => points.push([date, instance]) }).options, intervals, points };
}
test("only the authorized self calendar accepts real drag and two-point input; lessons never become editable", () => {
  const { options, intervals, points } = calendarOptions(true);
  assert.equal(options.selectable, true);
  assert.equal(options.editable, false);
  assert.equal(options.eventStartEditable, false);
  assert.equal(options.eventDurationEditable, false);
  assert.equal(calendarOptions(false).options.selectable, false);
  const start = new Date("2026-10-12T03:00:00Z");
  const end = new Date("2026-10-12T04:30:00Z");
  options.select({ start, end, jsEvent: {}, allDay: false });
  options.select({ start, end, jsEvent: null, allDay: false });
  assert.deepEqual(intervals, [[start, end]]);
  options.dateClick({ date: start, allDay: false, view: { calendar: "self" } });
  assert.deepEqual(points, [[start, "self"]]);
});

test("destroyed calendar callbacks cannot change the visible range or open stale editors", async () => {
  const implementation = await import("../app/ava-calendar/live/calendar-columns");
  assert.ok(implementation.calendarLifecycle, "calendar callbacks must be fenced after destruction");
  const lifecycle = implementation.calendarLifecycle();
  const seen = [];
  const callback = lifecycle.guard((value) => seen.push(value));
  callback("current"); lifecycle.dispose(); callback("stale");
  assert.deepEqual(seen, ["current"]);
});

test("all-teacher columns render a bounded viewport while retaining the last teacher", async () => {
  const implementation = await import("../lib/ava-calendar-columns").catch(() => null);
  assert.ok(implementation?.calendarColumnWindow, "all-teacher calendars need a bounded viewport");
  const first = implementation.calendarColumnWindow(273, 1200, 0);
  assert.equal(first.first, 0);
  assert.ok(first.end - first.first <= 8);
  const last = implementation.calendarColumnWindow(273, 1200, 273 * first.columnWidth);
  assert.equal(last.end, 273);
  assert.ok(last.end - last.first <= 8);
  assert.ok(last.first > 0);
  const phone = implementation.calendarColumnWindow(273, 302, 0);
  assert.equal(phone.columnWidth, 302);
});

test("local editor rejects nonexistent DST times and requires explicit repeated-time offset", async () => {
  const implementation = await import("../lib/ava-calendar-editor").catch(() => null);
  assert.ok(implementation?.calendarEditorInstant, "timezone-safe editor conversion is required");
  const convert = implementation.calendarEditorInstant;
  assert.throws(() => convert("2026-10-04T02:30", "Australia/Melbourne"), /不存在/);
  assert.throws(() => convert("2026-11-01T01:30", "America/New_York"), /偏移/);
  assert.equal(convert("2026-11-01T01:30", "America/New_York", "earlier"), "2026-11-01T05:30:00.000Z");
  assert.equal(convert("2026-11-01T01:30", "America/New_York", "later"), "2026-11-01T06:30:00.000Z");
  assert.equal(convert("2026-10-17T00:30", "Asia/Shanghai"), "2026-10-16T16:30:00.000Z");
});

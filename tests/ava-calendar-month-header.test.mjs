import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const file = "app/ava-calendar/live/calendar-client.tsx";
const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const constructor = syntax.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "createCalendar");
assert.ok(constructor, "the shipping Calendar constructor must be exercised");
const compiled = ts.transpileModule(constructor.getText(syntax), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test("live Calendar uses weekday-only month headers without changing dated time-grid headers", () => {
  class CaptureCalendar {
    constructor(host, options) { this.host = host; this.options = options; }
  }
  const createCalendar = runInNewContext(`${compiled}\ncreateCalendar;`, {
    Calendar: CaptureCalendar,
    timeGridPlugin: {}, dayGridPlugin: {}, interactionPlugin: {}, luxonPlugin: {}, zhCnLocale: {},
    renderLesson() {}, mountLesson() {},
  });
  const host = {};
  const datesSet = () => {};
  const calendar = createCalendar(host, { zone: "Australia/Melbourne", view: "dayGridMonth" }, datesSet, () => {});
  const options = JSON.parse(JSON.stringify(calendar.options));
  assert.equal(calendar.host, host);
  assert.equal(calendar.options.datesSet, datesSet);
  assert.deepEqual(options.views.dayGridMonth?.dayHeaderFormat, { weekday: "short" });
  assert.equal(options.views.dayGridMonth?.dayMaxEvents, 3);
  assert.deepEqual(options.dayHeaderFormat, { month: "2-digit", day: "2-digit", weekday: "short" });
  assert.deepEqual(options.views.timeGridThreeDay, { type: "timeGrid", duration: { days: 3 } });
  assert.equal(options.firstDay, 1);
  assert.equal(options.timeZone, "Australia/Melbourne");
});

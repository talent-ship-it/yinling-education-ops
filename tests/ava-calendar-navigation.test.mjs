import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { Calendar } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import luxonPlugin from "@fullcalendar/luxon3";
import { DateTime } from "luxon";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

const file = "app/ava-calendar/live/calendar-client.tsx";
const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function shipping(names, scope = {}) {
  const selected = syntax.statements.filter((statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
  assert.equal(selected.length, names.length, `shipping functions required: ${names.join(", ")}`);
  const compiled = ts.transpileModule(selected.map((item) => item.getText(syntax)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return runInNewContext(`${compiled}\n({${names.join(",")}});`, { require(name) { assert.equal(name, "react/jsx-runtime"); return jsxRuntime; }, exports: {}, DateTime, ...scope });
}

const directory = { teachers: [{ id: "T1", name: "Synthetic First" }, { id: "T2", name: "Synthetic Last" }], events: [], remainingAVA: [] };
test("calendar timezone follows account preferences while keeping the selected view across preference changes", () => {
  const states = [];
  let cursor = 0;
  const { useCalendarViewState } = shipping(["useCalendarViewState"], {
    initialCalendarView: () => "timeGridDay",
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = value; }];
    },
  });
  const selected = [];
  const change = (timezone) => selected.push(timezone);
  const first = useCalendarViewState({ displayTimezone: "Asia/Shanghai", onDisplayTimezoneChange: change });
  assert.equal(first.zone, "Asia/Shanghai");
  first.setView("timeGridWeek");
  first.setZone("Australia/Melbourne");
  assert.deepEqual(selected, ["Australia/Melbourne"]);
  cursor = 0;
  const second = useCalendarViewState({ displayTimezone: selected[0], onDisplayTimezoneChange: change });
  assert.equal(second.zone, "Australia/Melbourne");
  assert.equal(second.view, "timeGridWeek");
});

test("all-teacher day columns do not disable aggregate three-day week or month views", () => {
  const { globalCalendarView, surfaceColumns } = shipping(["globalCalendarView", "surfaceColumns"], { calendarTeacherColumns: (data) => data.teachers });
  assert.equal(globalCalendarView(directory, "", "timeGridDay"), true);
  for (const view of ["timeGridThreeDay", "timeGridWeek", "dayGridMonth"]) {
    assert.equal(globalCalendarView(directory, "", view), false, view);
    assert.deepEqual(JSON.parse(surfaceColumns(directory, "", false, null, true)), [{ id: "", name: "" }]);
  }
  assert.deepEqual(JSON.parse(surfaceColumns(directory, "T2", false, null, true)), [{ id: "T2", name: "" }]);
});

test("view choices expose four usable pressed-state buttons for all teachers", () => {
  const declarations = ["CalendarControls", "TeacherFilter", ...(source.includes("function CalendarViewButtons(") ? ["CalendarViewButtons"] : [])];
  const scope = { styles: new Proxy({}, { get: (_, key) => key }), ZONES: { UTC: "UTC" } };
  const { CalendarControls } = shipping(declarations, scope);
  const noop = () => {};
  const html = renderToStaticMarkup(CalendarControls({ data: directory, teacher: "", setTeacher: noop, zone: "UTC", setZone: noop, view: "timeGridWeek", setView: noop, global: true, activeOnly: true, setActiveOnly: noop, loading: false, refreshCalendar: noop }));
  assert.match(html, /role="group" aria-label="日历视图"/);
  assert.equal((html.match(/aria-pressed="(?:true|false)" data-view=/g) ?? []).length, 4);
  assert.match(html, /aria-pressed="true" data-view="timeGridWeek"/);
  assert.doesNotMatch(html, /<select[^>]*aria-label="日历视图"[^>]*disabled/);
});

test("date and view changes reuse the calendar and preserve a wall date across timezone changes", () => {
  const { updateCalendarDisplay } = shipping(["updateCalendarDisplay"]);
  const calendar = new Calendar({ isConnected: false }, { plugins: [timeGridPlugin, dayGridPlugin, luxonPlugin], initialView: "timeGridDay", initialDate: "2026-11-18", timeZone: "Australia/Melbourne", firstDay: 1, views: { timeGridThreeDay: { type: "timeGrid", duration: { days: 3 } } } });
  for (const zone of ["UTC", "Europe/London", "Australia/Melbourne"]) {
    for (const view of ["timeGridThreeDay", "timeGridWeek", "dayGridMonth", "timeGridDay"]) {
      updateCalendarDisplay(calendar, zone, view, "2026-11-18");
      assert.equal(calendar.view.type, view);
      assert.equal(DateTime.fromJSDate(calendar.getDate(), { zone }).toISODate(), "2026-11-18");
    }
  }
  calendar.destroy();
});

function liveHook() {
  const states = [], refs = [], effects = [], reads = [];
  let stateCursor = 0, refCursor = 0;
  const functions = shipping(["useLiveData", "readFailure", "accessLost", "synchronizationFailure", "readFailureSync"], {
    useState(initial) { const index = stateCursor++; if (!(index in states)) states[index] = initial; return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useCallback: (callback) => callback,
    useEffect: (callback) => effects.push(callback),
    useAvaCalendarVisibleRefresh() {}, AbortController, setTimeout, clearTimeout,
    fetchAvaCalendarWindow(window, signal) { return new Promise((resolve) => reads.push({ window, signal, resolve })); },
  });
  return { states, reads, render() { stateCursor = 0; refCursor = 0; effects.length = 0; const value = functions.useLiveData({ start: "2026-11-18T00:00:00.000Z", end: "2026-11-19T00:00:00.000Z" }, () => {}); return { value, start: () => effects[0]() }; } };
}

test("a successful self save invalidates a pending read without weakening ordinary duplicate suppression", async () => {
  const state = liveHook();
  const first = state.render(), cleanup = first.start();
  first.value.refreshCalendar();
  assert.equal(state.states[0], 0);
  assert.equal(typeof first.value.invalidateCalendar, "function");
  first.value.invalidateCalendar();
  assert.equal(state.states[0], 1);
  cleanup();
  const next = state.render(), cleanupNext = next.start();
  assert.equal(state.reads[0].signal.aborted, true);
  state.reads[1].resolve({ events: [{ eventId: "new" }], teachers: [], remainingAVA: [], availabilityStates: [] });
  await new Promise((resolve) => setImmediate(resolve));
  state.reads[0].resolve({ events: [{ eventId: "old" }], teachers: [], remainingAVA: [], availabilityStates: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.states[1].events[0].eventId, "new");
  assert.equal(state.reads.length, 2);
  cleanupNext();
});

test("the mounted calendar survives date-range, view and timezone updates", () => {
  const references = [], effects = [], queued = [];
  let refIndex = 0, effectIndex = 0, created = 0, destroyed = 0;
  const fakeNode = () => ({ dataset: {}, append() {}, removeAttribute() {}, replaceChildren() {}, parentElement: { clientWidth: 900 } });
  const { useMountedCalendars: mountCalendars } = shipping(["useMountedCalendars", "updateCalendarDisplay", "calendarAnchorDate", "completesCalendarPoint"], {
    useRef(initial) { return references[refIndex++] ??= { current: initial }; },
    useEffect(callback, dependencies) { const index = effectIndex++; const prior = effects[index]; if (!prior || dependencies.some((value, i) => value !== prior.dependencies[i])) queued.push({ index, callback, dependencies }); },
    node: fakeNode, styles: {}, appendCalendarSpacer() {}, sizeTeacherColumn() {}, restoreCalendarScroll() {}, calendarScrollers: () => [], readCalendarScroll: (_, prior) => prior,
    calendarLifecycle: () => ({ guard: (callback) => callback, dispose() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    createCalendar(_host, initial, datesSet) {
      created++;
      const instance = new Calendar({ isConnected: false }, { plugins: [timeGridPlugin, dayGridPlugin, luxonPlugin], initialView: initial.view, initialDate: initial.date, timeZone: initial.zone, views: { timeGridThreeDay: { type: "timeGrid", duration: { days: 3 } } } });
      instance.render = () => datesSet({ timeZone: initial.zone, view: { calendar: instance } });
      instance.destroy = () => { destroyed++; };
      return instance;
    },
  });
  const props = { hostRef: { current: fakeNode() }, anchorRef: { current: "2026-11-18" }, pendingRef: { current: null }, scrollRef: { current: { top: -1, left: 0 } }, columns: '[{"id":"T1","name":""}]', order: '["T1"]', positionKey: "initial-range", first: 0, end: 1, totalColumns: 1, columnWidth: 0, global: false, zone: "Australia/Melbourne", view: "timeGridDay", selfId: "T1", calendarsRef: { current: [] }, datesSet() {}, openLesson() {}, openDraft() {} };
  function render(next) {
    refIndex = 0; effectIndex = 0; queued.length = 0;
    mountCalendars(next);
    for (const item of queued) effects[item.index]?.cleanup?.();
    for (const item of queued) effects[item.index] = { dependencies: item.dependencies, cleanup: item.callback() };
  }
  try {
    render(props);
    const original = props.calendarsRef.current[0];
    original.gotoDate("2026-11-19"); props.anchorRef.current = "2026-11-19";
    render({ ...props, positionKey: "next-range" });
    for (const view of ["timeGridThreeDay", "timeGridWeek", "dayGridMonth", "timeGridDay"]) {
      render({ ...props, positionKey: `range-${view}`, view });
      assert.equal(props.calendarsRef.current[0], original);
    }
    render({ ...props, positionKey: "UTC-range", zone: "UTC" });
    assert.equal(props.calendarsRef.current[0], original);
    assert.equal(DateTime.fromJSDate(original.getDate(), { zone: "UTC" }).toISODate(), "2026-11-19");
    assert.equal(created, 1);
    assert.equal(destroyed, 0);
  } finally { for (const effect of effects) effect.cleanup?.(); }
  assert.equal(destroyed, 1);
});


test("month popovers stay inside the visible calendar and viewport with an internally scrollable body", () => {
  const body = { style: {}, get offsetHeight() { return Math.min(900, Number.parseFloat(this.style.maxHeight) || 900); } };
  const origin = { top: 300, left: 100 };
  const popover = {
    style: {}, offsetParent: { getBoundingClientRect: () => origin }, querySelector: () => body,
    get offsetHeight() { return body.offsetHeight + 30; },
    getBoundingClientRect() { return { top: Number.parseFloat(this.style.top ?? "100") + origin.top, left: Number.parseFloat(this.style.left ?? "900") + origin.left, height: this.offsetHeight, width: Math.min(320, Number.parseFloat(this.style.maxWidth) || 320) }; },
  };
  const viewport = { offsetTop: 0, offsetLeft: 0, height: 725, width: 900 };
  const host = { querySelector: () => popover, closest: () => ({ getBoundingClientRect: () => ({ top: 300, bottom: 1020, left: 200, right: 1083 }) }) };
  const { fitCalendarPopover } = shipping(["fitCalendarPopover", "calendarPopoverBounds"], { window: { visualViewport: viewport } });
  for (const height of [725, 480, 400]) {
    viewport.height = height;
    fitCalendarPopover(host);
    const bounds = popover.getBoundingClientRect();
    assert.ok(bounds.top >= 308);
    assert.ok(bounds.top + bounds.height <= height - 8);
    assert.ok(bounds.left >= 208);
    assert.ok(bounds.left + bounds.width <= 892);
    assert.ok(body.offsetHeight < 900);
  }
});


test("manual DOM scroll is captured before a reused calendar changes timezone or date", async () => {
  const { readCalendarScroll, restoreCalendarScroll } = await import("../app/ava-calendar/live/calendar-columns.ts");
  const { calendarColumnScrollLeft } = await import("../app/ava-calendar/live/calendar-presentation.ts");
  const viewport = { scrollLeft: 0 };
  const scroller = { scrollTop: 0 };
  const host = { current: { parentElement: viewport, querySelectorAll: () => [{ closest: () => scroller }] } };
  const refs = [], commits = [];
  let cursor = 0, effectCursor = 0;
  const { useCalendarPosition: positionHook } = shipping(["useCalendarPosition"], {
    useRef(value) { return refs[cursor++] ??= { current: value }; },
    useEffect(callback, dependencies) {
      const i = effectCursor++;
      const saved = commits[i];
      if (!saved || dependencies.some((value, index) => value !== saved.dependencies[index])) {
        saved?.cleanup?.();
        commits[i] = { dependencies, cleanup: callback() };
      }
    },
    readCalendarScroll, restoreCalendarScroll, calendarColumnScrollLeft,
  });
  const render = (key, width = 0, order = '["T1"]') => { cursor = 0; effectCursor = 0; return positionHook(host, key, order, width); };
  const position = render("Melbourne-week");
  viewport.scrollLeft = 280;
  scroller.scrollTop = 300;
  assert.equal(position.current.left, 0);
  render("Melbourne-week");
  assert.equal(viewport.scrollLeft, 280);
  render("UTC-week");
  assert.equal(viewport.scrollLeft, 280);
  assert.equal(position.current.left, 280);
  assert.equal(position.current.top, -1);
  viewport.scrollLeft = 340;
  scroller.scrollTop = 700;
  render("UTC-next-week");
  assert.equal(viewport.scrollLeft, 340);
  assert.equal(position.current.top, -1);
  render("next-day-columns", 340, '["T1","T2"]');
  assert.equal(viewport.scrollLeft, 0);
  for (const effect of commits) effect.cleanup?.();
});

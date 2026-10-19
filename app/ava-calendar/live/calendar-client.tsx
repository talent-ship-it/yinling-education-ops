"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Calendar, type DatesSetArg, type EventContentArg, type EventInput, type EventMountArg } from "@fullcalendar/core";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import luxonPlugin from "@fullcalendar/luxon3";
import { DateTime } from "luxon";
import type { AvaCalendarEvent } from "@/lib/ava-calendar-projection";
import { fetchAvaCalendarRange as fetchAvaCalendarWindow, type AvaCalendarLiveData, type AvaCalendarLiveWindow } from "@/lib/ava-calendar-live-client";
import { ASSIGNABLE_DEMO_STAFF_USERS as TRIAL_OPERATIONS } from "@/lib/demo-users";
import styles from "./calendar.module.css";
import { useAvaCalendarVisibleRefresh } from "@/lib/ava-calendar-visible-refresh";
import type { AvaCalendarSync } from "@/lib/ava-calendar-display";
import { SelfAvailabilityButton, SelfAvailabilityDialogs, useTeacherSelfAvailability, type AvailabilityDraft } from "./self-editor";
import { useCalendarColumnWindow, calendarScrollers, readCalendarScroll, restoreCalendarScroll, appendCalendarSpacer, sizeTeacherColumn, calendarLifecycle } from "./calendar-columns";
import { calendarTeacherColumns, calendarInitialScrollTime, calendarColumnScrollLeft, type CalendarColumnPosition } from "./calendar-presentation";

const ZONES: Record<string, string> = { "Australia/Melbourne": "墨尔本", "Australia/Sydney": "悉尼", "Australia/Brisbane": "布里斯班", "Australia/Adelaide": "阿德莱德", "Australia/Perth": "珀斯", "Pacific/Auckland": "奥克兰", "Asia/Shanghai": "中国", "Asia/Hong_Kong": "香港", "Asia/Singapore": "新加坡", "Europe/London": "伦敦", "America/New_York": "纽约", UTC: "UTC" };

function readFailure(error: unknown) {
  return error instanceof Error && error.name !== "AbortError" ? error.message : "读取超时，请重试。";
}


function accessLost(failure: string) {
  return failure.startsWith("登录已失效") || failure.startsWith("当前账号无权");
}

function synchronizationFailure(failure: string) { return !!failure && !accessLost(failure) && !failure.startsWith("课表或身份已更新"); }
function readFailureSync(prior: AvaCalendarSync | undefined, failure: string): AvaCalendarSync | undefined {
  if (!synchronizationFailure(failure)) return undefined;
  return { state: "sync_failed", lastSuccessAt: prior?.lastSuccessAt ?? null, staleAfterMinutes: 90 };
}
function selectedLesson(data: AvaCalendarLiveData | null, loading: boolean, selectedId: string) {
  if (loading) return undefined;
  return data?.events.find((event) => event.eventId === selectedId);
}

function useLiveData(window: AvaCalendarLiveWindow | null, onAccessLost: () => void) {
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<AvaCalendarLiveData | null>(null);
  const [dataRange, setDataRange] = useState<AvaCalendarLiveWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [sync, setSync] = useState<AvaCalendarSync>();
  const busy = useRef(true);
  const refreshCalendar = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setRefresh((value) => value + 1);
  }, []);
  const invalidateCalendar = useCallback(() => {
    busy.current = true;
    setRefresh((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!window) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 50000);
    let mounted = true;
    function reportFailure(error: unknown) {
      if (!mounted) return;
      const message = readFailure(error);
      setFailure(message);
      setData(null);
      setSync((prior) => readFailureSync(prior, message));
      if (accessLost(message)) onAccessLost();
    }
    async function read() {
      busy.current = true;
      setLoading(true); setFailure("");
      try {
        const next = await fetchAvaCalendarWindow(window!, abort.signal);
        if (mounted) { setData(next); setDataRange(window); setSync(next.sync); }
      } catch (error) {
        reportFailure(error);
      } finally {
        clearTimeout(timer);
        if (mounted) { busy.current = false; setLoading(false); }
      }
    }
    void read();
    return () => { mounted = false; clearTimeout(timer); abort.abort(); };
  }, [window, refresh, onAccessLost]);
  useAvaCalendarVisibleRefresh(loading, refreshCalendar);
  return { data, dataRange, loading, failure, refreshCalendar, invalidateCalendar, sync };
}

function node(tag: string, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function lessonDisplayStudents(lesson: AvaCalendarEvent) {
  return [...lesson.students, ...(lesson.unresolvedSourceStudents ?? []).map((student) => ({ ...student, color: "owner-unassigned" }))];
}

function studentNameNode(student: { studentName: string; color: string }) {
  const name = node("span", styles.studentName, student.studentName || "学生待确认");
  name.dataset.ownerColor = student.color;
  return name;
}

function lessonTeacherName(lesson: AvaCalendarEvent) {
  return lesson.teacherName || "老师待确认";
}

function lessonNames(lesson: AvaCalendarEvent) {
  const names = node("strong", styles.names);
  if (lesson.trial) {
    const badge = node("b", styles.trialTag, "试听");
    badge.dataset.trial = "true"; names.append(badge);
  }
  const students = lessonDisplayStudents(lesson);
  for (const student of students) names.append(studentNameNode(student));
  if (!students.length) {
    const name = node("span", styles.studentName, "学生待确认");
    name.dataset.ownerColor = "owner-unassigned"; names.append(name);
  }
  return names;
}

function lessonOwnerNames(lesson: AvaCalendarEvent) {
  return [...new Set(lessonDisplayStudents(lesson).map((student) => student.owner || "教务待分配"))].join(" / ");
}

function renderLesson(info: EventContentArg) {
  const lesson = info.event.extendedProps.lesson as AvaCalendarEvent | undefined;
  if (!lesson) return { domNodes: [] };
  const copy = node("div", styles.eventCopy);
  const zone = String(info.view.calendar.getOption("timeZone"));
  const start = info.isStart ? DateTime.fromISO(lesson.startsAt).setZone(zone).toFormat("HH:mm") : "00:00";
  const end = info.isEnd ? DateTime.fromISO(lesson.endsAt).setZone(zone).toFormat("HH:mm") : "24:00";
  copy.append(lessonNames(lesson), node("span", styles.eventTime, `${start}–${end}`), node("span", styles.eventDetail, `${lessonTeacherName(lesson)} · ${lessonOwnerNames(lesson)}`));
  return { domNodes: [copy] };
}

function lessonInputs(data: AvaCalendarLiveData | null, teacher: string): EventInput[] {
  if (!data) return [];
  const lessons = data.events.filter((event) => !teacher || event.teacherId === teacher).map((lesson) => {
    const students = lessonDisplayStudents(lesson);
    const colors = new Set(students.map((student) => student.color));
    return { id: lesson.eventId, start: lesson.startsAt, end: lesson.endsAt, title: students.map((student) => student.studentName).join("、") || "学生待确认", classNames: [styles.lesson, ...(Date.parse(lesson.endsAt) - Date.parse(lesson.startsAt) < 3600000 ? [styles.compact] : [])], extendedProps: { lesson, ownerColor: colors.size === 1 ? [...colors][0] : "owner-unassigned" } };
  });
  const remaining = data.remainingAVA.filter((interval) => !teacher || interval.teacherId === teacher).map((interval) => ({ id: `ava:${interval.id}:${interval.startsAt}`, start: interval.startsAt, end: interval.endsAt, display: "background", classNames: [styles.free], extendedProps: { interval } }));
  return [...lessons, ...remaining];
}

function mountLesson(info: EventMountArg, openLesson: (lesson: AvaCalendarEvent) => void) {
  const lesson = info.event.extendedProps.lesson as AvaCalendarEvent | undefined;
  if (!lesson) { info.el.dataset.avaId = info.event.extendedProps.interval.id; return; }
  info.el.dataset.eventId = lesson.eventId; info.el.dataset.ownerColor = info.event.extendedProps.ownerColor;
  info.el.dataset.start = lesson.startsAt; info.el.dataset.end = lesson.endsAt;
  info.el.setAttribute("role", "button"); info.el.setAttribute("tabindex", "0");
  info.el.setAttribute("aria-label", `${lesson.trial ? "试听课" : "正式课"} ${info.event.title} ${lessonTeacherName(lesson)}`);
  info.el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); openLesson(lesson);
  });
}

type CalendarEntry = { select: (start: Date, end: Date) => void; point: (date: Date, instance: Pick<Calendar, "select" | "unselect">) => void };
function createCalendar(host: HTMLElement, initial: { zone: string; view: string; writable?: boolean; date?: string }, datesSet: (info: DatesSetArg) => void, openLesson: (lesson: AvaCalendarEvent) => void, entry?: CalendarEntry) {
  return new Calendar(host, {
    plugins: [timeGridPlugin, dayGridPlugin, interactionPlugin, luxonPlugin], locale: zhCnLocale,
    initialView: initial.view, initialDate: initial.date, timeZone: initial.zone, firstDay: 1, headerToolbar: false,
    allDaySlot: false, height: 720, selectable: initial.writable === true, editable: false, eventStartEditable: false, eventDurationEditable: false,
    selectMinDistance: 5, selectLongPressDelay: 350, selectMirror: false, unselectAuto: false, snapDuration: "00:15:00",
    selectAllow: (range) => !range.allDay && range.end.valueOf() - range.start.valueOf() >= 900000 && range.end.valueOf() - range.start.valueOf() < 86400000,
    select(info) { if (!info.allDay && info.jsEvent) entry?.select(info.start, info.end); },
    dateClick(info) { if (!info.allDay && initial.writable) entry?.point(info.date, info.view.calendar); },
    views: { timeGridThreeDay: { type: "timeGrid", duration: { days: 3 } }, dayGridMonth: { dayHeaderFormat: { weekday: "short" }, dayMaxEvents: 3 } },
    slotDuration: "00:30:00", slotMinTime: "00:00:00", slotMaxTime: "24:00:00", scrollTime: "09:00:00", scrollTimeReset: false,
    nowIndicator: true, eventMinHeight: 0, eventShortHeight: 34,
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    dayHeaderFormat: { month: "2-digit", day: "2-digit", weekday: "short" }, eventContent: renderLesson, datesSet,
    eventDidMount: (info) => mountLesson(info, openLesson),
    eventClick(info) { const lesson = info.event.extendedProps.lesson as AvaCalendarEvent | undefined; if (lesson) openLesson(lesson); },
  });
}

type CalendarRefs = RefObject<Calendar[]>;
function DateNavigation({ calendarsRef, date }: { calendarsRef: CalendarRefs; date: string }) {
  return <div className={styles.navigation}>
    <button type="button" className={styles.iconButton} aria-label="上一页" onClick={() => calendarsRef.current.forEach((calendar) => calendar.prev())}>‹</button>
    <button type="button" className={styles.iconButton} aria-label="下一页" onClick={() => calendarsRef.current.forEach((calendar) => calendar.next())}>›</button>
    <button type="button" onClick={() => calendarsRef.current.forEach((calendar) => calendar.today())}>今天</button>
    <input type="date" aria-label="日期" value={date} onChange={(event) => { if (event.target.value) calendarsRef.current.forEach((calendar) => calendar.gotoDate(event.target.value)); }} />
  </div>;
}

function TeacherFilter({ data, teacher, setTeacher }: { data: AvaCalendarLiveData | null; teacher: string; setTeacher: (value: string) => void }) {
  return <select aria-label="老师" value={teacher} onChange={(event) => setTeacher(event.target.value)}><option value="">全部老师</option>{teacher && !data?.teachers.some((item) => item.id === teacher) && <option value={teacher}>已选老师</option>}{data?.teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;
}

function CalendarViewButtons({ view, setView }: { view: string; setView: (value: string) => void }) {
  return <div className={styles.viewSwitcher} role="group" aria-label="日历视图">{[["timeGridDay", "日"], ["timeGridThreeDay", "3 天"], ["timeGridWeek", "周"], ["dayGridMonth", "月"]].map(([value, label]) => <button type="button" key={value} aria-pressed={view === value} data-view={value} onClick={() => setView(value)}>{label}</button>)}</div>;
}

type ControlsProps = { data: AvaCalendarLiveData | null; teacher: string; setTeacher: (value: string) => void; zone: string; setZone: (value: string) => void; view: string; setView: (value: string) => void; global: boolean; activeOnly: boolean; setActiveOnly: (value: boolean) => void; loading: boolean; refreshCalendar: () => void };
function CalendarControls({ data, teacher, setTeacher, zone, setZone, view, setView, global, activeOnly, setActiveOnly, loading, refreshCalendar }: ControlsProps) {
  return <div className={styles.controls}>
    <TeacherFilter data={data} teacher={teacher} setTeacher={setTeacher} />
    <select aria-label="显示时区" value={zone} onChange={(event) => setZone(event.target.value)}>{[...new Set([zone, ...Object.keys(ZONES)])].map((value) => <option key={value} value={value}>{ZONES[value] || value}</option>)}</select>
    <CalendarViewButtons view={view} setView={setView} />
    <button type="button" disabled={loading} onClick={refreshCalendar}>刷新</button>
    {global && <button type="button" aria-pressed={activeOnly} onClick={() => setActiveOnly(!activeOnly)}>只看有课/AVA</button>}
  </div>;
}

function hasRemainingAvailability(data: AvaCalendarLiveData, teacher: string) {
  return data.remainingAVA.some((interval) => !teacher || interval.teacherId === teacher);
}

function availabilityMessageForTeachers(data: AvaCalendarLiveData, teacher: string, teachers: AvaCalendarLiveData["teachers"]) {
  if (!teachers.length) return "AVA 数据暂未就绪";
  if (hasRemainingAvailability(data, teacher)) return "";
  const states = new Map(data.availabilityStates.map((item) => [item.teacherId, item.state]));
  return teachers.every((item) => states.get(item.id) === "empty") ? "当前范围无可用 AVA" : "AVA 数据暂未就绪";
}

function availabilityMessage(data: AvaCalendarLiveData | null, teacher: string) {
  return data ? availabilityMessageForTeachers(data, teacher, teacher ? data.teachers.filter((item) => item.id === teacher) : data.teachers) : "";
}

function LoadingStatus({ loading }: { loading: boolean }) {
  if (!loading) return null;
  return <p role="status" className={styles.status}>正在读取…</p>;
}

function FailureStatus({ failure }: { failure: string }) {
  if (!failure) return null;
  return <p role="alert" className={styles.status}>{failure}{failure.startsWith("登录已失效") && <> <a href="/ava-calendar/live">重新登录</a></>}</p>;
}

function MessageStatus({ loading, failure, message }: { loading: boolean; failure: string; message: string }) {
  if (loading || failure || !message) return null;
  return <p role="status" className={styles.status}>{message}</p>;
}

function ReadStatus({ loading, failure, message }: { loading: boolean; failure: string; message: string }) {
  return <><LoadingStatus loading={loading} /><FailureStatus failure={failure} /><MessageStatus loading={loading} failure={failure} message={message} /></>;
}

function detailTime(event: AvaCalendarEvent, zone: string) {
  const start = DateTime.fromISO(event.startsAt).setZone(zone);
  const end = DateTime.fromISO(event.endsAt).setZone(zone);
  return `${start.toFormat("yyyy-MM-dd HH:mm")} – ${end.toFormat(start.toISODate() === end.toISODate() ? "HH:mm" : "yyyy-MM-dd HH:mm")}`;
}

function DetailStudents({ lesson }: { lesson: AvaCalendarEvent }) {
  const students = lessonDisplayStudents(lesson);
  return students.length ? students.map((student, index) => <div key={index}><span>{student.owner || "教务待分配"}</span><strong data-owner-color={student.color}>{student.studentName || "学生待确认"}</strong></div>) : <div><strong data-owner-color="owner-unassigned">学生待确认</strong></div>;
}

function DetailContent({ selected, zone }: { selected: AvaCalendarEvent | undefined; zone: string }) {
  if (!selected) return null;
  return <div className={styles.detailContent}>
    <div><span>老师</span><strong>{lessonTeacherName(selected)}</strong></div>
    <div><span>时间 · {ZONES[zone] || zone}</span><strong>{detailTime(selected, zone)}</strong></div>
    <div><span>时长</span><strong>{(Date.parse(selected.endsAt) - Date.parse(selected.startsAt)) / 60000} 分钟</strong></div>
    <DetailStudents lesson={selected} />
    {selected.identityPending && <div><span>身份待确认</span></div>}
  </div>;
}

const SYNC_WARNINGS: Record<AvaCalendarSync["state"], string> = {
  fresh: "", stale: "课表已过旧（90 分钟），绿色 AVA 仅扣除最后同步的课程。", sync_failed: "课表同步失败，当前使用最后成功快照。", unknown: "课表同步状态暂不可确认。",
};
function syncWarning(sync: AvaCalendarSync | undefined, unavailable: boolean) {
  if (unavailable) return "课表暂不可用，已隐藏绿色 AVA。";
  return sync ? SYNC_WARNINGS[sync.state] : "";
}
function syncTime(sync: AvaCalendarSync | undefined, zone: string) {
  return sync?.lastSuccessAt ? DateTime.fromISO(sync.lastSuccessAt).setZone(zone).toFormat("yyyy-MM-dd HH:mm ZZ") : "未知";
}
function SyncStatus({ sync, zone, unavailable }: { sync: AvaCalendarSync | undefined; zone: string; unavailable: boolean }) {
  if (!sync && !unavailable) return null;
  const warning = syncWarning(sync, unavailable);
  const attributes = warning ? { role: "alert", className: styles.syncWarning } : { role: "status", className: styles.status };
  return <p {...attributes}>{warning}最后成功同步：{syncTime(sync, zone)}</p>;
}
function globalCalendarView(data: AvaCalendarLiveData | null, teacher: string, view: string) { return !teacher && view === "timeGridDay" && (data?.teachers.length ?? 0) > 1; }
function surfaceColumns(data: AvaCalendarLiveData | null, teacher: string, global: boolean, range: AvaCalendarLiveWindow | null, activeOnly: boolean, selfId = "") {
  if (global) {
    const active = calendarTeacherColumns(data, range, activeOnly, selfId);
    return JSON.stringify(active.length ? active : [{ id: "", name: "" }]);
  }
  const scoped = teacher || (data?.teachers.length === 1 ? data.teachers[0]!.id : !data ? selfId : "");
  return JSON.stringify([{ id: scoped, name: "" }]);
}

type PendingCalendarPoint = { start: number; instance: Pick<Calendar, "select" | "unselect"> } | null;
function completesCalendarPoint(first: PendingCalendarPoint, current: Pick<Calendar, "select" | "unselect">, date: Date) {
  if (!first) return false;
  const duration = date.valueOf() - first.start;
  return first.instance === current && duration >= 900000 && duration < 86400000;
}
function initialCalendarView() { return "timeGridDay"; }
function nextCalendarRange(prior: AvaCalendarLiveWindow | null, next: AvaCalendarLiveWindow) { return prior && prior.start === next.start && prior.end === next.end ? prior : next; }

type SurfaceProps = { data: AvaCalendarLiveData | null; loading: boolean; teacher: string; zone: string; view: string; range: AvaCalendarLiveWindow | null; activeOnly: boolean; selfId?: string; calendarsRef: CalendarRefs; datesSet: (info: DatesSetArg) => void; openLesson: (lesson: AvaCalendarEvent) => void; openDraft: (draft: AvailabilityDraft) => void; resetKey: number };
type MountedCalendarOptions = Pick<SurfaceProps, "zone" | "view" | "selfId" | "calendarsRef" | "datesSet" | "openLesson" | "openDraft"> & { hostRef: RefObject<HTMLDivElement | null>; anchorRef: RefObject<string | undefined>; pendingRef: RefObject<PendingCalendarPoint>; scrollRef: RefObject<{ top: number; left: number }>; columns: string; first: number; end: number; totalColumns: number; columnWidth: number; global: boolean };
function useMountedCalendars({ hostRef, anchorRef, pendingRef, scrollRef, columns, first, end, totalColumns, columnWidth, global, zone, view, selfId, calendarsRef, datesSet, openLesson, openDraft }: MountedCalendarOptions) {
  const settings = useRef({ zone, view });
  useEffect(() => { settings.current = { zone, view }; }, [zone, view]);
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    pendingRef.current = null; element.removeAttribute("data-first-point");
    const teachers: { id: string; name: string }[] = JSON.parse(columns);
    const instances: Calendar[] = [];
    const lifecycle = calendarLifecycle();
    appendCalendarSpacer(element, first * columnWidth);
    function draw(start: Date, end: Date) {
      pendingRef.current = null; element!.removeAttribute("data-first-point");
      openDraft({ commandKey: crypto.randomUUID(), startsAt: start.toISOString(), endsAt: end.toISOString() });
    }
    teachers.forEach((item, index) => {
      const wrapper = node("div", styles.teacherColumn); wrapper.dataset.teacher = item.id; wrapper.dataset.writable = String(item.id === selfId);
      sizeTeacherColumn(wrapper, columnWidth, global);
      const grid = node("div", styles.calendar); wrapper.append(grid); element.append(wrapper);
      const instance = createCalendar(grid, { ...settings.current, date: anchorRef.current, writable: !!item.id && item.id === selfId }, lifecycle.guard((info: DatesSetArg) => {
        pendingRef.current = null; element.removeAttribute("data-first-point");
        if (index === 0) { anchorRef.current = calendarAnchorDate(info); datesSet(info); }
      }), lifecycle.guard(openLesson), { select: lifecycle.guard(draw), point: lifecycle.guard((date: Date, current: Pick<Calendar, "select" | "unselect">) => {
        const first = pendingRef.current;
        instances.forEach((calendar) => calendar.unselect());
        if (completesCalendarPoint(first, current, date)) {
          current.select(new Date(first!.start), date); draw(new Date(first!.start), date);
        } else {
          pendingRef.current = { start: date.valueOf(), instance: current };
          current.select(date, new Date(date.valueOf() + 900000)); element.dataset.firstPoint = date.toISOString();
        }
      }) });
      if (global) instance.setOption("dayHeaderContent", () => item.name);
      instances.push(instance); instance.render();
    });
    appendCalendarSpacer(element, (totalColumns - end) * columnWidth);
    calendarsRef.current = instances;
    restoreCalendarScroll(element, scrollRef.current);
    const scrollers = calendarScrollers(element);
    scrollers.forEach((scroller) => scroller.addEventListener("scroll", () => { scrollers.forEach((other) => { if (Math.abs(other.scrollTop - scroller.scrollTop) > 1) other.scrollTop = scroller.scrollTop; }); }, { passive: true }));
    const observer = new ResizeObserver(() => { element.dataset.scrollable = String(element.scrollWidth > element.parentElement!.clientWidth + 1); });
    observer.observe(element.parentElement!);
    return () => { lifecycle.dispose(); scrollRef.current = readCalendarScroll(element, scrollRef.current); observer.disconnect(); instances.forEach((instance) => instance.destroy()); calendarsRef.current = []; element.replaceChildren(); };
  }, [hostRef, anchorRef, pendingRef, scrollRef, columns, first, end, totalColumns, columnWidth, global, selfId, calendarsRef, datesSet, openLesson, openDraft]);
  useEffect(() => { calendarsRef.current.forEach((instance) => updateCalendarDisplay(instance, zone, view, anchorRef.current)); }, [zone, view, columns, first, end, totalColumns, columnWidth, global, selfId, calendarsRef, anchorRef]);
}

function updateCalendarDisplay(instance: Calendar, zone: string, view: string, date: string | undefined) {
  if (instance.getOption("timeZone") === zone && instance.view.type === view) return;
  instance.batchRendering(() => {
    instance.setOption("timeZone", zone);
    if (instance.view.type !== view) instance.changeView(view, date);
    else if (date) instance.gotoDate(date);
  });
}

function revealInitialLesson(host: HTMLElement) {
  const navigation = document.querySelector(".mobile-bottom-nav")?.getBoundingClientRect();
  if (!navigation?.height) return;
  const viewport = host.parentElement!.getBoundingClientRect();
  const lesson = [...host.querySelectorAll<HTMLElement>(".fc-timegrid-event[data-event-id]")].find((element) => {
    const box = element.getBoundingClientRect();
    const scroller = element.closest(".fc-scroller")!.getBoundingClientRect();
    return box.left < viewport.right && box.right > viewport.left && box.top < scroller.bottom && box.bottom > scroller.top;
  });
  if (!lesson) return;
  const name = lesson.querySelector("strong")!.getBoundingClientRect();
  const delta = name.bottom - Math.min(innerHeight, navigation.top);
  if (delta > 0) window.scrollBy(0, delta + 8);
}

function calendarPopoverBounds(container: HTMLElement) {
  const viewport = window.visualViewport ?? { offsetTop: 0, offsetLeft: 0, height: window.innerHeight, width: window.innerWidth };
  const bounds = container.getBoundingClientRect();
  return {
    top: Math.max(bounds.top, viewport.offsetTop) + 8,
    bottom: Math.min(bounds.bottom, viewport.offsetTop + viewport.height) - 8,
    left: Math.max(bounds.left, viewport.offsetLeft) + 8,
    right: Math.min(bounds.right, viewport.offsetLeft + viewport.width) - 8,
  };
}

function fitCalendarPopover(host: HTMLElement) {
  const popover = host.querySelector<HTMLElement>(".fc-more-popover");
  const body = popover?.querySelector<HTMLElement>(".fc-popover-body");
  const container = host.closest<HTMLElement>('[aria-label="日历滚动区域"]');
  if (!popover || !body || !container || !popover.offsetParent) return;
  const { top, bottom, left, right } = calendarPopoverBounds(container);
  popover.style.maxWidth = `${Math.max(0, right - left)}px`;
  body.style.maxHeight = `${Math.max(0, bottom - top - (popover.offsetHeight - body.offsetHeight))}px`;
  const rect = popover.getBoundingClientRect();
  const origin = popover.offsetParent.getBoundingClientRect();
  popover.style.top = `${Math.max(top, Math.min(rect.top, bottom - rect.height)) - origin.top}px`;
  popover.style.left = `${Math.max(left, Math.min(rect.left, right - rect.width)) - origin.left}px`;
}

function useCalendarPopover(host: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitCalendarPopover(element)); };
    const observer = new MutationObserver(schedule);
    observer.observe(element, { childList: true, subtree: true });
    const targets = [window, window.visualViewport].filter((target) => target !== null);
    targets.forEach((target) => { target.addEventListener("resize", schedule); target.addEventListener("scroll", schedule, true); });
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      targets.forEach((target) => { target.removeEventListener("resize", schedule); target.removeEventListener("scroll", schedule, true); });
    };
  }, [host]);
}

function useCalendarPosition(host: RefObject<HTMLDivElement | null>, key: string, order: string, width: number) {
  const scroll = useRef({ top: -1, left: 0 });
  const prior = useRef<CalendarColumnPosition | null>(null);
  useEffect(() => {
    const next = { key, columns: JSON.parse(order) as string[], width };
    if (prior.current?.key !== key) scroll.current.top = -1;
    scroll.current.left = calendarColumnScrollLeft(prior.current, next, scroll.current.left);
    prior.current = next;
    if (host.current) restoreCalendarScroll(host.current, scroll.current);
  }, [host, key, order, width]);
  return scroll;
}

function CalendarSurface({ state, controls, resetKey }: { state: Pick<SurfaceProps, "data" | "loading" | "teacher" | "zone" | "view" | "selfId" | "range" | "activeOnly">; controls: Pick<SurfaceProps, "calendarsRef" | "datesSet" | "openLesson" | "openDraft">; resetKey: number }) {
  const { data, loading, teacher, zone, view, selfId, range, activeOnly } = state;
  const { calendarsRef, datesSet, openLesson, openDraft } = controls;
  const host = useRef<HTMLDivElement>(null);
  useCalendarPopover(host);
  const anchor = useRef<string | undefined>(undefined);
  const pending = useRef<{ start: number; instance: Pick<Calendar, "select" | "unselect"> } | null>(null);
  const global = globalCalendarView(data, teacher, view);
  const allColumns: { id: string; name: string }[] = JSON.parse(surfaceColumns(data, teacher, global, range, activeOnly, selfId));
  const totalColumns = allColumns.length;
  const { first, end, columnWidth, totalWidth } = useCalendarColumnWindow(host, totalColumns);
  const layoutWidth = global ? columnWidth : 0;
  const columns = JSON.stringify(allColumns.slice(first, end));
  const order = JSON.stringify(allColumns.map(({ id }) => id));
  const positionKey = JSON.stringify([range?.start, range?.end, zone, teacher, view]);
  const scrollPositionRef = useCalendarPosition(host, positionKey, order, layoutWidth);
  const initialized = useRef("");
  useMountedCalendars({ hostRef: host, anchorRef: anchor, pendingRef: pending, scrollRef: scrollPositionRef, columns, first, end, totalColumns, columnWidth: layoutWidth, global, zone, view, selfId, calendarsRef, datesSet, openLesson, openDraft });
  useEffect(() => {
    calendarsRef.current.forEach((instance, index) => {
      const scoped = (JSON.parse(columns) as { id: string }[])[index]!.id;
      instance.batchRendering(() => { instance.getEventSources().forEach((source) => source.remove()); instance.addEventSource(lessonInputs(loading ? null : data, scoped)); });
    });
  }, [data, loading, columns, order, positionKey, first, end, totalColumns, layoutWidth, global, zone, view, selfId, calendarsRef]);
  useEffect(() => {
    if (!data || loading || !range || initialized.current === positionKey) return;
    initialized.current = positionKey;
    const time = calendarInitialScrollTime(data, range, zone, teacher);
    if (global) host.current!.parentElement!.scrollLeft = 0;
    calendarsRef.current.forEach((instance) => instance.scrollToTime(time));
    revealInitialLesson(host.current!);
    scrollPositionRef.current = readCalendarScroll(host.current!, scrollPositionRef.current);
  }, [data, loading, range, zone, teacher, positionKey, columns, layoutWidth, global, calendarsRef, scrollPositionRef]);
  useEffect(() => { pending.current = null; host.current?.removeAttribute("data-first-point"); calendarsRef.current.forEach((instance) => instance.unselect()); }, [resetKey, calendarsRef]);
  return <div ref={host} className={global ? styles.globalCalendar : styles.singleCalendar} style={global ? { width: totalWidth } : undefined} data-first-column={first} />;
}

function browserCalendarZone() { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Melbourne"; }
function calendarAnchorDate(info: DatesSetArg) { return DateTime.fromJSDate(info.view.calendar.getDate(), { zone: info.timeZone }).toISODate() || ""; }
function closeHiddenLesson(dialogRef: RefObject<HTMLDialogElement | null>, data: AvaCalendarLiveData | null, loading: boolean) { if (loading || !data) dialogRef.current?.close(); }
function loadedAvailabilityMessage(data: AvaCalendarLiveData | null, loading: boolean, teacher: string) { return loading ? "" : availabilityMessage(data, teacher); }
function LessonDialog({ dialogRef, selected, zone }: { dialogRef: RefObject<HTMLDialogElement | null>; selected: AvaCalendarEvent | undefined; zone: string }) {
  return <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="live-detail-title">
    <header className={styles.dialogHeader}><h2 id="live-detail-title">{selected?.trial ? "试听课" : "课程详情"}</h2><button type="button" className={styles.iconButton} aria-label="关闭课程详情" onClick={() => dialogRef.current?.close()}>×</button></header>
    <DetailContent selected={selected} zone={zone} />
  </dialog>;
}
function calendarSwitches(close: () => void, hideManager: (value: boolean) => void, setters: { setZone: (value: string) => void; setTeacher: (value: string) => void; setView: (value: string) => void }) {
  return {
    switchZone: (next: string) => { close(); hideManager(false); setters.setZone(next); },
    switchTeacher: (next: string) => { close(); hideManager(false); setters.setTeacher(next); },
    switchView: (next: string) => { close(); hideManager(false); setters.setView(next); },
  };
}
function useCalendarViewState() {
  const [zone, setZone] = useState(browserCalendarZone);
  const [view, setView] = useState(initialCalendarView);
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  const [teacher, setTeacher] = useState("");
  return { zone, setZone, view, setView, date, setDate, title, setTitle, teacher, setTeacher };
}
function useLiveCalendarPage() {
  const { zone, setZone, view, setView, date, setDate, title, setTitle, teacher, setTeacher } = useCalendarViewState();
  const [range, setRange] = useState<AvaCalendarLiveWindow | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<AvailabilityDraft | null>(null);
  const [manager, setManager] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const calendarsRef = useRef<Calendar[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const self = useTeacherSelfAvailability(range?.start);
  const clearSelf = self.clear;
  const clearPrivateSelection = useCallback(() => { setTeacher(""); setSelectedId(""); setDraft(null); setManager(false); clearSelf(); }, [clearSelf, setTeacher]);
  const { data, dataRange, loading, failure, refreshCalendar, invalidateCalendar, sync } = useLiveData(range, clearPrivateSelection);
  const selected = selectedLesson(data, loading, selectedId);
  const global = globalCalendarView(data, teacher, view);
  const datesSet = useCallback((info: DatesSetArg) => {
    setDate(calendarAnchorDate(info));
    setTitle(info.view.title);
    setResetKey((value) => value + 1);
    const next = { start: info.start.toISOString(), end: info.end.toISOString() };
    setRange((prior) => nextCalendarRange(prior, next));
  }, [setDate, setTitle]);
  const openLesson = useCallback((lesson: AvaCalendarEvent) => { setResetKey((value) => value + 1); setSelectedId(lesson.eventId); dialog.current?.showModal(); }, []);
  const openDraft = useCallback((next: AvailabilityDraft) => { setManager(false); setDraft(next); }, []);
  const closeDraft = () => { setDraft(null); setResetKey((value) => value + 1); };
  const refresh = () => { refreshCalendar(); void self.reload(); };
  useEffect(() => { closeHiddenLesson(dialog, data, loading); }, [data, loading]);
  const { switchZone, switchTeacher, switchView } = calendarSwitches(closeDraft, setManager, { setZone, setTeacher, setView });
  return { zone, view, date, title, teacher, range, draft, manager, setManager, setResetKey, resetKey, calendarsRef, dialog, data, dataRange, loading, failure, refreshCalendar, invalidateCalendar, sync, self, selected, global, datesSet, openLesson, openDraft, closeDraft, refresh, switchZone, switchTeacher, switchView };
}
export default function AvaCalendarLiveClient() {
  const [activeOnly, setActiveOnly] = useState(true);
  const { zone, view, date, title, teacher, range, draft, manager, setManager, setResetKey, resetKey, calendarsRef, dialog, data, dataRange, loading, failure, invalidateCalendar, sync, self, selected, global, datesSet, openLesson, openDraft, closeDraft, refresh, switchZone, switchTeacher, switchView } = useLiveCalendarPage();
  return <div className={styles.page}>
    <section className={`panel ${styles.stage}`} aria-label="老师课程日历">
      <div className={styles.toolbar}>
        <div className={styles.navigationRow}><h2 className={styles.rangeTitle} aria-live="polite">{title}</h2><DateNavigation calendarsRef={calendarsRef} date={date} /></div>
        <div className={styles.filterRow}><CalendarControls data={data} teacher={teacher} setTeacher={switchTeacher} zone={zone} setZone={switchZone} view={view} setView={switchView} global={global} activeOnly={activeOnly} setActiveOnly={setActiveOnly} loading={loading} refreshCalendar={refresh} /><SelfAvailabilityButton available={!!self.data} open={() => { setResetKey((value) => value + 1); setManager(true); }} /></div>
      </div>
      <div className={styles.legend} aria-label="日历图例"><span><i className={styles.freeSwatch} />AVA</span><span className={styles.trialTag}>试听</span>{TRIAL_OPERATIONS.map((owner, index) => <span key={owner}><i className={styles.swatch} data-owner-color={`owner-${index + 1}`} />{owner}</span>)}</div>
      <ReadStatus loading={loading} failure={failure} message={loadedAvailabilityMessage(data, loading, teacher)} />
      <SyncStatus sync={sync} zone={zone} unavailable={synchronizationFailure(failure)} />
      <FailureStatus failure={self.failure} />
      <div className={styles.viewport} aria-label="日历滚动区域"><CalendarSurface state={{ data, loading: loading || dataRange !== range, teacher, zone, view, range, activeOnly, selfId: self.data?.teacherId }} controls={{ calendarsRef, datesSet, openLesson, openDraft }} resetKey={resetKey} /></div>
    </section>
    <LessonDialog dialogRef={dialog} selected={selected} zone={zone} />
    <SelfAvailabilityDialogs data={self.data} manager={manager} draft={draft} range={range} zone={zone} edit={openDraft} closeManager={() => setManager(false)} closeDraft={closeDraft} save={self.save} saved={invalidateCalendar} />
  </div>;
}

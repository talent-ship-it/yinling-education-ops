"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Calendar, type DatesSetArg, type EventContentArg, type EventInput, type EventMountArg } from "@fullcalendar/core";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import luxonPlugin from "@fullcalendar/luxon3";
import { DateTime } from "luxon";
import type { AvaCalendarEvent } from "@/lib/ava-calendar-projection";
import { fetchAvaCalendarWindow, type AvaCalendarLiveData, type AvaCalendarLiveWindow } from "@/lib/ava-calendar-live-client";
import { TRIAL_OPERATIONS } from "@/lib/lp-workflows";
import styles from "./calendar.module.css";
import { useAvaCalendarVisibleRefresh } from "@/lib/ava-calendar-visible-refresh";

const ZONES: Record<string, string> = { "Australia/Melbourne": "墨尔本", "Australia/Sydney": "悉尼", "Australia/Brisbane": "布里斯班", "Australia/Adelaide": "阿德莱德", "Australia/Perth": "珀斯", "Pacific/Auckland": "奥克兰", "Asia/Shanghai": "中国", "Asia/Hong_Kong": "香港", "Asia/Singapore": "新加坡", "Europe/London": "伦敦", "America/New_York": "纽约", UTC: "UTC" };

function readFailure(error: unknown) {
  return error instanceof Error && error.name !== "AbortError" ? error.message : "读取超时，请重试。";
}


function accessLost(failure: string) {
  return failure.startsWith("登录已失效") || failure.startsWith("当前账号无权");
}

function useLiveData(window: AvaCalendarLiveWindow | null, onAccessLost: () => void) {
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<AvaCalendarLiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const busy = useRef(true);
  const refreshCalendar = useCallback(() => {
    if (busy.current) return;
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
      if (accessLost(message)) onAccessLost();
    }
    async function read() {
      busy.current = true;
      setData(null); setLoading(true); setFailure("");
      try {
        const next = await fetchAvaCalendarWindow(window!, abort.signal);
        if (mounted) setData(next);
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
  return { data, loading, failure, refreshCalendar };
}

function node(tag: string, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function studentNameNode(student: AvaCalendarEvent["students"][number]) {
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
  for (const student of lesson.students) names.append(studentNameNode(student));
  if (!lesson.students.length) {
    const name = node("span", styles.studentName, "学生待确认");
    name.dataset.ownerColor = "owner-unassigned"; names.append(name);
  }
  return names;
}

function lessonOwnerNames(lesson: AvaCalendarEvent) {
  return [...new Set(lesson.students.map((student) => student.owner || "教务待分配"))].join(" / ");
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
    const colors = new Set(lesson.students.map((student) => student.color));
    return { id: lesson.eventId, start: lesson.startsAt, end: lesson.endsAt, title: lesson.students.map((student) => student.studentName).join("、") || "学生待确认", classNames: [styles.lesson, ...(Date.parse(lesson.endsAt) - Date.parse(lesson.startsAt) < 3600000 ? [styles.compact] : [])], extendedProps: { lesson, ownerColor: colors.size === 1 ? [...colors][0] : "owner-unassigned" } };
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

function createCalendar(host: HTMLElement, initial: { zone: string; view: string }, datesSet: (info: DatesSetArg) => void, openLesson: (lesson: AvaCalendarEvent) => void) {
  return new Calendar(host, {
    plugins: [timeGridPlugin, dayGridPlugin, interactionPlugin, luxonPlugin], locale: zhCnLocale,
    initialView: initial.view, timeZone: initial.zone, firstDay: 1, headerToolbar: false,
    allDaySlot: false, height: 720, selectable: false, editable: false, eventStartEditable: false, eventDurationEditable: false,
    views: { timeGridThreeDay: { type: "timeGrid", duration: { days: 3 } } },
    slotDuration: "00:30:00", slotMinTime: "00:00:00", slotMaxTime: "24:00:00", scrollTime: "13:00:00", scrollTimeReset: false,
    nowIndicator: true, eventMinHeight: 0, eventShortHeight: 34,
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    dayHeaderFormat: { month: "2-digit", day: "2-digit", weekday: "short" }, eventContent: renderLesson, datesSet,
    eventDidMount: (info) => mountLesson(info, openLesson),
    eventClick(info) { const lesson = info.event.extendedProps.lesson as AvaCalendarEvent | undefined; if (lesson) openLesson(lesson); },
  });
}

type CalendarRef = RefObject<Calendar | null>;
function DateNavigation({ calendar, date }: { calendar: CalendarRef; date: string }) {
  return <div className={styles.navigation}>
    <button type="button" className={styles.iconButton} aria-label="上一页" onClick={() => calendar.current?.prev()}>‹</button>
    <button type="button" className={styles.iconButton} aria-label="下一页" onClick={() => calendar.current?.next()}>›</button>
    <button type="button" onClick={() => calendar.current?.today()}>今天</button>
    <input type="date" aria-label="日期" value={date} onChange={(event) => { if (event.target.value) calendar.current?.gotoDate(event.target.value); }} />
  </div>;
}

function TeacherFilter({ data, teacher, setTeacher }: { data: AvaCalendarLiveData | null; teacher: string; setTeacher: (value: string) => void }) {
  return <select aria-label="老师" value={teacher} onChange={(event) => setTeacher(event.target.value)}><option value="">全部老师</option>{teacher && !data?.teachers.some((item) => item.id === teacher) && <option value={teacher}>已选老师</option>}{data?.teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;
}

type ControlsProps = { calendar: CalendarRef; data: AvaCalendarLiveData | null; teacher: string; setTeacher: (value: string) => void; zone: string; setZone: (value: string) => void; view: string; loading: boolean; refreshCalendar: () => void };
function CalendarControls({ calendar, data, teacher, setTeacher, zone, setZone, view, loading, refreshCalendar }: ControlsProps) {
  return <div className={styles.controls}>
    <TeacherFilter data={data} teacher={teacher} setTeacher={setTeacher} />
    <select aria-label="显示时区" value={zone} onChange={(event) => { setZone(event.target.value); calendar.current?.setOption("timeZone", event.target.value); }}>{[...new Set([zone, ...Object.keys(ZONES)])].map((value) => <option key={value} value={value}>{ZONES[value] || value}</option>)}</select>
    <select aria-label="日历视图" value={view} onChange={(event) => calendar.current?.changeView(event.target.value)}><option value="timeGridDay">日</option><option value="timeGridThreeDay">3 天</option><option value="timeGridWeek">周</option><option value="dayGridMonth">月</option></select>
    <button type="button" disabled={loading} onClick={refreshCalendar}>刷新</button>
  </div>;
}

function ReadStatus({ loading, failure }: { loading: boolean; failure: string }) {
  return <>{loading && <p role="status" className={styles.status}>正在读取…</p>}{failure && <p role="alert" className={styles.status}>{failure}{failure.startsWith("登录已失效") && <> <a href="/ava-calendar/live">重新登录</a></>}</p>}</>;
}

function detailTime(event: AvaCalendarEvent, zone: string) {
  const start = DateTime.fromISO(event.startsAt).setZone(zone);
  const end = DateTime.fromISO(event.endsAt).setZone(zone);
  return `${start.toFormat("yyyy-MM-dd HH:mm")} – ${end.toFormat(start.toISODate() === end.toISODate() ? "HH:mm" : "yyyy-MM-dd HH:mm")}`;
}

function DetailStudents({ students }: { students: AvaCalendarEvent["students"] }) {
  return students.length ? students.map((student) => <div key={student.studentId}><span>{student.owner || "教务待分配"}</span><strong data-owner-color={student.color}>{student.studentName || "学生待确认"}</strong></div>) : <div><strong data-owner-color="owner-unassigned">学生待确认</strong></div>;
}

function DetailContent({ selected, zone }: { selected: AvaCalendarEvent | undefined; zone: string }) {
  if (!selected) return null;
  return <div className={styles.detailContent}>
    <div><span>老师</span><strong>{lessonTeacherName(selected)}</strong></div>
    <div><span>时间 · {ZONES[zone] || zone}</span><strong>{detailTime(selected, zone)}</strong></div>
    <div><span>时长</span><strong>{(Date.parse(selected.endsAt) - Date.parse(selected.startsAt)) / 60000} 分钟</strong></div>
    <DetailStudents students={selected.students} />
    {selected.identityPending && <div><span>身份待确认</span></div>}
  </div>;
}

export default function AvaCalendarLiveClient() {
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Melbourne");
  const [view, setView] = useState(() => typeof window !== "undefined" && window.innerWidth < 700 ? "timeGridDay" : "timeGridWeek");
  const [date, setDate] = useState("");
  const [teacher, setTeacher] = useState("");
  const [range, setRange] = useState<AvaCalendarLiveWindow | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const calendar = useRef<Calendar | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef({ zone, view });
  const clearPrivateSelection = useCallback(() => { setTeacher(""); setSelectedId(""); }, []);
  const { data, loading, failure, refreshCalendar } = useLiveData(range, clearPrivateSelection);
  const selected = data?.events.find((event) => event.eventId === selectedId);
  useEffect(() => {
    if (!host.current) return;
    const instance = createCalendar(host.current, initial.current, (info) => {
      setView(info.view.type);
      setDate(DateTime.fromJSDate(info.view.calendar.getDate(), { zone: info.timeZone }).toISODate() || "");
      const next = { start: info.start.toISOString(), end: info.end.toISOString() };
      setRange((prior) => prior?.start === next.start && prior.end === next.end ? prior : next);
    }, (lesson) => { setSelectedId(lesson.eventId); dialog.current?.showModal(); });
    calendar.current = instance; instance.render();
    return () => { instance.destroy(); calendar.current = null; };
  }, []);
  useEffect(() => {
    const instance = calendar.current;
    if (!instance) return;
    if (!data) dialog.current?.close();
    instance.batchRendering(() => { instance.getEventSources().forEach((source) => source.remove()); instance.addEventSource(lessonInputs(data, teacher)); });
  }, [data, teacher]);
  return <main className={styles.page}>
    <header className={styles.brandBar}><Link className={styles.brand} href="/" aria-label="工作台"><span className={styles.brandMark}>IL</span><h1>AVA</h1></Link></header>
    <section className={styles.stage} aria-label="老师课程日历">
      <div className={styles.toolbar}><DateNavigation calendar={calendar} date={date} /><CalendarControls calendar={calendar} data={data} teacher={teacher} setTeacher={setTeacher} zone={zone} setZone={setZone} view={view} loading={loading} refreshCalendar={refreshCalendar} /></div>
      <div className={styles.legend} aria-label="日历图例"><span><i className={styles.freeSwatch} />AVA</span><span className={styles.trialTag}>试听</span>{TRIAL_OPERATIONS.map((owner, index) => <span key={owner}><i className={styles.swatch} data-owner-color={`owner-${index + 1}`} />{owner}</span>)}</div>
      <ReadStatus loading={loading} failure={failure} />
      <div className={styles.viewport} aria-label="日历滚动区域"><div ref={host} className={styles.calendar} /></div>
    </section>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="live-detail-title">
      <header className={styles.dialogHeader}><h2 id="live-detail-title">{selected?.trial ? "试听课" : "课程详情"}</h2><button type="button" className={styles.iconButton} aria-label="关闭课程详情" onClick={() => dialog.current?.close()}>×</button></header>
      <DetailContent selected={selected} zone={zone} />
    </dialog>
  </main>;
}

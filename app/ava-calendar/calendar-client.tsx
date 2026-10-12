"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import type { AvaCalendarEvent, AvaCalendarProjection } from "@/lib/ava-calendar-projection";
import styles from "./calendar.module.css";
import { useAvaCalendarVisibleRefresh } from "@/lib/ava-calendar-visible-refresh";

type CalendarData = AvaCalendarProjection & { source: { revision: string; publishedAt: string; freshness: "fresh" | "stale"; coverage: "complete" | "partial" } };
type CalendarResponse = CalendarData & { error?: string };
const TIMEZONES = ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Pacific/Auckland", "Asia/Shanghai", "Asia/Singapore", "Europe/London", "UTC"];
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function browserZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Melbourne";
}

function localDate(value: Date, zone: string) {
  const fields = new Intl.DateTimeFormat("en-AU", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return ["year", "month", "day"].map((field) => fields.find((part) => part.type === field)!.value).join("-");
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function thisWeek(zone: string) {
  const today = localDate(new Date(), zone);
  return addDays(today, -((new Date(`${today}T12:00:00.000Z`).getUTCDay() + 6) % 7));
}

function timeInZone(value: string, zone: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function lessonWindow(event: AvaCalendarEvent, day: string, zone: string) {
  const start = localDate(new Date(event.startsAt), zone) < day ? "00:00" : timeInZone(event.startsAt, zone);
  const end = localDate(new Date(event.endsAt), zone) > day ? "24:00" : timeInZone(event.endsAt, zone);
  return `${start}–${end}`;
}

function responseFailure(status: number, error?: string) {
  return status === 401 ? "登录已失效，请重新登录。" : error || "课表暂时无法读取。";
}

function validateCalendarData(body: CalendarResponse) {
  if (!Array.isArray(body.events) || !Array.isArray(body.teachers) || !body.source) throw new Error("课表暂时无法读取。");
  return body;
}

async function fetchCalendar(week: string, signal: AbortSignal) {
  const query = new URLSearchParams({ start: `${addDays(week, -1)}T00:00:00.000Z`, end: `${addDays(week, 8)}T00:00:00.000Z` });
  const response = await fetch(`/api/ava-calendar?${query}`, { cache: "no-store", credentials: "same-origin", signal });
  const body = await response.json() as CalendarResponse;
  if (!response.ok) throw new Error(responseFailure(response.status, body.error));
  return validateCalendarData(body);
}

function readFailure(error: unknown) {
  return error instanceof Error && error.name !== "AbortError" ? error.message : "读取超时，请重试。";
}


function useCalendarData(week: string) {
  const [refresh, setRefresh] = useState(0);
  const [calendar, setCalendar] = useState<CalendarData | null>(null);
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(true);
  const refreshCalendar = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    const abort = new AbortController();
    let mounted = true;
    const timer = setTimeout(() => abort.abort(), 50000);
    async function read() {
      setCalendar(null);
      setFailure("");
      setLoading(true);
      let nextCalendar: CalendarData | null = null;
      let nextFailure = "";
      try {
        nextCalendar = await fetchCalendar(week, abort.signal);
      } catch (error) {
        nextFailure = readFailure(error);
      } finally {
        clearTimeout(timer);
      }
      if (!mounted) return;
      setCalendar(nextCalendar);
      setFailure(nextFailure);
      setLoading(false);
    }
    void read();
    return () => { mounted = false; clearTimeout(timer); abort.abort(); };
  }, [week, refresh]);

  useAvaCalendarVisibleRefresh(loading, refreshCalendar);
  return { calendar, failure, loading, refreshCalendar };
}

function initialScrollLeft(element: HTMLDivElement, week: string, zone: string) {
  const today = localDate(new Date(), zone);
  const index = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${week}T00:00:00Z`)) / 86400000);
  return (index >= 0 && index < 7 ? index : 0) * element.scrollWidth / 7;
}

function useCalendarScroll(calendar: CalendarData | null, week: string, zone: string) {
  const scroll = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef({ week: "", left: 0 });
  useEffect(() => {
    if (!calendar || !scroll.current) return;
    scroll.current.scrollLeft = scrollPosition.current.week === week ? scrollPosition.current.left : initialScrollLeft(scroll.current, week, zone);
    scrollPosition.current = { week, left: scroll.current.scrollLeft };
  }, [calendar, week, zone]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    scrollPosition.current = { week, left: event.currentTarget.scrollLeft };
  };
  return { scroll, onScroll };
}

function selectedCalendarTeacher(calendar: CalendarData | null, teacher: string) {
  return calendar?.teachers.some((item) => item.id === teacher) ? teacher : "";
}

function WeekNavigation({ week, zone, setWeek }: { week: string; zone: string; setWeek: (value: string) => void }) {
  return <div className={styles.navigation}>
    <button type="button" aria-label="上一周" onClick={() => setWeek(addDays(week, -7))}>‹</button>
    <button type="button" onClick={() => setWeek(thisWeek(zone))}>本周</button>
    <button type="button" aria-label="下一周" onClick={() => setWeek(addDays(week, 7))}>›</button>
    <strong>{week.slice(5)} — {addDays(week, 6).slice(5)}</strong>
  </div>;
}

function TeacherFilter({ calendar, teacher, setTeacher }: { calendar: CalendarData | null; teacher: string; setTeacher: (value: string) => void }) {
  if (!calendar || calendar.teachers.length <= 1) return null;
  return <label>老师<select value={teacher} onChange={(event) => setTeacher(event.target.value)}><option value="">全部老师</option>{calendar.teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>;
}

type CalendarFiltersProps = {
  calendar: CalendarData | null;
  teacher: string;
  setTeacher: (value: string) => void;
  zone: string;
  setZone: (value: string) => void;
  loading: boolean;
  refreshCalendar: () => void;
};

function CalendarFilters({ calendar, teacher, setTeacher, zone, setZone, loading, refreshCalendar }: CalendarFiltersProps) {
  return <div className={styles.filters}>
    <TeacherFilter calendar={calendar} teacher={teacher} setTeacher={setTeacher} />
    <label>时区<select value={zone} onChange={(event) => setZone(event.target.value)}>{[...new Set([zone, ...TIMEZONES])].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <button type="button" disabled={loading} onClick={refreshCalendar}>刷新</button>
  </div>;
}

function CalendarReadStatus({ loading, failure }: { loading: boolean; failure: string }) {
  return <>
    {loading && <p role="status" className={styles.status}>正在读取…</p>}
    {failure && <p role="alert" className={styles.status}>{failure}{failure.startsWith("登录已失效") && <> <a href="/ava-calendar">重新登录</a></>}</p>}
  </>;
}

function CalendarSourceStatus({ source }: { source: CalendarData["source"] }) {
  return (source.freshness !== "fresh" || source.coverage !== "complete") && <p role="status" className={styles.status}>{source.freshness !== "fresh" ? "课表来源已过期。" : "部分日期超出课表来源范围。"}</p>;
}

function LessonStudents({ students }: { students: AvaCalendarEvent["students"] }) {
  return students.length ? students.map((student) => <div key={student.studentId} className={styles.student} data-owner-color={student.color}><strong>{student.studentName}</strong><span>{student.owner || "教务待分配"}</span></div>) : <div className={styles.student} data-owner-color="owner-unassigned"><strong>学生待确认</strong></div>;
}

function LessonTeacher({ event }: { event: AvaCalendarEvent }) {
  return <>
    <span className={styles.teacher}>{event.teacherName || "老师待确认"}</span>
    {event.identityPending && event.students.length > 0 && <span className={styles.teacher}>身份待确认</span>}
  </>;
}

function CalendarLesson({ event, day, zone }: { event: AvaCalendarEvent; day: string; zone: string }) {
  return <article className={styles.lesson} data-event-id={event.eventId}>
    <div className={styles.lessonHeading}><time>{lessonWindow(event, day, zone)}</time>{event.trial && <b>试听</b>}</div>
    <LessonStudents students={event.students} />
    <LessonTeacher event={event} />
  </article>;
}

function lessonIsOnDay(event: AvaCalendarEvent, day: string, zone: string) {
  return localDate(new Date(event.startsAt), zone) <= day && localDate(new Date(new Date(event.endsAt).valueOf() - 1), zone) >= day;
}

function CalendarDay({ day, index, lessons, zone }: { day: string; index: number; lessons: AvaCalendarEvent[]; zone: string }) {
  return <section className={styles.day} aria-label={day}>
    <h2>{WEEKDAYS[index]} <span>{day.slice(5)}</span></h2>
    {lessons.filter((event) => lessonIsOnDay(event, day, zone)).map((event) => <CalendarLesson key={event.eventId} event={event} day={day} zone={zone} />)}
  </section>;
}

type CalendarWeekProps = {
  calendar: CalendarData;
  teacher: string;
  week: string;
  zone: string;
  scroll: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
};

function CalendarWeek({ calendar, teacher, week, zone, scroll, onScroll }: CalendarWeekProps) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const lessons = calendar.events.filter((event) => !teacher || event.teacherId === teacher);
  return <div ref={scroll} className={styles.scroll} aria-label="周日历" onScroll={onScroll}><div className={styles.week}>
    {days.map((day, index) => <CalendarDay key={day} day={day} index={index} lessons={lessons} zone={zone} />)}
  </div></div>;
}

export default function AvaCalendarClient() {
  const [zone, setZone] = useState(browserZone);
  const [week, setWeek] = useState(() => thisWeek(browserZone()));
  const [teacher, setTeacher] = useState("");
  const { calendar, failure, loading, refreshCalendar } = useCalendarData(week);
  const { scroll, onScroll } = useCalendarScroll(calendar, week, zone);
  const selectedTeacher = selectedCalendarTeacher(calendar, teacher);

  return <main className={styles.page}>
    <header className={styles.header}><h1>课程日历</h1><Link href="/">工作台</Link></header>
    <div className={styles.toolbar}>
      <WeekNavigation week={week} zone={zone} setWeek={setWeek} />
      <CalendarFilters calendar={calendar} teacher={selectedTeacher} setTeacher={setTeacher} zone={zone} setZone={setZone} loading={loading} refreshCalendar={refreshCalendar} />
    </div>
    <CalendarReadStatus loading={loading} failure={failure} />
    {calendar && <>
      <CalendarSourceStatus source={calendar.source} />
      <CalendarWeek calendar={calendar} teacher={selectedTeacher} week={week} zone={zone} scroll={scroll} onScroll={onScroll} />
    </>}
  </main>;
}

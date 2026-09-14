"use client";

import { dateTimeFormat } from "@/lib/date-time-format";


import React, { type CSSProperties, useMemo, useState } from "react";

import {
  buildScheduleMonth,
  stableStudentCalendarColor,
  type ScheduleCalendarOccurrence,
} from "@/lib/schedule-calendar";

export type ScheduleMonthLesson = ScheduleCalendarOccurrence & Readonly<{
  studentName: string;
  teacherName: string;
  courseLabel: string;
  displayTime: string;
}>;

export type ScheduleMonthAvailability = Readonly<{
  occurrenceId: string;
  date: string;
  displayTime: string;
}>;

type ScheduleMonthViewProps = Readonly<{
  month: string;
  displayTimezone: string;
  language: "zh-CN" | "en-AU";
  lessons: readonly ScheduleMonthLesson[];
  availability?: readonly ScheduleMonthAvailability[];
  availabilityTeacherName?: string;
  selectedOccurrenceId?: string;
  onSelect: (lesson: ScheduleMonthLesson) => void;
}>;

type StudentColorStyle = CSSProperties & {
  "--student-event-bg": string;
  "--student-event-border": string;
  "--student-event-ink": string;
};

export function ScheduleMonthView({
  month,
  displayTimezone,
  language,
  lessons,
  availability = [],
  availabilityTeacherName,
  selectedOccurrenceId,
  onSelect,
}: ScheduleMonthViewProps) {
  const days = useMemo(() => buildScheduleMonth(month, lessons, displayTimezone), [month, lessons, displayTimezone]);
  const [dayPages, setDayPages] = useState<Record<string, number>>({});
  const availabilityByDate = new Map<string, ScheduleMonthAvailability[]>();
  availability.forEach((entry) => {
    availabilityByDate.set(entry.date, [...(availabilityByDate.get(entry.date) ?? []), entry]);
  });
  const locale = language === "en-AU" ? "en-AU" : "zh-CN";
  const weekdays = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(Date.UTC(2026, 0, 5 + offset));
    return dateTimeFormat(locale, { weekday: language === "en-AU" ? "short" : "narrow", timeZone: "UTC" }).format(date);
  });

  return (
    <div className="month-board-scroll" data-month={month}>
      <div className="month-board" role="region" aria-label={language === "en-AU" ? `${month} month schedule` : `${month} 月课表`}>
        {weekdays.map((weekday, index) => <div className="month-weekday" aria-hidden="true" key={`${weekday}-${index}`}>{weekday}</div>)}
        {days.map((day) => {
          const pages = Math.max(1, Math.ceil(day.occurrences.length / 4));
          const page = Math.min(dayPages[day.date] ?? 1, pages);
          const visibleLessons = day.occurrences.slice((page - 1) * 4, page * 4);
          return <section
            className={`month-day ${day.inMonth ? "" : "outside-month"} ${availabilityTeacherName && !(availabilityByDate.get(day.date)?.length) ? "outside-availability" : ""}`}
            role="group"
            aria-label={day.date}
            key={day.date}
          >
            <header><time dateTime={day.date}>{Number(day.date.slice(-2))}</time><span>{day.occurrences.length || ""}</span></header>
            <div className="month-day-events">
              {(availabilityByDate.get(day.date) ?? []).map((entry) => (
                <div
                  className="month-availability"
                  title={`${availabilityTeacherName ?? "老师"} · ${entry.displayTime}`}
                  key={entry.occurrenceId}
                >
                  <time>{entry.displayTime}</time>
                  <span>{availabilityTeacherName ?? "可排"}</span>
                </div>
              ))}
              {visibleLessons.map((lesson) => {
                const color = stableStudentCalendarColor(lesson.studentId);
                const style: StudentColorStyle = {
                  "--student-event-bg": color.background,
                  "--student-event-border": color.border,
                  "--student-event-ink": color.ink,
                };
                return (
                  <button
                    className={`month-event ${selectedOccurrenceId === lesson.occurrenceId ? "selected" : ""}`}
                    style={style}
                    type="button"
                    aria-pressed={selectedOccurrenceId === lesson.occurrenceId}
                    title={`${lesson.displayTime} · ${lesson.studentName} · ${lesson.courseLabel}`}
                    key={lesson.occurrenceId}
                    onClick={() => onSelect(lesson)}
                  >
                    <time>{lesson.displayTime}</time>
                    <strong>{lesson.studentName}</strong>
                    <small>{lesson.courseLabel}</small>
                  </button>
                );
              })}
            </div>
            {pages > 1 ? <div className="month-day-pagination">
              <button type="button" aria-label={`${day.date} ${language === "en-AU" ? "previous lessons" : "上一组课程"}`} disabled={page === 1} onClick={() => setDayPages((current) => ({ ...current, [day.date]: page - 1 }))}>‹</button>
              <span>{page} / {pages}</span>
              <button type="button" aria-label={`${day.date} ${language === "en-AU" ? "next lessons" : "下一组课程"}`} disabled={page === pages} onClick={() => setDayPages((current) => ({ ...current, [day.date]: page + 1 }))}>›</button>
            </div> : null}
          </section>;
        })}
      </div>
    </div>
  );
}

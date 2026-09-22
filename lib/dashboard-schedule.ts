import { dateTimeFormat } from "./date-time-format";
import { cleanTimezone } from "./timezone";

export function dashboardDate(instant: Date, timezone: string) {
  const parts = dateTimeFormat("en-CA", {
    timeZone: cleanTimezone(timezone), year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const value = (name: string) => parts.find((part) => part.type === name)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function dashboardLessonsForDay<T>(
  lessons: readonly T[],
  instantFor: (lesson: T) => Date,
  timezone: string,
  day: string,
): T[] {
  return lessons.map((lesson) => ({ lesson, instant: instantFor(lesson) }))
    .filter(({ instant }) => dashboardDate(instant, timezone) === day)
    .sort((left, right) => left.instant.getTime() - right.instant.getTime())
    .map(({ lesson }) => lesson);
}

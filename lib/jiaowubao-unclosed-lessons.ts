import { DateTime } from "luxon";
import { melbourneHourDate } from "./monthly-hour-period";
import { resolveAssignableOperationsOwner } from "./demo-users";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import { isJiaowubaoSharedTrialAccountLabel, jiaowubaoTrialStudentNameFromCourseTitle } from "./trial-operations";
import type { OpsTask } from "./ops-tasks";

export type UnclosedParticipant = Readonly<{ memberId: string | null; name: string | null }>;
export type UnclosedLesson = Readonly<{
  eventId: string;
  date: string;
  courseName: string | null;
  participants: readonly UnclosedParticipant[];
  firstDetectedAt: string;
  lastSeenAt: string;
}>;
export type UnclosedSnapshot = Readonly<{ revision: string | null; checkedAt: string | null; lessons: readonly UnclosedLesson[] }>;
export type UnclosedStateRecord = Record<string, unknown>;

export function unclosedTargetDate(now: Date) {
  const date = new Date(`${melbourneHourDate(now)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
}

function unclosedCatchUpDates(now: Date, previousCheckedAt: string | null | undefined) {
  if (previousCheckedAt === undefined || previousCheckedAt === null) return [];
  const previous = new Date(previousCheckedAt);
  if (!Number.isFinite(previous.valueOf()) || previous > now) throw new Error("unclosed_checkpoint_invalid");
  const start = Date.parse(`${unclosedTargetDate(previous)}T00:00:00Z`);
  const end = Date.parse(`${unclosedTargetDate(now)}T00:00:00Z`);
  const count = (end - start) / 86_400_000;
  if (count < 0 || count > 8 * 31) throw new Error("unclosed_window_limit");
  return Array.from({ length: count }, (_, index) => new Date(start + (index + 1) * 86_400_000).toISOString().slice(0, 10));
}

export function unclosedCollectionWindows(lessons: readonly UnclosedLesson[], now: Date, previousCheckedAt?: string | null) {
  const dates = [...new Set([unclosedTargetDate(now), ...unclosedCatchUpDates(now, previousCheckedAt), ...lessons.map((lesson) => lesson.date)])].sort();
  const windows: Array<{ start: string; end: string }> = [];
  for (const date of dates) {
    const current = windows.at(-1);
    if (current && Date.parse(`${date}T00:00:00Z`) - Date.parse(`${current.start}T00:00:00Z`) < 31 * 86_400_000) current.end = date;
    else windows.push({ start: date, end: date });
  }
  if (windows.length > 8) throw new Error("unclosed_window_limit");
  return windows;
}

export function reconcileUnclosedLessons(previous: readonly UnclosedLesson[], open: readonly UnclosedLesson[], completedIds: ReadonlySet<string>) {
  const merged = new Map(previous.map((lesson) => [lesson.eventId, lesson]));
  for (const lesson of open) {
    if (completedIds.has(lesson.eventId)) throw new Error("unclosed_source_changed");
    const retained = merged.get(lesson.eventId);
    merged.set(lesson.eventId, { ...lesson, firstDetectedAt: retained?.firstDetectedAt ?? lesson.firstDetectedAt });
  }
  for (const eventId of completedIds) merged.delete(eventId);
  return [...merged.values()].sort((left, right) => left.date.localeCompare(right.date) || left.eventId.localeCompare(right.eventId));
}

function object(value: unknown): UnclosedStateRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnclosedStateRecord : {};
}

function nameKeys(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [];
  return [...new Set([normalizeStudentImportName(value), studentImportAutomaticJwbNameKey(value)].filter(Boolean))];
}

function sourceIds(student: UnclosedStateRecord) {
  const source = object(student.jiaowubaoOpenApi);
  const historical = object(student.historicalJwbSnapshot);
  return [student.jwbSourceRow, source.sourceId, object(historical.currentAggregate).jwbSourceRow, object(historical.retained).jwbSourceRow].filter((value) => typeof value === "string" || typeof value === "number").map(String);
}

function participantStudent(participant: UnclosedParticipant, course: string | null, students: readonly UnclosedStateRecord[]) {
  const shared = isJiaowubaoSharedTrialAccountLabel(participant.name);
  const name = shared ? jiaowubaoTrialStudentNameFromCourseTitle(course) : participant.name;
  const keys = nameKeys(name);
  const named = students.filter((student) => nameKeys(student.name).some((key) => keys.includes(key)));
  const identified = shared ? [] : students.filter((student) => sourceIds(student).includes(participant.memberId ?? ""));
  const candidates = [...new Set([...named, ...identified].map((student) => student.id))];
  return candidates.length === 1 ? students.find((student) => student.id === candidates[0]) : undefined;
}

export function unclosedLessonOwners(lesson: UnclosedLesson, students: readonly UnclosedStateRecord[], lpItems: readonly UnclosedStateRecord[]) {
  const linked = lpItems.filter((item) => {
    const schedule = object(item.trialSchedule);
    return schedule.source === "jiaowubao-open-api" && schedule.eventId === lesson.eventId;
  });
  const participants = lesson.participants.map((participant) => participantStudent(participant, lesson.courseName, students));
  const linkedStudents = linked.length === 1 ? [students.find((student) => student.id === linked[0]!.studentId)] : [];
  const resolved = participants.length > 0 ? participants : linkedStudents;
  if (resolved.length === 0 || resolved.some((student) => !student)) return [{ owner: null, studentIds: [] as string[] }];
  const owners = new Map<string, string[]>();
  for (const student of resolved) {
    const owner = resolveAssignableOperationsOwner(student!.owner);
    if (!owner || typeof student!.id !== "string") return [{ owner: null, studentIds: [] as string[] }];
    owners.set(owner, [...new Set([...(owners.get(owner) ?? []), student!.id])]);
  }
  return [...owners].map(([owner, studentIds]) => ({ owner, studentIds }));
}

export function unclosedTask(input: Readonly<{ owner: string | null; lessons: readonly UnclosedLesson[]; checkedAt: string }>): OpsTask {
  const owner = input.owner ?? "Ops Admin";
  const dueAt = DateTime.fromISO(input.checkedAt, { zone: "Australia/Melbourne" }).endOf("day").toUTC().toISO()!;
  return {
    id: `JWB-UNCLOSED:${input.owner ?? "unassigned"}`, owner, studentId: `unclosed:${input.owner ?? "unassigned"}`,
    title: `【未结课】<${input.owner ?? "未匹配教务"}> <${input.lessons.length} 节>`,
    due: "", dueAt, status: "today", tone: "amber", category: "课后", trigger: input.lessons.map((lesson) => `${lesson.date} · ${lesson.eventId.replace("jwb-open-api:schedule:", "")}`).join("\n"), ruleKey: "jiaowubao.unclosed",
  };
}

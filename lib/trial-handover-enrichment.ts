import type { JiaowubaoOpenApiScheduleSnapshotWindow } from "./ops-store";
import { trialAccountLetter } from "./trial-account-label";

type RecordValue = Record<string, unknown>;
type SourceEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number];

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function empty(value: unknown) {
  return value == null || typeof value === "string" && !value.trim();
}

function nameKey(value: unknown) {
  return typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/\s+/gu, "") : "";
}

function sourceStudentName(value: string | null) {
  const source = value?.normalize("NFKC").trim() ?? "";
  const delimited = source.match(/^.*[-–—]\s+(.{1,80}?)\s*试听(?:课)?\s*$/u);
  const direct = delimited ? null : source.match(/^(.{1,80}?)\s*试听(?:课)?\s*$/u);
  const candidate = (delimited?.[1] ?? direct?.[1] ?? "").trim()
    .replace(/([A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ0-9])\s+(?=[一-鿿])/gu, "$1");
  return /^[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ'’.-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ'’.-]+){0,3}[一-鿿]{0,8}$/u.test(candidate) ? candidate : undefined;
}

function provenStudentName(item: RecordValue, event: SourceEvent, students: readonly RecordValue[]) {
  const hint = sourceStudentName(event.courseName);
  if (!hint || trialAccountLetter(hint)) return undefined;
  const identities = students.filter((student) => nameKey(student.name) === nameKey(hint));
  return identities.length === 1 && identities[0]!.id === item.studentId ? hint : undefined;
}

function enrichedIntake(value: unknown, name: string | undefined, duration: number) {
  if (!record(value)) return null;
  const next = { ...value };
  if (empty(next.studentName) && name) next.studentName = name;
  if (empty(next.trialDurationMinutes) && [45, 60].includes(duration)) next.trialDurationMinutes = duration;
  return next;
}

export function enrichTrialHandover(item: RecordValue, event: SourceEvent, students: readonly RecordValue[]): RecordValue {
  const fields = record(item.fields) ? item.fields : {};
  const nextFields = { ...fields };
  const teacher = event.sourceTeacherLabel?.trim();
  if (empty(fields.assignedTeacher) && teacher) nextFields.assignedTeacher = teacher;
  const duration = (new Date(event.endsAt).valueOf() - new Date(event.startsAt).valueOf()) / 60_000;
  if (empty(fields.trialDurationMinutes) && [45, 60].includes(duration)) nextFields.trialDurationMinutes = duration;
  const provenName = provenStudentName(item, event, students);
  if (fields.studentNameKnown !== true && empty(fields.studentName) && provenName) {
    nextFields.studentNameKnown = true;
    nextFields.studentName = provenName;
  }
  const trialIntake = enrichedIntake(item.trialIntake, provenName, duration);
  return {
    ...item,
    ...(JSON.stringify(fields) !== JSON.stringify(nextFields) ? { fields: nextFields } : {}),
    ...(record(trialIntake) ? { trialIntake } : {}),
  };
}

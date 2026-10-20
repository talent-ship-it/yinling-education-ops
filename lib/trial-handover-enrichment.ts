import { jiaowubaoTrialStudentNameFromCourseTitle } from "./trial-operations";
import type { JiaowubaoOpenApiScheduleSnapshotWindow } from "./ops-store";

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

export function enrichTrialHandover(item: RecordValue, event: SourceEvent, students: readonly RecordValue[]): RecordValue {
  const fields = record(item.fields) ? item.fields : {};
  const nextFields = { ...fields };
  const teacher = event.sourceTeacherLabel?.trim();
  if (empty(fields.assignedTeacher) && teacher) nextFields.assignedTeacher = teacher;
  const duration = (new Date(event.endsAt).valueOf() - new Date(event.startsAt).valueOf()) / 60_000;
  if (empty(fields.trialDurationMinutes) && [45, 60].includes(duration)) nextFields.trialDurationMinutes = duration;
  const hint = jiaowubaoTrialStudentNameFromCourseTitle(event.courseName);
  const identities = hint ? students.filter((student) => nameKey(student.name) === nameKey(hint)) : [];
  const provenName = identities.length === 1 && identities[0]!.id === item.studentId ? hint : undefined;
  if (fields.studentNameKnown !== true && empty(fields.studentName) && provenName) {
    nextFields.studentNameKnown = true;
    nextFields.studentName = provenName;
  }
  const trialIntake = record(item.trialIntake) ? { ...item.trialIntake } : null;
  if (trialIntake) {
    if (empty(trialIntake.studentName) && provenName) trialIntake.studentName = provenName;
    if (empty(trialIntake.trialDurationMinutes) && [45, 60].includes(duration)) trialIntake.trialDurationMinutes = duration;
  }
  return {
    ...item,
    ...(JSON.stringify(fields) !== JSON.stringify(nextFields) ? { fields: nextFields } : {}),
    ...(record(trialIntake) ? { trialIntake } : {}),
  };
}

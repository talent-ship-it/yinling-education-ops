import type { OpsStateRow } from "./ops-store";
import { buildWecomLpDraft } from "./wecom-lp-draft";
import { matchWecomDraftStudent, type WecomLpDraftRawSource, type WecomLpDraftSource } from "./wecom-lp-intake";
import { trialAccountLetter } from "./trial-account-label";
import type { TrialScheduleLink } from "./trial-operations";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function key(value: unknown) { return text(value).normalize("NFKC").toLocaleLowerCase("en-AU").replace(/\s+/gu, ""); }
function rowsOf(rows: readonly OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  return Array.isArray(payload) ? payload.filter(record) : [];
}
function realName(value: unknown, student: RecordValue) {
  const name = text(value);
  const guardian = text(student.guardianWechat).replace(/(?:\s*[@＠]教务\s*AI\s*助手)+\s*$/iu, "");
  return name && key(name.replace(/(?:\s*[@＠]教务\s*AI\s*助手)+\s*$/iu, "")) !== key(guardian) && key(name) !== key(student.guardianWechat) && !trialAccountLetter(name)
    && !/^(?:待确认|待补充|未知|未提供|暂无|unknown|tbd|n\/?a|[-?？]+)$/iu.test(name) ? name : null;
}
function nullableText(value: unknown) { return text(value) || null; }
function validSchedule(value: unknown): value is RecordValue {
  if (!record(value)) return false;
  return [value.source === "jiaowubao-open-api", Boolean(text(value.eventId)),
    Number.isFinite(Date.parse(text(value.startsAt))), Number.isFinite(Date.parse(text(value.endsAt))),
    Date.parse(text(value.endsAt)) > Date.parse(text(value.startsAt))].every(Boolean);
}
function scheduleMetadata(schedule: RecordValue) {
  return {
    ...(typeof schedule.sourceRevision === "string" ? { sourceRevision: schedule.sourceRevision } : {}),
    ...(schedule.confirmation === "screenshot-review" ? { confirmation: "screenshot-review" as const } : {}),
    ...(schedule.durationMinutes === 45 || schedule.durationMinutes === 60 ? { durationMinutes: schedule.durationMinutes } : {}),
    sharedAccountLabel: nullableText(schedule.sharedAccountLabel), sharedAccountLetter: nullableText(schedule.sharedAccountLetter),
  };
}
export function wecomLpScheduleOf(lp: RecordValue | undefined): TrialScheduleLink | undefined {
  const schedule = lp?.trialSchedule;
  if (!validSchedule(schedule)) return undefined;
  return {
    source: "jiaowubao-open-api", eventId: text(schedule.eventId), startsAt: text(schedule.startsAt), endsAt: text(schedule.endsAt),
    courseName: nullableText(schedule.courseName), studentName: text(schedule.studentName), teacherId: nullableText(schedule.teacherId),
    teacherName: text(schedule.teacherName), plannerHint: ["Tara", "Eileen", "Abby"].includes(text(schedule.plannerHint)) ? schedule.plannerHint as TrialScheduleLink["plannerHint"] : null,
    matchedAt: text(schedule.matchedAt), ...scheduleMetadata(schedule),
  };
}
function sourceStudent(source: WecomLpDraftRawSource, students: readonly RecordValue[], visibleRows: readonly OpsStateRow[]) {
  if (["identity_conflict", "identity_ambiguous"].includes(source.status)) return undefined;
  const studentId = source.confirmed?.studentId ?? matchWecomDraftStudent(source, students);
  return rowsOf(visibleRows, "students").find((row) => row.id === studentId && row.importArchived !== true);
}
function confirmedLp(source: WecomLpDraftRawSource, student: RecordValue | undefined, visibleRows: readonly OpsStateRow[], draft: ReturnType<typeof buildWecomLpDraft>) {
  if (!student || !source.confirmed) return undefined;
  return rowsOf(visibleRows, "lpItems").find((row) => row.id === source.confirmed!.lpItemId && row.studentId === student.id && row.workflowType === draft.workflowType);
}
function provenName(draft: ReturnType<typeof buildWecomLpDraft>, student: RecordValue | undefined, lpFields: RecordValue) {
  if (!student || draft.conflicts.some((conflict) => ["studentName", "studentNameKnown"].includes(conflict.field))) return null;
  return realName(lpFields.studentNameKnown === true ? lpFields.studentName : student.name, student);
}
function enrichDraftName(draft: ReturnType<typeof buildWecomLpDraft>, name: string | null) {
  if (draft.workflowType !== "试听 LP" || !name || draft.studentName) return draft;
  return { ...draft, studentName: name, fields: { ...draft.fields, studentNameKnown: true, studentName: name },
    missingFields: draft.missingFields.filter((field) => !["studentName", "studentNameKnown"].includes(field.field)) };
}
export function decorateWecomLpDraft(source: WecomLpDraftRawSource, students: readonly RecordValue[], visibleRows: readonly OpsStateRow[]): WecomLpDraftSource {
  const draft = buildWecomLpDraft(source.messages);
  const conflicted = ["identity_conflict", "identity_ambiguous"].includes(source.status);
  const student = sourceStudent(source, students, visibleRows);
  const matchedStudentId = student ? text(student.id) : null;
  const lp = confirmedLp(source, student, visibleRows, draft);
  const lpFields = record(lp?.fields) ? lp.fields : {};
  const name = provenName(draft, student, lpFields);
  const resolvedStudentName = conflicted ? null : source.studentName || draft.studentName || name;
  const trialSchedule = ["试听 LP", "换老师试听"].includes(draft.workflowType ?? "") ? wecomLpScheduleOf(lp) : null;
  return { ...source, draft: enrichDraftName(draft, name), matchedStudentId, resolvedStudentName, ...(trialSchedule ? { trialSchedule } : {}) };
}

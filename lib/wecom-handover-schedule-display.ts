import type { OpsStateRow } from "./ops-store";
import type { WecomLpDraftSource } from "./wecom-lp-intake";
import { trialAccountLetter } from "./trial-account-label";
import { wecomHandoverScheduleTitleName } from "./wecom-handover-schedule-title";
import { wecomLpScheduleOf } from "./wecom-lp-draft-enrichment";
import { WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION, type WecomHandoverScheduleCandidate, type WecomHandoverScheduleEvidence } from "./wecom-handover-schedule-types";

export type WecomHandoverScheduleDisplay = Pick<WecomHandoverScheduleEvidence, "status" | "checkedAt"> & Readonly<{
  candidates: readonly Omit<WecomHandoverScheduleCandidate, "sourceRunId">[];
}>;
function visibleStudents(rows: readonly OpsStateRow[]) {
  const payload = rows.find((row) => row.entity === "students")?.payload;
  return Array.isArray(payload) ? payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row) && row.importArchived !== true) : [];
}
function titleOnlyCandidateValid(candidate: WecomHandoverScheduleCandidate, evidence: WecomHandoverScheduleEvidence, schedule: NonNullable<ReturnType<typeof wecomLpScheduleOf>>) {
  const letter = trialAccountLetter(schedule.sharedAccountLabel);
  const planner = letter === "a" ? "Tara" : letter === "b" ? "Eileen" : letter === "c" ? "Abby" : null;
  return ["candidate", "ambiguous"].includes(evidence.status) && evidence.matchedStudentId === null
    && wecomHandoverScheduleTitleName(schedule.courseName) === candidate.studentName
    && Boolean(letter) && schedule.sharedAccountLetter === letter && schedule.plannerHint === planner;
}
function displayCandidate(candidate: WecomHandoverScheduleCandidate, evidence: WecomHandoverScheduleEvidence, students: ReturnType<typeof visibleStudents>) {
  const schedule = wecomLpScheduleOf({ trialSchedule: candidate.schedule });
  if (!schedule || schedule.studentName !== candidate.studentName) return null;
  const student = students.find((row) => row.id === candidate.studentId && row.name === candidate.studentName);
  const valid = candidate.studentId === null ? titleOnlyCandidateValid(candidate, evidence, schedule) : Boolean(student);
  return valid ? { studentId: candidate.studentId, studentName: candidate.studentName, schedule } : null;
}
function displayCandidates(evidence: WecomHandoverScheduleEvidence, rows: readonly OpsStateRow[]) {
  const students = visibleStudents(rows);
  const candidates = evidence.candidates.map((candidate) => displayCandidate(candidate, evidence, students));
  return candidates.every((candidate) => candidate !== null) ? candidates : null;
}
function matchedCandidate(source: WecomLpDraftSource, evidence: WecomHandoverScheduleEvidence, candidates: NonNullable<ReturnType<typeof displayCandidates>>) {
  const candidate = candidates[0];
  if (!candidate?.studentId || candidates.length !== 1 || candidate.studentId !== evidence.matchedStudentId) return null;
  if (source.matchedStudentId && source.matchedStudentId !== candidate.studentId) return null;
  return source.draft.conflicts.some((conflict) => ["studentName", "studentNameKnown", "guardianWechat"].includes(conflict.field)) ? null : candidate;
}
function matchedDraft(source: WecomLpDraftSource, evidence: WecomHandoverScheduleEvidence, candidates: NonNullable<ReturnType<typeof displayCandidates>>) {
  if (evidence.status !== "matched") return source;
  const candidate = matchedCandidate(source, evidence, candidates);
  if (!candidate) return source;
  const draft = source.draft.studentName ? source.draft : { ...source.draft, studentName: candidate.studentName,
    fields: { ...source.draft.fields, studentNameKnown: true, studentName: candidate.studentName },
    missingFields: source.draft.missingFields.filter((field) => !["studentName", "studentNameKnown"].includes(field.field)) };
  return { ...source, draft, matchedStudentId: candidate.studentId, resolvedStudentName: source.resolvedStudentName || candidate.studentName, trialSchedule: candidate.schedule };
}
export function applyWecomHandoverScheduleEvidence(source: WecomLpDraftSource, evidence: WecomHandoverScheduleEvidence | undefined, rows: readonly OpsStateRow[]): WecomLpDraftSource {
  if (!evidence || evidence.algorithmVersion !== WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION || source.confirmed || ["identity_conflict", "identity_ambiguous"].includes(source.status)
    || evidence.sourceMessageId !== source.sourceMessageId || evidence.sourceRevision !== source.sourceRevision
    || !["matched", "candidate", "ambiguous", "needs_identity", "outside_window", "no_match", "identity_conflict"].includes(evidence.status)
    || !Number.isFinite(Date.parse(evidence.checkedAt)) || !Array.isArray(evidence.candidates) || evidence.candidates.length > 8) return source;
  const candidates = displayCandidates(evidence, rows);
  if (!candidates) return source;
  if (evidence.status === "matched" && (candidates.length !== 1 || candidates[0].studentId !== evidence.matchedStudentId)) return source;
  const result = matchedDraft(source, evidence, candidates);
  if (evidence.status === "matched" && result === source) return source;
  return { ...result, scheduleEvidence: { status: evidence.status, checkedAt: evidence.checkedAt, candidates } };
}

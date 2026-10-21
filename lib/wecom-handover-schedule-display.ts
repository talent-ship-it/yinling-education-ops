import type { OpsStateRow } from "./ops-store";
import type { WecomLpDraftSource } from "./wecom-lp-intake";
import { wecomLpScheduleOf } from "./wecom-lp-draft-enrichment";
import type { WecomHandoverScheduleCandidate, WecomHandoverScheduleEvidence } from "./wecom-handover-schedule-types";

export type WecomHandoverScheduleDisplay = Pick<WecomHandoverScheduleEvidence, "status" | "checkedAt"> & Readonly<{
  candidates: readonly Omit<WecomHandoverScheduleCandidate, "sourceRunId">[];
}>;
function visibleStudents(rows: readonly OpsStateRow[]) {
  const payload = rows.find((row) => row.entity === "students")?.payload;
  return Array.isArray(payload) ? payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row) && row.importArchived !== true) : [];
}
function displayCandidates(evidence: WecomHandoverScheduleEvidence, rows: readonly OpsStateRow[]) {
  const students = visibleStudents(rows);
  const candidates = evidence.candidates.map((candidate) => {
    const student = students.find((row) => row.id === candidate.studentId && row.name === candidate.studentName);
    const schedule = wecomLpScheduleOf({ trialSchedule: candidate.schedule });
    return student && schedule && schedule.studentName === candidate.studentName ? { studentId: candidate.studentId, studentName: candidate.studentName, schedule } : null;
  });
  return candidates.every((candidate) => candidate !== null) ? candidates : null;
}
function matchedDraft(source: WecomLpDraftSource, evidence: WecomHandoverScheduleEvidence, candidates: NonNullable<ReturnType<typeof displayCandidates>>) {
  if (evidence.status !== "matched") return source;
  const candidate = candidates[0];
  if (candidates.length !== 1 || candidate.studentId !== evidence.matchedStudentId
    || source.matchedStudentId && source.matchedStudentId !== candidate.studentId
    || source.draft.conflicts.some((conflict) => ["studentName", "studentNameKnown", "guardianWechat"].includes(conflict.field))) return source;
  const draft = source.draft.studentName ? source.draft : { ...source.draft, studentName: candidate.studentName,
    fields: { ...source.draft.fields, studentNameKnown: true, studentName: candidate.studentName },
    missingFields: source.draft.missingFields.filter((field) => !["studentName", "studentNameKnown"].includes(field.field)) };
  return { ...source, draft, matchedStudentId: candidate.studentId, resolvedStudentName: source.resolvedStudentName || candidate.studentName, trialSchedule: candidate.schedule };
}
export function applyWecomHandoverScheduleEvidence(source: WecomLpDraftSource, evidence: WecomHandoverScheduleEvidence | undefined, rows: readonly OpsStateRow[]): WecomLpDraftSource {
  if (!evidence || source.confirmed || ["identity_conflict", "identity_ambiguous"].includes(source.status)
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

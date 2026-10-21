import assert from "node:assert/strict";
import test from "node:test";
import { applyWecomHandoverScheduleEvidence } from "../lib/wecom-handover-schedule-display";
import { decorateWecomLpDraft } from "../lib/wecom-lp-draft-enrichment";
import type { OpsStateRow } from "../lib/ops-store";
import type { WecomLpDraftRawSource } from "../lib/wecom-lp-intake";
import type { WecomHandoverScheduleEvidence } from "../lib/wecom-handover-schedule-types";

const student = { id: "STU-SYNTH", name: "Synthetic Child", guardianWechat: "", owner: "Ella" };
const raw: WecomLpDraftRawSource = {
  id: "synthetic-source", sourceMessageId: "synthetic-source", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: "a".repeat(64),
  wechatName: "Unlinked Parent", studentName: null, operationsOwner: "Ella", coursePlanner: "Eileen", status: "awaiting_student_name",
  createdAt: "2026-10-20T01:00:00.000Z", messages: [{ messageId: "synthetic-source", sentAt: "2026-10-20T01:00:00.000Z", text: "【学生姓名】：\n【安排教师】：Synthetic Teacher\n【安排科目】：English" }], confirmed: null,
};
const rows: OpsStateRow[] = [{ entity: "students", payload: [student], version: 1, updated_at: raw.createdAt, updated_by: "synthetic" }];
const source = decorateWecomLpDraft(raw, [student], rows);
const schedule = { source: "jiaowubao-open-api" as const, eventId: "synthetic-event", startsAt: "2026-10-22T08:00:00.000Z", endsAt: "2026-10-22T09:00:00.000Z", studentName: student.name, courseName: "English", teacherName: "Synthetic Teacher", teacherId: null, plannerHint: null, matchedAt: raw.createdAt, sourceRevision: `sha256:${"b".repeat(64)}`, sharedAccountLabel: null, sharedAccountLetter: null };
const evidence: WecomHandoverScheduleEvidence = { algorithmVersion: "2", sourceMessageId: raw.sourceMessageId, sourceRevision: raw.sourceRevision, snapshotRevision: `sha256:${"b".repeat(64)}`, checkedAt: raw.createdAt, status: "matched", matchedStudentId: student.id, candidates: [{ studentId: student.id, studentName: student.name, sourceRunId: "private-run-id", schedule }] };

test("strong visible evidence fills the draft and whitelists the public schedule without mutating inputs", () => {
  const before = JSON.stringify({ source, rows, evidence });
  const result = applyWecomHandoverScheduleEvidence(source, evidence, rows);
  assert.equal(result.draft.studentName, student.name);
  assert.equal(result.draft.fields.studentNameKnown, true);
  assert.equal(result.matchedStudentId, student.id);
  assert.equal(result.trialSchedule?.startsAt, schedule.startsAt);
  assert.equal(result.studentName, null);
  assert.equal(result.sourceRevision, raw.sourceRevision);
  assert.doesNotMatch(JSON.stringify(result), /private-run-id|snapshotRevision/);
  assert.equal(JSON.stringify({ source, rows, evidence }), before);
});

test("teacher and subject candidates remain separate from identity and LP form selection", () => {
  const result = applyWecomHandoverScheduleEvidence(source, { ...evidence, status: "candidate", matchedStudentId: null }, rows);
  assert.equal(result.draft.studentName, null);
  assert.equal(result.matchedStudentId, null);
  assert.equal(result.resolvedStudentName, null);
  assert.equal(result.trialSchedule, undefined);
  assert.equal(result.scheduleEvidence?.candidates[0].studentName, student.name);
});

test("evidence from missing, older, or unknown algorithms never reaches the draft", () => {
  for (const algorithmVersion of [undefined, "1", "3"]) {
    const stale = { ...evidence, algorithmVersion } as unknown as WecomHandoverScheduleEvidence;
    assert.equal(applyWecomHandoverScheduleEvidence(source, stale, rows), source);
  }
});

test("mixed visibility drops the whole candidate set rather than manufacturing uniqueness", () => {
  const hidden = { ...evidence.candidates[0], studentId: "STU-HIDDEN", studentName: "Hidden Child", schedule: { ...schedule, studentName: "Hidden Child", eventId: "hidden-event" } };
  const result = applyWecomHandoverScheduleEvidence(source, { ...evidence, status: "ambiguous", matchedStudentId: null, candidates: [...evidence.candidates, hidden] }, rows);
  assert.equal(result, source);
  assert.doesNotMatch(JSON.stringify(result), /Hidden Child|hidden-event/);
  const archivedRows = [{ ...rows[0], payload: [{ ...student, importArchived: true }] }];
  assert.equal(applyWecomHandoverScheduleEvidence(source, evidence, archivedRows), source);
});

test("stale, malformed or conflicting proofs never attach a schedule", () => {
  for (const invalid of [
    { ...evidence, sourceRevision: "c".repeat(64) },
    { ...evidence, sourceMessageId: "other-source" },
    { ...evidence, checkedAt: "invalid" },
    { ...evidence, matchedStudentId: "other-student" },
    { ...evidence, candidates: [{ ...evidence.candidates[0], schedule: { ...schedule, studentName: "Wrong Child" } }] },
  ]) assert.equal(applyWecomHandoverScheduleEvidence(source, invalid, rows), source);
  assert.equal(applyWecomHandoverScheduleEvidence({ ...source, matchedStudentId: "other-student" }, evidence, rows).scheduleEvidence, undefined);
  for (const status of ["identity_conflict", "identity_ambiguous"])
    assert.equal(applyWecomHandoverScheduleEvidence({ ...source, status }, evidence, rows).trialSchedule, undefined);
});

test("confirmed LP evidence remains authoritative when reconciliation is pending or unavailable", () => {
  const confirmed = { ...source, confirmed: { studentId: student.id, lpItemId: "LP-SYNTH" }, trialSchedule: schedule };
  assert.equal(applyWecomHandoverScheduleEvidence(confirmed, evidence, rows), confirmed);
  assert.equal(applyWecomHandoverScheduleEvidence(confirmed, undefined, rows), confirmed);
});


test("unregistered title-only candidates expose class details while leaving every identity field unresolved", () => {
  const titleSchedule = { ...schedule, courseName: "English - New Child试听", studentName: "New Child", plannerHint: "Eileen" as const, sharedAccountLabel: "试听学员B2026", sharedAccountLetter: "b" };
  const titleEvidence = { ...evidence, status: "candidate" as const, matchedStudentId: null, candidates: [{ ...evidence.candidates[0], studentId: null, studentName: "New Child", schedule: titleSchedule }] };
  for (const status of ["candidate", "ambiguous"] as const) {
    const result = applyWecomHandoverScheduleEvidence(source, { ...titleEvidence, status }, rows);
    assert.equal(result.scheduleEvidence?.candidates[0].studentId, null);
    assert.equal(result.scheduleEvidence?.candidates[0].studentName, "New Child");
    assert.equal(result.scheduleEvidence?.candidates[0].schedule.startsAt, titleSchedule.startsAt);
    assert.equal(result.draft.studentName, null);
    assert.equal(result.matchedStudentId, null);
    assert.equal(result.resolvedStudentName, null);
    assert.equal(result.trialSchedule, undefined);
  }
  for (const schedule of [{ ...titleSchedule, sharedAccountLetter: "a" }, { ...titleSchedule, plannerHint: null }, { ...titleSchedule, sharedAccountLabel: null }, { ...titleSchedule, courseName: "English - Different Child试听" }, { ...titleSchedule, courseName: "English试听" }]) {
    const invalid = { ...titleEvidence, candidates: [{ ...titleEvidence.candidates[0], schedule }] };
    assert.equal(applyWecomHandoverScheduleEvidence(source, invalid, rows), source);
  }
  assert.equal(applyWecomHandoverScheduleEvidence(source, { ...titleEvidence, status: "matched" }, rows), source);
});

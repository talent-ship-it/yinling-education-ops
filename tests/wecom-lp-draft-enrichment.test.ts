import assert from "node:assert/strict";
import test from "node:test";
import { decorateWecomLpDraft } from "../lib/wecom-lp-draft-enrichment";
import type { WecomLpDraftRawSource } from "../lib/wecom-lp-intake";
import type { OpsStateRow } from "../lib/ops-store";

const student = { id: "STU-1", name: "Synthetic Child", guardianWechat: "Synthetic Parent", owner: "Ella" };
const source: WecomLpDraftRawSource = {
  id: "synthetic-handover", sourceMessageId: "synthetic-handover", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: "a".repeat(64),
  wechatName: "Synthetic Parent@教务AI助手", studentName: null, operationsOwner: "Ella", coursePlanner: "Eileen", status: "awaiting_student_name",
  createdAt: "2026-10-20T01:00:00.000Z", messages: [{ messageId: "synthetic-handover", text: "【姓名】：\n【偏好时间】：每天7-9点都可以\n【安排教师】：Synthetic Teacher\n【安排科目】：Synthetic Subject", sentAt: "2026-10-20T01:00:00.000Z" }], confirmed: null,
};
const schedule = { source: "jiaowubao-open-api", eventId: "synthetic-event", startsAt: "2026-10-22T08:00:00.000Z", endsAt: "2026-10-22T09:00:00.000Z", studentName: "Synthetic Child", courseName: "Synthetic Course", teacherName: "Synthetic Teacher", matchedAt: "2026-10-20T00:00:00.000Z", durationMinutes: 60, sharedAccountLetter: "b", sharedAccountLabel: "试听学员B2026", sourceRevision: `sha256:${"b".repeat(64)}` };
const lp = { id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", trialSchedule: schedule };
function rows(students: Record<string, unknown>[] = [student], lpItems: Record<string, unknown>[] = []) {
  return [{ entity: "students", payload: students }, { entity: "lpItems", payload: lpItems }].map((row) => ({ ...row, version: 1, updated_at: source.createdAt, updated_by: "synthetic" })) as OpsStateRow[];
}

test("a uniquely proven visible family supplies the name without changing source evidence or creating a schedule", () => {
  const visible = rows();
  const before = JSON.stringify({ source, visible });
  const result = decorateWecomLpDraft(source, [student], visible);
  assert.equal(result.matchedStudentId, "STU-1");
  assert.equal(result.resolvedStudentName, "Synthetic Child");
  assert.equal(result.draft.studentName, "Synthetic Child");
  assert.equal(result.draft.fields.studentNameKnown, true);
  assert.equal(result.draft.fields.preferredTime, "每天7-9点都可以");
  assert.equal(result.trialSchedule, undefined);
  assert.equal(result.status, "awaiting_student_name");
  assert.equal(result.studentName, null);
  assert.equal(result.sourceRevision, source.sourceRevision);
  assert.equal(JSON.stringify({ source, visible }), before);
});

test("a hidden sibling, invisible winner, or conflicted case cannot supply a name or schedule", () => {
  const sibling = { ...student, id: "STU-2", name: "Hidden Sibling", owner: "Tiffany" };
  for (const [input, all, visible] of [
    [source, [student, sibling], rows()],
    [source, [student], rows([])],
    [{ ...source, status: "identity_conflict" }, [student], rows()],
    [{ ...source, status: "identity_ambiguous" }, [student], rows()],
  ] as const) {
    const result = decorateWecomLpDraft(input, all, visible);
    assert.equal(result.matchedStudentId, null);
    assert.equal(result.resolvedStudentName, null);
    assert.equal(result.trialSchedule, undefined);
  }
});

test("guardian placeholders, shared accounts, and archived students never become student names", () => {
  for (const name of ["Synthetic Parent", "Synthetic Parent@教务AI助手", "试听学员B2026", "待确认"]) {
    const candidate = { ...student, name };
    const result = decorateWecomLpDraft(source, [candidate], rows([candidate]));
    assert.equal(result.resolvedStudentName, null);
    assert.notEqual(result.draft.fields.studentNameKnown, true);
  }
  const archived = { ...student, importArchived: true };
  assert.equal(decorateWecomLpDraft(source, [archived], rows([archived])).matchedStudentId, null);
});

test("only the confirmed visible LP for that student supplies its persisted Jiaowubao schedule", () => {
  const confirmed = { ...source, confirmed: { studentId: "STU-1", lpItemId: "LP-1" } };
  const result = decorateWecomLpDraft(confirmed, [student], rows([student], [{ ...lp, trialSchedule: { ...schedule, privateExtra: "omitted" } }]));
  assert.deepEqual(result.trialSchedule, { ...schedule, teacherId: null, plannerHint: null });
  assert.equal(decorateWecomLpDraft(source, [student], rows([student], [lp])).trialSchedule, undefined);
  for (const candidate of [{ ...lp, id: "LP-OTHER" }, { ...lp, studentId: "STU-OTHER" }, { ...lp, workflowType: "其他 LP" }]) {
    assert.equal(decorateWecomLpDraft(confirmed, [student], rows([student], [candidate])).trialSchedule, undefined);
  }
  assert.equal(decorateWecomLpDraft(confirmed, [student], rows([student], [])).trialSchedule, undefined);
});

test("invalid and non-Jiaowubao schedule metadata is never presented as a confirmed class time", () => {
  const confirmed = { ...source, confirmed: { studentId: "STU-1", lpItemId: "LP-1" } };
  for (const trialSchedule of [{ ...schedule, source: "other" }, { ...schedule, startsAt: "invalid" }, { ...schedule, endsAt: schedule.startsAt }, { ...schedule, eventId: "" }]) {
    assert.equal(decorateWecomLpDraft(confirmed, [student], rows([student], [{ ...lp, trialSchedule }])).trialSchedule, undefined);
  }
});

test("reviewed LP name can complete an unnamed roster while explicit source names remain intact", () => {
  const unnamed = { ...student, name: "Synthetic Parent" };
  const confirmed = { ...source, confirmed: { studentId: "STU-1", lpItemId: "LP-1" } };
  const reviewed = { ...lp, fields: { studentNameKnown: true, studentName: "Reviewed Child" } };
  assert.equal(decorateWecomLpDraft(confirmed, [unnamed], rows([unnamed], [reviewed])).resolvedStudentName, "Reviewed Child");
  const named = { ...source, studentName: "Explicit Child" };
  assert.equal(decorateWecomLpDraft(named, [student], rows()).resolvedStudentName, "Explicit Child");
});

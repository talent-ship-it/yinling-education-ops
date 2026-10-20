import assert from "node:assert/strict";
import test from "node:test";
import { enrichTrialHandover } from "../lib/trial-handover-enrichment";
import { trialAccountFromParticipants } from "../lib/trial-account-label";

const event = {
  eventId: "fixture-event-1", sourceDate: "2026-10-22",
  startsAt: "2026-10-22T08:05:00.000Z", endsAt: "2026-10-22T09:05:00.000Z",
  courseName: "Y7 English - Morgan王同学试听", sourceTeacherId: "fixture-teacher-1", sourceTeacherLabel: "Synthetic Teacher",
  sourceParticipants: [{ memberId: "fixture-shared-b", label: "试听学员B（校长号1）2026" }], sourceStudentsTruncated: false,
};
const students = [{ id: "fixture-student-1", name: "Morgan王同学", owner: "Ella" }];
const lp = { id: "fixture-lp-1", studentId: "fixture-student-1", workflowType: "试听 LP", fields: { studentNameKnown: false, subject: "英文写作", preferredTime: "周六上午" } };

test("API enrichment fills missing handover values without rewriting the course preference or source student", () => {
  const before = structuredClone({ lp, students });
  const result = enrichTrialHandover(lp, event, students);
  assert.deepEqual(result.fields, { ...lp.fields, assignedTeacher: "Synthetic Teacher", studentNameKnown: true, studentName: "Morgan王同学", trialDurationMinutes: 60 });
  assert.equal(result.trialIntake, undefined);
  assert.deepEqual({ lp, students }, before);
});

test("manual teacher, student and duration values survive while empty intake fields can be completed", () => {
  const item = { ...lp, fields: { ...lp.fields, assignedTeacher: "Chosen Teacher", studentNameKnown: true, studentName: "Chosen Name", trialDurationMinutes: 45 }, trialIntake: { studentName: "", trialDurationMinutes: null, writingRequired: true, requestSentAt: "2026-10-20T01:00:00.000Z" } };
  const result = enrichTrialHandover(item, event, students);
  assert.deepEqual(result.fields, item.fields);
  assert.deepEqual(result.trialIntake, { ...item.trialIntake, studentName: "Morgan王同学", trialDurationMinutes: 60 });
  assert.deepEqual(enrichTrialHandover(result, event, students), result);
});

test("a shared account, duplicated name or mismatched roster cannot create a student identity", () => {
  for (const roster of [[], [...students, { id: "duplicate", name: "Morgan 王同学" }], [{ id: "different", name: "Morgan王同学" }]]) {
    const result = enrichTrialHandover(lp, event, roster).fields as Record<string, unknown>;
    assert.equal(result.studentName, undefined);
    assert.equal(result.studentNameKnown, false);
  }
  const result = enrichTrialHandover(lp, { ...event, courseName: "Unstructured Class" }, students).fields as Record<string, unknown>;
  assert.equal(result.studentName, undefined);
});

test("nonstandard durations remain schedule data and nonempty intake or incomplete name values stay unchanged", () => {
  const item = { ...lp, fields: { ...lp.fields, studentName: "需核对姓名" }, trialIntake: { studentName: "人工姓名", trialDurationMinutes: 45 } };
  const result = enrichTrialHandover(item, { ...event, endsAt: "2026-10-22T09:35:00.000Z" }, students);
  assert.deepEqual(result.trialIntake, item.trialIntake);
  assert.equal((result.fields as Record<string, unknown>).trialDurationMinutes, undefined);
  assert.equal((result.fields as Record<string, unknown>).studentName, "需核对姓名");
  assert.equal(result.jwbSourceRow, undefined);
});

test("shared labels come from the exact event and conflicting account letters are not guessed", () => {
  assert.deepEqual(trialAccountFromParticipants(event.sourceParticipants), { sharedAccountLabel: "试听学员B（校长号1）2026", sharedAccountLetter: "b" });
  assert.deepEqual(trialAccountFromParticipants([{ label: "试听学员A" }, ...event.sourceParticipants]), { sharedAccountLabel: null, sharedAccountLetter: null });
  assert.deepEqual(trialAccountFromParticipants([{ label: "Morgan王同学" }]), { sharedAccountLabel: null, sharedAccountLetter: null });
});

test("unfamiliar name glyphs and punctuation stay for manual confirmation", () => {
  for (const name of ["Ḿorgan王同学", "Morgan🙂王同学"]) {
    const item = { ...lp, studentId: "fixture-glyph" };
    const result = enrichTrialHandover(item, { ...event, courseName: `Y7 English - ${name}试听` }, [{ id: "fixture-glyph", name }]);
    assert.equal((result.fields as Record<string, unknown>).studentName, undefined);
  }
  const result = enrichTrialHandover(lp, { ...event, courseName: "Y7 English - Morgan 王同学试听" }, students);
  assert.equal((result.fields as Record<string, unknown>).studentName, "Morgan王同学");
});

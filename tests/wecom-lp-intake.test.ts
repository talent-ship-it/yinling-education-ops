import assert from "node:assert/strict";
import test from "node:test";
import { buildWecomLpDraft } from "../lib/wecom-lp-draft";
import { matchWecomDraftStudent, parseWecomLpConfirmation, wecomDraftTimezone, type WecomLpDraftRawSource } from "../lib/wecom-lp-intake";
const fields = { responsibleOperations: "Ella", planner: "Abby", requestSentAt: "2026-10-20T09:00:00.000Z", assignedTeacher: "Synthetic Teacher", subject: "Y8 English", oneSentenceDescription: "Synthetic learning needs", locationTimezone: "VIC", contactParents: true, contactStudent: false, contactPerson: "家长", timeMentioned: false, studentNameKnown: true, studentName: "Synthetic Child", trialDurationMinutes: 60, trialPaymentMethod: "后置付费试听", writingRequired: false, paperRequired: false, specifiedContentStatus: "无需指定", preparationFollowUp: "是", isUniversityStudent: false };
function command() { return { commandKey: "b011aafd-7bb4-43d6-a52a-6c529221a55a", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceMessageId: "synthetic-handover-1", sourceRevision: "a".repeat(64), fields, expectedVersions: { students: 1, lpItems: 2, tasks: 3, files: 4 } }; }
const source: WecomLpDraftRawSource = { id: "synthetic-handover-1", sourceMessageId: "synthetic-handover-1", caseId: command().caseId, sourceRevision: command().sourceRevision, wechatName: "Synthetic Parent", studentName: "Synthetic Child", operationsOwner: "Ella", coursePlanner: "Abby", status: "identified", createdAt: fields.requestSentAt, messages: [{ messageId: "synthetic-handover-1", text: "【微信名】：Synthetic Parent", sentAt: fields.requestSentAt }], confirmed: null };
test("source confirmation validates one complete LP and derives the student from reviewed fields", () => {
  const parsed = parseWecomLpConfirmation({ ...command(), newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" } });
  assert.equal(parsed.newStudent?.name, "Synthetic Child");
  assert.equal(parsed.newStudent?.planner, "Abby");
  assert.equal(parsed.newStudent?.course, "Y8 English");
  assert.equal(parsed.newStudent?.location, "VIC");
  assert.equal(parsed.newStudent?.segment, "试听");
  assert.equal(parsed.studentId, undefined);
  assert.equal(parsed.expectedVersions.lpItems, 2);
});
test("unnamed trials use the reviewed WeChat name without inventing a student name", () => {
  const parsed = parseWecomLpConfirmation({ ...command(), fields: { ...fields, studentNameKnown: false, studentName: undefined }, newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" } });
  assert.equal(parsed.newStudent?.name, "Synthetic Parent");
  assert.equal(parsed.fields.studentNameKnown, false);
});
test("confirmation rejects incomplete data, forged versions, mixed targets and unsupported assignments", () => {
  for (const input of [
    { ...command() },
    { ...command(), studentId: "STU-1", newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" } },
    { ...command(), studentId: "STU-1", fields: { ...fields, assignedTeacher: "" } },
    { ...command(), studentId: "STU-1", expectedVersions: { students: 0, lpItems: 2, tasks: 3, files: 4 } },
    { ...command(), studentId: "STU-1", sourceRevision: "stale" },
    { ...command(), studentId: "STU-1", fullAdmin: true },
    { ...command(), newStudent: { guardianWechat: "Synthetic Parent", timezone: "invalid" } },
    { ...command(), newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne", owner: "Nixon" } },
    { ...command(), fields: { ...fields, responsibleOperations: "思佳" }, newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" } },
  ]) assert.throws(() => parseWecomLpConfirmation(input));
});
test("existing-student confirmation keeps the selected ID and never supplies a new student", () => {
  const parsed = parseWecomLpConfirmation({ ...command(), studentId: "STU-EXISTING" });
  assert.equal(parsed.studentId, "STU-EXISTING"); assert.equal(parsed.newStudent, undefined);
});
test("automatic match requires one active identity and does not guess among siblings", () => {
  const student = { id: "STU-1", name: "Synthetic Child", guardianWechat: "Synthetic Parent" };
  assert.equal(matchWecomDraftStudent(source, [student]), "STU-1");
  assert.equal(matchWecomDraftStudent(source, [{ ...student, importArchived: true }]), null);
  assert.equal(matchWecomDraftStudent(source, [student, { ...student, id: "STU-2" }]), null);
  assert.equal(matchWecomDraftStudent({ ...source, studentName: null }, [student, { ...student, id: "STU-2", name: "Sibling" }]), null);
  assert.equal(matchWecomDraftStudent({ ...source, messages: [{ ...source.messages[0], studentId: "STU-1" }] }, [student]), "STU-1");
});
test("contradictory explicit student links never preselect one sibling", () => {
  const messages = [{ ...source.messages[0], studentId: "STU-1" }, { ...source.messages[0], messageId: "follow-up", studentId: "STU-2" }];
  assert.equal(matchWecomDraftStudent({ ...source, messages }, [
    { id: "STU-1", name: "Synthetic Child", guardianWechat: "Synthetic Parent" },
    { id: "STU-2", name: "Sibling", guardianWechat: "Synthetic Parent" },
  ]), null);
});
test("recognized trial locations map to existing timezone choices while unknowns remain unfilled", () => {
  assert.equal(wecomDraftTimezone("VIC"), "Australia/Melbourne");
  assert.equal(wecomDraftTimezone("NZ"), "Pacific/Auckland");
  assert.equal(wecomDraftTimezone("国内"), "Asia/Shanghai");
  assert.equal(wecomDraftTimezone("Europe/Sarajevo"), "Europe/Sarajevo");
  assert.equal(wecomDraftTimezone("unknown"), "");
});
test("source data stays read-only when generating a draft", () => {
  const before = JSON.stringify(source);
  buildWecomLpDraft(source.messages);
  assert.equal(JSON.stringify(source), before);
});

test("guardian mentions are formatting while distinct names and placeholders stay separate", () => {
  const student = { id: "STU-1", name: "Synthetic Child", guardianWechat: "Synthetic Parent" };
  for (const wechatName of ["Synthetic Parent@教务AI助手", "Ｓｙｎｔｈｅｔｉｃ Parent＠教务AI助手", "Synthetic Parent @教务 AI 助手 @教务AI助手"]) {
    assert.equal(matchWecomDraftStudent({ ...source, wechatName }, [student]), "STU-1");
  }
  for (const wechatName of ["@教务AI助手", "-@教务AI助手", "待确认@教务AI助手", "教务AI助手", "N/A"]) {
    assert.equal(matchWecomDraftStudent({ ...source, wechatName }, [{ ...student, guardianWechat: wechatName }]), null);
  }
  assert.equal(matchWecomDraftStudent({ ...source, wechatName: "DJ@教务AI助手" }, [{ ...student, guardianWechat: "J" }]), null);
  for (const status of ["identity_conflict", "identity_ambiguous"] as const) {
    assert.equal(matchWecomDraftStudent({ ...source, status }, [student]), null);
  }
});

test("a legacy case cannot lend its family identity to a different message guardian", () => {
  const student = { id: "STU-1", name: "Synthetic Child", guardianWechat: "DJ" };
  const base = { ...source, wechatName: "DJ@教务AI助手", studentName: null };
  const messages = [{ ...source.messages[0], text: "【微信名】：J@教务AI助手" }];
  assert.equal(matchWecomDraftStudent({ ...base, messages }, [student]), null);
  assert.equal(matchWecomDraftStudent({ ...base, messages: [{ ...messages[0], studentId: "STU-1" }] }, [student]), null);
  assert.equal(matchWecomDraftStudent({ ...base, messages: [{ ...messages[0], text: "【微信名】：DJ@教务AI助手" }] }, [student]), "STU-1");
  assert.equal(matchWecomDraftStudent({ ...base, messages: [{ ...messages[0], text: "【微信名】：DJ@教务AI助手" }, { ...messages[0], messageId: "synthetic-other", text: "【微信名】：J@教务AI助手" }] }, [student]), null);
});

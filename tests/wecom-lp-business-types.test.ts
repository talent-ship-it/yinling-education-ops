import assert from "node:assert/strict";
import test from "node:test";
import { buildWecomLpDraft, type WecomLpDraftSourceRecord } from "../lib/wecom-lp-draft";
import { matchWecomDraftStudent, parseWecomLpConfirmation, type WecomLpDraftRawSource } from "../lib/wecom-lp-intake";

const sentAt = "2026-10-21T01:00:00.000Z";
const record = (text: string, messageId = "synthetic-business-1"): WecomLpDraftSourceRecord => ({ messageId, text, sentAt });
const newLp = `[Rose]老生新LP 信息交接[Rose]
【学生姓名】：Synthetic Student
【安排科目】：English
【安排教师】：Synthetic Teacher
【是否“要指定内容”】：需教务跟进
【是否“要写作”】：是
【是否“发试卷 收试卷”】：否
【是否“跟进老师备课内容”】：是`;
const repeat = `[Rose]二次试听 信息交接[Rose]
【学生】：Synthetic Student
【安排教师】：Synthetic New Teacher
【是否“要指定内容”】：无需指定
【是否“跟进老师备课内容”】：是
【二次试听原因 + 注意事项】：Change teaching approach; preserve specific exam practice.`;
const modification = `[Rose]老生LP修改 信息交接[Rose]
【学生姓名】：Synthetic Student
【涉及科目】：English
【变动内容】：Use the updated school report.
Highlight the changed section and confirm with the teacher.`;

test("new old-student LP preserves the current short handover flags without trial-only fields", () => {
  const draft = buildWecomLpDraft([record(newLp)]);
  assert.equal(draft.workflowType, "老师新 LP");
  assert.equal(draft.fields.teacher, "Synthetic Teacher");
  assert.equal(draft.fields.subject, "English");
  assert.equal(draft.fields.writingRequired, true);
  assert.equal(draft.fields.paperRequired, false);
  assert.equal(draft.fields.specifiedContentStatus, "需教务跟进");
  assert.equal(draft.fields.assignedTeacher, undefined);
  assert.equal(draft.fields.trialPaymentMethod, undefined);
  assert.ok(!draft.missingFields.some((field) => field.field === "guardianWechat"));
  const missing = buildWecomLpDraft([record("老生新LP 信息交接\n【学生】：Synthetic Student")]);
  assert.equal(missing.fields.writingRequired, undefined);
  assert.equal(missing.fields.paperRequired, undefined);
});

test("repeat trials stay ordinary trial LPs and preserve the arranged teacher and reason", () => {
  const draft = buildWecomLpDraft([record(repeat)]);
  assert.equal(draft.workflowType, "试听 LP");
  assert.equal(draft.fields.assignedTeacher, "Synthetic New Teacher");
  assert.equal(draft.fields.newTeacher, undefined);
  assert.equal(draft.fields.originalTeacher, undefined);
  assert.equal(draft.fields.subject, undefined);
  assert.match(String(draft.fields.specialNotes), /specific exam practice/u);
  assert.equal(draft.fields.changeReason, undefined);
  assert.ok(draft.missingFields.some((field) => field.field === "trialDurationMinutes"));
  for (const text of ["【LP类型】：二次试听", "业务类型：二次试听", "【二次试听信息交接】"]) {
    assert.equal(buildWecomLpDraft([record(text)]).workflowType, "试听 LP");
  }
});

test("only an explicit teacher-change type selects the teacher-change workflow", () => {
  const draft = buildWecomLpDraft([record(repeat.replace("二次试听 信息", "换老师试听 信息"))]);
  assert.equal(draft.workflowType, "换老师试听");
  assert.equal(draft.fields.newTeacher, "Synthetic New Teacher");
  assert.equal(draft.fields.assignedTeacher, undefined);
  assert.equal(draft.fields.originalTeacher, undefined);
  assert.match(String(draft.fields.changeReason), /specific exam practice/u);
});

test("a historical trial or satisfaction with the same teacher never implies a teacher change", () => {
  for (const reason of ["很久以前上过一节写作课，现在想再安排试听。", "对老师满意，想再多试一次。", "想试试其他科目。", "还没有试听，等待安排。"]) {
    const draft = buildWecomLpDraft([record(repeat.replace(/Change teaching approach;.*$/u, reason))]);
    assert.equal(draft.workflowType, "试听 LP");
    assert.equal(draft.fields.specialNotes, reason.normalize("NFKC"));
  }
  const sameType = buildWecomLpDraft([record(repeat), record("试听LP 信息交接", "synthetic-business-2")]);
  assert.equal(sameType.workflowType, "试听 LP");
  const conflict = buildWecomLpDraft([record(repeat), record("换老师试听 信息交接", "synthetic-business-2")]);
  assert.equal(conflict.workflowType, null);
  assert.ok(conflict.conflicts.some((field) => field.field === "workflowType"));
});

test("LP modification accepts its three-field source and preserves multiline changes", () => {
  const draft = buildWecomLpDraft([record(modification)]);
  assert.equal(draft.workflowType, "老师 LP 修改");
  assert.equal(draft.studentName, "Synthetic Student");
  assert.equal(draft.fields.subject, "English");
  assert.equal(draft.fields.teacher, undefined);
  assert.equal(draft.fields.modificationRequirements, "Use the updated school report.\nHighlight the changed section and confirm with the teacher.");
});

test("conflicting headings remain unresolved with source provenance", () => {
  const draft = buildWecomLpDraft([record(modification), record(repeat, "synthetic-business-2")]);
  assert.equal(draft.workflowType, null);
  const conflict = draft.conflicts.find((field) => field.field === "workflowType");
  assert.deepEqual(conflict?.values, ["老师 LP 修改", "试听 LP"]);
  assert.deepEqual(conflict?.messageIds, ["synthetic-business-1", "synthetic-business-2"]);
  const note = buildWecomLpDraft([record(`${newLp}\n【特殊备注】：Discuss 二次试听 or 老生LP修改 only if requested.`)]);
  assert.equal(note.workflowType, "老师新 LP");
});

test("nontrial sources can preselect only a unique active existing student from the explicit name", () => {
  const messages = [record(modification)];
  const source: WecomLpDraftRawSource = { id: "synthetic-business-1", sourceMessageId: "synthetic-business-1", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: "a".repeat(64), wechatName: "", studentName: "Synthetic Student", operationsOwner: null, coursePlanner: null, status: "identified", createdAt: sentAt, messages, confirmed: null };
  const student = { id: "STU-1", name: "Synthetic Student", guardianWechat: "Synthetic Parent" };
  assert.equal(matchWecomDraftStudent(source, [student]), "STU-1");
  assert.equal(matchWecomDraftStudent(source, [student, { ...student, id: "STU-2" }]), null);
  assert.equal(matchWecomDraftStudent(source, [{ ...student, importArchived: true }]), null);
  assert.equal(matchWecomDraftStudent({ ...source, status: "identity_conflict" }, [student]), null);
});

test("a named repeat trial can match only a unique active student without inventing a WeChat name", () => {
  const source: WecomLpDraftRawSource = { id: "synthetic-repeat", sourceMessageId: "synthetic-repeat", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: "a".repeat(64), wechatName: "", studentName: "Synthetic Student", operationsOwner: null, coursePlanner: null, status: "awaiting_student_name", createdAt: sentAt, messages: [record(repeat)], confirmed: null };
  const student = { id: "STU-1", name: "Synthetic Student", guardianWechat: "Synthetic Parent" };
  assert.equal(matchWecomDraftStudent(source, [student]), "STU-1");
  assert.equal(matchWecomDraftStudent(source, [student, { ...student, id: "STU-2" }]), null);
  assert.equal(matchWecomDraftStudent(source, [{ ...student, importArchived: true }]), null);
  assert.equal(matchWecomDraftStudent({ ...source, messages: [record("学生姓名：Synthetic Student")] }, [student]), null);
});

test("nontrial confirmation cannot create a new student or smuggle unsupported workflow types", () => {
  const command = { commandKey: "b011aafd-7bb4-43d6-a52a-6c529221a55a", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceMessageId: "synthetic-business-1", sourceRevision: "a".repeat(64), fields: {}, expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 } };
  for (const workflowType of ["老师新 LP", "换老师试听", "老师 LP 修改"]) assert.throws(() => parseWecomLpConfirmation({ ...command, workflowType, newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" } }), /已有学生/u);
  for (const workflowType of [null, "代课 LP", "学生直报（无试听）", "__proto__"]) assert.throws(() => parseWecomLpConfirmation({ ...command, workflowType, studentId: "STU-1" }), /不支持/u);
});


test("ordinary repeat trials preserve explicit new-teacher aliases and flag conflicting assignments", () => {
  for (const label of ["新老师", "新教师", "新任课老师"]) {
    const draft = buildWecomLpDraft([record(repeat.replace("安排教师", label))]);
    assert.equal(draft.fields.assignedTeacher, "Synthetic New Teacher");
    assert.equal(draft.fields.newTeacher, undefined);
    assert.ok(!draft.missingFields.some((field) => field.field === "assignedTeacher"));
  }
  const conflict = buildWecomLpDraft([record(`${repeat}\n【新老师】：Different Teacher`)]);
  assert.equal(conflict.fields.assignedTeacher, undefined);
  assert.ok(conflict.conflicts.some((field) => field.field === "assignedTeacher"));
});

test("ordinary repeat reasons and special notes remain complementary while source conflicts remain visible", () => {
  const draft = buildWecomLpDraft([record(`${repeat}\n【特殊备注】：Send preparation materials early.`)]);
  assert.equal(draft.fields.specialNotes, "Change teaching approach; preserve specific exam practice.\nSend preparation materials early.");
  assert.deepEqual(draft.conflicts, []);
  const later = record("【特殊备注】：Confirm availability first.", "synthetic-note-2");
  const conflict = buildWecomLpDraft([record(`${repeat}\n【特殊备注】：Send preparation materials early.`), later]);
  assert.equal(conflict.fields.specialNotes, undefined);
  assert.ok(conflict.conflicts.some((field) => field.field === "specialNotes"));
});

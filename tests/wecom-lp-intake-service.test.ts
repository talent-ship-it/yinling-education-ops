import assert from "node:assert/strict";
import test from "node:test";
import { createWecomLpIntakeHandlers } from "../lib/wecom-lp-intake-service";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import type { OpsStateRow, confirmWecomLpDraftAtomic, readWecomLpDrafts } from "../lib/ops-store";
import type { WecomLpDraftRawSource } from "../lib/wecom-lp-intake";
const fields = { responsibleOperations: "Ella", planner: "Eileen", requestSentAt: "2026-10-20T09:00:00.000Z", assignedTeacher: "Synthetic Teacher", subject: "Y8 English", oneSentenceDescription: "Synthetic learning needs", locationTimezone: "VIC", contactParents: true, contactStudent: false, contactPerson: "家长", timeMentioned: false, studentNameKnown: true, studentName: "Synthetic Child", trialDurationMinutes: 60, trialPaymentMethod: "后置付费试听", writingRequired: false, paperRequired: false, specifiedContentStatus: "无需指定", preparationFollowUp: "是", isUniversityStudent: false };
const command = { commandKey: "b011aafd-7bb4-43d6-a52a-6c529221a55a", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceMessageId: "synthetic-handover-1", sourceRevision: "a".repeat(64), fields, expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 }, studentId: "STU-1" };
function harness(options: { fullAdmin?: boolean; session?: DemoSessionIdentity; source?: WecomLpDraftRawSource | null; errorCode?: string } = {}) {
  const student = { id: "STU-1", name: "Synthetic Child", owner: "Ella", planner: "Tara", guardianWechat: "Synthetic Parent" };
  const rows: OpsStateRow[] = ["students", "lpItems", "tasks", "files"].map((entity) => ({ entity, payload: entity === "students" ? [student, { ...student, id: "STU-OTHER", name: "Other Synthetic Child", guardianWechat: "Other Synthetic Parent", owner: "Tiffany" }] : [], version: 1, updated_at: fields.requestSentAt, updated_by: "synthetic" }));
  const source: WecomLpDraftRawSource = { id: command.sourceMessageId, sourceMessageId: command.sourceMessageId, caseId: command.caseId, sourceRevision: command.sourceRevision, wechatName: "Synthetic Parent", studentName: "Synthetic Child", operationsOwner: "Ella", coursePlanner: "Eileen", status: "identified", createdAt: fields.requestSentAt, messages: [{ messageId: command.sourceMessageId, text: "【安排教师】：Synthetic Teacher\n【安排科目】：Y8 English", sentAt: fields.requestSentAt }], confirmed: null };
  const saved: Parameters<typeof confirmWecomLpDraftAtomic>[0][] = [];
  const reads: Parameters<typeof readWecomLpDrafts>[0][] = [];
  const handlers = createWecomLpIntakeHandlers({
    readSession: async () => ({ session: options.session ?? { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"] }, fullAdmin: options.fullAdmin ?? false }),
    readRows: async () => rows,
    readDraft: async () => options.source === undefined ? source : options.source,
    readDrafts: async (input) => { reads.push(input); return { rows: options.source === null ? [] : [options.source ?? source], nextCursor: null, total: 1 }; },
    confirm: async (input) => {
      saved.push(input);
      if (options.errorCode) throw Object.assign(new Error("synthetic database failure"), { code: options.errorCode });
      return [{ command_key: input.commandKey, operation: "create", applied: true, student_id: "STU-1", lp_item_id: "LP-SYNTHETIC", students_row: rows[0], lp_items_row: rows[1], tasks_row: rows[2], files_row: rows[3], audit_entry_id: "synthetic" }] as Awaited<ReturnType<typeof confirmWecomLpDraftAtomic>>;
    },
  });
  const post = (input: unknown = command) => handlers.POST(new Request("https://synthetic.invalid/api", { method: "POST", body: JSON.stringify(input) }));
  return { handlers, saved, reads, post, source };
}
test("confirmation keeps the existing roster planner and the handover planner separate", async () => {
  const f = harness(); const response = await f.post();
  assert.equal(response.status, 200);
  assert.deepEqual(f.saved[0].authorizedAssignment, { owner: "Ella", planner: "Tara", mayReassign: false });
  assert.equal(f.saved[0].fields.planner, "Eileen");
  const body = await response.json();
  assert.equal(body.committed, true);
  assert.deepEqual(body.studentsRow.payload.map((student: { id: string }) => student.id), ["STU-1"]);
  assert.match(response.headers.get("Cache-Control")!, /no-store/);
});
test("teachers, restricted scopes and cross-owner assignments cannot confirm", async () => {
  for (const f of [
    harness({ session: { user: "Ella", role: "teacher" } }),
    harness({ session: { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"], scopeMembers: [{ kind: "student", key: "STU-1" }] } }),
  ]) { assert.equal((await f.post()).status, 403); assert.equal(f.saved.length, 0); }
  const f = harness();
  assert.equal((await f.post({ ...command, fields: { ...fields, responsibleOperations: "Tiffany" } })).status, 403);
  assert.equal((await f.post({ ...command, studentId: "STU-OTHER" })).status, 403);
  assert.equal(f.saved.length, 0);
});
test("new-student confirmation refuses an existing identity before calling the transaction", async () => {
  const f = harness(); const { studentId: _, ...base } = command; void _;
  const response = await f.post({ ...base, newStudent: { guardianWechat: "Synthetic Parent", timezone: "Australia/Melbourne" } });
  assert.equal(response.status, 409); assert.equal(f.saved.length, 0);
});
test("source mismatches and forged input never reach the transaction", async () => {
  const absent = harness({ source: null }); assert.equal((await absent.post()).status, 404);
  const f = harness(); assert.equal((await f.post({ ...command, caseId: "d6385b25-691c-424f-a81b-5de3835ea704" })).status, 404);
  assert.equal((await f.post({ ...command, fullAdmin: true })).status, 400); assert.equal(f.saved.length, 0);
});
test("database failures preserve conflict, authorization and unavailable status without exposing errors", async () => {
  for (const [code, status] of [["40001", 409], ["23505", 409], ["42501", 403], ["P0002", 404], ["22023", 400], ["PGRST202", 501], ["unknown", 503]] as const) {
    const response = await harness({ errorCode: code }).post(); assert.equal(response.status, status);
    assert.doesNotMatch(JSON.stringify(await response.json()), /synthetic database failure/);
  }
});
test("draft reads validate cursors, decorate fields and only preselect visible students", async () => {
  const f = harness(); const response = await f.handlers.GET(new Request("https://synthetic.invalid/api"));
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.drafts[0].matchedStudentId, "STU-1"); assert.equal(body.drafts[0].draft.fields.subject, "Y8 English");
  assert.equal((await f.handlers.GET(new Request("https://synthetic.invalid/api?cursor=bad%20cursor"))).status, 400);
});

test("range reads pass UTC calendar bounds and the verified session scope to the store", async () => {
  const f = harness();
  const response = await f.handlers.GET(new Request("https://synthetic.invalid/api?from=2026-10-20&to=2026-10-20&timezone=Asia/Shanghai&cursor=synthetic-handover-1"));
  assert.equal(response.status, 200);
  assert.deepEqual(f.reads, [{ actor: "Ella", fullAdmin: false, cursor: "synthetic-handover-1", from: "2026-10-19T16:00:00.000Z", before: "2026-10-20T16:00:00.000Z" }]);
  assert.equal(f.saved.length, 0);
  assert.equal(response.headers.get("Vary"), "Cookie");
});

test("invalid range filters never reach the store or confirmation transaction", async () => {
  const f = harness();
  for (const filter of ["from=2026-10-21&to=2026-10-20", "to=2026-02-30", "timezone=bad", "from=2026-10-20&from=2026-10-20", "fullAdmin=true"]) {
    assert.equal((await f.handlers.GET(new Request(`https://synthetic.invalid/api?${filter}`))).status, 400);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.saved.length, 0);
  const teacher = harness({ session: { user: "Synthetic Teacher", role: "teacher" } });
  assert.equal((await teacher.handlers.GET(new Request("https://synthetic.invalid/api?from=2026-10-20"))).status, 403);
  assert.equal(teacher.reads.length, 0);
});

test("confirmed handovers retain their association in range results", async () => {
  const source = harness().source;
  const f = harness({ source: { ...source, handoverAt: "2026-10-19T23:30:00.000Z", confirmed: { studentId: "STU-1", lpItemId: "LP-SYNTHETIC" } } });
  const response = await f.handlers.GET(new Request("https://synthetic.invalid/api?from=2026-10-20&to=2026-10-20&timezone=Asia/Shanghai"));
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.drafts[0].confirmed.lpItemId, "LP-SYNTHETIC");
  assert.equal(body.drafts[0].handoverAt, "2026-10-19T23:30:00.000Z");
  assert.equal(body.drafts[0].matchedStudentId, "STU-1"); assert.equal(f.saved.length, 0);
});

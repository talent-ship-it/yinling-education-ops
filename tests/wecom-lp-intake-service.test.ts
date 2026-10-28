import assert from "node:assert/strict";
import test from "node:test";
import { createWecomLpIntakeHandlers } from "../lib/wecom-lp-intake-service";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import type { OpsStateRow, confirmWecomLpDraftAtomic, readWecomLpDrafts, readWecomHandoverScheduleEvidence } from "../lib/ops-store";
import type { WecomLpDraftRawSource } from "../lib/wecom-lp-intake";
import type { WecomHandoverScheduleEvidence } from "../lib/wecom-handover-schedule-types";
const fields = { responsibleOperations: "Ella", planner: "Eileen", requestSentAt: "2026-10-20T09:00:00.000Z", assignedTeacher: "Synthetic Teacher", subject: "Y8 English", oneSentenceDescription: "Synthetic learning needs", locationTimezone: "VIC", contactParents: true, contactStudent: false, contactPerson: "家长", timeMentioned: false, studentNameKnown: true, studentName: "Synthetic Child", trialDurationMinutes: 60, trialPaymentMethod: "后置付费试听", writingRequired: false, paperRequired: false, specifiedContentStatus: "无需指定", preparationFollowUp: "是", isUniversityStudent: false };
const command = { commandKey: "b011aafd-7bb4-43d6-a52a-6c529221a55a", caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceMessageId: "synthetic-handover-1", sourceRevision: "a".repeat(64), fields, expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 }, studentId: "STU-1" };
function harness(options: { fullAdmin?: boolean; session?: DemoSessionIdentity; source?: WecomLpDraftRawSource | null; errorCode?: string; applied?: boolean; evidence?: Awaited<ReturnType<typeof readWecomHandoverScheduleEvidence>>; evidenceError?: boolean; readPage?: (input: Parameters<typeof readWecomLpDrafts>[0]) => Awaited<ReturnType<typeof readWecomLpDrafts>> } = {}) {
  const student = { id: "STU-1", name: "Synthetic Child", owner: "Ella", planner: "Tara", guardianWechat: "Synthetic Parent" };
  const rows: OpsStateRow[] = ["students", "lpItems", "tasks", "files"].map((entity) => ({ entity, payload: entity === "students" ? [student, { ...student, id: "STU-OTHER", name: "Other Synthetic Child", guardianWechat: "Other Synthetic Parent", owner: "Tiffany" }] : [], version: 1, updated_at: fields.requestSentAt, updated_by: "synthetic" }));
  const source: WecomLpDraftRawSource = { id: command.sourceMessageId, sourceMessageId: command.sourceMessageId, caseId: command.caseId, sourceRevision: command.sourceRevision, wechatName: "Synthetic Parent", studentName: "Synthetic Child", operationsOwner: "Ella", coursePlanner: "Eileen", status: "identified", createdAt: fields.requestSentAt, messages: [{ messageId: command.sourceMessageId, text: "【安排教师】：Synthetic Teacher\n【安排科目】：Y8 English", sentAt: fields.requestSentAt }], confirmed: null };
  const saved: Parameters<typeof confirmWecomLpDraftAtomic>[0][] = [];
  const reads: Parameters<typeof readWecomLpDrafts>[0][] = [];
  const evidenceReads: Parameters<typeof readWecomHandoverScheduleEvidence>[0][] = [];
  const handlers = createWecomLpIntakeHandlers({
    readSession: async () => ({ session: options.session ?? { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"] }, fullAdmin: options.fullAdmin ?? false }),
    readRows: async () => rows,
    readScheduleEvidence: async (input) => { evidenceReads.push(input); if (options.evidenceError) throw new Error("private-database-error"); return options.evidence ?? []; },
    readDraft: async () => options.source === undefined ? source : options.source,
    readDrafts: async (input) => { reads.push(input); return options.readPage?.(input) ?? { rows: options.source === null ? [] : [options.source ?? source], nextCursor: null, total: 1 }; },
    confirm: async (input) => {
      saved.push(input);
      if (options.errorCode) throw Object.assign(new Error("synthetic database failure"), { code: options.errorCode });
      return [{ command_key: input.commandKey, operation: "create", applied: options.applied ?? true, student_id: "STU-1", lp_item_id: "LP-SYNTHETIC", students_row: rows[0], lp_items_row: rows[1], tasks_row: rows[2], files_row: rows[3], audit_entry_id: "synthetic" }] as Awaited<ReturnType<typeof confirmWecomLpDraftAtomic>>;
    },
  });
  const post = (input: unknown = command) => handlers.POST(new Request("https://synthetic.invalid/api", { method: "POST", body: JSON.stringify(input) }));
  return { handlers, saved, reads, evidenceReads, post, source, rows };
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
test("a repost arriving before or during confirmation returns a specific refresh message", async () => {
  for (const stage of ["readDraft", "confirm"] as const) {
    let confirms = 0;
    const f = harness();
    const handlers = createWecomLpIntakeHandlers({
      readSession: async () => ({ session: { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"] }, fullAdmin: false }),
      readRows: async () => f.rows,
      readDraft: async () => {
        if (stage === "readDraft") throw Object.assign(new Error("wecom_lp_source_superseded"), { code: "40001" });
        return f.source;
      },
      readDrafts: async () => ({ rows: [], total: 0, nextCursor: null }),
      readScheduleEvidence: async () => [],
      confirm: async () => {
        confirms += 1;
        throw Object.assign(new Error("wecom_lp_source_superseded"), { code: "40001" });
      },
    });
    const response = await handlers.POST(new Request("https://synthetic.invalid/api", { method: "POST", body: JSON.stringify(command) }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "这条交接已有更新版本，请刷新后确认最新草稿。", code: "draft_superseded" });
    assert.equal(confirms, stage === "readDraft" ? 0 : 1);
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

test("GET proves family uniqueness before filtering students by operations owner", async () => {
  const base = harness().source;
  const f = harness({ source: { ...base, wechatName: "Synthetic Parent@教务AI助手", studentName: null, status: "awaiting_student_name" } });
  const students = f.rows[0].payload as Record<string, unknown>[];
  students.push({ id: "STU-HIDDEN-SIBLING", name: "Hidden Sibling", guardianWechat: "Synthetic Parent", owner: "Tiffany" });
  const response = await f.handlers.GET(new Request("https://synthetic.invalid/api"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.drafts[0].matchedStudentId, null);
  assert.equal(body.drafts[0].resolvedStudentName, null);
  assert.doesNotMatch(JSON.stringify(body), /Hidden Sibling|STU-HIDDEN-SIBLING/);
  assert.equal(f.saved.length, 0);
});


test("evidence reads use the verified actor and never block readable handovers during reconciliation outages", async () => {
  const f = harness({ evidenceError: true });
  const response = await f.handlers.GET(new Request("https://synthetic.invalid/api"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.drafts[0].scheduleEvidenceUnavailable, true);
  assert.equal(body.drafts[0].draft.fields.subject, "Y8 English");
  assert.deepEqual(f.evidenceReads, [{ sourceMessageIds: [command.sourceMessageId], actor: "Ella", fullAdmin: false }]);
  assert.equal(f.saved.length, 0);
  assert.doesNotMatch(JSON.stringify(body), /private-database-error/);
  const empty = harness({ source: null });
  await empty.handlers.GET(new Request("https://synthetic.invalid/api"));
  assert.equal(empty.evidenceReads.length, 0);
});


test("GET joins persisted evidence by exact message revision and exposes only the public schedule", async () => {
  const evidence = { algorithmVersion: "2" as const, sourceMessageId: command.sourceMessageId, sourceRevision: command.sourceRevision, snapshotRevision: `sha256:${"b".repeat(64)}`, checkedAt: fields.requestSentAt, status: "matched" as const, matchedStudentId: "STU-1", candidates: [{ studentId: "STU-1", studentName: "Synthetic Child", sourceRunId: "private-snapshot-run", schedule: { source: "jiaowubao-open-api" as const, eventId: "synthetic-event", startsAt: "2026-10-22T08:00:00.000Z", endsAt: "2026-10-22T09:00:00.000Z", teacherName: "Synthetic Teacher", teacherId: null, courseName: "Y8 English", studentName: "Synthetic Child", plannerHint: null, matchedAt: fields.requestSentAt } }] };
  for (const heading of ["", "二次试听 信息交接\n"]) {
    const original = harness().source;
    const source = { ...original, messages: [{ ...original.messages[0], text: heading + original.messages[0].text }] };
    const f = harness({ source, evidence: [evidence] });
    const response = await f.handlers.GET(new Request("https://synthetic.invalid/api"));
    const body = await response.json();
    assert.equal(body.drafts[0].trialSchedule.eventId, "synthetic-event");
    assert.equal(body.drafts[0].scheduleEvidence.status, "matched");
    assert.doesNotMatch(JSON.stringify(body), /private-snapshot-run|snapshotRevision/);
    assert.equal(f.evidenceReads.length, 1);
    assert.equal(f.saved.length, 0);
  }
  const stale = harness({ evidence: [{ ...evidence, sourceRevision: "c".repeat(64) }] });
  const staleBody = await (await stale.handlers.GET(new Request("https://synthetic.invalid/api"))).json();
  assert.equal(staleBody.drafts[0].trialSchedule, undefined);
});


test("source business type cannot be changed or confirmed while its headings conflict", async () => {
  const original = harness().source;
  for (const title of ["老生LP修改 信息交接", "老生新LP 信息交接\n二次试听 信息交接"]) {
    const source = { ...original, messages: [{ ...original.messages[0], text: `${title}\n【学生】：Synthetic Child` }] };
    const f = harness({ source });
    const response = await f.post();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "workflow_conflict");
    assert.equal(f.saved.length, 0);
  }
});

test("LP modification draft pages never acquire trial schedule identity evidence", async () => {
  const original = harness().source;
  const source = { ...original, messages: [{ ...original.messages[0], text: "老生LP修改 信息交接\n【学生姓名】：Synthetic Child\n【涉及科目】：English\n【变动内容】：Update the learning goal." }] };
  const f = harness({ source, evidenceError: true });
  const response = await f.handlers.GET(new Request("https://synthetic.invalid/api"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.drafts[0].draft.workflowType, "老师 LP 修改");
  assert.equal(body.drafts[0].trialSchedule, undefined);
  assert.equal(body.drafts[0].scheduleEvidenceUnavailable, undefined);
  assert.equal(f.evidenceReads.length, 0);
});


test("committed legacy handovers replay their stored trial intent after business classification changes", async () => {
  const original = harness().source;
  const source = { ...original, confirmed: { studentId: "STU-1", lpItemId: "LP-SYNTHETIC" },
    messages: [{ ...original.messages[0], text: `老生新LP 信息交接\n${original.messages[0].text}` }] };
  const f = harness({ source, applied: false });
  const response = await f.post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.applied, false);
  assert.equal(body.lpItemId, "LP-SYNTHETIC");
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].workflowType, "试听 LP");
  assert.deepEqual(f.saved[0].fields, fields);
  const changed = harness({ source, errorCode: "23505" });
  const conflict = await changed.post({ ...command, fields: { ...fields, subject: "Maths" } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "draft_conflict");
  assert.equal(changed.saved.length, 1);
});

function pagedSources(sources: readonly WecomLpDraftRawSource[]) {
  return (input: Parameters<typeof readWecomLpDrafts>[0]) => {
    const start = input.cursor ? sources.findIndex((source) => source.sourceMessageId === input.cursor) + 1 : 0;
    const rows = sources.slice(start, start + 30);
    return { rows, nextCursor: start + rows.length < sources.length ? rows.at(-1)!.sourceMessageId : null, total: sources.length };
  };
}
function numberedSource(index: number, searchText = ""): WecomLpDraftRawSource {
  const base = harness().source;
  const id = `synthetic-filter-${String(index).padStart(3, "0")}`;
  return { ...base, id, sourceMessageId: id, messages: [{ ...base.messages[0], messageId: id, text: `${base.messages[0].text}\n${searchText}` }] };
}
function scheduleEvidence(source: WecomLpDraftRawSource, status: "matched" | "candidate" | "no_match"): WecomHandoverScheduleEvidence {
  return {
    algorithmVersion: "2", sourceMessageId: source.sourceMessageId, sourceRevision: source.sourceRevision,
    snapshotRevision: `sha256:${"b".repeat(64)}`, checkedAt: fields.requestSentAt, status,
    matchedStudentId: status === "matched" ? "STU-1" : null,
    candidates: status === "no_match" ? [] : [{
      studentId: "STU-1", studentName: "Synthetic Child", sourceRunId: "private-synthetic-run",
      schedule: { source: "jiaowubao-open-api", eventId: `event-${source.sourceMessageId}`, startsAt: "2026-10-22T08:00:00.000Z", endsAt: "2026-10-22T09:00:00.000Z",
        teacherName: "Synthetic Teacher", teacherId: null, courseName: "Y8 English", studentName: "Synthetic Child", plannerHint: null, matchedAt: fields.requestSentAt },
    }],
  };
}

test("sparse search scans every authorized range page and reports the filtered total", async () => {
  const sources = Array.from({ length: 90 }, (_, index) => numberedSource(index, index % 13 === 0 ? "Needle" : "Other"));
  const f = harness({ readPage: pagedSources(sources) });
  const response = await f.handlers.GET(new Request("https://synthetic.invalid/api?query=needle&from=2026-10-20&to=2026-10-20"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.drafts.map((source: { id: string }) => source.id), sources.filter((_, index) => index % 13 === 0).map((source) => source.id));
  assert.equal(body.total, 7);
  assert.equal(body.nextCursor, null);
  assert.equal(f.reads.length, 3);
  for (const input of f.reads) {
    assert.equal(input.actor, "Ella"); assert.equal(input.fullAdmin, false);
    assert.equal(input.from, "2026-10-19T16:00:00.000Z"); assert.equal(input.before, "2026-10-20T16:00:00.000Z");
    assert.equal(input.query, undefined); assert.equal(input.scheduleMatch, undefined);
  }
  assert.deepEqual(f.evidenceReads.map((read) => read.sourceMessageIds.length), [30, 30, 30]);
  assert.equal(f.saved.length, 0);
});

test("filtered pagination retains matches within raw page boundaries without repeats or omissions", async () => {
  const sources = Array.from({ length: 75 }, (_, index) => numberedSource(index, index % 2 === 0 ? "ＮＥＥＤＬＥ" : ""));
  const f = harness({ readPage: pagedSources(sources) });
  const first = await (await f.handlers.GET(new Request("https://synthetic.invalid/api?query=needle"))).json();
  assert.equal(first.total, 38); assert.equal(first.drafts.length, 30); assert.equal(first.nextCursor, sources[58].sourceMessageId);
  const second = await (await f.handlers.GET(new Request(`https://synthetic.invalid/api?query=needle&cursor=${first.nextCursor}`))).json();
  assert.equal(second.total, 38); assert.equal(second.drafts.length, 8); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.drafts, ...second.drafts].map((source: { id: string }) => source.id), sources.filter((_, index) => index % 2 === 0).map((source) => source.id));
  assert.equal(f.reads.length, 6);
});

test("schedule filters include visible candidates and exclude nontrial handovers from both states", async () => {
  const sources = Array.from({ length: 4 }, (_, index) => numberedSource(index));
  sources[3] = { ...sources[3], messages: [{ ...sources[3].messages[0], text: "老生LP修改 信息交接\n【学生姓名】：Synthetic Child\n【涉及科目】：English\n【变动内容】：Synthetic update" }] };
  const f = harness({ readPage: pagedSources(sources), evidence: [
    scheduleEvidence(sources[0], "matched"), scheduleEvidence(sources[1], "candidate"), scheduleEvidence(sources[2], "no_match"),
  ] });
  const matched = await (await f.handlers.GET(new Request("https://synthetic.invalid/api?scheduleMatch=matched&query=synthetic"))).json();
  assert.equal(matched.total, 2);
  assert.deepEqual(matched.drafts.map((source: { id: string }) => source.id), sources.slice(0, 2).map((source) => source.id));
  assert.equal(matched.drafts[1].trialSchedule, undefined);
  assert.equal(matched.drafts[1].scheduleEvidence.candidates.length, 1);
  const unmatched = await (await f.handlers.GET(new Request("https://synthetic.invalid/api?scheduleMatch=unmatched"))).json();
  assert.equal(unmatched.total, 1); assert.equal(unmatched.drafts[0].id, sources[2].id);
  assert.equal(f.saved.length, 0);
});

test("schedule outages cannot classify handovers as having no small timetable", async () => {
  const f = harness({ evidenceError: true });
  for (const scheduleMatch of ["matched", "unmatched"]) {
    const response = await f.handlers.GET(new Request(`https://synthetic.invalid/api?scheduleMatch=${scheduleMatch}`));
    const body = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(body.drafts, []); assert.equal(body.total, 0);
  }
  const all = await (await f.handlers.GET(new Request("https://synthetic.invalid/api?query=Synthetic"))).json();
  assert.equal(all.total, 1); assert.equal(all.drafts[0].scheduleEvidenceUnavailable, true);
});

test("text search finds resolved roster names and visible ownership without creating records", async () => {
  const original = harness().source;
  const f = harness({ source: { ...original, studentName: null, messages: [{ ...original.messages[0], text: original.messages[0].text }], coursePlanner: "Eileen" } });
  for (const query of ["Synthetic Child", "synthetic parent", "Ella", "EILEEN", "Y8 English", "English   Synthetic_Parent", "试听 LP"]) {
    const response = await f.handlers.GET(new Request(`https://synthetic.invalid/api?query=${encodeURIComponent(query)}`));
    const body = await response.json();
    assert.equal(body.total, 1, query);
  }
  assert.equal(f.saved.length, 0);
});

test("invalid and unstable filtered cursors fail safely without partial results", async () => {
  const sources = [numberedSource(0, "Needle"), numberedSource(1, "Needle")];
  const absent = harness({ readPage: pagedSources(sources) });
  assert.equal((await absent.handlers.GET(new Request("https://synthetic.invalid/api?query=needle&cursor=missing-source"))).status, 400);
  const duplicate = harness({ readPage: () => ({ rows: [sources[0], sources[0]], nextCursor: null, total: 2 }) });
  let read = 0;
  const repeated = harness({ readPage: () => ({ rows: [sources[read++]], nextCursor: sources[0].sourceMessageId, total: 90 }) });
  const empty = harness({ readPage: () => ({ rows: [], nextCursor: "empty-page", total: 90 }) });
  for (const f of [duplicate, repeated, empty]) {
    const response = await f.handlers.GET(new Request("https://synthetic.invalid/api?query=needle"));
    assert.equal(response.status, 503); assert.equal((await response.json()).code, "invalid_draft_page");
    assert.equal(f.saved.length, 0);
  }
  const teacher = harness({ session: { user: "Synthetic Teacher", role: "teacher" } });
  assert.equal((await teacher.handlers.GET(new Request("https://synthetic.invalid/api?query=needle&scheduleMatch=unmatched"))).status, 403);
  assert.equal(teacher.reads.length, 0);
});

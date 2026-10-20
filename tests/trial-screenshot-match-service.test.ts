import assert from "node:assert/strict";
import test from "node:test";
import { createTrialScreenshotMatchHandler } from "../lib/trial-screenshot-match-service";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import type { JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "../lib/ops-store";
import type { WecomLpDraftRawSource } from "../lib/wecom-lp-intake";

const revision = `sha256:${"a".repeat(64)}`;
const evidence = { sourceDate: "2026-10-20", startTime: "09:00", endTime: "10:00", teacherName: "Synthetic Teacher", courseName: "English - Synthetic Child试听", sharedAccountLetter: "a" };
const target = { lpItemId: "LP-1" };
const draftTarget = { caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceMessageId: "synthetic-handover-1", sourceRevision: "b".repeat(64) };
const event = { eventId: "jwb-open-api:schedule:1", sourceDate: evidence.sourceDate, startsAt: "2026-10-19T22:00:00.000Z", endsAt: "2026-10-19T23:00:00.000Z", courseName: evidence.courseName, sourceTeacherId: "7", sourceTeacherLabel: evidence.teacherName, sourceParticipants: [{ memberId: "8001", label: "试听学员A" }], sourceStudentsTruncated: false };
const snapshot: JiaowubaoOpenApiScheduleSnapshotWindow = { state: "complete", freshness: "fresh", revision, publishedAt: "2026-10-19T22:00:00.000Z", sourceWindow: { start: "2026-10-19", end: "2026-10-30" }, events: [], invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false };
function harness(options: { fullAdmin?: boolean; session?: DemoSessionIdentity; source?: WecomLpDraftRawSource | null; students?: Record<string, unknown>[]; lp?: Record<string, unknown>; events?: typeof event[]; snapshot?: JiaowubaoOpenApiScheduleSnapshotWindow; error?: unknown } = {}) {
  const rows: OpsStateRow[] = ["students", "lpItems", "tasks", "files"].map((entity) => ({ entity, version: 1, updated_at: event.startsAt, updated_by: "synthetic", payload: entity === "students" ? options.students ?? [{ id: "STU-1", name: "Synthetic Child", guardianWechat: "Synthetic Parent", owner: "Ella" }] : entity === "lpItems" ? [options.lp ?? { id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", fields: { responsibleOperations: "Ella", studentNameKnown: true, studentName: "Synthetic Child" } }] : [] }));
  const source: WecomLpDraftRawSource = { id: draftTarget.sourceMessageId, ...draftTarget, wechatName: "Synthetic Parent", studentName: "Synthetic Child", operationsOwner: "Ella", coursePlanner: "Eileen", status: "identified", createdAt: event.startsAt, messages: [], confirmed: null };
  const reads: unknown[] = [];
  const handler = createTrialScreenshotMatchHandler({
    readSession: async () => ({ session: options.session ?? { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"] }, fullAdmin: options.fullAdmin ?? false }),
    readRows: async () => rows,
    readDraft: async () => { reads.push("draft"); return options.source === undefined ? source : options.source; },
    readSnapshot: async (input) => { reads.push(["snapshot", input]); return options.snapshot ?? snapshot; },
    readSource: async (...args) => { reads.push(["source", ...args]); if (options.error) throw options.error; return options.events ?? [event]; },
  });
  const post = (input: unknown = { target, evidence }) => handler(new Request("https://synthetic.invalid/api", { method: "POST", body: JSON.stringify(input) }));
  return { post, handler, reads, source, rows };
}
test("exact source candidates contain only the reviewed fields and never mutate state", async () => {
  const f = harness({ events: [{ ...event, sourceParticipants: [...event.sourceParticipants, { memberId: "private-id", label: "Private Other Student" }], price: "private-price", raw: "private-raw" } as typeof event] });
  const before = JSON.stringify(f.rows);
  const response = await f.post();
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.candidates.length, 1);
  assert.deepEqual(Object.keys(body.candidates[0]).sort(), ["eventId", "sourceRevision", "sourceDate", "startsAt", "endsAt", "teacherName", "courseName", "studentNameHint", "sharedAccountLabel", "sharedAccountLetter", "durationMinutes"].sort());
  assert.equal(body.candidates[0].durationMinutes, 60); assert.equal(body.candidates[0].sharedAccountLetter, "a");
  assert.equal(body.ambiguous, false); assert.equal(body.coverage.timeZone, "Australia/Melbourne");
  assert.deepEqual(body.coverage.requestedWindow, { startsAt: "2026-10-19T13:00:00.000Z", endsAt: "2026-10-20T13:00:00.000Z" });
  assert.doesNotMatch(JSON.stringify(body), /private-id|Private Other|private-price|private-raw|sourceParticipants/);
  assert.equal(JSON.stringify(f.rows), before); assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("Vary"), "Cookie");
});
test("NFKC, case and whitespace normalization require exact teacher, course and calendar times", async () => {
  const f = harness();
  assert.equal((await (await f.post({ target, evidence: { ...evidence, teacherName: "Ｓｙｎｔｈｅｔｉｃ  Teacher", courseName: "english - synthetic child试听" } })).json()).candidates.length, 1);
  for (const difference of [{ teacherName: "Other Teacher" }, { courseName: "English" }, { startTime: "09:01" }, { endTime: "10:01" }, { sourceDate: "2026-10-21" }, { sharedAccountLetter: "b" }]) {
    assert.equal((await (await f.post({ target, evidence: { ...evidence, ...difference } })).json()).candidates.length, 0);
  }
});
test("teachers, restricted sessions and cross-owner targets cannot read global source", async () => {
  for (const f of [harness({ session: { user: "Ella", role: "teacher" } }), harness({ session: { user: "Ella", role: "staff", permissions: ["operations.read"] } }), harness({ session: { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"], scopeMembers: [{ kind: "student", key: "STU-1" }] } }), harness({ students: [{ id: "STU-1", name: "Synthetic Child", owner: "Tiffany" }] }), harness({ lp: { id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", fields: { responsibleOperations: "Tiffany" } } })]) {
    assert.equal((await f.post()).status, 403); assert.equal(f.reads.length, 0);
  }
});
test("source case identity, owner and revision are checked before global schedule access", async () => {
  const base = harness().source;
  for (const [source, status] of [[null, 404], [{ ...base, operationsOwner: "Tiffany" }, 403], [{ ...base, sourceRevision: "c".repeat(64) }, 409], [{ ...base, caseId: "other" }, 404], [{ ...base, status: "identity_conflict" }, 409]] as const) {
    const f = harness({ source }); assert.equal((await f.post({ target: draftTarget, evidence })).status, status); assert.deepEqual(f.reads, ["draft"]);
  }
  const f = harness(); assert.equal((await f.post({ target: draftTarget, evidence })).status, 200);
});
test("unknown ordinary targets need identity; full admins can inspect exact screenshot evidence", async () => {
  const options = { students: [{ id: "STU-1", name: "Synthetic Parent", guardianWechat: "Synthetic Parent", owner: "Ella" }], lp: { id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", fields: { studentNameKnown: false } } };
  const f = harness(options); const body = await (await f.post()).json();
  assert.equal(body.reason, "needs_identity"); assert.deepEqual(f.reads, []);
  const admin = harness({ ...options, fullAdmin: true }); assert.equal((await (await admin.post()).json()).candidates.length, 1);
});
test("ordinary staff never receive a different student's candidate or title-derived name", async () => {
  const other = { ...event, courseName: "English - Other Child试听", sourceParticipants: [{ memberId: "other", label: "Other Child" }] };
  const f = harness({ events: [other] }); const body = await (await f.post({ target, evidence: { ...evidence, courseName: other.courseName, sharedAccountLetter: undefined } })).json();
  assert.deepEqual(body.candidates, []);
  const direct = harness({ students: [{ id: "STU-1", name: "Synthetic Child", owner: "Ella", jwbSourceRow: "8001" }], events: [{ ...event, courseName: "Generic English Course", sourceParticipants: [{ memberId: "8001", label: "Synthetic Child" }] }] });
  const requestEvidence = { ...evidence, courseName: "Generic English Course" }; delete (requestEvidence as Partial<typeof evidence>).sharedAccountLetter;
  assert.equal((await (await direct.post({ target, evidence: requestEvidence })).json()).candidates.length, 1);
});
test("ambiguity is retained and candidates are capped at five only after a complete source read", async () => {
  const f = harness({ events: Array.from({ length: 7 }, (_, i) => ({ ...event, eventId: `jwb-open-api:schedule:${i}` })) });
  const body = await (await f.post()).json(); assert.equal(body.candidates.length, 5); assert.equal(body.ambiguous, true); assert.equal(body.hasMore, true);
});
test("stale complete coverage is explicit; absent/outside publications return no candidates", async () => {
  const f = harness({ snapshot: { ...snapshot, state: "stale", freshness: "stale" } }); const body = await (await f.post()).json();
  assert.equal(body.coverage.freshness, "stale"); assert.equal(body.candidates.length, 1);
  assert.deepEqual((f.reads[1] as unknown[])[4], snapshot.sourceWindow);
  for (const source of [{ ...snapshot, state: "absent" as const, revision: null, sourceWindow: null }, { ...snapshot, sourceWindow: { start: "2026-10-21", end: "2026-10-30" } }]) {
    const f = harness({ snapshot: source }); const body = await (await f.post()).json(); assert.equal(body.coverage.complete, false); assert.deepEqual(body.candidates, []); assert.equal(f.reads.length, 1);
  }
});
test("source reset or incomplete paging fails closed without leaking upstream payloads", async () => {
  for (const code of ["source_changed", "40001", "other"]) {
    const f = harness({ error: Object.assign(new Error("private-source-payload"), { code }) });
    const response = await f.post(); assert.equal(response.status, code === "other" ? 503 : 409); assert.doesNotMatch(JSON.stringify(await response.json()), /private-source/);
  }
});
test("malformed evidence, extra privileges and oversized bodies are rejected before data reads", async () => {
  for (const input of [{ target, evidence, fullAdmin: true }, { target: { ...target, studentId: "STU-1" }, evidence }, { target, evidence: { ...evidence, sourceDate: "2026-02-30" } }, { target, evidence: { ...evidence, endTime: "08:00" } }, { target, evidence: { ...evidence, startTime: "9:00" } }, { target, evidence: { ...evidence, sharedAccountLetter: "d" } }, { target, evidence: { ...evidence, teacherName: "x".repeat(241) } }]) {
    const f = harness(); assert.equal((await f.post(input)).status, 400); assert.deepEqual(f.reads, []);
  }
  const f = harness(); assert.equal((await f.handler(new Request("https://synthetic.invalid", { method: "POST", body: "x".repeat(8193) }))).status, 413); assert.deepEqual(f.reads, []);
});
test("Melbourne DST days use calendar bounds instead of an assumed 24-hour interval", async () => {
  const f = harness({ snapshot: { ...snapshot, sourceWindow: { start: "2026-10-01", end: "2026-10-30" } } });
  const body = await (await f.post({ target, evidence: { ...evidence, sourceDate: "2026-10-04" } })).json();
  assert.deepEqual(body.coverage.requestedWindow, { startsAt: "2026-10-03T14:00:00.000Z", endsAt: "2026-10-04T13:00:00.000Z" });
});

test("only full admins may hand-review a unique exact time, teacher and shared-account match when OCR course text differs", async () => {
  const altered = { ...evidence, courseName: "English - garbled OCR title" };
  const admin = harness({ fullAdmin: true });
  const body = await (await admin.post({ target, evidence: altered })).json();
  assert.equal(body.candidates.length, 1); assert.equal(body.candidates[0].courseName, event.courseName);
  assert.deepEqual((await (await harness().post({ target, evidence: altered })).json()).candidates, []);
  const ambiguous = harness({ fullAdmin: true, events: [event, { ...event, eventId: "jwb-open-api:schedule:2", courseName: "Other trusted title" }] });
  const multiple = await (await ambiguous.post({ target, evidence: altered })).json();
  assert.deepEqual(multiple.candidates, []); assert.equal(multiple.ambiguous, true);
  const noAccount = { ...altered }; delete (noAccount as Partial<typeof altered>).sharedAccountLetter;
  assert.deepEqual((await (await admin.post({ target, evidence: noAccount })).json()).candidates, []);
});

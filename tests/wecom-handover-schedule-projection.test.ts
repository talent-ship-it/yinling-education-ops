import assert from "node:assert/strict";
import test from "node:test";
import type { OpsStateRow } from "../lib/ops-store";
import type { WecomLpDraftRawSource } from "../lib/wecom-lp-intake";
import type { WecomHandoverScheduleEvent, WecomHandoverScheduleInput } from "../lib/wecom-handover-schedule-types";
import { prepareWecomHandoverScheduleProjection } from "../lib/wecom-handover-schedule-projection";

const checkedAt = "2026-10-21T00:00:00.000Z";
const teacher = { id: "TEA-1", name: "Synthetic Teacher" };
const child = { id: "STU-1", name: "Child One", guardianWechat: "Parent One", jwbSourceRow: "member-1", owner: "Ella", planner: "Eileen" };
const other = { id: "STU-2", name: "Child Two", guardianWechat: "Parent Two", jwbSourceRow: "member-2", owner: "Ella", planner: "Eileen" };
const currentCoverage = [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", historical: false }];
function source(id = "handover-1", patch: Partial<WecomLpDraftRawSource> = {}): WecomLpDraftRawSource {
  return { id, sourceMessageId: id, caseId: `case-${id}`, sourceRevision: "a".repeat(64), wechatName: "Parent One@教务AI助手", studentName: null, operationsOwner: "Ella", coursePlanner: "Eileen", status: "awaiting_student_name", createdAt: "2026-10-20T00:00:00.000Z", confirmed: null,
    messages: [{ messageId: id, text: "【家长微信名】：Parent One@教务AI助手\n【安排教师】：Synthetic Teacher\n【安排科目】：Y8 English\n【课程规划】：Eileen", sentAt: "2026-10-20T00:00:00.000Z" }], ...patch };
}
function messageSource(id: string, guardian: string, extra = "", patch: Partial<WecomLpDraftRawSource> = {}) {
  return source(id, { wechatName: guardian, messages: [{ messageId: id, text: `【家长微信名】：${guardian}\n【安排教师】：Synthetic Teacher\n【安排科目】：Y8 English\n【课程规划】：Eileen${extra}`, sentAt: "2026-10-20T00:00:00.000Z" }], ...patch });
}
function event(id = "event-1", patch: Partial<WecomHandoverScheduleEvent> = {}): WecomHandoverScheduleEvent {
  return { eventId: id, sourceDate: "2026-10-22", startsAt: "2026-10-22T08:00:00.000Z", endsAt: "2026-10-22T09:00:00.000Z", courseName: "Child One - English试听", sourceTeacherId: "jwb-teacher-1", sourceTeacherLabel: "Synthetic Teacher", sourceParticipants: [{ memberId: "shared-b", label: "试听学员B2026" }], sourceStudentsTruncated: false, sourceRevision: `sha256:${"b".repeat(64)}`, sourceRunId: "run-1", historical: false, ...patch };
}
function rows(students: Record<string, unknown>[] = [child], lpItems: Record<string, unknown>[] = [], teachers: Record<string, unknown>[] = [teacher]): OpsStateRow[] {
  return [{ entity: "students", payload: students }, { entity: "teachers", payload: teachers }, { entity: "lpItems", payload: lpItems }].map((row) => ({ ...row, version: 1, updated_at: checkedAt, updated_by: "synthetic" }));
}
function input(patch: Partial<WecomHandoverScheduleInput> = {}): WecomHandoverScheduleInput {
  return { snapshotRevision: `sha256:${"c".repeat(64)}`, inputRevision: "1", targetSourceMessageIds: ["handover-1"], sources: [source()], rows: rows(), coverage: currentCoverage, events: [event()], checkedAt, ...patch };
}
function project(patch: Partial<WecomHandoverScheduleInput> = {}) { return prepareWecomHandoverScheduleProjection(input(patch))[0]!; }

test("a unique exact family and current full-source event produce reproducible immutable evidence", () => {
  const data = input();
  const before = JSON.stringify(data);
  const result = prepareWecomHandoverScheduleProjection(data)[0]!;
  assert.equal(result.status, "matched");
  assert.equal(result.matchedStudentId, child.id);
  assert.equal(result.sourceRevision, data.sources[0]!.sourceRevision);
  assert.equal(result.checkedAt, checkedAt);
  assert.equal(result.candidates[0]!.sourceRunId, "run-1");
  assert.deepEqual(result.candidates[0]!.schedule, { source: "jiaowubao-open-api", sourceRevision: event().sourceRevision, eventId: "event-1", startsAt: event().startsAt, endsAt: event().endsAt, courseName: event().courseName, studentName: child.name, teacherId: teacher.id, teacherName: teacher.name, plannerHint: "Eileen", sharedAccountLabel: "试听学员B2026", sharedAccountLetter: "b", durationMinutes: 60, matchedAt: checkedAt });
  assert.deepEqual(prepareWecomHandoverScheduleProjection(data), [result]);
  assert.equal(JSON.stringify(data), before);
});

test("new competing messages invalidate an unchanged source even when only that source is targeted", () => {
  assert.equal(project().status, "matched");
  const rival = messageSource("handover-2", "Unlinked Parent");
  const result = project({ inputRevision: "2", sources: [source(), rival] });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.sourceRevision, source().sourceRevision);
  assert.equal(result.matchedStudentId, null);
  assert.equal(prepareWecomHandoverScheduleProjection(input({ targetSourceMessageIds: ["handover-2"], sources: [source(), rival] })).length, 1);
});

test("a later roster identity can match without rewriting the original message", () => {
  const unknown = messageSource("handover-1", "New Parent");
  assert.equal(project({ sources: [unknown] }).status, "candidate");
  const result = project({ inputRevision: "2", sources: [unknown], rows: rows([{ ...child, guardianWechat: "New Parent" }]) });
  assert.equal(result.status, "matched");
  assert.equal(result.sourceRevision, unknown.sourceRevision);
});

test("an explicit complete name or a consistent linked student ID is a strong anchor", () => {
  for (const candidate of [messageSource("handover-1", "New Parent", "\n【姓名】：Child One", { studentName: child.name }), source("handover-1", { messages: source().messages.map((message) => ({ ...message, studentId: child.id })) })]) {
    assert.equal(project({ sources: [candidate] }).status, "matched");
  }
  assert.notEqual(project({ sources: [messageSource("handover-1", "New Parent", "\n【姓名】：Child", { studentName: "Child" })] }).status, "matched");
});

test("no identity anchor can at most show a candidate and generic accounts never become identities", () => {
  for (const guardian of ["New Parent", "-@教务AI助手"]) {
    const result = project({ sources: [messageSource("handover-1", guardian)] });
    assert.equal(result.status, "candidate");
    assert.equal(result.matchedStudentId, null);
    assert.equal(result.candidates[0]!.studentId, child.id);
  }
  const generic = { ...child, name: "试听学员B2026", guardianWechat: "New Parent" };
  const result = project({ sources: [messageSource("handover-1", "Unknown Parent")], rows: rows([generic]), events: [event("event-1", { courseName: "English试听" })] });
  assert.equal(result.status, "needs_identity");
  assert.equal(result.candidates.length, 0);
});

test("siblings prevent guardian-only automatic binding", () => {
  const sibling = { ...other, guardianWechat: child.guardianWechat };
  const result = project({ rows: rows([child, sibling]) });
  assert.equal(result.status, "candidate");
  assert.equal(result.matchedStudentId, null);
  assert.equal(result.candidates[0]!.studentId, child.id);
  const named = source("handover-1", { studentName: child.name });
  assert.equal(project({ rows: rows([child, sibling]), sources: [named] }).status, "matched");
});

test("global hidden same-name students and conflicting member/name proofs fail closed", () => {
  const sameName = { ...other, name: child.name };
  for (const patch of [
    { rows: rows([child, sameName]) },
    { rows: rows([child, other]), events: [event("event-1", { sourceParticipants: [{ memberId: "member-1", label: "Child Two" }, { memberId: "shared-b", label: "试听学员B2026" }] })] },
    { rows: rows([child, { ...other, jwbSourceRow: "member-1" }]), events: [event("event-1", { sourceParticipants: [{ memberId: "member-1", label: "Child One" }] })] },
    { events: [event("event-1", { sourceParticipants: [{ memberId: "unmapped-other-member", label: "Child One" }] })] },
  ]) {
    const result = project(patch);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedStudentId, null);
    assert.equal(result.candidates.length, 0);
  }
});

test("DJ/J original guardian mismatch and source identity conflicts suppress every candidate", () => {
  const mismatch = messageSource("handover-1", "DJ");
  const candidates = [{ ...mismatch, wechatName: "J" }, source("handover-1", { status: "identity_conflict" }), source("handover-1", { status: "identity_ambiguous" }), source("handover-1", { studentName: "Different Child" }), source("handover-1", { messages: [...source().messages, { messageId: "second", sentAt: checkedAt, text: "", studentId: other.id }, { messageId: "third", sentAt: checkedAt, text: "", studentId: child.id }] })];
  for (const candidate of candidates) {
    const result = project({ sources: [candidate], rows: rows([child, other]) });
    assert.equal(result.status, "identity_conflict");
    assert.equal(result.candidates.length, 0);
  }
});

test("whole-name matching never equates J with DJ", () => {
  const students = [{ ...child, name: "J" }, { ...other, name: "DJ" }];
  const result = project({ rows: rows(students), events: [event("event-1", { courseName: "DJ - English试听" })] });
  assert.equal(result.status, "no_match");
  assert.equal(result.candidates.length, 0);
});

test("both persisted LP ownership and an existing eligible LP reserve an event", () => {
  for (const lp of [
    { id: "LP-1", studentId: child.id, trialSchedule: { eventId: "event-1" } },
    { id: "LP-1", studentId: child.id, trialScheduleReview: { source: "screenshot-review", eventId: "event-1" } },
    { id: "LP-1", studentId: child.id, workflowType: "试听 LP", requestedAt: source().createdAt, stage: "待排课" },
  ]) {
    const result = project({ rows: rows([child], [lp]) });
    assert.equal(result.status, "no_match");
    assert.equal(result.candidates.length, 0);
  }
});

test("multiple source events stay ambiguous before the presentation cap", () => {
  const events = Array.from({ length: 9 }, (_, index) => event(`event-${index + 1}`, { startsAt: `2026-10-${String(index + 22).padStart(2, "0")}T08:00:00.000Z`, endsAt: `2026-10-${String(index + 22).padStart(2, "0")}T09:00:00.000Z` }));
  const result = project({ events });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 8);
  assert.equal(result.matchedStudentId, null);
});

test("candidate matching needs teacher, subject, planner and a nearby handover", () => {
  const unknown = messageSource("handover-1", "New Parent");
  for (const wrong of [
    event("event-1", { sourceTeacherLabel: "Different Teacher" }),
    event("event-1", { courseName: "Child One - Math试听" }),
    event("event-1", { sourceParticipants: [{ memberId: "shared-a", label: "试听学员A2026" }] }),
    event("event-1", { sourceParticipants: [{ memberId: "member-1", label: "Child One" }] }),
    event("event-1", { startsAt: "2026-11-21T08:00:00.000Z", endsAt: "2026-11-21T09:00:00.000Z" }),
  ]) {
    const result = project({ sources: [unknown], events: [wrong] });
    assert.equal(result.status, "needs_identity");
    assert.equal(result.candidates.length, 0);
  }
});

test("combined subjects allow English/Math candidates without matching fragments inside student names", () => {
  const unknown = messageSource("handover-1", "New Parent");
  const combined = { ...unknown, messages: unknown.messages.map((message) => ({ ...message, text: message.text.replace("Y8 English", "Y8EnglishMath") })) };
  for (const subject of ["English", "Math"]) assert.equal(project({ sources: [combined], events: [event("event-1", { courseName: `Child One - ${subject}试听` })] }).status, "candidate");
  const math = { ...unknown, messages: unknown.messages.map((message) => ({ ...message, text: message.text.replace("Y8 English", "Math") })) };
  assert.equal(project({ sources: [math], rows: rows([{ ...child, name: "Mathilda" }]), events: [event("event-1", { courseName: "Mathilda - English试听" })] }).candidates.length, 0);
});

test("composite teacher first names support candidates only when each native alias is unique", () => {
  const teachers = [{ id: "TEA-1", name: "Sharyn Smith" }, { id: "TEA-2", name: "Kelly Jones" }];
  const composite = source("handover-1", { messages: source().messages.map((message) => ({ ...message, text: message.text.replace("Synthetic Teacher", "Sharyn Kelly") })) });
  const result = project({ sources: [composite], rows: rows([child], [], teachers), events: [event("event-1", { sourceTeacherLabel: "Sharyn Smith" })] });
  assert.equal(result.status, "candidate");
  assert.equal(result.matchedStudentId, null);
  assert.equal(result.candidates[0]!.schedule.teacherId, "TEA-1");
  const short = project({ sources: [composite], rows: rows([child], [], teachers), events: [event("event-1", { sourceTeacherLabel: "Sharyn" })] });
  assert.equal(short.status, "candidate");
  assert.equal(short.candidates[0]!.schedule.teacherId, null);
  assert.equal(short.candidates[0]!.schedule.teacherName, "Sharyn");
  assert.equal(project({ sources: [composite], rows: rows([child], [], [...teachers, { id: "TEA-3", name: "Sharyn Other" }]), events: [event("event-1", { sourceTeacherLabel: "Sharyn Smith" })] }).candidates.length, 0);
});

test("reschedules use the current snapshot and a canceled historical future event never returns", () => {
  const old = event("old-event", { startsAt: "2026-10-23T08:00:00.000Z", endsAt: "2026-10-23T09:00:00.000Z", historical: true });
  const coverage = [...currentCoverage, { ...currentCoverage[0]!, historical: true }];
  const moved = project({ coverage, events: [old, event("moved-event")] });
  assert.equal(moved.status, "matched");
  assert.equal(moved.candidates[0]!.schedule.eventId, "moved-event");
  const canceled = project({ coverage, events: [old] });
  assert.equal(canceled.status, "no_match");
  assert.equal(canceled.candidates.length, 0);
});

test("past historical events are candidates and current date coverage supersedes history", () => {
  const oldSource = source("handover-1", { createdAt: "2026-10-01T00:00:00.000Z", messages: source().messages.map((message) => ({ ...message, sentAt: "2026-10-01T00:00:00.000Z" })) });
  const old = event("past-event", { startsAt: "2026-10-03T08:00:00.000Z", endsAt: "2026-10-03T09:00:00.000Z", historical: true });
  const coverage = [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z", historical: true }, { startsAt: "2026-10-15T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", historical: false }];
  const result = project({ sources: [oldSource], coverage, events: [old] });
  assert.equal(result.status, "candidate");
  assert.equal(result.matchedStudentId, null);
  assert.equal(result.candidates[0]!.schedule.eventId, "past-event");
  assert.equal(project({ sources: [oldSource], coverage: [...coverage, ...currentCoverage], events: [old] }).candidates.length, 0);
});

test("coverage gaps cannot prove absence or automatic uniqueness", () => {
  const coverage = [{ startsAt: "2026-10-21T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z", historical: false }];
  assert.equal(project({ coverage }).status, "candidate");
  assert.equal(project({ coverage, events: [] }).status, "outside_window");
  assert.equal(project({ coverage: currentCoverage.map((window) => ({ ...window, historical: true })) }).status, "outside_window");
  assert.equal(project({ events: [] }).status, "no_match");
});

test("truncated participants and uncertain competing events cannot prove a match", () => {
  const truncated = event("truncated", { sourceStudentsTruncated: true, sourceParticipants: [] });
  const only = project({ events: [truncated] });
  assert.equal(only.status, "ambiguous");
  assert.equal(only.candidates.length, 0);
  const result = project({ events: [event(), truncated] });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.matchedStudentId, null);
});

test("multiple real students or conflicting shared planner accounts cannot auto-bind", () => {
  const group = event("group", { courseName: "English试听", sourceParticipants: [{ memberId: "member-1", label: child.name }, { memberId: "member-2", label: other.name }, { memberId: "shared-b", label: "试听学员B2026" }] });
  assert.equal(project({ rows: rows([child, other]), events: [group] }).status, "candidate");
  const shared = event("shared", { sourceParticipants: [{ memberId: "shared-a", label: "试听学员A2026" }, { memberId: "shared-b", label: "试听学员B2026" }] });
  assert.notEqual(project({ events: [shared] }).status, "matched");
  assert.equal(project({ events: [shared] }).candidates.length, 0);
});

test("direct nonshared member evidence maps only the exact internal student and keeps nullable source metadata", () => {
  const direct = event("direct", { sourceParticipants: [{ memberId: "member-1", label: child.name }] });
  const result = project({ events: [direct] });
  assert.equal(result.status, "matched");
  assert.equal(result.candidates[0]!.schedule.plannerHint, null);
  assert.equal(result.candidates[0]!.schedule.sharedAccountLabel, null);
  assert.equal(result.candidates[0]!.schedule.sharedAccountLetter, null);
  assert.notEqual(result.candidates[0]!.schedule.teacherId, direct.sourceTeacherId);
});

test("invalid authority, duplicate events, invalid clocks and oversized targets fail closed", () => {
  assert.throws(() => project({ rows: rows().filter((row) => row.entity !== "students") }), /authority/);
  assert.throws(() => project({ checkedAt: "invalid" }), /clock/);
  assert.throws(() => project({ events: [event("invalid", { startsAt: "invalid" })] }), /source time/);
  assert.throws(() => project({ sources: [source(), source()] }), /targets/);
  assert.throws(() => project({ targetSourceMessageIds: Array.from({ length: 51 }, (_, index) => `source-${index}`) }), /targets/);
  assert.throws(() => project({ targetSourceMessageIds: ["unknown"] }), /targets/);
  assert.equal(project({ events: [event(), event()] }).status, "ambiguous");
});


test("ordinary lessons and contradictory scheduling fields never become a confirmed trial", () => {
  const ordinary = event("ordinary", { courseName: "Child One - English", sourceParticipants: [{ memberId: "member-1", label: child.name }] });
  assert.equal(project({ events: [ordinary] }).status, "no_match");
  const minimal = source("handover-1", { messages: [{ messageId: "handover-1", sentAt: source().createdAt, text: "【家长微信名】：Parent One" }] });
  assert.equal(project({ sources: [minimal], events: [ordinary] }).status, "no_match");
  const conflicting = source("handover-1", { messages: [...source().messages, { messageId: "follow-up", text: "【安排教师】：Different Teacher", sentAt: checkedAt }] });
  const result = project({ sources: [conflicting] });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 0);
});


test("teacher identity keeps word boundaries and candidate names preserve the native display value", () => {
  const exactTeacher = { id: "TEA-1", name: "Ann A" };
  const candidate = source("handover-1", { messages: source().messages.map((message) => ({ ...message, text: message.text.replace("Synthetic Teacher", "Ann A") })) });
  assert.equal(project({ sources: [candidate], rows: rows([child], [], [exactTeacher]), events: [event("event-1", { sourceTeacherLabel: "Anna" })] }).candidates.length, 0);
  const native = { ...child, name: " Child One " };
  const result = project({ rows: rows([native]) });
  assert.equal(result.candidates[0]!.studentName, native.name);
  assert.equal(result.candidates[0]!.schedule.studentName, native.name);
});


test("conflicted drafts keep their potential claim in global contention while exposing no candidates", () => {
  for (const status of ["identity_conflict", "identity_ambiguous"] as const) {
    const rival = messageSource("handover-2", "Unknown Parent", "", { status });
    const result = prepareWecomHandoverScheduleProjection(input({ sources: [source(), rival], targetSourceMessageIds: ["handover-1", "handover-2"] }));
    assert.equal(result[0]!.status, "ambiguous");
    assert.equal(result[0]!.matchedStudentId, null);
    assert.equal(result[1]!.status, "identity_conflict");
    assert.equal(result[1]!.candidates.length, 0);
  }
  const rival = messageSource("handover-2", "Unknown Parent");
  const teacherConflict = { ...rival, messages: [...rival.messages, { messageId: "follow-up", text: "【安排教师】：Different Teacher", sentAt: checkedAt }] };
  assert.equal(project({ sources: [source(), teacherConflict] }).status, "ambiguous");
  const linkedConflict = source("handover-2", { status: "identity_conflict", messages: [{ messageId: "handover-2", text: "", sentAt: source().createdAt, studentId: child.id }] });
  assert.equal(project({ sources: [source(), linkedConflict] }).status, "ambiguous");
  const unrelated = messageSource("handover-2", "Unknown Parent", "", { status: "identity_conflict", createdAt: "2026-08-01T00:00:00.000Z", messages: source("handover-2").messages.map((message) => ({ ...message, sentAt: "2026-08-01T00:00:00.000Z" })) });
  assert.equal(project({ sources: [source(), unrelated] }).status, "matched");
});


test("missing real student names remain unresolved and unknown participant labels cannot override a member ID", () => {
  for (const name of ["Parent One", "Parent One@教务AI助手", "试听学员B2026", "待确认"]) {
    assert.equal(project({ rows: rows([{ ...child, name }]), events: [] }).status, "needs_identity");
  }
  const mismatched = event("member-label-mismatch", { sourceParticipants: [{ memberId: "member-1", label: "Different Unknown Child" }] });
  const result = project({ events: [mismatched] });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 0);
});


test("delayed ingestion uses the source message timestamp and explicit handover timestamps remain authoritative", () => {
  const archived = source("handover-1", { createdAt: "2026-11-01T00:00:00.000Z", messages: source().messages.map((message) => ({ ...message, sentAt: "2026-10-01T00:00:00.000Z" })) });
  const historical = event("historical", { startsAt: "2026-10-03T08:00:00.000Z", endsAt: "2026-10-03T09:00:00.000Z", historical: true });
  const coverage = [{ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z", historical: true }, { startsAt: "2026-10-15T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", historical: false }];
  const result = project({ sources: [archived], events: [historical], coverage });
  assert.equal(result.status, "candidate");
  assert.equal(result.candidates[0]!.schedule.eventId, "historical");
  const recent = { ...archived, messages: [...source().messages, { messageId: "different-source", sentAt: "2026-08-01T00:00:00.000Z", text: "" }] };
  assert.equal(project({ sources: [recent] }).status, "matched");
  assert.equal(project({ sources: [{ ...archived, handoverAt: source().createdAt }] }).status, "matched");
  for (const invalid of [{ ...archived, handoverAt: "invalid" }, { ...archived, handoverAt: "" }, { ...archived, messages: archived.messages.map((message) => ({ ...message, sentAt: "invalid" })) }]) {
    assert.throws(() => project({ sources: [invalid] }), /handover timestamp/);
  }
});

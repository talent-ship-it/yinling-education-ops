import assert from "node:assert/strict";
import test from "node:test";
import { createTrialScreenshotConfirmHandler, type TrialScreenshotConfirmationInput, type TrialScreenshotConfirmationResult } from "../lib/trial-screenshot-confirm-service";
import type { OpsStateRow, JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";

const revision = `sha256:${"a".repeat(64)}`;
const command = { commandKey: "8561c3da-e665-4cb1-a3b5-baa0aab15ea2", lpItemId: "LP-1", eventId: "jwb-open-api:schedule:1", sourceRevision: revision, sourceDate: "2026-10-20", expectedVersions: { students: 1, lpItems: 1, tasks: 1 } };
const event = { eventId: command.eventId, sourceDate: command.sourceDate, startsAt: "2026-10-19T22:00:00.000Z", endsAt: "2026-10-19T23:00:00.000Z", courseName: "English - Synthetic Child试听", sourceTeacherId: "7", sourceTeacherLabel: "Synthetic Teacher", sourceParticipants: [{ memberId: "8001", label: "试听学员A" }], sourceStudentsTruncated: false };
const snapshot: JiaowubaoOpenApiScheduleSnapshotWindow = { state: "complete", freshness: "fresh", revision, publishedAt: "2026-10-19T20:00:00.000Z", sourceWindow: { start: "2026-10-19", end: "2026-10-30" }, events: [], invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false };
function harness(options: { fullAdmin?: boolean; student?: Record<string, unknown>; lp?: Record<string, unknown>; events?: typeof event[]; snapshot?: JiaowubaoOpenApiScheduleSnapshotWindow; receipt?: TrialScreenshotConfirmationResult; commitError?: unknown } = {}) {
  const lp = options.lp ?? { id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", stage: "待跟进", requestedAt: "2026-10-19T01:00:00.000Z", trialPaid: true, ledger: { scheduledAt: "human-override", result: "human-result" }, fields: { responsibleOperations: "Ella", studentNameKnown: false, assignedTeacher: "Old Teacher", subject: "Keep subject", trialDurationMinutes: 45, trialPaymentMethod: "赠送" }, trialIntake: { planner: "Tara", requestSentAt: "2026-10-19T01:00:00.000Z", contactParents: true, contactStudent: false, writingRequired: false, paperRequired: false, trialDurationMinutes: 45 } };
  const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: event.startsAt, updated_by: "synthetic" });
  const done = { id: "DONE", studentId: "STU-1", title: "Synthetic done history", owner: "Ella", status: "done", ruleKey: "trial.jiaowubao.today", anchorBookingId: "JWB:old", requestAnchorBookingId: "LP-1", result: "human-done" };
  const rows = [row("students", [options.student ?? { id: "STU-1", name: "Synthetic Parent", guardianWechat: "Synthetic Parent", owner: "Ella", planner: "Tara" }]), row("lpItems", [lp]), row("tasks", [done]), row("files", []), row("teachers", [{ id: "T-1", name: "Synthetic Teacher" }]), row("bookings", [])];
  const calls: string[] = []; let saved: TrialScreenshotConfirmationInput | undefined;
  const handler = createTrialScreenshotConfirmHandler({
    readSession: async () => ({ session: { user: "Ella", role: "staff", permissions: ["operations.read", "operations.write"] }, fullAdmin: options.fullAdmin ?? true }),
    readRows: async () => rows, readDraft: async () => null,
    readSnapshot: async () => { calls.push("snapshot"); return options.snapshot ?? snapshot; },
    readSource: async () => { calls.push("source"); return options.events ?? [event]; },
    readReceipt: async () => { calls.push("receipt"); return options.receipt ? [options.receipt] : []; },
    commit: async (input) => { calls.push("commit"); saved = input; if (options.commitError) throw options.commitError; return [{ command_key: command.commandKey, applied: true, student_id: "STU-1", lp_item_id: "LP-1", lp_items_row: { ...rows[1]!, version: 3, payload: input.nextLpItems }, tasks_row: { ...rows[2]!, version: 2, payload: input.nextTasks }, audit_entry_id: "synthetic-audit" }]; },
    now: () => new Date("2026-10-19T02:00:00.000Z"),
  });
  return { rows, lp, calls, saved: () => saved, post: (input: unknown = command) => handler(new Request("https://synthetic.invalid", { method: "POST", body: JSON.stringify(input) })) };
}
test("confirmation derives trusted fields and exact event without changing student, subject, ledger, paid or done history", async () => {
  const f = harness(); const before = JSON.stringify(f.rows); const response = await f.post(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.committed, true); assert.ok(body.lpItemsRow); assert.ok(body.tasksRow); assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const saved = f.saved()!; const lp = saved.nextLpItems[0] as { fields: Record<string, unknown>; trialIntake: Record<string, unknown>; trialSchedule: Record<string, unknown>; trialScheduleReview: Record<string, unknown>; stage: unknown; trialPaid: unknown; ledger: unknown };
  assert.equal(lp.fields.assignedTeacher, event.sourceTeacherLabel); assert.equal(lp.fields.studentName, "Synthetic Child"); assert.equal(lp.fields.studentNameKnown, true); assert.equal(lp.fields.trialDurationMinutes, 60); assert.equal(lp.fields.subject, "Keep subject");
  assert.equal(lp.trialIntake.studentName, "Synthetic Child"); assert.equal(lp.trialIntake.trialDurationMinutes, 60); assert.equal(lp.trialSchedule.eventId, event.eventId); assert.equal(lp.trialSchedule.confirmation, "screenshot-review"); assert.equal(lp.stage, f.lp.stage); assert.equal(lp.trialPaid, true); assert.deepEqual(lp.ledger, f.lp.ledger);
  assert.equal(JSON.stringify(f.rows), before); assert.deepEqual(saved.expectedVersions, command.expectedVersions); assert.deepEqual(saved.nextTasks.find((task) => (task as Record<string, unknown>).id === "DONE"), (f.rows[2]!.payload as unknown[])[0]);
  assert.ok(saved.nextTasks.some((task) => (task as Record<string, unknown>).anchorBookingId === `JWB:${event.eventId}`));
});
test("receipt replay occurs before source freshness and obsolete versions without a second commit", async () => {
  const f = harness(); const receipt: TrialScreenshotConfirmationResult = { command_key: command.commandKey, applied: true, student_id: "STU-1", lp_item_id: "LP-1", lp_items_row: f.rows[1]!, tasks_row: f.rows[2]!, audit_entry_id: "audit" };
  const replay = harness({ receipt, snapshot: { ...snapshot, state: "stale", freshness: "stale" } }); const body = await (await replay.post({ ...command, expectedVersions: { students: 99, lpItems: 99, tasks: 99 } })).json();
  assert.equal(body.committed, true); assert.equal(body.applied, false); assert.deepEqual(replay.calls, ["receipt"]);
});
test("scope is checked before receipt or private source; ordinary unknown identity fails before commit", async () => {
  const denied = harness({ fullAdmin: false, student: { id: "STU-1", name: "Synthetic Child", owner: "Tiffany" } }); assert.equal((await denied.post()).status, 403); assert.deepEqual(denied.calls, []);
  const unknown = harness({ fullAdmin: false }); assert.equal((await unknown.post()).status, 403); assert.ok(!unknown.calls.includes("commit"));
});
test("known student mismatches, stale revision, version conflicts, different prior event and truncated source fail closed", async () => {
  const template = harness().lp;
  for (const f of [harness({ lp: { ...template, resultStatus: "已取消" } }), harness({ lp: { ...template, fields: { ...template.fields, studentNameKnown: true, studentName: "Other Child" } } }), harness({ snapshot: { ...snapshot, state: "stale", freshness: "stale" } }), harness({ events: [{ ...event, sourceStudentsTruncated: true }] }), harness({ lp: { ...template, trialSchedule: { eventId: "other" } } }), harness({ snapshot: { ...snapshot, revision: `sha256:${"b".repeat(64)}` } })]) {
    assert.equal((await f.post()).status, 409); assert.ok(!f.calls.includes("commit"));
  }
  const f = harness(); assert.equal((await f.post({ ...command, expectedVersions: { ...command.expectedVersions, students: 2 } })).status, 409); assert.deepEqual(f.calls, ["receipt"]);
});
test("non45/60 durations preserve restricted fields and unfamiliar course titles never create student names", async () => {
  const f = harness({ events: [{ ...event, endsAt: "2026-10-19T23:30:00.000Z", courseName: "Unfamiliar title without student" }] }); assert.equal((await f.post()).status, 200);
  const lp = f.saved()!.nextLpItems[0] as typeof f.lp & { fields: Record<string, unknown> }; assert.equal(lp.fields.trialDurationMinutes, 45); assert.equal(lp.fields.studentNameKnown, false); assert.equal(lp.trialIntake.trialDurationMinutes, 45);
});
test("invalid privileged payloads and uncertain outcomes never report success or leak private source", async () => {
  for (const input of [{ ...command, fullAdmin: true }, { ...command, sourceDate: "2026-02-30" }, { ...command, expectedVersions: { ...command.expectedVersions, students: 0 } }]) { const f = harness(); assert.equal((await f.post(input)).status, 400); assert.deepEqual(f.calls, []); }
  for (const code of ["23505", "40001", "42501", "unexpected"]) { const f = harness({ commitError: Object.assign(new Error("private raw payload"), { code }) }); const response = await f.post(); assert.equal(response.status, code === "42501" ? 403 : code === "unexpected" ? 503 : 409); const body = await response.json(); assert.equal(body.committed, undefined); assert.doesNotMatch(JSON.stringify(body), /private raw/); }
});
test("reviewed event pins survive cancellation and reserve the event against heuristic competitors", async () => {
  const f = harness(); assert.equal((await f.post()).status, 200);
  const saved = f.saved()!; const confirmed = saved.nextLpItems[0] as Record<string, unknown>;
  assert.deepEqual(confirmed.trialScheduleReview, { source: "screenshot-review", eventId: event.eventId });
  const rows = f.rows.map((row) => row.entity === "lpItems" ? { ...row, payload: [confirmed, { ...confirmed, id: "LP-2", trialScheduleReview: undefined, trialSchedule: undefined }] } : row);
  const { prepareJiaowubaoTrialSyncProjection } = await import("../lib/jiaowubao-trial-sync-projection");
  const run = (currentRows: OpsStateRow[], rawEvents: typeof event[]) => prepareJiaowubaoTrialSyncProjection({ rows: currentRows, rawEvents, snapshotRevision: revision, matchedAt: "2026-10-19T02:00:00.000Z", window: { startsAt: "2026-10-19T13:00:00.000Z", endsAt: "2026-10-20T13:00:00.000Z" } });
  const moved = { ...event, startsAt: "2026-10-19T23:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" };
  const rematch = run(rows, [moved]); assert.equal(rematch.references.length, 1); assert.equal(rematch.references[0]!.lpItemId, "LP-1"); assert.equal((rematch.nextLpItems[0]!.trialSchedule as Record<string, unknown>).startsAt, moved.startsAt);
  const cancelled = run(rows, []); assert.equal(cancelled.revocations.length, 1); assert.equal(cancelled.nextLpItems[0]!.trialSchedule, undefined); assert.deepEqual(cancelled.nextLpItems[0]!.trialScheduleReview, confirmed.trialScheduleReview);
  const cancelledRows = rows.map((row) => row.entity === "lpItems" ? { ...row, payload: cancelled.nextLpItems } : row);
  const other = run(cancelledRows, [{ ...event, eventId: "jwb-open-api:schedule:replacement" }]);
  assert.ok(!other.references.some((reference) => reference.lpItemId === "LP-1"));
});

test("legacy trial LPs without intake use the confirmed LP name without rewriting the guardian placeholder", async () => {
  const { trialIntake: ignoredIntake, ...legacy } = harness().lp;
  assert.ok(ignoredIntake);
  const f = harness({ lp: legacy }); assert.equal((await f.post()).status, 200);
  const lp = f.saved()!.nextLpItems[0] as Record<string, unknown>;
  assert.equal((lp.trialSchedule as Record<string, unknown>).studentName, "Synthetic Child");
  assert.equal(lp.trialIntake, undefined);
  assert.equal(((f.rows[0]!.payload as Record<string, unknown>[])[0]!).name, "Synthetic Parent");
});

test("screenshot confirmation preserves an empty intake name when the LP already knows the student", async () => {
  const template = harness().lp;
  const f = harness({ student: { id: "STU-1", name: "Synthetic Child", owner: "Ella", planner: "Tara" }, lp: { ...template, fields: { ...(template.fields as Record<string, unknown>), studentNameKnown: true, studentName: "Synthetic Child" }, trialIntake: { ...(template.trialIntake as Record<string, unknown>), studentName: "" } } });
  assert.equal((await f.post()).status, 200);
  const lp = f.saved()!.nextLpItems[0] as Record<string, unknown>;
  assert.equal((lp.fields as Record<string, unknown>).studentName, "Synthetic Child");
  assert.equal((lp.trialIntake as Record<string, unknown>).studentName, "");
});

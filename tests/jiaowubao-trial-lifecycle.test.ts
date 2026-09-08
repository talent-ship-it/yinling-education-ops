import assert from "node:assert/strict";
import test from "node:test";
import { prepareJiaowubaoTrialSyncProjection as project } from "../lib/jiaowubao-trial-sync-projection";
import { runJiaowubaoTrialAutoSyncCore, type JiaowubaoTrialAutoSyncDependencies } from "../lib/jiaowubao-trial-auto-sync-core";
import { jiaowubaoTrialSyncIntent, jiaowubaoTrialSyncScope, parseJiaowubaoTrialSyncCommand,
  persistJiaowubaoTrialSyncPendingCommands, readJiaowubaoTrialSyncPendingCommands } from "../lib/jiaowubao-trial-sync";
import { buildTencentTrialLedgerMirrorRows } from "../lib/tencent-trial-ledger-mirror";
import type { OpsStateRow } from "../lib/ops-store";

const revision = `sha256:${"b".repeat(64)}`;
const oldRevision = `sha256:${"a".repeat(64)}`;
const now = new Date("2030-09-02T00:00:00.000Z");
const window = { startsAt: "2030-09-01T00:00:00.000Z", endsAt: "2030-09-09T00:00:00.000Z" };
const event = { eventId: "E-1", sourceDate: "2030-09-03", startsAt: "2030-09-03T08:00:00.000Z", endsAt: "2030-09-03T09:00:00.000Z",
  courseName: "Synthetic Student trial", sourceTeacherId: "9", sourceTeacherLabel: "Synthetic Teacher",
  sourceParticipants: [{ memberId: "1", label: "Synthetic Student" }], sourceStudentsTruncated: false };
const reference = { lpItemId: "LP-1", eventId: event.eventId, startsAt: event.startsAt };
const link = { source: "jiaowubao-open-api", sourceRevision: oldRevision, eventId: event.eventId,
  startsAt: event.startsAt, endsAt: event.endsAt, teacherId: "T-1", teacherName: "Synthetic Teacher", plannerHint: "Tara", matchedAt: "2030-09-01T00:00:00.000Z" };
const lp = { id: "LP-1", studentId: "S-1", workflowType: "试听 LP", stage: "待跟进", owner: "Ella", requestedAt: "2030-09-01T00:00:00.000Z", fields: { preparationFollowUp: "是" } };
const task = { id: "TASK-1", title: "Synthetic trial reminder", owner: "Ella", studentId: "S-1", status: "upcoming", tone: "amber", due: event.startsAt, dueAt: event.startsAt,
  ruleKey: "trial.jiaowubao.payment-n2", anchorBookingId: "JWB:E-1", requestAnchorBookingId: "LP-1" };
const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: now.toISOString(), updated_by: "fixture" });
function rows(lpItems: unknown[] = [lp], tasks: unknown[] = []) {
  return [row("students", [{ id: "S-1", name: "Synthetic Student", owner: "Ella", planner: "Tara", jwbSourceRow: "1" }]),
    row("teachers", [{ id: "T-1", name: "Synthetic Teacher" }]), row("bookings", []), row("lpItems", lpItems), row("tasks", tasks)];
}
const common = { rawEvents: [event], snapshotRevision: revision, matchedAt: now, window };

test("a browser subset cannot hide a competing LP or steal a previously assigned event", () => {
  const competing = rows([lp, { ...lp, id: "LP-2" }]);
  assert.deepEqual(project({ ...common, rows: competing }).references, []);
  assert.throws(() => project({ ...common, rows: competing, references: [reference] }), /无歧义/);
  assert.throws(() => project({ ...common, rows: rows([lp, { ...lp, id: "LP-2", stage: "完成", trialSchedule: link }]), references: [reference] }), /无歧义/);
});

test("a new LP inserted between discovery and the automatic batch prevents its commit", async () => {
  let reads = 0;
  let commits = 0;
  const dependencies: JiaowubaoTrialAutoSyncDependencies = {
    getRows: async () => ++reads === 1 ? rows() : rows([lp, { ...lp, id: "LP-2" }]),
    readSource: async () => [event], now: () => now, uuid: () => crypto.randomUUID(),
    commit: async () => { commits += 1; return []; },
  };
  await assert.rejects(runJiaowubaoTrialAutoSyncCore({ snapshotRevision: revision, window }, dependencies), /无歧义/);
  assert.equal(commits, 0);
});

test("a disappeared future event clears its source fallback and unfinished reminders while preserving history", () => {
  const done = { ...task, id: "DONE", status: "done", result: "Confirmed", closedAt: now.toISOString() };
  const unrelated = { ...task, id: "UNRELATED", anchorBookingId: "JWB:E-2" };
  const projection = project({ ...common, rawEvents: [], rows: rows([{ ...lp, trialSchedule: link }], [task, done, unrelated]) });
  assert.deepEqual(projection.revocations, [reference]);
  assert.equal(projection.nextLpItems[0]!.trialSchedule, undefined);
  assert.deepEqual(projection.nextTasks, [done, unrelated]);
  assert.deepEqual(projection.studentIds, ["S-1"]);
  const mirror = buildTencentTrialLedgerMirrorRows({ lpItems: projection.nextLpItems, students: [] });
  assert.equal(mirror[0]!.values["上课日期和时间（墨尔本）"], "");
});

test("historical, outside-window, completed and unverified source links are preserved", () => {
  const cases = [
    { ...lp, trialSchedule: { ...link, startsAt: "2030-09-01T08:00:00.000Z" } },
    { ...lp, trialSchedule: { ...link, startsAt: window.endsAt } },
    { ...lp, trialSchedule: link, stage: "完成" },
    { ...lp, trialSchedule: { ...link, sourceRevision: undefined } },
  ];
  for (const candidate of cases) {
    const result = project({ ...common, rawEvents: [], rows: rows([candidate], [task]) });
    assert.deepEqual(result.revocations, []);
    assert.deepEqual(result.nextLpItems, [candidate]);
    assert.deepEqual(result.nextTasks, [task]);
  }
  assert.deepEqual(project({ ...common, window: undefined, rawEvents: [], rows: rows([{ ...lp, trialSchedule: link }]) }).revocations, []);
  assert.throws(() => project({ ...common, window: undefined, rawEvents: [], rows: rows([{ ...lp, trialSchedule: link }]), references: [], revocations: [reference] }), /完整新快照/);
});

test("an existing source event cannot be revoked even if it is no longer matchable", () => {
  const input = { ...common, rows: rows([{ ...lp, trialSchedule: link }]), rawEvents: [{ ...event, sourceStudentsTruncated: true }] };
  assert.deepEqual(project(input).revocations, []);
  assert.throws(() => project({ ...input, references: [], revocations: [reference] }), /完整新快照/);
});

test("a revocation-only automatic batch commits and an incomplete source never reaches projection", async () => {
  let commits = 0;
  const dependencies: JiaowubaoTrialAutoSyncDependencies = {
    getRows: async () => rows([{ ...lp, trialSchedule: link }], [task]), readSource: async () => [], now: () => now, uuid: () => crypto.randomUUID(),
    commit: async (input) => {
      commits += 1;
      assert.deepEqual(input.matches, []);
      assert.deepEqual(input.revocations, [reference]);
      assert.deepEqual(input.nextTasks, []);
      return [{ command_key: input.commandKey, applied: true, snapshot_revision: revision, lp_item_ids: ["LP-1"], student_ids: ["S-1"],
        lp_items_row: row("lpItems", input.nextLpItems), tasks_row: row("tasks", input.nextTasks), audit_entry_id: crypto.randomUUID() }];
    },
  };
  assert.equal((await runJiaowubaoTrialAutoSyncCore({ snapshotRevision: revision, window }, dependencies)).appliedCount, 1);
  assert.equal(commits, 1);
  await assert.rejects(runJiaowubaoTrialAutoSyncCore({ snapshotRevision: revision, window }, { ...dependencies, readSource: async () => { throw new Error("incomplete"); } }), /incomplete/);
  assert.equal(commits, 1);
});

test("revocation commands preserve exact retry intent and reject mixed ownership references", () => {
  const command = parseJiaowubaoTrialSyncCommand({ commandKey: crypto.randomUUID(), snapshotRevision: revision, window, matches: [], revocations: [reference], expectedVersions: { lpItems: 1, tasks: 1 } });
  assert.deepEqual(jiaowubaoTrialSyncIntent(command).revocations, [reference]);
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const pending = { ...command, scope: jiaowubaoTrialSyncScope(command) };
  persistJiaowubaoTrialSyncPendingCommands(storage, "Ella", [pending]);
  assert.deepEqual([...readJiaowubaoTrialSyncPendingCommands(storage, "Ella").values()], [pending]);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({ ...command, matches: [reference] }), /同时匹配和撤销/);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({ ...command, revocations: [] }), /数量无效/);
  // A prior bug may already have duplicated a source link. Both stale links
  // must be removable in one command without allowing duplicate assignments.
  assert.equal(parseJiaowubaoTrialSyncCommand({ ...command,
    revocations: [reference, { ...reference, lpItemId: "LP-2" }] }).revocations?.length, 2);
});

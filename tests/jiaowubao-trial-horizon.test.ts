import assert from "node:assert/strict";
import test from "node:test";
import {
  jiaowubaoTrialProjectionWindow,
  runJiaowubaoTrialAutoSyncHorizonCore,
  type JiaowubaoTrialAutoSyncDependencies,
} from "../lib/jiaowubao-trial-auto-sync-core";
import { prepareJiaowubaoTrialSyncProjection } from "../lib/jiaowubao-trial-sync-projection";
import type { OpsStateRow } from "../lib/ops-store";

const revision = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-09-22T01:00:00.000Z");
const windows = [
  { start: "2026-09-22", end: "2026-10-22" },
  { start: "2026-10-23", end: "2026-11-22" },
  { start: "2026-11-23", end: "2026-12-23" },
].map(jiaowubaoTrialProjectionWindow);
type Event = Awaited<ReturnType<JiaowubaoTrialAutoSyncDependencies["readSource"]>>[number];
const event = (id: string, date: string, student = "1"): Event => ({
  eventId: `jwb-open-api:schedule:${id}`, sourceDate: date,
  startsAt: `${date}T08:00:00.000Z`, endsAt: `${date}T09:00:00.000Z`,
  courseName: `Student ${student}`, sourceTeacherId: "source-teacher-1", sourceTeacherLabel: "Grace Lin",
  sourceParticipants: [{ memberId: `member-${student}`, label: `Student ${student}` }],
  sourceStudentsTruncated: false,
});
const row = (entity: string, payload: unknown, version = 1): OpsStateRow => ({
  entity, payload, version, updated_at: now.toISOString(), updated_by: "fixture",
});
function fixtureRows(studentIds = ["1"]): OpsStateRow[] {
  return [
    row("bookings", []),
    row("students", studentIds.map((id) => ({
      id: `STU-${id}`, name: `Student ${id}`, owner: "Ella", planner: "Tara", jwbSourceRow: `member-${id}`,
    }))),
    row("teachers", [{ id: "TEA-1", name: "Grace Lin" }]),
    row("lpItems", studentIds.map((id) => ({
      id: `LP-${id}`, studentId: `STU-${id}`, workflowType: "试听 LP", stage: "待跟进", owner: "Ella",
      requestedAt: "2026-09-22T00:00:00.000Z", fields: { trialPaymentMethod: "免费试听" },
    }))),
    row("tasks", []),
  ];
}
function harness(source: readonly Event[], initial = fixtureRows()) {
  let authority = initial;
  let serial = 0;
  const calls: string[] = [];
  const commits: Parameters<JiaowubaoTrialAutoSyncDependencies["commit"]>[0][] = [];
  const dependencies: JiaowubaoTrialAutoSyncDependencies = {
    now: () => now,
    uuid: () => `123e4567-e89b-42d3-a456-${String(++serial).padStart(12, "0")}`,
    getRows: async () => authority,
    readSource: async (pinnedRevision, window) => {
      assert.equal(pinnedRevision, revision);
      calls.push(`read:${window.startsAt}`);
      return source.filter((item) => item.startsAt >= window.startsAt && item.startsAt < window.endsAt);
    },
    commit: async (input) => {
      assert.equal(calls.filter((call) => call.startsWith("read:")).length % windows.length, 0,
        "all pinned source windows must be read before a write");
      const window = input.commandIntent.window as { startsAt: string; endsAt: string };
      assert.ok(Date.parse(window.endsAt) - Date.parse(window.startsAt) <= 32 * 86_400_000);
      assert.ok(input.matches.length + (input.revocations?.length ?? 0) <= 24);
      assert.ok(input.matches.every((match) => match.startsAt >= window.startsAt && match.startsAt < window.endsAt));
      // Model the existing SQL whole-revision absence guard. A moved event is
      // not a deletion, even when it no longer appears in the old time window.
      assert.ok((input.revocations ?? []).every((ref) => !source.some((item) => item.eventId === ref.eventId)),
        "jiaowubao_trial_revocation_not_proven");
      calls.push("commit");
      commits.push(input);
      const lp = row("lpItems", input.nextLpItems, authority.find((item) => item.entity === "lpItems")!.version + 1);
      const tasks = row("tasks", input.nextTasks, authority.find((item) => item.entity === "tasks")!.version + 1);
      authority = authority.map((item) => item.entity === "lpItems" ? lp : item.entity === "tasks" ? tasks : item);
      return [{ command_key: input.commandKey, applied: true, snapshot_revision: revision,
        lp_item_ids: input.matches.map((match) => match.lpItemId), student_ids: [],
        lp_items_row: lp, tasks_row: tasks, audit_entry_id: "00000000-0000-4000-8000-000000000001" }];
    },
  };
  return { dependencies, calls, commits, rows: () => authority };
}

test("an event moved to a later window is updated once without a false deletion", async () => {
  const original = event("1", "2026-10-01");
  const initial = fixtureRows();
  const before = prepareJiaowubaoTrialSyncProjection({
    rows: initial, rawEvents: [original], snapshotRevision: revision, window: windows[0], matchedAt: now,
  });
  const linked = initial.map((item) => item.entity === "lpItems" ? row(item.entity, before.nextLpItems)
    : item.entity === "tasks" ? row(item.entity, before.nextTasks) : item);
  const moved = event("1", "2026-11-01");
  const saved = harness([moved], linked);
  const result = await runJiaowubaoTrialAutoSyncHorizonCore({ snapshotRevision: revision, windows }, saved.dependencies);
  assert.equal(result.appliedCount, 1);
  assert.equal(saved.commits.length, 1);
  assert.equal(saved.commits[0].matches[0].startsAt, moved.startsAt);
  assert.deepEqual(saved.commits[0].revocations ?? [], []);
});

test("competing lessons in separate windows remain ambiguous across the entire revision", async () => {
  const saved = harness([event("1", "2026-10-01"), event("2", "2026-11-01")]);
  const result = await runJiaowubaoTrialAutoSyncHorizonCore({ snapshotRevision: revision, windows }, saved.dependencies);
  assert.equal(result.outcome, "no_match");
  assert.equal(saved.commits.length, 0);
});

test("a failed later source read or duplicate source identity causes zero trial writes", async () => {
  const saved = harness([event("1", "2026-10-01")]);
  await assert.rejects(runJiaowubaoTrialAutoSyncHorizonCore({ snapshotRevision: revision, windows }, {
    ...saved.dependencies,
    readSource: async (pinned, window) => {
      if (window.startsAt === windows[2].startsAt) throw new Error("source changed");
      return saved.dependencies.readSource(pinned, window);
    },
  }), /source changed/);
  assert.equal(saved.commits.length, 0);
  await assert.rejects(runJiaowubaoTrialAutoSyncHorizonCore({ snapshotRevision: revision, windows }, {
    ...saved.dependencies, readSource: async () => [event("1", "2026-10-01")],
  }), /source identity invalid/);
  assert.equal(saved.commits.length, 0);
});

test("late commit failure propagates and the same revision retry converges without duplicate tasks", async () => {
  const saved = harness([event("1", "2026-10-01"), event("2", "2026-11-01", "2")], fixtureRows(["1", "2"]));
  const input = { snapshotRevision: revision, windows };
  await assert.rejects(runJiaowubaoTrialAutoSyncHorizonCore(input, {
    ...saved.dependencies,
    commit: async (command) => {
      if (command.matches.some((match) => match.lpItemId === "LP-2")) throw new Error("late commit unavailable");
      return saved.dependencies.commit(command);
    },
  }), /late commit unavailable/);
  assert.equal(saved.commits.length, 1, "completed bounded command remains committed");
  const result = await runJiaowubaoTrialAutoSyncHorizonCore(input, saved.dependencies);
  assert.equal(result.appliedCount, 1, "retry only applies the unfinished window");
  assert.equal(saved.commits.length, 2);
  const tasks = saved.rows().find((item) => item.entity === "tasks")!.payload as { id: string }[];
  assert.ok(tasks.length > 0);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.equal((await runJiaowubaoTrialAutoSyncHorizonCore(input, saved.dependencies)).appliedCount, 0);
  assert.equal(saved.commits.length, 2);
});

test("horizon rejects gaps and oversized read windows before any source call", async () => {
  const saved = harness([]);
  for (const invalid of [[], [windows[0], windows[2]], [{ startsAt: windows[0].startsAt, endsAt: windows[2].endsAt }]]) {
    await assert.rejects(runJiaowubaoTrialAutoSyncHorizonCore({ snapshotRevision: revision, windows: invalid }, saved.dependencies), /windows invalid/);
  }
  assert.equal(saved.calls.length, 0);
});

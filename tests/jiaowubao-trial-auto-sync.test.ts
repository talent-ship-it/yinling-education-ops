import assert from "node:assert/strict";
import test from "node:test";

import {
  jiaowubaoTrialProjectionWindow,
  runJiaowubaoTrialAutoSyncCore,
} from "../lib/jiaowubao-trial-auto-sync-core";
import type { OpsStateRow } from "../lib/ops-store";

const revision = `sha256:${"b".repeat(64)}`;
const rawEvent = {
  eventId: "evt-auto-1",
  sourceDate: "2026-09-03",
  startsAt: "2026-09-03T08:00:00.000Z",
  endsAt: "2026-09-03T09:00:00.000Z",
  courseName: "Auto Student",
  sourceTeacherId: "source-teacher-1",
  sourceTeacherLabel: "Grace Lin",
  sourceParticipants: [
    { memberId: "member-auto-1", label: "Auto Student" },
    { memberId: null, label: "试听学员A" },
  ],
  sourceStudentsTruncated: false,
} as const;

function row(entity: string, payload: unknown, version = 1): OpsStateRow {
  return { entity, payload, version, updated_at: "2026-08-29T00:00:00.000Z", updated_by: "fixture" };
}

function fixtureRows(): OpsStateRow[] {
  return [
    row("bookings", []),
    row("students", [{
      id: "STU-AUTO-1",
      name: "Auto Student",
      owner: "Ella",
      planner: "Tara",
      jwbSourceRow: "member-auto-1",
    }]),
    row("teachers", [{ id: "TEA-AUTO-1", name: "Grace Lin" }]),
    row("lpItems", [{
      id: "LP-AUTO-1",
      studentId: "STU-AUTO-1",
      workflowType: "试听 LP",
      stage: "待跟进",
      owner: "Ella",
      requestedAt: "2026-08-29T00:00:00.000Z",
      fields: { preparationFollowUp: "是", trialPaymentMethod: "免费试听" },
      trialIntake: {
        planner: "Tara",
        requestSentAt: "2026-08-29T00:00:00.000Z",
        contactParents: true,
        contactStudent: false,
        writingRequired: false,
        paperRequired: false,
        studentName: "Auto Student",
        trialDurationMinutes: 60,
      },
    }], 7),
    row("tasks", [], 11),
  ];
}

test("converts inclusive Melbourne source dates across DST to exact UTC boundaries", () => {
  assert.deepEqual(jiaowubaoTrialProjectionWindow({ start: "2026-10-03", end: "2026-10-05" }), {
    startsAt: "2026-10-02T14:00:00.000Z",
    endsAt: "2026-10-05T13:00:00.000Z",
  });
});

test("background reconciliation discovers, commits, and then skips an unchanged trial projection", async () => {
  let authority = fixtureRows();
  let commitCount = 0;
  const dependencies = {
    getRows: async () => authority,
    readSource: async () => [rawEvent],
    uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    now: () => new Date("2026-08-29T01:00:00.000Z"),
    commit: async (input: {
      commandKey: string;
      snapshotRevision: string;
      matches: readonly Readonly<{ lpItemId: string; eventId: string; startsAt: string }>[];
      nextLpItems: readonly unknown[];
      nextTasks: readonly unknown[];
    }) => {
      commitCount += 1;
      const lpBefore = authority.find((candidate) => candidate.entity === "lpItems")!;
      const taskBefore = authority.find((candidate) => candidate.entity === "tasks")!;
      const lpAfter = row("lpItems", input.nextLpItems, lpBefore.version + 1);
      const taskAfter = row("tasks", input.nextTasks, taskBefore.version + 1);
      authority = authority.map((candidate) => candidate.entity === "lpItems"
        ? lpAfter
        : candidate.entity === "tasks" ? taskAfter : candidate);
      return [{
        command_key: input.commandKey,
        applied: true,
        snapshot_revision: input.snapshotRevision,
        lp_item_ids: input.matches.map((match) => match.lpItemId),
        student_ids: ["STU-AUTO-1"],
        lp_items_row: lpAfter,
        tasks_row: taskAfter,
        audit_entry_id: "00000000-0000-4000-8000-000000000001",
      }];
    },
  };
  const window = {
    startsAt: "2026-08-28T14:00:00.000Z",
    endsAt: "2026-09-28T14:00:00.000Z",
  } as const;

  const first = await runJiaowubaoTrialAutoSyncCore({ snapshotRevision: revision, window }, dependencies);
  assert.deepEqual(first, { outcome: "applied", matchedCount: 1, appliedCount: 1, batchCount: 1 });
  assert.equal(commitCount, 1);
  const linked = (authority.find((candidate) => candidate.entity === "lpItems")!.payload as Record<string, unknown>[])[0]!;
  assert.equal((linked.trialSchedule as Record<string, unknown>).eventId, rawEvent.eventId);

  const second = await runJiaowubaoTrialAutoSyncCore({ snapshotRevision: revision, window }, dependencies);
  assert.deepEqual(second, { outcome: "no_change", matchedCount: 1, appliedCount: 0, batchCount: 0 });
  assert.equal(commitCount, 1);
});

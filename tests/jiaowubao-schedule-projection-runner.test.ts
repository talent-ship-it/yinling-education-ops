import assert from "node:assert/strict";
import test from "node:test";

import {
  runJiaowubaoScheduleProjectionTarget,
  runOrQueueJiaowubaoScheduleProjectionTarget,
  type JiaowubaoScheduleProjectionDependencies,
  type JiaowubaoScheduleProjectionTarget,
} from "../lib/jiaowubao-schedule-projection-runner";

const REVISION = `sha256:${"a".repeat(64)}`;

function target(projectionState: "pending" | "authority_done" | "complete"):
JiaowubaoScheduleProjectionTarget {
  return Object.freeze({
    revision: REVISION,
    rowCount: 12,
    projectionState,
    window: Object.freeze({ start: "2026-09-23", end: "2026-12-24" }),
    publishedAt: "2026-09-23T00:00:00.000Z",
  });
}

function dependencies(
  calls: string[],
  options: Readonly<{ canStart?: boolean; authorityAdvanceState?: "authority_done" | "complete" }> = {},
): JiaowubaoScheduleProjectionDependencies<string, string> {
  return {
    canStartProjection: () => options.canStart ?? true,
    assertAuthorityTime: () => { calls.push("assert_authority_time"); },
    projectAuthority: async (value) => {
      calls.push(`authority:${value.revision}:${value.rowCount}`);
      return "authority_receipt";
    },
    projectTrials: async (value, allowStalePinnedRevision) => {
      calls.push(`trials:${value.window.start}:${value.window.end}:${allowStalePinnedRevision}`);
      return "trial_receipt";
    },
    advance: async (input) => {
      calls.push(`advance:${input.expectedState}:${input.nextState}`);
      const state = input.nextState === "authority_done"
        ? options.authorityAdvanceState ?? "authority_done"
        : input.nextState;
      return { revision: input.revision, state, replayed: false };
    },
  };
}

test("pending projections execute authority then trials and persist both transitions", async () => {
  const calls: string[] = [];
  const phases: string[] = [];
  const result = await runJiaowubaoScheduleProjectionTarget(
    target("pending"),
    dependencies(calls),
    (phase) => { phases.push(phase); },
  );
  assert.deepEqual(result, {
    authorityProjection: "authority_receipt",
    trialProjection: "trial_receipt",
  });
  assert.deepEqual(phases, ["project_authority", "project_trials"]);
  assert.deepEqual(calls, [
    "assert_authority_time",
    `authority:${REVISION}:12`,
    "advance:pending:authority_done",
    "trials:2026-09-23:2026-12-24:true",
    "advance:authority_done:complete",
  ]);
});

test("authority_done recovery skips authority and keeps the persisted source window", async () => {
  const calls: string[] = [];
  const result = await runJiaowubaoScheduleProjectionTarget(
    target("authority_done"),
    dependencies(calls),
    () => undefined,
  );
  assert.equal(result.authorityProjection, null);
  assert.equal(result.trialProjection, "trial_receipt");
  assert.deepEqual(calls, [
    "trials:2026-09-23:2026-12-24:true",
    "advance:authority_done:complete",
  ]);
});

test("a complete target becomes pending before a low-budget run returns", async () => {
  const calls: string[] = [];
  const result = await runOrQueueJiaowubaoScheduleProjectionTarget(
    target("complete"),
    dependencies(calls, { canStart: false }),
    () => undefined,
  );
  assert.deepEqual(result, {
    projectionQueued: true,
    authorityProjection: null,
    trialProjection: null,
  });
  assert.deepEqual(calls, ["advance:complete:pending"]);
});

test("a CAS receipt showing complete suppresses duplicate trial work", async () => {
  const calls: string[] = [];
  const result = await runJiaowubaoScheduleProjectionTarget(
    target("pending"),
    dependencies(calls, { authorityAdvanceState: "complete" }),
    () => undefined,
  );
  assert.equal(result.authorityProjection, "authority_receipt");
  assert.equal(result.trialProjection, null);
  assert.equal(calls.some((call) => call.startsWith("trials:")), false);
});

test("transition receipts are revision-bound", async () => {
  const calls: string[] = [];
  const invalid = dependencies(calls);
  await assert.rejects(
    runJiaowubaoScheduleProjectionTarget(target("pending"), {
      ...invalid,
      advance: async () => ({ revision: `sha256:${"b".repeat(64)}`, state: "authority_done", replayed: false }),
    }, () => undefined),
    /projection_transition_invalid/,
  );
});

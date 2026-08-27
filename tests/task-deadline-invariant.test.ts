import assert from "node:assert/strict";
import test from "node:test";

import { isCanonicalTaskDueAt, isExecutableOpenTask, isFrozenLegacyTask } from "../lib/ops-tasks.ts";
import { assertOpsStateTransition, OpsStateTransitionError } from "../lib/ops-state-transition.ts";

const context = {} as never;

function transition(currentPayload: unknown, nextPayload: unknown) {
  return assertOpsStateTransition({
    entity: "tasks",
    currentPayload,
    nextPayload,
    rows: [{
      entity: "students",
      payload: [{ id: "S-1", importArchived: false }],
      version: 1,
      updated_at: "2026-08-20T00:00:00.000Z",
      updated_by: "test",
    }],
    context,
  });
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "TASK-1",
    title: "Follow up",
    owner: "Abby",
    watchers: ["Abby", "Ops Admin"],
    studentId: "S-1",
    due: "历史描述",
    dueAt: "2026-08-20T08:00:00.000Z",
    status: "upcoming",
    tone: "blue",
    category: "LP",
    trigger: "test",
    ...overrides,
  };
}

test("canonical deadline accepts only exact valid ISO instants", () => {
  assert.equal(isCanonicalTaskDueAt("2026-08-20T08:00:00.000Z"), true);
  assert.equal(isCanonicalTaskDueAt("2026-02-30T08:00:00.000Z"), false);
  assert.equal(isCanonicalTaskDueAt("发布后立即"), false);
  assert.equal(isCanonicalTaskDueAt("2026-08-20T08:00:00Z"), false);
  assert.equal(isCanonicalTaskDueAt(undefined), false);
});

test("new and edited open tasks cannot omit or fake their deadline", () => {
  assert.throws(() => transition([], [task({ dueAt: undefined })]), OpsStateTransitionError);
  assert.throws(() => transition([], [task({ dueAt: "发布后立即" })]), OpsStateTransitionError);
  assert.throws(() => transition([task()], [task({ dueAt: undefined })]), OpsStateTransitionError);
  assert.throws(() => transition([task()], [task({ title: "Edited", dueAt: "2026-02-30T08:00:00.000Z" })]), OpsStateTransitionError);
  transition([task()], [task({ title: "Edited" })]);
});

test("canonical dueAt never overrides a freeze marker and generic writes cannot forge one", () => {
  const marked = task({
    legacyEvidence: {
      state: "frozen",
      reason: "missing_canonical_due_at",
      frozenAt: "2026-08-20T00:00:00.000Z",
    },
  });
  assert.equal(isFrozenLegacyTask(marked), true);
  assert.equal(isExecutableOpenTask(marked), false);
  assert.equal(isFrozenLegacyTask(task({ legacyEvidence: { state: "corrupt" } })), true);
  assert.equal(isExecutableOpenTask(task({ legacyEvidence: null })), false);
  assert.throws(() => transition([], [marked]), OpsStateTransitionError);
  assert.throws(() => transition([task()], [marked]), OpsStateTransitionError);
  assert.throws(() => transition(
    [task({ status: "done" })],
    [task({ status: "done", legacyEvidence: marked.legacyEvidence })],
  ), OpsStateTransitionError);
});

test("frozen evidence stays hidden until a dedicated route removes its marker", () => {
  const frozen = task({
    dueAt: undefined,
    legacyEvidence: {
      state: "frozen",
      reason: "missing_canonical_due_at",
      sourceDue: "发布后立即",
      frozenAt: "2026-08-20T00:00:00.000Z",
    },
  });
  assert.equal(isFrozenLegacyTask(frozen), true);
  assert.equal(isExecutableOpenTask(frozen), false);
  transition([frozen], [frozen]);
  assert.throws(() => transition([frozen], []), OpsStateTransitionError);
  assert.throws(() => transition([frozen], [task({
    ...frozen,
    title: "changed historical evidence",
  })]), OpsStateTransitionError);

  const repaired = { ...frozen, dueAt: "2026-08-20T08:00:00.000Z" };
  assert.equal(isFrozenLegacyTask(repaired), true);
  assert.equal(isExecutableOpenTask(repaired), false);
  assert.throws(() => transition([frozen], [repaired]), OpsStateTransitionError);
  Reflect.deleteProperty(repaired, "legacyEvidence");
  assert.equal(isFrozenLegacyTask(repaired), false);
  assert.equal(isExecutableOpenTask(repaired), true);
  assert.throws(() => transition([frozen], [repaired]), OpsStateTransitionError);
});

test("generic app-state cannot thaw a managed task even with a canonical unchanged projection", () => {
  const frozen = task({
    dueAt: undefined,
    ruleKey: "trial.parent-follow-up",
    anchorBookingId: "TRIAL-1",
    legacyEvidence: {
      state: "frozen",
      reason: "missing_canonical_due_at",
      frozenAt: "2026-08-20T00:00:00.000Z",
    },
  });
  const repaired = {
    ...frozen,
    dueAt: "2026-08-20T08:00:00.000Z",
  };
  Reflect.deleteProperty(repaired, "legacyEvidence");
  assert.throws(() => transition([frozen], [repaired]), OpsStateTransitionError);
  assert.throws(() => transition([frozen], [{
    ...repaired,
    title: "Authoritatively recalculated",
  }]), OpsStateTransitionError);
  assert.throws(() => transition([frozen], [{
    ...repaired,
    ruleKey: "trial.parent-no-reply-follow-up",
  }]), OpsStateTransitionError);
  assert.throws(() => transition([frozen], [{
    ...repaired,
    anchorBookingId: "TRIAL-OTHER",
  }]), OpsStateTransitionError);
});

test("completed historical tasks remain readable without inventing an open deadline", () => {
  const completed = task({ status: "done", dueAt: undefined });
  transition([completed], [task({ ...completed, result: "已完成" })]);
  assert.equal(isExecutableOpenTask(completed), false);
});

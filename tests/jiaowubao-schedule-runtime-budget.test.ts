import assert from "node:assert/strict";
import test from "node:test";

import {
  JIAOWUBAO_SCHEDULE_ROUTE_WORK_MS,
  assertJiaowubaoScheduleTime,
  hasJiaowubaoScheduleTime,
  jiaowubaoScheduleRpcOptions,
  jiaowubaoScheduleWorkDeadline,
} from "../lib/jiaowubao-schedule-runtime-budget";

test("the route deadline includes projection-target and identity work", () => {
  const startedAt = 1_000_000;
  const deadlineAt = jiaowubaoScheduleWorkDeadline(startedAt);
  assert.equal(deadlineAt, startedAt + JIAOWUBAO_SCHEDULE_ROUTE_WORK_MS);
  assert.doesNotThrow(() => assertJiaowubaoScheduleTime(deadlineAt, 35_000, 12_000, startedAt + 200_000));
  assert.throws(
    () => assertJiaowubaoScheduleTime(deadlineAt, 35_000, 12_000, deadlineAt - 47_000),
    /schedule_route_deadline/,
  );
  assert.equal(hasJiaowubaoScheduleTime(deadlineAt, 35_000, 12_000, startedAt + 200_000), true);
  assert.equal(hasJiaowubaoScheduleTime(deadlineAt, 35_000, 12_000, deadlineAt - 47_000), false);
});

test("RPCs share one absolute deadline instead of resetting the route budget", () => {
  const deadlineAt = Date.now() + 200_000;
  assert.deepEqual(jiaowubaoScheduleRpcOptions(deadlineAt, 115_000), {
    deadlineAt,
    timeoutMs: 115_000,
  });
  assert.throws(() => jiaowubaoScheduleRpcOptions(Number.NaN), /schedule_route_deadline/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolveOpsRpcTiming } from "../lib/ops-rpc-budget";

test("RPC timing never outlives the shared route deadline", () => {
  assert.deepEqual(resolveOpsRpcTiming({ deadlineAt: 10_020, timeoutMs: 1_000 }, 15_000, 10_000), {
    timeoutMs: 20,
    timeoutCode: "deadline",
  });
  assert.deepEqual(resolveOpsRpcTiming({ deadlineAt: 20_000, timeoutMs: 250 }, 15_000, 10_000), {
    timeoutMs: 250,
    timeoutCode: "timeout",
  });
});

test("RPC timing rejects exhausted and malformed budgets before fetch", () => {
  assert.equal(resolveOpsRpcTiming({ deadlineAt: 10_000 }, 15_000, 10_000), null);
  assert.equal(resolveOpsRpcTiming({ deadlineAt: Number.NaN }, 15_000, 10_000), null);
  assert.equal(resolveOpsRpcTiming({ timeoutMs: 0 }, 15_000, 10_000), null);
});

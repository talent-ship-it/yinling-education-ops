import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import * as access from "../lib/ops-access.ts";
import * as ledger from "../lib/trial-ledger.ts";

const compiled = ts.transpileModule(readFileSync(new URL("../app/api/operations/trial-ledger/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const commandKey = "123e4567-e89b-42d3-a456-426614174000";
const stateRow = (entity, payload) => ({ entity, payload, version: 3, updated_at: "2026-10-25T00:00:00Z", updated_by: "fixture" });
function fixtureCommand(options) {
  const field = options.field ?? "resultStatus";
  return { commandKey, lpItemId: options.lpItemId ?? "LP-1", field, expectedValue: null,
    value: options.value ?? ({ lpFinalized: true, resultStatus: "试听成功" })[field] };
}
function fixture(options = {}) {
  const students = stateRow("students", [{ id: "S-1", owner: "Erin" }, { id: "S-2", owner: "Molly" }]);
  const lpItems = stateRow("lpItems", [{ id: "LP-1", studentId: "S-1", workflowType: "试听 LP", trialLpFinalized: true },
    { id: "LP-2", studentId: "S-2", workflowType: "试听 LP" }]);
  const tasks = stateRow("tasks", [{ id: "T-1", studentId: "S-1", owner: "Erin", status: "done", ruleKey: "trial.jiaowubao.lp-final-n2" },
    { id: "T-2", studentId: "S-2", owner: "Molly", status: "done" }]);
  const receipt = { command_key: commandKey, lp_item_id: "LP-1", field: options.field ?? "resultStatus", lp_items_row: lpItems, applied: true };
  let writes = 0;
  const modules = new Map([
    ["next/headers", { cookies: async () => ({ get: () => undefined }) }],
    ["next/server", { NextResponse: { json: (body, init) => Response.json(body, init) } }],
    ["@/lib/demo-auth", { DEMO_COOKIE_NAME: "fixture", getCurrentDemoSession: async () => ({ session: {
      user: "Erin", role: options.teacher ? "teacher" : "staff", permissions: ["operations.read", "operations.write"],
      ...(options.entities ? { scopeMembers: options.entities.map((key) => ({ kind: "entity", key })) } : {}),
    } }) }],
    ["@/lib/nixon-auth", { NIXON_COOKIE_NAME: "fixture-admin", hasFullAdminAccess: () => false }],
    ["@/lib/ops-access", access], ["@/lib/trial-ledger", ledger],
    ["@/lib/ops-store", { OpsStoreError: class extends Error {},
      getOpsState: async (names) => [students, lpItems, tasks].filter((row) => names.includes(row.entity)),
      getTrialLedgerCommandResult: async () => options.replay ? [receipt] : [],
      mutateTrialLedgerFieldAtomic: async () => { writes += 1; return [receipt]; },
    }],
  ]);
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, console, require: (name) => {
    if (!modules.has(name)) throw new Error(`Unexpected import ${name}`); return modules.get(name);
  } });
  return { post: () => compiledModule.exports.POST(new Request("http://localhost/api/operations/trial-ledger", { method: "POST",
    body: JSON.stringify(fixtureCommand(options)) })), writes: () => writes };
}

test("ledger result changes return fresh task state filtered to the current staff scope", async () => {
  const f = fixture(); const response = await f.post(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(f.writes(), 1);
  assert.deepEqual(body.tasksRow.payload.map((task) => task.id), ["T-1"]);
  assert.deepEqual(body.lpItemsRow.payload.map((item) => item.id), ["LP-1"]);
});
test("idempotent ledger replay also refreshes the scoped task receipt", async () => {
  const f = fixture({ replay: true }); const response = await f.post(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(f.writes(), 0); assert.equal(body.applied, false);
  assert.deepEqual(body.tasksRow.payload.map((task) => task.id), ["T-1"]);
});
test("another staff member's LP cannot be mutated or used to read task state", async () => {
  const f = fixture({ lpItemId: "LP-2" }); const response = await f.post();
  assert.equal(response.status, 403); assert.equal(f.writes(), 0);
  assert.equal((await response.json()).tasksRow, undefined);
});
test("teacher accounts cannot use the ledger task refresh path", async () => {
  const f = fixture({ teacher: true }); const response = await f.post();
  assert.equal(response.status, 403); assert.equal(f.writes(), 0);
});

for (const [field, value] of [["lpFinalized", true], ["resultStatus", "被家长取消"]]) {
  test(`${field} is denied before mutation when task projection is outside the entity scope`, async () => {
    const f = fixture({ field, value, entities: ["students", "lpItems"] });
    const response = await f.post();
    assert.equal(response.status, 403);
    assert.equal(f.writes(), 0);
    assert.equal((await response.json()).tasksRow, undefined);
  });
}
test("a scoped replay cannot return task state after task access is revoked", async () => {
  const f = fixture({ field: "lpFinalized", replay: true, entities: ["students", "lpItems"] });
  const response = await f.post();
  assert.equal(response.status, 403);
  assert.equal(f.writes(), 0);
  assert.equal((await response.json()).tasksRow, undefined);
});
test("an unrelated planner edit retains the narrower ledger-only transaction scope", async () => {
  const f = fixture({ field: "planner", value: "Eileen", entities: ["students", "lpItems"] });
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(f.writes(), 1);
  assert.equal((await response.json()).tasksRow, undefined);
});
test("explicit task scope permits the finalized transaction and only its scoped receipt", async () => {
  const f = fixture({ field: "lpFinalized", entities: ["students", "lpItems", "tasks"] });
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(f.writes(), 1);
  assert.deepEqual((await response.json()).tasksRow.payload.map((task) => task.id), ["T-1"]);
});

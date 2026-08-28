import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../supabase/migrations/20260828000600_trial_ledger_atomic.sql", import.meta.url);
const routePath = new URL("../app/api/operations/trial-ledger/route.ts", import.meta.url);
const storePath = new URL("../lib/ops-store.ts", import.meta.url);
const transitionPath = new URL("../lib/ops-state-transition.ts", import.meta.url);

test("trial ledger writes use a dedicated idempotent field-level OCC contract", async () => {
  const [migration, route, store, transition] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(routePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(transitionPath, "utf8"),
  ]);

  assert.match(migration, /create table if not exists internal\.trial_ledger_commands/);
  assert.match(migration, /where entity = 'lpItems' for update/);
  assert.match(migration, /current_value is distinct from expected_value/);
  assert.match(migration, /trial_ledger_field_conflict/);
  assert.match(migration, /trialLedgerOverrides/);
  assert.match(migration, /trialLedgerAudit/);
  assert.match(migration, /resultAudit/);
  assert.match(migration, /insert into public\.ops_mutation_log/);
  assert.match(migration, /append_operational_contract_audit/);
  assert.match(migration, /revoke all on table internal\.trial_ledger_commands/);

  assert.match(route, /getTrialLedgerCommandResult/);
  assert.match(route, /mutateTrialLedgerFieldAtomic/);
  assert.match(route, /canOperateStudent/);
  assert.match(route, /teacher_forbidden/);
  assert.match(route, /field_conflict/);
  assert.match(route, /不会降级为整表覆盖写入/);

  assert.match(store, /TRIAL_LEDGER_ATOMIC_RPC/);
  assert.match(store, /TRIAL_LEDGER_COMMAND_RESULT_RPC/);
  assert.match(store, /p_expected_value/);
  assert.match(transition, /试听复盘台账只能由专用字段级原子流程修改/);
});

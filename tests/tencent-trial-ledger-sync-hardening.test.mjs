import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Tencent bridge releases projection failures and hardens leases plus record mappings", async () => {
  const [route, migration] = await Promise.all([
    read("app/api/integrations/tencent-trial-ledger/route.ts"),
    read("supabase/migrations/20260828001000_tencent_trial_ledger_sync_hardening.sql"),
  ]);

  assert.match(route, /let claimedLeaseToken: string \| null = null/);
  assert.match(route, /claimedLeaseToken = claim\.lease_token/);
  assert.match(route, /errorCode: "projection_failed"/);
  assert.match(route, /await failTencentTrialLedgerSyncBatch/);

  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('tencent-trial-ledger-sync', 0\)\)/);
  assert.match(migration, /completed_at_value := clock_timestamp\(\)/);
  assert.match(migration, /now_at := clock_timestamp\(\)/);
  assert.match(migration, /run\.lease_expires_at <= completed_at_value/);
  assert.match(migration, /run\.lease_expires_at <= now_at/);
  assert.match(migration, /p_record_count is null or p_record_count not between 0 and 100000/);
  assert.match(migration, /tencent_trial_ledger_mapping_reassignment/);
  assert.doesNotMatch(migration, /delete from internal\.tencent_trial_ledger_record_map/);
  assert.match(migration, /case when outbox\.attempt_count >= 8 then 'dead' else 'failed' end/);
  assert.match(migration, /bool_and\(status = 'dead'\)/);
  assert.match(migration, /revoke all on function public\.complete_tencent_trial_ledger_sync_batch/);
  assert.match(migration, /revoke all on function public\.fail_tencent_trial_ledger_sync_batch/);
});

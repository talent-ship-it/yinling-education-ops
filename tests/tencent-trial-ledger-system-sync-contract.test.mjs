import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("production owns the Tencent mirror clock and calls the official MCP directly", async () => {
  const [route, bridge, worker, client, migration, vercel, readme] = await Promise.all([
    read("app/api/cron/tencent-trial-ledger/route.ts"),
    read("app/api/integrations/tencent-trial-ledger/route.ts"),
    read("lib/tencent-trial-ledger-system-sync.ts"),
    read("lib/tencent-docs-smartsheet.ts"),
    read("supabase/migrations/20260829000100_schedule_tencent_trial_ledger_sync_every_15_minutes.sql"),
    read("vercel.json"),
    read("README.md"),
  ]);

  assert.match(route, /TENCENT_DOCS_TOKEN/);
  assert.match(route, /TENCENT_TRIAL_LEDGER_CRON_TOKEN/);
  assert.match(route, /TENCENT_TRIAL_LEDGER_BRIDGE_TOKEN/);
  assert.match(route, /Supabase pg_cron invokes this production worker; Codex is never in the run path/);
  assert.match(bridge, /tencent-docs-system-worker/);
  assert.doesNotMatch(bridge, /codex-mcp-bridge|Codex bridge/);
  assert.match(worker, /planTencentTrialLedgerWrites/);
  assert.match(worker, /assertTencentTrialLedgerReadback/);
  assert.match(worker, /action: "complete"/);
  assert.match(worker, /action: "fail"/);
  assert.doesNotMatch(worker, /deleteTencent|delete_records/);
  assert.match(client, /https:\/\/docs\.qq\.com\/openapi\/mcp/);
  assert.match(client, /smartsheet\.list_records/);
  assert.match(client, /smartsheet\.add_records/);
  assert.match(client, /smartsheet\.update_records/);
  assert.doesNotMatch(client, /smartsheet\.delete_records/);

  assert.match(migration, /'\*\/15 \* \* \* \*'/);
  assert.match(migration, /tencent-trial-ledger-sync-15m/);
  assert.match(migration, /https:\/\/app\.insiderleadsedu\.com\/api\/cron\/tencent-trial-ledger/);
  assert.match(migration, /vault\.decrypted_secrets/);
  assert.match(migration, /tencent_trial_ledger_cron_token/);
  assert.doesNotMatch(migration, /tencent_trial_ledger_bridge_token/);
  assert.doesNotMatch(migration, /TENCENT_DOCS_TOKEN|Authorization[^\n]+[A-Za-z0-9_-]{32,}/);
  assert.deepEqual(JSON.parse(vercel).crons, []);
  assert.match(readme, /Codex is not part of the scheduled run path/);
});

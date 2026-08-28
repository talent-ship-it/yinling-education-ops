import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Tencent trial ledger uses a transactional, leased and idempotent bridge contract", async () => {
  const [migration, route, store, mirror, client, readme] = await Promise.all([
    read("supabase/migrations/20260828000800_tencent_trial_ledger_outbox.sql"),
    read("app/api/integrations/tencent-trial-ledger/route.ts"),
    read("lib/ops-store.ts"),
    read("lib/tencent-trial-ledger-mirror.ts"),
    read("app/operations-client.tsx"),
    read("README.md"),
  ]);

  assert.match(migration, /internal\.tencent_trial_ledger_outbox/);
  assert.match(migration, /after insert or update of payload, version on public\.ops_state/);
  assert.match(migration, /entity in \('students', 'lpItems'\)/);
  assert.match(migration, /internal\.tencent_trial_ledger_sync_runs/);
  assert.match(migration, /internal\.tencent_trial_ledger_record_map/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expired/);
  assert.match(migration, /attempt_count >= 8/);
  assert.match(migration, /payload_sha256/);
  assert.match(migration, /append_operational_contract_audit/);
  assert.match(migration, /revoke all on table internal\.tencent_trial_ledger_outbox/);

  assert.match(route, /TENCENT_TRIAL_LEDGER_BRIDGE_TOKEN/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /createHmac/);
  assert.match(route, /completionProof/);
  assert.match(route, /manifest does not match the claimed projection/);
  assert.match(route, /claimTencentTrialLedgerSyncBatch/);
  assert.match(route, /completeTencentTrialLedgerSyncBatch/);
  assert.match(route, /failTencentTrialLedgerSyncBatch/);
  assert.match(route, /buildTencentTrialLedgerMirrorRows/);
  assert.match(route, /read them back before POSTing/);
  assert.doesNotMatch(route, /console\.error\([^\n]*rows|console\.error\([^\n]*payload/);

  assert.match(store, /TENCENT_TRIAL_LEDGER_SYNC_CLAIM_RPC/);
  assert.match(store, /TENCENT_TRIAL_LEDGER_SYNC_COMPLETE_RPC/);
  assert.match(store, /TENCENT_TRIAL_LEDGER_SYNC_FAIL_RPC/);
  assert.match(mirror, /DSUtQaFFNQXZMU01u/);
  assert.match(client, /腾讯复盘台账/);
  assert.match(readme, /dedicated 13-column trial-review SmartSheet/);
});

test("the mirror exposes exactly the boss handbook's 13 visible columns", async () => {
  const mirror = await read("lib/tencent-trial-ledger-mirror.ts");
  for (const title of [
    "学生姓名", "家长微信名", "LP 类型", "上课月份", "请求日期/时间",
    "上课日期和时间（墨尔本）", "教务", "课程规划老师", "科目", "老师",
    "试听状态", "是否付费", "备注",
  ]) assert.match(mirror, new RegExp(title.replace(/[()]/gu, "\\$&")));
  assert.doesNotMatch(mirror, /系统记录ID/);
});

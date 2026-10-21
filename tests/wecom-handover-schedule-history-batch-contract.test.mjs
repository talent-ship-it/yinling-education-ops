import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021085243_batch_wecom_handover_schedule_history_reads.sql", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-history-batch-runtime.sql", import.meta.url), "utf8");

test("batched history reader validates every original raw date and suppresses all current keys", () => {
  assert.match(migration, /coalesce\(i\.item -> 'record' ->> 'dated',''\) collate "C" as source_date_text/u);
  assert.match(migration, /date_values as materialized \(\s*select distinct source_date_text from raw_records/u);
  assert.match(migration, /date_map as materialized \(\s*select source_date_text,internal\.wecom_schedule_date\(source_date_text\)/u);
  assert.match(migration, /from raw_records r join date_map d using\(source_date_text\)/u);
  assert.match(migration, /\(select count\(source_day\) from records\)/u);
  assert.match(migration, /current_source_keys as materialized \(\s*select i\.source_key from internal\.jiaowubao_open_api_schedule_snapshot_ingest_items i where i\.run_id = current_run\s*\)/u);
  assert.match(migration, /where i\.id = current_run or \(i\.latest_run_id = i\.id and current_item\.source_key is null\)/u);
  assert.match(migration, /statement_timeout = '12s'/u);
  assert.match(migration, /statement_timeout = '13s'/u);
  assert.doesNotMatch(migration, /(?:create table|create index|insert into|delete from|alter role|set jit)/u);
});

test("batched history reader has disposable parity and fail-closed runtime coverage", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-history-batch");
  assert.equal(fixture?.source, "tests/sql/wecom-handover-schedule-history-batch-runtime.sql");
  for (const condition of ["batched_reader_changed_input", "batched_reader_modified_native_evidence",
    "current_key_outside_history_range_revived_old_event", "distinct_date_map_silently_dropped_invalid_source",
    "batched_save_reconstitution_failed", "batched_reader_secret_guard_missing", "batched_rpc_local_budgets_missing"]) {
    assert.ok(runtime.includes(condition));
  }
  assert.match(runtime, /set plan_cache_mode = force_generic_plan/u);
  assert.match(runtime, /array\['missing','null','empty','duplicate-invalid','nontrial-unselected'\]/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021092450_retain_wecom_handover_trial_records.sql", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-history-retained-runtime.sql", import.meta.url), "utf8");

test("retained history reader carries JSON only for exactly selected conservative trial days", () => {
  assert.match(migration, /array_agg\(day::text collate "C"\) as selected_dates/u);
  assert.match(migration, /select s\.id,s\.revision,s\.completed_at,i\.source_key,raw_date\.source_date_text,\s*case when raw_date\.source_date_text = any\(s\.selected_dates\) then\s*case when internal\.is_wecom_schedule_trial_record\(i\.item -> 'record'\) then i\.item -> 'record' end\s*end as record/u);
  assert.match(migration, /coalesce\(i\.item -> 'record' ->> 'dated',''\) collate "C" as source_date_text offset 0/u);
  assert.match(migration, /select r\.id,r\.revision,r\.completed_at,r\.source_key,r\.record,d\.source_day/u);
  assert.match(migration, /select s\.day,i\.id,i\.revision,i\.completed_at,i\.source_key,i\.record,latest\.run_id/u);
  assert.match(migration, /shaped as \(\s*select \* from surviving where record is not null/u);
  assert.doesNotMatch(migration, /join internal\.jiaowubao_open_api_schedule_snapshot_ingest_items i on i\.run_id=s\.id/u);
});

test("retained history reader keeps strict validation and global current-key precedence", () => {
  assert.match(migration, /date_values as materialized \(\s*select distinct source_date_text from raw_records/u);
  assert.match(migration, /date_map as materialized \(\s*select source_date_text,internal\.wecom_schedule_date\(source_date_text\)/u);
  assert.match(migration, /from raw_records r join date_map d using\(source_date_text\)/u);
  assert.match(migration, /\(select count\(source_day\) from records\)/u);
  assert.match(migration, /current_source_keys as materialized \(\s*select i\.source_key from internal\.jiaowubao_open_api_schedule_snapshot_ingest_items i where i\.run_id = current_run\s*\)/u);
  assert.match(migration, /where i\.id = current_run or \(i\.latest_run_id = i\.id and current_item\.source_key is null\)/u);
  assert.match(migration, /from candidate_items where id <> current_run and latest_run_id is null/u);
  assert.match(migration, /internal\.wecom_schedule_event\(source_key,record,revision,id,id <> current_run\)/u);
  assert.match(migration, /statement_timeout = '12s' set work_mem = '32MB' set enable_indexscan = off/u);
  assert.doesNotMatch(migration, /(?:create table|create index|insert into|delete from|alter role|set jit|set statement_timeout = '13s')/u);
});

test("retained history fixture runs parity and fail-closed cases after the new migration", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-history-retained");
  assert.equal(fixture?.source, "tests/sql/wecom-handover-schedule-history-retained-runtime.sql");
  const after = runtime.split("\\ir ../../supabase/migrations/20261021092450_retain_wecom_handover_trial_records.sql")[1];
  assert.ok(after);
  for (const condition of ["retained_reader_changed_complete_input", "retained_reader_modified_native_evidence",
    "retained_assigned_day_hole_or_current_nontrial_outside_range_changed", "retained_save_reconstitution_failed",
    "retained_save_replay_created_business_records", "retained_rpc_local_settings_or_restore_failed",
    "retained_reader_secret_guard_missing", "retained_invalid_source_date_was_filtered",
    "retained_nontrial_stub_bypassed_missing_cache", "retained_invalid_trial_or_unknown_members_was_filtered",
    "retained_reader_error_leaked_local_guc"]) {
    assert.ok(after.includes(condition), condition);
  }
  assert.match(after, /array\['force_custom_plan','force_generic_plan'\]/u);
  assert.match(after, /array\['missing','null','empty','duplicate-invalid','nontrial-unselected'\]/u);
  assert.match(after, /array\['invalid-trial-clock','unknown-participants'\]/u);
});

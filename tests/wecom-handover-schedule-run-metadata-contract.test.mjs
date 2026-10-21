import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021122214_cache_wecom_schedule_run_metadata.sql", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-run-metadata-runtime.sql", import.meta.url), "utf8");

test("run metadata stays private and preserves RPC budgets while deriving authenticated narrow evidence", () => {
  assert.match(migration, /alter table internal\.wecom_schedule_run_metadata enable row level security/u);
  assert.match(migration, /revoke all on internal\.wecom_schedule_run_metadata from public, anon, authenticated, service_role/u);
  assert.match(migration, /statement_timeout = '12s' set work_mem = '32MB' set enable_indexscan = off/u);
  assert.doesNotMatch(migration, /create or replace function public\.(?:save_|complete_|stage_)|grant .*internal\.|alter role|set jit/u);
  assert.match(migration, /string_agg\(i\.item::text,'' order by i\.page_index,i\.item_index\)/u);
  assert.match(migration, /jsonb_object_agg\(i\.source_key,true\) filter\(where internal\.is_wecom_schedule_trial_record/u);
  assert.doesNotMatch(migration, /left join current_source_keys/u);
  assert.match(migration, /surviving_trials as materialized \(\s*select \* from surviving where is_trial/u);
  assert.match(migration, /left join lateral \(\s*select i\.run_id,i\.item.*?offset 0\s*\) i on true/su);
});

test("release SQL manifest executes cache integrity and concurrent append acceptance cases", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-run-metadata");
  assert.deepEqual(fixture?.steps, [
    { kind: "sql", file: "tests/sql/wecom-handover-schedule-run-metadata-runtime.sql" },
    { kind: "python", file: "tests/sql/wecom-handover-schedule-run-metadata-concurrency.py" },
  ]);
  for (const condition of ["metadata_missing_receipt_accepted", "metadata_complete_input_changed",
    "metadata_backfill_modified_native_evidence", "metadata_bad_receipt_accepted", "metadata_late_source_record_missing_accepted",
    "metadata_zero_row_coverage_missing", "metadata_invalid_selected_raw_date_accepted", "metadata_nontrial_missing_latest_cache_accepted",
    "metadata_owner_append_failed_to_invalidate_receipt_and_evidence", "metadata_invalid_trial_was_filtered",
    "metadata_mutation_did_not_invalidate", "metadata_current_outside_range_keys_or_date_semantics_changed",
    "metadata_backfill_accepted_repeatable_read", "metadata_invalid_trial_map_accepted",
    "metadata_prior_trial_rule_cache_accepted", "metadata_changed_trial_rule_cache_not_rebuilt",
    "metadata_changed_raw_hash_accepted_after_rebuild", "metadata_changed_rule_left_old_get_evidence_visible",
    "metadata_rule_backfill_revived_stale_get_evidence", "metadata_rule_refresh_did_not_restore_current_evidence",
    "metadata_get_accepted_missing_complete_run_receipt", "metadata_get_accepted_empty_receipt_table",
    "metadata_refresh_accepted_repeatable_read", "metadata_item_invalidation_accepted_repeatable_read", "metadata_run_index_accepted_repeatable_read", "metadata_wide_current_full_input_changed",
    "metadata_normal_completion_failed_to_build_and_publish", "metadata_staging_built_receipt", "metadata_empty_current_full_input_changed",
    "metadata_read_only_repeatable_read_input_changed"]) assert.ok(runtime.includes(condition), condition);
});

test("rule changes hide GET evidence immediately and advance the epoch when an old receipt is rebuilt", () => {
  const getter = migration.slice(migration.indexOf("create or replace function public.read_wecom_handover_schedule_evidence("));
  assert.equal((getter.match(/internal\.wecom_schedule_trial_rule_fingerprint\(\)/gu) || []).length, 1);
  assert.match(getter, /c\.trial_rule_fingerprint=current_trial_rule/u);
  assert.match(getter, /c\.run_id is null/u);
  assert.doesNotMatch(getter, /source_dates|jsonb_each/u);
  assert.match(migration, /if prior_trial_rule is not null and prior_trial_rule is distinct from trial_rule then\s*update internal\.wecom_handover_schedule_epoch/u);
  assert.ok(runtime.includes("20261021112432_avoid_wecom_schedule_current_key_nested_loop.sql"));
});


test("metadata writers enforce fresh snapshots and acquire parent rows before advisory locks", () => {
  for (const name of ["refresh_wecom_schedule_run_metadata", "invalidate_wecom_schedule_item_metadata", "index_wecom_schedule_run_metadata", "backfill_wecom_schedule_run_metadata"]) {
    const start = migration.indexOf(`create function internal.${name}(`);
    const body = migration.slice(start, migration.indexOf("$$;", start));
    assert.match(body, /perform internal\.assert_wecom_schedule_metadata_write_isolation\(\)/u);
    assert.match(body, /for share/u);
    const advisory = body.indexOf("pg_advisory_xact_lock");
    if (advisory !== -1) assert.ok(body.indexOf("for share") < advisory, name);
  }
  const concurrency = readFileSync(new URL("./sql/wecom-handover-schedule-run-metadata-concurrency.py", import.meta.url), "utf8");
  assert.match(concurrency, /public\.complete_jiaowubao_open_api_schedule_snapshot_ingest/u);
  assert.match(concurrency, /metadata_append_parent_wait/u);
  assert.match(concurrency, /metadata_completion_parent_wait/u);
});

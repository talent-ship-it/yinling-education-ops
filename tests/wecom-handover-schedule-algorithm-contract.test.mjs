import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021094454_version_wecom_handover_schedule_evidence.sql", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-algorithm-runtime.sql", import.meta.url), "utf8");

test("algorithm migration guards selectors, writes, and cache reads with one private version", () => {
  assert.match(migration, /create function internal\.wecom_handover_schedule_algorithm_version\(\)\s*returns text language sql immutable set search_path = '' as \$\$ select '2'::text; \$\$;/u);
  assert.match(migration, /revoke all on function internal\.wecom_handover_schedule_algorithm_version\(\) from public, anon, authenticated, service_role/u);
  assert.equal((migration.match(/or e\.evidence -> 'algorithmVersion' is distinct from to_jsonb\(internal\.wecom_handover_schedule_algorithm_version\(\)\)/gu) ?? []).length, 2);
  assert.match(migration, /and e\.evidence -> 'algorithmVersion' = to_jsonb\(internal\.wecom_handover_schedule_algorithm_version\(\)\)/u);
  const save = migration.slice(migration.indexOf("create or replace function public.save_wecom_handover_schedule_evidence"));
  assert.ok(save.indexOf("wecom_schedule_algorithm_changed") < save.indexOf("for share"));
  assert.ok(save.indexOf("wecom_schedule_algorithm_changed") < save.indexOf("input := public.read_wecom_handover_schedule_input"));
  assert.match(save, /item -> 'algorithmVersion' is distinct from to_jsonb\(internal\.wecom_handover_schedule_algorithm_version\(\)\)/u);
  assert.match(save, /entry - array\[[^\]]*'algorithmVersion'\]::text\[\]/u);
  assert.match(save, /not\(entry \?& array\[[^\]]*'algorithmVersion'\]\)/u);
  assert.match(save, /unnest\(array\[[^\]]*'algorithmVersion'\]\)/u);
  assert.match(migration, /update internal\.wecom_handover_schedule_epoch set revision = revision \+ 1 where singleton/u);
  assert.match(migration, /if not found then\s*raise exception using errcode = '55000', message = 'wecom_schedule_epoch_missing'/u);
});

test("algorithm migration keeps protected reader budgets and business guards", () => {
  assert.match(migration, /statement_timeout = '12s' set work_mem = '32MB' set enable_indexscan = off/u);
  assert.match(migration, /statement_timeout = '13s' set work_mem = '32MB'/u);
  assert.equal((migration.match(/invalid_ops_secret/gu) ?? []).length, 3);
  assert.equal((migration.match(/grant execute on function public\./gu) ?? []).length, 3);
  assert.doesNotMatch(migration, /(?:create table|create index|alter role|set jit|update public\.ops_state|update internal\.wecom_archive_messages)/u);
});

test("algorithm fixture verifies legacy invalidation and early old-worker rejection after migration", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-algorithm");
  assert.equal(fixture?.source, "tests/sql/wecom-handover-schedule-algorithm-runtime.sql");
  const after = runtime.split("\\ir ../../supabase/migrations/20261021094454_version_wecom_handover_schedule_evidence.sql")[1];
  assert.ok(after);
  for (const condition of ["algorithm_fixture_or_exact_increment_failed", "algorithm_did_not_invalidate_and_reselect",
    "algorithm_old_version_same_epoch_became_current", "algorithm_rewrote_stored_evidence", "algorithm_accepted_old_projection",
    "algorithm_current_save_did_not_restore", "algorithm_modified_business_identity",
    "algorithm_disabled_native_invalidation", "algorithm_privileges_or_runtime_settings_changed",
    "algorithm_called_expensive_reader", "algorithm_old_worker_was_accepted",
    "algorithm_wrong_version_cache_was_visible", "algorithm_old_worker_changed_cached_batch",
    "algorithm_version_weakened_exact_key_whitelist", "algorithm_sentinel_rollback_did_not_restore_reader"]) {
    assert.ok(after.includes(condition), condition);
  }
  assert.match(after, /array\['missing','old','numeric','null','future'\]/u);
});

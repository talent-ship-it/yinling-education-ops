import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021080306_stabilize_wecom_handover_schedule_history_plan.sql", import.meta.url), "utf8");

test("history optimization keeps private metadata and bounded protected RPC settings", () => {
  assert.match(migration, /alter table internal\.wecom_schedule_latest_complete_source enable row level security/u);
  assert.match(migration, /revoke all on internal\.wecom_schedule_latest_complete_source from public, anon, authenticated, service_role/u);
  assert.match(migration, /lock table internal\.jiaowubao_open_api_schedule_snapshot_ingest_runs in share row exclusive mode/u);
  assert.match(migration, /statement_timeout = '10s'/u);
  assert.match(migration, /statement_timeout = '12s'/u);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) (?:public\.ops_state|internal\.wecom_archive_messages|internal\.wecom_lp_confirmations)\b/u);
});

test("history cache has a registered disposable behavioral fixture", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-history-cache");
  assert.equal(fixture?.source, "tests/sql/wecom-handover-schedule-history-cache-runtime.sql");
  const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-history-cache-runtime.sql", import.meta.url), "utf8");
  for (const condition of ["latest_complete_source_backfill_failed", "complete_trigger_not_incremental",
    "latest_cache_current_precedence_or_reschedule_failed", "missing_historical_cache_was_accepted",
    "out_of_window_invalid_date_silently_dropped", "cache_backfill_modified_native_evidence"]) {
    assert.ok(runtime.includes(condition));
  }
});

test("SQL trial course cases match the matcher JavaScript Unicode boundary", () => {
  const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-history-cache-runtime.sql", import.meta.url), "utf8");
  const cases = JSON.parse(runtime.split("$trial_cases$")[1]);
  for (const { course, expected } of cases) {
    assert.equal(/试听|视听|\btrial\b/iu.test(course.trim()), expected, course);
  }
});

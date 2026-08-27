import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration005, migration006, fixture] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819100500_review_jiaowubao_schedule_label_mappings.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL(
    "../supabase/migrations/20260819100600_materialize_jiaowubao_schedule_mapping_candidates.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("./sql/jiaowubao-schedule-mapping-snapshot-performance.sql", import.meta.url), "utf8"),
]);

function functionBody(sql, schema, name) {
  return sql.match(new RegExp(
    `create or replace function ${schema}\\.${name}[\\s\\S]*?\\$${name}\\$;`,
    "i",
  ))?.[0] ?? "";
}

test("006 creates a private immutable per-completed-run snapshot and race-free backfill", () => {
  assert.match(migration006, /create table if not exists internal\.jiaowubao_direct_schedule_mapping_snapshot_manifests/i);
  assert.match(migration006, /create table if not exists internal\.jiaowubao_direct_schedule_mapping_candidate_snapshots/i);
  assert.match(migration006, /payload_sha256 text not null/i);
  assert.match(migration006, /completion_audit_id uuid not null/i);
  assert.match(migration006, /candidate_set_sha256 text not null/i);
  assert.match(migration006, /primary key \(run_id, mapping_key\)/i);
  assert.match(migration006, /unique \(run_id, teacher_label_key, course_label_key\)/i);
  assert.match(migration006, /enable row level security/i);
  assert.match(migration006, /revoke all on table internal\.jiaowubao_direct_schedule_mapping_candidate_snapshots/i);
  assert.match(migration006, /jiaowubao_schedule_mapping_snapshot_append_only/i);
  assert.match(migration006, /lock table internal\.jiaowubao_direct_import_runs in exclusive mode/i);
  assert.match(migration006, /after update of state on internal\.jiaowubao_direct_import_runs/i);
  assert.match(migration006, /when \(old\.state = 'staging' and new\.state = 'complete'\)/i);
  assert.match(migration006, /for completed_run in[\s\S]*?where run_state\.state = 'complete'/i);
  assert.match(migration006, /assert_jiaowubao_direct_schedule_mapping_snapshot_integrity/i);
  assert.doesNotMatch(migration006, /\bupdate\s+internal\.jiaowubao_direct_schedule_events\b/i);
  assert.doesNotMatch(migration006, /internal\.jiaowubao_direct_current_schedule_blocks/i);
  assert.doesNotMatch(migration006, /availability_effect\s*=/i);
});

test("source proof is calculated once at materialization, while runtime candidates remain snapshot-only", () => {
  const source = functionBody(
    migration006,
    "internal",
    "jiaowubao_direct_schedule_mapping_snapshot_source",
  );
  const candidate = functionBody(
    migration006,
    "internal",
    "jiaowubao_direct_schedule_mapping_candidates",
  );
  const manifest = functionBody(
    migration006,
    "internal",
    "jiaowubao_direct_schedule_mapping_snapshot_manifest",
  );
  const integrity = functionBody(
    migration006,
    "internal",
    "assert_jiaowubao_direct_schedule_mapping_snapshot_integrity",
  );

  assert.match(source, /base_rows as materialized/i);
  assert.match(source, /string_agg\(source_rows\.record_sha256, ',' order by source_rows\.record_sha256\)/i);
  assert.match(source, /jiaowubao-direct-schedule-label-mapping-candidate-v1/i);
  assert.match(source, /internal\.jiaowubao_direct_schedule_events/i);
  assert.match(candidate, /candidate_snapshots/i);
  assert.match(candidate, /snapshot_manifest/i);
  assert.doesNotMatch(candidate, /jiaowubao_direct_schedule_events/i);
  assert.doesNotMatch(manifest, /snapshot_digest/i, "runtime header validation must stay page-bounded");
  assert.match(integrity, /snapshot_digest/i, "full compact digest belongs to materialize/reconciliation only");
});

test("post-006 GET, PUT, and append-only decision guard cannot re-read source schedule events", () => {
  const reader = functionBody(
    migration006,
    "public",
    "get_jiaowubao_direct_schedule_mapping_review",
  );
  const put = functionBody(
    migration005,
    "public",
    "put_jiaowubao_direct_schedule_label_mapping",
  );
  const guard = functionBody(
    migration005,
    "internal",
    "jiaowubao_direct_schedule_mapping_decision_guard",
  );

  assert.match(reader, /page_keys as materialized/i);
  assert.match(reader, /order by snapshot\.mapping_key[\s\S]*?limit p_limit \+ 1/i);
  assert.ok(
    reader.indexOf("page_keys as materialized") < reader.indexOf("page_classified as materialized"),
    "the indexed keyset page must be selected before page classification",
  );
  assert.match(reader, /saved_snapshot_manifest\.candidate_count/i);
  assert.doesNotMatch(reader, /jiaowubao_direct_schedule_events/i);
  assert.doesNotMatch(put, /jiaowubao_direct_schedule_events/i);
  assert.doesNotMatch(guard, /jiaowubao_direct_schedule_events/i);
  assert.match(put, /internal\.jiaowubao_direct_schedule_mapping_candidates\(saved_run\.id\)/i);
  assert.match(guard, /internal\.jiaowubao_direct_schedule_mapping_candidates\(new\.run_id\)/i);
});

test("the rollback scale fixture proves 005 v1 parity and bounds GET/cursor/PUT at 39,743 events", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;$/im);
  assert.match(fixture, /20260819100500_review_jiaowubao_schedule_label_mappings\.sql/i);
  assert.match(fixture, /20260819100600_materialize_jiaowubao_schedule_mapping_candidates\.sql/i);
  assert.ok(
    fixture.indexOf("20260819100500_review_jiaowubao_schedule_label_mappings.sql")
      < fixture.indexOf("20260819100600_materialize_jiaowubao_schedule_mapping_candidates.sql"),
  );
  assert.match(fixture, /generate_series\(1, 39743\)/i);
  assert.match(fixture, /% 359/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_005_expected/i);
  assert.match(fixture, /except all/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_snapshot_v1_parity_failed/i);
  assert.match(fixture, /snapshot_runtime_raw_source_access_failed/i);
  assert.match(fixture, /statement_timeout', '500ms'/i);
  assert.match(fixture, /snapshot_get_performance_failed/i);
  assert.match(fixture, /snapshot_cursor_performance_failed/i);
  assert.match(fixture, /snapshot_pagination_duplicate_failed/i);
  assert.match(fixture, /snapshot_pagination_coverage_failed/i);
  assert.match(fixture, /snapshot_put_performance_failed/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL(
  "../supabase/migrations/20260821220000_jiaowubao_open_api_schedule_snapshot_ingest.sql",
  import.meta.url,
), "utf8");

test("JWB Open API schedule ingest is a separate private evidence protocol", () => {
  assert.match(migration, /jiaowubao_open_api_schedule_snapshot_ingest_runs/);
  assert.match(migration, /jiaowubao_open_api_schedule_snapshot_ingest_pages/);
  assert.match(migration, /jiaowubao_open_api_schedule_snapshot_ingest_items/);
  assert.match(migration, /jiaowubao_open_api_schedule_snapshot_current/);
  assert.doesNotMatch(migration, /student_import_source_rows/);
  assert.doesNotMatch(migration, /insert\s+into\s+(?:public\.)?(?:students|bookings|tasks)/i);
  assert.match(migration, /state in \('staging', 'complete', 'aborted'\)/);
  assert.match(migration, /no native projection/i);
});

test("schedule ingest is chunked, bounded, canonical, and replay-safe", () => {
  assert.match(migration, /stage_jiaowubao_open_api_schedule_snapshot_page/);
  assert.match(migration, /octet_length\(p_rows::text\) > 2097152/);
  assert.match(migration, /primary key \(run_id, page_index\)/);
  assert.match(migration, /unique \(run_id, source_key\)/);
  assert.match(migration, /page_conflict/);
  assert.match(migration, /replayed/);
  assert.match(migration, /expected_page_count/);
  assert.match(migration, /expected_row_count/);
  assert.match(migration, /expected_page_count between 0 and 500/);
  assert.match(migration, /expected_row_count between 0 and 50000/);
  assert.match(migration, /expected_current_revision text check/);
  assert.match(migration, /row_count between 1 and 100/);
  assert.match(migration, /external_manifest_sha256/);
  assert.match(migration, /canonical_rows_sha256/);
  assert.match(migration, /p_envelope \?& ARRAY\['apiSourceKey','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata'\]/);
  assert.match(migration, /item_value \?& ARRAY\['sourceKey','record'\]/);
  assert.match(migration, /item_value -> 'record'\) \?& ARRAY\['cal_id'\]/);
  assert.match(migration, /rows_hash/);
  assert.match(migration, /jsonb::text/);
  assert.match(migration, /source_key/);
  assert.match(migration, /unique \(run_id, source_key\)/);
});

test("only a completed run can replace the API-source pointer", () => {
  assert.match(migration, /complete_jiaowubao_open_api_schedule_snapshot_ingest/);
  assert.match(migration, /pages_incomplete/);
  assert.match(migration, /current_pointer_conflict/);
  assert.match(migration, /observed_current_revision is distinct from run_state\.expected_current_revision/);
  assert.doesNotMatch(migration, /expected_rows_sha256/);
  assert.match(migration, /state='complete'/);
  assert.match(migration, /on conflict\(api_source_key\) do update/);
  assert.match(migration, /abort_jiaowubao_open_api_schedule_snapshot_ingest/);
  assert.match(migration, /delete from internal\.jiaowubao_open_api_schedule_snapshot_ingest_items/);
  assert.match(migration, /delete from internal\.jiaowubao_open_api_schedule_snapshot_ingest_pages/);
});

test("API secret is never part of the snapshot envelope or persisted tables", () => {
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(migration, /p_envelope -> 'query'\)::text\).*sk\|secret\|token\|password/);
  assert.match(migration, /p_envelope -> 'query'\) - ARRAY\['start','end','limit','order'\]/);
  assert.match(migration, /lower\(\(p_envelope -> 'sourceMetadata'\)::text\).*sk\|secret\|token\|password/);
  assert.match(migration, /p_envelope -> 'sourceMetadata'\) - ARRAY\['exportFormat','manifestSha256','recordsSha256'\]/);
  assert.match(migration, /stu_list\|student\|name\|price\|cont\|logo\|note\|remark/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_open_api_schedule_snapshot_ingest_runs from public, anon, authenticated/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_open_api_schedule_snapshot_ingest_pages from public, anon, authenticated/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_open_api_schedule_snapshot_ingest_items from public, anon, authenticated/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_open_api_schedule_snapshot_current from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.begin_jiaowubao_open_api_schedule_snapshot_ingest/);
  assert.doesNotMatch(migration, /grant execute .*jiaowubao_open_api_schedule_snapshot/i);
});

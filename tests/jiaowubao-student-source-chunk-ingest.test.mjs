import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL(
    "../supabase/migrations/20260821105524_chunk_jiaowubao_student_source_ingest.sql",
    import.meta.url,
  ),
  "utf8",
);
const fixture = await readFile(
  new URL("./sql/jiaowubao-student-source-chunk-ingest-contract.sql", import.meta.url),
  "utf8",
);

const rpc = (name) => {
  const marker = `create or replace function public.${name}(`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `${name} is missing`);
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${name} is unterminated`);
  return sql.slice(start, end + 4);
};

test("JWB student source staging exposes the bounded resumable RPC contract", () => {
  for (const name of [
    "get_jiaowubao_student_source_ingest_preflight",
    "begin_jiaowubao_student_source_ingest",
    "stage_jiaowubao_student_source_chunk",
    "get_jiaowubao_student_source_ingest_status",
    "complete_jiaowubao_student_source_ingest",
    "abort_jiaowubao_student_source_ingest",
  ]) {
    const body = rpc(name);
    assert.match(body, /internal\.verify_ops_secret\(p_secret\)/);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = ''/i);
    assert.match(body, /p_actor not in \('Nixon', 'Ops Admin'\)/);
  }
  assert.match(sql, /content_bytes integer not null check \(content_bytes between 1 and 2097152\)/);
  assert.match(sql, /expected_chunk_count integer not null check \(expected_chunk_count between 1 and 512\)/);
  assert.match(sql, /chunk_index integer not null check \(chunk_index between 0 and 511\)/);
  assert.match(sql, /octet_length\(p_closures::text\) > 2097152/);
  assert.match(sql, /jiaowubao_student_source_chunk_sequence_gap/);
  assert.match(sql, /jiaowubao_student_source_chunk_conflict/);
  assert.match(sql, /jiaowubao_student_source_source_row_conflict/);
  assert.match(sql, /rowCanonicalJson/);
  assert.match(sql, /closureCanonicalJson/);
  assert.match(sql, /normalized_rows_sha256/);
  assert.match(sql, /expected_published_rows_sha256/);
  assert.match(sql, /expectedPublishedJwb/);
  assert.match(sql, /jiaowubao_student_source_jsonb_object_size/);
  assert.match(sql, /pg_catalog\.jsonb_object_keys/);
  assert.doesNotMatch(sql, /\bjsonb_object_length\(/);
  assert.match(sql, /jiaowubao_student_source_normalized_rows_conflict/);
  assert.match(sql, /\^sha256:\[a-f0-9\]\{64\}\$/);
});

test("publication remains invisible until complete and cannot mutate business state", () => {
  const complete = rpc("complete_jiaowubao_student_source_ingest");
  assert.match(complete, /state <> 'staging'/);
  assert.match(complete, /expected_chunk_count/);
  assert.match(complete, /expected_row_count/);
  assert.match(complete, /set_config\(/);
  assert.match(complete, /internal\.jiaowubao_student_source_publish_run_id/);
  assert.match(complete, /public\.put_student_import_source_rows\(/);
  assert.match(complete, /normalized_rows_sha256/);
  assert.match(complete, /student_import_source:jwb/);
  assert.match(complete, /for update/);
  assert.match(complete, /jiaowubao_student_source_publication_pointer_changed/);
  assert.doesNotMatch(complete, /update public\.ops_state/i);
  assert.doesNotMatch(complete, /internal\.student_import_identity_link_sets/i);
  assert.doesNotMatch(complete, /insert into public\.(students|bookings|packages)/i);

  const stage = rpc("stage_jiaowubao_student_source_chunk");
  assert.doesNotMatch(stage, /internal\.student_import_source_rows\s+(?:insert|update|delete)/i);
  const status = rpc("get_jiaowubao_student_source_ingest_status");
  assert.doesNotMatch(status, /source_metadata/);
  assert.doesNotMatch(status, /source_revisions/);
  assert.doesNotMatch(status, /closures\b/);
});

test("legacy one-shot JWB ingest is fail-closed while master remains allowed", () => {
  assert.match(sql, /guard_legacy_jiaowubao_student_source_ingest/);
  assert.match(sql, /jiaowubao_student_source_chunked_ingest_required/);
  assert.match(sql, /new\.source_kind = 'jwb'/);
  assert.match(sql, /internal\.jiaowubao_student_source_publish_run_id/);
  assert.match(sql, /before insert or update or delete on internal\.student_import_source_rows/);
  assert.match(sql, /current_setting\('internal\.jiaowubao_student_source_abort_run_id', true\)/);
});

test("abort is the only chunk cleanup path and completed chunks are immutable", () => {
  const abort = rpc("abort_jiaowubao_student_source_ingest");
  assert.match(abort, /set_config\(/);
  assert.match(abort, /delete from internal\.jiaowubao_student_source_ingest_chunks/);
  assert.match(abort, /state = 'aborted'/);
  assert.match(sql, /jiaowubao_student_source_chunk_immutable/);
  assert.match(sql, /jiaowubao_student_source_chunk_delete_forbidden/);
  assert.match(sql, /jiaowubao_student_source_run_immutable/);
  assert.match(sql, /before update or delete on internal\.jiaowubao_student_source_ingest_runs/i);
  assert.match(sql, /state = 'complete'[\s\S]*payload_sha256 is not null/);
  assert.match(sql, /state = 'aborted'[\s\S]*abort_audit_id is not null/);
});

test("rollback fixture covers the complete resumable lifecycle without business writes", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;$/im);
  assert.match(fixture, /20260821105524_chunk_jiaowubao_student_source_ingest\.sql/i);
  assert.match(fixture, /chunk_sequence_gap/i);
  assert.match(fixture, /chunk_conflict/i);
  assert.match(fixture, /source_row_conflict/i);
  assert.match(fixture, /source_pointer/i);
  assert.match(fixture, /where source_kind = 'master'/i);
  assert.match(fixture, /state_row\.entity in \('students', 'packages', 'bookings', 'tasks'\)/i);
  assert.match(fixture, /identity_links_before/i);
  assert.match(fixture, /abort_cleanup_failed|delete from internal\.jiaowubao_student_source_ingest_chunks/i);
  assert.match(fixture, /jiaowubao_student_source_fixture_closures/i);
  assert.match(fixture, /normalizedRowsSha256/i);
  assert.match(fixture, /expectedPublishedJwb/i);
  assert.match(fixture, /publication_pointer_changed/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
});

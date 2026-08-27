import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260818001100_ingest_jiaowubao_static_excel_supplements.sql",
    import.meta.url,
  ),
  "utf8",
);

const fixture = await readFile(
  new URL(
    "./sql/jiaowubao-static-excel-supplement-contract.sql",
    import.meta.url,
  ),
  "utf8",
);

test("static JWB Excel supplements are isolated from operational student and booking state", () => {
  assert.doesNotMatch(migration, /public\.ops_state/i);
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from)\s+public\./i);
  assert.doesNotMatch(migration, /put_student_import_source_rows/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_static_excel_batches/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_static_excel_records/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_static_excel_record_attachments/i);
  assert.match(migration, /enable row level security/i);
});

test("the master-only reader and the only new writer are secret-gated, chunked, auditable, and replay-safe", () => {
  const writers = migration.match(/create or replace function public\./gi) ?? [];
  assert.equal(writers.length, 2);
  assert.match(
    migration,
    /create or replace function public\.get_current_student_import_master_source\(\s*p_secret text\s*\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  );
  assert.match(migration, /static_excel_master_source_unavailable/i);
  assert.match(migration, /'masterSource'/i);
  assert.match(migration, /invalid_static_excel_master_source/i);
  assert.match(migration, /static_excel_master_source_changed/i);
  assert.match(
    migration,
    /create or replace function public\.put_jiaowubao_static_excel_supplement\(\s*p_secret text,\s*p_source_id text,\s*p_revision text,\s*p_batch jsonb,\s*p_actor text\s*\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  );
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /chunk_count between 1 and 512/i);
  assert.match(migration, /static_excel_chunk_size_limit_exceeded/i);
  assert.match(migration, /static_excel_chunk_conflict/i);
  assert.match(migration, /static_excel_chunk_sequence_gap/i);
  assert.match(migration, /'jiaowubao_static_excel\.chunk_staged'/i);
  assert.match(migration, /'jiaowubao_static_excel\.batch_completed'/i);
  assert.match(migration, /'replayed', true/i);
  // PostgreSQL parses `->` and `-` in a way that can otherwise make this
  // JSONB schema validation try to subtract an array from a string literal.
  // Keep the selected JSONB object parenthesized before removing allowed keys.
  assert.match(migration, /\(p_batch\s*->\s*'recordCounts'\)\s*-\s*ARRAY\[/i);
  assert.match(migration, /\(p_batch\s*->\s*'chunk'\)\s*-\s*ARRAY\[/i);
});

test("attachments remain Tencent-gated and preserve one schedule cell with many safe links", () => {
  assert.match(migration, /attachment_index integer not null check \(attachment_index between 1 and 250\)/i);
  assert.match(migration, /static_excel_attachment_excluded_master_forbidden/i);
  assert.match(migration, /trim\(coalesce\(master_row\.value ->> 'status', ''\)\) = '不活跃 \+ 无课时'/i);
  assert.match(migration, /static_excel_attachment_master_row_unknown/i);
  assert.match(migration, /static_excel_attachment_name_mismatch/i);
  assert.match(migration, /evidence_name text/i);
  assert.match(migration, /'evidenceName'/i);
  assert.match(migration, /attachment\.value\s*->>\s*'matchMode'\s*<>\s*'exact_name'/i);
  assert.match(migration, /'review_required_annotation'/i);
  assert.match(migration, /'non_operational_static_schedule'/i);
  assert.match(migration, /static_excel_schedule_source_cell_required/i);
  assert.match(migration, /\['workbook', 'row', 'cell'\]/i);
});

test("the ledger allows the measured expanded evidence batch while preserving a hard bound", () => {
  assert.match(migration, /received_bytes integer not null default 0 check \(received_bytes between 0 and 134217728\)/i);
  assert.match(migration, /saved_batch\.received_bytes \+ chunk_bytes > 134217728/i);
  assert.match(migration, /content_bytes integer not null check \(content_bytes between 1 and 2097152\)/i);
});

test("the disposable 170008 SQL fixture restores its audit writer only inside its rollback transaction", () => {
  assert.match(fixture, /begin;[\s\S]*?create or replace function internal\.append_operational_contract_audit\(/i);
  assert.match(fixture, /insert into internal\.operational_contract_audit/i);
  assert.match(fixture, /\$jiaowubao_static_excel_fixture_audit\$/i);
  assert.match(fixture, /\bir\s+\.\.\/\.\.\/supabase\/migrations\/20260818001100_ingest_jiaowubao_static_excel_supplements\.sql/i);
  assert.match(fixture, /rollback;\s*$/i);
});

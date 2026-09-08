import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260909000100_wecom_bot_receiver_ingest.sql",
  import.meta.url,
), "utf8");

test("bot ingestion reuses the private archive table without projecting business state", () => {
  assert.match(migration, /create or replace function public\.ingest_wecom_bot_batch\(/i);
  assert.match(migration, /internal\.wecom_archive_messages%rowtype/i);
  assert.match(migration, /classification, student_name_hint, guardian_wechat_hint,\s+student_id, match_status, ingested_by/i);
  assert.match(migration, /'other', null, null, null, 'pending'/i);
  assert.doesNotMatch(migration, /project_wecom_archive_message/i);
  assert.doesNotMatch(migration, /wecom_archive_media/i);
});

test("bot ingestion is secret-gated, bounded, post-cutoff and idempotent", () => {
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(migration, /jsonb_array_length\(p_records\) > 50/i);
  assert.match(migration, /octet_length\(p_records::text\) > 8388608/i);
  assert.match(migration, /sent_at < p_started_at/i);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*hashtextextended[\s\S]*messageId/i);
  assert.match(migration, /wecom_bot_idempotency_conflict/i);
  assert.match(migration, /revoke all on function public\.ingest_wecom_bot_batch/i);
  assert.match(migration, /grant execute on function public\.ingest_wecom_bot_batch[\s\S]*to anon/i);
});

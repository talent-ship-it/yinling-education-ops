import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260910093517_wecom_bot_auto_match.sql",
  import.meta.url,
), "utf8");

test("bot auto-match is exact, active-roster-only, and reuses the audited projection", () => {
  assert.match(migration, /create or replace function internal\.auto_match_wecom_archive_message\(/i);
  assert.match(migration, /archive\.classification not in \('handover', 'renewal_follow_up', 'trial_scheduling'\)/i);
  assert.match(migration, /count\(distinct nullif\(pg_catalog\.btrim\(student ->> 'id'/i);
  assert.match(migration, /internal\.wecom_plain_key\(student ->> 'name'\)/i);
  assert.match(migration, /internal\.wecom_plain_key\(archive\.guardian_wechat_hint\)/i);
  assert.match(migration, /coalesce\(student ->> 'importArchived', 'false'\) <> 'true'/i);
  assert.match(migration, /internal\.project_wecom_archive_message\(/i);
  assert.match(migration, /exact_unique_active_student_identity/i);
  assert.match(migration, /when serialization_failure then/i);
});

test("ambiguous and missing identities stay in the review inbox", () => {
  assert.match(migration, /match_status = 'ambiguous'/i);
  assert.match(migration, /match_status = 'pending'/i);
  assert.match(migration, /student_id = null/i);
  assert.match(migration, /'linked', linked_count/i);
  assert.match(migration, /'ambiguous', ambiguous_count/i);
  assert.match(migration, /'pending', pending_count/i);
});

test("the replacement keeps the secret-gated bot contract and idempotency promotion", () => {
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(migration, /pg_catalog\.jsonb_array_length\(p_records\) > 50/i);
  assert.match(migration, /pg_catalog\.octet_length\(p_records::text\) > 8388608/i);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock[\s\S]*hashtextextended[\s\S]*messageId/i);
  assert.match(migration, /wecom_bot_idempotency_conflict/i);
  assert.match(migration, /grant execute on function public\.ingest_wecom_bot_batch[\s\S]*to anon/i);
});

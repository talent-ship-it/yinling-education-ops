import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260901000100_wecom_archive_ingestion.sql",
  import.meta.url,
), "utf8");

test("keeps WeCom bodies and media in private RLS tables", () => {
  assert.match(migration, /create table if not exists internal\.wecom_archive_messages/i);
  assert.match(migration, /create table if not exists internal\.wecom_archive_media/i);
  assert.match(migration, /alter table internal\.wecom_archive_messages enable row level security/i);
  assert.match(migration, /alter table internal\.wecom_archive_media enable row level security/i);
  assert.match(migration, /revoke all on table internal\.wecom_archive_messages from public, anon, authenticated/i);
  assert.match(migration, /revoke all on table internal\.wecom_archive_media from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /service_role|raw_payload|private_key|encoding_aes_key/i);
});

test("fails closed on secret, post-join cutoff, idempotency and bounded verified media", () => {
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(migration, /\(source ->> 'sentAt'\)::timestamptz < p_started_at/i);
  assert.doesNotMatch(migration, /p_started_at\s*<\s*now\(\)\s*-\s*interval/i);
  assert.match(migration, /wecom_archive_idempotency_conflict/i);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*hashtextextended[\s\S]*messageId/i);
  assert.match(migration, /octet_length\(decoded\) > 3145728/i);
  assert.match(migration, /octet_length\(p_records::text\) > 8388608/i);
  assert.match(migration, /total_decoded_bytes > 6291456/i);
  assert.match(migration, /wecom_archive_duplicate_media_key/i);
  assert.match(migration, /extensions\.digest\(decoded, 'sha256'\)/i);
  assert.match(migration, /image\/jpeg[\s\S]*image\/png[\s\S]*image\/webp[\s\S]*application\/pdf/i);
  assert.match(migration, /attachment|media_integrity_mismatch/i);
});

test("links only one exact active-student match and preserves unresolved records", () => {
  assert.match(migration, /internal\.wecom_plain_key\(student ->> 'name'\) = internal\.wecom_plain_key\(canonical_student_hint\)/i);
  assert.match(migration, /guardianWechat[\s\S]*internal\.wecom_plain_key\(canonical_guardian_hint\)/i);
  assert.match(migration, /coalesce\(student ->> 'importArchived', 'false'\) <> 'true'/i);
  assert.match(migration, /candidate_count = 1 then 'linked'/i);
  assert.match(migration, /candidate_count > 1 then 'ambiguous'/i);
  assert.match(migration, /else 'pending'/i);
  assert.match(migration, /p_require_exact_hint_match/i);
  assert.match(migration, /wecom_projection_identity_changed/i);
  assert.match(migration, /nullif\(btrim\(student ->> 'guardianWechat'\), ''\)/i);
  assert.doesNotMatch(migration, /similarity\(|levenshtein|soundex/i);
});

test("projects linked inbound records into ordinary internal messages and student files", () => {
  const lockOffsets = ["files", "messages", "students"].map((entity) =>
    migration.indexOf(`where state.entity = '${entity}' for update`));
  assert.ok(lockOffsets.every((offset) => offset > 0));
  assert.deepEqual([...lockOffsets].sort((left, right) => left - right), lockOffsets);
  assert.match(migration, /'status', '仅内部'/u);
  assert.match(migration, /'type', case[\s\S]*'续课 FU'[\s\S]*'FU'/u);
  assert.match(migration, /'source', '\/api\/integrations\/wecom\/media\/'/i);
  assert.match(migration, /jsonb_set\([\s\S]*current_student[\s\S]*'\{files\}'/i);
  for (const entity of ["messages", "files", "students"]) {
    assert.match(migration, new RegExp(`insert into public\\.ops_mutation_log\\(entity, version, actor\\)[\\s\\S]*?values \\('${entity}'`, "i"));
  }
  assert.match(migration, /media\.student_id is distinct from btrim\(p_student_id\)/i);
  assert.match(migration, /internal\.append_operational_contract_audit\([\s\S]*'wecom\.archive\.projected'/i);
});

test("exposes only OPS-secret RPCs for inbox review, linking, status and authorised media", () => {
  for (const rpc of [
    "ingest_wecom_archive_batch",
    "read_wecom_archive_inbox",
    "link_wecom_archive_message",
    "get_wecom_archive_media",
    "get_wecom_archive_status",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\(`, "i"));
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}\\([\\s\\S]*?from public, anon, authenticated`, "i"));
  }
  assert.match(migration, /media\.student_id is null or media\.projected_file_id is null[\s\S]*return null/i);
});

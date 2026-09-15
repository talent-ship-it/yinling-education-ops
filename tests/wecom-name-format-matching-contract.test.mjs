import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260915000200_wecom_name_format_matching.sql",
  import.meta.url,
), "utf8");

test("student name matching canonicalises display formatting without fuzzy matching", () => {
  assert.match(migration, /create or replace function internal\.wecom_name_key\(p_value text\)/i);
  assert.match(migration, /pg_catalog\.normalize\(pg_catalog\.btrim\(p_value\), 'NFKC'\)/i);
  assert.match(migration, /pg_catalog\.translate\(/i);
  assert.match(migration, /\[\[:space:\]\]\+/i);
  assert.match(migration, /full-width characters, whitespace, punctuation, or/i);
  assert.match(migration, /not a fuzzy,[\s\S]*substring,[\s\S]*transliteration,[\s\S]*alias matcher/i);
});

test("only the student-name checks are format-normalised and projection rechecks agree", () => {
  assert.match(
    migration,
    /internal\.wecom_name_key\(student ->> ''name''\) = internal\.wecom_name_key\(archive\.student_name_hint\)/i,
  );
  assert.match(
    migration,
    /internal\.wecom_name_key\(current_student ->> ''name''\) <> internal\.wecom_name_key\(archive\.student_name_hint\)/i,
  );
  assert.match(migration, /format_normalized_unique_active_student_identity/i);
  assert.doesNotMatch(migration, /wecom_name_key\([^\n]*guardian/i);
  assert.match(migration, /wecom_name_format_definition_drift/i);
});

test("the backfill retries only unresolved bot text through the unique active-roster gate", () => {
  assert.match(migration, /archive\.ingested_by = 'WeCom Bot Receiver'/i);
  assert.match(migration, /archive\.message_type = 'text'/i);
  assert.match(migration, /archive\.match_status = 'pending'/i);
  assert.match(migration, /archive\.student_id is null/i);
  assert.match(migration, /archive\.projected_at is null/i);
  assert.match(migration, /archive\.student_name_hint is not null/i);
  assert.match(migration, /internal\.auto_match_wecom_archive_message\(/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.ops_state/i);
});

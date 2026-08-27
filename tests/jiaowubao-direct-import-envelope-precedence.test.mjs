import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819000600_fix_jiaowubao_direct_import_envelope_precedence.sql",
    import.meta.url,
  ),
  "utf8",
);

test("the forward migration parenthesizes nested JSONB before subtracting allowed envelope keys", () => {
  assert.match(
    migration,
    /\(p_envelope -> 'recordCounts'\) - ARRAY\[/i,
  );
  assert.match(
    migration,
    /\(p_envelope -> 'expectedCounts'\) - ARRAY\[/i,
  );
  assert.match(
    migration,
    /\(p_chunk -> 'chunk'\) - ARRAY\[/i,
  );
  assert.match(
    migration,
    /\(record\.value -> 'studentRelationship'\) - ARRAY\[/i,
  );
  assert.doesNotMatch(
    migration,
    /(?<!\()(?:p_envelope -> '(?:recordCounts|expectedCounts)'|p_chunk -> 'chunk'|record\.value -> 'studentRelationship') - ARRAY\[/i,
  );
});

test("the precedence fix replaces only the private envelope assertion and preserves its ACL", () => {
  assert.match(
    migration,
    /create or replace function internal\.jiaowubao_direct_import_assert_envelope\(p_envelope jsonb\)/i,
  );
  assert.match(migration, /security invoker[\s\S]*?set search_path = ''/i);
  assert.match(
    migration,
    /revoke all on function internal\.jiaowubao_direct_import_assert_envelope\(jsonb\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /create or replace function internal\.jiaowubao_direct_import_assert_staging_chunk\([\s\S]*?p_run_id uuid,[\s\S]*?p_chunk jsonb[\s\S]*?\)/i,
  );
  assert.match(
    migration,
    /revoke all on function internal\.jiaowubao_direct_import_assert_staging_chunk\(uuid, jsonb\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(
    migration,
    /\b(?:insert\s+into|update\s+(?:internal|public)\.|delete\s+from|truncate|drop)\b/i,
  );
  assert.doesNotMatch(migration, /\b(?:grant|security definer)\b/i);
});

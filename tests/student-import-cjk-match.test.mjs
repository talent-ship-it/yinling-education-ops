import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260817000300_enforce_exact_student_jwb_name_match.sql",
    import.meta.url,
  ),
  "utf8",
);
const baseMigration = await readFile(
  new URL(
    "../supabase/migrations/20260813013935_operational_atomic_contracts.sql",
    import.meta.url,
  ),
  "utf8",
);
const service = await readFile(new URL("../lib/student-import-service.ts", import.meta.url), "utf8");

test("SQL automatic matching uses only the exact full-name key", () => {
  assert.match(baseMigration, /student_import_display_name\(p_name text\)[\s\S]*normalize\(coalesce\(p_name, ''\), NFKC\)/i);
  assert.match(migration, /create or replace function internal\.student_import_name_key\(p_name text\)/i);
  assert.match(migration, /internal\.student_import_display_name\(p_name\)/i);
  assert.match(migration, /'ABCDEFGHIJKLMNOPQRSTUVWXYZ',[\s\S]*'abcdefghijklmnopqrstuvwxyz'/i);
  const nameKey = migration.match(/create or replace function internal\.student_import_name_key\(p_name text\)[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  assert.doesNotMatch(nameKey, /student_import_cjk_name_key/i);
  assert.match(migration, /create or replace function internal\.student_import_master_review_name_key\(p_name text\)[\s\S]*select internal\.student_import_name_key\(p_name\)/i);
  assert.match(migration, /create or replace function internal\.student_import_cjk_name_key\(p_name text\)[\s\S]*select ''::text/i);
  assert.match(migration, /student_import_name_key\('张·三'\) =[\s\S]*student_import_name_key\('张（三）'\)/i);
  assert.match(service, /student-import-plan-v8-strict-or-reviewed-jwb-annotation-match/);
});

test("the forward migration preserves old reviews but blocks non-exact links at every write and projection boundary", () => {
  assert.match(migration, /create or replace function internal\.student_import_identity_link_names_mismatch/i);
  assert.match(migration, /create trigger enforce_student_import_identity_link_exact_names/i);
  assert.match(migration, /before insert or update on internal\.student_import_identity_link_sets/i);
  assert.match(migration, /student_import_identity_link_name_mismatch/i);
  assert.match(migration, /pg_get_functiondef[\s\S]*student_import_canonical_projection/i);
  assert.match(migration, /student_import_exact_name_projection_match_fixture_mismatch/i);
  assert.match(migration, /student_import_exact_name_projection_mismatch_fixture_mismatch/i);
  assert.match(migration, /student_import_exact_name_projection_review_fixture_missing/i);
  assert.match(migration, /student_import_exact_name_projection_existing_fixture_missing/i);
  assert.doesNotMatch(migration, /delete\s+from\s+internal\.student_import_identity_link_sets/i);
});

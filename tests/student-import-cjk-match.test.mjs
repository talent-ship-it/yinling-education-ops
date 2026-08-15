import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260815013000_unique_cjk_student_name_match.sql",
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

test("SQL canonical projection uses the same closed Chinese-name key contract", () => {
  assert.match(migration, /create or replace function internal\.student_import_cjk_name_key\(p_name text\)/i);
  assert.match(migration, /display_name text := internal\.student_import_display_name\(p_name\)/i);
  assert.match(baseMigration, /student_import_display_name\(p_name text\)[\s\S]*normalize\(coalesce\(p_name, ''\), NFKC\)/i);
  assert.match(migration, /code_point between 13312 and 19903/i);
  assert.match(migration, /code_point between 19968 and 40959/i);
  assert.match(migration, /code_point between 131072 and 195103/i);
  assert.match(migration, /else\s+return ''/i);
  assert.match(migration, /char_length\(result\) >= 2/i);
  assert.match(migration, /student_import_name_key\(p_name text\)[\s\S]*student_import_cjk_name_key/i);
  assert.match(migration, /revoke all on function internal\.student_import_cjk_name_key\(text\)/i);
});

test("migration fixtures prove unique match and fail closed for mixed, duplicate and short names", () => {
  assert.match(migration, /student_import_cjk_name_key\('Alice 张三'\) <> ''/);
  assert.match(migration, /student_import_cjk_projection_match_fixture_mismatch/);
  assert.match(migration, /student_import_cjk_projection_duplicate_fixture_mismatch/);
  assert.match(migration, /student_import_cjk_projection_short_fixture_mismatch/);
  assert.match(migration, /\(duplicate_projection -> 0\) \? 'jwbSourceRow'/);
  assert.match(migration, /\(short_projection -> 0\) \? 'jwbSourceRow'/);
  assert.match(service, /student-import-plan-v6-unique-cjk-name-match/);
});

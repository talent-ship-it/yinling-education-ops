import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260815010000_report_student_import_source_readiness.sql",
    import.meta.url,
  ),
  "utf8",
);
const route = await readFile(new URL("../app/api/student-import/route.ts", import.meta.url), "utf8");

test("source readiness migration reports only missing source kinds", () => {
  assert.match(migration, /create or replace function public\.get_latest_student_import_source_rows/i);
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /master\.source_kind is null[\s\S]*array_append\(missing_sources, 'master'\)/i);
  assert.match(migration, /jwb\.source_kind is null[\s\S]*array_append\(missing_sources, 'jwb'\)/i);
  assert.match(migration, /message = 'student_import_source_rows_unavailable'/i);
  assert.match(migration, /detail = 'missing_sources=' \|\| array_to_string\(missing_sources, ','\)/i);
  assert.match(
    migration,
    /revoke all on function public\.get_latest_student_import_source_rows\(text\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_latest_student_import_source_rows\(text\)[\s\S]*to anon, authenticated/i,
  );
});

test("formal import route returns a stable source-unavailable contract", () => {
  assert.match(route, /parseStudentImportSourceUnavailableDetail\(error\.detail\)/);
  assert.match(route, /error\.code === "P0002"/);
  assert.match(route, /error\.message === "student_import_source_rows_unavailable"/);
  assert.match(route, /code: "student_import_source_rows_unavailable"/);
  assert.match(route, /missingSources/);
});

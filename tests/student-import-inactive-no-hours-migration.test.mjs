import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, regression] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260818001200_restore_inactive_no_hours_roster_exclusion.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL(
    "./sql/student-import-inactive-no-hours-exclusion.sql",
    import.meta.url,
  ), "utf8"),
]);

test("the forward migration restores the sole inactive/no-hours Tencent exclusion", () => {
  assert.match(
    migration,
    /create or replace function\s+internal\.student_import_master_duplicate_candidates/i,
  );
  assert.match(
    migration,
    /trim\(coalesce\(row_item\.value\s*->>\s*'status',\s*''\)\)\s*<>\s*'不活跃 \+ 无课时'/i,
  );
  assert.match(
    migration,
    /student_import_canonical_projection_170008_base\(text,jsonb,jsonb,jsonb,jsonb,jsonb\)/i,
  );
  assert.match(
    migration,
    /if clean_name = \\'\\' or row_value\s*->>\s*\\'status\\'\s*=\s*\\'不活跃 \+ 无课时\\'/i,
  );
  assert.match(migration, /effective_identity_links\s+jsonb/i);
  assert.match(
    migration,
    /jsonb_array_elements\(effective_identity_links\)\s+with ordinality/i,
  );
  assert.doesNotMatch(migration, /master_source_values/i);
  assert.doesNotMatch(migration, /projection_items\s+jsonb\[\]/i);
  assert.match(
    migration,
    /commit_student_import_plan_atomic\(text,text,bigint,jsonb,jsonb,text\)/i,
  );
  assert.match(
    migration,
    /eligible_master_row\s*->>\s*'status'\s*<>\s*'不活跃 \+ 无课时'/i,
  );
  assert.doesNotMatch(
    migration,
    /source_row\s*->>\s*'status'\s*<>\s*'不活跃 \+ 无课时'/i,
  );
  assert.match(
    migration,
    /put_student_import_source_rows\(text,text,text,text,jsonb,text\)/i,
  );
  assert.match(
    migration,
    /inactive_no_hours_source_ingest_patch_verification_failed/i,
  );
  assert.doesNotMatch(migration, /delete\s+from\s+(?:public\.)?ops_state/i);
});

test("the SQL regression is explicitly disposable and covers peer, JWB-only, and archive behavior", () => {
  assert.match(regression, /^begin;/im);
  assert.match(regression, /^rollback;/im);
  assert.match(regression, /20260817000800 predecessor only/i);
  assert.match(
    regression,
    /\\ir\s+\.\.\/\.\.\/supabase\/migrations\/20260818001200_restore_inactive_no_hours_roster_exclusion\.sql/i,
  );
  assert.match(regression, /inactive_no_hours_member_id_reservation_regression/i);
  assert.match(regression, /inactive_no_hours_projection_regression/i);
  assert.match(regression, /inactive_no_hours_duplicate_review_regression/i);
  assert.match(regression, /No Tencent Master/);
  assert.match(regression, /importArchived/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, regression] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819000400_archive_referenced_student_jwb_facts.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("./sql/student-import-archive-jwb-facts.sql", import.meta.url), "utf8"),
]);

test("referenced archives retain package IDs but move active JWB balances into history", () => {
  assert.match(
    migration,
    /create or replace function\s+internal\.student_import_canonical_archive\(p_student jsonb\)/i,
  );
  assert.match(migration, /student_import_historical_jwb_snapshot/i);
  assert.match(migration, /student_import_historical_jwb_facts/i);
  assert.match(migration, /student_import_merge_historical_jwb_facts/i);
  assert.match(migration, /coalesce\(package\.value\s*->>\s*'id',\s*''\)\s+like\s+'PKG-JWB-%'/i);
  assert.match(migration, /jsonb_build_object\('lessonPackages',\s*existing_packages\)/i);
  assert.match(migration, /jsonb_build_object\('packageCoverage',\s*'partial'\)/i);
  for (const field of [
    "importSource",
    "jwbMatchStatus",
    "jwbSourceRow",
    "remainingHours",
    "contractHours",
    "contractEffectiveDate",
    "firstJwbHourEntryDate",
  ]) {
    assert.match(migration, new RegExp(`- '${field}'`, "i"));
  }
  assert.match(migration, /existing_snapshot\s*->\s*'currentAggregate'/i);
  assert.match(
    migration,
    /importArchivedReason',\s*'referenced_history'/i,
  );
  assert.match(
    migration,
    /revoke all on function\s+internal\.student_import_canonical_archive\(jsonb\)/i,
  );
  assert.doesNotMatch(migration, /(?:update|delete\s+from|insert\s+into)\s+(?:public\.)?ops_state/i);
});

test("the SQL regression is transactional and proves signed-balance replay stability", () => {
  assert.match(regression, /^begin;/im);
  assert.match(regression, /^rollback;/im);
  assert.match(regression, /'remainingHours',\s*-2/i);
  assert.match(regression, /archive_jwb_active_fields_not_stripped/i);
  assert.match(regression, /archive_package_references_not_preserved/i);
  assert.match(regression, /archive_jwb_history_not_preserved/i);
  assert.match(regression, /archive_identity_or_source_history_lost/i);
  assert.match(regression, /archive_jwb_canonical_replay_changed/i);
});

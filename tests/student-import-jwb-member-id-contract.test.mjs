import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, masterAuthoritativeMigration, domain, service] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260817000400_support_authoritative_master_jwb_member_id.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../supabase/migrations/20260817000800_tencent_master_roster_authoritative.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(new URL("../lib/student-import.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/student-import-service.ts", import.meta.url), "utf8"),
]);

test("the Tencent 教务宝学员编号 header is normalized and blank cells are absent", () => {
  assert.match(service, /MASTER_JWB_MEMBER_ID_HEADER\s*=\s*"教务宝学员编号"/);
  assert.match(service, /"jwbMemId"/);
  assert.match(service, /typeof value === "string" && !value\.trim\(\)/);
  assert.match(service, /Master rows may supply either jwbMemId or 教务宝学员编号, not both/);
  assert.match(domain, /jwbMemId\?: StudentImportSourceKey/);
});

test("a master JWB ID is strict enrichment evidence, never a master-import admission gate", () => {
  assert.match(domain, /invalidJwbMemberMasterKeys/);
  assert.match(domain, /invalid_jwb_member_id/);
  assert.match(domain, /duplicate_master_jwb_member_id/);
  assert.match(domain, /master_jwb_member_id_identity_link_conflict/);
  assert.match(domain, /reviewedAnnotationMemberMasterKeys/);
  assert.match(domain, /memberIdAllowsReviewedJwb/);
  assert.match(masterAuthoritativeMigration, /A member ID is a strict enrichment selector, not an import-existence gate/i);
  assert.match(masterAuthoritativeMigration, /unknown\/cross-name IDs merely cause the JWB leg to be ignored/i);
  assert.match(masterAuthoritativeMigration, /student_import_master_jwb_member_id_error/i);
  assert.match(masterAuthoritativeMigration, /duplicate_student_import_master_jwb_member_id/i);
  assert.match(masterAuthoritativeMigration, /declared_member_ids/i);
  assert.match(masterAuthoritativeMigration, /nullif\(internal\.student_import_source_key\([^)]*jwbMemId[^)]*\), ''\)/i);
});

test("source ingest keeps malformed/duplicate IDs fail-closed while final projection downgrades stale JWB legs", () => {
  assert.match(migration, /put_student_import_source_rows\(text,text,text,text,jsonb,text\)/i);
  assert.match(migration, /student_import_master_jwb_member_id_allowed_fields_anchor_mismatch/i);
  assert.match(migration, /student_import_master_jwb_member_id_validation_anchor_mismatch/i);
  assert.match(migration, /student_import_identity_link_master_jwb_member_id_conflict/i);
  assert.match(migration, /create or replace function internal\.enforce_student_import_identity_link_exact_names/i);
  assert.match(migration, /student_import_identity_link_master_jwb_member_id_conflict/i);
  assert.match(migration, /pg_get_functiondef[\s\S]*student_import_canonical_projection/i);
  assert.match(migration, /student_import_master_jwb_member_id_projection_patch_verification_failed/i);
  assert.match(migration, /master_name_count := 1;[\s\S]*jwb_name_count := 1;/i);
  assert.match(migration, /student_import_master_jwb_member_id_fixture_mismatch/i);
  assert.match(migration, /student_import_master_jwb_member_id_name_fixture_missing/i);
  assert.match(migration, /student_import_master_jwb_member_id_duplicate_fixture_missing/i);
  assert.match(migration, /student_import_master_jwb_member_id_excluded_fixture_missing/i);
  assert.match(masterAuthoritativeMigration, /when downgradeable then raw_link - 'jwbSourceRow' - 'matchStrategy'/i);
  assert.match(masterAuthoritativeMigration, /optional-enrichment ambiguity/i);
  assert.doesNotMatch(migration, /delete\s+from\s+internal\.student_import_identity_link_sets/i);
});

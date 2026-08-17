import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, route, store, ui, domain] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260817000500_review_jwb_latin_parenthetical_annotations.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL("../app/api/student-import/identity-links/annotation/route.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/student-import.ts", import.meta.url), "utf8"),
]);

test("the JWB annotation exception is closed, one-way and source-wide unique", () => {
  assert.match(domain, /STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1/);
  assert.match(domain, /const JWB_LATIN_PARENTHETICAL_ANNOTATION = \/\^\[A-Za-z\]\+\$\//);
  assert.match(domain, /studentImportJwbLatinParentheticalAnnotationKey/);
  assert.match(domain, /isStudentImportJwbLatinParentheticalAnnotationMatch/);
  assert.match(domain, /annotationMasterRowsByKey/);
  assert.match(domain, /annotationJwbRowsByKey/);
  assert.match(domain, /annotationExistingIdsByKey/);
  assert.match(domain, /derivedMasterOwnersByStudentId/);
  assert.match(domain, /annotationMasterRowsByKey\.get\(masterName\)\?\.length === 1/);
  assert.match(domain, /annotationJwbRowsByKey\.get\(masterName\)\?\.length === 1/);
  assert.doesNotMatch(domain, /(?:levenshtein|similarity|fuzzy(?:name)?match)/i);

  assert.match(migration, /student_import_jwb_latin_parenthetical_annotation_key/i);
  assert.match(migration, /student_import_ascii_latin_letters/i);
  assert.match(migration, /char_length\(p_value\) = octet_length\(p_value\)/i);
  assert.match(migration, /p_value collate "C"/i);
  assert.match(migration, /\^\[\^\(\)\]\+\\\(\[\^\(\)\]\+\\\)\$\x27/i);
  assert.match(migration, /Learner\(É\)/);
  assert.match(migration, /student_import_jwb_annotation_relaxed_name_key/i);
  assert.match(migration, /master_collision_basis/i);
  assert.match(migration, /resolved_active_master/i);
  assert.match(migration, /existing_collision/i);
  assert.match(migration, /position\('\(' in internal\.student_import_display_name\(/i);
  assert.match(migration, /'jwb_latin_parenthetical_annotation_v1'/);
  assert.match(migration, /count\(\*\)[\s\S]*student_import_jwb_annotation_relaxed_name_key/i);
  assert.doesNotMatch(migration, /\[A-Za-z0-9\]/);
});

test("the exception is durable at both the link-set trigger and final projection", () => {
  assert.match(migration, /create or replace function internal\.student_import_identity_link_names_mismatch/i);
  assert.match(migration, /create or replace function internal\.enforce_student_import_identity_link_exact_names/i);
  assert.match(migration, /create or replace function internal\.enforce_student_import_identity_link_exact_names/i);
  assert.match(migration, /new\.links/i);
  assert.match(migration, /student_import_annotation_projection_validation_anchor_mismatch/i);
  assert.match(migration, /'matchStrategy'/);
  assert.match(migration, /student_import_identity_annotation_projection_fixture_mismatch/i);
  assert.match(migration, /student_import_identity_annotation_invalid_fixture_missing/i);
  assert.match(migration, /student_import_identity_annotation_collision_fixture_mismatch/i);
  assert.match(migration, /student_import_identity_annotation_master_shadow_fixture_missing/i);
  assert.match(migration, /student_import_identity_annotation_existing_shadow_fixture_missing/i);
  assert.doesNotMatch(migration, /delete\s+from\s+internal\.student_import_identity_link_sets/i);
});

test("annotation review does not broaden the authoritative JWB member-ID contract", () => {
  const candidateStart = migration.indexOf(
    "create or replace function internal.student_import_identity_annotation_candidates",
  );
  const candidateEnd = migration.indexOf("\ncreate or replace function ", candidateStart + 1);
  assert.doesNotMatch(migration.slice(candidateStart, candidateEnd), /jwbMemId/);
  assert.match(migration, /student_import_identity_link_master_jwb_member_id_conflict/);
  assert.match(domain, /master_jwb_member_id_name_mismatch/);
});

test("bulk preview and confirmation are state-bound, auditable and replay-safe", () => {
  assert.match(migration, /create or replace function internal\.student_import_identity_annotation_candidates/i);
  assert.match(migration, /p_master_rows jsonb,[\s\S]*p_resolved_master_rows jsonb/i);
  assert.match(migration, /duplicate suppressed by a separate master-resolution decision still[\s\S]*source-wide identity uniqueness/i);
  assert.match(migration, /'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'/);
  assert.match(migration, /create table if not exists internal\.student_import_identity_annotation_review_commands/i);
  assert.match(migration, /reject_student_import_identity_annotation_review_command_mutation/i);
  assert.match(migration, /create or replace function public\.get_student_import_identity_annotation_review_preview/i);
  assert.match(migration, /create or replace function public\.put_student_import_identity_annotation_review/i);
  assert.match(migration, /set statement_timeout = '8s'/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /student_import_identity_annotation_review_replay_conflict/i);
  assert.match(migration, /student_import\.identity_annotation_review_confirmed/i);
  assert.match(migration, /candidateFingerprint/i);
  assert.match(migration, /duplicateResolutionFingerprint/i);
  assert.match(migration, /student_import_identity_annotation_review_timeout_guard_missing/i);
  assert.match(migration, /revoke all on function public\.put_student_import_identity_annotation_review/i);
  assert.match(migration, /grant execute on function public\.put_student_import_identity_annotation_review/i);
});

test("the browser can only submit the opaque confirmation key", () => {
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /MAX_REQUEST_BYTES = 512/);
  assert.match(route, /STUDENT_IMPORT_IDENTITY_ANNOTATION_PREVIEW_RPC/);
  assert.match(route, /STUDENT_IMPORT_IDENTITY_ANNOTATION_PUT_RPC/);
  assert.match(route, /identity_annotation_review_too_large/);
  assert.match(post, /Object\.keys\(payload\)\.length !== 1/);
  assert.match(post, /"confirmationKey" in payload/);
  assert.doesNotMatch(post, /\b(?:masterSourceRow|jwbSourceRow|studentId|matchStrategy)\b/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_ANNOTATION_PREVIEW_RPC/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_ANNOTATION_PUT_RPC/);
  assert.match(store, /p_confirmation_key: input\.confirmationKey/);
  const annotationPutStart = store.indexOf(
    "export function putStudentImportIdentityAnnotationReview",
  );
  const annotationPutEnd = store.indexOf("\nexport function ", annotationPutStart + 1);
  assert.doesNotMatch(
    store.slice(annotationPutStart, annotationPutEnd),
    /p_(?:master|jwb|student|match)/i,
  );
  assert.match(ui, /\/api\/student-import\/identity-links\/annotation/);
  assert.match(ui, /JSON\.stringify\(\{ confirmationKey: preview\.confirmationKey \}\)/);
  assert.match(ui, /教务宝英文括号备注高置信关联/);
});

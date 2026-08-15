import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, route, store] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260815044000_student_import_bulk_create_identity_review.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL(
    "../app/api/student-import/identity-links/bulk-create/route.ts",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
]);

function functionBody(source, signature) {
  const start = source.indexOf(`create or replace function ${signature}`);
  assert.ok(start >= 0, `${signature} is missing`);
  const bodyStart = source.indexOf("as $$", start);
  const end = source.indexOf("\n$$;", bodyStart);
  assert.ok(bodyStart > start && end > bodyStart, `${signature} body is incomplete`);
  return source.slice(bodyStart, end);
}

test("bulk-create API accepts one opaque key and never browser-provided identities", () => {
  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /MAX_REQUEST_BYTES = 512/);
  assert.match(route, /Object\.keys\(payload\)\.length !== 1/);
  assert.match(route, /OPAQUE_KEY\.test\(payload\.confirmationKey\)/);
  assert.match(route, /getStudentImportIdentityBulkCreateReviewPreview/);
  assert.match(route, /putStudentImportIdentityBulkCreateReview/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /masterSourceRow|jwbSourceRow|studentId|\bname\b|\bdecision\b/);
  assert.match(route, /student_import_identity_bulk_create_review_conflict/);
  assert.match(route, /student_import_identity_bulk_create_review_contract_unavailable/);
  assert.match(route, /requestedCount: saved\.requestedCount/);
  assert.match(route, /newlyAppliedCount: saved\.newlyAppliedCount/);
  assert.match(route, /alreadyAppliedCount: saved\.alreadyAppliedCount/);
  assert.match(route, /finalCount: saved\.finalCount/);
});

test("server store forwards only secret, opaque key and authenticated actor", () => {
  assert.match(store, /STUDENT_IMPORT_IDENTITY_BULK_CREATE_PREVIEW_RPC = "get_student_import_identity_bulk_create_review_preview"/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_BULK_CREATE_PUT_RPC = "put_student_import_identity_bulk_create_review"/);
  const start = store.indexOf("export function putStudentImportIdentityBulkCreateReview");
  const end = store.indexOf("\n}\n", start) + 3;
  const body = store.slice(start, end);
  assert.match(body, /p_secret: secret/);
  assert.match(body, /p_confirmation_key: input\.confirmationKey/);
  assert.match(body, /p_actor: input\.actor/);
  assert.doesNotMatch(body, /sourceRow|studentId|decision|revision|rows/);
});

test("candidate snapshot is set-based, required and closed to zero existing names", () => {
  const candidates = functionBody(
    migration,
    "internal.student_import_identity_bulk_create_candidates",
  );
  assert.match(candidates, /master_raw as materialized/);
  assert.match(candidates, /master_basis as materialized/);
  assert.match(candidates, /active_master as materialized/);
  assert.match(candidates, /owner_basis as materialized/);
  assert.match(candidates, /required_master as materialized/);
  assert.match(candidates, /jwb_raw as materialized/);
  assert.match(candidates, /student_raw as materialized/);
  assert.match(candidates, /student_review_counts as materialized/);
  assert.match(candidates, /count\(\*\) over \(partition by review_key\)/);
  assert.match(candidates, /count\(\*\) over \(partition by derived_student_id\) as derived_owner_count/);
  assert.match(candidates, /derived_owner_count = 1/);
  assert.equal((candidates.match(/student_import_student_id\s*\(/g) ?? []).length, 1);

  const requiredAt = candidates.indexOf("required_master as materialized");
  const jwbAt = candidates.indexOf("jwb_raw as materialized", requiredAt);
  const required = candidates.slice(requiredAt, jwbAt);
  for (const status of ["在读", "活跃 + 有课时", "不活跃 + 有课时", "在读 + 加课待排"]) {
    assert.match(required, new RegExp(status.replace("+", "\\+")));
  }
  assert.doesNotMatch(required, /活跃 \+ 无课时/);

  assert.match(candidates, /coalesce\(existing\.existing_key_count, 0\) as existing_key_count/);
  assert.match(candidates, /paired\.existing_key_count = 0/);
  assert.doesNotMatch(candidates, /unique_student/);
  assert.match(candidates, /not exists \([\s\S]*from student_ids current_student[\s\S]*current_student\.student_id = paired\.derived_student_id/);
  assert.match(candidates, /join unique_jwb jwb using \(review_key\)/);
  assert.match(candidates, /candidate_conflict/);
});

test("create plan reuses the proven three-dimensional closure with its own contract", () => {
  const plan = functionBody(
    migration,
    "internal.student_import_identity_bulk_create_plan",
  );
  assert.equal((plan.match(/student_import_identity_bulk_merge_plan\s*\(/g) ?? []).length, 1);
  assert.match(plan, /student-import-identity-bulk-create-plan-v1/);
  assert.match(plan, /triplePlanFingerprint/);
  assert.match(plan, /'createCandidateCount'/);
  assert.match(plan, /'pendingCreateCount'/);
  assert.match(plan, /'alreadyLinkedCreateCount'/);
  assert.match(plan, /'combinedLinks'/);
  assert.match(migration, /student_import_identity_bulk_create_review_conflict_fixture_missing/);
});

test("opaque key binds every source, student, review and link-set CAS dimension", () => {
  const key = functionBody(
    migration,
    "internal.student_import_identity_bulk_create_review_key",
  );
  assert.match(key, /student-import-identity-bulk-create-review-v1/);
  for (const field of [
    "p_master_source_id",
    "p_master_revision",
    "p_master_rows_sha256",
    "p_jwb_source_id",
    "p_jwb_revision",
    "p_jwb_rows_sha256",
    "p_students_version",
    "p_review_epoch",
    "p_active_link_fingerprint",
    "p_duplicate_resolution_fingerprint",
    "p_plan_fingerprint",
  ]) assert.match(key, new RegExp(field));
  assert.match(migration, /student_import_identity_bulk_create_review_key_fixture_mismatch/);
});

test("mutation locks canonically, recomputes once and writes one audit plus one upsert", () => {
  const put = functionBody(
    migration,
    "public.put_student_import_identity_bulk_create_review",
  );
  const advisoryAt = put.indexOf("student_import_identity_link_set:singleton");
  const jwbAt = put.indexOf("source_kind = 'jwb' for update");
  const masterAt = put.indexOf("source_kind = 'master' for update");
  const linksetAt = put.indexOf("identity_state.singleton for update");
  const studentsAt = put.indexOf("state_row.entity = 'students' for update");
  assert.ok(advisoryAt >= 0 && jwbAt > advisoryAt && masterAt > jwbAt
    && linksetAt > masterAt && studentsAt > linksetAt);
  assert.equal((put.match(/create_candidates := internal\.student_import_identity_bulk_create_candidates/g) ?? []).length, 1);
  assert.equal((put.match(/create_plan := internal\.student_import_identity_bulk_create_plan/g) ?? []).length, 1);
  assert.equal((put.match(/append_operational_contract_audit\s*\(/g) ?? []).length, 1);
  assert.equal((put.match(/insert into internal\.student_import_identity_link_sets/g) ?? []).length, 1);
  assert.equal((put.match(/on conflict \(singleton\) do update set/g) ?? []).length, 1);
  assert.doesNotMatch(put, /\bloop\b|put_student_import_identity_review_(decision|pair)\s*\(/i);
  assert.match(put, /expected_key <> p_confirmation_key/);
  assert.match(put, /requested_count <> newly_applied_count \+ already_applied_count/);
  assert.match(put, /final_count <> before_link_count \+ newly_applied_count/);
});

test("replay ledger is immutable and validates audit, fingerprint and count", () => {
  const put = functionBody(
    migration,
    "public.put_student_import_identity_bulk_create_review",
  );
  assert.match(migration, /create table if not exists internal\.student_import_identity_bulk_create_review_commands/);
  assert.match(migration, /before update or delete on internal\.student_import_identity_bulk_create_review_commands/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table internal\.student_import_identity_bulk_create_review_commands[\s\S]*from public, anon, authenticated/);
  assert.match(put, /student_import_identity_bulk_create_review_replay_conflict/);
  assert.match(put, /saved\.link_fingerprint <> prior_command\.after_link_fingerprint/);
  assert.match(put, /saved\.link_count <> prior_command\.final_count/);
  assert.match(put, /saved\.audit_id <> prior_command\.audit_id/);
  assert.match(put, /'unchanged', true/);
  assert.equal((put.match(/insert into internal\.student_import_identity_bulk_create_review_commands/g) ?? []).length, 1);
});

test("public functions have only function-local 8s guards and exact grants", () => {
  for (const name of [
    "public.get_student_import_identity_bulk_create_review_preview",
    "public.put_student_import_identity_bulk_create_review",
  ]) {
    const body = functionBody(migration, name);
    const declarationAt = migration.indexOf(`create or replace function ${name}`);
    const bodyAt = migration.indexOf("as $$", declarationAt);
    const declaration = migration.slice(declarationAt, bodyAt);
    assert.match(declaration, /security definer/);
    assert.match(declaration, /set search_path = ''/);
    assert.match(declaration, /set statement_timeout = '8s'/);
    assert.match(body, /internal\.verify_ops_secret\(p_secret\)/);
  }
  assert.equal((migration.match(/set statement_timeout = '8s'/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /alter\s+(database|role|system)[\s\S]*statement_timeout/i);
  assert.match(migration, /student_import_identity_bulk_create_review_timeout_guard_missing/);
  assert.match(migration, /revoke all on function public\.get_student_import_identity_bulk_create_review_preview\(text\)[\s\S]*grant execute on function public\.get_student_import_identity_bulk_create_review_preview\(text\)/);
  assert.match(migration, /revoke all on function public\.put_student_import_identity_bulk_create_review\([\s\S]*grant execute on function public\.put_student_import_identity_bulk_create_review\(/);
  assert.match(functionBody(migration, "public.put_student_import_identity_bulk_create_review"), /p_actor not in \('Nixon', 'Ops Admin'\)/);
});

test("migration carries fail-closed transactional semantic fixtures", () => {
  for (const marker of [
    "student_import_identity_bulk_create_review_zero_existing_fixture_mismatch",
    "student_import_identity_bulk_create_review_existing_fixture_mismatch",
    "student_import_identity_bulk_create_review_ambiguity_fixture_mismatch",
    "student_import_identity_bulk_create_review_required_fixture_mismatch",
    "student_import_identity_bulk_create_review_occupied_fixture_mismatch",
    "student_import_identity_bulk_create_review_owner_fixture_missing",
    "student_import_identity_bulk_create_review_pending_fixture_mismatch",
    "student_import_identity_bulk_create_review_preserve_fixture_mismatch",
    "student_import_identity_bulk_create_review_exact_fixture_mismatch",
    "student_import_identity_bulk_create_review_conflict_fixture_missing",
    "student_import_identity_bulk_create_review_key_fixture_mismatch",
  ]) assert.match(migration, new RegExp(marker));

  const ownerSentinel = migration.indexOf(
    "message = 'student_import_identity_bulk_create_review_owner_fixture_missing'",
  );
  const ownerBlock = migration.slice(ownerSentinel - 120, ownerSentinel + 180);
  assert.match(ownerBlock, /errcode = 'P0001'/);
  assert.match(ownerBlock, /exception when invalid_parameter_value/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, route, store] = await Promise.all([
  readFile(new URL("../supabase/migrations/20260815043000_student_import_bulk_identity_review.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/api/student-import/identity-links/bulk/route.ts", import.meta.url), "utf8"),
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

test("bulk identity API accepts one opaque key and never browser-provided identities", () => {
  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /MAX_REQUEST_BYTES = 512/);
  assert.match(route, /Object\.keys\(payload\)\.length !== 1/);
  assert.match(route, /OPAQUE_KEY\.test\(payload\.confirmationKey\)/);
  assert.match(route, /getStudentImportIdentityBulkReviewPreview/);
  assert.match(route, /putStudentImportIdentityBulkReview/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /masterSourceRow|jwbSourceRow|studentId|\bname\b|\bdecision\b/);
  assert.match(route, /student_import_identity_bulk_review_conflict/);
  assert.match(route, /student_import_identity_bulk_review_contract_unavailable/);
  assert.match(route, /requestedCount: saved\.requestedCount/);
  assert.match(route, /newlyAppliedCount: saved\.newlyAppliedCount/);
  assert.match(route, /alreadyAppliedCount: saved\.alreadyAppliedCount/);
  assert.match(route, /finalCount: saved\.finalCount/);
});

test("server store forwards only secret, opaque key and authenticated actor", () => {
  assert.match(store, /STUDENT_IMPORT_IDENTITY_BULK_PREVIEW_RPC = "get_student_import_identity_bulk_review_preview"/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_BULK_PUT_RPC = "put_student_import_identity_bulk_review"/);
  const start = store.indexOf("export function putStudentImportIdentityBulkReview");
  const end = store.indexOf("\n}\n", start) + 3;
  const body = store.slice(start, end);
  assert.match(body, /p_secret: secret/);
  assert.match(body, /p_confirmation_key: input\.confirmationKey/);
  assert.match(body, /p_actor: input\.actor/);
  assert.doesNotMatch(body, /sourceRow|studentId|decision|revision|rows/);
});

test("merge snapshot is set-based, merge-only and computes every basis once", () => {
  const candidates = functionBody(
    migration,
    "internal.student_import_identity_bulk_merge_candidates",
  );
  assert.doesNotMatch(candidates, /student_import_identity_review_candidates\s*\(/);
  assert.match(candidates, /master_raw as materialized/);
  assert.match(candidates, /master_basis as materialized/);
  assert.match(candidates, /active_master as materialized/);
  assert.match(candidates, /owner_basis as materialized/);
  assert.match(candidates, /from active_master/);
  assert.match(candidates, /derived_targets as materialized/);
  assert.match(candidates, /student_id like 'STU-M-%'/);
  assert.match(candidates, /where exists \(select 1 from derived_targets\)/);
  assert.match(candidates, /jwb_raw as materialized/);
  assert.match(candidates, /student_raw as materialized/);
  assert.match(candidates, /count\(\*\) over \(partition by review_key\)/);
  assert.equal((candidates.match(/student_import_student_id\s*\(/g) ?? []).length, 1);
  assert.match(candidates, /join unique_jwb jwb using \(review_key\)/);
  assert.match(candidates, /join unique_student student using \(review_key\)/);
  assert.doesNotMatch(candidates, /candidateKey|resolutionKey|'decision'/);
  assert.match(candidates, /owner\.source_key <> paired\.master_source_key/);
});

test("plan preserves exact triples and rejects partial or global ownership conflicts", () => {
  const plan = functionBody(
    migration,
    "internal.student_import_identity_bulk_merge_plan",
  );
  assert.match(plan, /already_linked/);
  assert.match(plan, /'pendingLinks', pending_links/);
  assert.match(plan, /student_import_identity_bulk_review_conflict/);
  assert.match(plan, /active_basis jsonb/);
  assert.match(plan, /candidate_basis jsonb/);
  assert.match(plan, /active_index as materialized/);
  assert.match(plan, /candidate_index as materialized/);
  assert.match(plan, /join active_index active using \(master_key\)/);
  assert.match(plan, /join active_index active using \(jwb_key\)/);
  assert.match(plan, /join active_index active using \(student_id\)/);
  assert.match(plan, /left join active_index active[\s\S]*active\.master_key = candidate\.master_key[\s\S]*active\.jwb_key = candidate\.jwb_key[\s\S]*active\.student_id = candidate\.student_id/);
  assert.doesNotMatch(plan, /join jsonb_array_elements\([^\n]+\)[\s\S]{0,300}\sor\s/i);
  assert.match(plan, /combined_basis := active_basis \|\| pending_basis/);
  assert.match(plan, /student-import-identity-bulk-merge-plan-v1/);
});

test("mutation locks in canonical order, computes once and writes one audit plus immutable replay", () => {
  const put = functionBody(
    migration,
    "public.put_student_import_identity_bulk_review",
  );
  const advisoryAt = put.indexOf("student_import_identity_link_set:singleton");
  const jwbAt = put.indexOf("source_kind = 'jwb' for update");
  const masterAt = put.indexOf("source_kind = 'master' for update");
  const linksetAt = put.indexOf("identity_state.singleton for update");
  const studentsAt = put.indexOf("state_row.entity = 'students' for update");
  assert.ok(advisoryAt >= 0 && jwbAt > advisoryAt && masterAt > jwbAt
    && linksetAt > masterAt && studentsAt > linksetAt);
  assert.equal((put.match(/merge_candidates := internal\.student_import_identity_bulk_merge_candidates/g) ?? []).length, 1);
  assert.equal((put.match(/merge_plan := internal\.student_import_identity_bulk_merge_plan/g) ?? []).length, 1);
  assert.equal((put.match(/append_operational_contract_audit\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(put, /\bloop\b|put_student_import_identity_review_decision\s*\(/i);
  assert.match(put, /expected_key <> p_confirmation_key/);
  assert.match(put, /student_import_identity_bulk_review_replay_conflict/);
  assert.match(put, /saved\.audit_id <> prior_command\.audit_id/);
  assert.match(put, /requestedCount/);
  assert.match(put, /newlyAppliedCount/);
  assert.match(put, /alreadyAppliedCount/);
  assert.match(put, /finalCount/);
  assert.match(migration, /final_count = before_link_count \+ newly_applied_count/);
  assert.match(put, /'beforeLinkCount', before_link_count/);
  assert.match(migration, /create table if not exists internal\.student_import_identity_bulk_review_commands/);
  assert.match(migration, /before update or delete on internal\.student_import_identity_bulk_review_commands/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table internal\.student_import_identity_bulk_review_commands[\s\S]*from public, anon, authenticated/);
});

test("public functions use exact grants and internal helpers remain private", () => {
  for (const name of [
    "public.get_student_import_identity_bulk_review_preview",
    "public.put_student_import_identity_bulk_review",
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
  assert.match(functionBody(migration, "public.put_student_import_identity_bulk_review"), /p_actor not in \('Nixon', 'Ops Admin'\)/);
  assert.equal((migration.match(/set statement_timeout = '8s'/g) ?? []).length, 2);
  assert.match(migration, /student_import_identity_bulk_review_timeout_guard_missing/);
  assert.match(migration, /'statement_timeout=8s' = any\(preview_config\)/);
  assert.match(migration, /'statement_timeout=8s' = any\(mutation_config\)/);
  assert.match(migration, /revoke all on function public\.get_student_import_identity_bulk_review_preview\(text\)[\s\S]*grant execute on function public\.get_student_import_identity_bulk_review_preview\(text\)/);
  assert.match(migration, /revoke all on function public\.put_student_import_identity_bulk_review\(text, text, text\)[\s\S]*grant execute on function public\.put_student_import_identity_bulk_review\(text, text, text\)/);
  for (const helper of [
    "student_import_identity_resolved_master_rows",
    "student_import_identity_bulk_merge_candidates",
    "student_import_identity_bulk_merge_plan",
    "student_import_identity_bulk_review_key",
  ]) {
    assert.match(migration, new RegExp(`revoke all on function internal\\.${helper}`));
  }
});

test("migration carries transactional semantic fixtures for closure and drift", () => {
  for (const marker of [
    "student_import_identity_bulk_review_unique_fixture_mismatch",
    "student_import_identity_bulk_review_ambiguity_fixture_mismatch",
    "student_import_identity_bulk_review_owner_fixture_mismatch",
    "student_import_identity_bulk_review_self_owner_fixture_mismatch",
    "student_import_identity_bulk_review_pending_fixture_mismatch",
    "student_import_identity_bulk_review_preserve_fixture_mismatch",
    "student_import_identity_bulk_review_exact_fixture_mismatch",
    "student_import_identity_bulk_review_conflict_fixture_missing",
    "student_import_identity_bulk_review_duplicate_fixture_mismatch",
    "student_import_identity_bulk_review_key_fixture_mismatch",
  ]) assert.match(migration, new RegExp(marker));
});

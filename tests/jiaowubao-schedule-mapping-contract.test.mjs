import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, store, route] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819100500_review_jiaowubao_schedule_label_mappings.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL(
    "../app/api/jiaowubao-direct-import/schedule-mappings/route.ts",
    import.meta.url,
  ), "utf8"),
]);

function functionBody(name) {
  return migration.match(new RegExp(
    `create or replace function public\\.${name}[\\s\\S]*?\\$${name}\\$;`,
    "i",
  ))?.[0] ?? "";
}

test("mapping decisions are a separate append-only source-label ledger", () => {
  const ledger = migration.match(/create table if not exists internal\.jiaowubao_direct_schedule_label_mapping_decisions[\s\S]*?\n\);/i)?.[0] ?? "";
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_schedule_label_mapping_decisions/i);
  assert.match(migration, /decision_sequence bigint generated always as identity unique/i);
  assert.match(migration, /run_id uuid not null references internal\.jiaowubao_direct_import_runs/i);
  assert.match(migration, /source_evidence_sha256 text not null/i);
  assert.match(migration, /command_key uuid not null unique/i);
  assert.match(migration, /supersedes_decision_id uuid references internal\.jiaowubao_direct_schedule_label_mapping_decisions/i);
  assert.match(migration, /before insert or update or delete on internal\.jiaowubao_direct_schedule_label_mapping_decisions/i);
  assert.match(migration, /jiaowubao_schedule_mapping_decisions_append_only/i);
  assert.match(migration, /internal\.jiaowubao_direct_schedule_mapping_candidates\(new\.run_id\)/i);
  assert.doesNotMatch(ledger, /teacher_label text|course_label text/i);
  assert.doesNotMatch(migration, /\bupdate\s+internal\.jiaowubao_direct_schedule_events\b/i);
  assert.doesNotMatch(migration, /\binsert\s+into\s+internal\.jiaowubao_direct_schedule_events\b/i);
  assert.doesNotMatch(migration, /internal\.jiaowubao_direct_current_schedule_blocks/i);
  assert.doesNotMatch(migration, /availability_effect\s*=/i);
});

test("candidate provenance is a completed run plus a deterministic full pair-group digest", () => {
  const candidates = migration.match(/create or replace function internal\.jiaowubao_direct_schedule_mapping_candidates[\s\S]*?\$jiaowubao_direct_schedule_mapping_candidates\$;/i)?.[0] ?? "";
  assert.match(candidates, /run_state\.state = 'complete'/i);
  assert.match(candidates, /teacher_label_key/i);
  assert.match(candidates, /course_label_key/i);
  assert.match(candidates, /string_agg\(source_rows\.record_sha256, ',' order by source_rows\.record_sha256\)/i);
  assert.match(candidates, /source_evidence_sha256/i);
  assert.match(candidates, /jiaowubao-direct-schedule-label-mapping-candidate-v1/i);
  assert.match(candidates, /event_count/i);
});

test("read model is secret-gated, bounded, paginated and hides raw source identifiers", () => {
  const body = functionBody("get_jiaowubao_direct_schedule_mapping_review");
  const catalog = migration.match(/create or replace function internal\.jiaowubao_direct_schedule_mapping_teacher_catalog[\s\S]*?\$jiaowubao_direct_schedule_mapping_teacher_catalog\$;/i)?.[0] ?? "";
  assert.match(body, /not internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(body, /p_limit not between 1 and 120/i);
  assert.match(body, /p_after_mapping_key !~ '\^sha256:/i);
  assert.match(body, /limit p_limit \+ 1/i);
  assert.match(body, /where p_after_mapping_key is null or mapping_key > p_after_mapping_key/i);
  assert.match(body, /mapping_status/i);
  assert.match(body, /authority_changed/i);
  assert.match(body, /target_basis_sha256 = target_catalog\.target_basis_sha256/i);
  assert.match(body, /'mappingKey'/i);
  assert.match(catalog, /max_teachers constant integer := 512/i);
  assert.match(catalog, /max_subjects_per_teacher constant integer := 120/i);
  assert.match(catalog, /jsonb_array_length\(p_teachers\) > max_teachers/i);
  assert.match(catalog, /jiaowubao_schedule_mapping_teacher_catalog_too_large/i);
  assert.match(catalog, /jsonb_array_length\(teacher_value -> 'subjects'\) > max_subjects_per_teacher/i);
  assert.match(catalog, /jiaowubao_schedule_mapping_teacher_subject_catalog_too_large/i);
  for (const forbiddenOutputKey of [
    "eventId", "sourceKey", "sourceWorkbook", "sourceRow", "sourceCell", "sourcePayload",
    "sourceEvidenceSha256", "teacherLabelKey", "courseLabelKey", "recordSha256",
  ]) {
    assert.doesNotMatch(body, new RegExp(`'${forbiddenOutputKey}'`, "i"));
  }
});

test("confirmation re-resolves current teacher and exact subject membership under lock", () => {
  const body = functionBody("put_jiaowubao_direct_schedule_label_mapping");
  assert.match(body, /not internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(body, /lock table internal\.jiaowubao_direct_import_runs in share mode/i);
  assert.match(body, /from internal\.jiaowubao_direct_schedule_mapping_candidates\(saved_run\.id\)/i);
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /where decision_row\.command_key = p_command_key/i);
  assert.match(body, /prior_command\.teachers_version <> p_expected_teachers_version/i);
  assert.match(body, /Every first-seen command key receives an append-only receipt/i);
  assert.match(body, /insert into internal\.jiaowubao_direct_schedule_label_mapping_decisions/i);
  assert.match(body, /'stateUnchanged', logical_unchanged/i);
  assert.match(body, /where state_row\.entity = 'teachers'\s+for update/i);
  assert.match(body, /teachers_state\.version <> p_expected_teachers_version/i);
  assert.match(body, /where catalog\.teacher_id = p_target_teacher_id\s+and p_target_subject_id = any\(catalog\.subject_ids\)/i);
  assert.match(body, /internal\.append_operational_contract_audit/i);
  assert.match(body, /supersedes_decision_id/i);
  assert.match(body, /order by decision_row\.decision_sequence desc/i);
  assert.match(body, /target_basis_sha256/i);
  assert.doesNotMatch(body, /\bupdate\s+public\.ops_state\b/i);
  assert.doesNotMatch(body, /\binsert\s+into\s+(?:public\.)?(?:bookings|tasks|operations)/i);
});

test("mapping RPCs remain server-only contracts and route accepts no source labels or event IDs", () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /revoke all on table internal\.jiaowubao_direct_schedule_label_mapping_decisions/i);
  assert.match(migration, /revoke all on function public\.get_jiaowubao_direct_schedule_mapping_review/i);
  assert.match(migration, /revoke all on function public\.put_jiaowubao_direct_schedule_label_mapping/i);
  assert.match(store, /import "server-only"/i);
  assert.match(store, /JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_REVIEW_RPC/i);
  assert.match(store, /JIAOWUBAO_DIRECT_SCHEDULE_MAPPING_PUT_RPC/i);
  assert.match(store, /p_after_mapping_key: input\.cursor/i);
  assert.match(store, /p_expected_teachers_version: input\.expectedTeachersVersion/i);
  assert.match(route, /PAGE_LIMIT = 80/i);
  assert.match(route, /MAX_REQUEST_BYTES = 1_024/i);
  assert.match(route, /readBoundedRequestBody/i);
  assert.match(route, /reader\.cancel\(\)/i);
  assert.match(route, /error\.code === "57014"/i);
  assert.match(route, /jiaowubao_schedule_mapping_read_timeout/i);
  assert.match(route, /hasTeacherImportAdminAccess/i);
  assert.match(route, /Cache-Control": "private, no-store"/i);
  assert.match(route, /mappingKey[\s\S]*?commandKey[\s\S]*?targetTeacherId[\s\S]*?targetSubjectId/i);
  assert.doesNotMatch(route, /sourceRow|sourceCell|sourceKey|teacherLabel|courseLabel|eventId/i);
  assert.doesNotMatch(route, /request\.text\(\)/i);
});

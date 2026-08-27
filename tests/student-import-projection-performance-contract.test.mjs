import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260818000100_optimize_student_import_projection_wrapper.sql",
    import.meta.url,
  ),
  "utf8",
);
const accumulatorMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000200_optimize_student_import_projection_accumulators.sql",
    import.meta.url,
  ),
  "utf8",
);
const packageAccumulatorMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000300_optimize_student_import_jwb_package_buffers.sql",
    import.meta.url,
  ),
  "utf8",
);
const reuseBaseLedgerMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000400_reuse_base_jwb_ledger_packages.sql",
    import.meta.url,
  ),
  "utf8",
);
const packagePreflightMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000500_validate_jwb_package_preflight.sql",
    import.meta.url,
  ),
  "utf8",
);
const safeLinkNormalizationMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000600_optimize_safe_identity_link_normalization.sql",
    import.meta.url,
  ),
  "utf8",
);
const allocatorMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000700_optimize_student_number_allocator.sql",
    import.meta.url,
  ),
  "utf8",
);
const partialSnapshotReplayMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000800_fix_partial_jwb_snapshot_replay.sql",
    import.meta.url,
  ),
  "utf8",
);
const provenanceTriggerMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818000900_optimize_student_number_provenance_trigger.sql",
    import.meta.url,
  ),
  "utf8",
);
const prevalidatedPackageProjectionMigration = await readFile(
  new URL(
    "../supabase/migrations/20260818001000_reuse_prevalidated_jwb_package_projection.sql",
    import.meta.url,
  ),
  "utf8",
);

test("the outer formal-import wrapper maps current students and JWB rows once", () => {
  assert.match(
    migration,
    /pg_get_functiondef\([\s\S]*internal\.student_import_canonical_projection\(text,jsonb,jsonb,jsonb,jsonb,jsonb\)/i,
  );
  assert.match(migration, /base_projection\s*:=\s*internal\.student_import_canonical_projection_170008_base/i);
  assert.match(migration, /current_student_by_id\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(migration, /matched_jwb_by_source\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(migration, /jsonb_array_elements\(p_current_students\)\s+with ordinality/i);
  assert.match(migration, /jsonb_array_elements\(p_jwb_rows\)\s+with ordinality/i);
  assert.match(migration, /select distinct on \(student\.value\s*->>\s*'id'\)/i);
  assert.match(migration, /select distinct on \(internal\.student_import_source_key\(jwb\.value\s*->\s*'sourceRow'\)\)/i);
  assert.match(migration, /order by student\.value\s*->>\s*'id',\s*student\.ordinal/i);
  assert.match(migration, /order by internal\.student_import_source_key\(jwb\.value\s*->\s*'sourceRow'\),\s*jwb\.ordinal/i);
  assert.match(migration, /existing_student\s*:=\s*current_student_by_id\s*->\s*\(base_student\s*->>\s*'id'\)/i);
  assert.match(migration, /matched_jwb_by_source\s*->\s*internal\.student_import_source_key/i);
});

test("the wrapper performance patch fails closed if the audited shape drifts", () => {
  for (const failure of [
    "student_import_projection_wrapper_missing",
    "student_import_projection_wrapper_map_declaration_anchor_mismatch",
    "student_import_projection_wrapper_base_anchor_mismatch",
    "student_import_projection_wrapper_lookup_anchor_mismatch",
    "student_import_projection_wrapper_lookup_patch_verification_failed",
  ]) {
    assert.match(migration, new RegExp(failure));
  }
  assert.match(migration, /set local lock_timeout\s*=\s*'1s'/i);
  assert.match(migration, /select student into existing_student/i);
  assert.match(migration, /select jwb into matched_jwb/i);
  assert.match(migration, /position\('select student into existing_student' in definition\)\s*<>\s*0/i);
  assert.match(migration, /position\('select jwb into matched_jwb' in definition\)\s*<>\s*0/i);
});

test("formal and outer projection buffers preserve their existing loop order", () => {
  assert.match(
    accumulatorMigration,
    /pg_get_functiondef\([\s\S]*student_import_canonical_projection_170008_base\(text,jsonb,jsonb,jsonb,jsonb,jsonb\)/i,
  );
  assert.match(accumulatorMigration, /formal_student_items\s+jsonb\[\]\s*:=\s*array\[\]::jsonb\[\]/i);
  assert.match(accumulatorMigration, /formal_student_items\s*:=\s*array_append\(formal_student_items,\s*record_value\)/i);
  assert.match(accumulatorMigration, /coalesce\(to_jsonb\(formal_student_items\)[\s\S]*manual_trials\s*\|\|\s*referenced_archives/i);
  assert.match(accumulatorMigration, /projection_items\s+jsonb\[\]\s*:=\s*array\[\]::jsonb\[\]/i);
  assert.match(accumulatorMigration, /array_append\(projection_items,\s*base_student\)/i);
  assert.match(accumulatorMigration, /array_append\(projection_items,\s*record_value\)/i);
  assert.match(accumulatorMigration, /return\s+coalesce\(to_jsonb\(projection_items\)/i);
  assert.match(accumulatorMigration, /formal_students\s*:=\s*formal_students\s*\|\|\s*jsonb_build_array\(record_value\)/i);
  assert.match(accumulatorMigration, /result\s*:=\s*result\s*\|\|\s*jsonb_build_array\(/i);
});

test("the accumulator patch fails closed if either audited accumulator drifts", () => {
  for (const failure of [
    "student_import_base_projection_accumulator_function_missing",
    "student_import_base_projection_accumulator_declaration_anchor_mismatch",
    "student_import_base_projection_accumulator_append_anchor_mismatch",
    "student_import_base_projection_accumulator_return_anchor_mismatch",
    "student_import_base_projection_accumulator_patch_verification_failed",
    "student_import_outer_projection_accumulator_function_missing",
    "student_import_outer_projection_accumulator_declaration_anchor_mismatch",
    "student_import_outer_projection_accumulator_base_append_anchor_mismatch",
    "student_import_outer_projection_accumulator_record_append_anchor_mismatch",
    "student_import_outer_projection_accumulator_return_anchor_mismatch",
    "student_import_outer_projection_accumulator_patch_verification_failed",
  ]) {
    assert.match(accumulatorMigration, new RegExp(failure));
  }
});

test("the JWB package canonicalizer buffers completed purchases and packages once", () => {
  assert.match(
    packageAccumulatorMigration,
    /pg_get_functiondef\([\s\S]*student_import_canonical_jwb_packages\(text,jsonb\)/i,
  );
  assert.match(packageAccumulatorMigration, /result_items\s+jsonb\[\]\s*:=\s*array\[\]::jsonb\[\]/i);
  assert.match(packageAccumulatorMigration, /purchases_items\s*:=\s*array\[\]::jsonb\[\]/i);
  assert.match(
    packageAccumulatorMigration,
    /purchases_items\s*:=\s*array_append\(purchases_items,\s*purchase_value\)/i,
  );
  assert.match(
    packageAccumulatorMigration,
    /result_items\s*:=\s*array_append\(result_items,\s*jsonb_build_object\(/i,
  );
  assert.match(
    packageAccumulatorMigration,
    /result\s*:=\s*coalesce\(to_jsonb\(result_items\),\s*'\[\]'::jsonb\)/i,
  );
});

test("the JWB package accumulator patch fails closed if its audited function drifts", () => {
  for (const failure of [
    "student_import_jwb_package_accumulator_function_missing",
    "student_import_jwb_package_accumulator_declaration_anchor_mismatch",
    "student_import_jwb_package_accumulator_purchase_declaration_anchor_mismatch",
    "student_import_jwb_package_accumulator_purchase_append_anchor_mismatch",
    "student_import_jwb_package_accumulator_package_append_anchor_mismatch",
    "student_import_jwb_package_accumulator_total_anchor_mismatch",
    "student_import_jwb_package_accumulator_patch_verification_failed",
  ]) {
    assert.match(packageAccumulatorMigration, new RegExp(failure));
  }
  assert.match(packageAccumulatorMigration, /set local lock_timeout\s*=\s*'1s'/i);
  assert.match(packageAccumulatorMigration, /purchases\s*:=\s*purchases\s*\|\|\s*jsonb_build_array\(purchase_value\)/i);
  assert.match(packageAccumulatorMigration, /result\s*:=\s*result\s*\|\|\s*jsonb_build_array\(jsonb_build_object\(/i);
});

test("the outer wrapper reuses only the base projection's current PKG-JWB ledger rows", () => {
  assert.match(
    reuseBaseLedgerMigration,
    /pg_get_functiondef\([\s\S]*student_import_canonical_projection\(text,jsonb,jsonb,jsonb,jsonb,jsonb\)/i,
  );
  assert.match(
    reuseBaseLedgerMigration,
    /jsonb_array_elements\(coalesce\(base_student\s*->\s*'lessonPackages',\s*'\[\]'::jsonb\)\)/i,
  );
  assert.match(reuseBaseLedgerMigration, /like\s*'PKG-JWB-%'/i);
  assert.match(
    reuseBaseLedgerMigration,
    /jsonb_agg\(package\.value\s+order by\s+package\.ordinal\)/i,
  );
  assert.match(reuseBaseLedgerMigration, /student_import_reuse_base_jwb_ledger_anchor_mismatch/i);
  assert.match(reuseBaseLedgerMigration, /student_import_reuse_base_jwb_ledger_patch_verification_failed/i);
  assert.match(reuseBaseLedgerMigration, /set local lock_timeout\s*=\s*'1s'/i);
});

test("the all-JWB preflight validates without generating discarded ledger rows", () => {
  assert.match(
    packagePreflightMigration,
    /create or replace function\s+internal\.student_import_validate_jwb_packages\(\s*p_packages\s+jsonb/i,
  );
  assert.match(packagePreflightMigration, /returns\s+void/i);
  assert.match(packagePreflightMigration, /internal\.student_import_has_microhour_precision/i);
  assert.match(packagePreflightMigration, /invalid_student_import_jwb_package_total/i);
  assert.match(
    packagePreflightMigration,
    /perform\s+internal\.student_import_validate_jwb_packages\(\s*jwb\s*->\s*'lessonPackages'\s*\)/i,
  );
  assert.match(
    packagePreflightMigration,
    /where\s+jwb\s+\?\s+'lessonPackages'/i,
  );
  assert.match(packagePreflightMigration, /student_import_jwb_package_preflight_anchor_mismatch/i);
  assert.match(packagePreflightMigration, /student_import_jwb_package_preflight_patch_verification_failed/i);
  assert.match(packagePreflightMigration, /set local lock_timeout\s*=\s*'1s'/i);
});

test("the safe-link pass normalizes source display names once without changing its decisions", () => {
  assert.match(
    safeLinkNormalizationMigration,
    /master_source_values\s+as\s+materialized/i,
  );
  assert.match(
    safeLinkNormalizationMigration,
    /jwb_source_values\s+as\s+materialized/i,
  );
  assert.match(
    safeLinkNormalizationMigration,
    /student_import_annotation_name_key_from_display_name\(/i,
  );
  assert.match(
    safeLinkNormalizationMigration,
    /student_import_jwb_annotation_key_from_display\(/i,
  );
  assert.match(
    safeLinkNormalizationMigration,
    /array_agg\(row_value\s+order by\s+ordinal\)\)\[1\]/i,
  );
  assert.match(
    safeLinkNormalizationMigration,
    /coalesce\(nullif\(annotation_key,\s*''\),\s*name_key\)/i,
  );
  assert.match(safeLinkNormalizationMigration, /student_import_safe_link_normalization_cte_anchor_mismatch/i);
  assert.match(safeLinkNormalizationMigration, /student_import_safe_link_normalization_key_anchor_mismatch/i);
  assert.match(safeLinkNormalizationMigration, /student_import_safe_link_normalization_patch_verification_failed/i);
  assert.match(safeLinkNormalizationMigration, /set local lock_timeout\s*=\s*'1s'/i);
});

test("the formal student-number allocator aggregates reservations and per-day serials once", () => {
  assert.match(
    allocatorMigration,
    /pg_get_functiondef\([\s\S]*student_import_assign_student_numbers\(jsonb,text\)/i,
  );
  assert.match(allocatorMigration, /reservation_assignments\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(allocatorMigration, /generated_assignments\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(allocatorMigration, /serial_floors\s+as\s*\(/i);
  assert.match(allocatorMigration, /row_number\(\)\s+over\s*\(\s*partition by candidate\.candidate_date_key/i);
  assert.match(allocatorMigration, /order by internal\.student_import_utf16_sort_key\(candidate\.student_id\)/i);
  assert.match(allocatorMigration, /jsonb_object_agg\(/i);
  assert.match(allocatorMigration, /coalesce\(jsonb_agg\(/i);
  assert.match(allocatorMigration, /student_number_daily_sequence_exhausted/i);
  assert.match(allocatorMigration, /A present but malformed JWB historical date fails closed/i);
  for (const failure of [
    "student_import_number_allocator_missing",
    "student_import_number_allocator_declaration_anchor_mismatch",
    "student_import_number_allocator_reservation_anchor_mismatch",
    "student_import_number_allocator_validation_tail_anchor_mismatch",
    "student_import_number_allocator_allocation_anchor_mismatch",
    "student_import_number_allocator_result_anchor_mismatch",
    "student_import_number_allocator_patch_verification_failed",
  ]) {
    assert.match(allocatorMigration, new RegExp(failure));
  }
});

test("partial same-source JWB ledgers do not self-promote active facts into history on replay", () => {
  assert.match(
    partialSnapshotReplayMigration,
    /pg_get_functiondef\([\s\S]*student_import_canonical_projection\(text,jsonb,jsonb,jsonb,jsonb,jsonb\)/i,
  );
  assert.match(partialSnapshotReplayMigration, /partial_same_jwb_source\s+boolean\s*:=\s*false/i);
  assert.match(partialSnapshotReplayMigration, /coalesce\(partial_ledger,\s*false\)/i);
  assert.match(
    partialSnapshotReplayMigration,
    /student_import_source_key\(existing_student\s*->\s*'jwbSourceRow'\)\s*is not distinct from\s*internal\.student_import_source_key\(matched_jwb\s*->\s*'sourceRow'\)/i,
  );
  assert.match(partialSnapshotReplayMigration, /not partial_same_jwb_source/i);
  assert.match(partialSnapshotReplayMigration, /student_import_partial_snapshot_declaration_anchor_mismatch/i);
  assert.match(partialSnapshotReplayMigration, /student_import_partial_snapshot_facts_anchor_mismatch/i);
  assert.match(partialSnapshotReplayMigration, /student_import_partial_snapshot_patch_verification_failed/i);
});

test("the provenance trigger materializes first-ordinal and reservation lookups without changing registry proof", () => {
  assert.match(
    provenanceTriggerMigration,
    /pg_get_functiondef\([\s\S]*internal\.enforce_student_number_date_provenance\(\)/i,
  );
  assert.match(provenanceTriggerMigration, /old_by_id\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(provenanceTriggerMigration, /distinct on \(old_student\.value\s*->>\s*'id'\)/i);
  assert.match(provenanceTriggerMigration, /order by old_student\.value\s*->>\s*'id',\s*old_student\.ordinal/i);
  assert.match(provenanceTriggerMigration, /reservation_by_student_id\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(provenanceTriggerMigration, /reservation_by_number\s+jsonb\s*:=\s*'\{\}'::jsonb/i);
  assert.match(provenanceTriggerMigration, /selected_reservation\s*:=\s*case when student_reservation is not null/i);
  assert.match(provenanceTriggerMigration, /student_reservation\s*:=\s*case when student_pending_index is not null/i);
  assert.match(provenanceTriggerMigration, /number_reservation\s*:=\s*case when number_pending_index is not null/i);
  assert.match(provenanceTriggerMigration, /\$provenance_post_insert_anchor\$/i);
  assert.match(provenanceTriggerMigration, /where reservation\.student_number = current_number/i);
  assert.match(provenanceTriggerMigration, /output_started\s+boolean\s*:=\s*false/i);
  assert.match(provenanceTriggerMigration, /next_payload\s*:=\s*next_payload\s*\|\|/i);
});

test("the provenance trigger performance patch fails closed on an audited predecessor drift", () => {
  for (const failure of [
    "student_number_provenance_trigger_missing",
    "student_number_provenance_declaration_anchor_mismatch",
    "student_number_provenance_map_anchor_mismatch",
    "student_number_provenance_old_lookup_anchor_mismatch",
    "student_number_provenance_reservation_lookup_anchor_mismatch",
    "student_number_provenance_post_insert_anchor_mismatch",
    "student_number_provenance_output_anchor_mismatch",
    "student_number_provenance_patch_verification_failed",
  ]) {
    assert.match(provenanceTriggerMigration, new RegExp(failure));
  }
  assert.match(provenanceTriggerMigration, /set local lock_timeout\s*=\s*'1s'/i);
});

test("the base reuses prevalidated JWB package projection only after the all-source preflight", () => {
  assert.match(
    prevalidatedPackageProjectionMigration,
    /create or replace function\s+internal\.student_import_project_prevalidated_jwb_packages\(\s*p_student_id\s+text,\s*p_packages\s+jsonb/i,
  );
  assert.match(prevalidatedPackageProjectionMigration, /returns\s+jsonb/i);
  assert.match(prevalidatedPackageProjectionMigration, /immutable/i);
  assert.match(prevalidatedPackageProjectionMigration, /set search_path\s*=\s*''/i);
  assert.match(
    prevalidatedPackageProjectionMigration,
    /revoke all on function internal\.student_import_project_prevalidated_jwb_packages\(text, jsonb\)\s+from public, anon, authenticated/i,
  );
  assert.match(
    prevalidatedPackageProjectionMigration,
    /perform\s+internal\.student_import_validate_jwb_packages\(p_packages\);\s*return\s+internal\.student_import_project_prevalidated_jwb_packages\(p_student_id, p_packages\);/i,
  );
  assert.match(
    prevalidatedPackageProjectionMigration,
    /preflight_anchor\s*:=\s*\$verbatim_preflight\$\s*perform\s+internal\.student_import_validate_jwb_packages\(\s*jwb\s*->\s*'lessonPackages'\s*\)\s*from jsonb_array_elements\(p_jwb_rows\) jwb\s*where jwb \? 'lessonPackages';\$verbatim_preflight\$/i,
  );
  assert.match(
    prevalidatedPackageProjectionMigration,
    /student_import_project_prevalidated_jwb_packages\(\s*student_id, matched_jwb\s*->\s*'lessonPackages'\s*\)/i,
  );
  assert.match(
    prevalidatedPackageProjectionMigration,
    /\(totals\s*->>\s*''remainingHours''\)::numeric/i,
  );
  assert.match(
    prevalidatedPackageProjectionMigration,
    /\(totals\s*->>\s*''contractHours''\)::numeric/i,
  );
});

test("the prevalidated package projector patch fails closed on base-shape drift", () => {
  for (const failure of [
    "student_import_prevalidated_jwb_projection_base_missing",
    "student_import_prevalidated_jwb_projection_base_projector_anchor_mismatch",
    "student_import_prevalidated_jwb_projection_remaining_total_anchor_mismatch",
    "student_import_prevalidated_jwb_projection_contract_total_anchor_mismatch",
    "student_import_prevalidated_jwb_projection_patch_verification_failed",
  ]) {
    assert.match(prevalidatedPackageProjectionMigration, new RegExp(failure));
  }
  assert.match(prevalidatedPackageProjectionMigration, /set local lock_timeout\s*=\s*'1s'/i);
  assert.match(
    prevalidatedPackageProjectionMigration,
    /count_anchor\s*:=\s*\(length\(definition\)\s*-\s*length\(replace\(definition, preflight_anchor, ''\)\)\)\s*\/\s*length\(preflight_anchor\);/i,
  );
  assert.match(
    prevalidatedPackageProjectionMigration,
    /position\('student_import_canonical_jwb_packages\(' in definition\)\s*<>\s*0/i,
  );
});

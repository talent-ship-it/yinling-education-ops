import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = await readFile(
  new URL("./sql/jiaowubao-direct-import-migrations-compile.sql", import.meta.url),
  "utf8",
);

test("the direct-import migration compile fixture is disposable and loads the exact forward chain", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;/im);
  assert.match(fixture, /20260819000100_create_jiaowubao_direct_import_projection\.sql/i);
  assert.match(fixture, /20260819000200_read_jiaowubao_direct_import_projection\.sql/i);
  assert.match(fixture, /20260819000300_guard_booking_capacity_against_jiaowubao_schedule\.sql/i);
  assert.match(fixture, /20260819000600_fix_jiaowubao_direct_import_envelope_precedence\.sql/i);
  assert.match(fixture, /20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity\.sql/i);
  assert.match(fixture, /20260819000800_fix_jiaowubao_direct_import_completion_proof\.sql/i);
  assert.match(fixture, /20260819000900_optimize_jiaowubao_direct_import_completion_proof\.sql/i);
  assert.match(fixture, /20260819001000_batch_jiaowubao_direct_import_schedule_stage\.sql/i);
  assert.match(fixture, /20260819001100_resume_jiaowubao_direct_import_chunks\.sql/i);
  assert.match(fixture, /20260819001200_guard_jiaowubao_direct_import_auto_abort\.sql/i);
  assert.match(fixture, /20260819100400_read_jiaowubao_operations_readiness\.sql/i);
  assert.match(fixture, /20260819100500_review_jiaowubao_schedule_label_mappings\.sql/i);
  assert.match(fixture, /20260819100600_materialize_jiaowubao_schedule_mapping_candidates\.sql/i);
  assert.match(fixture, /to_regclass\('internal\.jiaowubao_direct_import_runs'\)/i);
  assert.match(fixture, /to_regprocedure\('internal\.begin_jiaowubao_direct_import\(jsonb,text\)'\)/i);
  assert.match(fixture, /to_regprocedure\('internal\.abort_jiaowubao_direct_import_if_current_master_differs\(uuid,text,text,text,text\)'\)/i);
  assert.match(fixture, /to_regprocedure\('public\.get_jiaowubao_direct_schedule_window\(text,timestamptz,timestamptz,text,text\[\],text\[\],integer,timestamptz,uuid,uuid\)'\)/i);
  assert.match(fixture, /to_regprocedure\('public\.get_jiaowubao_direct_operations_readiness\(text,timestamptz,timestamptz,integer,integer,integer\)'\)/i);
  assert.match(fixture, /to_regprocedure\('public\.get_jiaowubao_direct_schedule_mapping_review\(text,integer,text\)'\)/i);
  assert.match(fixture, /to_regprocedure\('public\.put_jiaowubao_direct_schedule_label_mapping\(text,text,uuid,text,text,text,bigint,text\)'\)/i);
  assert.match(fixture, /perform internal\.jiaowubao_direct_import_assert_envelope\(valid_envelope\)/i);
  assert.match(fixture, /perform internal\.jiaowubao_direct_import_assert_staging_chunk\(test_run_id, valid_chunk\)/i);
  assert.match(
    fixture,
    /perform internal\.stage_jiaowubao_direct_import_chunk\(\s*test_run_id, valid_chunk, valid_projection, 'Migration fixture'\s*\)/i,
  );
  assert.match(
    fixture,
    /perform internal\.complete_jiaowubao_direct_import\(test_run_id, 'Migration fixture'\)/i,
  );
  assert.match(fixture, /completed_run\.state = 'complete'/i);
  assert.match(fixture, /public\.get_jiaowubao_direct_operations_readiness\(/i);
  assert.match(fixture, /public\.get_jiaowubao_direct_schedule_mapping_review\(/i);
  assert.match(fixture, /'sourceKey', 'jwb-mapping-fixture:schedule:1'/i);
  assert.match(fixture, /'sourceKey', 'jwb-mapping-fixture:schedule:2'/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_first_cursor_page_failed/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_second_cursor_page_failed/i);
  assert.match(fixture, /public\.put_jiaowubao_direct_schedule_label_mapping\(/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_confirm_replay_failed/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_noop_receipt_failed/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_revoke_supersede_failed/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_stale_version_not_rejected/i);
  assert.match(fixture, /SQLSTATE <> '40001'/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_authority_drift_readback_failed/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_source_or_booking_mutated/i);
  assert.match(fixture, /generate_series\(1, 513\)/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_teacher_catalog_bound_not_rejected/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_teacher_catalog_too_large/i);
  assert.match(fixture, /generate_series\(1, 121\)/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_teacher_subject_catalog_bound_not_rejected/i);
  assert.match(fixture, /jiaowubao_schedule_mapping_teacher_subject_catalog_too_large/i);
  assert.match(fixture, /insert into public\.ops_state[\s\S]*?'students'[\s\S]*?'teachers'[\s\S]*?'bookings'/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
});

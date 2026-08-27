import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819001200_guard_jiaowubao_direct_import_auto_abort.sql",
    import.meta.url,
  ),
  "utf8",
);
const fixture = await readFile(
  new URL("./sql/jiaowubao-direct-import-auto-abort-contract.sql", import.meta.url),
  "utf8",
);

const abortIfCurrentMasterDiffers = migration.match(
  /create or replace function internal\.abort_jiaowubao_direct_import_if_current_master_differs\([\s\S]*?\$abort_jiaowubao_direct_import_if_current_master_differs\$;/i,
)?.[0] ?? "";

test("012 makes authority-drift cleanup conditional on the exact locked current Tencent master", () => {
  assert.match(
    abortIfCurrentMasterDiffers,
    /returns jsonb\s+language plpgsql\s+security invoker\s+set search_path = ''/i,
  );
  assert.match(
    abortIfCurrentMasterDiffers,
    /p_expected_master_rows_sha256 is null\s+or p_expected_master_rows_sha256 !~ '\^\[a-f0-9\]\{64\}\$'/i,
  );

  // The preliminary read only forms the same revision advisory key as 011.
  // The authoritative locked reads are run first and master second, matching
  // completion and ensuring an authority refresh cannot slip between proof
  // and the delegated cleanup.
  const lockedRunAt = abortIfCurrentMasterDiffers.indexOf(
    "where run_state.id = p_run_id\n  for update;",
  );
  const lockedMasterAt = abortIfCurrentMasterDiffers.indexOf(
    "where source_state.source_kind = 'master'\n  for share;",
  );
  assert.notEqual(lockedRunAt, -1);
  assert.notEqual(lockedMasterAt, -1);
  assert.ok(lockedRunAt < lockedMasterAt, "the authoritative run lock precedes the master lock");
  assert.match(abortIfCurrentMasterDiffers, /pg_catalog\.pg_advisory_xact_lock/i);

  assert.match(
    abortIfCurrentMasterDiffers,
    /current_master\.source_id is distinct from p_expected_master_source_id[\s\S]*?current_master\.revision is distinct from p_expected_master_revision[\s\S]*?current_master\.rows_sha256 is distinct from p_expected_master_rows_sha256/i,
  );
  assert.match(
    abortIfCurrentMasterDiffers,
    /current_master\.source_id is not distinct from saved_run\.master_source_id[\s\S]*?current_master\.revision is not distinct from saved_run\.master_revision[\s\S]*?current_master\.rows_sha256 is not distinct from saved_run\.master_rows_sha256/i,
  );
  assert.match(abortIfCurrentMasterDiffers, /'reason', 'current_master_not_expected'/i);
  assert.match(abortIfCurrentMasterDiffers, /'reason', 'run_master_still_current'/i);
  assert.match(
    abortIfCurrentMasterDiffers,
    /abort_receipt := internal\.abort_jiaowubao_direct_import\(p_run_id, p_actor\);/i,
  );
  assert.match(abortIfCurrentMasterDiffers, /'state', 'aborted'[\s\S]*?'aborted', true/i);
  assert.doesNotMatch(
    abortIfCurrentMasterDiffers,
    /^\s*(?:delete\s+from|update\s+internal\.|insert\s+into)\s+/im,
  );
  assert.match(
    migration,
    /revoke all on function internal\.abort_jiaowubao_direct_import_if_current_master_differs\(uuid, text, text, text, text\)\s+from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(migration, /security definer|grant\s+execute|create\s+(?:or\s+replace\s+)?function\s+public\./i);
});

test("the disposable 012 fixture proves cleanup, stale-observation no-op, and no-drift no-op", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;$/im);
  assert.match(fixture, /20260819001100_resume_jiaowubao_direct_import_chunks\.sql/i);
  assert.match(fixture, /20260819001200_guard_jiaowubao_direct_import_auto_abort\.sql/i);
  assert.match(fixture, /abort_jiaowubao_direct_import_if_current_master_differs/i);
  assert.match(fixture, /jiaowubao_direct_import_auto_abort_cleanup_failed/i);
  assert.match(fixture, /current_master_not_expected/i);
  assert.match(fixture, /jiaowubao_direct_import_auto_abort_expected_mismatch_deleted/i);
  assert.match(fixture, /run_master_still_current/i);
  assert.match(fixture, /jiaowubao_direct_import_auto_abort_no_drift_deleted/i);
  assert.match(fixture, /run_state\.abort_audit_id is not null or run_state\.aborted_at is not null/i);
  assert.match(fixture, /jiaowubao_direct_import\.aborted/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
});

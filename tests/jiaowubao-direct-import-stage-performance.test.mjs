import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../supabase/migrations/20260819001000_batch_jiaowubao_direct_import_schedule_stage.sql", import.meta.url),
  "utf8",
);
const fixture = await readFile(
  new URL("./sql/jiaowubao-direct-import-stage-performance.sql", import.meta.url),
  "utf8",
);

test("010 batches schedule events and participants without weakening the private contract", () => {
  assert.match(migration, /create or replace function internal\.stage_jiaowubao_direct_import_chunk\(/iu);
  assert.match(migration, /language plpgsql\s+security invoker\s+set search_path = ''/iu);
  assert.match(migration, /insert into internal\.jiaowubao_direct_schedule_events[\s\S]+?from jsonb_array_elements\(p_projection -> 'scheduleEvents'\)/iu);
  assert.match(migration, /insert into internal\.jiaowubao_direct_schedule_event_participants[\s\S]+?cross join lateral jsonb_array_elements\(schedule_projection_row\.value -> 'participants'\)/iu);
  assert.match(migration, /jiaowubao_direct_import_schedule_participant_coverage_invalid/iu);
  assert.match(migration, /jiaowubao_direct_import_schedule_participant_identity_required/iu);
  assert.match(migration, /revoke all on function internal\.stage_jiaowubao_direct_import_chunk\(uuid, jsonb, jsonb, text\)\s+from public, anon, authenticated/iu);
  assert.doesNotMatch(migration, /security definer|grant\s+execute|drop\s+table|delete\s+from/iu);
});

test("the local stage benchmark executes 010 inside one disposable transaction", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/mu);
  assert.match(fixture, /^begin;$/imu);
  assert.match(fixture, /20260819001000_batch_jiaowubao_direct_import_schedule_stage\.sql/iu);
  assert.match(fixture, /1499 events \+ 1499 participants \+ 1 identity/iu);
  assert.match(fixture, /perform internal\.stage_jiaowubao_direct_import_chunk\(/iu);
  assert.match(fixture, /jiaowubao_direct_import_stage_fixture_count_mismatch/iu);
  assert.match(fixture, /^rollback;$/imu);
  assert.doesNotMatch(fixture, /^commit;$/imu);
});

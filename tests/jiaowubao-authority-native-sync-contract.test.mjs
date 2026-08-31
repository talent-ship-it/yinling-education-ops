import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, nativeMatchMigration, quarantineMigration, store] = await Promise.all([
  readFile(new URL("../supabase/migrations/20260831000800_apply_jiaowubao_authority_to_native.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260831000900_report_jiaowubao_native_matches.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260831001000_quarantine_jiaowubao_native_row_failures.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
]);

test("every authority entity gets a durable private native crosswalk", () => {
  assert.match(migration, /create table if not exists internal\.jiaowubao_authority_native_links/);
  assert.match(migration, /entity_type in \('schedule','student','teacher','course','class','room'\)/);
  assert.match(migration, /primary key \(entity_type, source_native_id\)/);
  assert.match(migration, /alter table internal\.jiaowubao_authority_native_links enable row level security/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_authority_native_links from public, anon, authenticated/);
  assert.match(migration, /source_payload jsonb not null/);
  assert.match(migration, /'rawPayloadStoredPrivately', true/);
  assert.match(migration, /'priceStoredPrivately'/);
});

test("the native merge is secret-gated, deterministic, atomic and idempotent", () => {
  assert.match(migration, /create or replace function public\.apply_jiaowubao_open_api_authority_native/);
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /order by state\.entity\s+for update/);
  assert.match(migration, /internal\.jiaowubao_authority_native_id\('STU'/);
  assert.match(migration, /internal\.jiaowubao_authority_native_id\('BOOK'/);
  assert.match(migration, /next_students is distinct from students_state\.payload/);
  assert.match(migration, /next_bookings is distinct from bookings_state\.payload/);
  assert.match(migration, /update public\.ops_state state set/);
  assert.match(migration, /version = state\.version \+ 1/);
  assert.match(migration, /'mappingRates', jsonb_build_object/);
  assert.match(migration, /'students', 100/);
  assert.match(migration, /'schedules', 100/);
  assert.doesNotMatch(migration, /grant execute on function public\.apply_jiaowubao_open_api_authority_native/);
});

test("one 30-minute RPC applies native data and returns a post-write projection", () => {
  assert.match(migration, /rename to project_jiaowubao_open_api_authority_read_model/);
  assert.match(migration, /initial_projection := public\.project_jiaowubao_open_api_authority_read_model/);
  assert.match(migration, /native_apply := public\.apply_jiaowubao_open_api_authority_native/);
  assert.match(migration, /if native_apply ->> 'applied' = 'true' then/);
  assert.equal((migration.match(/final_projection := public\.project_jiaowubao_open_api_authority_read_model/g) ?? []).length, 1);
  assert.match(migration, /'\{coverage,nativeRecordsSynchronized\}'/);
  assert.match(migration, /grant execute on function public\.project_jiaowubao_open_api_authority\(text,text,text\)/);
  assert.match(store, /timeoutMs: 260_000/);
});

test("the verified one-student schedule shape becomes a normal native booking", () => {
  assert.match(migration, /jsonb_array_length\(source_entity\.payload -> 'stu_list'\) <> 1/);
  assert.match(migration, /'sourceLessonId', 'jwb-open-api:schedule:' \|\| mapped\.source_native_id/);
  assert.match(migration, /'studentId', mapped\.student_id/);
  assert.match(migration, /'teacherId', mapped\.teacher_id/);
  assert.match(migration, /'course', coalesce\(nullif\(btrim\(mapped\.record ->> 'course_title'\)/);
  assert.match(migration, /durationInferredFromHours/);
  assert.match(migration, /internal\.jiaowubao_authority_booking_duration/);
});

test("the final public match rate uses the durable crosswalk, including nameless source IDs", () => {
  assert.match(nativeMatchMigration, /internal\.jiaowubao_authority_native_links/);
  assert.match(nativeMatchMigration, /link\.active/);
  assert.match(nativeMatchMigration, /'basis', 'durable_source_id_crosswalk'/);
  assert.match(nativeMatchMigration, /'matchRate', case when matched = 0 then 0 else 100 end/);
  assert.match(nativeMatchMigration, /final_projection := jsonb_set\(final_projection, '\{matches\}', native_matches, true\)/);
  assert.match(nativeMatchMigration, /'\{coverage,sourceOnlyEntityRows\}'/);
  assert.match(nativeMatchMigration, /'0'::jsonb/);
});

test("one malformed source row is quarantined privately instead of aborting its batch", () => {
  assert.match(quarantineMigration, /create table if not exists internal\.jiaowubao_authority_native_quarantine/);
  assert.match(quarantineMigration, /alter table internal\.jiaowubao_authority_native_quarantine enable row level security/);
  assert.match(quarantineMigration, /revoke all on table internal\.jiaowubao_authority_native_quarantine\s+from public, anon, authenticated, service_role/);
  assert.match(quarantineMigration, /create or replace function internal\.jiaowubao_authority_native_schedule_skip_reason/);
  assert.match(quarantineMigration, /'duplicate_source_id'/);
  assert.match(quarantineMigration, /'participant_count_not_one'/);
  assert.match(quarantineMigration, /insert into internal\.jiaowubao_authority_native_quarantine/);
  assert.match(quarantineMigration, /replace\(source_definition, fail_fast_anchor, quarantine_block\)/);
  assert.match(quarantineMigration, /replace\(patched_definition, incomplete_anchor, ''\)/);
  assert.match(quarantineMigration, /position\('jiaowubao_authority_native_schedule_shape_invalid' in patched_definition\) <> 0/);
  assert.match(quarantineMigration, /position\('jiaowubao_authority_native_schedule_mapping_incomplete' in patched_definition\) <> 0/);
});

test("the final receipt reports successful and skipped rows without claiming false 100 percent", () => {
  assert.match(quarantineMigration, /'rowFailurePolicy', 'skip_and_record'/);
  assert.match(quarantineMigration, /'skippedRows', native_skipped_count/);
  assert.match(quarantineMigration, /'batchContinuedAfterSkips', native_skipped_count > 0/);
  assert.match(quarantineMigration, /'matchRate', case when total = 0 then 0\s+else round\(matched::numeric \* 100 \/ total, 2\) end/);
  assert.match(quarantineMigration, /'sourceOnly', skipped/);
  assert.match(quarantineMigration, /'\{coverage,sourceOnlyEntityRows\}'/);
  assert.match(quarantineMigration, /to_jsonb\(native_skipped_count\)/);
  assert.match(quarantineMigration, /'\{prices,skippedPriceRecords\}'/);
  assert.match(quarantineMigration, /'durable_source_id_crosswalk_with_quarantine'/);
});

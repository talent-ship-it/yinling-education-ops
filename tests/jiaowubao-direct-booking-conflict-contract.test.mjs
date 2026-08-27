import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, route, originalContract] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819000300_guard_booking_capacity_against_jiaowubao_schedule.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../app/api/bookings/mutate/route.ts", import.meta.url), "utf8"),
  readFile(new URL(
    "../supabase/migrations/20260813013935_operational_atomic_contracts.sql",
    import.meta.url,
  ), "utf8"),
]);

test("Jiaowubao blocks are a database-enforced teacher and student conflict surface", () => {
  const helper = migration.match(
    /create or replace function internal\.assert_jiaowubao_direct_booking_interval_available\([\s\S]*?\$assert_jiaowubao_direct_booking_interval_available\$;/i,
  )?.[0] ?? "";
  assert.ok(helper, "private schedule-conflict helper must exist");
  assert.match(helper, /security definer/i);
  assert.match(helper, /set search_path = ''/i);
  assert.match(migration, /revoke all on function internal\.assert_jiaowubao_direct_booking_interval_available/i);
  assert.match(helper, /lock table internal\.jiaowubao_direct_import_runs in share mode/i);
  assert.match(helper, /pg_catalog\.set_config\('lock_timeout', '1s', true\)/i);
  assert.match(helper, /from pg_catalog\.pg_timezone_names/i);
  assert.match(helper, /for occurrence_index in 0\.\.\(occurrence_count - 1\)/i);
  assert.match(helper, /occurrence_date := source_date \+ \(occurrence_index \* 7\)/i);
  assert.match(helper, /candidate_count < 1/i);
  assert.match(helper, /candidate\.starts_at at time zone source_timezone = source_local_start/i);
  assert.match(helper, /internal\.jiaowubao_direct_current_schedule_blocks/i);
  assert.match(helper, /imported_block\.occupied_range && tstzrange\(/i);
  assert.match(helper, /imported_block\.teacher_id = p_teacher_id/i);
  assert.match(helper, /p_student_id = any\(imported_block\.student_ids\)/i);
  assert.match(helper, /jiaowubao_direct_import_schedule_conflict/i);
  // Existing booking validation permits a repeated wall clock. The SQL guard
  // keeps that behavior but examines all exact IANA candidates so either side
  // of a DST fold cannot bypass a direct-import interval.
  assert.match(helper, /A repeated DST[\s\S]*?test every exact candidate/is);
  assert.doesNotMatch(helper, /candidate_count <> 1/i);
});

test("the public booking RPC is patched only through an exact fail-closed anchor", () => {
  const original = originalContract.match(
    /create or replace function public\.mutate_booking_capacity_atomic\([\s\S]*?\n\$\$;/i,
  )?.[0] ?? "";
  const originalWriteAnchor = [
    "  update public.ops_state s set",
    "    payload = p_bookings,",
    "    version = s.version + 1,",
    "    updated_at = now(),",
    "    updated_by = left(trim(p_actor), 120)",
    "  where s.entity = 'bookings'",
    "  returning s.* into saved_booking_state;",
  ].join("\n");
  assert.ok(original, "current reviewed booking RPC source must exist");
  assert.equal(
    original.split(originalWriteAnchor).length - 1,
    1,
    "the 003 dynamic anchor must match exactly one legacy booking-state write",
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\.mutate_booking_capacity_atomic\(/i,
  );
  assert.match(
    migration,
    /to_regprocedure\(\s*'public\.mutate_booking_capacity_atomic\(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text\)'/is,
  );
  assert.match(migration, /pg_get_functiondef\(target_oid\)/i);
  assert.match(migration, /target_proc\.pronargs <> 12/i);
  assert.match(migration, /target_proc\.proargnames\[1:target_proc\.pronargs\] is distinct from ARRAY/i);
  assert.match(migration, /position\(anchor in source_definition\) = 0/i);
  assert.match(migration, /position\(anchor in substr\(source_definition/i);
  assert.match(migration, /guard \|\| anchor/i);
  assert.match(migration, /jiaowubao_booking_capacity_guard_anchor_mismatch/i);
  assert.match(migration, /execute patched_definition/i);
  assert.match(migration, /jiaowubao_booking_capacity_guard_postcheck_failed/i);
  assert.match(migration, /if p_action <> 'delete' then[\s\S]*?assert_jiaowubao_direct_booking_interval_available/is);
  assert.match(
    migration,
    /revoke all on function public\.mutate_booking_capacity_atomic\([\s\S]*?from public, anon, authenticated/is,
  );
  assert.match(migration, /grant execute on function public\.mutate_booking_capacity_atomic\(/i);
  // The conflict identifier deliberately stays in the private helper; the
  // dynamic public patch contains only the helper call, so a copied public
  // function body cannot accidentally drift into a different error contract.
  assert.match(migration, /position\('jiaowubao_direct_import_schedule_conflict' in patched_definition\) <> 0/i);
});

test("the booking route turns the exact database conflict into a retryable 409", () => {
  assert.match(
    route,
    /error\.message === "jiaowubao_direct_import_schedule_conflict"[\s\S]*?code: "jiaowubao_direct_import_schedule_conflict"[\s\S]*?\}, 409\)/is,
  );
});

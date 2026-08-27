import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819000900_optimize_jiaowubao_direct_import_completion_proof.sql",
    import.meta.url,
  ),
  "utf8",
);
const originalMigration = await readFile(
  new URL(
    "../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql",
    import.meta.url,
  ),
  "utf8",
);
const benchmarkFixture = await readFile(
  new URL("./sql/jiaowubao-direct-import-completion-performance.sql", import.meta.url),
  "utf8",
);

const extractFunction = (sql, name, terminator) => {
  const start = sql.indexOf(`create or replace function internal.${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const endMarker = `$${terminator}$;`;
  const end = sql.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${name} must have its reviewed terminator`);
  return sql.slice(start, end + endMarker.length);
};

const originalValidation = extractFunction(
  originalMigration,
  "jiaowubao_direct_import_validate_projection",
  "jiaowubao_direct_import_validate_projection",
);
const validation = extractFunction(
  migration,
  "jiaowubao_direct_import_validate_projection",
  "jiaowubao_direct_import_validate_projection",
);
const timeHelper = extractFunction(
  migration,
  "jiaowubao_direct_import_assert_unambiguous_schedule_time",
  "jiaowubao_direct_import_assert_unambiguous_schedule_time",
);

test("009 byte-preserves the authority and attachment proof before the optimized schedule section", () => {
  const originalPrefix = originalValidation.slice(
    0,
    originalValidation.indexOf("  schedule_time_proofs"),
  );
  const optimizedPrefix = validation.slice(
    0,
    validation.indexOf("  schedule_checked"),
  );

  assert.equal(optimizedPrefix, originalPrefix);
});

test("the Melbourne proof uses only direct and adjacent-transition candidates", () => {
  for (const body of [timeHelper, validation]) {
    assert.doesNotMatch(body, /generate_series|make_interval|count\(distinct/i);
    assert.match(
      body,
      /direct_start at time zone 'Australia\/Melbourne'[\s\S]*?distinct from (?:schedule_event\.)?local_start/i,
    );
    assert.match(body, /direct_start is distinct from (?:schedule_event\.)?(?:p_starts_at|starts_at)/i);
    assert.match(
      body,
      /\((?:schedule_event\.)?direct_start - interval '1 hour'\) at time zone 'Australia\/Melbourne'[\s\S]*?= (?:schedule_event\.)?local_start/i,
    );
    assert.match(
      body,
      /\((?:schedule_event\.)?direct_start \+ interval '1 hour'\) at time zone 'Australia\/Melbourne'[\s\S]*?= (?:schedule_event\.)?local_start/i,
    );
  }
  assert.doesNotMatch(validation, /schedule_time_(?:endpoints|candidates|proofs)/i);
  assert.match(validation, /direct_candidate\(direct_start, direct_end\)/i);
  assert.match(timeHelper, /p_source_timezone is distinct from 'Australia\/Melbourne'/i);
  assert.match(timeHelper, /p_dst_resolution is distinct from 'unambiguous'/i);
});

test("schedule teacher, subject, and time checks reuse one narrow schedule scan", () => {
  assert.match(validation, /schedule_checked as materialized/i);
  assert.match(validation, /exact_teacher_evidence as materialized[\s\S]*?select distinct/i);
  assert.match(validation, /exact_teacher_checked as materialized/i);
  assert.match(validation, /current_teacher_count/i);
  assert.match(validation, /current_teacher_name_count/i);

  const scheduleTableReferences = validation.match(
    /internal\.jiaowubao_direct_schedule_events\b/gi,
  ) ?? [];
  assert.equal(
    scheduleTableReferences.length,
    3,
    "two participant joins plus one schedule_checked scan are the only schedule relation reads",
  );
  for (const code of [
    "jiaowubao_direct_import_schedule_time_proof_invalid",
    "jiaowubao_direct_import_teacher_name_evidence_invalid",
    "jiaowubao_direct_import_teacher_id_not_exact_current_record",
    "jiaowubao_direct_import_teacher_name_ambiguous",
    "jiaowubao_direct_import_subject_resolution_not_yet_authoritative",
  ]) assert.match(validation, new RegExp(code, "u"));
});

test("both replacements preserve private invoker boundaries and ACLs", () => {
  for (const body of [timeHelper, validation]) {
    assert.match(body, /returns void\s+language plpgsql\s+security invoker\s+set search_path = ''/i);
  }
  assert.match(
    migration,
    /revoke all on function internal\.jiaowubao_direct_import_assert_unambiguous_schedule_time\(text, date, text, time, time, timestamptz, timestamptz, text\)\s+from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /revoke all on function internal\.jiaowubao_direct_import_validate_projection\(uuid, jsonb, jsonb, jsonb\)\s+from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(migration, /\b(?:grant|security definer|drop|truncate)\b/i);
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from)\s+public\.ops_state\b/i);
});

test("the 39,743-event PostgreSQL performance fixture is timed and fully rolled back", () => {
  assert.match(benchmarkFixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(benchmarkFixture, /^begin;/im);
  assert.match(benchmarkFixture, /generate_series\(1, 39743\)/i);
  assert.match(benchmarkFixture, /event_number <= 27011/i);
  assert.match(benchmarkFixture, /clock_timestamp\(\)/i);
  assert.match(benchmarkFixture, /benchmark_elapsed_ms > 1000/i);
  assert.match(benchmarkFixture, /jiaowubao_direct_import_validate_projection/i);
  assert.match(benchmarkFixture, /date '2026-04-05'[\s\S]*?time '02:30'/i);
  assert.match(benchmarkFixture, /date '2026-10-04'[\s\S]*?time '02:30'/i);
  assert.match(benchmarkFixture, /jiaowubao_direct_import_schedule_time_proof_invalid/i);
  assert.match(benchmarkFixture, /^rollback;$/im);
  assert.doesNotMatch(benchmarkFixture, /^commit;$/im);
});

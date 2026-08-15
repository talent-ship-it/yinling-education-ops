import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonical = await readFile(new URL(
  "../supabase/migrations/20260813013935_operational_atomic_contracts.sql",
  import.meta.url,
), "utf8");
const forward = await readFile(new URL(
  "../supabase/migrations/20260815034000_permanent_teacher_replacement_atomic.sql",
  import.meta.url,
), "utf8");

function sqlFunction(source, qualifiedName) {
  const marker = `create or replace function ${qualifiedName}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${qualifiedName} is missing`);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${qualifiedName} is unterminated`);
  return source.slice(start, end + 4);
}

const helpers = [
  "internal.permanent_teacher_replacement_occurrence_projection",
  "internal.permanent_teacher_replacement_upsert_override",
  "internal.permanent_teacher_replacement_expected_bookings",
  "internal.permanent_teacher_replacement_expected_teachers",
];
const rpcs = [
  "public.get_permanent_teacher_replacement_command_result",
  "public.confirm_permanent_teacher_replacement_atomic",
];

test("permanent replacement forward migration exactly matches the canonical contract", () => {
  const start = canonical.indexOf("-- A permanent teacher handover");
  const end = canonical.indexOf("-- BEGIN EXAM SUBMISSION ATOMIC SUFFIX", start);
  assert.ok(start >= 0 && end > start, "canonical permanent replacement suffix boundaries are missing");
  const canonicalContract = canonical.slice(start, end).trimEnd() + "\n";
  assert.equal(forward, canonicalContract, "the complete forward migration must equal the canonical suffix");
  for (const name of [...helpers, ...rpcs]) {
    assert.equal(sqlFunction(forward, name), sqlFunction(canonical, name), `${name} parity`);
  }
  for (const source of [canonical, forward]) {
    assert.match(source, /create table if not exists internal\.permanent_teacher_replacement_commands/i);
    assert.match(source, /alter table internal\.permanent_teacher_replacement_commands enable row level security/i);
    assert.match(source, /permanent_replacement_fixture_occurrence_closure_mismatch/i);
    assert.match(source, /permanent_replacement_fixture_booking_history_mismatch/i);
    assert.match(source, /permanent_replacement_fixture_colon_booking_id_collision/i);
    assert.match(source, /permanent_replacement_fixture_non_string_override_accepted/i);
    assert.match(source, /permanent_replacement_fixture_capacity_mismatch/i);
  }
});

test("both RPCs keep the server-secret and explicit Data API execution boundary", () => {
  for (const name of rpcs) {
    const body = sqlFunction(forward, name);
    assert.match(body, /internal\.verify_ops_secret\(p_secret\)/i);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = ''/i);
  }
  for (const signature of [
    "get_permanent_teacher_replacement_command_result(text, text, jsonb, text)",
    "confirm_permanent_teacher_replacement_atomic(text, text, jsonb, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text)",
  ]) {
    const escaped = signature.replace(/[()]/g, "\\$&");
    assert.match(forward, new RegExp(
      `revoke all on function public\\.${escaped}\\s+from public, anon, authenticated, service_role`, "i",
    ));
    assert.match(forward, new RegExp(
      `grant execute on function public\\.${escaped}\\s+to anon, authenticated`, "i",
    ));
  }
});

test("atomic replacement locks the four rows in the global order before replay or mutation", () => {
  const body = sqlFunction(forward, "public.confirm_permanent_teacher_replacement_atomic");
  const bookingLock = body.indexOf("s.entity = 'bookings' for update");
  const operationLock = body.indexOf("s.entity = 'operations' for update");
  const studentLock = body.indexOf("s.entity = 'students' for update");
  const teacherLock = body.indexOf("s.entity = 'teachers' for update");
  const ledgerRead = body.lastIndexOf("from internal.permanent_teacher_replacement_commands c");
  assert.ok(bookingLock > 0 && bookingLock < operationLock);
  assert.ok(operationLock < studentLock && studentLock < teacherLock);
  assert.ok(teacherLock < ledgerRead, "ledger must be re-read after all locks");
  assert.match(body, /prior\.affected_occurrence_ids is distinct from p_affected_occurrence_ids/i);
  assert.match(body, /prior\.changed_teacher_ids is distinct from p_changed_teacher_ids/i);
  assert.match(body, /return query select prior\.command_key[\s\S]*false,[\s\S]*prior\.audit_id/i);
});

test("the database recomputes every caller-supplied projection from locked state", () => {
  const body = sqlFunction(forward, "public.confirm_permanent_teacher_replacement_atomic");
  assert.match(body, /permanent_teacher_replacement_occurrence_projection\([\s\S]*booking_state\.payload[\s\S]*true/i);
  assert.match(body, /expected_projection -> 'occurrenceIds' is distinct from p_affected_occurrence_ids/i);
  assert.match(body, /permanent_teacher_replacement_expected_bookings\([\s\S]*booking_state\.payload/i);
  assert.match(body, /p_bookings is distinct from expected_bookings/i);
  assert.match(body, /permanent_teacher_replacement_expected_teachers\([\s\S]*teacher_state\.payload/i);
  assert.match(body, /p_changed_teacher_ids is distinct from expected_changed_teacher_ids/i);
  assert.match(body, /p_teachers is distinct from expected_teachers/i);
  assert.match(body, /p_students is distinct from expected_students/i);
  assert.match(body, /from internal\.teacher_departure_creation_commands creation/i);
  assert.match(body, /current_operation ->> 'creationCommandKey'/i);
  assert.match(body, /creation_group\.value ->> 'operationId' = p_operation_id/i);
  assert.match(body, /'OPS-DEPARTURE-' \|\| pg_catalog\.left\(encode\(extensions\.digest\(/i);
  assert.match(body, /replacement_already_active[\s\S]*replacement_already_assigned[\s\S]*acceptsStudents/i);
  assert.match(body, /current_operation - 'status'[\s\S]*is distinct from[\s\S]*next_operation - 'status'/i);
  assert.match(body, /full join jsonb_array_elements\(p_operations\) with ordinality/i);
  assert.equal(
    (forward.match(/pg_catalog\.left\((?:value|item\.value|affected\.value), length\((?:value|item\.value|affected\.value)\) - 11\)/gi) ?? []).length,
    4,
    "every occurrence-to-series lookup must remove the final date suffix",
  );
  assert.doesNotMatch(forward, /length\(booking(?:\.value)? ->> 'id'\) \+ 1/i);
  const occurrenceProjection = sqlFunction(
    forward,
    "internal.permanent_teacher_replacement_occurrence_projection",
  );
  assert.match(occurrenceProjection, /jsonb_typeof\(item\.value -> 'teacherId'\) not in \('string', 'null'\)/i);
  assert.match(occurrenceProjection, /jsonb_typeof\(item\.value -> 'studentId'\) not in \('string', 'null'\)/i);
});

test("OCC, confirmed-without-ledger, actor and first-confirmation time all fail closed", () => {
  const body = sqlFunction(forward, "public.confirm_permanent_teacher_replacement_atomic");
  for (const entity of ["booking", "operation", "student", "teacher"]) {
    assert.match(body, new RegExp(`expected_${entity}_version < 1`, "i"));
  }
  assert.match(body, /trim\(current_operation ->> 'status'\)[\s\S]*= '已确认'[\s\S]*permanent_replacement_confirmed_without_ledger/i);
  assert.match(body, /next_operation ->> 'confirmedBy' is distinct from trim\(p_actor\)/i);
  assert.match(body, /confirmed_at_text[\s\S]*\[0-9\]\{3\}Z\$/i);
  assert.match(body, /clock_timestamp\(\) - interval '15 minutes'/i);
  assert.match(body, /clock_timestamp\(\) \+ interval '2 minutes'/i);
});

test("command key is the SHA-256 of the same narrow JSON intent used by TypeScript", () => {
  const intent = { operationId: "OPS-1", chosenTeacherId: "T-2" };
  const expected = `permanent-teacher-replacement:${createHash("sha256")
    .update(JSON.stringify(intent)).digest("hex")}`;
  assert.equal(expected, "permanent-teacher-replacement:c87abd19850847a98b1bd9f9cc4edf1a0980a03ce20dc1bb6a996709c6dd5e6f");
  for (const name of rpcs) {
    const body = sqlFunction(forward, name);
    assert.match(body, /\{\"operationId\":\"'[\s\S]*\",\"chosenTeacherId\":\"'/i);
    assert.match(body, /extensions\.digest\([\s\S]*'sha256'/i);
  }
});

test("only changed rows advance versions, and every advance is mutation-logged", () => {
  const body = sqlFunction(forward, "public.confirm_permanent_teacher_replacement_atomic");
  for (const [state, entity] of [
    ["booking", "bookings"],
    ["operation", "operations"],
    ["student", "students"],
    ["teacher", "teachers"],
  ]) {
    assert.match(body, new RegExp(
      `if ${state}_state\\.payload is distinct from[\\s\\S]*where s\\.entity = '${entity}'[\\s\\S]*insert into public\\.ops_mutation_log`,
      "i",
    ));
  }
  assert.match(body, /insert into internal\.permanent_teacher_replacement_commands/i);
  assert.match(body, /internal\.append_operational_contract_audit/i);
});

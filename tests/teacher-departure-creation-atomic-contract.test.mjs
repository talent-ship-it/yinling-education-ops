import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260815041000_teacher_departure_creation_atomic.sql",
  import.meta.url,
);

function sqlFunction(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(start >= 0 && end > start, `${name} function body is missing`);
  return sql.slice(start, end + 4);
}

test("departure client sends only the narrow five-version command to one atomic route", async () => {
  const [route, store, client, service] = await Promise.all([
    readFile(new URL("../app/api/operations/departure/create/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/teacher-departure-creation-service.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /parseTeacherDepartureCreationCommand/);
  assert.match(route, /getOpsState\(DEPARTURE_ENTITIES\)/);
  assert.match(route, /getTeacherDepartureCreationCommandResult/);
  assert.match(route, /prepareTeacherDepartureCreation/);
  assert.match(route, /createTeacherDepartureAtomic\(\{ \.\.\.prepared, affectedGroups: atomicAffectedGroups\(prepared\.affectedGroups\), actor \}\)/);
  assert.match(route, /replayRows = await getOpsState\(DEPARTURE_ENTITIES\)/);
  assert.match(route, /saved\[0\]\.applied[\s\S]*committedRowsPayload\([\s\S]*await getOpsState\(DEPARTURE_ENTITIES\)/);
  assert.match(route, /affected_student_ids\.some\(\(studentId\) => !canOperateStudent/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(route, /Cache-Control": "private, no-store"/);

  assert.match(store, /TEACHER_DEPARTURE_CREATION_ATOMIC_RPC = "create_teacher_departure_atomic"/);
  assert.match(store, /TEACHER_DEPARTURE_CREATION_COMMAND_RESULT_RPC = "get_teacher_departure_creation_command_result"/);
  const wrapper = store.slice(store.indexOf("export function createTeacherDepartureAtomic"), store.indexOf("export function submitExamAtomic"));
  for (const field of [
    "p_command_key", "p_command_intent", "p_source_teacher_id", "p_effective_date",
    "p_detail", "p_expected_versions", "p_operations", "p_tasks", "p_affected_groups",
    "p_submitted_at", "p_actor",
  ]) assert.match(wrapper, new RegExp(field));

  const submit = client.slice(client.indexOf("const submitOperation ="), client.indexOf("const submitRenewalFollowUp ="));
  assert.match(submit, /fetch\("\/api\/operations\/departure\/create"/);
  assert.match(submit, /teacher-departure-create:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(submit, /operationsShared\.applyRemote\(body\.operationRow/);
  assert.match(submit, /tasksShared\.applyRemote\(body\.taskRow/);
  assert.doesNotMatch(submit.slice(submit.indexOf('type === "老师离职"'), submit.indexOf("const studentLeave")), /setOperations|setTasks/);

  assert.match(service, /projectTeacherDepartureOccurrences/);
  assert.match(service, /teacher\.subjects as string\[\]\)\.includes\(teacherSubjectId\)/);
  assert.match(service, /teacherAvailableForOccurrence/);
  assert.match(service, /teacherHasConflict/);
  assert.match(service, /newStudentCapacity/);
  assert.match(service, /relationshipAlreadyEstablished/);
  assert.match(service, /replacement_candidate_not_found/);
  assert.match(service, /Complete it before creating another effective date/);
  assert.match(service, /canOperateStudent/);
  assert.match(service, /watchers: \[DEFAULT_TEACHING_CONTROL_WATCHER\]/);
  assert.match(service, /\\u001f/);
});

test("departure SQL locks all five rows in one global order and replays under those locks", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const body = sqlFunction(sql, "public.create_teacher_departure_atomic");
  const locks = ["bookings", "operations", "students", "tasks", "teachers"]
    .map((entity) => body.indexOf(`s.entity = '${entity}' for update`));
  assert.ok(locks.every((offset) => offset > 0));
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
  const replay = body.lastIndexOf("from internal.teacher_departure_creation_commands c");
  assert.ok(replay > locks.at(-1), "ledger replay must be observed after all five row locks");
  assert.ok(body.indexOf("version_conflict") > replay, "lost-response replay precedes OCC failure");
  for (const entity of ["booking", "operation", "student", "task", "teacher"]) {
    assert.match(body, new RegExp(`expected_${entity}_version < 1`));
  }
  assert.match(body, /submitted_at_value < clock_timestamp\(\) - interval '15 minutes'/);
  assert.match(body, /submitted_at_value > clock_timestamp\(\) \+ interval '2 minutes'/);
  assert.doesNotMatch(body, /statement_timeout/);
});

test("locked SQL recomputes occurrence closure and accepts only exact operation/task additions", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const body = sqlFunction(sql, "public.create_teacher_departure_atomic");
  assert.match(body, /internal\.teacher_departure_creation_projection\(\s*booking_state\.payload, student_state\.payload/);
  assert.match(body, /supplied_closure is distinct from expected_closure/);
  assert.match(sqlFunction(sql, "internal.teacher_departure_creation_projection"), /unbounded_teacher_departure_series/);
  assert.match(body, /teacherSubjectId/);
  assert.match(body, /availabilityWindows/);
  assert.match(body, /acceptsStudents/);
  assert.match(body, /newStudentCapacity/);
  assert.match(body, /jsonb_array_length\(item\.value -> 'candidateTeacherIds'\) = 0/);
  assert.match(body, /candidate_already_active/);
  assert.match(body, /candidate_already_assigned/);
  assert.match(body, /item\.value ->> 'teacherId' = p_source_teacher_id[\s\S]*teacher_departure_workflow_already_exists/);
  assert.match(body, /expected_operations := generated_operations \|\| operation_state\.payload/);
  assert.match(body, /expected_tasks := generated_tasks \|\| task_state\.payload/);
  assert.match(body, /p_operations is distinct from expected_operations/);
  assert.match(body, /p_tasks is distinct from expected_tasks/);
  assert.match(body, /insert into public\.ops_mutation_log/);
  assert.match(body, /append_operational_contract_audit\(\s*'operation\.teacher_departure_create', trim\(p_actor\), 'teacher', p_source_teacher_id,/);
  assert.match(body, /insert into internal\.teacher_departure_creation_commands/);
  assert.match(body, /chr\(31\)/);
});

test("departure command ledger and RPCs have explicit secret/RLS/grant boundaries", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table internal\.teacher_departure_creation_commands enable row level security/);
  assert.match(sql, /revoke all on table internal\.teacher_departure_creation_commands from public, anon, authenticated, service_role/);
  for (const name of [
    "public.get_teacher_departure_creation_command_result",
    "public.create_teacher_departure_atomic",
  ]) {
    const body = sqlFunction(sql, name);
    assert.match(body, /internal\.verify_ops_secret\(p_secret\)/);
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = ''/);
    assert.match(body, /prior\.actor <> trim\(p_actor\)/);
  }
  for (const signature of [
    "get_teacher_departure_creation_command_result(text, text, jsonb, text)",
    "create_teacher_departure_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text)",
  ]) {
    const escaped = signature.replace(/[()]/g, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}\\s+from public, anon, authenticated, service_role`, "i"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}\\s+to anon, authenticated`, "i"));
  }
});

test("forward migration is byte-equivalent to the canonical departure suffix", async () => {
  const [forward, canonical] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url), "utf8"),
  ]);
  const startMarker = "-- BEGIN TEACHER DEPARTURE CREATION ATOMIC SUFFIX\n";
  const endMarker = "\n-- END TEACHER DEPARTURE CREATION ATOMIC SUFFIX";
  const start = canonical.indexOf(startMarker);
  const end = canonical.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  assert.equal(canonical.slice(start + startMarker.length, end), forward.trimEnd());
  assert.match(forward, /teacher_departure_creation_fixture_projection_mismatch/);
  assert.match(forward, /TSK-DEPARTURE-33b1857fea16f74280c16518/);
  assert.match(forward, /OPS-DEPARTURE-a7bff281fd38f8e19efe75c7/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../supabase/migrations/20260819101200_teacher_absence_creation_atomic.sql", import.meta.url);
function body(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(start >= 0 && end > start, `${name} missing`);
  return sql.slice(start, end + 4);
}

test("teacher absence route/client use first-operation replay, durable keys, and remote rows", async () => {
  const [route, client, service, store, pending] = await Promise.all([
    readFile(new URL("../app/api/operations/teacher-absence/create/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/teacher-absence-creation-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/teacher-absence-pending.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /getTeacherAbsenceCreationCommandResult/);
  assert.match(route, /createTeacherAbsenceAtomic/);
  const replayIndex = route.indexOf("const replay = await getTeacherAbsenceCreationCommandResult");
  assert.ok(replayIndex >= 0);
  assert.ok(replayIndex < route.indexOf("const rows = await getOpsState(ENTITIES);", replayIndex), "commit replay lookup must be the first database operation before stale OCC preparation");
  assert.ok(replayIndex < route.lastIndexOf("const prepared = prepareTeacherAbsenceCreation"), "commit replay lookup must precede stale OCC preparation");
  assert.match(route, /saved\[0\]\.applied[\s\S]*await getOpsState\(ENTITIES\)/);
  assert.match(route, /operationRow: operationRow \?\? null/);
  assert.match(route, /taskRow: taskRow \?\? null/);
  assert.match(route, /affected_student_ids\.every\(\(studentId\) => canOperateStudent/);
  assert.match(route, /operationIds: scopeAuthorized \? replay\[0\]\.operation_ids : \[\]/);
  assert.match(route, /affectedStudentIds: scopeAuthorized \? saved\[0\]\.affected_student_ids : \[\]/);
  assert.match(route, /preview/);
  assert.match(client, /teacher-absence-create:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(client, /readTeacherAbsencePendingCommands\(directEnrollmentStorage, sessionOperator\)/);
  assert.match(client, /recovered\?\.expectedVersions \?\? currentVersions/);
  assert.match(client, /teacherAbsencePendingDisposition\([\s\S]*status: response\.status/);
  assert.match(client, /pendingDisposition === "clear"\) removePending\(\)/);
  assert.match(client, /共享状态行暂不可用[\s\S]*return;/);
  assert.match(client, /operationsShared\.applyRemote\(body\.operationRow/);
  assert.match(client, /tasksShared\.applyRemote\(body\.taskRow/);
  const atomicBranch = client.slice(client.indexOf('if (type === "老师请假" || type === "请假" || type === "代课")'), client.indexOf("const studentLeave ="));
  assert.match(atomicBranch, /operationHasSourceBooking[\s\S]*absenceEventStart/);
  assert.doesNotMatch(atomicBranch, /setOperations\(|setTasks\(/);
  assert.match(pending, /TEACHER_ABSENCE_PENDING_LIMIT = 8/);
  assert.match(pending, /encodeURIComponent\(actor\.trim\(\)\.toLocaleLowerCase\(\)\)/);
  assert.match(service, /occurrence\.teacherId !== input\.command\.sourceTeacherId/);
  assert.doesNotMatch(service, /if \(booking\.kind === "代课"\) continue/);
  assert.match(service, /historicalLastLessonDate/);
  assert.match(service, /candidate-confirm/);
  assert.match(store, /TEACHER_ABSENCE_CREATION_ATOMIC_RPC = "create_teacher_absence_atomic"/);
});

test("SQL locks the five projections, recomputes closure, preserves confirm-later semantics, and has replay boundaries", async () => {
  const sql = await readFile(migration, "utf8");
  const create = body(sql, "public.create_teacher_absence_atomic");
  for (const entity of ["bookings", "operations", "students", "tasks", "teachers"]) assert.match(create, new RegExp(`s\.entity = '${entity}' for update`));
  assert.match(create, /internal\.teacher_absence_creation_projection/);
  assert.match(create, /supplied is distinct from expected/);
  assert.match(create, /firstAffectedAt/);
  assert.match(create, /internal\.teacher_absence_candidate_ids/);
  assert.match(sql, /internal\.teacher_absence_candidate_eligible/);
  assert.match(create, /historical_due_date/);
  assert.match(create, /generated_tasks \|\| t\.payload/);
  assert.match(create, /p_tasks is distinct from/);
  assert.match(create, /jsonb_build_object\('id', expected_task_id/);
  assert.match(create, /teacher_absence_workflow_already_exists/);
  assert.match(create, /insert into internal\.teacher_absence_creation_commands/);
  const replayLookup = body(sql, "public.get_teacher_absence_creation_command_result");
  assert.match(replayLookup, /prior\.command_intent is distinct from p_command_intent/);
  assert.match(replayLookup, /prior\.actor <> trim\(p_actor\)/);
  assert.match(create, /append_operational_contract_audit\(\s*'operation\.teacher_absence_create'/);
  assert.match(sql, /lesson occurrence status is\s+-- deliberately unchanged until/);
  assert.match(sql, /override_item \? 'teacherId'/);
  assert.match(sql, /repeatCount/);
  assert.match(body(sql, "internal.teacher_absence_candidate_ranges"), /extract\(dow from source_date\)/);
  assert.match(body(sql, "internal.teacher_absence_candidate_ranges"), /excludedDates/);
  assert.match(body(sql, "internal.teacher_absence_candidate_ranges"), /teacher_absence_ava_instant/);
  assert.match(body(sql, "internal.teacher_absence_candidate_eligible"), /teacher_absence_candidate_ranges/);
  assert.match(body(sql, "internal.teacher_absence_candidate_eligible"), /startsAt/);
  assert.match(body(sql, "internal.teacher_absence_candidate_eligible"), /endsAt/);
  assert.doesNotMatch(body(sql, "internal.teacher_absence_creation_projection"), /kind' = '代课'.*continue/);
  assert.doesNotMatch(body(sql, "internal.teacher_absence_candidate_eligible"), /kind' = '代课'.*continue/);
  assert.match(body(sql, "internal.teacher_absence_resolve_occurrence"), /durationMinutes/);
  assert.match(sql, /teacher_absence_source_range_end/);
  assert.match(sql, /teacher_absence_recurrence_interval/);
  assert.match(sql, /recurrenceEndDate/);
  assert.match(sql, /teacher_absence_repeat_count_out_of_range/);
  assert.doesNotMatch(body(sql, "internal.teacher_absence_creation_projection"), /least\(\s*104/);
  assert.match(sql, /jsonb_array_length\(projected #> '\{0,affectedOccurrenceIds\}'\) <> 105/);
  assert.match(sql, /teacher_absence_creation_fixture_substitute_projection_mismatch/);
  assert.match(sql, /teacher_absence_creation_fixture_substitute_conflict_mismatch/);
  for (const name of ["public.get_teacher_absence_creation_command_result", "public.create_teacher_absence_atomic"]) assert.match(body(sql, name), /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(sql, /alter table internal\.teacher_absence_creation_commands enable row level security/);
  assert.match(sql, /teacher_absence_creation_commands_audit_id_idx/);
  assert.match(sql, /revoke all on table internal\.teacher_absence_creation_commands from public, anon, authenticated, service_role/);
});

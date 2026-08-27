import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url);
const projectionMigrationUrl = new URL("../supabase/migrations/20260819101900_booking_trial_projection_atomic.sql", import.meta.url);

test("booking route uses one atomic RPC and never falls back to independent state writes", async () => {
  const route = await readFile(new URL("../app/api/bookings/mutate/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/booking-capacity-service.ts", import.meta.url), "utf8");
  assert.match(route, /parseBookingCapacityCommand/);
  assert.match(route, /prepareBookingCapacityMutation/);
  assert.match(route, /getBookingCapacityCommandResult/);
  assert.ok(route.indexOf("getBookingCapacityCommandResult") < route.indexOf("prepareBookingCapacityMutation({"));
  assert.ok(route.indexOf("getBookingCapacityCommandResult({") < route.indexOf("const rows = await getOpsState"));
  assert.match(route, /getOpsState\(\["bookings", "students", "lpItems", "tasks", "teachers"\]\)/);
  assert.match(route, /mutateBookingCapacityAtomic\(\{ \.\.\.prepared, actorRole: session\.role, actor \}\)/);
  assert.match(route, /studentRow/);
  assert.match(route, /taskRow/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(route, /booking_capacity_contract_unavailable/);
  assert.match(service, /REQUEST_FIELDS/);
  assert.match(service, /BOOKING_FIELDS/);
  assert.match(service, /VERSION_FIELDS = new Set\(\["bookings", "students", "lpItems", "tasks", "teachers"\]\)/);
  assert.doesNotMatch(service, /"teachers"\s*,\s*"students"/);
});

test("forward booking projection contract locks and returns the complete authoritative projection", async () => {
  const sql = await readFile(projectionMigrationUrl, "utf8");
  const start = sql.indexOf("create or replace function public.mutate_booking_projection_atomic");
  const end = sql.indexOf("revoke all on function public.mutate_booking_projection_atomic", start);
  assert.ok(start >= 0 && end > start);
  const body = sql.slice(start, end);
  const locks = [...body.matchAll(/select \* into \w+ from public\.ops_state where entity = '([^']+)' for update;/g)].map((match) => match[1]);
  assert.deepEqual(locks, ["bookings", "students", "lpItems", "tasks", "teachers"]);
  assert.match(body, /p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers'/);
  assert.match(body, /public\.mutate_booking_capacity_atomic\(/);
  assert.match(body, /internal\.rebuild_booking_trial_tasks\(/);
  assert.match(body, /where entity = 'students'/);
  assert.match(body, /where entity = 'tasks'/);
  assert.match(body, /internal\.booking_projection_commands/);
  assert.match(sql, /create or replace function public\.get_booking_projection_command_result/);
  assert.match(sql, /bookings_row public\.ops_state,[\s\S]*students_row public\.ops_state,[\s\S]*tasks_row public\.ops_state,[\s\S]*teachers_row public\.ops_state/);
  assert.match(body, /p_command_intent ->> 'action' = 'cancel_occurrence' and p_action = 'update'/);
  assert.match(body, /p_command_intent ->> 'action' = 'update_occurrence' and p_action = 'update'/);
  assert.match(body, /internal\.booking_projection_has_active_relationship/);
  assert.match(body, /array\[previous_student, p_student_id\]/);
  assert.match(body, /teacher_id, previous_teacher_id/);

  const replayStart = sql.indexOf("create or replace function public.get_booking_projection_command_result");
  const replayEnd = sql.indexOf("revoke all on function public.get_booking_projection_command_result", replayStart);
  const replayBody = sql.slice(replayStart, replayEnd);
  assert.doesNotMatch(replayBody, /select \* into \w+ from public\.ops_state where entity = '[^']+' for share;/);
  assert.match(replayBody, /with desired\(entity, lock_order\) as \([\s\S]*'bookings'::text, 1[\s\S]*'students'::text, 2[\s\S]*'lpItems'::text, 3[\s\S]*'tasks'::text, 4[\s\S]*'teachers'::text, 5/);
  assert.match(replayBody, /ordered_locks as materialized \([\s\S]*order by desired\.lock_order\s+for share of state/);
  assert.match(replayBody, /stable_snapshot as materialized \([\s\S]*array_agg\(state order by desired\.lock_order\)/);
  assert.equal(replayBody.match(/for share of state/g)?.length, 1);
  assert.match(replayBody, /cardinality\(receipt_rows\) <> 5/);
  assert.match(replayBody, /booking_projection_replay_version_regressed/);
  assert.match(replayBody, /prior\.actor_role/);
  assert.match(replayBody, /prior\.teacher_id/);
  assert.match(sql, /coalesce\(occurrence_override ->> 'status', 'confirmed'\) in \('cancelled', 'leave'\)/);
});

test("teacher replay is bound to the original role and authoritative teacher identities", async () => {
  const route = await readFile(new URL("../app/api/bookings/mutate/route.ts", import.meta.url), "utf8");
  assert.match(route, /bookingCapacityTeacherReplayAllowed\(\{/);
  assert.match(route, /ledgerActorRole: replay\[0\]\.actor_role/);
  assert.match(route, /allowedTeacherIds: replayAccess\.teacherIds/);
  assert.match(route, /teacherId: replay\[0\]\.teacher_id/);
  assert.match(route, /previousTeacherId: replay\[0\]\.previous_teacher_id/);
});

test("browser-derived projection payloads are rejected and never reach the projection RPC", async () => {
  const service = await readFile(new URL("../lib/booking-capacity-service.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /REQUEST_FIELDS[^\n]*students|REQUEST_FIELDS[^\n]*tasks/);
  const wrapper = store.slice(store.indexOf("export function mutateBookingCapacityAtomic"), store.indexOf("export function confirmOperationOccurrencesAtomic"));
  assert.doesNotMatch(wrapper, /p_students|p_tasks/);
  assert.match(wrapper, /p_actor_role/);
});

test("database contract locks versions and writes bookings plus teachers transactionally", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const start = sql.indexOf("create or replace function public.mutate_booking_capacity_atomic");
  const end = sql.indexOf("revoke all on function public.mutate_booking_capacity_atomic", start);
  assert.ok(start >= 0 && end > start);
  const body = sql.slice(start, end);
  assert.match(body, /where s\.entity = 'bookings' for update/);
  assert.match(body, /where s\.entity = 'students' for update/);
  assert.match(body, /where s\.entity = 'teachers' for update/);
  assert.match(body, /p_expected_versions - 'bookings' - 'students' - 'teachers' <> '\{\}'::jsonb/);
  assert.match(body, /expected_booking_version is null or expected_booking_version < 1/);
  assert.match(body, /expected_student_version is null or expected_student_version < 1/);
  assert.match(body, /expected_teacher_version is null or expected_teacher_version < 1/);
  assert.match(body, /booking_state\.version is distinct from expected_booking_version/);
  assert.match(body, /student_state\.version is distinct from expected_student_version/);
  assert.match(body, /teacher_state\.version is distinct from expected_teacher_version/);
  assert.match(body, /unrelated_booking_changed/);
  assert.match(body, /unrelated_teacher_changed/);
  assert.match(body, /target_student :=[\s\S]*student_state\.payload/);
  assert.match(body, /current_student :=[\s\S]*current_booking ->> 'studentId'/);
  assert.match(body, /archived_student_booking_read_only/);
  assert.ok(body.indexOf("for update") < body.indexOf("archived_student_booking_read_only"));
  assert.ok(body.indexOf("archived_student_booking_read_only") < body.indexOf("if prior.command_key is not null then"));
  assert.match(body, /update public\.ops_state s set[\s\S]*where s\.entity = 'bookings'/);
  assert.match(body, /update public\.ops_state s set[\s\S]*where s\.entity = 'teachers'/);
  assert.match(body, /append_operational_contract_audit/);
  assert.match(body, /internal\.booking_capacity_commands/);
  assert.match(body, /prior\.command_intent is distinct from p_command_intent/);
  assert.match(body, /p_command_intent ->> 'action' = 'upsert' and p_action in \('create', 'update'\)/);
  assert.match(body, /p_command_intent ->> 'action' = 'delete' and p_action = 'delete'/);
  assert.doesNotMatch(body.slice(body.indexOf("if prior.command_key is not null then"), body.indexOf("if booking_state.version is distinct from expected_booking_version")), /prior\.booking_version/);
});

test("database exposes a secret-only stable-intent replay lookup", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.get_booking_capacity_command_result\(/);
  assert.match(sql, /prior\.command_intent is distinct from p_command_intent/);
  assert.match(sql, /prior\.actor <> left\(trim\(p_actor\), 120\)/);
  assert.match(sql, /revoke all on function public\.get_booking_capacity_command_result/);
});

test("database booking function remains secret-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /if not internal\.verify_ops_secret\(p_secret\)/);
  assert.match(sql, /revoke all on function public\.mutate_booking_capacity_atomic[\s\S]*from public, anon, authenticated/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url);

test("booking route uses one atomic RPC and never falls back to independent state writes", async () => {
  const route = await readFile(new URL("../app/api/bookings/mutate/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/booking-capacity-service.ts", import.meta.url), "utf8");
  assert.match(route, /parseBookingCapacityCommand/);
  assert.match(route, /prepareBookingCapacityMutation/);
  assert.match(route, /getBookingCapacityCommandResult/);
  assert.ok(route.indexOf("getBookingCapacityCommandResult") < route.indexOf("prepareBookingCapacityMutation({"));
  assert.match(route, /mutateBookingCapacityAtomic\(\{ \.\.\.prepared, actor \}\)/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(route, /booking_capacity_contract_unavailable/);
  assert.match(service, /REQUEST_FIELDS/);
  assert.match(service, /BOOKING_FIELDS/);
  assert.doesNotMatch(service, /"teachers"\s*,\s*"students"/);
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
  assert.match(body, /booking_state\.version <> expected_booking_version/);
  assert.match(body, /student_state\.version <> expected_student_version/);
  assert.match(body, /teacher_state\.version <> expected_teacher_version/);
  assert.match(body, /unrelated_booking_changed/);
  assert.match(body, /unrelated_teacher_changed/);
  assert.match(body, /update public\.ops_state s set[\s\S]*where s\.entity = 'bookings'/);
  assert.match(body, /update public\.ops_state s set[\s\S]*where s\.entity = 'teachers'/);
  assert.match(body, /append_operational_contract_audit/);
  assert.match(body, /internal\.booking_capacity_commands/);
  assert.match(body, /prior\.command_intent is distinct from p_command_intent/);
  assert.match(body, /p_command_intent ->> 'action' = 'upsert' and p_action in \('create', 'update'\)/);
  assert.match(body, /p_command_intent ->> 'action' = 'delete' and p_action = 'delete'/);
  assert.doesNotMatch(body.slice(body.indexOf("if prior.command_key is not null then"), body.indexOf("if booking_state.version <> expected_booking_version")), /prior\.booking_version/);
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

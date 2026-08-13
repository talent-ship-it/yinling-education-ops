import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("operation confirmation stays behind one reviewed atomic RPC", async () => {
  const [sql, route, client] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/confirm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sql, /create or replace function public\.confirm_operation_occurrences_atomic\(/i);
  assert.match(sql, /for update[\s\S]*entity = 'operations' for update[\s\S]*entity = 'teachers' for update/i);
  assert.match(sql, /unrelated_booking_override_changed/);
  assert.match(
    sql,
    /p_action = 'leave'[\s\S]*new_override - 'occurrenceId' - 'status'[\s\S]*old_override - 'occurrenceId' - 'status'/,
  );
  assert.match(
    sql,
    /p_action = 'substitute'[\s\S]*new_override - 'occurrenceId' - 'status' - 'teacherId'[\s\S]*old_override - 'occurrenceId' - 'status' - 'teacherId'/,
  );
  assert.match(sql, /revoke all on function public\.confirm_operation_occurrences_atomic/);
  assert.match(sql, /grant execute on function public\.confirm_operation_occurrences_atomic/);
  assert.match(route, /prepareOperationConfirmation/);
  assert.match(route, /getOperationConfirmationCommandResult/);
  assert.ok(route.indexOf("getOperationConfirmationCommandResult") < route.indexOf("prepareOperationConfirmation({"));
  assert.match(route, /confirmOperationOccurrencesAtomic/);
  assert.match(client, /fetch\("\/api\/operations\/confirm"/);
  assert.match(client, /bookingsShared\.applyRemote\(body\.bookingRow/);
  assert.match(client, /operationsShared\.applyRemote\(body\.operationRow/);
  const finalConfirm = client.slice(client.indexOf('title: "确认异常处理已完成"'), client.indexOf("const renderRenewals"));
  assert.doesNotMatch(finalConfirm, /setBookings\(/);
  assert.doesNotMatch(finalConfirm, /setOperations\(/);
  assert.match(sql, /create or replace function public\.get_operation_confirmation_command_result\(/);
  assert.match(sql, /prior\.command_intent is distinct from p_command_intent/);
  const replayBranch = sql.slice(
    sql.indexOf("if prior.command_key is not null then", sql.indexOf("create or replace function public.confirm_operation_occurrences_atomic")),
    sql.indexOf("if booking_state.version <> expected_booking_version", sql.indexOf("create or replace function public.confirm_operation_occurrences_atomic")),
  );
  assert.doesNotMatch(replayBranch, /prior\.booking_version|prior\.operation_version/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, store, route] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819100400_read_jiaowubao_operations_readiness.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL(
    "../app/api/jiaowubao-direct-import/operations-readiness/route.ts",
    import.meta.url,
  ), "utf8"),
]);

function functionBody(name) {
  return migration.match(new RegExp(
    `create or replace function public\\.${name}[\\s\\S]*?\\$${name}\\$;`,
    "i",
  ))?.[0] ?? "";
}

test("operations readiness is one secret-gated, latest-complete, bounded reader", () => {
  const body = functionBody("get_jiaowubao_direct_operations_readiness");
  assert.match(body, /not internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(body, /run_state\.state = 'complete'/i);
  assert.match(body, /p_window_end - p_window_start > interval '63 days'/i);
  assert.match(body, /p_schedule_limit not between 1 and 250/i);
  assert.match(body, /p_leave_makeup_limit not between 1 and 250/i);
  assert.match(body, /p_renewal_limit not between 1 and 250/i);
  assert.match(body, /limit p_schedule_limit \+ 1/i);
  assert.match(body, /limit p_leave_makeup_limit \+ 1/i);
  assert.match(body, /limit p_renewal_limit \+ 1/i);
  assert.match(body, /'runToken', saved_run\.id::text/i);
  assert.match(body, /'windowEvents'/i);
  assert.doesNotMatch(body, /'futureEvents'/i);
  assert.match(body, /to_char\(p_window_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/i);
  assert.match(body, /to_char\(page\.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /revoke all on function public\.get_jiaowubao_direct_operations_readiness/i);
  assert.match(migration, /grant execute on function public\.get_jiaowubao_direct_operations_readiness/i);
});

test("schedule queue distinguishes mapping evidence from valid AVA blockers", () => {
  const body = functionBody("get_jiaowubao_direct_operations_readiness");
  assert.match(body, /schedule_event\.time_parse_status = 'parsed'/i);
  assert.match(body, /schedule_event\.teacher_resolution <> 'exact_name'/i);
  assert.match(body, /schedule_event\.subject_resolution <> 'exact_name'/i);
  assert.match(body, /schedule_event\.availability_effect = 'blocks_teacher_ava'/i);
  assert.match(body, /schedule_event\.time_parse_status = 'invalid_time'/i);
  assert.match(body, /'attachedParticipantCount'/i);
  assert.match(body, /participant\.resolution_state = 'attached'/i);
});

test("leave/makeup and renewal queues are attached source evidence, never automatic work", () => {
  const body = functionBody("get_jiaowubao_direct_operations_readiness");
  assert.match(body, /incident\.resolution_state = 'attached'/i);
  assert.match(body, /supplemental_record\.resolution_state = 'attached'/i);
  assert.match(body, /supplemental_record\.record_kind in \('contract', 'hour_balance'\)/i);
  assert.match(body, /'hasContractEvidence'/i);
  assert.match(body, /'hasHourBalanceEvidence'/i);
  assert.doesNotMatch(body, /insert into public\.ops_state/i);
  assert.doesNotMatch(body, /update public\.ops_state/i);
  assert.doesNotMatch(body, /delete from public\.ops_state/i);
  assert.doesNotMatch(body, /create or replace function public\.put_/i);
  assert.doesNotMatch(body, /dueat/i);
});

test("the curated DTO omits source identifiers, names, phones, coordinates, and payloads", () => {
  const body = functionBody("get_jiaowubao_direct_operations_readiness");
  for (const forbiddenOutputKey of [
    "sourceKey",
    "sourceWorkbook",
    "sourceRow",
    "sourceCell",
    "sourcePayload",
    "evidencePhone",
    "evidenceName",
    "masterSourceRow",
    "quarantineReason",
  ]) {
    assert.doesNotMatch(body, new RegExp(`'${forbiddenOutputKey}'`, "i"));
  }
  assert.doesNotMatch(body, /evidence_phone/i);
  assert.doesNotMatch(body, /evidence_name/i);
  assert.match(body, /'teacherLabel'/i);
  assert.match(route, /!access\.fullAdmin && !access\.limitedAdmin/i);
});

test("only the server route fixes queue limits and sends the secret-gated RPC", () => {
  assert.match(store, /import "server-only"/i);
  assert.match(store, /JIAOWUBAO_DIRECT_OPERATIONS_READINESS_RPC/i);
  assert.match(store, /p_schedule_limit: input\.scheduleLimit/i);
  assert.match(store, /p_leave_makeup_limit: input\.leaveMakeupLimit/i);
  assert.match(store, /p_renewal_limit: input\.renewalLimit/i);
  assert.match(route, /READINESS_SCHEDULE_LIMIT = 120/i);
  assert.match(route, /READINESS_LEAVE_MAKEUP_LIMIT = 120/i);
  assert.match(route, /READINESS_RENEWAL_LIMIT = 160/i);
  assert.match(route, /MAX_READINESS_WINDOW_MS = 63 \* 24 \* 60 \* 60 \* 1_000/i);
  assert.match(route, /windowStart: windowStart\.value/i);
  assert.match(route, /windowEnd: windowEnd\.value/i);
  assert.match(route, /Cache-Control": "private, no-store"/i);
  assert.doesNotMatch(route, /request\.json/i);
});

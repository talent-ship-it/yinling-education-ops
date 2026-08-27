import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("temporary classrooms keep the provider-first atomic saga boundary", async () => {
  const [route, migration, hardening, client, bbb, store, displayPreferences] = await Promise.all([
    read("../app/api/classroom/temporary/route.ts"),
    read("../supabase/migrations/20260824000300_temporary_classroom_atomic.sql"),
    read("../supabase/migrations/20260824000500_harden_temporary_classroom_identity.sql"),
    read("../app/operations-client.tsx"),
    read("../lib/bigbluebutton.ts"),
    read("../lib/ops-store.ts"),
    read("../lib/display-preferences.ts"),
  ]);

  assert.match(route, /DEMO_LIMITED_ADMIN_USER/);
  assert.match(route, /session\.role === "limited-admin"/);
  assert.match(route, /upsert_bind_classroom/);
  assert.match(route, /createMeeting\(/);
  assert.match(route, /mutateBookingCapacityAtomic\(/);
  assert.match(route, /getBookingCapacityCommandResult\(/);
  assert.match(route, /getTemporaryClassroomCapability\(/);
  assert.match(route, /claimTemporaryClassroomRequest\(/);
  assert.match(route, /temporary-booking:\$\{session\.user\}:\$\{requestKey\}/);
  assert.match(route, /temporary-test:\$\{session\.user\}:\$\{requestKey\}/);
  assert.match(route, /temporaryCommandKey\(session\.user, requestKey\)/);
  assert.match(route, /const requestKey = text\(body\.requestKey\)/);
  assert.doesNotMatch(route, /body\.requestKey\) \|\|/);
  assert.match(route, /displayTimezoneOptions/);
  assert.match(route, /SUPPORTED_TIMEZONES\.has\(timezone\)/);
  assert.match(route, /const timezone = text\(body\.timezone\)/);
  assert.match(route, /const date = text\(body\.date\)/);
  assert.match(route, /const start = text\(body\.start\)/);
  assert.doesNotMatch(route, /text\(body\.date\) \|\|/);
  assert.doesNotMatch(route, /text\(body\.start\) \|\|/);
  assert.match(route, /export const maxDuration = 90/);
  assert.match(route, /TEMPORARY_CLASSROOM_RPC_TIMEOUT_MS = 10_000/);
  assert.match(route, /temporaryClassroomRpcOptions/);
  assert.match(route, /getTemporaryClassroomCapability\(temporaryClassroomRpcOptions\)/);
  assert.match(route, /claimTemporaryClassroomRequest\([\s\S]*?temporaryClassroomRpcOptions\)/);
  assert.match(route, /getBookingCapacityCommandResult\([\s\S]*?temporaryClassroomRpcOptions/);
  assert.match(route, /getOpsState\([\s\S]*?temporaryClassroomRpcOptions/);
  assert.match(route, /mutateBookingCapacityAtomic\([\s\S]*?temporaryClassroomRpcOptions/);
  assert.match(route, /five sequential RPC boundaries/);
  assert.match(route, /65s/);
  assert.ok(route.indexOf("await createMeeting(") < route.indexOf("await mutateBookingCapacityAtomic("));
  assert.ok(route.indexOf("await getTemporaryClassroomCapability(") < route.indexOf("await createMeeting("));
  assert.ok(route.indexOf("await claimTemporaryClassroomRequest(") < route.indexOf("await createMeeting("));
  assert.ok(route.indexOf("await getBookingCapacityCommandResult(") < route.indexOf("await getOpsState("));
  assert.match(route, /if \(!hasRecordDetails\)/);
  assert.doesNotMatch(route, /randomUUID/);

  assert.match(migration, /upsert_bind_classroom/);
  assert.match(migration, /temporary_classroom_projection_missing/);
  assert.match(migration, /internal\.booking_projection_commands/);
  assert.match(migration, /mutate_booking_projection_atomic/);
  assert.match(migration, /extensions\.digest\(p_command_intent ->> 'occurrenceId', 'sha256'\)/);

  assert.match(hardening, /temporary_classroom_requests/);
  assert.match(hardening, /temporary_classroom_request_conflict/);
  assert.match(hardening, /get_temporary_classroom_capability/);
  assert.match(hardening, /booking_projection_occurrence_exists/);
  assert.match(hardening, /source_date.*target_date/s);
  const expectedTimezones = [
    "Australia/Melbourne",
    "Australia/Adelaide",
    "Australia/Sydney",
    "Australia/Canberra",
    "Australia/Hobart",
    "Australia/Brisbane",
    "Australia/Perth",
    "Pacific/Auckland",
    "Asia/Shanghai",
    "America/Argentina/Buenos_Aires",
    "Europe/Sarajevo",
  ];
  const displayTimezones = [...displayPreferences.matchAll(/\{ id: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(displayTimezones, expectedTimezones, "display timezone allowlist changed unexpectedly");
  const timezoneGuard = hardening.match(/or p_intent ->> 'timezone'\s+not in\s*\(([\s\S]*?)\)/i);
  assert.ok(timezoneGuard, "SQL must validate temporary-classroom timezone against an explicit allowlist");
  const sqlTimezones = [...timezoneGuard[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(sqlTimezones, displayTimezones, "SQL timezone allowlist must stay in exact parity with display preferences");
  assert.doesNotMatch(hardening, /p_intent ->> 'timezone'\s*<>\s*'Australia\/Melbourne'/i);
  assert.match(hardening, /set statement_timeout = '5s'/);
  assert.match(hardening, /set statement_timeout = '15s'/);
  assert.match(hardening, /booking_occurrence_not_found/);

  assert.match(client, /temporaryClassroomRequestKeyRef/);
  assert.match(client, /readTemporaryClassroomPending/);
  assert.match(client, /writeTemporaryClassroomPending/);
  assert.match(client, /normalizeTemporaryClassroomIntent/);
  assert.match(client, /clearTemporaryClassroomPending\(sessionOperator, requestIntent/);
  assert.doesNotMatch(client.slice(client.indexOf("立即开临时课堂"), client.indexOf("setModal(\"temporaryClassroom\")")), /temporaryClassroomRequestKeyRef\.current = null/);
  assert.match(client, /const recordedPayload: TemporaryClassroomRecordedPayload/);
  assert.match(client, /recordedPayload\.start/);
  assert.match(client, /classroomFetch\(/);
  assert.match(client, /CLASSROOM_CLIENT_TIMEOUT_MS = 80_000/);
  assert.match(client, /five RPC boundaries/);
  assert.doesNotMatch(client, /temporaryClassroomRequest\(\)/);

  assert.match(bbb, /AbortController/);
  assert.match(bbb, /BBB_REQUEST_TIMEOUT_MS/);
  assert.match(bbb, /"timeout"/);
  assert.match(store, /OPS_RPC_TIMEOUT_MS/);
  assert.match(store, /OPS_RPC_TIMEOUT_MS = 15_000/);
  assert.match(store, /OpsRpcOptions/);
  assert.match(store, /getOpsState\(entities\?: string\[\], options: OpsRpcOptions/);
  assert.match(store, /getBookingCapacityCommandResult\([\s\S]*?options: OpsRpcOptions/);
  assert.match(store, /getTemporaryClassroomCapability\(options: OpsRpcOptions/);
  assert.match(store, /claimTemporaryClassroomRequest\([\s\S]*?options: OpsRpcOptions/);
  assert.match(store, /mutateBookingCapacityAtomic\([\s\S]*?options: OpsRpcOptions/);
  assert.match(store, /AbortController/);
  assert.match(store, /TEMPORARY_CLASSROOM_CAPABILITY_RPC/);
});

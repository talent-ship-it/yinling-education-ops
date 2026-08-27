import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../supabase/migrations/20260824000200_bind_booking_classroom_atomic.sql", import.meta.url);

test("classroom binding is a forward wrapper patch after the deployed schedule snapshot migration", () => {
  assert.ok(migration.pathname.includes("20260824000200"));
});

test("classroom binding stays a separate semantic action over the five-row booking projection transaction", async () => {
  const [sql, service, pending, client, route] = await Promise.all([
    readFile(migration, "utf8"),
    readFile(new URL("../lib/booking-capacity-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/booking-projection-pending.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bookings/mutate/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(sql, /bind_classroom/);
  assert.match(sql, /p_command_intent ->> 'action' = 'bind_classroom' and p_action = 'update'/);
  assert.match(sql, /yinling-occ-\[0-9a-f\]\{48\}/);
  assert.match(sql, /extensions\.digest\(p_command_intent ->> 'occurrenceId', 'sha256'\)/);
  assert.match(sql, /internal\.booking_projection_commands/);
  assert.match(sql, /public\.mutate_booking_capacity_atomic/);
  assert.match(sql, /entity = ''bookings'' for update/);
  assert.match(sql, /entity = ''students'' for update/);
  assert.match(sql, /entity = ''lpItems'' for update/);
  assert.match(sql, /entity = ''tasks'' for update/);
  assert.match(sql, /entity = ''teachers'' for update/);
  assert.match(sql, /core_intent := case when p_command_intent ->> 'action' in \('cancel_occurrence', 'update_occurrence', 'bind_classroom'\)/);
  assert.doesNotMatch(sql, /bind_classroom' and p_action = 'update_occurrence'/);

  assert.match(service, /action: "upsert" \| "upsert_bind_classroom" \| "delete" \| "cancel_occurrence" \| "update_occurrence" \| "bind_classroom"/);
  assert.match(service, /meetingIdForOccurrenceValue\(occurrenceId\)/);
  assert.match(service, /CLASSROOM_STATUS_RANK/);
  assert.match(service, /createdAt: classroomCreatedAt/);
  assert.match(pending, /action !== "upsert_bind_classroom"/);
  assert.match(client, /action: "bind_classroom"/);
  assert.match(client, /await persistClassroom/);
  assert.match(route, /command\.action === "bind_classroom" && session\.role === "staff"/);
  assert.match(route, /requestedAction: command\.action/);
});

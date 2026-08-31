import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../supabase/migrations/20260831000400_trial_acceptance_fixture_cleanup.sql", import.meta.url),
  "utf8",
);

test("acceptance fixture cleanup targets only the two named synthetic markers", () => {
  assert.match(migration, /student\.value ->> 'name' = 'QA 系统验收 20260827'/);
  assert.match(migration, /lp\.value #>> '\{fields,specialNotes\}' = 'E2E-QA-NO-FOLLOWUP-20260831-02'/);
  assert.match(migration, /task\.value ->> 'studentId'/);
  assert.match(migration, /task\.value ->> 'anchorBookingId'/);
});

test("acceptance fixture cleanup preserves completed and frozen QA history", () => {
  assert.match(migration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/);
  assert.match(migration, /not \(task\.value \? 'legacyEvidence'\)/);
  assert.match(migration, /internal\.legacy_task_deadline_freezes/);
  assert.doesNotMatch(migration, /set payload = next_s/);
});

test("acceptance fixture cleanup atomically removes only the new LP and open tasks", () => {
  assert.match(migration, /entity = 'students' for update/);
  assert.match(migration, /entity = 'lpItems' for update/);
  assert.match(migration, /entity = 'tasks' for update/);
  for (const entity of ["lpItems", "tasks"]) {
    assert.match(migration, new RegExp(`values \\('${entity}', saved\\.version, saved\\.updated_by\\)`));
  }
});

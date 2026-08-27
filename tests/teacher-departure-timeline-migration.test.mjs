import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819101100_teacher_departure_timeline_tasks.sql",
    import.meta.url,
  ),
  "utf8",
);

test("departure timeline SQL clears explicit null teacher/student overrides", () => {
  assert.match(migration, /case when override\.value \? 'teacherId'[\s\S]*jsonb_typeof\(override\.value -> 'teacherId'\) = 'string'[\s\S]*else null end[\s\S]*else nullif\(trim\(source\.booking ->> 'teacherId'\), ''\) end as teacher_id/);
  assert.match(migration, /case when override\.value \? 'studentId'[\s\S]*jsonb_typeof\(override\.value -> 'studentId'\) = 'string'[\s\S]*else null end[\s\S]*else nullif\(trim\(source\.booking ->> 'studentId'\), ''\) end as student_id/);
  assert.doesNotMatch(migration, /coalesce\(override\.value ->> 'teacherId', source\.booking ->> 'teacherId'\)/);
  assert.doesNotMatch(migration, /coalesce\(override\.value ->> 'studentId', source\.booking ->> 'studentId'\)/);
});

test("departure timeline SQL preserves fractional duration precision", () => {
  assert.match(migration, /then \(override\.value ->> 'durationMinutes'\)::numeric/);
  assert.match(migration, /else \(source\.booking ->> 'duration'\)::numeric end as duration_minutes/);
  assert.doesNotMatch(migration, /durationMinutes'\)::integer/);
  assert.doesNotMatch(migration, /duration'\)::integer/);
});

test("departure timeline still keeps the atomic RPC rewrite and security boundary", () => {
  assert.match(migration, /create or replace function internal\.teacher_departure_creation_tasks_v2/);
  assert.match(migration, /language plpgsql\s+security definer\s+set search_path = ''/);
  assert.match(migration, /revoke all on function internal\.teacher_departure_creation_tasks_v2/);
  assert.match(migration, /pg_get_functiondef\(p\.oid\)/);
  assert.match(migration, /internal\.teacher_departure_creation_tasks_v2\(p_command_key, operation_id, student_id, student_item ->> ''owner'', p_source_teacher_id, booking_state\.payload, p_effective_date::date, submitted_at_value\)/);
});

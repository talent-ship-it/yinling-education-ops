import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20260819101400_support_booking_recurrence_intervals.sql", import.meta.url), "utf8");
const fixture = await readFile(new URL("sql/booking-recurrence-intervals-contract.sql", import.meta.url), "utf8");

test("recurrence migration is a forward function patch with fail-closed bounds", () => {
  assert.match(sql, /create or replace function internal\.booking_recurrence_interval_days/);
  assert.match(sql, /create or replace function internal\.booking_recurrence_repeat_count/);
  assert.match(sql, /create or replace function internal\.booking_recurrence_end_date/);
  assert.match(sql, /create or replace function internal\.booking_recurrence_source_end_date/);
  assert.match(sql, /create or replace function internal\.booking_recurrence_occurrence_count/);
  assert.match(sql, /recurrenceIntervalDays/);
  assert.match(sql, /recurrenceEndDate/);
  assert.match(sql, /between 1 and 365/);
  assert.match(sql, /Legacy recurring=true rows were weekly/);
  assert.match(sql, /assert_jiaowubao_direct_booking_interval_available/);
  assert.match(sql, /end_date_occurrence_limit constant integer := 366/);
  assert.match(sql, /booking_recurrence_repeat_count_required/);
  assert.match(sql, /booking_recurrence_end_date_too_far/);
  assert.match(sql, /occurrence_count := 104/);
  assert.doesNotMatch(sql, /patched_definition = replace\(\s*source_definition,\s*'occurrence_date/);
  assert.match(sql, /permanent_teacher_replacement_occurrence_projection/);
  assert.match(sql, /complete_lesson_occurrence_atomic/);
  assert.match(sql, /mutate_booking_capacity_atomic/);
  assert.match(sql, /booking_recurrence_source_end_date\(booking\)/);
  assert.match(sql, /teacher_departure_creation_tasks_v2/);
  assert.match(sql, /booking_recurrence_legacy_frequency_requires_bounds/);
  assert.match(sql, /booking_recurrence_interval_required/);
  assert.doesNotMatch(sql, /^\s*create\s+table/im);
  assert.match(sql, /revoke all on function internal\.booking_recurrence_interval_days/);
  assert.match(fixture, /20260819101400_support_booking_recurrence_intervals\.sql/);
  assert.match(fixture, /booking_recurrence_legacy_interval_fixture_failed/);
  assert.match(fixture, /booking_recurrence_invalid_end_fixture_did_not_reject/);
  assert.match(fixture, /booking_recurrence_occurrence_count_fixture_failed/);
  assert.match(fixture, /jiaowubao_legacy_weekly_fixture_failed/);
  assert.match(fixture, /jiaowubao_nonweekly_unbounded_fixture_did_not_reject/);
});

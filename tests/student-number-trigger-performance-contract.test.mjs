import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL("../supabase/migrations/20260827000500_optimize_manual_student_number_trigger.sql", import.meta.url),
  "utf8",
);

test("manual student-number allocation keeps its safety boundary while removing per-row registry scans", () => {
  assert.match(sql, /pg_get_functiondef\([\s\S]*internal\.assign_new_student_numbers\(\)/i);
  assert.match(sql, /assign_new_student_numbers_predecessor_mismatch/i);
  assert.match(sql, /reservation_maps_set_based_v1/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /jsonb_object_agg\([\s\S]*reservation\.student_id/i);
  assert.match(sql, /jsonb_object_agg\([\s\S]*reservation\.student_number/i);
  assert.match(sql, /row_number\(\)\s+over/i);
  assert.match(sql, /jsonb_agg\([\s\S]*order by student\.ordinal/i);
  assert.match(sql, /insert into internal\.student_number_reservations\(student_number, student_id\)[\s\S]*select[\s\S]*on conflict do nothing/i);
  assert.match(sql, /number_reservation\.student_id is distinct from student\.value ->> 'id'/i);
  assert.match(sql, /student_reservation\.student_number is distinct from student\.value ->> 'studentNumber'/i);
});

test("manual student-number allocation preserves the existing validation failures", () => {
  for (const failure of [
    "students_payload_must_be_array",
    "previous_students_payload_must_be_array",
    "student_number_reservation_invalid",
    "previous_student_payload_item_or_id_invalid",
    "previous_duplicate_student_id",
    "student_payload_item_or_id_invalid",
    "duplicate_student_id",
    "student_number_server_assigned",
    "previous_student_number_invalid",
    "student_number_immutable",
    "student_number_invalid",
    "student_number_reserved_identity",
    "duplicate_student_number",
    "student_number_daily_sequence_exhausted",
    "student_number_reservation_conflict",
  ]) {
    assert.match(sql, new RegExp(failure));
  }
  assert.match(sql, /set local lock_timeout\s*=\s*'1s'/i);
  assert.match(sql, /assign_new_student_numbers_patch_verification_failed/i);
});

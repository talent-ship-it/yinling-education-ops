import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260915000100_wecom_bot_student_field_backfill.sql",
  import.meta.url,
), "utf8");

test("backfills only untouched pending bot records using the explicit 【学生】 label", () => {
  assert.match(migration, /【学生】\|学生/u);
  assert.match(migration, /archive\.match_status = 'pending'/i);
  assert.match(migration, /archive\.student_id is null/i);
  assert.match(migration, /archive\.projected_at is null/i);
  assert.match(migration, /archive\.student_name_hint is null/i);
  assert.match(migration, /count\(distinct candidate_lines\.student_name_hint\) = 1/i);
  assert.match(migration, /internal\.auto_match_wecom_archive_message\(/i);
});

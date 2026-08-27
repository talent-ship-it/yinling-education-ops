import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity.sql",
    import.meta.url,
  ),
  "utf8",
);
const originalMigration = await readFile(
  new URL(
    "../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql",
    import.meta.url,
  ),
  "utf8",
);

const extractStageFunction = (sql) => sql.match(
  /create or replace function internal\.stage_jiaowubao_direct_import_chunk\([\s\S]*?\$stage_jiaowubao_direct_import_chunk\$;/i,
)?.[0] ?? "";

const functionBody = extractStageFunction(migration);

test("the forward migration replaces the complete private stage function without changing its boundary", () => {
  assert.match(
    functionBody,
    /create or replace function internal\.stage_jiaowubao_direct_import_chunk\(\s*p_run_id uuid,\s*p_chunk jsonb,\s*p_projection jsonb,\s*p_actor text\s*\)/i,
  );
  assert.match(functionBody, /returns jsonb\s+language plpgsql\s+security invoker\s+set search_path = ''/i);
  assert.match(functionBody, /jiaowubao_direct_import\.chunk_staged/i);
  assert.match(functionBody, /insert into internal\.jiaowubao_direct_supplemental_records/i);
  assert.match(functionBody, /insert into internal\.jiaowubao_direct_schedule_events/i);
  assert.match(functionBody, /insert into internal\.jiaowubao_direct_schedule_event_participants/i);
  assert.match(functionBody, /insert into internal\.jiaowubao_direct_leave_makeup_events/i);
  assert.match(
    migration,
    /revoke all on function internal\.stage_jiaowubao_direct_import_chunk\(uuid, jsonb, jsonb, text\)\s+from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(migration, /\b(?:grant|security definer)\b/i);
});

test("every SQL row alias that collided with a PL/pgSQL local has a distinct name", () => {
  assert.match(functionBody, /supplemental_loop_row\.value/i);
  assert.match(functionBody, /schedule_loop_row\.value/i);
  assert.match(functionBody, /leave_makeup_loop_row\.value/i);
  assert.match(functionBody, /supplemental_projection_row\.value/i);
  assert.match(functionBody, /schedule_projection_row\.value/i);
  assert.match(functionBody, /leave_makeup_projection_row\.value/i);
  assert.match(functionBody, /schedule_count_row\.value/i);
  assert.match(functionBody, /raw_records raw_record_row/i);
  assert.match(functionBody, /schedule_event_participants participant_row/i);
  assert.match(functionBody, /source_name_row\.value/i);

  assert.doesNotMatch(functionBody, /jsonb_array_elements\([^\n]*\)\s+item\(value\)/i);
  assert.doesNotMatch(functionBody, /\b(?:from|join)\s+raw_records\s+raw_record\b/i);
  assert.doesNotMatch(functionBody, /schedule_event_participants\s+participant\b/i);
  assert.doesNotMatch(functionBody, /\)\s+source_name\(value\)/i);
});

test("the replacement is byte-equivalent to 001 after reversing only the reviewed alias renames", () => {
  const restoredAliases = functionBody
    .replaceAll("supplemental_loop_row.value", "value")
    .replaceAll("supplemental_loop_row(value)", "item(value)")
    .replaceAll("schedule_loop_row.value", "value")
    .replaceAll("schedule_loop_row(value)", "item(value)")
    .replaceAll("leave_makeup_loop_row.value", "value")
    .replaceAll("leave_makeup_loop_row(value)", "item(value)")
    .replaceAll("supplemental_projection_row", "item")
    .replaceAll("schedule_projection_row", "item")
    .replaceAll("leave_makeup_projection_row", "item")
    .replaceAll("schedule_count_row", "item")
    .replaceAll("raw_record_row", "raw_record")
    .replaceAll("participant_row", "participant")
    .replaceAll("source_name_row", "source_name");

  assert.equal(restoredAliases, extractStageFunction(originalMigration));
});

test("the alias repair is definition-only and cannot mutate operational state by itself", () => {
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from)\s+public\.ops_state\b/i);
  assert.doesNotMatch(migration, /create(?:\s+or\s+replace)?\s+function\s+public\./i);
  assert.doesNotMatch(migration, /\b(?:drop|truncate)\b/i);
});

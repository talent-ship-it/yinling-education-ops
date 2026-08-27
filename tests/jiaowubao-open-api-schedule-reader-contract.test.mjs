import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260822001100_read_jiaowubao_open_api_schedule_snapshot.sql"), "utf8");
const route = fs.readFileSync(path.join(root, "app/api/jiaowubao-open-api/schedule/route.ts"), "utf8");
const opsStore = fs.readFileSync(path.join(root, "lib/ops-store.ts"), "utf8");
const mapping = fs.readFileSync(path.join(root, "lib/jiaowubao-open-api-schedule-reader.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "app/operations-client.tsx"), "utf8");
const parser = fs.readFileSync(path.join(root, "app/jiaowubao-imported-schedule.tsx"), "utf8");

test("reader migration is a new immutable snapshot contract", () => {
  assert.match(migration, /create or replace function public\.get_jiaowubao_open_api_schedule_snapshot_window/);
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/);
  assert.match(migration, /from internal\.jiaowubao_open_api_schedule_snapshot_current/);
  assert.doesNotMatch(migration, /(?:from|join) internal\.jiaowubao_direct_|direct_schedule_events/);
  assert.match(migration, /order by scoped_event\.starts_at, scoped_event\.event_id/);
  assert.match(migration, /p_cursor_start/);
  assert.match(migration, /state_value := case when freshness_value = 'fresh' then 'complete' else 'stale' end/);
  assert.match(migration, /'sourceStudentsTruncated'/);
  assert.match(migration, /source_name\.missing_member_count = 0/);
  assert.match(migration, /internal\.student_import_name_key/);
  assert.match(migration, /internal\.student_import_jwb_auto_name_key/);
  assert.match(migration, /if source_start_date is null[\s\S]*source_start_date !~[\s\S]*source_window_invalid/);
  assert.match(migration, /begin[\s\S]*source_start_at := \(source_start_date::date::timestamp[\s\S]*exception when others/);
  assert.match(migration, /p_scope in \('teacher', 'availability'\) and p_scope_student_member_ids is not null/);
  assert.doesNotMatch(migration, /p_scope = 'teacher'[\s\S]{0,500}p_scope_student_member_ids\) = any/);
  assert.doesNotMatch(migration, /'price(?:_|')/i);
  assert.match(migration, /revoke all on function public\.get_jiaowubao_open_api_schedule_snapshot_window\([\s\S]*text\[\]\n\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_jiaowubao_open_api_schedule_snapshot_window\([\s\S]*text\[\]\n\) to anon, authenticated/);
});

test("API route keeps source mapping server-only and separates session/reader/upstream failures", () => {
  assert.match(route, /buildOpsAccessContext\(rows, session\.user, fullAdmin, session\)/);
  assert.match(route, /getJiaowubaoOpenApiScheduleSnapshotWindow/);
  assert.match(route, /code: "session_required"/);
  assert.match(route, /resolved\.status === 401/);
  assert.match(route, /jiaowubao_open_api_schedule_reader_unavailable/);
  assert.match(route, /jiaowubao_open_api_schedule_snapshot_unavailable/);
  assert.match(route, /sourceParticipants/);
  assert.match(route, /internalByNameKey/);
  assert.doesNotMatch(route, /importSource !== "" && importSource !== "master"/);
  assert.match(mapping, /normalizeStudentImportName\(participant\.label\)[\s\S]*studentImportAutomaticJwbNameKey\(participant\.label\)/);
  assert.match(route, /mapJiaowubaoSnapshotParticipants\(\s*event\.sourceParticipants/);
  assert.doesNotMatch(route, /price_mem|\bprice\b|sourceStudentMemberIds.*return|sourceTeacherLabel.*return/);
  assert.match(opsStore, /p_scope_student_name_keys: input\.studentNameKeys/);
  assert.match(opsStore, /Server-only raw receipt from the Open API source snapshot reader/);
});

test("schedule client uses the snapshot route and parser allow-list", () => {
  assert.match(client, /fetch\(`\/api\/jiaowubao-open-api\/schedule\?/);
  assert.doesNotMatch(client, /fetch\(`\/api\/jiaowubao-direct-import\/schedule\?/);
  assert.match(client, /response\.status === 401 \? "session" : response\.status === 501 \? "reader_unavailable" : "unavailable"/);
  assert.match(client, /page\.state !== "complete" && page\.state !== "stale"/);
  assert.match(client, /parseSnapshotSchedulePage/);
  assert.match(parser, /parseJiaowubaoImportedSchedulePage/);
  assert.match(parser, /"price_mem"/);
  assert.match(parser, /"stu_list"/);
  assert.match(parser, /feed\?\.state === "stale"/);
});

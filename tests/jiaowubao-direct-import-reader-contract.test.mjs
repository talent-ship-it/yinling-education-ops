import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, store, scheduleRoute, historyRoute] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819000200_read_jiaowubao_direct_import_projection.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/jiaowubao-direct-import/schedule/route.ts", import.meta.url), "utf8"),
  readFile(new URL(
    "../app/api/jiaowubao-direct-import/students/[studentId]/history/route.ts",
    import.meta.url,
  ), "utf8"),
]);

function functionBody(name) {
  return migration.match(new RegExp(
    `create or replace function public\\.${name}[\\s\\S]*?\\$${name}\\$;`,
    "i",
  ))?.[0] ?? "";
}

test("the direct-import read surface is exactly two curated, secret-gated readers", () => {
  const publicFunctions = migration.match(/create or replace function public\.[a-z0-9_]+/gi) ?? [];
  assert.deepEqual(publicFunctions.map((entry) => entry.toLowerCase()), [
    "create or replace function public.get_jiaowubao_direct_schedule_window",
    "create or replace function public.get_jiaowubao_direct_student_history",
  ]);
  assert.match(migration, /revoke all on function public\.get_jiaowubao_direct_schedule_window\(text, timestamptz, timestamptz, text, text\[\], text\[\], integer, timestamptz, uuid, uuid\)/i);
  assert.match(migration, /revoke all on function public\.get_jiaowubao_direct_student_history\(text, text, integer\)/i);
  assert.match(migration, /grant execute on function public\.get_jiaowubao_direct_schedule_window/i);
  assert.match(migration, /grant execute on function public\.get_jiaowubao_direct_student_history/i);
  assert.doesNotMatch(migration, /create or replace function public\.put_/i);
});

test("the schedule reader uses UTC overlap, pin-safe keyset pagination, and never emits raw workbook or cohort fields", () => {
  const body = functionBody("get_jiaowubao_direct_schedule_window");
  assert.match(body, /not internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(body, /schedule_event\.starts_at < p_window_end/i);
  assert.match(body, /schedule_event\.ends_at > p_window_start/i);
  assert.match(body, /p_limit not between 1 and 250/i);
  assert.match(body, /\(p_cursor_start is null\) <> \(p_cursor_event_id is null\)/i);
  assert.match(body, /p_cursor_start is not null and p_run_token is null/i);
  assert.match(body, /p_run_token is not null and p_run_token <> saved_run\.id/i);
  assert.match(body, /'state', 'reset'/i);
  assert.match(body, /limit p_limit \+ 1/i);
  assert.match(body, /from page_events schedule_event/i);
  assert.match(body, /to_char\(last_event\.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\)/i);
  assert.match(body, /'hasMore', has_more/i);
  assert.match(body, /'nextCursor', next_cursor/i);
  assert.match(body, /'runToken', saved_run\.id::text/i);
  assert.match(body, /if p_cursor_start is null and p_scope <> 'availability' then\s*\n\s*select count\(\*\)::integer into invalid_time_event_count/i);
  assert.match(body, /coalesce\(cardinality\(p_scope_teacher_ids\), 0\) not between 1 and 512/i);
  assert.match(body, /coalesce\(cardinality\(p_scope_student_ids\), 0\) not between 1 and 1024/i);
  assert.match(body, /visibleStudentIds/i);
  assert.match(body, /visibleStudentsTruncated/i);
  assert.match(body, /limit 101/i);
  assert.match(body, /\)\[1:100\]/i);
  assert.match(body, /p_scope not in \('all', 'teacher', 'student', 'availability'\)/i);
  assert.match(body, /case when p_scope = 'availability' then null else schedule_event\.course_name end/i);
  assert.match(body, /participant_page on p_scope <> 'availability'/i);
  assert.match(body, /schedule_event\.availability_effect = 'blocks_teacher_ava'/i);
  assert.match(body, /tstzrange\(schedule_event\.starts_at, schedule_event\.ends_at, '\[\)'\)\s*\n\s*&& tstzrange\(p_window_start, p_window_end, '\[\)'\)/i);
  for (const forbidden of ["source_key", "source_workbook", "source_row", "source_cell", "source_payload", "evidence_phone", "class_name", "teacher_display_name"]) {
    assert.doesNotMatch(body, new RegExp(forbidden, "i"));
  }
});

test("reader indexes bound paged schedule and per-student history reads", () => {
  assert.match(migration, /jiaowubao_direct_schedule_events_reader_window_idx/i);
  assert.match(migration, /jiaowubao_direct_schedule_events_reader_range_idx/i);
  assert.match(migration, /using gist \(tstzrange\(starts_at, ends_at, '\[\)'\)\)/i);
  assert.match(migration, /\(run_id, starts_at, id\)\s*\n\s*where time_parse_status = 'parsed'/i);
  assert.match(migration, /jiaowubao_direct_schedule_events_reader_teacher_window_idx/i);
  assert.match(migration, /jiaowubao_direct_schedule_participants_reader_student_event_idx/i);
  assert.match(migration, /jiaowubao_direct_schedule_participants_reader_event_student_idx/i);
  assert.match(migration, /jiaowubao_direct_leave_makeup_reader_student_idx/i);
  assert.match(migration, /jiaowubao_direct_supplemental_reader_student_idx/i);
});

test("the student reader keeps history attached-only and returns no source identity metadata", () => {
  const body = functionBody("get_jiaowubao_direct_student_history");
  assert.match(body, /resolution_state = 'attached'/i);
  assert.match(body, /source_payload #>> '\{source,raw,fields,课程\}'/i);
  assert.match(body, /source_payload #>> '\{source,raw,fields,学员类型\}'/i);
  assert.match(body, /source_payload #>> '\{source,raw,fields,课时数\}'/i);
  assert.match(body, /source_payload #>> '\{source,raw,fields,总课时数\}'/i);
  assert.match(body, /source_payload #>> '\{source,className\}'/i);
  assert.match(body, /source_payload #>> '\{source,raw,values,classType\}'/i);
  assert.match(body, /select exists \([\s\S]*?offset p_limit[\s\S]*?\) into supplemental_truncated/is);
  assert.match(body, /select exists \([\s\S]*?offset p_limit[\s\S]*?\) into leave_makeups_truncated/is);
  for (const forbiddenOutputKey of [
    "sourceKey",
    "sourceWorkbook",
    "sourceRow",
    "masterSourceRow",
    "evidencePhone",
    "evidenceName",
    "quarantineReason",
  ]) {
    assert.doesNotMatch(body, new RegExp(`'${forbiddenOutputKey}'`, "i"));
  }
});

test("server-only store and GET routes derive scope, sign continuation state, and reject raw cursor tuples", () => {
  assert.match(store, /import "server-only"/i);
  assert.match(store, /p_scope_teacher_ids: input\.teacherIds/i);
  assert.match(store, /p_scope_student_ids: input\.studentIds/i);
  assert.match(store, /p_limit: input\.limit/i);
  assert.match(store, /p_cursor_start: input\.cursor\?\.startsAt \?\? null/i);
  assert.match(store, /p_run_token: input\.runToken/i);
  assert.doesNotMatch(store, /JIAOWUBAO_DIRECT_LEAVE_MAKEUP_WINDOW_RPC/i);
  assert.match(scheduleRoute, /buildOpsAccessContext/i);
  assert.match(scheduleRoute, /scope: "teacher"/i);
  assert.match(scheduleRoute, /scope: "student"/i);
  assert.match(scheduleRoute, /scope: "availability"/i);
  assert.match(scheduleRoute, /scope: requestedTeacherId \? "teacher" : "all"/i);
  assert.match(scheduleRoute, /CANONICAL_UTC_INSTANT/i);
  assert.match(scheduleRoute, /CANONICAL_CURSOR_UTC_INSTANT/i);
  assert.match(scheduleRoute, /parsed\.toISOString\(\)\.slice\(0, 19\) !== value\.slice\(0, 19\)/i);
  assert.match(scheduleRoute, /createHmac\("sha256", cursorSigningSecret\(\)\)/i);
  assert.match(scheduleRoute, /contextHash\(context\)/i);
  assert.match(scheduleRoute, /function contextHash\(context: ScheduleCursorContext\)[\s\S]*?createHmac\("sha256", cursorSigningSecret\(\)\)/i);
  assert.match(scheduleRoute, /CURSOR_TTL_SECONDS/i);
  assert.match(scheduleRoute, /url\.searchParams\.get\("cursor"\)/i);
  assert.match(scheduleRoute, /url\.searchParams\.has\("cursorStartsAt"\)/i);
  assert.match(scheduleRoute, /getPublicSchedulePage/i);
  assert.match(scheduleRoute, /studentIds: null,[\s\S]*?\}, cursorToken\.value\)/is);
  assert.match(scheduleRoute, /cursorStartsAt/i);
  assert.match(scheduleRoute, /cursorEventId/i);
  assert.match(scheduleRoute, /SCHEDULE_PAGE_LIMIT = 250/i);
  assert.match(scheduleRoute, /cursor: signedCursor\?\.cursor \?\? null/i);
  assert.match(scheduleRoute, /if \(!access\.staff \|\| !knownTeacherIds\.has\(requestedTeacherId\)\)/i);
  assert.match(scheduleRoute, /return noStore\(\{ error: "未找到该老师。" \}, 404\)/i);
  assert.doesNotMatch(scheduleRoute, /studentId"\)/i);
  assert.match(scheduleRoute, /Cache-Control": "private, no-store"/i);
  assert.match(historyRoute, /canAccessStudent/i);
  assert.match(historyRoute, /getJiaowubaoDirectStudentHistory/i);
  assert.match(historyRoute, /Cache-Control": "private, no-store"/i);
});

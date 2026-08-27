import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260819100900_read_teacher_availability_completion_pending_ids.sql",
  import.meta.url,
);

function functionBody(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf("revoke all on function", start);
  assert.ok(start >= 0 && end > start, `${signature} body is missing`);
  return sql.slice(start, end);
}

test("AVA completion pending-ID reader is secret-only, month-scoped, bounded, and PII-minimal", async () => {
  const [sql, store, route, service] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/teacher-availability/completion/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/teacher-availability-completion-service.ts", import.meta.url), "utf8"),
  ]);
  const body = functionBody(sql, "public.get_teacher_availability_completion_pending_teacher_ids");

  assert.match(sql, /create index if not exists teacher_availability_pending_month_teacher_idx[\s\S]*where status = 'pending'/i);
  assert.match(body, /security definer/i);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(body, /p_month.*\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$/is);
  assert.match(body, /p_limit > 1000/i);
  assert.match(body, /submission\.status = 'pending'/i);
  assert.match(body, /submission\.submission_month = p_month/i);
  assert.match(body, /limit p_limit \+ 1/i);
  assert.match(body, /overflowed boolean/i);
  assert.doesNotMatch(body, /teacher_name|current_city|availability_slots|notes|review_note|reviewed_by/i);
  assert.match(sql, /revoke all on function public\.get_teacher_availability_completion_pending_teacher_ids\(text, text, integer\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_teacher_availability_completion_pending_teacher_ids\(text, text, integer\)[\s\S]*to anon, authenticated/i);

  assert.match(store, /TEACHER_AVAILABILITY_COMPLETION_PENDING_TEACHERS_RPC = "get_teacher_availability_completion_pending_teacher_ids"/);
  const wrapper = store.slice(
    store.indexOf("export function getTeacherAvailabilityCompletionPendingTeacherIds"),
    store.indexOf("export function submitTeacherAvailabilityAtomic"),
  );
  for (const field of ["p_secret", "p_month", "p_limit"]) assert.match(wrapper, new RegExp(field));
  assert.doesNotMatch(wrapper, /teacher_name|current_city|availability_slots|notes|review_note/);

  assert.match(route, /currentMonthInMelbourne/);
  assert.match(route, /getTeacherAvailabilityCompletionPendingTeacherIds\(\{[\s\S]*month,[\s\S]*limit: MAX_COMPLETION_PENDING_TEACHERS/);
  assert.doesNotMatch(route, /getTeacherAvailabilitySubmissions/);
  assert.match(service, /reader\.overflowed === true/);
  assert.match(service, /MAX_COMPLETION_PENDING_TEACHERS/);
});

test("AVA completion reader SQL fixture is self-contained, migration-runnable, bounded, and disposable", async () => {
  const fixture = await readFile(
    new URL("./sql/teacher-availability-completion-reader-contract.sql", import.meta.url),
    "utf8",
  );

  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;/im);
  assert.match(fixture, /create schema if not exists internal/i);
  assert.match(fixture, /create table if not exists public\.teacher_availability_submissions/i);
  assert.match(fixture, /create or replace function internal\.verify_ops_secret/i);
  assert.match(fixture, /20260819100900_read_teacher_availability_completion_pending_ids\.sql/i);
  assert.match(fixture, /ava-completion-reader-fixture-secret/i);
  assert.match(fixture, /generate_series\(1, 1001\)/i);
  assert.match(fixture, /ava_completion_reader_bound_or_scope_failed/i);
  assert.match(fixture, /ava_completion_reader_secret_not_rejected/i);
  assert.match(fixture, /ava_completion_reader_limit_not_rejected/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
  assert.ok(
    fixture.indexOf("create table if not exists public.teacher_availability_submissions")
      < fixture.indexOf("20260819100900_read_teacher_availability_completion_pending_ids.sql"),
    "fixture must create the transaction-local table before loading the migration",
  );
  assert.ok(
    fixture.indexOf("create or replace function internal.verify_ops_secret")
      < fixture.indexOf("20260819100900_read_teacher_availability_completion_pending_ids.sql"),
    "fixture must install the transaction-local secret verifier before loading the migration",
  );
});

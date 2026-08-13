import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260813013935_operational_atomic_contracts.sql",
  import.meta.url,
);
const sql = await readFile(migrationUrl, "utf8");

const publicRpcSignatures = [
  "put_lesson_attendance_evidence(text, text, text, timestamptz, jsonb, text, text)",
  "get_lesson_attendance_evidence(text, text, text)",
  "complete_lesson_occurrence_atomic(text, text, bigint, jsonb, text, jsonb, text, text, text, text)",
  "put_student_import_source_rows(text, text, text, text, jsonb, text)",
  "get_latest_student_import_source_rows(text)",
  "commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)",
  "review_teacher_availability_submission_atomic(text, bigint, text, text, bigint, jsonb, text, text)",
  "get_teacher_availability_submissions(text)",
  "get_booking_capacity_command_result(text, text, jsonb, text)",
  "get_operation_confirmation_command_result(text, text, jsonb, text)",
  "mutate_booking_capacity_atomic(text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)",
  "confirm_operation_occurrences_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text)",
];

test("all operational RPCs verify the shared server secret", () => {
  const functionBodies = sql.split(/create or replace function public\./i).slice(1);
  const names = functionBodies.map((body) => body.match(/^([a-z0-9_]+)/i)?.[1]);
  for (const name of [
    "put_lesson_attendance_evidence",
    "get_lesson_attendance_evidence",
    "complete_lesson_occurrence_atomic",
    "put_student_import_source_rows",
    "get_latest_student_import_source_rows",
    "commit_student_import_plan_atomic",
    "review_teacher_availability_submission_atomic",
    "get_teacher_availability_submissions",
    "get_booking_capacity_command_result",
    "get_operation_confirmation_command_result",
    "mutate_booking_capacity_atomic",
    "confirm_operation_occurrences_atomic",
  ]) {
    const body = functionBodies[names.indexOf(name)];
    assert.ok(body, `${name} is missing`);
    assert.match(body, /internal\.verify_ops_secret\(p_secret\)/i, `${name} must verify OPS_API_SECRET`);
    assert.match(body, /security definer/i, `${name} is expected to cross the locked table boundary`);
    assert.match(body, /set search_path = ''/i, `${name} must pin an empty search_path`);
  }
});

test("every public security-definer RPC revokes default execute before opt-in grants", () => {
  for (const signature of publicRpcSignatures) {
    const escaped = signature.replace(/[()]/g, "\\$&");
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${escaped}\\s+from public, anon, authenticated`, "i"),
      `missing revoke for ${signature}`,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${escaped}\\s+to anon, authenticated`, "i"),
      `missing deliberate server-RPC grant for ${signature}`,
    );
  }
});

test("all internal state tables are RLS-enabled and inaccessible directly", () => {
  for (const table of [
    "operational_contract_audit",
    "lesson_attendance_evidence",
    "lesson_occurrence_settlements",
    "student_import_source_rows",
    "student_import_commits",
    "teacher_availability_reviews",
  ]) {
    assert.match(sql, new RegExp(`alter table internal\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table internal\\.${table} from public, anon, authenticated`, "i"));
  }
});

test("lesson completion locks and versions every dependent state before one atomic write", () => {
  for (const entity of ["bookings", "payroll", "students", "teachers"]) {
    assert.match(sql, new RegExp(`from public\\.ops_state where entity = '${entity}' for update`, "i"));
    assert.match(sql, new RegExp(`p_state_versions ->> '${entity}'`, "i"));
  }
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.complete_lesson_occurrence_atomic"),
    sql.indexOf("revoke all on function public.complete_lesson_occurrence_atomic"),
  );
  assert.doesNotMatch(functionBody, /where entity = 'lessonOccurrences'/i);
  assert.doesNotMatch(functionBody, /p_state_versions ->> 'lessonOccurrences'/i);
  assert.match(functionBody, /jsonb_set\(b, '\{occurrenceOverrides\}'/i);
  assert.match(functionBody, /lesson\.attendance_abnormal/i);
  assert.match(functionBody, /abnormal_settlement_mutates_financial_state/i);
  assert.match(functionBody, /p_callback_nonce_sha256/i);
  assert.match(functionBody, /audit_id = completion_audit_id/i);
  assert.doesNotMatch(functionBody, /audit_id = lesson_settlement\.audit_id/i);
  assert.match(sql, /lesson_settlement_not_derived_from_state/i);
  assert.match(sql, /insufficient_lesson_hours/i);
  assert.match(sql, /insert into internal\.lesson_occurrence_settlements/i);
});

test("student import uses raw server-owned source rows, source revision locks and a plan fingerprint", () => {
  assert.match(sql, /create table if not exists internal\.student_import_source_rows/i);
  assert.match(sql, /student_import_source_rows_unavailable/i);
  assert.match(sql, /master\.revision <> p_source_revisions ->> 'master'/i);
  assert.match(sql, /current_state\.version <> p_expected_student_version/i);
  assert.match(sql, /p_plan_fingerprint[^\n]*\^sha256:/i);
  assert.match(sql, /p_actor not in \('Nixon', 'Ops Admin'\)/i);
});

test("student import refuses to remove canonical IDs that remain referenced", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  for (const entity of [
    "bookings",
    "files",
    "lpItems",
    "messages",
    "operations",
    "payroll",
    "renewals",
    "tasks",
  ]) {
    assert.match(functionBody, new RegExp(`'${entity}'`, "i"), `${entity} references must be guarded`);
  }
  assert.match(functionBody, /order by array_position\(reference_entities, s\.entity\)[\s\S]*for update/i);
  assert.match(functionBody, /new_student ->> 'id' = old_student ->> 'id'/i);
  assert.match(functionBody, /reference_item ->> 'studentId' = old_student ->> 'id'/i);
  assert.match(functionBody, /student_import_referenced_student_removed/i);
  assert.match(functionBody, /student_import_referenced_package_removed/i);
  assert.match(functionBody, /old_package ->> 'id' = package_reference\.referenced_package_id/i);
  assert.match(functionBody, /new_package ->> 'id' = package_reference\.referenced_package_id/i);
});

test("student import backfills only uniquely matched future package references and audits ambiguity", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(functionBody, /bookings_state_unavailable/i);
  assert.match(functionBody, /cardinality\(matching_package_ids\) = 1/i);
  assert.match(functionBody, /subject\.subject_id = booking_subject/i);
  assert.match(functionBody, /nullif\(trim\(booking_item ->> 'packageId'\), ''\) is null/i);
  assert.match(functionBody, /current_timestamp at time zone 'Australia\/Melbourne'/i);
  assert.match(functionBody, /nullif\(trim\(override_item ->> 'settledAt'\), ''\) is null/i);
  assert.match(functionBody, /case[\s\S]*right\(override_item ->> 'occurrenceId', 10\)::date/i);
  assert.match(functionBody, /jsonb_set\(override_item, '\{packageId\}'/i);
  assert.match(functionBody, /bookingPackageBackfilledIds/i);
  assert.match(functionBody, /bookingPackageUnresolvedIds/i);
  assert.match(functionBody, /update public\.ops_state s set[\s\S]*where s\.entity = 'bookings'/i);
});

test("availability review supports atomic approve/reject, version lock and durable audit", () => {
  const sourceTableAt = sql.search(/create table if not exists public\.teacher_availability_submissions/i);
  const reviewTableAt = sql.search(/create table if not exists internal\.teacher_availability_reviews/i);
  assert.ok(sourceTableAt >= 0 && sourceTableAt < reviewTableAt, "submission table must exist before the review FK and rowtype");
  assert.match(sql, /alter table public\.teacher_availability_submissions[\s\S]*add column if not exists review_note text/i);
  assert.match(sql, /teacher_availability_submissions_month_check[\s\S]*not valid/i);
  assert.match(sql, /create unique index if not exists teacher_availability_submissions_id_uidx/i);
  assert.match(sql, /alter table public\.teacher_availability_submissions enable row level security/i);
  assert.match(sql, /revoke all on table public\.teacher_availability_submissions from public, anon, authenticated/i);
  assert.match(sql, /p_decision not in \('approved', 'rejected'\)/i);
  assert.match(sql, /submission\.status <> p_expected_submission_status/i);
  assert.match(sql, /teacher_state\.version <> p_expected_teacher_version/i);
  assert.match(sql, /availability_windows_do_not_match_submission/i);
  assert.match(sql, /expected_retained_windows/i);
  assert.match(sql, /Recreate the pure-domain retainOutsideMonth contract/i);
  assert.match(sql, /update public\.teacher_availability_submissions/i);
  assert.match(sql, /insert into internal\.teacher_availability_reviews/i);
  assert.match(sql, /teacher_availability\.' \|\| p_decision/i);
});

test("availability inbox drops the deployed legacy return shape before rebuilding it", () => {
  const dropAt = sql.search(/drop function if exists public\.get_teacher_availability_submissions\(text\)/i);
  const createAt = sql.search(/create or replace function public\.get_teacher_availability_submissions\(p_secret text\)/i);
  assert.ok(dropAt >= 0, "legacy inbox function must be dropped");
  assert.ok(createAt > dropAt, "the 14-column inbox function must be created after the drop");
});

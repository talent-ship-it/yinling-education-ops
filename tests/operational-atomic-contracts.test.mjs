import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260813013935_operational_atomic_contracts.sql",
  import.meta.url,
);
const sql = await readFile(migrationUrl, "utf8");
const sourcePrecedenceFixSql = await readFile(
  new URL(
    "../supabase/migrations/20260814142638_fix_import_source_jsonb_precedence.sql",
    import.meta.url,
  ),
  "utf8",
);
const teacherResolutionLookupFixSql = await readFile(
  new URL(
    "../supabase/migrations/20260814153000_optimize_teacher_resolution_lookup.sql",
    import.meta.url,
  ),
  "utf8",
);

function sqlFunction(source, qualifiedName) {
  const marker = `create or replace function ${qualifiedName}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${qualifiedName} is missing`);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${qualifiedName} is unterminated`);
  return source.slice(start, end + 4);
}

const publicRpcSignatures = [
  "put_lesson_attendance_evidence(text, text, text, timestamptz, jsonb, text, text)",
  "get_lesson_attendance_evidence(text, text, text)",
  "complete_lesson_occurrence_atomic(text, text, bigint, jsonb, text, jsonb, text, text, text, text)",
  "put_student_import_source_rows(text, text, text, text, jsonb, text)",
  "get_latest_student_import_source_rows(text)",
  "put_student_import_identity_links(text, jsonb, jsonb, text)",
  "put_student_import_master_duplicate_resolution(text, text, text, text)",
  "commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)",
  "put_teacher_import_source(text, text, text, text, jsonb, jsonb, jsonb, text)",
  "get_latest_teacher_import_sources(text)",
  "put_teacher_import_identity_link(text, text, text, text)",
  "put_teacher_import_hard_resolution(text, text, text, text)",
  "commit_teacher_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)",
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
    "put_student_import_identity_links",
    "put_student_import_master_duplicate_resolution",
    "commit_student_import_plan_atomic",
    "put_teacher_import_source",
    "get_latest_teacher_import_sources",
    "put_teacher_import_identity_link",
    "put_teacher_import_hard_resolution",
    "commit_teacher_import_plan_atomic",
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
    "student_import_identity_link_sets",
    "student_import_master_duplicate_resolutions",
    "student_import_commits",
    "teacher_import_sources",
    "teacher_import_identity_links",
    "teacher_import_hard_resolutions",
    "teacher_import_commits",
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
  assert.match(functionBody, /current_student ->> 'importArchived' = 'true'[\s\S]*errcode = '42501'[\s\S]*archived_student_lesson_read_only/i);
  assert.ok(
    functionBody.indexOf("archived_student_lesson_read_only") < functionBody.indexOf("if replaying_prior then"),
    "archived student guard must run before lesson replay returns",
  );
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
  const sourceBody = sql.slice(
    sql.indexOf("create or replace function public.put_student_import_source_rows"),
    sql.indexOf("create or replace function public.get_latest_student_import_source_rows"),
  );
  assert.match(sourceBody, /\(r -> 'attributes'\)[\s\S]*ARRAY\['location', 'year', 'owner', 'planner'\]::text\[\]/i);
  assert.match(sourceBody, /\(r -> 'attributes'\) - ARRAY\['jiaowubaoPackageImport'\]::text\[\]/i);
  assert.match(sourceBody, /\(r -> 'attributes' -> 'jiaowubaoPackageImport'\) - ARRAY\[[\s\S]*'adjustmentContracts'[\s\S]*\]::text\[\]/i);
  assert.doesNotMatch(sourceBody, /\br -> 'attributes'\s*-\s*'(?:location|jiaowubaoPackageImport)'/i);
  assert.doesNotMatch(sourceBody, /\br -> 'attributes'\s*->\s*'jiaowubaoPackageImport'\s*-\s*'status'/i);
  assert.match(sourceBody, /r - 'sourceRow' - 'name' - 'remainingHours' - 'contractHours'/i);
  assert.match(sourceBody, /packageCoverage.*complete.*partial.*none/is);
  assert.match(sourceBody, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.match(sourceBody, /student_import_source:' \|\| p_source_kind/i);
  assert.match(sourceBody, /saved\.source_id = trim\(p_source_id\)/i);
  assert.match(sourceBody, /attribute\.value #>> '\{\}' <> trim/i);
  assert.match(sourceBody, /student_import_has_microhour_precision\(r -> 'remainingHours'\)/i);
  assert.match(sourceBody, /student_import_has_microhour_precision[\s\S]*currentTotalHours/i);
  assert.match(sourceBody, /student_import_has_microhour_precision\(unresolved -> 'totalHours'\)/i);
  assert.match(sourceBody, /student_import_has_microhour_precision\(adjustment -> 'hoursDelta'\)/i);
  assert.match(sourceBody, /perform internal\.student_import_canonical_jwb_packages[\s\S]*lessonPackages/i);
  assert.match(sql, /create or replace function internal\.student_import_js_trim\(p_value text\)/i);
  assert.match(sourceBody, /r ->> 'sourceRow' <> internal\.student_import_source_key\(r -> 'sourceRow'\)/i);
  assert.match(sql, /student_import_source_key\(to_jsonb\(chr\(9\)[\s\S]*chr\(160\)[\s\S]*<\s*>\s*'ROW-1'/i);
});

test("student identity links are revision/version-bound and currently clear-only", () => {
  assert.match(sql, /create table if not exists internal\.student_import_identity_link_sets/i);
  const putBody = sql.slice(
    sql.indexOf("create or replace function public.put_student_import_identity_links"),
    sql.indexOf("revoke all on function public.put_student_import_source_rows"),
  );
  assert.match(putBody, /p_links jsonb/i);
  assert.match(putBody, /jsonb_array_length\(p_links\) <> 0/i);
  assert.doesNotMatch(putBody, /parent|mobile|phone|email/i);
  assert.match(putBody, /master\.revision <> p_source_revisions ->> 'master'/i);
  assert.match(putBody, /jwb\.revision <> p_source_revisions ->> 'jwb'/i);
  assert.match(putBody, /students_state\.version, canonical_links/i);
  assert.match(putBody, /student_import\.identity_links_replaced/i);
  assert.match(putBody, /saved\.students_version = students_state\.version/i);
  assert.match(putBody, /'fingerprint', fingerprint, 'count'/i);

  const getBody = sql.slice(
    sql.indexOf("create or replace function public.get_latest_student_import_source_rows"),
    sql.indexOf("create or replace function public.put_student_import_identity_links"),
  );
  assert.match(getBody, /'identityLinks'/i);
  assert.match(getBody, /'identityLinkFingerprint'/i);
  assert.match(getBody, /link_set\.students_version = students_state\.version/i);
  assert.match(getBody, /link_set\.link_count = 0/i);
  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(commitBody, /from internal\.student_import_identity_link_sets l[\s\S]*for update/i);
  assert.match(commitBody, /student_import_identity_links_changed/i);
  assert.match(commitBody, /link_set\.students_version = case[\s\S]*when replaying_prior then p_expected_student_version[\s\S]*else current_state\.version/i);
  assert.match(commitBody, /link_set\.link_count = 0/i);
  assert.match(commitBody, /current_state\.version <> prior\.students_version/i);
  assert.match(commitBody, /student_import_idempotent_state_changed/i);
  assert.ok(
    commitBody.indexOf("from internal.student_import_identity_link_sets l")
      < commitBody.indexOf("return query select\n      'students'::text,\n      prior.students_version"),
    "an idempotent replay must re-lock and revalidate its revision-bound identity set",
  );
});

test("student formal commit independently proves namespaced identity and eligible-row bijection", () => {
  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(sql, /create or replace function internal\.student_import_fnv1a/i);
  assert.match(sql, /create or replace function internal\.student_import_master_source_key/i);
  assert.match(sql, /create or replace function internal\.student_import_student_id/i);
  assert.match(sql, /normalize\(coalesce\(p_name, ''\), NFKC\)/i);
  assert.match(commitBody, /student_import_formal_identity_mismatch/i);
  assert.match(commitBody, /from jsonb_array_elements\(resolved_master_rows\) eligible_master_row/i);
  assert.match(commitBody, /from jsonb_array_elements\(expected_students\) imported_student/i);
  assert.match(commitBody, /imported_student ->> 'importSource' = 'master'/i);
  assert.match(commitBody, /imported_student ->> 'name' =[\s\S]*student_import_display_name/i);
  assert.match(commitBody, /imported_student ->> 'status' = eligible_master_row ->> 'status'/i);
  assert.match(commitBody, /student_import_master_source_key\(master\.source_id, eligible_master_row -> 'sourceRow'\)/i);
  assert.match(commitBody, /student_import_student_id\(master\.source_id, eligible_master_row -> 'sourceRow'\)/i);
});

test("student commit preserves only canonical current manual trials and immutable archives", () => {
  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(sql, /create or replace function internal\.student_import_is_manual_trial\(p_student jsonb\)/i);
  assert.match(sql, /create or replace function internal\.student_import_defaults\(p_student jsonb\)/i);
  assert.match(sql, /create or replace function internal\.student_import_canonical_manual_trial\(p_student jsonb\)/i);
  assert.match(sql, /create or replace function internal\.student_import_canonical_archive\(p_student jsonb\)/i);
  assert.match(sql, /revoke all on function internal\.student_import_canonical_manual_trial\(jsonb\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function internal\.student_import_canonical_archive\(jsonb\)[\s\S]*from public, anon, authenticated/i);

  assert.match(commitBody, /student_import_manual_trial_mismatch/i);
  assert.match(commitBody, /from jsonb_array_elements\(expected_students\) imported_student[\s\S]*from jsonb_array_elements\(current_state\.payload\) old_student/i);
  assert.match(commitBody, /from jsonb_array_elements\(current_state\.payload\) old_student[\s\S]*from jsonb_array_elements\(expected_students\) imported_student/i);
  assert.match(commitBody, /imported_student = internal\.student_import_canonical_manual_trial\(old_student\)/i);
  assert.match(commitBody, /internal\.student_import_is_manual_trial\(old_student\)/i);

  assert.match(commitBody, /archived_student <>[\s\S]*internal\.student_import_canonical_archive\(old_student\)/i);
  assert.match(sql, /'next', '历史引用归档，只读'/i);
  assert.match(sql, /'nextTone', 'neutral'/i);
  assert.match(sql, /'importArchivedReason', 'referenced_history'/i);
});

test("student master duplicates require revision/version-bound opaque hard decisions", () => {
  assert.match(sql, /create table if not exists internal\.student_import_master_duplicate_resolutions/i);
  const putBody = sql.slice(
    sql.indexOf("create or replace function public.put_student_import_master_duplicate_resolution"),
    sql.indexOf("create or replace function public.put_student_import_identity_links"),
  );
  assert.match(putBody, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(putBody, /student_import_master_duplicate_candidates\(master, students_state\)/i);
  assert.match(putBody, /selected_student_id/i);
  assert.match(putBody, /link ->> 'masterSourceRow' = selected_source_row/i);
  assert.match(putBody, /link_set\.students_version = students_state\.version/i);
  assert.doesNotMatch(putBody, /students_state\.payload\)[\s\S]*student ->> '(?:sourceRow|masterSourceKey)'/i);
  assert.doesNotMatch(putBody, /p_selected|p_source_rows|p_student_id/i);
  assert.match(putBody, /student_import\.master_duplicate_resolution_confirmed/i);
  assert.match(sql, /unclosed_blank_student_master_status/i);
  assert.match(sql, /'在读', '活跃 \+ 无课时', '活跃 \+ 有课时', '不活跃 \+ 有课时', '在读 \+ 加课待排'/i);

  const latestBody = sql.slice(
    sql.indexOf("create or replace function public.get_latest_student_import_source_rows"),
    sql.indexOf("create or replace function public.put_student_import_master_duplicate_resolution"),
  );
  assert.match(latestBody, /masterDuplicateResolutions/i);
  assert.match(latestBody, /masterDuplicateResolutionFingerprint/i);

  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(commitBody, /masterDuplicateResolutions/i);
  assert.match(commitBody, /student_import_master_duplicate_snapshot\(master, duplicate_decision_state\)/i);
  assert.match(commitBody, /student_import_master_duplicate_resolution_required/i);
  assert.match(commitBody, /expected_students\s*:=\s*internal\.student_import_canonical_projection/i);
  assert.match(commitBody, /resolved_master_rows[\s\S]*selectedSourceRow/i);
  assert.match(commitBody, /p_students\s+is distinct from\s+expected_students/i);
  assert.match(commitBody, /jsonb_array_elements\(resolved_master_rows\) eligible_master_row/i);
  assert.match(commitBody, /master_duplicate_resolution_fingerprint/i);
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
  assert.match(functionBody, /jsonb_array_elements_text\(referenced_student_ids\)[\s\S]*referenced_student_id = old_student ->> 'id'/i);
  assert.match(functionBody, /student_import_referenced_student_removed/i);
  assert.match(functionBody, /student_import_referenced_package_removed/i);
  assert.match(functionBody, /old_package ->> 'id' = package_reference\.referenced_package_id/i);
  assert.match(functionBody, /new_package ->> 'id' = package_reference\.referenced_package_id/i);
  assert.match(functionBody, /reference_state\.entity = 'renewals'/i);
  assert.match(functionBody, /reference_state\.entity = 'payroll'/i);
  assert.match(functionBody, /old_student -> 'lessonLedger'/i);
  assert.match(functionBody, /renewal\.package-depletion/i);
});

test("student import treats FU attachments as server-owned, race-safe student references", () => {
  const latestBody = sql.slice(
    sql.indexOf("create or replace function public.get_latest_student_import_source_rows"),
    sql.indexOf("create or replace function public.put_student_import_master_duplicate_resolution"),
  );
  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );

  assert.match(sql, /create or replace function internal\.student_fu_attachment_reference_snapshot\(\)/i);
  assert.doesNotMatch(sql, /\bwith\s+references\s+as\b/i);
  assert.match(sql, /\bwith\s+reference_snapshot\s+as\b/i);
  assert.match(sql, /revoke all on function internal\.student_fu_attachment_reference_snapshot\(\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /select distinct a\.student_id[\s\S]*order by a\.student_id/i);
  assert.match(sql, /alter table internal\.student_fu_attachments enable row level security/i);
  assert.match(sql, /revoke all on table internal\.student_fu_attachments from public, anon, authenticated/i);
  assert.match(latestBody, /'fuAttachmentReferences', fu_attachment_snapshot/i);
  assert.doesNotMatch(latestBody, /attachment\.id|file_name|content_base64/i);
  assert.match(commitBody, /p_source_revisions ->> 'fuAttachments'/i);
  assert.match(commitBody, /lock table internal\.student_fu_attachments in share mode/i);
  assert.match(commitBody, /student_import_fu_attachments_changed/i);
  assert.ok(
    commitBody.indexOf("lock table internal.student_fu_attachments in share mode")
      < commitBody.indexOf("from internal.student_import_commits c"),
    "attachment references must be locked and revalidated before the idempotency shortcut",
  );
  assert.match(commitBody, /select trim\(attachment\.student_id\) as student_id[\s\S]*student_fu_attachments attachment/i);
  assert.match(commitBody, /jsonb_array_elements_text\(referenced_student_ids\)[\s\S]*archived_student ->> 'id'/i);
  assert.match(commitBody, /jsonb_array_elements_text\(referenced_student_ids\)[\s\S]*old_student ->> 'id'/i);
  assert.match(commitBody, /fu_attachment_fingerprint/i);
  assert.match(commitBody, /'fuAttachmentFingerprint'/i);
});

test("main migration reinstalls fail-closed PDF-capable FU attachment RPCs", () => {
  const putBody = sql.slice(
    sql.indexOf("create or replace function public.put_student_fu_attachment"),
    sql.indexOf("create or replace function public.get_student_fu_attachment"),
  );
  const getBody = sql.slice(
    sql.indexOf("create or replace function public.get_student_fu_attachment"),
    sql.indexOf("create or replace function internal.student_import_name_key"),
  );
  for (const body of [putBody, getBody]) {
    assert.match(body, /if not internal\.verify_ops_secret\(p_secret\) then/i);
    assert.match(body, /errcode = '42501'.*invalid_ops_secret/is);
    assert.doesNotMatch(body, /perform internal\.verify_ops_secret/i);
  }
  assert.match(putBody, /application\/pdf/i);
  assert.match(putBody, /octet_length\(decoded\) > 4194304/i);
  assert.match(sql, /revoke all on function public\.put_student_fu_attachment[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.get_student_fu_attachment[\s\S]*from public, anon, authenticated/i);
});

test("student import backfills only uniquely matched future package references and audits ambiguity", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(functionBody, /bookings_state_unavailable/i);
  assert.match(functionBody, /cardinality\(matching_package_ids\) = 1/i);
  assert.match(functionBody, /sum\(\(purchase ->> 'hours'\)::numeric\)[\s\S]*consumedHours[\s\S]*> 0/i);
  assert.match(functionBody, /jsonb_typeof\(booking_item -> 'repeatCount'\) = 'number'/i);
  assert.match(functionBody, /repeatCount'\)::numeric between 1 and 1000/i);
  assert.match(functionBody, /or not \(booking_item \? 'repeatCount'\)/i);
  assert.match(functionBody, /booking_item ->> 'date'\)::date \+[\s\S]*repeatCount[\s\S]*\* 7/i);
  assert.match(functionBody, /subject\.subject_id = booking_subject/i);
  assert.match(functionBody, /nullif\(trim\(booking_item ->> 'packageId'\), ''\) is null/i);
  assert.match(functionBody, /current_timestamp at time zone 'Australia\/Melbourne'/i);
  assert.match(functionBody, /nullif\(trim\(override_item ->> 'settledAt'\), ''\) is null/i);
  assert.match(functionBody, /override_effective_date[\s\S]*override_item -> 'date'[\s\S]*occurrenceId/i);
  assert.match(functionBody, /override_student_id\s*:=\s*case[\s\S]*override_item \? 'studentId'/i);
  assert.match(functionBody, /override_subject\s*:=\s*case[\s\S]*override_item \? 'subjectId'/i);
  assert.match(functionBody, /imported_student ->> 'id' = override_student_id/i);
  assert.match(functionBody, /subject\.subject_id = override_subject/i);
  assert.match(functionBody, /not \(override_item \? 'packageId'\)/i);
  assert.match(functionBody, /importArchived[\s\S]*is false/i);
  assert.match(functionBody, /jsonb_set\(override_item, '\{packageId\}'/i);
  assert.match(functionBody, /bookingPackageBackfilledIds/i);
  assert.match(functionBody, /bookingPackageUnresolvedIds/i);
  assert.match(functionBody, /update public\.ops_state s set[\s\S]*where s\.entity = 'bookings'/i);
  assert.match(functionBody, /if next_bookings is distinct from booking_state\.payload then/i);
  const parentBackfill = functionBody.slice(
    functionBody.indexOf("if nullif(trim(booking_item ->> 'packageId')"),
    functionBody.indexOf("elsif nullif(trim(booking_item ->> 'packageId')"),
  );
  assert.match(
    parentBackfill,
    /booking_item ->> 'date'\)::date\s*>=\s*[\s\S]*current_timestamp at time zone 'Australia\/Melbourne'/i,
  );
  assert.doesNotMatch(
    parentBackfill,
    /repeatCount[\s\S]*\*\s*7[\s\S]*current_timestamp at time zone 'Australia\/Melbourne'/i,
  );
  assert.match(
    functionBody,
    /parent_package_backfilled[\s\S]*not override_is_eligible[\s\S]*jsonb_set\(override_item, '\{packageId\}', 'null'::jsonb/i,
  );
  assert.match(
    functionBody,
    /already-started parent[\s\S]*unresolved_booking_ids\s*:=\s*unresolved_booking_ids/i,
  );
  const commonGate = functionBody.slice(
    functionBody.indexOf("if jsonb_typeof(booking_item) = 'object'"),
    functionBody.indexOf("if nullif(trim(booking_item ->> 'packageId')", functionBody.indexOf("if jsonb_typeof(booking_item) = 'object'")),
  );
  assert.doesNotMatch(commonGate, /booking_item ->> 'status'|sourceTiming/i);
});

test("student commit revalidates complete package and purchase invariants at the SQL boundary", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(functionBody, /invalid_student_import_package_ids/i);
  assert.doesNotMatch(functionBody, /invalid_student_import_global_package_ids/i);
  assert.match(functionBody, /lesson_package_item -> 'subjectIds'[\s\S]*count\(distinct trim\(subject #>> '\{\}'\)\)/i);
  assert.match(functionBody, /purchaseRecords.*1000/is);
  assert.match(functionBody, /purchase_item ->> 'hours'\)::numeric <= 0/i);
  assert.match(functionBody, /consumedHours'\)::numeric < 0/i);
  assert.match(functionBody, /invalid_student_import_complete_package_balance/i);
  assert.match(
    functionBody,
    /packageCoverage' = 'complete'[\s\S]*importArchived'[\s\S]*is false[\s\S]*invalid_student_import_complete_package_balance/i,
  );
  assert.match(
    functionBody,
    /purchasedAt'[\s\S]*\^\(\\d\{4\}-\\d\{2\}-\\d\{2\}\|\\d\{4\}-\\d\{2\}-\\d\{2\}T/i,
  );
  assert.match(functionBody, /student_import_has_microhour_precision/i);
  assert.match(functionBody, /remainingHours'\)::numeric < 0[\s\S]*packageCoverage[\s\S]*none/i);
  assert.match(functionBody, /not \(s \? 'packageCoverage'\)[\s\S]*PKG-JWB-%/i);
  assert.match(functionBody, /coalesce\(s ->> 'packageCoverage', ''\) <> 'none'/i);
  for (const requiredField of [
    "initials", "owner", "course", "timezone", "teacher", "next", "nextTone", "files",
  ]) {
    assert.match(
      functionBody,
      new RegExp(`s -> '${requiredField}'|s ->> '${requiredField}'`, "i"),
      `commit must validate the UI-required ${requiredField} field`,
    );
  }
  assert.match(functionBody, /nextTone'[\s\S]*neutral[\s\S]*purple/i);
  assert.match(functionBody, /files'\)::numeric <> trunc/i);
});

test("student packages may share a subject while each package keeps unique bindings", () => {
  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.doesNotMatch(
    commitBody,
    /sum\(jsonb_array_length\(lesson_package -> 'subjectIds'\)\)[\s\S]*count\(distinct trim\(subject #>> '\{\}'\)\)/i,
  );
  assert.match(
    commitBody,
    /jsonb_array_elements\(lesson_package_item -> 'subjectIds'\)[\s\S]*count\(distinct trim\(subject #>> '\{\}'\)\)/i,
  );
});

test("student source ingest bounds every nested JWB audit collection and identifier", () => {
  const ingestBody = sql.slice(
    sql.indexOf("create or replace function public.put_student_import_source_rows"),
    sql.indexOf("create or replace function public.get_latest_student_import_source_rows"),
  );
  assert.match(ingestBody, /unresolvedCourseBalances'[\s\S]*jsonb_array_length[\s\S]*> 1000/i);
  assert.match(ingestBody, /adjustmentContracts'[\s\S]*jsonb_array_length[\s\S]*> 1000/i);
  assert.match(ingestBody, /length\(trim\(unresolved ->> 'courseId'\)\) > 240/i);
  assert.match(ingestBody, /length\(trim\(unresolved ->> 'title'\)\) > 240/i);
  assert.match(ingestBody, /length\(trim\(adjustment ->> 'contractId'\)\) > 240/i);
  assert.match(ingestBody, /length\(trim\(adjustment ->> 'courseId'\)\) > 240/i);
  assert.match(ingestBody, /student_import_canonical_jwb_packages/i);
  assert.match(sql, /student_import_microhour_precision_fixture_mismatch/i);
  assert.match(sql, /student_import_timezone_ascii_boundary_fixture_mismatch/i);
});

test("teacher import locks both workbook revisions, teacher state and stable identities", () => {
  assert.match(sql, /create table if not exists internal\.teacher_import_sources/i);
  assert.match(sql, /create table if not exists internal\.teacher_import_commits/i);
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_teacher_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_teacher_import_plan_atomic"),
  );
  assert.match(functionBody, /where s\.workbook = 'k12' for update/i);
  assert.match(functionBody, /where s\.workbook = 'university' for update/i);
  assert.match(functionBody, /where s\.entity = 'teachers' for update/i);
  assert.match(functionBody, /k12\.revision <> p_source_revisions ->> 'k12'/i);
  assert.match(functionBody, /university\.revision <> p_source_revisions ->> 'university'/i);
  assert.match(functionBody, /current_state\.version <> p_expected_teacher_version/i);
  assert.match(functionBody, /teacher_import_existing_teacher_removed/i);
  assert.match(functionBody, /teacher_import_roster_reference_mismatch/i);
  assert.match(functionBody, /teacher_import_sheet_contract_changed/i);
  assert.match(functionBody, /insert into internal\.teacher_import_commits/i);
  assert.match(functionBody, /teacher_import\.committed/i);
});

test("teacher import replay revalidates current sources, decisions and committed state", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_teacher_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_teacher_import_plan_atomic"),
  );
  const priorAt = functionBody.indexOf("from internal.teacher_import_commits c");
  const sourceLockAt = functionBody.indexOf("where s.workbook = 'k12' for update");
  const replayReturnAt = functionBody.indexOf("prior.committed_by,\n      false");
  const hardResolutionCheckAt = functionBody.indexOf("teacher_import_hard_resolutions_changed");
  const identityResolutionCheckAt = functionBody.lastIndexOf("teacher_import_identity_links_changed");

  assert.match(functionBody, /replaying_prior boolean := false/i);
  assert.match(functionBody, /replaying_prior := true/i);
  assert.match(functionBody, /current_state\.version <> prior\.teachers_version/i);
  assert.match(functionBody, /digest\(current_state\.payload::text, 'sha256'\)[\s\S]*prior\.teachers_sha256/i);
  assert.match(functionBody, /teacher_import_idempotent_state_changed/i);
  assert.match(functionBody, /elsif current_state\.version <> p_expected_teacher_version/i);
  assert.ok(priorAt >= 0 && sourceLockAt > priorAt, "replay lookup must precede canonical source locks");
  assert.ok(replayReturnAt > sourceLockAt, "replay must not return before source and state locks");
  assert.ok(replayReturnAt > hardResolutionCheckAt, "replay must revalidate hard resolutions");
  assert.ok(replayReturnAt > identityResolutionCheckAt, "replay must revalidate identity resolutions");
  assert.match(functionBody, /current_state\.updated_by,\n\s+true/i);
});

test("teacher source ingest is revision-idempotent and serialises first writes", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.put_teacher_import_source"),
    sql.indexOf("create or replace function public.get_latest_teacher_import_sources"),
  );
  assert.match(functionBody, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.match(functionBody, /teacher_import_revision_conflict/i);
  assert.match(functionBody, /saved\.snapshot_sha256 = snapshot_hash/i);
  assert.match(functionBody, /'unchanged', true/i);
  assert.match(functionBody, /teacher_import\.source_ingested/i);
  assert.match(functionBody, /\(r -> 'attributes'\) - ARRAY\['location'\]::text\[\] <> '\{\}'::jsonb/i);
});

test("source ingest repair disambiguates JSONB subtraction and preserves the teacher RPC contract", () => {
  const functionBody = sourcePrecedenceFixSql.slice(
    sourcePrecedenceFixSql.indexOf("create or replace function public.put_teacher_import_source"),
    sourcePrecedenceFixSql.indexOf("revoke all on function public.put_teacher_import_source"),
  );
  assert.match(functionBody, /\(r -> 'attributes'\) - ARRAY\['location'\]::text\[\] <> '\{\}'::jsonb/i);
  assert.doesNotMatch(functionBody, /\br -> 'attributes' - 'location'/i);
  assert.match(functionBody, /security definer[\s\S]*set search_path = ''/i);
  assert.match(functionBody, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(functionBody, /teacher_import\.source_ingested/i);
  assert.match(
    sourcePrecedenceFixSql,
    /revoke all on function public\.put_teacher_import_source\(text, text, text, text, jsonb, jsonb, jsonb, text\)[\s\S]*grant execute/i,
  );
});

test("source ingest repair disambiguates every student JSONB attributes allow-list", () => {
  const functionBody = sourcePrecedenceFixSql.slice(
    sourcePrecedenceFixSql.indexOf("create or replace function public.put_student_import_source_rows"),
    sourcePrecedenceFixSql.indexOf("revoke all on function public.put_student_import_source_rows"),
  );
  assert.match(functionBody, /\(r -> 'attributes'\)[\s\S]*ARRAY\['location', 'year', 'owner', 'planner'\]::text\[\]/i);
  assert.match(functionBody, /\(r -> 'attributes'\) - ARRAY\['jiaowubaoPackageImport'\]::text\[\]/i);
  assert.match(functionBody, /\(r -> 'attributes' -> 'jiaowubaoPackageImport'\) - ARRAY\[[\s\S]*'adjustmentContracts'[\s\S]*\]::text\[\]/i);
  assert.doesNotMatch(functionBody, /\br -> 'attributes'\s*-\s*'(?:location|jiaowubaoPackageImport)'/i);
  assert.doesNotMatch(functionBody, /\br -> 'attributes'\s*->\s*'jiaowubaoPackageImport'\s*-\s*'status'/i);
  assert.match(functionBody, /security definer[\s\S]*set search_path = ''/i);
  assert.match(functionBody, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(functionBody, /student_import\.source_ingested/i);
  assert.match(
    sourcePrecedenceFixSql,
    /revoke all on function public\.put_student_import_source_rows\(text, text, text, text, jsonb, text\)[\s\S]*grant execute/i,
  );
  assert.match(sourcePrecedenceFixSql, /import_source_jsonb_precedence_fixture_mismatch_teacher/i);
  assert.match(sourcePrecedenceFixSql, /import_source_jsonb_precedence_fixture_mismatch_student_master/i);
  assert.match(sourcePrecedenceFixSql, /import_source_jsonb_precedence_fixture_mismatch_student_jwb_outer/i);
  assert.match(sourcePrecedenceFixSql, /import_source_jsonb_precedence_fixture_mismatch_student_jwb_nested/i);
});

test("import migrations contain no unparenthesized JSON extraction followed by text subtraction", () => {
  const ambiguousJsonbSubtraction = /->\s*'[^']+'\s*-\s*'[^']+'/i;
  assert.doesNotMatch(sql, ambiguousJsonbSubtraction);
  assert.doesNotMatch(sourcePrecedenceFixSql, ambiguousJsonbSubtraction);
});

test("teacher identity links are opaque, revision-bound, auditable and revalidated on commit", () => {
  assert.match(sql, /create table if not exists internal\.teacher_import_identity_links/i);
  const putBody = sql.slice(
    sql.indexOf("create or replace function public.put_teacher_import_identity_link"),
    sql.indexOf("revoke all on function public.put_teacher_import_source"),
  );
  assert.match(putBody, /p_resolution_key text/i);
  assert.match(putBody, /p_decision text/i);
  assert.match(putBody, /p_decision not in \('merge', 'separate'\)/i);
  assert.doesNotMatch(putBody, /p_teacher_id|p_source_refs/i);
  assert.match(putBody, /internal\.teacher_import_database_name_key\(row_value ->> 'name'\)/i);
  assert.match(putBody, /with k12_unique as materialized/i);
  assert.match(putBody, /join university_unique ur using \(name_key\)/i);
  assert.match(putBody, /k12\.revision.*university\.revision/is);
  assert.match(putBody, /teacher_import\.identity_link_confirmed/i);
  assert.match(putBody, /pg_catalog\.pg_advisory_xact_lock/i);

  const getBody = sql.slice(
    sql.indexOf("create or replace function public.get_latest_teacher_import_sources"),
    sql.indexOf("create or replace function public.put_teacher_import_identity_link"),
  );
  assert.match(getBody, /'identityLinks'/i);
  assert.match(getBody, /'decision', l\.decision/i);
  assert.match(getBody, /l\.k12_revision = k12\.revision/i);
  assert.match(getBody, /l\.university_revision = university\.revision/i);

  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_teacher_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_teacher_import_plan_atomic"),
  );
  assert.match(commitBody, /teacher_import_identity_link_required/i);
  assert.match(commitBody, /existing_teacher ->> 'id' = t ->> 'id'/i);
  assert.match(commitBody, /current_state\.payload\) existing_teacher/i);
  assert.match(commitBody, /teacher_import_identity_links_changed/i);
  assert.match(commitBody, /case l\.decision/i);
});

test("teacher V2 hard resolutions are closed, revision-bound and enforced again at commit", () => {
  assert.match(sql, /create table if not exists internal\.teacher_import_hard_resolutions/i);
  assert.match(sql, /create or replace function internal\.teacher_import_hard_candidates/i);
  const keyBody = sql.slice(
    sql.indexOf("create or replace function internal.teacher_import_hard_key"),
    sql.indexOf("create or replace function internal.teacher_import_hard_candidates"),
  );
  assert.match(keyBody, /sourceId', 'UTF8'\);[\s\S]*decode\('00', 'hex'\)[\s\S]*sheetName/i);
  assert.match(keyBody, /sheetName', 'UTF8'\);[\s\S]*decode\('00', 'hex'\)[\s\S]*sourceRow/i);
  for (const fixture of [
    "sha256:1d3a46fd4b218aa83738a732628cfd57fdba8dc5045c8537cf2b92d7103b1c67",
    "sha256:cbe8d81ca7a47e98f14a30cb5e799f042371d72d6db5e0462f46c92364a8e328",
    "sha256:cd624be68238fec52227362399eed001d2d0b6e463bdff0f966de6ca177d2eac",
    "sha256:3b62fca49e69afceb26cef4779c94679433c0a4c91760f9bf03cc282f30be214",
  ]) assert.match(sql, new RegExp(fixture));
  assert.match(sql, /teacher_hard_key_fixture_mismatch_same_workbook/i);
  assert.match(sql, /teacher_hard_key_fixture_mismatch_cross_workbook/i);
  assert.match(sql, /teacher_hard_key_fixture_mismatch_subject_ignore/i);
  assert.match(sql, /teacher_hard_key_fixture_mismatch_subject_assign/i);
  assert.match(sql, /create or replace function internal\.teacher_import_database_name_key/i);
  assert.match(sql, /teacher_name_contract_fixture_mismatch_nfkc_v2_pair/i);
  assert.match(sql, /teacher_hard_candidate_fixture_mismatch_nfkc_v2_pair/i);
  for (const fixture of [
    "sha256:bfbc3e5b70c4e35ee6a87cab1a5530722d36bc519c0df1497ddca92badcb303d",
    "sha256:c2b46c06370631eaa84f87085cc1407e6a7384cadbdb2bdf4bdf6faf95245ec6",
    "sha256:1390b9b37ec5e3c3bba8ec4b59915c92ecb2ae5c104c2f1f77bd47a1b381ad4a",
    "sha256:5a8bdd161a397c3f996bb2c57749a230fb4671e3e374dd607e03269ea10a1912",
  ]) assert.match(sql, new RegExp(fixture));
  const candidateBody = sql.slice(
    sql.indexOf("create or replace function internal.teacher_import_hard_candidates"),
    sql.indexOf("revoke all on function internal.teacher_import_name_key"),
  );
  assert.match(candidateBody, /count\(distinct internal\.teacher_import_database_name_key\(source_row ->> 'name'\)\) = 1/i);
  assert.match(candidateBody, /count\(\*\) = 2[\s\S]*workbook = 'k12'[\s\S]*workbook = 'university'[\s\S]*teacher_import_database_name_key/i);
  const putBody = sql.slice(
    sql.indexOf("create or replace function public.put_teacher_import_hard_resolution"),
    sql.indexOf("revoke all on function public.put_teacher_import_source"),
  );
  assert.match(putBody, /where s\.workbook = 'k12' for update/i);
  assert.match(putBody, /where s\.workbook = 'university' for update/i);
  assert.match(putBody, /teacher_import_hard_candidate_by_key\([\s\S]*k12,[\s\S]*university,[\s\S]*p_resolution_key,[\s\S]*p_decision/i);
  assert.doesNotMatch(putBody, /teacher_import_hard_candidates\(k12, university\)/i);
  assert.doesNotMatch(putBody, /p_(?:teacher|source|subject|roster|row|name)/i);
  assert.match(putBody, /teacher_import\.hard_resolution_confirmed/i);
  assert.match(putBody, /pg_catalog\.pg_advisory_xact_lock/i);

  const getBody = sql.slice(
    sql.indexOf("create or replace function public.get_latest_teacher_import_sources"),
    sql.indexOf("create or replace function public.put_teacher_import_identity_link"),
  );
  assert.match(getBody, /'hardResolutions'/i);
  assert.match(getBody, /r\.k12_revision = k12\.revision/i);
  assert.match(getBody, /r\.university_revision = university\.revision/i);

  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.commit_teacher_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_teacher_import_plan_atomic"),
  );
  assert.match(commitBody, /teacher_import_hard_resolution_required/i);
  assert.match(commitBody, /teacher_import_hard_resolutions_changed/i);
  assert.match(commitBody, /hard_candidates := internal\.teacher_import_hard_candidates\(k12, university\)/i);
  assert.match(commitBody, /r\.decision = 'assign'/i);
  assert.match(commitBody, /r\.subject_ref ->> 'sheetName'/i);
  assert.match(commitBody, /r\.kind = 'cross_workbook_identity'[\s\S]*r\.decision = 'merge'/i);
  assert.match(commitBody, /join jsonb_array_elements\(r\.source_refs\) decision_ref/i);
  assert.match(commitBody, /jsonb_array_length\(r\.source_refs\)/i);
});

test("teacher resolution lookup hotfix removes the timeout-shaped query plans", () => {
  for (const name of [
    "internal.teacher_import_hard_candidates",
    "internal.teacher_import_hard_candidate_by_key",
    "public.put_teacher_import_identity_link",
    "public.put_teacher_import_hard_resolution",
  ]) {
    assert.equal(
      sqlFunction(teacherResolutionLookupFixSql, name),
      sqlFunction(sql, name),
      `${name} forward repair must match the canonical contract`,
    );
  }

  const v1Body = sqlFunction(teacherResolutionLookupFixSql, "public.put_teacher_import_identity_link");
  assert.match(v1Body, /with k12_unique as materialized/i);
  assert.match(v1Body, /university_unique as materialized/i);
  assert.match(v1Body, /having count\(\*\) = 1/i);
  assert.match(v1Body, /join university_unique ur using \(name_key\)/i);
  assert.doesNotMatch(v1Body, /cross join jsonb_array_elements\(university\.roster_rows\)/i);
  assert.doesNotMatch(v1Body, /select count\(\*\) from jsonb_array_elements\((?:k12|university)\.roster_rows\)/i);
  assert.match(v1Body, /teacher-import-identity-link-v1/i);
  assert.match(v1Body, /expected_key <> p_resolution_key/i);

  const candidateBody = sqlFunction(teacherResolutionLookupFixSql, "internal.teacher_import_hard_candidates");
  assert.match(candidateBody, /jsonb_agg\(option order by roster_ordinality\)/i);
  assert.match(candidateBody, /with ordinality/i);
  assert.doesNotMatch(candidateBody, /for roster_row in select value from jsonb_array_elements\(candidate_rows\)/i);

  const oneKeyBody = sqlFunction(teacherResolutionLookupFixSql, "internal.teacher_import_hard_candidate_by_key");
  const identityBranch = oneKeyBody.indexOf("if p_decision in ('merge', 'separate')");
  const subjectScan = oneKeyBody.indexOf("for subject_record in");
  assert.ok(identityBranch >= 0 && subjectScan > identityBranch);
  assert.match(oneKeyBody.slice(identityBranch, subjectScan), /return null;/i);
  assert.match(oneKeyBody, /if p_decision = 'ignore'/i);
  assert.match(oneKeyBody, /continue;[\s\S]*return jsonb_build_object/i);
  assert.match(sql, /teacher_hard_candidate_by_key_fixture_option_count/i);
  assert.match(sql, /teacher_hard_candidate_by_key_fixture_mismatch/i);
  assert.match(sql, /teacher_hard_candidate_by_key_fixture_unknown_key/i);
  assert.match(teacherResolutionLookupFixSql, /teacher_hard_candidate_by_key_fixture_option_count/i);
  assert.match(teacherResolutionLookupFixSql, /teacher_hard_candidate_by_key_fixture_mismatch/i);
  assert.match(teacherResolutionLookupFixSql, /teacher_hard_candidate_by_key_fixture_unknown_key/i);

  const hardPutBody = sqlFunction(teacherResolutionLookupFixSql, "public.put_teacher_import_hard_resolution");
  assert.match(hardPutBody, /candidate := internal\.teacher_import_hard_candidate_by_key/i);
  assert.doesNotMatch(hardPutBody, /jsonb_array_elements\(internal\.teacher_import_hard_candidates/i);
  assert.match(hardPutBody, /teacher_import\.hard_resolution_confirmed/i);
  assert.match(hardPutBody, /pg_catalog\.pg_advisory_xact_lock/i);

  assert.match(teacherResolutionLookupFixSql, /revoke all on function internal\.teacher_import_hard_candidate_by_key/i);
  assert.match(teacherResolutionLookupFixSql, /revoke all on function public\.put_teacher_import_identity_link/i);
  assert.match(teacherResolutionLookupFixSql, /grant execute on function public\.put_teacher_import_identity_link/i);
  assert.match(teacherResolutionLookupFixSql, /revoke all on function public\.put_teacher_import_hard_resolution/i);
  assert.match(teacherResolutionLookupFixSql, /grant execute on function public\.put_teacher_import_hard_resolution/i);
});

test("student import archive markers preserve only referenced excluded historical IDs", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_student_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_student_import_plan_atomic"),
  );
  assert.match(functionBody, /jsonb_typeof\(s -> 'importArchived'\) <> 'boolean'/i);
  assert.match(functionBody, /importArchivedReason' <> 'referenced_history'/i);
  assert.match(functionBody, /s ->> 'status' <> '不活跃 \+ 无课时'/i);
  assert.match(functionBody, /not \(s \? 'importArchived'\) and s \? 'importArchivedReason'/i);
  assert.match(functionBody, /current_state\.payload\) old_student/i);
  assert.match(functionBody, /jsonb_array_elements_text\(referenced_student_ids\)[\s\S]*referenced_student_id = archived_student ->> 'id'/i);
  assert.match(functionBody, /jsonb_array_elements\(resolved_master_rows\) eligible_master_row/i);
  assert.match(functionBody, /eligible_master_row ->> 'status' <> '不活跃 \+ 无课时'/i);
  assert.match(functionBody, /link ->> 'studentId' = archived_student ->> 'id'/i);
  assert.doesNotMatch(functionBody, /old_student ->> '(?:masterSourceKey|sourceRow)' = eligible_master_row ->> 'sourceRow'/i);
  assert.match(functionBody, /student_import_invalid_archive/i);
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

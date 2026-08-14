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
const teacherSubjectResolutionSetFixSql = await readFile(
  new URL(
    "../supabase/migrations/20260814170000_optimize_teacher_subject_resolution_set.sql",
    import.meta.url,
  ),
  "utf8",
);
const teacherAuthoritySql = await readFile(
  new URL(
    "../supabase/migrations/20260814184500_enforce_authoritative_teacher_import.sql",
    import.meta.url,
  ),
  "utf8",
);
const teacherAuthorityPerformanceSql = await readFile(
  new URL(
    "../supabase/migrations/20260814223000_optimize_authoritative_teacher_validation.sql",
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
  assert.match(functionBody, /where source_row\.workbook = 'k12'\s+for update/i);
  assert.match(functionBody, /where source_row\.workbook = 'university'\s+for update/i);
  assert.match(functionBody, /where state_row\.entity = 'teachers'\s+for update/i);
  assert.match(functionBody, /k12\.revision <> p_source_revisions ->> 'k12'/i);
  assert.match(functionBody, /university\.revision <> p_source_revisions ->> 'university'/i);
  assert.match(functionBody, /current_state\.version <> p_expected_teacher_version/i);
  assert.match(sql, /teacher_import_existing_teacher_removed/i);
  assert.match(functionBody, /assert_teacher_import_authoritative_plan/i);
  assert.match(sql, /teacher_import_authoritative_reference_mismatch/i);
  assert.match(functionBody, /teacher_import_sheet_contract_changed/i);
  assert.match(functionBody, /insert into internal\.teacher_import_commits/i);
  assert.match(functionBody, /teacher_import\.committed/i);
});

test("teacher import replay revalidates current sources, authority closure and committed state", () => {
  const functionBody = sql.slice(
    sql.indexOf("create or replace function public.commit_teacher_import_plan_atomic"),
    sql.indexOf("revoke all on function public.commit_teacher_import_plan_atomic"),
  );
  const priorAt = functionBody.indexOf("from internal.teacher_import_commits c");
  const sourceLockAt = functionBody.indexOf("where source_row.workbook = 'k12'");
  const replayReturnAt = functionBody.indexOf("prior.committed_by,\n      false");
  const authorityCheckAt = functionBody.indexOf("assert_teacher_import_authoritative_plan");

  assert.match(functionBody, /replaying_prior boolean := false/i);
  assert.match(functionBody, /replaying_prior := true/i);
  assert.match(functionBody, /current_state\.version <> prior\.teachers_version/i);
  assert.match(functionBody, /digest\(current_state\.payload::text, 'sha256'\)[\s\S]*prior\.teachers_sha256/i);
  assert.match(functionBody, /teacher_import_idempotent_state_changed/i);
  assert.match(functionBody, /elsif current_state\.version <> p_expected_teacher_version/i);
  assert.ok(priorAt >= 0 && sourceLockAt > priorAt, "replay lookup must precede canonical source locks");
  assert.ok(replayReturnAt > sourceLockAt, "replay must not return before source and state locks");
  assert.ok(replayReturnAt > authorityCheckAt, "replay must revalidate exact-name authority closure");
  assert.doesNotMatch(functionBody, /teacher_import_(?:hard_resolutions|identity_links)/i);
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
  assert.doesNotMatch(teacherAuthoritySql, ambiguousJsonbSubtraction);
  assert.doesNotMatch(teacherAuthorityPerformanceSql, ambiguousJsonbSubtraction);
});

test("teacher identity links remain opaque, revision-bound audit history", () => {
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
  assert.doesNotMatch(commitBody, /teacher_import_identity_links/i);
  assert.doesNotMatch(commitBody, /teacher_import_identity_link_required/i);
  assert.match(commitBody, /assert_teacher_import_authoritative_plan/i);
});

test("teacher V2 hard resolutions remain closed, revision-bound audit history", () => {
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
  assert.doesNotMatch(commitBody, /teacher_import_hard_resolutions/i);
  assert.doesNotMatch(commitBody, /teacher_import_hard_resolution_required/i);
  assert.doesNotMatch(commitBody, /teacher_import_subject_hard_candidate_basis/i);
  assert.match(commitBody, /assert_teacher_import_authoritative_plan/i);
});

test("teacher resolution lookup hotfix removes the timeout-shaped query plans", () => {
  for (const name of [
    "public.put_teacher_import_identity_link",
    "public.put_teacher_import_hard_resolution",
  ]) {
    assert.equal(
      sqlFunction(teacherResolutionLookupFixSql, name),
      sqlFunction(sql, name),
      `${name} first forward repair must match the canonical contract`,
    );
  }
  for (const name of [
    "internal.teacher_import_subject_hard_candidate_basis",
    "internal.teacher_import_subject_hard_candidate_rows",
    "internal.teacher_import_hard_candidates",
    "internal.teacher_import_hard_candidate_by_key",
  ]) {
    assert.equal(
      sqlFunction(teacherSubjectResolutionSetFixSql, name),
      sqlFunction(sql, name),
      `${name} latest forward repair must match the canonical contract`,
    );
  }
  assert.notEqual(
    sqlFunction(teacherSubjectResolutionSetFixSql, "public.commit_teacher_import_plan_atomic"),
    sqlFunction(sql, "public.commit_teacher_import_plan_atomic"),
    "the later authority migration intentionally replaces the resolution-gated commit",
  );

  const v1Body = sqlFunction(teacherResolutionLookupFixSql, "public.put_teacher_import_identity_link");
  assert.match(v1Body, /with k12_unique as materialized/i);
  assert.match(v1Body, /university_unique as materialized/i);
  assert.match(v1Body, /having count\(\*\) = 1/i);
  assert.match(v1Body, /join university_unique ur using \(name_key\)/i);
  assert.doesNotMatch(v1Body, /cross join jsonb_array_elements\(university\.roster_rows\)/i);
  assert.doesNotMatch(v1Body, /select count\(\*\) from jsonb_array_elements\((?:k12|university)\.roster_rows\)/i);

  const basisBody = sqlFunction(teacherSubjectResolutionSetFixSql, "internal.teacher_import_subject_hard_candidate_basis");
  for (const cte of ["roster_raw", "roster", "subject_raw", "subjects", "match_counts", "blocking_subjects", "blocking_options", "candidate_assignments"]) {
    assert.match(basisBody, new RegExp(`${cte} as materialized`, "i"));
  }
  assert.match(basisBody, /teacher_import_name_key\(roster_raw\.roster_row ->> 'name'\) as name_key/i);
  assert.match(basisBody, /teacher_import_name_key\(subject_raw\.subject_row ->> 'name'\) as name_key/i);
  assert.match(basisBody, /m\.exact_count > 1/i);
  assert.match(basisBody, /m\.operational_count > 1/i);
  assert.match(basisBody, /m\.nickname_count <> 1/i);
  assert.match(basisBody, /b\.exact_count = 0[\s\S]*b\.operational_count = 0[\s\S]*b\.nickname_count <> 1/i);
  assert.doesNotMatch(basisBody, /for subject_record|for roster_row/i);

  const rowsBody = sqlFunction(teacherSubjectResolutionSetFixSql, "internal.teacher_import_subject_hard_candidate_rows");
  assert.match(rowsBody, /p_resolution_key text/i);
  assert.match(rowsBody, /assignment_keys as materialized/i);
  assert.match(rowsBody, /select distinct on \(b\.resolution_group_key collate "C"\)[\s\S]*order by\s+b\.resolution_group_key collate "C"/i);
  assert.doesNotMatch(rowsBody, /select distinct on \(b\.resolution_group_key\)/i);
  assert.match(rowsBody, /p_resolution_key is null or a\.resolution_key = p_resolution_key/i);
  assert.match(rowsBody, /jsonb_build_array\(b\.subject_ref_key, b\.roster_ref_key\), 'assign'/i);

  const candidateBody = sqlFunction(teacherSubjectResolutionSetFixSql, "internal.teacher_import_hard_candidates");
  assert.match(candidateBody, /teacher_import_subject_hard_candidate_rows\([\s\S]*null, null/i);
  assert.doesNotMatch(candidateBody, /for subject_record|for roster_row/i);

  const oneKeyBody = sqlFunction(teacherSubjectResolutionSetFixSql, "internal.teacher_import_hard_candidate_by_key");
  assert.match(oneKeyBody, /teacher_import_subject_hard_candidate_rows\([\s\S]*p_decision, p_resolution_key/i);
  assert.doesNotMatch(oneKeyBody, /for subject_record|jsonb_array_elements\(p_k12\.subject_rows\)/i);

  const commitBody = sqlFunction(teacherSubjectResolutionSetFixSql, "public.commit_teacher_import_plan_atomic");
  assert.match(commitBody, /teacher_import_subject_hard_candidate_basis\(k12, university\)/i);
  assert.equal((commitBody.match(/teacher_import_subject_hard_candidate_basis\(k12, university\)/gi) ?? []).length, 1);
  assert.match(commitBody, /subjectRefKey/i);
  assert.match(commitBody, /rosterRefKey/i);
  assert.match(commitBody, /select distinct basis ->> 'resolutionGroupKey'/i);
  assert.doesNotMatch(commitBody, /internal\.teacher_import_hard_candidates\(k12, university\)/i);
  assert.match(commitBody, /teacher_import_hard_resolution_required/i);
  assert.match(commitBody, /teacher_import_hard_resolutions_changed/i);

  for (const source of [sql, teacherSubjectResolutionSetFixSql]) {
    assert.match(source, /teacher_hard_candidate_by_key_fixture_option_count/i);
    assert.match(source, /teacher_hard_candidate_by_key_fixture_mismatch/i);
    assert.match(source, /teacher_hard_candidate_by_key_fixture_unknown_key/i);
  }

  const hardPutBody = sqlFunction(teacherResolutionLookupFixSql, "public.put_teacher_import_hard_resolution");
  assert.match(hardPutBody, /candidate := internal\.teacher_import_hard_candidate_by_key/i);
  assert.match(hardPutBody, /teacher_import\.hard_resolution_confirmed/i);
  assert.match(hardPutBody, /pg_catalog\.pg_advisory_xact_lock/i);

  assert.match(teacherSubjectResolutionSetFixSql, /drop function if exists internal\.teacher_import_subject_hard_candidate_rows/i);
  assert.match(teacherSubjectResolutionSetFixSql, /revoke all on function internal\.teacher_import_subject_hard_candidate_basis/i);
  assert.match(teacherSubjectResolutionSetFixSql, /revoke all on function internal\.teacher_import_subject_hard_candidate_rows/i);
  assert.match(teacherSubjectResolutionSetFixSql, /revoke all on function public\.commit_teacher_import_plan_atomic/i);
  assert.match(teacherSubjectResolutionSetFixSql, /grant execute on function public\.commit_teacher_import_plan_atomic/i);
});

test("teacher authority migration enforces the exact-name roster plus subject-tab union", () => {
  for (const name of [
    "internal.teacher_import_clean_text",
    "internal.teacher_import_js_trim",
    "internal.teacher_import_initials",
    "internal.teacher_import_timezone_for_location",
    "internal.teacher_import_name_key",
    "internal.teacher_import_authoritative_id",
    "internal.teacher_import_authoritative_ref_basis",
    "internal.teacher_import_authoritative_row_basis",
    "internal.teacher_import_authoritative_subject_basis",
    "internal.teacher_import_authoritative_detail_basis",
    "internal.teacher_import_expected_operational_fragments",
    "internal.assert_teacher_import_authoritative_plan",
    "internal.assert_teacher_import_plan_shape",
    "public.commit_teacher_import_plan_atomic",
  ]) {
    assert.equal(
      sqlFunction(teacherAuthoritySql, name),
      sqlFunction(sql, name),
      `${name} forward migration must match the canonical contract`,
    );
  }

  const cleanTextBody = sqlFunction(teacherAuthoritySql, "internal.teacher_import_clean_text");
  assert.match(cleanTextBody, /normalize\(coalesce\(p_value, ''\), NFKC\)/i);
  assert.match(cleanTextBody, /U&'\\200B\\200C\\200D\\FEFF'/i);
  assert.match(cleanTextBody, /\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000/i);
  assert.match(cleanTextBody, /select nullif\(pg_catalog\.btrim\(pg_catalog\.regexp_replace/i);
  assert.doesNotMatch(cleanTextBody, /ABCDEFGHIJKLMNOPQRSTUVWXYZ|pg_catalog\.lower|\blower\s*\(/i);

  const jsTrimBody = sqlFunction(teacherAuthoritySql, "internal.teacher_import_js_trim");
  assert.match(jsTrimBody, /pg_catalog\.btrim\([\s\S]*\\FEFF/i);
  assert.doesNotMatch(jsTrimBody, /normalize|regexp_replace|teacher_import_clean_text/i);

  const initialsBody = sqlFunction(teacherAuthoritySql, "internal.teacher_import_initials");
  assert.match(initialsBody, /normalize\(coalesce\(p_name, ''\), NFKC\)/i);
  assert.match(initialsBody, /regexp_split_to_array\([\s\S]*\\00B7\\30FB_-/i);
  assert.match(initialsBody, /cardinality\(tokens\) > 1/i);
  assert.match(initialsBody, /pg_catalog\.substr\(tokens\[1\], 1, 1\)/i);
  assert.doesNotMatch(initialsBody, /pg_catalog\.substring/i);
  assert.match(initialsBody, /translate\(result, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'\)/i);
  assert.doesNotMatch(initialsBody, /teacher_import_clean_text|pg_catalog\.upper/i);

  const timezoneBody = sqlFunction(teacherAuthoritySql, "internal.teacher_import_timezone_for_location");
  for (const timezone of [
    "Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane",
    "Australia/Adelaide", "Australia/Perth", "Australia/Hobart",
    "Australia/Darwin", "Asia/Shanghai",
  ]) assert.match(timezoneBody, new RegExp(timezone.replace("/", "\\/")));
  assert.match(timezoneBody, /\(\^\|\[\^a-z0-9_\]\)\(melbourne\|vic\|victoria\)/i);
  assert.match(timezoneBody, /'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[\s\S]*'abcdefghijklmnopqrstuvwxyz'/i);
  assert.match(timezoneBody, /pg_catalog\.strpos\(location_key, '墨尔本'\)/i);
  assert.doesNotMatch(timezoneBody, /pg_catalog\.(?:lower|position|substring)|auckland|argentina|bosnia/i);

  const nameKeyBody = sqlFunction(teacherAuthoritySql, "internal.teacher_import_name_key");
  assert.match(nameKeyBody, /normalize\(coalesce\(p_name, ''\), NFKC\)/i);
  assert.match(nameKeyBody, /parser to pg_catalog\.normalize/i);
  assert.match(nameKeyBody, /U&'\\200B\\200C\\200D\\FEFF'/i);
  assert.match(nameKeyBody, /\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000/i);
  assert.match(nameKeyBody, /pg_catalog\.translate\([\s\S]*'ABCDEFGHIJKLMNOPQRSTUVWXYZ',[\s\S]*'abcdefghijklmnopqrstuvwxyz'/i);
  assert.doesNotMatch(nameKeyBody, /pg_catalog\.lower|\blower\s*\(/i);
  assert.match(teacherAuthoritySql, /teacher_name_contract_fixture_mismatch_fullwidth_punctuation/i);
  assert.match(teacherAuthoritySql, /teacher_name_contract_fixture_mismatch_nfkc_ascii_case_runtime/i);
  assert.match(teacherAuthoritySql, /teacher_import_name_key\('老师，A：B'\)[\s\S]*teacher_import_name_key\('老师,A:B'\)/i);
  assert.match(teacherAuthoritySql, /teacher_import_name_key\('ASCII CASE'\) <> 'ascii case'/i);
  assert.match(teacherAuthoritySql, /teacher_import_name_key\('Oﬁ ＆ CO'\) <> 'ofi & co'/i);
  assert.match(teacherAuthoritySql, /teacher_import_name_key\('ÉLODIE'\) <> 'Élodie'/i);
  assert.match(teacherAuthoritySql, /teacher_import_name_key\('İSTANBUL'\) <> 'İstanbul'/i);
  assert.match(teacherAuthoritySql, /teacher_import_name_key\('ΑΒΓ ABC'\) <> 'ΑΒΓ abc'/i);

  const authorityIdBody = sqlFunction(teacherAuthoritySql, "internal.teacher_import_authoritative_id");
  assert.match(authorityIdBody, /'TEA-TX-A-' \|\| encode\(extensions\.digest/i);
  assert.match(authorityIdBody, /convert_to\(internal\.teacher_import_name_key\(p_name\), 'UTF8'\)/i);
  assert.match(authorityIdBody, /'sha256'/i);
  assert.doesNotMatch(authorityIdBody, /source_id|source_row|workbook/i);
  assert.match(teacherAuthoritySql, /teacher_authoritative_id_contract_fixture_mismatch/i);
  assert.match(teacherAuthoritySql, /TEA-TX-A-ed62142be3bc6f1f3c19457d0d78fee6210f3e287cd6df153c4ea5b131f98b68/i);
  assert.match(teacherAuthoritySql, /TEA-TX-A-831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a/i);

  const refBasis = sqlFunction(teacherAuthoritySql, "internal.teacher_import_authoritative_ref_basis");
  assert.match(refBasis, /source_id \|\| '#subjects'/i);
  assert.match(refBasis, /'name:' \|\| encode\(extensions\.digest\([\s\S]*convert_to\(subject_name\.name_key, 'UTF8'\)/i);
  assert.match(refBasis, /where not exists \([\s\S]*roster\.workbook = subject_name\.workbook[\s\S]*roster\.name_key = subject_name\.name_key/i);
  assert.doesNotMatch(refBasis, /operational_name|nickname|hard_resolution|identity_link/i);

  const rowBasis = sqlFunction(teacherAuthoritySql, "internal.teacher_import_authoritative_row_basis");
  assert.match(rowBasis, /returns table \([\s\S]*availability_text text[\s\S]*capacity_text text[\s\S]*location text/i);
  assert.match(rowBasis, /jsonb_typeof\(roster_row #> '\{attributes,location\}'\) = 'string'/i);
  assert.match(rowBasis, /jsonb_typeof\(roster_row -> 'availabilityText'\) = 'string'/i);
  assert.match(rowBasis, /end\s+as availability_text[\s\S]*end\s+as capacity_text[\s\S]*end\s+as location/i);
  assert.match(rowBasis, /source_id \|\| '#subjects'/i);
  assert.match(rowBasis, /array_agg\([\s\S]*row_name order by raw_subject_names\.subject_ordinality/i);
  assert.doesNotMatch(rowBasis, /hard_resolution|identity_link/i);

  const subjectBasis = sqlFunction(teacherAuthoritySql, "internal.teacher_import_authoritative_subject_basis");
  assert.match(subjectBasis, /sheet_position between 2 and 17/i);
  assert.match(subjectBasis, /sheet_position between 2 and 8/i);
  assert.match(subjectBasis, /group by subject_membership\.name_key, subject_membership\.sheet_name/i);

  const detailBasis = sqlFunction(teacherAuthoritySql, "internal.teacher_import_authoritative_detail_basis");
  assert.match(detailBasis, /teacher_import_clean_text\(subject_row ->> 'subjectDetail'\)/i);
  assert.match(detailBasis, /jsonb_array_elements\(p_k12\.subject_rows\) with ordinality/i);
  assert.match(detailBasis, /jsonb_array_elements\(p_university\.subject_rows\) with ordinality/i);
  assert.match(detailBasis, /partition by[\s\S]*convert_to\(raw_details\.name_key, 'UTF8'\)[\s\S]*convert_to\(raw_details\.detail, 'UTF8'\)[\s\S]*order by raw_details\.workbook_order, raw_details\.detail_order/i);
  assert.match(detailBasis, /where ranked_details\.occurrence_rank = 1/i);
  assert.doesNotMatch(detailBasis, /sheet_position/i);

  const operational = sqlFunction(
    teacherAuthoritySql,
    "internal.teacher_import_expected_operational_fragments",
  );
  assert.match(operational, /teacher_import_authoritative_row_basis\(p_k12, p_university\)/i);
  assert.match(operational, /teacher_import_js_trim\(basis\.source_row #>> '\{\}'\)/i);
  assert.match(operational, /convert_to\(basis\.workbook, 'UTF8'\)[\s\S]*decode\('00', 'hex'\)[\s\S]*convert_to\(basis\.source_id, 'UTF8'\)/i);
  assert.match(operational, /row_count > 1 and existing\.existing_teacher is not null[\s\S]*existing\.existing_teacher ->> 'name'/i);
  assert.match(operational, /row_number\(\) over \([\s\S]*source_text\.kind[\s\S]*convert_to\(source_text\.value, 'UTF8'\)[\s\S]*order by authority_rows\.reference_key/i);
  assert.match(operational, /count\(distinct pg_catalog\.convert_to\(authority_rows\.location, 'UTF8'\)\)/i);
  assert.match(operational, /teacher_import_js_trim\([\s\S]*existing_teacher ->> 'availability'[\s\S]*then active_base\.existing_teacher ->> 'availability'/i);
  assert.match(operational, /teacher_import_timezone_for_location\(active_values\.expected_location\)/i);
  assert.match(operational, /existing_index as materialized \([\s\S]*teacher_import_name_key\(existing_teacher ->> 'name'\) as name_key/i);
  assert.match(operational, /existing_ranked as materialized \([\s\S]*partition by pg_catalog\.convert_to\(existing_index\.name_key, 'UTF8'\)/i);
  assert.match(operational, /left join existing_ranked existing[\s\S]*existing\.existing_rank = 1/i);
  assert.doesNotMatch(operational, /left join lateral \([\s\S]*jsonb_array_elements\(p_existing_teachers\)/i);
  assert.match(operational, /where not exists \([\s\S]*active_expected\.teacher_id = existing\.existing_teacher ->> 'id'/i);
  assert.match(operational, /from existing_index existing/i);
  assert.match(operational, /jsonb_typeof\(existing\.existing_teacher -> 'location'\) = 'string'[\s\S]*teacher_import_clean_text\(existing\.existing_teacher ->> 'location'\)/i);
  assert.match(operational, /'availabilityStatus', '暂停接新'/i);
  assert.match(operational, /'acceptsStudents', false/i);
  assert.match(operational, /case when historical_values\.availability_source_text is not null[\s\S]*jsonb_build_object\([\s\S]*'availabilitySourceText'/i);
  for (const field of [
    "name", "initials", "availability", "availabilityStatus", "timezone",
    "load", "capacity", "acceptsStudents", "note", "location",
    "availabilitySourceText", "capacitySourceText",
  ]) assert.match(operational, new RegExp(`'${field}'`, "i"));

  const assertion = sqlFunction(teacherAuthoritySql, "internal.assert_teacher_import_authoritative_plan");
  for (const invariant of [
    "teacher_import_authoritative_reference_mismatch",
    "teacher_import_authoritative_name_mismatch",
    "teacher_import_existing_id_name_changed",
    "teacher_import_existing_unmanaged_fields_changed",
    "teacher_import_new_teacher_unmanaged_fields",
    "teacher_import_existing_name_ambiguous",
    "teacher_import_exact_name_existing_id_mismatch",
    "teacher_import_authoritative_id_collision",
    "teacher_import_authoritative_id_mismatch",
    "teacher_import_authoritative_subject_mismatch",
    "teacher_import_authoritative_metadata_mismatch",
    "teacher_import_operational_projection_mismatch",
    "teacher_import_existing_teacher_removed",
    "teacher_import_unreferenced_teacher_added",
    "teacher_import_historical_reference_mismatch",
    "teacher_import_historical_authority_not_cleared",
  ]) assert.match(assertion, new RegExp(invariant, "i"));
  assert.match(assertion, /p_k12\.source_id \|\| '#subjects'/i);
  assert.match(assertion, /teacher_by_name\.teacher -> 'subjects' is distinct from expected\.expected_subjects/i);
  assert.match(assertion, /teacher_by_name\.teacher -> 'sourceCategories' is distinct from expected\.expected_subjects/i);
  assert.match(assertion, /jsonb_agg\(to_jsonb\(department\.department\) order by department\.workbook_order\)/i);
  assert.match(assertion, /when 'k12' then '中小学'[\s\S]*else '大学'/i);
  assert.match(assertion, /string_agg\(detail_basis ->> 'detail', '；' order by/i);
  assert.match(assertion, /teacher_by_name\.teacher -> 'departments' is distinct from expected\.expected_departments/i);
  assert.match(assertion, /expected\.expected_detail is null and teacher_by_name\.teacher \? 'subjectDetail'/i);
  assert.match(assertion, /convert_to\(teacher_by_name\.teacher ->> 'subjectDetail', 'UTF8'\) is distinct from[\s\S]*convert_to\(expected\.expected_detail, 'UTF8'\)/i);
  assert.match(assertion, /teacher \? 'subjectDetail'/i);
  assert.match(assertion, /teacher -> 'departments' is distinct from '\[\]'::jsonb/i);
  assert.match(assertion, /\(teacher ->> 'availabilityStatus'\) is distinct from '暂停接新'/i);
  assert.match(assertion, /\(teacher ->> 'acceptsStudents'\) is distinct from 'false'/i);
  assert.match(assertion, /teacher ->> 'id' = existing_teacher ->> 'id'[\s\S]*teacher_import_name_key\(teacher ->> 'name'\) <>[\s\S]*teacher_import_name_key\(existing_teacher ->> 'name'\)/i);
  assert.match(assertion, /teacher ->> 'id' = internal\.teacher_import_authoritative_id\(authority\.name_key\)/i);
  assert.match(assertion, /teacher_import_expected_operational_fragments\([\s\S]*p_k12, p_university, p_existing_teachers/i);
  assert.match(assertion, /teacher_by_id as materialized \([\s\S]*teacher ->> 'id' as teacher_id/i);
  assert.match(assertion, /jsonb_object_agg\(field\.key, field\.value\)/i);
  assert.match(assertion, /jsonb_each\(teacher_by_id\.teacher\) field/i);
  const operationalKeys = assertion.match(/where field\.key = any\(array\[([\s\S]*?)\]::text\[\]\)/i);
  assert.ok(operationalKeys, "operational comparison must use an explicit key allowlist");
  assert.deepEqual(
    [...operationalKeys[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    [
      "name", "initials", "availability", "availabilityStatus", "timezone",
      "load", "capacity", "acceptsStudents", "note", "location",
      "availabilitySourceText", "capacitySourceText",
    ],
  );
  assert.doesNotMatch(assertion, /teacher_import_existing_reference_owner_changed/i);
  assert.match(assertion, /teacher - array\[[\s\S]*\]::text\[\][\s\S]*is distinct from[\s\S]*existing_teacher - array\[/i);
  const managedFields = [
    "id", "name", "subjects", "subjectDetail", "departments", "sourceCategories",
    "teacherSourceRefs", "availability", "availabilityStatus", "availabilitySourceText",
    "capacitySourceText", "initials", "timezone", "load", "capacity", "acceptsStudents",
    "note", "location",
  ];
  const allowlistBodies = [...assertion.matchAll(/(?:teacher|existing_teacher) - array\[([\s\S]*?)\]::text\[\]/gi)]
    .map((match) => [...match[1].matchAll(/'([^']+)'/g)].map((field) => field[1]));
  assert.equal(allowlistBodies.length, 3, "existing/new teacher guards must share three exact allowlists");
  for (const allowlist of allowlistBodies) assert.deepEqual(allowlist, managedFields);
  assert.doesNotMatch(assertion, /payrollHistory|availabilityWindows|capacityAssignments/);
  assert.match(assertion, /not exists \([\s\S]*existing_teacher ->> 'id' = teacher ->> 'id'[\s\S]*teacher - array\[[\s\S]*is distinct from '\{\}'::jsonb/i);
  assert.doesNotMatch(assertion, /teacher_import_(?:hard_resolutions|identity_links)/i);

  const shapeBody = sqlFunction(teacherAuthoritySql, "internal.assert_teacher_import_plan_shape");
  assert.match(shapeBody, /teacher_item jsonb;/i);
  assert.match(shapeBody, /teacher_ref_item jsonb;/i);
  assert.match(shapeBody, /for teacher_item in select value from jsonb_array_elements\(p_teachers\)/i);
  assert.match(shapeBody, /for teacher_ref_item in select value from jsonb_array_elements\(teacher_item -> 'teacherSourceRefs'\)/i);
  assert.doesNotMatch(shapeBody, /\bteacher(?:_ref)? jsonb;|for teacher(?:_ref)? in select value/i);
  const mandatoryTypes = new Map([
    ["id", "string"], ["name", "string"], ["initials", "string"],
    ["subjects", "array"], ["departments", "array"], ["sourceCategories", "array"],
    ["teacherSourceRefs", "array"], ["availability", "string"],
    ["availabilityStatus", "string"], ["timezone", "string"], ["load", "number"],
    ["capacity", "number"], ["acceptsStudents", "boolean"], ["note", "string"],
  ]);
  for (const [field, type] of mandatoryTypes) {
    assert.match(
      shapeBody,
      new RegExp(`jsonb_typeof\\(teacher_item -> '${field}'\\) is distinct from '${type}'`, "i"),
      `${field} must reject missing and JSON-null values`,
    );
  }
  assert.match(shapeBody, /jsonb_typeof\(p_teachers\) is distinct from 'array'/i);
  assert.match(shapeBody, /teacher_item ->> 'availabilityStatus' in \('可接新生', '暂停接新', '待确认'\)/i);
  assert.match(shapeBody, /foreach optional_field in array array\[[\s\S]*'subjectDetail'[\s\S]*'location'[\s\S]*'availabilitySourceText'[\s\S]*'capacitySourceText'/i);
  assert.match(shapeBody, /teacher_item \? optional_field[\s\S]*jsonb_typeof\(teacher_item -> optional_field\) is distinct from 'string'/i);
  assert.match(shapeBody, /department #>> '\{\}' in \('中小学', '大学'\)/i);
  assert.match(shapeBody, /jsonb_array_length\(teacher_item -> 'departments'\) <> \([\s\S]*count\(distinct department #>> '\{\}'\)/i);
  assert.match(shapeBody, /\(teacher_item ->> 'load'\)::numeric < 0/i);
  assert.match(shapeBody, /\(teacher_item ->> 'capacity'\)::numeric < 0/i);
  assert.doesNotMatch(shapeBody, /jsonb_typeof\([^\n]*\)\s*<>/i);

  const commitBody = sqlFunction(teacherAuthoritySql, "public.commit_teacher_import_plan_atomic");
  const sourceLockAt = commitBody.indexOf("where source_row.workbook = 'k12'");
  const authorityAt = commitBody.indexOf("assert_teacher_import_authoritative_plan");
  const shapeAt = commitBody.indexOf("assert_teacher_import_plan_shape");
  const hashAt = commitBody.indexOf("teachers_hash :=");
  const replayAt = commitBody.indexOf("prior.committed_by,\n      false");
  assert.ok(shapeAt >= 0 && shapeAt < hashAt, "wire shape must be proven before hashing");
  assert.ok(sourceLockAt >= 0 && authorityAt > sourceLockAt, "authority assertion must run after source locks");
  assert.ok(replayAt > authorityAt, "replay must revalidate authority before returning");
  assert.doesNotMatch(commitBody, /teacher_import_(?:hard_resolutions|identity_links)/i);
  assert.match(commitBody, /'identityPolicy', 'exact_normalized_name'/i);
  assert.match(commitBody, /authorityReferenceCount/i);
  assert.match(commitBody, /authoritySubjectMembershipCount/i);

  assert.match(teacherAuthoritySql, /teacher_authority_basis_fixture_mismatch/i);
  assert.match(teacherAuthoritySql, /teacher_authority_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_authoritative_id_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_id_reuse_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_direct_row_reuse_fixture_mismatch/i);
  assert.match(teacherAuthoritySql, /teacher_historical_departments_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_historical_status_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_authoritative_departments_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_authoritative_stale_detail_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_authoritative_fabricated_detail_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_authoritative_missing_detail_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /K12 Focus；Uni Detail/i);
  assert.match(teacherAuthoritySql, /Essay Detail；Local Detail；Research Skills/i);
  assert.match(teacherAuthoritySql, /teacher_shape_missing_field_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_shape_null_field_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_shape_optional_null_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_shape_optional_blank_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_shape_duplicate_department_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_shape_invalid_department_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_unmanaged_field_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_new_unmanaged_field_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /array\['payrollHistory','availabilityWindows','capacityAssignments'\]/i);
  assert.match(teacherAuthoritySql, /teacher_operational_primitive_fixture_mismatch/i);
  assert.match(teacherAuthoritySql, /teacher_operational_projection_fixture_mismatch/i);
  assert.match(teacherAuthoritySql, /teacher_operational_display_name_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_operational_field_rejection_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_operational_optional_removal_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /teacher_operational_optional_fabrication_fixture_did_not_fail/i);
  assert.match(teacherAuthoritySql, /non_string_existing := jsonb_set\(existing_fixture, '\{1,location\}', '42'::jsonb\)/i);
  assert.match(teacherAuthoritySql, /array\[0, 2, 3\]::integer\[\]/i);
  assert.match(teacherAuthoritySql, /First AVA；Second AVA/i);
  assert.match(teacherAuthoritySql, /Duplicate Capacity；University Capacity/i);
  assert.match(teacherAuthoritySql, /name:831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a/i);
  assert.doesNotMatch(teacherAuthoritySql, /student_import|operation_confirmation|availability_submission/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.assert_teacher_import_authoritative_plan/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.assert_teacher_import_plan_shape\(jsonb\)/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_clean_text\(text\)/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_js_trim\(text\)/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_initials\(text\)/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_timezone_for_location\(text\)/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_authoritative_row_basis/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_expected_operational_fragments/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_authoritative_detail_basis/i);
  assert.match(teacherAuthoritySql, /revoke all on function internal\.teacher_import_authoritative_id\(text\)/i);
  assert.match(teacherAuthoritySql, /revoke all on function public\.commit_teacher_import_plan_atomic[\s\S]*grant execute/i);
});

test("teacher authority validation hotfix removes production-shaped repeated JSON scans", () => {
  for (const name of [
    "internal.teacher_import_expected_operational_fragments",
    "internal.assert_teacher_import_authoritative_plan",
  ]) {
    assert.equal(
      sqlFunction(teacherAuthorityPerformanceSql, name),
      sqlFunction(teacherAuthoritySql, name),
      `${name} performance hotfix must match the authority migration`,
    );
    assert.equal(
      sqlFunction(teacherAuthorityPerformanceSql, name),
      sqlFunction(sql, name),
      `${name} performance hotfix must match the canonical contract`,
    );
  }

  const operational = sqlFunction(
    teacherAuthorityPerformanceSql,
    "internal.teacher_import_expected_operational_fragments",
  );
  assert.match(operational, /existing_index as materialized/i);
  assert.match(operational, /existing_ranked as materialized/i);
  assert.match(operational, /left join existing_ranked existing/i);
  assert.equal(
    [...operational.matchAll(/teacher_import_name_key\(existing_teacher ->> 'name'\)/gi)].length,
    1,
    "240 locked existing names must be normalized once, not once per authoritative name",
  );
  assert.doesNotMatch(
    operational,
    /left join lateral \([\s\S]*jsonb_array_elements\(p_existing_teachers\)/i,
  );

  const assertion = sqlFunction(
    teacherAuthorityPerformanceSql,
    "internal.assert_teacher_import_authoritative_plan",
  );
  assert.match(assertion, /teacher_by_id as materialized/i);
  assert.equal(
    [...assertion.matchAll(/teacher_by_name as materialized/gi)].length,
    2,
    "subject and metadata validation must each index the 254-row plan once",
  );
  assert.equal(
    [...assertion.matchAll(/join teacher_by_name on teacher_by_name\.name_key = expected\.name_key/gi)].length,
    2,
  );
  assert.doesNotMatch(
    assertion,
    /join jsonb_array_elements\(p_teachers\) teacher on exists \([\s\S]*?basis ->> 'nameKey' = expected\.name_key/i,
  );
  assert.doesNotMatch(
    assertion,
    /left join lateral jsonb_array_elements\(p_teachers\) teacher/i,
  );

  // At the observed production cardinalities, the removed owner lookup had
  // two 227 x 254 x 266 nested probes (over 30 million comparisons).
  const oldOwnerProbeComparisons = 2 * 227 * 254 * 266;
  assert.ok(oldOwnerProbeComparisons > 30_000_000);
  assert.match(teacherAuthorityPerformanceSql, /revoke all on function internal\.teacher_import_expected_operational_fragments/i);
  assert.match(teacherAuthorityPerformanceSql, /revoke all on function internal\.assert_teacher_import_authoritative_plan/i);
  assert.doesNotMatch(teacherAuthorityPerformanceSql, /create or replace function public\./i);
  assert.doesNotMatch(teacherAuthorityPerformanceSql, /grant execute|\bupdate\b|\binsert\b|\bdelete\b/i);
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

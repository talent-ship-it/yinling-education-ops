-- PostgreSQL gives the binary subtraction operator higher precedence than the
-- JSON extraction operator.  Without parentheses, source attributes allow-list
-- expressions were parsed as:
--
--   r -> ('attributes' - 'location')
--
-- and source uploads failed before validation with 42725
-- (operator is not unique: unknown - unknown).
create or replace function public.put_teacher_import_source(
  p_secret text,
  p_workbook text,
  p_source_id text,
  p_revision text,
  p_sheet_names jsonb,
  p_roster_rows jsonb,
  p_subject_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.teacher_import_sources%rowtype;
  snapshot_hash text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_workbook not in ('k12', 'university')
     or p_actor not in ('Nixon', 'Ops Admin')
     or nullif(trim(p_source_id), '') is null
     or length(trim(p_source_id)) > 160
     or nullif(trim(p_revision), '') is null
     or length(trim(p_revision)) > 240
     or jsonb_typeof(p_sheet_names) <> 'array'
     or jsonb_array_length(p_sheet_names) < 1
     or jsonb_array_length(p_sheet_names) > 100
     or exists (
       select 1 from jsonb_array_elements(p_sheet_names) s
       where jsonb_typeof(s) <> 'string' or nullif(trim(s #>> '{}'), '') is null
     )
     or jsonb_typeof(p_roster_rows) <> 'array'
     or jsonb_array_length(p_roster_rows) < 1
     or jsonb_array_length(p_roster_rows) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_roster_rows) r
       where jsonb_typeof(r) <> 'object'
          or r ->> 'workbook' <> p_workbook
          or jsonb_typeof(r -> 'sourceRow') not in ('string', 'number')
          or nullif(trim(r ->> 'sourceRow'), '') is null
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or (r ? 'attributes' and jsonb_typeof(r -> 'attributes') <> 'object')
          or (r ? 'attributes' and (r -> 'attributes') - ARRAY['location']::text[] <> '{}'::jsonb)
          or (r -> 'attributes' ? 'location' and jsonb_typeof(r -> 'attributes' -> 'location') <> 'string')
          or (r ? 'availabilityText' and jsonb_typeof(r -> 'availabilityText') not in ('string', 'null'))
          or (r ? 'capacityText' and jsonb_typeof(r -> 'capacityText') not in ('string', 'null'))
          or r - 'workbook' - 'sourceRow' - 'name' - 'availabilityText' - 'capacityText' - 'attributes' <> '{}'::jsonb
     )
     or jsonb_typeof(p_subject_rows) <> 'array'
     or jsonb_array_length(p_subject_rows) > 100000
     or exists (
       select 1 from jsonb_array_elements(p_subject_rows) r
       where jsonb_typeof(r) <> 'object'
          or r ->> 'workbook' <> p_workbook
          or jsonb_typeof(r -> 'sourceRow') not in ('string', 'number')
          or nullif(trim(r ->> 'sourceRow'), '') is null
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or jsonb_typeof(r -> 'sheetName') <> 'string'
          or nullif(trim(r ->> 'sheetName'), '') is null
          or (r ? 'subjectDetail' and jsonb_typeof(r -> 'subjectDetail') not in ('string', 'null'))
          or r - 'workbook' - 'sheetName' - 'sourceRow' - 'name' - 'subjectDetail' <> '{}'::jsonb
     ) then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_source';
  end if;

  snapshot_hash := encode(extensions.digest(
    jsonb_build_object(
      'sheetNames', p_sheet_names,
      'rosterRows', p_roster_rows,
      'subjectRows', p_subject_rows
    )::text,
    'sha256'
  ), 'hex');

  -- Serialises the first insert as well as later updates for each workbook.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('teacher_import_source:' || p_workbook, 0)
  );
  select * into saved
  from internal.teacher_import_sources s
  where s.workbook = p_workbook
  for update;

  if found
     and saved.source_id = trim(p_source_id)
     and saved.revision = trim(p_revision)
     and saved.snapshot_sha256 = snapshot_hash then
    return jsonb_build_object(
      'workbook', saved.workbook,
      'sourceId', saved.source_id,
      'revision', saved.revision,
      'rosterRowCount', saved.roster_row_count,
      'subjectRowCount', saved.subject_row_count,
      'unchanged', true
    );
  end if;
  if found and saved.revision = trim(p_revision) then
    raise exception using errcode = '23505', message = 'teacher_import_revision_conflict';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.source_ingested',
    p_actor,
    'teacher_import_source',
    p_workbook,
    jsonb_build_object(
      'sourceId', trim(p_source_id),
      'revision', trim(p_revision),
      'rosterRowCount', jsonb_array_length(p_roster_rows),
      'subjectRowCount', jsonb_array_length(p_subject_rows),
      'snapshotSha256', snapshot_hash
    )
  );

  insert into internal.teacher_import_sources (
    workbook, source_id, revision, sheet_names, roster_rows, subject_rows,
    roster_row_count, subject_row_count, snapshot_sha256,
    ingested_by, ingested_at, audit_id
  ) values (
    p_workbook, trim(p_source_id), trim(p_revision), p_sheet_names,
    p_roster_rows, p_subject_rows, jsonb_array_length(p_roster_rows),
    jsonb_array_length(p_subject_rows), snapshot_hash,
    left(trim(p_actor), 120), now(), audit_entry_id
  )
  on conflict (workbook) do update set
    source_id = excluded.source_id,
    revision = excluded.revision,
    sheet_names = excluded.sheet_names,
    roster_rows = excluded.roster_rows,
    subject_rows = excluded.subject_rows,
    roster_row_count = excluded.roster_row_count,
    subject_row_count = excluded.subject_row_count,
    snapshot_sha256 = excluded.snapshot_sha256,
    ingested_by = excluded.ingested_by,
    ingested_at = excluded.ingested_at,
    audit_id = excluded.audit_id
  returning * into saved;

  return jsonb_build_object(
    'workbook', saved.workbook,
    'sourceId', saved.source_id,
    'revision', saved.revision,
    'rosterRowCount', saved.roster_row_count,
    'subjectRowCount', saved.subject_row_count,
    'unchanged', false
  );
end;
$$;

revoke all on function public.put_teacher_import_source(text, text, text, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.put_teacher_import_source(text, text, text, text, jsonb, jsonb, jsonb, text)
  to anon, authenticated;

-- The student source RPC had the same precedence bug in its master and JWB
-- nested attributes allow-lists, so the forward repair must replace it too.
create or replace function public.put_student_import_source_rows(
  p_secret text,
  p_source_kind text,
  p_source_id text,
  p_revision text,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.student_import_source_rows%rowtype;
  rows_hash text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_source_kind not in ('master', 'jwb')
     or p_actor not in ('Nixon', 'Ops Admin')
     or nullif(trim(p_source_id), '') is null
     or length(trim(p_source_id)) > 160
     or nullif(trim(p_revision), '') is null
     or length(trim(p_revision)) > 240
     or nullif(trim(p_actor), '') is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_rows) r
       where jsonb_typeof(r) <> 'object'
          or not (r ? 'sourceRow')
          or jsonb_typeof(r -> 'sourceRow') not in ('string', 'number')
          or nullif(internal.student_import_source_key(r -> 'sourceRow'), '') is null
          or length(internal.student_import_source_key(r -> 'sourceRow')) > 240
          or (
            jsonb_typeof(r -> 'sourceRow') = 'string'
            and r ->> 'sourceRow' <> internal.student_import_source_key(r -> 'sourceRow')
          )
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or length(trim(r ->> 'name')) > 240
          or (
            p_source_kind = 'master'
            and (
              r - 'sourceRow' - 'name' - 'status' - 'attributes' <> '{}'::jsonb
              or trim(coalesce(r ->> 'status', '')) not in (
                '',
                '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
                '不活跃 + 有课时', '在读 + 加课待排'
              )
              or (r ? 'attributes' and jsonb_typeof(r -> 'attributes') <> 'object')
              or (r ? 'attributes' and (r -> 'attributes')
                - ARRAY['location', 'year', 'owner', 'planner']::text[] <> '{}'::jsonb)
              or exists (
                select 1
                from jsonb_each(coalesce(r -> 'attributes', '{}'::jsonb)) attribute(key, value)
                where jsonb_typeof(attribute.value) <> 'string'
                   or nullif(trim(attribute.value #>> '{}'), '') is null
                   or attribute.value #>> '{}' <> trim(attribute.value #>> '{}')
                   or length(trim(attribute.value #>> '{}')) > 120
              )
            )
          )
          or (
            p_source_kind = 'jwb'
            and (
              r - 'sourceRow' - 'name' - 'remainingHours' - 'contractHours'
                - 'contractEffectiveDate' - 'lessonPackages' - 'packageCoverage' - 'attributes' <> '{}'::jsonb
              or (r ? 'remainingHours' and jsonb_typeof(r -> 'remainingHours') not in ('number', 'null'))
              or (r ? 'remainingHours' and jsonb_typeof(r -> 'remainingHours') = 'number'
                and not internal.student_import_has_microhour_precision(r -> 'remainingHours'))
              or (r ? 'contractHours' and jsonb_typeof(r -> 'contractHours') not in ('number', 'null'))
              or (r ? 'contractHours' and jsonb_typeof(r -> 'contractHours') = 'number'
                and not internal.student_import_has_microhour_precision(r -> 'contractHours'))
              or (r ? 'contractHours' and jsonb_typeof(r -> 'contractHours') = 'number'
                and (r ->> 'contractHours')::numeric < 0)
              or (r ? 'contractEffectiveDate'
                and jsonb_typeof(r -> 'contractEffectiveDate') not in ('string', 'null'))
              or (r ? 'contractEffectiveDate'
                and jsonb_typeof(r -> 'contractEffectiveDate') = 'string'
                and r ->> 'contractEffectiveDate' !~ '^\d{4}-\d{2}-\d{2}$')
              or coalesce(r ->> 'packageCoverage', '') not in ('complete', 'partial', 'none')
              or (r ? 'lessonPackages' and jsonb_typeof(r -> 'lessonPackages') <> 'array')
              or (r ->> 'packageCoverage' in ('complete', 'partial')
                and coalesce(jsonb_array_length(r -> 'lessonPackages'), 0) < 1)
              or (r ->> 'packageCoverage' = 'none'
                and coalesce(jsonb_array_length(r -> 'lessonPackages'), 0) > 0)
              or (
                coalesce((r ->> 'remainingHours')::numeric, 0) < 0
                and (
                  r ->> 'packageCoverage' <> 'none'
                  or coalesce(jsonb_array_length(r -> 'lessonPackages'), 0) <> 0
                )
              )
              or not (r ? 'attributes')
              or jsonb_typeof(r -> 'attributes') <> 'object'
              or (r -> 'attributes') - ARRAY['jiaowubaoPackageImport']::text[] <> '{}'::jsonb
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport') <> 'object'
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'status')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'currentTotalHours')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'currentUsedHours')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'currentRemainingHours')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'adjustmentContracts')
              or (r -> 'attributes' -> 'jiaowubaoPackageImport') - ARRAY[
                'status', 'currentTotalHours', 'currentUsedHours', 'currentRemainingHours',
                'unresolvedCourseBalances', 'adjustmentContracts'
              ]::text[] <> '{}'::jsonb
              or coalesce(r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'status', '') not in (
                'aggregate_only_missing_purchase_history',
                'aggregate_only_negative_adjustment',
                'aggregate_only_negative_balance',
                'aggregate_only_negative_balance_and_adjustment',
                'aggregate_only_no_current_courses',
                'packages_from_current_balances_with_negative_adjustment_audit',
                'packages_from_current_course_balances',
                'partial_packages_unresolved_course_balances'
              )
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentTotalHours') <> 'number'
              or not internal.student_import_has_microhour_precision(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentTotalHours'
              )
              or (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentTotalHours')::numeric < 0
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentUsedHours') <> 'number'
              or not internal.student_import_has_microhour_precision(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentUsedHours'
              )
              or (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentUsedHours')::numeric < 0
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentRemainingHours') <> 'number'
              or not internal.student_import_has_microhour_precision(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentRemainingHours'
              )
              or (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentTotalHours')::numeric <>
                (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentUsedHours')::numeric +
                (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentRemainingHours')::numeric
              or (
                r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'unresolvedCourseBalances'
                and jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances') <> 'array'
              )
              or jsonb_array_length(coalesce(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                '[]'::jsonb
              )) > 1000
              or exists (
                select 1
                from jsonb_array_elements(coalesce(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                  '[]'::jsonb
                )) unresolved
                where jsonb_typeof(unresolved) <> 'object'
                   or unresolved - 'courseId' - 'title' - 'totalHours' - 'usedHours' - 'remainingHours' <> '{}'::jsonb
                   or jsonb_typeof(unresolved -> 'courseId') <> 'string'
                   or nullif(trim(unresolved ->> 'courseId'), '') is null
                   or length(trim(unresolved ->> 'courseId')) > 240
                   or jsonb_typeof(unresolved -> 'title') <> 'string'
                   or nullif(trim(unresolved ->> 'title'), '') is null
                   or length(trim(unresolved ->> 'title')) > 240
                   or jsonb_typeof(unresolved -> 'totalHours') <> 'number'
                   or not internal.student_import_has_microhour_precision(unresolved -> 'totalHours')
                   or (unresolved ->> 'totalHours')::numeric < 0
                   or jsonb_typeof(unresolved -> 'usedHours') <> 'number'
                   or not internal.student_import_has_microhour_precision(unresolved -> 'usedHours')
                   or (unresolved ->> 'usedHours')::numeric < 0
                   or jsonb_typeof(unresolved -> 'remainingHours') <> 'number'
                   or not internal.student_import_has_microhour_precision(unresolved -> 'remainingHours')
                   or (unresolved ->> 'totalHours')::numeric <>
                     (unresolved ->> 'usedHours')::numeric + (unresolved ->> 'remainingHours')::numeric
              )
              or (
                select count(*)
                from jsonb_array_elements(coalesce(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                  '[]'::jsonb
                )) unresolved
              ) <> (
                select count(distinct unresolved ->> 'courseId')
                from jsonb_array_elements(coalesce(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                  '[]'::jsonb
                )) unresolved
              )
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts') <> 'array'
              or jsonb_array_length(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
              ) > 1000
              or exists (
                select 1
                from jsonb_array_elements(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
                ) adjustment
                where jsonb_typeof(adjustment) <> 'object'
                   or adjustment - 'contractId' - 'nature' - 'courseId' - 'hoursDelta' <> '{}'::jsonb
                   or jsonb_typeof(adjustment -> 'contractId') <> 'string'
                   or nullif(trim(adjustment ->> 'contractId'), '') is null
                   or length(trim(adjustment ->> 'contractId')) > 240
                   or adjustment ->> 'nature' not in ('退费', '转出')
                   or jsonb_typeof(adjustment -> 'courseId') <> 'string'
                   or nullif(trim(adjustment ->> 'courseId'), '') is null
                   or length(trim(adjustment ->> 'courseId')) > 240
                   or jsonb_typeof(adjustment -> 'hoursDelta') <> 'number'
                   or not internal.student_import_has_microhour_precision(adjustment -> 'hoursDelta')
                   or (adjustment ->> 'hoursDelta')::numeric > 0
              )
              or (
                select count(*)
                from jsonb_array_elements(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
                ) adjustment
              ) <> (
                select count(distinct adjustment ->> 'contractId')
                from jsonb_array_elements(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
                ) adjustment
              )
            )
          )
  ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_source_rows';
  end if;
  if p_source_kind = 'jwb' then
    -- Re-run the nested package canonicalizer at ingest time.  The source row
    -- contract must reject malformed IDs, dates and micro-hour values before
    -- they become locked evidence for a later plan.
    perform internal.student_import_canonical_jwb_packages(
      'STU-JWB-SOURCE-VALIDATION',
      row_value -> 'lessonPackages'
    )
    from jsonb_array_elements(p_rows) row_value
    where row_value ->> 'packageCoverage' in ('complete', 'partial');
  end if;
  if p_source_kind = 'master' and exists (
    select 1 from jsonb_array_elements(p_rows) blank_row
    where trim(coalesce(blank_row ->> 'status', '')) = ''
      and not exists (
        select 1 from jsonb_array_elements(p_rows) sibling
        where sibling ->> 'sourceRow' <> blank_row ->> 'sourceRow'
          and trim(coalesce(sibling ->> 'status', '')) <> '不活跃 + 无课时'
          and internal.student_import_name_key(sibling ->> 'name') =
            internal.student_import_name_key(blank_row ->> 'name')
      )
  ) then
    raise exception using errcode = '22023', message = 'unclosed_blank_student_master_status';
  end if;

  rows_hash := encode(extensions.digest(p_rows::text, 'sha256'), 'hex');

  -- Serialise the first insert as well as later updates for each source kind.
  -- A row lock alone cannot protect an absent row on the initial ingest.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student_import_source:' || p_source_kind, 0)
  );
  select * into saved
  from internal.student_import_source_rows s
  where s.source_kind = p_source_kind
  for update;

  if found
     and saved.source_id = trim(p_source_id)
     and saved.revision = trim(p_revision)
     and saved.rows_sha256 = rows_hash then
    return jsonb_build_object(
      'sourceKind', saved.source_kind,
      'sourceId', saved.source_id,
      'revision', saved.revision,
      'rowCount', saved.row_count,
      'unchanged', true
    );
  end if;
  if found
     and saved.revision = trim(p_revision)
     and (saved.source_id <> trim(p_source_id) or saved.rows_sha256 <> rows_hash) then
    raise exception using errcode = '23505', message = 'student_import_revision_conflict';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.source_ingested',
    p_actor,
    'student_import_source',
    p_source_kind,
    jsonb_build_object(
      'sourceId', left(trim(p_source_id), 160),
      'revision', left(trim(p_revision), 240),
      'rowCount', jsonb_array_length(p_rows),
      'rowsSha256', rows_hash
    )
  );

  insert into internal.student_import_source_rows (
    source_kind, source_id, revision, rows, row_count, rows_sha256,
    ingested_by, ingested_at, audit_id
  ) values (
    p_source_kind, left(trim(p_source_id), 160), left(trim(p_revision), 240),
    p_rows, jsonb_array_length(p_rows), rows_hash, left(trim(p_actor), 120),
    now(), audit_entry_id
  )
  on conflict (source_kind) do update set
    source_id = excluded.source_id,
    revision = excluded.revision,
    rows = excluded.rows,
    row_count = excluded.row_count,
    rows_sha256 = excluded.rows_sha256,
    ingested_by = excluded.ingested_by,
    ingested_at = excluded.ingested_at,
    audit_id = excluded.audit_id
  returning * into saved;

  return jsonb_build_object(
    'sourceKind', saved.source_kind,
    'sourceId', saved.source_id,
    'revision', saved.revision,
    'rowCount', saved.row_count,
    'unchanged', false
  );
end;
$$;

revoke all on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  to anon, authenticated;

-- Parse and evaluate each repaired operator shape while the migration runs,
-- without writing any source or audit rows.
do $$
declare
  teacher_source jsonb := '{"attributes":{"location":"Melbourne"}}'::jsonb;
  master_source jsonb := '{"attributes":{"location":"Melbourne","year":"2026","owner":"Ops","planner":"Ops"}}'::jsonb;
  jwb_source jsonb := '{"attributes":{"jiaowubaoPackageImport":{"status":"ok","currentTotalHours":1,"currentUsedHours":0,"currentRemainingHours":1,"unresolvedCourseBalances":[],"adjustmentContracts":[]}}}'::jsonb;
begin
  if (teacher_source -> 'attributes') - ARRAY['location']::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'import_source_jsonb_precedence_fixture_mismatch_teacher';
  end if;
  if (master_source -> 'attributes')
       - ARRAY['location', 'year', 'owner', 'planner']::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'import_source_jsonb_precedence_fixture_mismatch_student_master';
  end if;
  if (jwb_source -> 'attributes') - ARRAY['jiaowubaoPackageImport']::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'import_source_jsonb_precedence_fixture_mismatch_student_jwb_outer';
  end if;
  if (jwb_source -> 'attributes' -> 'jiaowubaoPackageImport') - ARRAY[
       'status', 'currentTotalHours', 'currentUsedHours', 'currentRemainingHours',
       'unresolvedCourseBalances', 'adjustmentContracts'
     ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'import_source_jsonb_precedence_fixture_mismatch_student_jwb_nested';
  end if;
end;
$$;

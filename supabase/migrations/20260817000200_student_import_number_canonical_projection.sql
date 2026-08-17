-- Preserve the existing course-effective date and add a distinct JWB
-- earliest-positive-contract date. The latter is the historical date encoded
-- into a human-facing student number; it is not a course start date or an
-- asserted JWB record-created timestamp.

create or replace function internal.student_import_managed_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'id', 'name', 'status', 'sourceRow', 'masterSourceKey', 'importSource',
    'jwbMatchStatus', 'jwbSourceRow', 'remainingHours', 'contractHours',
    'contractEffectiveDate', 'firstJwbHourEntryDate', 'lessonPackages',
    'packageCoverage', 'importArchived', 'importArchivedReason'
  ]::text[]
$$;

revoke all on function internal.student_import_managed_fields()
  from public, anon, authenticated;

-- The latest deployed definitions live in the source-validation and
-- identity-review migrations. Reconstructing their large bodies here would
-- risk silently losing a later security fix. Instead, fail closed unless the
-- exact current anchors occur once, then inject one narrowly-scoped clause
-- and verify the resulting function text.
do $student_number_canonical_patch$
declare
  function_definition text;
  patched_definition text;
  source_allowed_fields_anchor text := $anchor$- 'contractEffectiveDate' - 'lessonPackages' - 'packageCoverage' - 'attributes' <> '{}'::jsonb$anchor$;
  source_allowed_fields_replacement text := $replacement$- 'contractEffectiveDate' - 'firstJwbHourEntryDate' - 'lessonPackages' - 'packageCoverage' - 'attributes' <> '{}'::jsonb$replacement$;
  source_date_anchor text := $source_date_anchor$              or coalesce(r ->> 'packageCoverage', '') not in ('complete', 'partial', 'none')
$source_date_anchor$;
  source_date_clause text := $source_date_clause$              or (r ? 'firstJwbHourEntryDate'
                and jsonb_typeof(r -> 'firstJwbHourEntryDate') not in ('string', 'null'))
              or (r ? 'firstJwbHourEntryDate'
                and jsonb_typeof(r -> 'firstJwbHourEntryDate') = 'string'
                and r ->> 'firstJwbHourEntryDate' !~ '^\d{4}-\d{2}-\d{2}$')
$source_date_clause$;
  projection_anchor text := E'    if jsonb_array_length(lesson_packages) > 0 then\n';
  projection_clause text := $projection_clause$    if matched_jwb is not null
       and jsonb_typeof(matched_jwb -> 'firstJwbHourEntryDate') = 'string'
       and trim(matched_jwb ->> 'firstJwbHourEntryDate') <> '' then
      record_value := record_value || jsonb_build_object(
        'firstJwbHourEntryDate', trim(matched_jwb ->> 'firstJwbHourEntryDate')
      );
    end if;
$projection_clause$;
  reservation_snapshot_anchor text := E'    \'fuAttachmentReferences\', fu_attachment_snapshot\n  );';
  reservation_snapshot_replacement text := $reservation_snapshot_replacement$    'fuAttachmentReferences', fu_attachment_snapshot,
    'studentNumberReservations', internal.student_number_reservation_snapshot()
  );$reservation_snapshot_replacement$;
  comparison_anchor text := E'  if p_students is distinct from expected_students then\n';
  replay_anchor text := E'  if expected_students is distinct from students_state.payload\n';
  reservation_lock text := E'  lock table internal.student_number_reservations in share mode;\n';
  helper_call text := E'  expected_students := internal.student_import_assign_student_numbers(expected_students);\n\n';
  anchor_count integer;
begin
  select pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_number_source_function_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, source_allowed_fields_anchor, ''))
  ) / length(source_allowed_fields_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_source_allowed_fields_anchor_mismatch';
  end if;
  function_definition := replace(
    function_definition,
    source_allowed_fields_anchor,
    source_allowed_fields_replacement
  );
  anchor_count := (
    length(function_definition) - length(replace(function_definition, source_date_anchor, ''))
  ) / length(source_date_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_source_date_anchor_mismatch';
  end if;
  patched_definition := replace(
    function_definition,
    source_date_anchor,
    source_date_clause || source_date_anchor
  );
  execute patched_definition;
  if position('firstJwbHourEntryDate' in pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  )) = 0 then
    raise exception using errcode = 'P0001', message = 'student_number_source_patch_verification_failed';
  end if;

  -- The server-side preview must receive the same durable reservation mapping
  -- used by the commit helper. Without it, an already-removed student could
  -- make the TypeScript preview choose a serial that SQL correctly rejects.
  select pg_get_functiondef(
    'public.get_latest_student_import_source_rows(text)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_number_snapshot_function_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, reservation_snapshot_anchor, ''))
  ) / length(reservation_snapshot_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_snapshot_patch_anchor_mismatch';
  end if;
  patched_definition := replace(
    function_definition,
    reservation_snapshot_anchor,
    reservation_snapshot_replacement
  );
  execute patched_definition;
  if position('studentNumberReservations' in pg_get_functiondef(
    'public.get_latest_student_import_source_rows(text)'::regprocedure
  )) = 0 then
    raise exception using errcode = 'P0001', message = 'student_number_snapshot_patch_verification_failed';
  end if;

  select pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_number_projection_function_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, projection_anchor, ''))
  ) / length(projection_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_projection_patch_anchor_mismatch';
  end if;
  patched_definition := replace(
    function_definition,
    projection_anchor,
    projection_clause || projection_anchor
  );
  execute patched_definition;
  if position('firstJwbHourEntryDate' in pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  )) = 0 then
    raise exception using errcode = 'P0001', message = 'student_number_projection_patch_verification_failed';
  end if;

  -- A formal student-import plan is fingerprinted and replayed from the
  -- database-owned canonical projection. Add historical JWB-dated student
  -- numbers before either comparison, so a successful import, its audit
  -- fingerprint, and a lost-response replay all agree.
  select pg_get_functiondef(
    'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_number_commit_function_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, comparison_anchor, ''))
  ) / length(comparison_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_commit_patch_anchor_mismatch';
  end if;
  patched_definition := replace(
    function_definition,
    comparison_anchor,
    reservation_lock || helper_call || comparison_anchor
  );
  execute patched_definition;
  if (
    length(pg_get_functiondef(
      'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
    )) - length(replace(
      pg_get_functiondef(
        'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
      ),
      helper_call,
      ''
    ))
  ) / length(helper_call) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_commit_patch_verification_failed';
  end if;
  if (
    length(pg_get_functiondef(
      'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
    )) - length(replace(
      pg_get_functiondef(
        'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
      ),
      reservation_lock,
      ''
    ))
  ) / length(reservation_lock) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_commit_reservation_lock_missing';
  end if;

  select pg_get_functiondef(
    'public.get_student_import_commit_replay_result(text,text,bigint,text)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_number_replay_function_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, replay_anchor, ''))
  ) / length(replay_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_replay_patch_anchor_mismatch';
  end if;
  patched_definition := replace(
    function_definition,
    replay_anchor,
    reservation_lock || helper_call || replay_anchor
  );
  execute patched_definition;
  if (
    length(pg_get_functiondef(
      'public.get_student_import_commit_replay_result(text,text,bigint,text)'::regprocedure
    )) - length(replace(
      pg_get_functiondef(
        'public.get_student_import_commit_replay_result(text,text,bigint,text)'::regprocedure
      ),
      helper_call,
      ''
    ))
  ) / length(helper_call) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_replay_patch_verification_failed';
  end if;
  if (
    length(pg_get_functiondef(
      'public.get_student_import_commit_replay_result(text,text,bigint,text)'::regprocedure
    )) - length(replace(
      pg_get_functiondef(
        'public.get_student_import_commit_replay_result(text,text,bigint,text)'::regprocedure
      ),
      reservation_lock,
      ''
    ))
  ) / length(reservation_lock) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_number_replay_reservation_lock_missing';
  end if;
end;
$student_number_canonical_patch$;

-- Keep the existing publicly callable, secret-guarded RPC contracts explicit
-- after CREATE OR REPLACE. The helper itself remains internal-only.
revoke all on function public.get_latest_student_import_source_rows(text)
  from public, anon, authenticated;
grant execute on function public.get_latest_student_import_source_rows(text)
  to anon, authenticated;
revoke all on function public.commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  to anon, authenticated;
revoke all on function public.get_student_import_commit_replay_result(text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.get_student_import_commit_replay_result(text, text, bigint, text)
  to anon, authenticated;

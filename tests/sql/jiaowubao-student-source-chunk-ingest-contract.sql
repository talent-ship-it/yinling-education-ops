\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Local rollback fixture for the normalized JWB student-source protocol.
-- Run with psql against a disposable database that already contains the
-- operational student-import chain. It deliberately rolls back every schema
-- and data change; production uses begin, each stage call, and completion as
-- separate committed requests.

begin;
\ir ../../supabase/migrations/20260821105524_chunk_jiaowubao_student_source_ingest.sql

\if :{?ops_secret}
\else
\error 'set -v ops_secret="$OPS_API_SECRET" when running this disposable fixture'
\quit
\endif
select set_config('app.jiaowubao_student_source_fixture_secret', :'ops_secret', true);

-- The production planner emits compact canonical JSON. This rollback-only
-- helper uses PostgreSQL's own stable JSON text instead, which is sufficient
-- to exercise the database contract: every canonical string must parse back
-- to its closure, every digest must match its exact supplied bytes, and the
-- run-wide digest must bind their ordered sequence.
create function pg_temp.jiaowubao_student_source_fixture_closures(
  p_rows jsonb,
  p_source_id text,
  p_revision text,
  p_source_revisions jsonb
)
returns jsonb
language sql
as $$
  with row_values as (
    select row_value, ordinal_position
    from jsonb_array_elements(p_rows) with ordinality rows(row_value, ordinal_position)
  ), row_material as (
    select
      row_value,
      ordinal_position,
      row_value::text as row_canonical_json,
      'sha256:' || encode(extensions.digest(row_value::text, 'sha256'), 'hex') as row_sha256
    from row_values
  ), closure_material as (
    select
      *,
      jsonb_build_object(
        'format', 'jiaowubao-student-source-staging-v1',
        'sourceId', p_source_id,
        'revision', p_revision,
        'sourceRevisions', p_source_revisions,
        'sourceRow', row_value ->> 'sourceRow',
        'rowSha256', row_sha256
      )::text as closure_canonical_json
    from row_material
  )
  select jsonb_agg(jsonb_build_object(
    'sourceRow', row_value ->> 'sourceRow',
    'row', row_value,
    'rowCanonicalJson', row_canonical_json,
    'rowSha256', row_sha256,
    'closureCanonicalJson', closure_canonical_json,
    'closureSha256', 'sha256:' || encode(extensions.digest(closure_canonical_json, 'sha256'), 'hex')
  ) order by ordinal_position)
  from closure_material
$$;

create function pg_temp.jiaowubao_student_source_fixture_normalized_sha256(
  p_closures jsonb
)
returns text
language sql
as $$
  select 'sha256:' || encode(extensions.digest(
    '[' || string_agg(closure_value ->> 'closureCanonicalJson', ',' order by ordinal_position) || ']',
    'sha256'
  ), 'hex')
  from jsonb_array_elements(p_closures) with ordinality closures(closure_value, ordinal_position)
$$;

do $jiaowubao_student_source_chunk_contract$
declare
  fixture_secret text := current_setting('app.jiaowubao_student_source_fixture_secret');
  source_pointer_before text;
  master_before text;
  business_state_before text;
  identity_links_before text;
  source_pointer_after text;
  master_after text;
  business_state_after text;
  identity_links_after text;
  fixture_run_id uuid;
  receipt jsonb;
  expected_published_jwb jsonb;
  source_revisions jsonb := jsonb_build_object(
    'students', 'sha256:' || repeat('1', 64),
    'contracts', 'sha256:' || repeat('2', 64),
    'courseBalances', 'sha256:' || repeat('3', 64)
  );
  closures_zero jsonb;
  closures_changed jsonb;
  normalized_zero_sha256 text;
  rows_zero jsonb := jsonb_build_array(jsonb_build_object(
    'sourceRow', 'fixture:student:0', 'name', '测试学生', 'packageCoverage', 'none',
    'attributes', jsonb_build_object('jiaowubaoPackageImport', jsonb_build_object(
      'status', 'aggregate_only_no_current_courses', 'currentTotalHours', 0,
      'currentUsedHours', 0, 'currentRemainingHours', 0,
      'unresolvedCourseBalances', '[]'::jsonb, 'adjustmentContracts', '[]'::jsonb
    ))
  ));
  rows_changed jsonb := jsonb_build_array(jsonb_build_object(
    'sourceRow', 'fixture:student:0', 'name', '测试学生修改', 'packageCoverage', 'none',
    'attributes', jsonb_build_object('jiaowubaoPackageImport', jsonb_build_object(
      'status', 'aggregate_only_no_current_courses', 'currentTotalHours', 0,
      'currentUsedHours', 0, 'currentRemainingHours', 0,
      'unresolvedCourseBalances', '[]'::jsonb, 'adjustmentContracts', '[]'::jsonb
    ))
  ));
begin
  closures_zero := pg_temp.jiaowubao_student_source_fixture_closures(
    rows_zero, 'jiaowubao-runtime-fixture', 'runtime-abort', source_revisions
  );
  closures_changed := pg_temp.jiaowubao_student_source_fixture_closures(
    rows_changed, 'jiaowubao-runtime-fixture', 'runtime-abort', source_revisions
  );
  normalized_zero_sha256 := pg_temp.jiaowubao_student_source_fixture_normalized_sha256(closures_zero);
  select coalesce((select source_id || '|' || revision || '|' || rows_sha256
                   from internal.student_import_source_rows where source_kind = 'jwb'), '<none>')
  into source_pointer_before;
  select jsonb_build_object(
    'sourceId', source_row.source_id,
    'revision', source_row.revision,
    'rowsSha256', source_row.rows_sha256,
    'rowCount', source_row.row_count
  ) into expected_published_jwb
  from internal.student_import_source_rows source_row
  where source_row.source_kind = 'jwb';
  if expected_published_jwb is null
     or public.get_jiaowubao_student_source_ingest_preflight(fixture_secret, 'Ops Admin')
          -> 'currentJwb' is distinct from expected_published_jwb then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_preflight_failed';
  end if;
  select coalesce((select source_id || '|' || revision || '|' || rows_sha256
                   from internal.student_import_source_rows where source_kind = 'master'), '<none>')
  into master_before;
  select encode(extensions.digest(coalesce(
    (select jsonb_agg(to_jsonb(state_row) order by state_row.entity)::text
     from public.ops_state state_row
     where state_row.entity in ('students', 'packages', 'bookings', 'tasks')), ''), 'sha256'), 'hex')
  into business_state_before;
  select encode(extensions.digest(coalesce(
    (select row_to_json(link_set)::text from internal.student_import_identity_link_sets link_set
     where link_set.singleton), ''), 'sha256'), 'hex')
  into identity_links_before;

  receipt := public.begin_jiaowubao_student_source_ingest(
    fixture_secret,
    jsonb_build_object('sourceId', 'jiaowubao-runtime-fixture', 'revision', 'runtime-abort',
      'candidateArtifactSha256', 'sha256:' || repeat('a', 64),
      'sourceRevisions', source_revisions, 'normalizedRowsSha256', normalized_zero_sha256,
      'expectedPublishedJwb', expected_published_jwb,
      'expectedRowCount', 2,
      'expectedChunkCount', 2, 'sourceMetadata', jsonb_build_object('fixture', 'rollback')),
    'Ops Admin'
  );
  fixture_run_id := (receipt ->> 'runId')::uuid;

  begin
    perform public.stage_jiaowubao_student_source_chunk(fixture_secret, fixture_run_id, 1, closures_zero, 'Ops Admin');
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_gap_not_rejected';
  exception when others then
    if sqlerrm <> 'jiaowubao_student_source_chunk_sequence_gap' then raise; end if;
  end;
  perform public.stage_jiaowubao_student_source_chunk(fixture_secret, fixture_run_id, 0, closures_zero, 'Ops Admin');
  select coalesce((select source_id || '|' || revision || '|' || rows_sha256
                   from internal.student_import_source_rows where source_kind = 'jwb'), '<none>')
  into source_pointer_after;
  if source_pointer_after <> source_pointer_before then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_precomplete_visibility_failed';
  end if;
  receipt := public.stage_jiaowubao_student_source_chunk(fixture_secret, fixture_run_id, 0, closures_zero, 'Ops Admin');
  if receipt ->> 'replayed' <> 'true' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_replay_failed';
  end if;
  begin
    perform public.stage_jiaowubao_student_source_chunk(fixture_secret, fixture_run_id, 0, closures_changed, 'Ops Admin');
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_conflict_not_rejected';
  exception when others then
    if sqlerrm <> 'jiaowubao_student_source_chunk_conflict' then raise; end if;
  end;
  begin
    perform public.stage_jiaowubao_student_source_chunk(fixture_secret, fixture_run_id, 1, closures_zero, 'Ops Admin');
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_duplicate_not_rejected';
  exception when others then
    if sqlerrm <> 'jiaowubao_student_source_source_row_conflict' then raise; end if;
  end;
  begin
    perform public.complete_jiaowubao_student_source_ingest(fixture_secret, fixture_run_id, 'Ops Admin');
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_incomplete_not_rejected';
  exception when others then
    if sqlerrm <> 'jiaowubao_student_source_incomplete' then raise; end if;
  end;
  perform public.abort_jiaowubao_student_source_ingest(fixture_secret, fixture_run_id, 'Ops Admin');
  if exists (select 1 from internal.jiaowubao_student_source_ingest_chunks chunk where chunk.run_id = fixture_run_id)
     or not exists (select 1 from internal.jiaowubao_student_source_ingest_runs
                    where id = fixture_run_id and state = 'aborted') then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_abort_cleanup_failed';
  end if;

  -- A candidate is bound to the exact previously published JWB pointer. A
  -- malformed/stale pointer may stage privately but can never publish.
  receipt := public.begin_jiaowubao_student_source_ingest(
    fixture_secret,
    jsonb_build_object('sourceId', 'jiaowubao-runtime-fixture', 'revision', 'runtime-pointer-conflict',
      'candidateArtifactSha256', 'sha256:' || repeat('c', 64),
      'sourceRevisions', source_revisions,
      'normalizedRowsSha256', pg_temp.jiaowubao_student_source_fixture_normalized_sha256(
        pg_temp.jiaowubao_student_source_fixture_closures(
          rows_zero, 'jiaowubao-runtime-fixture', 'runtime-pointer-conflict', source_revisions
        )
      ),
      'expectedPublishedJwb', jsonb_set(
        expected_published_jwb, '{rowsSha256}', to_jsonb(case
          when expected_published_jwb ->> 'rowsSha256' = repeat('0', 64) then repeat('f', 64)
          else repeat('0', 64)
        end)
      ),
      'expectedRowCount', 1,
      'expectedChunkCount', 1, 'sourceMetadata', jsonb_build_object('fixture', 'rollback')),
    'Ops Admin'
  );
  fixture_run_id := (receipt ->> 'runId')::uuid;
  perform public.stage_jiaowubao_student_source_chunk(
    fixture_secret, fixture_run_id, 0,
    pg_temp.jiaowubao_student_source_fixture_closures(
      rows_zero, 'jiaowubao-runtime-fixture', 'runtime-pointer-conflict', source_revisions
    ),
    'Ops Admin'
  );
  begin
    perform public.complete_jiaowubao_student_source_ingest(fixture_secret, fixture_run_id, 'Ops Admin');
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_pointer_conflict_not_rejected';
  exception when others then
    if sqlerrm <> 'jiaowubao_student_source_publication_pointer_changed' then raise; end if;
  end;
  perform public.abort_jiaowubao_student_source_ingest(fixture_secret, fixture_run_id, 'Ops Admin');

  receipt := public.begin_jiaowubao_student_source_ingest(
    fixture_secret,
    jsonb_build_object('sourceId', 'jiaowubao-runtime-fixture', 'revision', 'runtime-complete',
      'candidateArtifactSha256', 'sha256:' || repeat('b', 64),
      'sourceRevisions', source_revisions,
      'normalizedRowsSha256', pg_temp.jiaowubao_student_source_fixture_normalized_sha256(
        pg_temp.jiaowubao_student_source_fixture_closures(
          rows_zero, 'jiaowubao-runtime-fixture', 'runtime-complete', source_revisions
        )
      ),
      'expectedPublishedJwb', expected_published_jwb,
      'expectedRowCount', 1,
      'expectedChunkCount', 1, 'sourceMetadata', jsonb_build_object('fixture', 'rollback')),
    'Ops Admin'
  );
  fixture_run_id := (receipt ->> 'runId')::uuid;
  perform public.stage_jiaowubao_student_source_chunk(
    fixture_secret, fixture_run_id, 0,
    pg_temp.jiaowubao_student_source_fixture_closures(
      rows_zero, 'jiaowubao-runtime-fixture', 'runtime-complete', source_revisions
    ),
    'Ops Admin'
  );
  receipt := public.complete_jiaowubao_student_source_ingest(fixture_secret, fixture_run_id, 'Ops Admin');
  if receipt ->> 'state' <> 'complete' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_completion_failed';
  end if;
  select source_id || '|' || revision || '|' || rows_sha256 into source_pointer_after
  from internal.student_import_source_rows where source_kind = 'jwb';
  if source_pointer_after not like 'jiaowubao-runtime-fixture|runtime-complete|%' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_pointer_publish_failed';
  end if;
  select coalesce((select source_id || '|' || revision || '|' || rows_sha256
                   from internal.student_import_source_rows where source_kind = 'master'), '<none>')
  into master_after;
  select encode(extensions.digest(coalesce(
    (select jsonb_agg(to_jsonb(state_row) order by state_row.entity)::text
     from public.ops_state state_row
     where state_row.entity in ('students', 'packages', 'bookings', 'tasks')), ''), 'sha256'), 'hex')
  into business_state_after;
  select encode(extensions.digest(coalesce(
    (select row_to_json(link_set)::text from internal.student_import_identity_link_sets link_set
     where link_set.singleton), ''), 'sha256'), 'hex')
  into identity_links_after;
  if master_after <> master_before or business_state_after <> business_state_before
     or identity_links_after <> identity_links_before then
    raise exception using errcode = 'P0001', message = 'jiaowubao_student_source_business_state_mutated';
  end if;
end;
$jiaowubao_student_source_chunk_contract$;

rollback;

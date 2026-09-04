-- Deterministic recovery for the dual-source completed-month snapshot.
--
-- 001-003 already model terminal `aborted` runs. This forward-only migration
-- centralises retirement so a pointer race or a conflicting stale staging
-- envelope cannot permanently reserve one source revision. It also permits a
-- previously completed revision to become current again when the upstream
-- source genuinely returns to that exact, already-verified snapshot.

create or replace function internal.abort_jiaowubao_completed_lesson_snapshot_run(
  p_run_id uuid,
  p_actor text,
  p_reason text,
  p_context jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype;
  audit_id uuid;
  lesson_page_count integer;
  lesson_row_count integer;
  schedule_page_count integer;
  schedule_row_count integer;
  context_value jsonb := coalesce(p_context, '{}'::jsonb);
begin
  if p_actor is distinct from 'Ops Admin'
     or p_reason is null
     or p_reason not in (
       'caller_failure',
       'current_pointer_conflict',
       'staging_envelope_conflict',
       'superseded_current_pointer'
     )
     or jsonb_typeof(context_value) is distinct from 'object'
     or octet_length(context_value::text) > 4096
     or lower(context_value::text) ~ '"(sk|secret|token|password|authorization|cookie)"\s*:' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_internal_abort_forbidden';
  end if;

  select * into run_state
  from internal.jiaowubao_completed_lesson_snapshot_runs run_row
  where run_row.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_run_not_found';
  end if;
  if run_state.state = 'aborted' then
    return jsonb_build_object('runId', p_run_id, 'state', 'aborted', 'replayed', true);
  end if;
  if run_state.staged_by is distinct from p_actor or run_state.state is distinct from 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_not_staging';
  end if;

  select count(*)::integer, coalesce(sum(row_count), 0)::integer
  into lesson_page_count, lesson_row_count
  from internal.jiaowubao_completed_lesson_snapshot_pages
  where run_id = p_run_id;
  select count(*)::integer, coalesce(sum(row_count), 0)::integer
  into schedule_page_count, schedule_row_count
  from internal.jiaowubao_completed_lesson_snapshot_schedule_pages
  where run_id = p_run_id;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_completed_lesson_snapshot_ingest.aborted',
    p_actor,
    'jiaowubao_completed_lesson_snapshot_run',
    p_run_id::text,
    context_value || jsonb_build_object(
      'reason', p_reason,
      'month', to_char(run_state.period_month, 'YYYY-MM'),
      'revision', run_state.revision,
      'expectedCurrentRevision', run_state.expected_current_revision,
      'stagedLessonPageCount', lesson_page_count,
      'stagedLessonRowCount', lesson_row_count,
      'stagedSchedulePageCount', schedule_page_count,
      'stagedScheduleRowCount', schedule_row_count
    )
  );

  perform pg_catalog.set_config(
    'internal.jiaowubao_completed_lesson_snapshot_abort_run_id',
    p_run_id::text,
    true
  );
  delete from internal.jiaowubao_completed_lesson_snapshot_schedule_events where run_id = p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id = p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_items where run_id = p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_pages where run_id = p_run_id;
  update internal.jiaowubao_completed_lesson_snapshot_runs
  set state = 'aborted', aborted_at = clock_timestamp(), abort_audit_id = audit_id
  where id = p_run_id;

  return jsonb_build_object(
    'runId', p_run_id,
    'state', 'aborted',
    'abortReason', p_reason,
    'replayed', false
  );
end;
$$;
revoke all on function internal.abort_jiaowubao_completed_lesson_snapshot_run(uuid,text,text,jsonb)
from public, anon, authenticated;

create or replace function public.begin_jiaowubao_completed_lesson_snapshot_ingest(
  p_secret text,
  p_envelope jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.jiaowubao_completed_lesson_snapshot_runs%rowtype;
  current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
  audit_id uuid;
  run_id uuid := gen_random_uuid();
  month_value date;
  expected_page_count integer;
  expected_row_count integer;
  expected_schedule_page_count integer;
  expected_schedule_row_count integer;
  observed_current_revision text;
  same_snapshot boolean;
  current_matches_saved boolean;
  abort_reason text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_actor_forbidden';
  end if;
  perform internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope);
  expected_page_count := (p_envelope ->> 'expectedPageCount')::integer;
  expected_row_count := (p_envelope ->> 'expectedRowCount')::integer;
  expected_schedule_page_count := (p_envelope ->> 'expectedSchedulePageCount')::integer;
  expected_schedule_row_count := (p_envelope ->> 'expectedScheduleRowCount')::integer;
  month_value := to_date((p_envelope ->> 'month') || '-01', 'YYYY-MM-DD');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || month_value::text, 0)
  );
  select * into current_row
  from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
    and current_pointer.period_month = month_value
  for update;
  observed_current_revision := case when found then current_row.revision else null end;

  select * into saved
  from internal.jiaowubao_completed_lesson_snapshot_runs run_row
  where run_row.period_month = month_value
    and run_row.revision = p_envelope ->> 'revision'
    and run_row.state in ('staging', 'complete')
  for update;
  if found then
    same_snapshot := saved.query is not distinct from p_envelope -> 'query'
      and saved.expected_page_count = expected_page_count
      and saved.expected_row_count = expected_row_count
      and saved.expected_schedule_page_count = expected_schedule_page_count
      and saved.expected_schedule_row_count = expected_schedule_row_count
      and saved.external_manifest_sha256 is not distinct from p_envelope ->> 'externalManifestSha256'
      and saved.source_metadata is not distinct from p_envelope -> 'sourceMetadata';

    current_matches_saved := saved.state = 'complete'
      and current_row.run_id is not distinct from saved.id
      and current_row.revision is not distinct from saved.revision
      and current_row.row_count is not distinct from saved.expected_row_count
      and current_row.schedule_row_count is not distinct from saved.expected_schedule_row_count
      and current_row.rows_sha256 is not distinct from saved.canonical_rows_sha256
      and current_row.payload_sha256 is not distinct from saved.payload_sha256;

    if saved.state = 'staging'
       and same_snapshot
       and saved.expected_current_revision is not distinct from p_envelope ->> 'expectedCurrentRevision' then
      return jsonb_build_object('runId', saved.id, 'state', saved.state, 'replayed', true);
    end if;

    -- A republish response can be lost. The exact retry still carries the old
    -- expected pointer, so prove the immutable run is already current before
    -- returning success instead of failing its now-stale CAS token.
    if same_snapshot and current_matches_saved then
      return jsonb_build_object(
        'runId', saved.id,
        'state', 'complete',
        'replayed', true,
        'republished', false
      );
    end if;

    if saved.state = 'complete' then
      if not same_snapshot then
        raise exception using errcode = '23505', message = 'jiaowubao_completed_lesson_snapshot_envelope_conflict';
      end if;
      if observed_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision' then
        raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_current_pointer_conflict';
      end if;

      audit_id := internal.append_operational_contract_audit(
        'jiaowubao_completed_lesson_snapshot.republished',
        p_actor,
        'jiaowubao_completed_lesson_snapshot_run',
        saved.id::text,
        jsonb_build_object(
          'month', to_char(month_value, 'YYYY-MM'),
          'revision', saved.revision,
          'previousCurrentRevision', observed_current_revision,
          'reason', 'source_revision_reappeared'
        )
      );
      insert into internal.jiaowubao_completed_lesson_snapshot_current(
        api_source_key,
        period_month,
        run_id,
        revision,
        row_count,
        schedule_row_count,
        rows_sha256,
        payload_sha256,
        published_at,
        audit_id
      ) values (
        'jwb-open-api-completed-lessons',
        month_value,
        saved.id,
        saved.revision,
        saved.expected_row_count,
        saved.expected_schedule_row_count,
        saved.canonical_rows_sha256,
        saved.payload_sha256,
        clock_timestamp(),
        audit_id
      )
      on conflict (api_source_key, period_month) do update
      set run_id = excluded.run_id,
          revision = excluded.revision,
          row_count = excluded.row_count,
          schedule_row_count = excluded.schedule_row_count,
          rows_sha256 = excluded.rows_sha256,
          payload_sha256 = excluded.payload_sha256,
          published_at = excluded.published_at,
          audit_id = excluded.audit_id;
      return jsonb_build_object(
        'runId', saved.id,
        'state', 'complete',
        'replayed', true,
        'republished', true
      );
    end if;

    abort_reason := case
      when saved.expected_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision'
        then 'superseded_current_pointer'
      else 'staging_envelope_conflict'
    end;
    perform internal.abort_jiaowubao_completed_lesson_snapshot_run(
      saved.id,
      p_actor,
      abort_reason,
      jsonb_build_object(
        'observedCurrentRevision', observed_current_revision,
        'replacementExpectedCurrentRevision', p_envelope ->> 'expectedCurrentRevision',
        'replacementRevision', p_envelope ->> 'revision'
      )
    );
  end if;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_completed_lesson_snapshot_ingest.started',
    p_actor,
    'jiaowubao_completed_lesson_snapshot_run',
    run_id::text,
    jsonb_build_object(
      'month', p_envelope ->> 'month',
      'revision', p_envelope ->> 'revision',
      'expectedPageCount', expected_page_count,
      'expectedRowCount', expected_row_count,
      'expectedSchedulePageCount', expected_schedule_page_count,
      'expectedScheduleRowCount', expected_schedule_row_count
    )
  );
  insert into internal.jiaowubao_completed_lesson_snapshot_runs(
    id,
    api_source_key,
    period_month,
    revision,
    query,
    expected_page_count,
    expected_row_count,
    expected_schedule_page_count,
    expected_schedule_row_count,
    expected_current_revision,
    external_manifest_sha256,
    source_metadata,
    staged_by,
    staging_audit_id
  ) values (
    run_id,
    'jwb-open-api-completed-lessons',
    month_value,
    p_envelope ->> 'revision',
    p_envelope -> 'query',
    expected_page_count,
    expected_row_count,
    expected_schedule_page_count,
    expected_schedule_row_count,
    p_envelope ->> 'expectedCurrentRevision',
    p_envelope ->> 'externalManifestSha256',
    p_envelope -> 'sourceMetadata',
    p_actor,
    audit_id
  );
  return jsonb_build_object('runId', run_id, 'state', 'staging', 'replayed', false);
end;
$$;

create or replace function public.complete_jiaowubao_completed_lesson_snapshot_ingest(
  p_secret text,
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype;
  current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
  period_month_value date;
  observed_current_revision text;
  lesson_page_count integer;
  lesson_row_count integer;
  schedule_page_count integer;
  schedule_row_count integer;
  rows_hash text;
  payload_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_complete_forbidden';
  end if;

  select period_month into period_month_value
  from internal.jiaowubao_completed_lesson_snapshot_runs run_row
  where run_row.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_run_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || period_month_value::text, 0)
  );
  select * into run_state
  from internal.jiaowubao_completed_lesson_snapshot_runs run_row
  where run_row.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_run_not_found';
  end if;
  if run_state.state = 'complete' then
    return jsonb_build_object(
      'runId', p_run_id,
      'state', 'complete',
      'rowCount', run_state.expected_row_count,
      'scheduleRowCount', run_state.expected_schedule_row_count,
      'rowsSha256', run_state.canonical_rows_sha256,
      'payloadSha256', run_state.payload_sha256,
      'replayed', true
    );
  end if;
  if run_state.state is distinct from 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_not_staging';
  end if;
  if run_state.period_month is distinct from period_month_value then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_period_invalid';
  end if;

  select * into current_row
  from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
    and current_pointer.period_month = run_state.period_month
  for update;
  observed_current_revision := case when found then current_row.revision else null end;
  if observed_current_revision is distinct from run_state.expected_current_revision then
    return internal.abort_jiaowubao_completed_lesson_snapshot_run(
      p_run_id,
      p_actor,
      'current_pointer_conflict',
      jsonb_build_object(
        'observedCurrentRevision', observed_current_revision,
        'replacementRevision', run_state.revision
      )
    );
  end if;

  select count(*)::integer, coalesce(sum(row_count), 0)::integer
  into lesson_page_count, lesson_row_count
  from internal.jiaowubao_completed_lesson_snapshot_pages
  where run_id = p_run_id;
  select count(*)::integer, coalesce(sum(row_count), 0)::integer
  into schedule_page_count, schedule_row_count
  from internal.jiaowubao_completed_lesson_snapshot_schedule_pages
  where run_id = p_run_id;
  if lesson_page_count <> run_state.expected_page_count
     or lesson_row_count <> run_state.expected_row_count
     or exists (
       select 1 from generate_series(0, run_state.expected_page_count - 1) expected_page
       where not exists (
         select 1 from internal.jiaowubao_completed_lesson_snapshot_pages
         where run_id = p_run_id and page_index = expected_page
       )
     ) then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_pages_incomplete';
  end if;
  if schedule_page_count <> run_state.expected_schedule_page_count
     or schedule_row_count <> run_state.expected_schedule_row_count
     or exists (
       select 1 from generate_series(0, run_state.expected_schedule_page_count - 1) expected_page
       where not exists (
         select 1 from internal.jiaowubao_completed_lesson_snapshot_schedule_pages
         where run_id = p_run_id and page_index = expected_page
       )
     ) then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_schedule_pages_incomplete';
  end if;

  select 'sha256:' || encode(extensions.digest(
    coalesce((
      select string_agg(canonical_json, '' order by page_index, item_index)
      from internal.jiaowubao_completed_lesson_snapshot_items where run_id = p_run_id
    ), '') || '|' || coalesce((
      select string_agg(canonical_json, '' order by page_index, item_index)
      from internal.jiaowubao_completed_lesson_snapshot_schedule_events where run_id = p_run_id
    ), ''),
    'sha256'
  ), 'hex') into rows_hash;
  select 'sha256:' || encode(extensions.digest(
    coalesce((
      select string_agg(page_sha256, '' order by page_index)
      from internal.jiaowubao_completed_lesson_snapshot_pages where run_id = p_run_id
    ), '') || '|' || coalesce((
      select string_agg(page_sha256, '' order by page_index)
      from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id = p_run_id
    ), ''),
    'sha256'
  ), 'hex') into payload_hash;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_completed_lesson_snapshot_ingest.completed',
    p_actor,
    'jiaowubao_completed_lesson_snapshot_run',
    p_run_id::text,
    jsonb_build_object(
      'month', to_char(run_state.period_month, 'YYYY-MM'),
      'revision', run_state.revision,
      'pageCount', lesson_page_count,
      'rowCount', lesson_row_count,
      'schedulePageCount', schedule_page_count,
      'scheduleRowCount', schedule_row_count,
      'rowsSha256', rows_hash,
      'payloadSha256', payload_hash
    )
  );
  update internal.jiaowubao_completed_lesson_snapshot_runs
  set state = 'complete',
      canonical_rows_sha256 = rows_hash,
      payload_sha256 = payload_hash,
      completed_at = clock_timestamp(),
      completion_audit_id = audit_id
  where id = p_run_id;
  insert into internal.jiaowubao_completed_lesson_snapshot_current(
    api_source_key,
    period_month,
    run_id,
    revision,
    row_count,
    schedule_row_count,
    rows_sha256,
    payload_sha256,
    audit_id
  ) values (
    'jwb-open-api-completed-lessons',
    run_state.period_month,
    p_run_id,
    run_state.revision,
    lesson_row_count,
    schedule_row_count,
    rows_hash,
    payload_hash,
    audit_id
  )
  on conflict (api_source_key, period_month) do update
  set run_id = excluded.run_id,
      revision = excluded.revision,
      row_count = excluded.row_count,
      schedule_row_count = excluded.schedule_row_count,
      rows_sha256 = excluded.rows_sha256,
      payload_sha256 = excluded.payload_sha256,
      published_at = clock_timestamp(),
      audit_id = excluded.audit_id;
  return jsonb_build_object(
    'runId', p_run_id,
    'state', 'complete',
    'rowCount', lesson_row_count,
    'scheduleRowCount', schedule_row_count,
    'rowsSha256', rows_hash,
    'payloadSha256', payload_hash,
    'replayed', false
  );
end;
$$;

create or replace function public.abort_jiaowubao_completed_lesson_snapshot_ingest(
  p_secret text,
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_abort_forbidden';
  end if;
  return internal.abort_jiaowubao_completed_lesson_snapshot_run(
    p_run_id,
    p_actor,
    'caller_failure',
    '{}'::jsonb
  );
end;
$$;
revoke all on function public.abort_jiaowubao_completed_lesson_snapshot_ingest(text,uuid,text)
from public, anon, authenticated;
grant execute on function public.abort_jiaowubao_completed_lesson_snapshot_ingest(text,uuid,text)
to anon, authenticated;

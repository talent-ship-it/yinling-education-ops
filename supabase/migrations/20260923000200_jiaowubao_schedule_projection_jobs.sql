-- Bind every published JWB schedule pointer to a durable projection job. If a
-- serverless invocation ends after publication, the next invocation resumes
-- the exact revision before any newer source snapshot can be collected.

create table if not exists internal.jiaowubao_open_api_schedule_projection_jobs (
  api_source_key text primary key check (api_source_key = 'jwb-open-api-schedule'),
  run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id),
  revision text not null check (revision ~ '^sha256:[a-f0-9]{64}$'),
  window_start date not null,
  window_end date not null check (window_end - window_start between 0 and 92),
  row_count integer not null check (row_count between 0 and 50000),
  state text not null check (state in ('pending','authority_done','complete')),
  source_published_at timestamptz not null,
  authority_completed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  last_audit_id uuid not null references internal.operational_contract_audit(id),
  check (
    (state = 'pending' and authority_completed_at is null and completed_at is null)
    or (state = 'authority_done' and authority_completed_at is not null and completed_at is null)
    or (state = 'complete' and authority_completed_at is not null and completed_at is not null)
  )
);

alter table internal.jiaowubao_open_api_schedule_projection_jobs enable row level security;
revoke all on table internal.jiaowubao_open_api_schedule_projection_jobs from public, anon, authenticated;

create or replace function internal.jiaowubao_schedule_projection_date(p_value text)
returns date
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $jiaowubao_schedule_projection_date$
begin
  if p_value !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p_value::date;
exception when datetime_field_overflow or invalid_datetime_format then
  return null;
end;
$jiaowubao_schedule_projection_date$;

revoke all on function internal.jiaowubao_schedule_projection_date(text)
from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_schedule_projection_allows_stale_trial(
  p_revision text,
  p_actor text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $jiaowubao_schedule_projection_allows_stale_trial$
  select exists (
    select 1
    from internal.jiaowubao_open_api_schedule_projection_jobs projection_job
    where projection_job.api_source_key = 'jwb-open-api-schedule'
      and projection_job.revision = p_revision
      and projection_job.state = 'authority_done'
  ) and p_actor is not distinct from 'Ops Admin'
$jiaowubao_schedule_projection_allows_stale_trial$;

revoke all on function internal.jiaowubao_schedule_projection_allows_stale_trial(text,text)
from public, anon, authenticated, service_role;

do $bind_stale_trial_recovery$
declare
  definition text;
  needle text := 'pointer.published_at < clock_timestamp() - interval ''2 hours''';
  replacement text := '(pointer.published_at < clock_timestamp() - interval ''2 hours'''
    || ' and not internal.jiaowubao_schedule_projection_allows_stale_trial(p_snapshot_revision,p_actor))';
begin
  select pg_catalog.pg_get_functiondef(
    'public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure
  ) into definition;
  if pg_catalog.strpos(definition, needle) = 0
     or pg_catalog.strpos(
       pg_catalog.substr(definition, pg_catalog.strpos(definition, needle) + pg_catalog.length(needle)),
       needle
     ) > 0 then
    raise exception 'jiaowubao_trial_sync_v2_freshness_guard_changed';
  end if;
  execute pg_catalog.replace(definition, needle, replacement);
end;
$bind_stale_trial_recovery$;

create or replace function internal.queue_jiaowubao_open_api_schedule_projection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $queue_jiaowubao_open_api_schedule_projection$
declare
  source_query jsonb;
  source_start date;
  source_end date;
  existing_job internal.jiaowubao_open_api_schedule_projection_jobs%rowtype;
begin
  if new.api_source_key is distinct from 'jwb-open-api-schedule' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.revision is not distinct from new.revision then
    return new;
  end if;
  select * into existing_job
  from internal.jiaowubao_open_api_schedule_projection_jobs projection_job
  where projection_job.api_source_key = new.api_source_key
  for update;
  if found
     and existing_job.revision is distinct from new.revision
     and existing_job.state <> 'complete' then
    raise exception using
      errcode = '55000',
      message = 'jiaowubao_schedule_projection_pending';
  end if;
  select source_run.query into source_query
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs source_run
  where source_run.id = new.run_id
    and source_run.state = 'complete';
  if not found
     or jsonb_typeof(source_query) is distinct from 'object'
     or coalesce(source_query ->> 'start', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(source_query ->> 'end', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_projection_window_invalid';
  end if;
  source_start := internal.jiaowubao_schedule_projection_date(source_query ->> 'start');
  source_end := internal.jiaowubao_schedule_projection_date(source_query ->> 'end');
  if source_start is null or source_end is null
     or source_end - source_start not between 0 and 92 then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_projection_window_invalid';
  end if;

  insert into internal.jiaowubao_open_api_schedule_projection_jobs(
    api_source_key, run_id, revision, window_start, window_end, row_count,
    state, source_published_at, authority_completed_at, completed_at,
    updated_at, last_audit_id
  ) values (
    new.api_source_key, new.run_id, new.revision, source_start, source_end,
    new.row_count, 'pending', new.published_at, null, null, now(), new.audit_id
  )
  on conflict (api_source_key) do update set
    run_id = excluded.run_id,
    revision = excluded.revision,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    row_count = excluded.row_count,
    state = 'pending',
    source_published_at = excluded.source_published_at,
    authority_completed_at = null,
    completed_at = null,
    updated_at = now(),
    last_audit_id = excluded.last_audit_id;
  return new;
end;
$queue_jiaowubao_open_api_schedule_projection$;

revoke all on function internal.queue_jiaowubao_open_api_schedule_projection()
from public, anon, authenticated;

drop trigger if exists queue_jiaowubao_open_api_schedule_projection
on internal.jiaowubao_open_api_schedule_snapshot_current;
create trigger queue_jiaowubao_open_api_schedule_projection
after insert or update of revision
on internal.jiaowubao_open_api_schedule_snapshot_current
for each row
execute function internal.queue_jiaowubao_open_api_schedule_projection();

insert into internal.jiaowubao_open_api_schedule_projection_jobs(
  api_source_key, run_id, revision, window_start, window_end, row_count,
  state, source_published_at, authority_completed_at, completed_at,
  updated_at, last_audit_id
)
select current_pointer.api_source_key,
  current_pointer.run_id,
  current_pointer.revision,
  parsed.source_start,
  parsed.source_end,
  current_pointer.row_count,
  'pending',
  current_pointer.published_at,
  null,
  null,
  now(),
  current_pointer.audit_id
from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
join internal.jiaowubao_open_api_schedule_snapshot_ingest_runs source_run
  on source_run.id = current_pointer.run_id
cross join lateral (
  select
    internal.jiaowubao_schedule_projection_date(source_run.query ->> 'start') as source_start,
    internal.jiaowubao_schedule_projection_date(source_run.query ->> 'end') as source_end
) parsed
where current_pointer.api_source_key = 'jwb-open-api-schedule'
  and source_run.state = 'complete'
  and parsed.source_start is not null
  and parsed.source_end - parsed.source_start between 0 and 92
on conflict (api_source_key) do nothing;

do $verify_projection_backfill$
begin
  if exists (
    select 1
    from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
    where current_pointer.api_source_key = 'jwb-open-api-schedule'
      and not exists (
        select 1
        from internal.jiaowubao_open_api_schedule_projection_jobs projection_job
        where projection_job.api_source_key = current_pointer.api_source_key
          and projection_job.revision = current_pointer.revision
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'jiaowubao_schedule_projection_backfill_invalid';
  end if;
end;
$verify_projection_backfill$;

create or replace function public.get_jiaowubao_open_api_schedule_projection_target(
  p_secret text,
  p_actor text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_open_api_schedule_projection_target$
declare
  target internal.jiaowubao_open_api_schedule_projection_jobs%rowtype;
  current_revision text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_schedule_projection_target_forbidden';
  end if;
  select current_pointer.revision into current_revision
  from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-schedule';
  if not found then
    return jsonb_build_object('state','absent');
  end if;
  select * into target
  from internal.jiaowubao_open_api_schedule_projection_jobs projection_job
  where projection_job.api_source_key = 'jwb-open-api-schedule';
  if not found or target.revision <> current_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_projection_job_missing';
  end if;
  return jsonb_build_object(
    'state','ready',
    'revision',target.revision,
    'rowCount',target.row_count,
    'projectionState',target.state,
    'window',jsonb_build_object(
      'start',to_char(target.window_start,'YYYY-MM-DD'),
      'end',to_char(target.window_end,'YYYY-MM-DD')
    ),
    'publishedAt',target.source_published_at
  );
end;
$get_jiaowubao_open_api_schedule_projection_target$;

create or replace function public.advance_jiaowubao_open_api_schedule_projection(
  p_secret text,
  p_revision text,
  p_expected_state text,
  p_next_state text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $advance_jiaowubao_open_api_schedule_projection$
declare
  current_revision text;
  target internal.jiaowubao_open_api_schedule_projection_jobs%rowtype;
  saved_audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor is distinct from 'Ops Admin'
     or p_revision is null
     or p_revision !~ '^sha256:[a-f0-9]{64}$'
     or not coalesce((
       p_expected_state = 'pending' and p_next_state = 'authority_done'
       or p_expected_state = 'authority_done' and p_next_state = 'complete'
       or p_expected_state = 'complete' and p_next_state = 'pending'
     ), false) then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_projection_transition_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-schedule-projection',0)
  );
  select current_pointer.revision into current_revision
  from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-schedule'
  for update;
  if not found then return jsonb_build_object('state','absent','replayed',false); end if;
  if current_revision <> p_revision then
    return jsonb_build_object(
      'state','reset','revision',current_revision,'replayed',false
    );
  end if;
  select * into target
  from internal.jiaowubao_open_api_schedule_projection_jobs projection_job
  where projection_job.api_source_key = 'jwb-open-api-schedule'
  for update;
  if not found or target.revision <> p_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_projection_job_missing';
  end if;
  if target.state = p_next_state
     or target.state = 'complete' and p_next_state = 'authority_done' then
    return jsonb_build_object(
      'state',target.state,'revision',target.revision,'replayed',true
    );
  end if;
  if target.state <> p_expected_state then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_projection_state_changed';
  end if;

  saved_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_open_api_schedule_projection.' || p_next_state,
    p_actor,
    'jiaowubao_open_api_schedule_projection',
    p_revision,
    jsonb_build_object('from',p_expected_state,'to',p_next_state)
  );
  update internal.jiaowubao_open_api_schedule_projection_jobs
  set state = p_next_state,
    authority_completed_at = case
      when p_next_state = 'pending' then null
      when p_next_state in ('authority_done','complete')
      then coalesce(authority_completed_at,now()) else authority_completed_at end,
    completed_at = case when p_next_state = 'complete' then now() else null end,
    updated_at = now(),
    last_audit_id = saved_audit_id
  where api_source_key = 'jwb-open-api-schedule';
  return jsonb_build_object(
    'state',p_next_state,'revision',p_revision,'replayed',false
  );
end;
$advance_jiaowubao_open_api_schedule_projection$;

revoke all on function public.get_jiaowubao_open_api_schedule_projection_target(text,text)
from public, anon, authenticated;
grant execute on function public.get_jiaowubao_open_api_schedule_projection_target(text,text)
to anon, authenticated;
revoke all on function public.advance_jiaowubao_open_api_schedule_projection(text,text,text,text,text)
from public, anon, authenticated;
grant execute on function public.advance_jiaowubao_open_api_schedule_projection(text,text,text,text,text)
to anon, authenticated;

create or replace function public.claim_jiaowubao_open_api_schedule_sync_lease_v2(
  p_secret text,
  p_api_source_key text,
  p_run_key text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $claim_jiaowubao_open_api_schedule_sync_lease_v2$
declare
  saved internal.jiaowubao_open_api_schedule_sync_leases%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_api_source_key is distinct from 'jwb-open-api-schedule'
     or p_run_key is null
     or p_run_key !~ '^jwb-open-api-schedule-sync:[0-9]{10,16}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_sync_lease_forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-open-api-schedule-sync:' || p_api_source_key, 0)
  );
  select * into saved
  from internal.jiaowubao_open_api_schedule_sync_leases lease_row
  where lease_row.api_source_key = p_api_source_key
  for update;
  if found and saved.lease_expires_at > now_at then
    return jsonb_build_object(
      'acquired',false,
      'runKey',saved.run_key,
      'retryAfterSeconds',greatest(
        1,
        ceil(extract(epoch from saved.lease_expires_at - now_at))::integer
      )
    );
  end if;
  insert into internal.jiaowubao_open_api_schedule_sync_leases(
    api_source_key,run_key,acquired_at,lease_expires_at
  ) values (
    p_api_source_key,p_run_key,now_at,now_at + interval '10 minutes'
  )
  on conflict (api_source_key) do update set
    run_key = excluded.run_key,
    acquired_at = excluded.acquired_at,
    lease_expires_at = excluded.lease_expires_at;
  return jsonb_build_object(
    'acquired',true,'runKey',p_run_key,'retryAfterSeconds',0
  );
end;
$claim_jiaowubao_open_api_schedule_sync_lease_v2$;

create or replace function public.release_jiaowubao_open_api_schedule_sync_lease_v2(
  p_secret text,
  p_api_source_key text,
  p_run_key text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $release_jiaowubao_open_api_schedule_sync_lease_v2$
declare
  saved internal.jiaowubao_open_api_schedule_sync_leases%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_api_source_key is distinct from 'jwb-open-api-schedule'
     or p_run_key is null
     or p_run_key !~ '^jwb-open-api-schedule-sync:[0-9]{10,16}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_sync_lease_forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-open-api-schedule-sync:' || p_api_source_key, 0)
  );
  select * into saved
  from internal.jiaowubao_open_api_schedule_sync_leases lease_row
  where lease_row.api_source_key = p_api_source_key
  for update;
  if not found or saved.run_key <> p_run_key then
    return jsonb_build_object('released',false);
  end if;
  update internal.jiaowubao_open_api_schedule_sync_leases
  set lease_expires_at = clock_timestamp()
  where api_source_key = p_api_source_key;
  return jsonb_build_object('released',true);
end;
$release_jiaowubao_open_api_schedule_sync_lease_v2$;

revoke all on function public.claim_jiaowubao_open_api_schedule_sync_lease_v2(text,text,text,text)
from public, anon, authenticated;
grant execute on function public.claim_jiaowubao_open_api_schedule_sync_lease_v2(text,text,text,text)
to anon, authenticated;
revoke all on function public.release_jiaowubao_open_api_schedule_sync_lease_v2(text,text,text,text)
from public, anon, authenticated;
grant execute on function public.release_jiaowubao_open_api_schedule_sync_lease_v2(text,text,text,text)
to anon, authenticated;

alter function public.project_jiaowubao_open_api_authority(text,text,text)
  set statement_timeout = '110s';
alter function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(text,jsonb,text)
  set statement_timeout = '110s';
alter function public.stage_jiaowubao_open_api_schedule_snapshot_page(text,uuid,integer,jsonb,text)
  set statement_timeout = '110s';
alter function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text)
  set statement_timeout = '110s';
alter function public.confirm_jiaowubao_open_api_schedule_snapshot_current(text,text,text,text)
  set statement_timeout = '110s';
alter function public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)
  set statement_timeout = '110s';
alter function public.advance_jiaowubao_open_api_schedule_projection(text,text,text,text,text)
  set statement_timeout = '110s';

comment on table internal.jiaowubao_open_api_schedule_projection_jobs is
  'Durable current-revision projection obligation; source refresh pauses until the job completes.';
comment on function public.get_jiaowubao_open_api_schedule_projection_target(text,text) is
  'Secret-gated aggregate projection target; returns no raw schedule records.';
comment on function public.advance_jiaowubao_open_api_schedule_projection(text,text,text,text,text) is
  'Secret-gated CAS transition for resumable authority and trial projection.';
comment on function public.claim_jiaowubao_open_api_schedule_sync_lease_v2(text,text,text,text) is
  'Attempt-unique 10-minute lease. Route work stops at 280 seconds and every mutating RPC at 110 seconds, so an invocation cannot issue or retain a write through takeover.';
comment on function public.release_jiaowubao_open_api_schedule_sync_lease_v2(text,text,text,text) is
  'Attempt-fenced schedule-sync lease release.';

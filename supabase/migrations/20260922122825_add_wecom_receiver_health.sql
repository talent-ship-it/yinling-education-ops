create table if not exists internal.wecom_receiver_health (
  singleton boolean primary key default true check (singleton),
  health jsonb not null check (pg_catalog.jsonb_typeof(health) = 'object'),
  recorded_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table internal.wecom_receiver_health enable row level security;
revoke all on table internal.wecom_receiver_health from public, anon, authenticated, service_role;

create or replace function public.record_wecom_receiver_health(
  p_secret text,
  p_health jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'state','connected','startedAt','updatedAt','authenticatedAt','lastMessageAt',
    'receivedThisRun','initialRepliesThisRun','initialStreamRepliesThisRun',
    'initialStreamFailuresThisRun','initialReplyFallbacksThisRun','initialReplyFailuresThisRun',
    'acknowledgementsThisRun','acknowledgementFailuresThisRun','lastInitialReplyAt',
    'lastInitialStreamError','lastInitialStreamErrorAt','lastInitialReplyError',
    'lastInitialReplyErrorAt','lastAcknowledgementAt','lastAcknowledgementError'
  ];
  count_key text;
  date_key text;
  error_key text;
  parsed_date timestamptz;
  recorded timestamptz := pg_catalog.clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_health is null or pg_catalog.jsonb_typeof(p_health) <> 'object'
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_health) as keys(key)
      where not (key = any (allowed_keys))
    )
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_health)) <> pg_catalog.array_length(allowed_keys, 1)
  then
    raise exception using errcode = '22023', message = 'invalid_wecom_receiver_health';
  end if;
  if p_health ->> 'state' not in (
    'starting','connected','authenticated','disconnected','reconnecting','error',
    'terminal_connection_error','storage_error','paused_duplicate_connection','stopped'
  ) or pg_catalog.jsonb_typeof(p_health -> 'connected') <> 'boolean' then
    raise exception using errcode = '22023', message = 'invalid_wecom_receiver_health';
  end if;

  foreach count_key in array array[
    'receivedThisRun','initialRepliesThisRun','initialStreamRepliesThisRun',
    'initialStreamFailuresThisRun','initialReplyFallbacksThisRun','initialReplyFailuresThisRun',
    'acknowledgementsThisRun','acknowledgementFailuresThisRun'
  ] loop
    if pg_catalog.jsonb_typeof(p_health -> count_key) <> 'number'
      or (p_health ->> count_key)::numeric <> pg_catalog.trunc((p_health ->> count_key)::numeric)
      or (p_health ->> count_key)::numeric < 0
      or (p_health ->> count_key)::numeric > 1000000000 then
      raise exception using errcode = '22023', message = 'invalid_wecom_receiver_health';
    end if;
  end loop;

  foreach date_key in array array[
    'startedAt','updatedAt','authenticatedAt','lastMessageAt','lastInitialReplyAt',
    'lastInitialStreamErrorAt','lastInitialReplyErrorAt','lastAcknowledgementAt'
  ] loop
    if p_health -> date_key = 'null'::jsonb and date_key not in ('startedAt','updatedAt') then continue; end if;
    if pg_catalog.jsonb_typeof(p_health -> date_key) <> 'string' then
      raise exception using errcode = '22023', message = 'invalid_wecom_receiver_health';
    end if;
    begin
      parsed_date := (p_health ->> date_key)::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_wecom_receiver_health';
    end;
  end loop;

  foreach error_key in array array[
    'lastInitialStreamError','lastInitialReplyError','lastAcknowledgementError'
  ] loop
    if p_health -> error_key = 'null'::jsonb then continue; end if;
    if pg_catalog.jsonb_typeof(p_health -> error_key) <> 'string'
      or p_health ->> error_key !~ '^[A-Za-z0-9_-]{1,80}$' then
      raise exception using errcode = '22023', message = 'invalid_wecom_receiver_health';
    end if;
  end loop;

  insert into internal.wecom_receiver_health(singleton, health, recorded_at)
  values (true, p_health, recorded)
  on conflict (singleton) do update
    set health = excluded.health, recorded_at = excluded.recorded_at;
  return pg_catalog.jsonb_build_object('outcome','committed','recordedAt',recorded);
end;
$$;

revoke all on function public.record_wecom_receiver_health(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_wecom_receiver_health(text, jsonb) to anon;

create or replace function public.get_wecom_archive_status(p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select pg_catalog.jsonb_build_object(
    'total', count(*),
    'linked', count(*) filter (where match_status = 'linked'),
    'ambiguous', count(*) filter (where match_status = 'ambiguous'),
    'pending', count(*) filter (where match_status = 'pending'),
    'trialAwaitingStudentName', (
      select count(*) from internal.wecom_trial_handover_cases where status = 'awaiting_student_name'
    ),
    'trialIdentified', (
      select count(*) from internal.wecom_trial_handover_cases where status = 'identified'
    ),
    'trialIdentityConflict', (
      select count(*) from internal.wecom_trial_handover_cases where status = 'identity_conflict'
    ),
    'trialIdentityAmbiguous', (
      select count(*) from internal.wecom_trial_handover_cases where status = 'identity_ambiguous'
    ),
    'latestSentAt', max(sent_at),
    'latestIngestedAt', max(ingested_at),
    'receiver', (
      select health || pg_catalog.jsonb_build_object('recordedAt', recorded_at)
      from internal.wecom_receiver_health where singleton
    )
  ) into result
  from internal.wecom_archive_messages;
  return result;
end;
$$;

revoke all on function public.get_wecom_archive_status(text)
  from public, anon, authenticated;
grant execute on function public.get_wecom_archive_status(text) to anon;

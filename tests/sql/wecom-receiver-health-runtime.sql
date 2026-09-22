\ir assert-disposable-database.sql
\set ON_ERROR_STOP on
begin;
create schema internal;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
exception when duplicate_object then null;
end $$;
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable set search_path = ''
as $$ select p_secret = 'synthetic-health-secret' $$;
create table internal.wecom_archive_messages(
  match_status text not null,
  sent_at timestamptz not null,
  ingested_at timestamptz not null
);
create table internal.wecom_trial_handover_cases(status text not null);

\ir ../../supabase/migrations/20260922122825_add_wecom_receiver_health.sql

do $test$
declare
  health jsonb := jsonb_build_object(
    'state','authenticated','connected',true,
    'startedAt','2026-09-22T00:00:00.000Z','updatedAt','2026-09-22T00:01:00.000Z',
    'authenticatedAt','2026-09-22T00:00:01.000Z','lastMessageAt',null,
    'receivedThisRun',2,'initialRepliesThisRun',2,'initialStreamRepliesThisRun',0,
    'initialStreamFailuresThisRun',2,'initialReplyFallbacksThisRun',2,'initialReplyFailuresThisRun',0,
    'acknowledgementsThisRun',2,'acknowledgementFailuresThisRun',0,
    'lastInitialReplyAt','2026-09-22T00:00:30.000Z',
    'lastInitialStreamError','93000','lastInitialStreamErrorAt','2026-09-22T00:00:29.000Z',
    'lastInitialReplyError',null,'lastInitialReplyErrorAt',null,
    'lastAcknowledgementAt','2026-09-22T00:00:40.000Z','lastAcknowledgementError',null
  );
  result jsonb;
begin
  result := public.record_wecom_receiver_health('synthetic-health-secret', health);
  assert result ->> 'outcome' = 'committed';
  result := public.get_wecom_archive_status('synthetic-health-secret');
  assert result -> 'receiver' ->> 'state' = 'authenticated';
  assert (result -> 'receiver' ->> 'initialReplyFallbacksThisRun')::integer = 2;
  assert result -> 'receiver' ? 'recordedAt';

  begin
    perform public.record_wecom_receiver_health('synthetic-health-secret', health || '{"callback":"private"}'::jsonb);
    raise exception 'extra health field accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.record_wecom_receiver_health('wrong-secret', health);
    raise exception 'invalid secret accepted';
  exception when insufficient_privilege then null;
  end;

  assert not has_table_privilege('anon','internal.wecom_receiver_health','SELECT');
  assert not has_table_privilege('authenticated','internal.wecom_receiver_health','SELECT');
  assert has_function_privilege('anon','public.record_wecom_receiver_health(text,jsonb)','EXECUTE');
  raise notice 'PASS: private receiver heartbeat, strict aggregate boundary and admin status projection';
end
$test$;
rollback;

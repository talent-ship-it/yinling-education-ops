\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create function internal.verify_ops_secret(text) returns boolean language sql as $$ select $1='synthetic-unclosed-secret' $$;
\ir ../../supabase/migrations/20261025214452_hr_unclosed_lesson_tasks.sql
\ir ../../supabase/migrations/20261025214452_hr_unclosed_lesson_tasks.sql

do $$
declare
  secret text:='synthetic-unclosed-secret'; checked timestamptz:='2020-10-25T00:00:00Z';
  row jsonb:='{"eventId":"jwb-open-api:schedule:1","date":"2020-10-23","courseName":"English","participants":[{"memberId":"11","name":"Alice"}],"firstDetectedAt":"2020-10-24T00:00:00.000Z","lastSeenAt":"2020-10-25T00:00:00.000Z"}';
  first_run uuid:='47000000-0000-4000-8000-000000000001'; second_run uuid:='47000000-0000-4000-8000-000000000002';
  stale_run uuid:='47000000-0000-4000-8000-000000000003'; aborted_run uuid:='47000000-0000-4000-8000-000000000004';
  duplicate_run uuid:='47000000-0000-4000-8000-000000000005'; receipt jsonb; before jsonb; current_rev text;
begin
  if has_table_privilege('anon','internal.jiaowubao_unclosed_pages','select') or has_table_privilege('authenticated','internal.jiaowubao_unclosed_runs','update') then raise exception 'private cache grants leaked'; end if;
  if public.read_jiaowubao_unclosed_snapshot(secret)->'lessons'<>'[]'::jsonb then raise exception 'initial cache not empty'; end if;
  begin perform public.read_jiaowubao_unclosed_snapshot('wrong'); raise exception 'wrong secret accepted'; exception when sqlstate '42501' then null; end;
  if internal.valid_jiaowubao_unclosed_lesson(row,checked) is not true then raise exception 'valid row rejected'; end if;
  if internal.valid_jiaowubao_unclosed_lesson(row||'{"date":"2026-02-30"}',checked) or internal.valid_jiaowubao_unclosed_lesson(row||'{"extra":"private"}',checked) or internal.valid_jiaowubao_unclosed_lesson(row||'{"firstDetectedAt":null}',checked) then raise exception 'invalid row accepted'; end if;
  perform public.begin_jiaowubao_unclosed_snapshot(secret,first_run,null,checked,1);
  begin perform public.complete_jiaowubao_unclosed_snapshot(secret,first_run); raise exception 'incomplete accepted'; exception when sqlstate '22023' then null; end;
  perform public.stage_jiaowubao_unclosed_snapshot(secret,first_run,0,jsonb_build_array(row));
  perform public.stage_jiaowubao_unclosed_snapshot(secret,first_run,0,jsonb_build_array(row));
  if public.read_jiaowubao_unclosed_snapshot(secret)->'lessons'<>'[]'::jsonb then raise exception 'partial publication visible'; end if;
  begin perform public.stage_jiaowubao_unclosed_snapshot(secret,first_run,0,jsonb_build_array(row||'{"courseName":"Other"}')); raise exception 'changed replay accepted'; exception when sqlstate '23505' then null; end;
  receipt:=public.complete_jiaowubao_unclosed_snapshot(secret,first_run);
  if receipt->>'revision' !~ '^sha256:[a-f0-9]{64}$' or receipt->>'rowCount'<>'1' then raise exception 'invalid receipt'; end if;
  if public.complete_jiaowubao_unclosed_snapshot(secret,first_run)<>receipt then raise exception 'completion replay changed'; end if;
  before:=public.read_jiaowubao_unclosed_snapshot(secret); current_rev:=receipt->>'revision';
  perform public.begin_jiaowubao_unclosed_snapshot(secret,second_run,current_rev,checked+interval '1 day',0);
  perform public.begin_jiaowubao_unclosed_snapshot(secret,stale_run,current_rev,checked+interval '1 day',0);
  perform public.begin_jiaowubao_unclosed_snapshot(secret,aborted_run,current_rev,checked+interval '1 day',0);
  perform public.abort_jiaowubao_unclosed_snapshot(secret,aborted_run);
  perform public.abort_jiaowubao_unclosed_snapshot(secret,aborted_run);
  begin perform public.complete_jiaowubao_unclosed_snapshot(secret,aborted_run); raise exception 'aborted publication accepted'; exception when sqlstate '55000' then null; end;
  if public.read_jiaowubao_unclosed_snapshot(secret)<>before then raise exception 'failed publication replaced current'; end if;
  perform public.begin_jiaowubao_unclosed_snapshot(secret,duplicate_run,current_rev,checked+interval '1 day',2);
  perform public.stage_jiaowubao_unclosed_snapshot(secret,duplicate_run,0,jsonb_build_array(row,row));
  begin perform public.complete_jiaowubao_unclosed_snapshot(secret,duplicate_run); raise exception 'duplicate IDs accepted'; exception when sqlstate '22023' then null; end;
  perform public.complete_jiaowubao_unclosed_snapshot(secret,second_run);
  begin perform public.complete_jiaowubao_unclosed_snapshot(secret,stale_run); raise exception 'stale publication accepted'; exception when sqlstate '40001' then null; end;
  if public.read_jiaowubao_unclosed_snapshot(secret)->'lessons'<>'[]'::jsonb then raise exception 'empty completed snapshot failed'; end if;
end $$;
rollback;

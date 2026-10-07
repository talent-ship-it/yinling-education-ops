\ir assert-disposable-database.sql
do $$
declare definition text:=pg_get_functiondef('public.get_jiaowubao_open_api_schedule_snapshot_window(text,timestamptz,timestamptz,text,text[],text[],integer,timestamptz,text,text,text[])'::regprocedure);
begin
  execute replace(definition,'public.get_jiaowubao_open_api_schedule_snapshot_window(', 'internal.fixture_reader_before(');
end;
$$;
revoke all on function internal.fixture_reader_before(text,timestamptz,timestamptz,text,text[],text[],integer,timestamptz,text,text,text[])
  from public,anon,authenticated,service_role;

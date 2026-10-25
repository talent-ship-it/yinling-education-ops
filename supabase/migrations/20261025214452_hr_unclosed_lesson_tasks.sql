create table if not exists internal.jiaowubao_unclosed_runs (
  id uuid primary key,
  expected_revision text,
  checked_at timestamptz not null,
  row_count integer not null check (row_count between 0 and 6000),
  state text not null default 'staging' check (state in ('staging','complete','aborted')),
  revision text,
  created_at timestamptz not null default now()
);
create table if not exists internal.jiaowubao_unclosed_pages (
  run_id uuid not null references internal.jiaowubao_unclosed_runs(id),
  page_index integer not null check (page_index between 0 and 59),
  rows jsonb not null check (jsonb_typeof(rows)='array'),
  primary key(run_id,page_index)
);
create table if not exists internal.jiaowubao_unclosed_current (
  singleton boolean primary key default true check(singleton),
  run_id uuid not null references internal.jiaowubao_unclosed_runs(id),
  revision text not null
);
alter table internal.jiaowubao_unclosed_runs enable row level security;
alter table internal.jiaowubao_unclosed_pages enable row level security;
alter table internal.jiaowubao_unclosed_current enable row level security;
revoke all on internal.jiaowubao_unclosed_runs,internal.jiaowubao_unclosed_pages,internal.jiaowubao_unclosed_current from public,anon,authenticated,service_role;

create or replace function internal.valid_jiaowubao_unclosed_lesson(p_row jsonb,p_checked_at timestamptz)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare person jsonb;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_row))<>6
    or not (p_row ?& array['eventId','date','courseName','participants','firstDetectedAt','lastSeenAt'])
    or coalesce(p_row->>'eventId','') !~ '^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
    or coalesce(p_row->>'eventId','') ~ '^jwb-open-api:schedule:0+$'
    or coalesce(p_row->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or to_char((p_row->>'date')::date,'YYYY-MM-DD')<>p_row->>'date'
    or coalesce(p_row->>'firstDetectedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or coalesce(p_row->>'lastSeenAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or (p_row->>'firstDetectedAt')::timestamptz > (p_row->>'lastSeenAt')::timestamptz
    or (p_row->>'lastSeenAt')::timestamptz > p_checked_at
    or jsonb_typeof(p_row->'participants') is distinct from 'array'
    or jsonb_array_length(p_row->'participants')>1000 then return false; end if;
  if p_row->'courseName'<>'null'::jsonb and (jsonb_typeof(p_row->'courseName')<>'string' or length(p_row->>'courseName')>240) then return false; end if;
  for person in select * from jsonb_array_elements(p_row->'participants') loop
    if jsonb_typeof(person)<>'object' or (select count(*) from jsonb_object_keys(person))<>2
      or not (person ?& array['memberId','name'])
      or jsonb_typeof(person->'memberId') is distinct from 'string'
      or coalesce(person->>'memberId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
      or coalesce(person->>'memberId','') ~ '^0+$'
      or (person->'name'<>'null'::jsonb and (jsonb_typeof(person->'name')<>'string' or length(person->>'name')>240)) then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;
revoke all on function internal.valid_jiaowubao_unclosed_lesson(jsonb,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.read_jiaowubao_unclosed_snapshot(p_secret text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='12s' as $$
declare result jsonb;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  select jsonb_build_object('revision',run.revision,'checkedAt',to_char(run.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lessons',coalesce((select jsonb_agg(item order by page.page_index,ord) from internal.jiaowubao_unclosed_pages page,
      lateral jsonb_array_elements(page.rows) with ordinality source(item,ord) where page.run_id=run.id),'[]'::jsonb)) into result
  from internal.jiaowubao_unclosed_current current
  join internal.jiaowubao_unclosed_runs run on run.id=current.run_id and run.state='complete' where current.singleton;
  return coalesce(result,'{"revision":null,"checkedAt":null,"lessons":[]}'::jsonb);
end $$;

create or replace function public.begin_jiaowubao_unclosed_snapshot(p_secret text,p_run_id uuid,p_expected_revision text,p_checked_at timestamptz,p_row_count integer)
returns void language plpgsql security definer set search_path='' set statement_timeout='12s' as $$
declare current_revision text;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if p_checked_at is null or p_checked_at>now()+interval '5 minutes' or p_row_count not between 0 and 6000 then
    raise exception using errcode='22023',message='invalid_unclosed_manifest'; end if;
  select revision into current_revision from internal.jiaowubao_unclosed_current where singleton;
  if current_revision is distinct from p_expected_revision then raise exception using errcode='40001',message='unclosed_snapshot_changed'; end if;
  insert into internal.jiaowubao_unclosed_runs(id,expected_revision,checked_at,row_count) values(p_run_id,p_expected_revision,p_checked_at,p_row_count);
end $$;

create or replace function public.stage_jiaowubao_unclosed_snapshot(p_secret text,p_run_id uuid,p_page_index integer,p_rows jsonb)
returns void language plpgsql security definer set search_path='' set statement_timeout='12s' as $$
declare run internal.jiaowubao_unclosed_runs; prior_rows jsonb; expected_count integer;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  select * into run from internal.jiaowubao_unclosed_runs where id=p_run_id for update;
  if not found or run.state<>'staging' then raise exception using errcode='55000',message='unclosed_run_not_staging'; end if;
  expected_count:=least(100,run.row_count-p_page_index*100);
  if p_page_index is null or p_page_index not between 0 and 59 or expected_count<=0
    or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)<>expected_count
    or octet_length(p_rows::text)>1048576 then raise exception using errcode='22023',message='invalid_unclosed_page'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) item where internal.valid_jiaowubao_unclosed_lesson(item,run.checked_at) is not true) then
    raise exception using errcode='22023',message='invalid_unclosed_lesson'; end if;
  select rows into prior_rows from internal.jiaowubao_unclosed_pages where run_id=p_run_id and page_index=p_page_index;
  if found then
    if prior_rows is distinct from p_rows then raise exception using errcode='23505',message='unclosed_page_conflict'; end if;
    return;
  end if;
  insert into internal.jiaowubao_unclosed_pages(run_id,page_index,rows) values(p_run_id,p_page_index,p_rows);
end $$;

create or replace function public.complete_jiaowubao_unclosed_snapshot(p_secret text,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='12s' as $$
declare run internal.jiaowubao_unclosed_runs; current_revision text; current_checked timestamptz; combined jsonb; row_count integer; v_revision text;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('jiaowubao-unclosed-publication'));
  select * into run from internal.jiaowubao_unclosed_runs where id=p_run_id for update;
  if not found then raise exception using errcode='22023',message='unclosed_run_missing'; end if;
  if run.state='complete' then return jsonb_build_object('revision',run.revision,'rowCount',run.row_count); end if;
  if run.state<>'staging' then raise exception using errcode='55000',message='unclosed_run_not_staging'; end if;
  select current.revision,previous.checked_at into current_revision,current_checked from internal.jiaowubao_unclosed_current current
    join internal.jiaowubao_unclosed_runs previous on previous.id=current.run_id where current.singleton;
  if current_revision is distinct from run.expected_revision or run.checked_at<current_checked then
    raise exception using errcode='40001',message='unclosed_snapshot_changed'; end if;
  select coalesce(jsonb_agg(item order by page.page_index,ord),'[]'::jsonb),count(*) into combined,row_count
    from internal.jiaowubao_unclosed_pages page,lateral jsonb_array_elements(page.rows) with ordinality source(item,ord) where page.run_id=p_run_id;
  if row_count<>run.row_count or row_count<>(select count(distinct item->>'eventId') from jsonb_array_elements(combined) item) then
    raise exception using errcode='22023',message='unclosed_snapshot_incomplete'; end if;
  v_revision:='sha256:'||encode(extensions.digest(combined::text,'sha256'),'hex');
  update internal.jiaowubao_unclosed_runs set state='complete',revision=v_revision where id=p_run_id;
  insert into internal.jiaowubao_unclosed_current(singleton,run_id,revision) values(true,p_run_id,v_revision)
    on conflict(singleton) do update set run_id=excluded.run_id,revision=excluded.revision;
  return jsonb_build_object('revision',v_revision,'rowCount',row_count);
end $$;
revoke all on function public.read_jiaowubao_unclosed_snapshot(text) from public,anon,authenticated,service_role;
revoke all on function public.begin_jiaowubao_unclosed_snapshot(text,uuid,text,timestamptz,integer) from public,anon,authenticated,service_role;
revoke all on function public.stage_jiaowubao_unclosed_snapshot(text,uuid,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.complete_jiaowubao_unclosed_snapshot(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_jiaowubao_unclosed_snapshot(text) to anon,authenticated;
grant execute on function public.begin_jiaowubao_unclosed_snapshot(text,uuid,text,timestamptz,integer) to anon,authenticated;
grant execute on function public.stage_jiaowubao_unclosed_snapshot(text,uuid,integer,jsonb) to anon,authenticated;
grant execute on function public.complete_jiaowubao_unclosed_snapshot(text,uuid) to anon,authenticated;

create or replace function public.abort_jiaowubao_unclosed_snapshot(p_secret text,p_run_id uuid)
returns void language plpgsql security definer set search_path='' set statement_timeout='12s' as $$
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  update internal.jiaowubao_unclosed_runs set state='aborted' where id=p_run_id and state='staging';
end $$;
revoke all on function public.abort_jiaowubao_unclosed_snapshot(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.abort_jiaowubao_unclosed_snapshot(text,uuid) to anon,authenticated;

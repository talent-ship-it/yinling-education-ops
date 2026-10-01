create table internal.jiaowubao_schedule_horizon_runs (
  id uuid primary key default gen_random_uuid(),
  api_source_key text not null default 'jwb-open-api-schedule' check (api_source_key = 'jwb-open-api-schedule'),
  window_start date not null,
  window_end date not null check (window_end = window_start + 92),
  expected_current_revision text check (expected_current_revision is null or expected_current_revision ~ '^sha256:[a-f0-9]{64}$'),
  lease_run_key text not null check (lease_run_key ~ '^jwb-open-api-schedule-sync:[0-9]{10,16}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  state text not null default 'collecting' check (state in ('collecting','ready','closed','aborted')),
  pass_number smallint not null default 0 check (pass_number between 0 and 1),
  window_index smallint not null default 0 check (window_index between 0 and 3),
  next_page integer not null default 1 check (next_page between 1 and 61),
  first_pass_resumed boolean not null default false,
  first_pass_count integer not null default 0 check (first_pass_count between 0 and 6000),
  second_pass_count integer not null default 0 check (second_pass_count between 0 and 6000),
  started_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  check ((state = 'collecting' and window_index between 0 and 2 and closed_at is null)
    or (state = 'ready' and window_index = 3 and closed_at is null)
    or (state in ('closed','aborted') and closed_at is not null))
);
create unique index jiaowubao_schedule_horizon_one_active
  on internal.jiaowubao_schedule_horizon_runs(api_source_key)
  where state in ('collecting','ready');
alter table internal.jiaowubao_schedule_horizon_runs enable row level security;
revoke all on table internal.jiaowubao_schedule_horizon_runs from public, anon, authenticated, service_role;

create table internal.jiaowubao_schedule_horizon_pages (
  run_id uuid not null references internal.jiaowubao_schedule_horizon_runs(id) on delete restrict,
  pass_number smallint not null check (pass_number between 0 and 1),
  window_index smallint not null check (window_index between 0 and 2),
  page_number integer not null check (page_number between 1 and 61),
  row_count integer not null check (row_count between 0 and 100),
  page_sha256 text not null check (page_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) = row_count and octet_length(rows::text) <= 2097152),
  staged_at timestamptz not null default clock_timestamp(),
  primary key(run_id,pass_number,window_index,page_number)
);
alter table internal.jiaowubao_schedule_horizon_pages enable row level security;
revoke all on table internal.jiaowubao_schedule_horizon_pages from public, anon, authenticated, service_role;

create table internal.jiaowubao_schedule_horizon_items (
  run_id uuid not null references internal.jiaowubao_schedule_horizon_runs(id) on delete restrict,
  pass_number smallint not null check (pass_number between 0 and 1),
  source_key text not null check (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  window_index smallint not null check (window_index between 0 and 2),
  page_number integer not null check (page_number between 1 and 60),
  primary key(run_id,pass_number,source_key),
  foreign key(run_id,pass_number,window_index,page_number)
    references internal.jiaowubao_schedule_horizon_pages(run_id,pass_number,window_index,page_number) on delete restrict
);
alter table internal.jiaowubao_schedule_horizon_items enable row level security;
revoke all on table internal.jiaowubao_schedule_horizon_items from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_schedule_horizon_current_matches(p_revision text)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select current_row.revision from internal.jiaowubao_open_api_schedule_snapshot_current current_row
    where current_row.api_source_key = 'jwb-open-api-schedule') is not distinct from p_revision
$$;
revoke all on function internal.jiaowubao_schedule_horizon_current_matches(text) from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_schedule_horizon_lease_matches(p_run_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from internal.jiaowubao_open_api_schedule_sync_leases lease_row
    where lease_row.api_source_key = 'jwb-open-api-schedule'
      and lease_row.run_key = p_run_key and lease_row.lease_expires_at > clock_timestamp())
$$;
revoke all on function internal.jiaowubao_schedule_horizon_lease_matches(text) from public, anon, authenticated, service_role;

create or replace function public.begin_jiaowubao_schedule_horizon_collection(
  p_secret text, p_run_key text, p_window_start date, p_window_end date, p_expected_current_revision text, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_schedule_horizon_runs%rowtype;
begin
  if internal.verify_ops_secret(p_secret) is not true or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_schedule_horizon_forbidden';
  end if;
  if p_window_start is null or p_window_start <> (clock_timestamp() at time zone 'Australia/Melbourne')::date
     or p_window_end is distinct from p_window_start + 92
     or (p_expected_current_revision is not null and p_expected_current_revision !~ '^sha256:[a-f0-9]{64}$')
     or not internal.jiaowubao_schedule_horizon_lease_matches(p_run_key) then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_horizon_window_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-schedule-horizon', 0));
  select * into saved from internal.jiaowubao_schedule_horizon_runs r
    where r.api_source_key = 'jwb-open-api-schedule' and r.state in ('collecting','ready')
    for update;
  if found and (saved.window_start is distinct from p_window_start
    or saved.window_end is distinct from p_window_end
    or saved.expected_current_revision is distinct from p_expected_current_revision) then
    delete from internal.jiaowubao_schedule_horizon_items where run_id = saved.id;
    delete from internal.jiaowubao_schedule_horizon_pages where run_id = saved.id;
    update internal.jiaowubao_schedule_horizon_runs
      set state = 'aborted', closed_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = saved.id;
    saved.id := null;
  end if;
  if not internal.jiaowubao_schedule_horizon_current_matches(p_expected_current_revision) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_horizon_current_changed';
  end if;
  if saved.id is null then
    insert into internal.jiaowubao_schedule_horizon_runs(window_start,window_end,expected_current_revision,lease_run_key)
      values(p_window_start,p_window_end,p_expected_current_revision,p_run_key) returning * into saved;
  elsif saved.state = 'ready' and saved.pass_number = 0 then
    update internal.jiaowubao_schedule_horizon_runs
      set state = 'collecting', pass_number = 1, window_index = 0, next_page = 1,
        first_pass_resumed = true, lease_run_key = p_run_key, updated_at = clock_timestamp()
      where id = saved.id returning * into saved;
  elsif saved.state = 'collecting' and saved.pass_number = 0 then
    update internal.jiaowubao_schedule_horizon_runs
      set first_pass_resumed = true, lease_run_key = p_run_key, updated_at = clock_timestamp()
      where id = saved.id returning * into saved;
  else
    update internal.jiaowubao_schedule_horizon_runs
      set lease_run_key = p_run_key, updated_at = clock_timestamp()
      where id = saved.id returning * into saved;
  end if;
  return jsonb_build_object('runId',saved.id,'state',saved.state,'passNumber',saved.pass_number,
    'windowIndex',saved.window_index,'nextPage',saved.next_page,
    'firstPassCount',saved.first_pass_count,'secondPassCount',saved.second_pass_count);
end;
$$;
revoke all on function public.begin_jiaowubao_schedule_horizon_collection(text,text,date,date,text,text) from public, anon, authenticated, service_role;
grant execute on function public.begin_jiaowubao_schedule_horizon_collection(text,text,date,date,text,text) to anon, authenticated;

create or replace function public.stage_jiaowubao_schedule_horizon_page(
  p_secret text, p_run_key text, p_run_id uuid, p_pass_number integer, p_window_index integer,
  p_page_number integer, p_rows jsonb, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_schedule_horizon_runs%rowtype;
  row_count_value integer; page_hash text; previous_hash text; next_window integer;
  current_run_id uuid; current_row_count integer; stored_current_count integer;
  needs_confirmation boolean := false;
begin
  if internal.verify_ops_secret(p_secret) is not true or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_schedule_horizon_forbidden';
  end if;
  select * into saved from internal.jiaowubao_schedule_horizon_runs r where r.id = p_run_id for update;
  if not found or saved.state <> 'collecting' or saved.pass_number <> p_pass_number
     or saved.window_index <> p_window_index or saved.next_page <> p_page_number
     or saved.lease_run_key is distinct from p_run_key
     or not internal.jiaowubao_schedule_horizon_lease_matches(p_run_key)
     or saved.window_start <> (clock_timestamp() at time zone 'Australia/Melbourne')::date
     or not internal.jiaowubao_schedule_horizon_current_matches(saved.expected_current_revision) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_horizon_cursor_changed';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_horizon_page_invalid';
  end if;
  row_count_value := jsonb_array_length(p_rows);
  if row_count_value > 100 or octet_length(p_rows::text) > 2097152
     or (row_count_value > 0 and p_page_number = 61) then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_horizon_page_oversize';
  end if;
  if row_count_value > 0 then perform internal.assert_jiaowubao_open_api_schedule_snapshot_page(p_rows); end if;
  page_hash := 'sha256:' || encode(extensions.digest(p_rows::text, 'sha256'),'hex');
  select page_row.page_sha256 into previous_hash from internal.jiaowubao_schedule_horizon_pages page_row
    where page_row.run_id = p_run_id and page_row.pass_number = p_pass_number
      and page_row.window_index = p_window_index and page_row.page_number = p_page_number - 1;
  if previous_hash = page_hash then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_horizon_repeated_page';
  end if;
  if (case when p_pass_number = 0 then saved.first_pass_count else saved.second_pass_count end) + row_count_value > 6000 then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_horizon_rows_oversize';
  end if;
  insert into internal.jiaowubao_schedule_horizon_pages(run_id,pass_number,window_index,page_number,row_count,page_sha256,rows)
    values(p_run_id,p_pass_number,p_window_index,p_page_number,row_count_value,page_hash,p_rows);
  insert into internal.jiaowubao_schedule_horizon_items(run_id,pass_number,source_key,window_index,page_number)
    select p_run_id,p_pass_number,entry.value ->> 'sourceKey',p_window_index,p_page_number
    from jsonb_array_elements(p_rows) as entry(value);
  if p_pass_number = 0 then
    update internal.jiaowubao_schedule_horizon_runs set first_pass_count = first_pass_count + row_count_value
      where id = p_run_id;
  else
    update internal.jiaowubao_schedule_horizon_runs set second_pass_count = second_pass_count + row_count_value
      where id = p_run_id;
  end if;
  if row_count_value = 100 then
    update internal.jiaowubao_schedule_horizon_runs
      set next_page = p_page_number + 1, updated_at = clock_timestamp() where id = p_run_id;
  else
    next_window := p_window_index + 1;
    if next_window < 3 then
      update internal.jiaowubao_schedule_horizon_runs
        set window_index = next_window, next_page = 1, updated_at = clock_timestamp() where id = p_run_id;
    elsif p_pass_number = 0 then
      needs_confirmation := saved.first_pass_resumed;
      select current_row.run_id,current_row.row_count into current_run_id,current_row_count
        from internal.jiaowubao_open_api_schedule_snapshot_current current_row
        where current_row.api_source_key = 'jwb-open-api-schedule';
      if current_run_id is not null then
        select count(*) into stored_current_count
          from internal.jiaowubao_open_api_schedule_snapshot_ingest_items current_item
          where current_item.run_id = current_run_id;
        if stored_current_count <> current_row_count then
          raise exception using errcode = '55000', message = 'jiaowubao_schedule_horizon_current_incomplete';
        end if;
        select exists(
          select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_items current_item
          where current_item.run_id = current_run_id
            and not exists(
              select 1 from internal.jiaowubao_schedule_horizon_items collected_item
              where collected_item.run_id = p_run_id and collected_item.pass_number = 0
                and collected_item.source_key = current_item.source_key
            )
        ) or needs_confirmation into needs_confirmation;
      end if;
      if needs_confirmation then
        update internal.jiaowubao_schedule_horizon_runs
          set pass_number = 1, window_index = 0, next_page = 1, updated_at = clock_timestamp()
          where id = p_run_id;
      else
        update internal.jiaowubao_schedule_horizon_runs
          set state = 'ready', window_index = 3, next_page = 1, updated_at = clock_timestamp()
          where id = p_run_id;
      end if;
    else
      update internal.jiaowubao_schedule_horizon_runs
        set state = 'ready', window_index = 3, next_page = 1, updated_at = clock_timestamp()
        where id = p_run_id;
    end if;
  end if;
  select * into saved from internal.jiaowubao_schedule_horizon_runs r where r.id = p_run_id;
  return jsonb_build_object('runId',saved.id,'state',saved.state,'passNumber',saved.pass_number,
    'windowIndex',saved.window_index,'nextPage',saved.next_page,
    'firstPassCount',saved.first_pass_count,'secondPassCount',saved.second_pass_count);
end;
$$;
revoke all on function public.stage_jiaowubao_schedule_horizon_page(text,text,uuid,integer,integer,integer,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.stage_jiaowubao_schedule_horizon_page(text,text,uuid,integer,integer,integer,jsonb,text) to anon, authenticated;

create or replace function public.read_jiaowubao_schedule_horizon_pages(
  p_secret text, p_run_key text, p_run_id uuid, p_offset integer, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_schedule_horizon_runs%rowtype; total_count integer; result_pages jsonb;
begin
  if internal.verify_ops_secret(p_secret) is not true or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_schedule_horizon_forbidden';
  end if;
  select * into saved from internal.jiaowubao_schedule_horizon_runs r where r.id = p_run_id;
  if not found or saved.state <> 'ready'
     or saved.lease_run_key is distinct from p_run_key
     or not internal.jiaowubao_schedule_horizon_lease_matches(p_run_key)
     or saved.window_start <> (clock_timestamp() at time zone 'Australia/Melbourne')::date
     or not internal.jiaowubao_schedule_horizon_current_matches(saved.expected_current_revision)
     or p_offset is null or p_offset < 0 or p_offset > 360 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_horizon_read_forbidden';
  end if;
  select count(*) into total_count from internal.jiaowubao_schedule_horizon_pages page_row where page_row.run_id = p_run_id;
  select coalesce(jsonb_agg(jsonb_build_object('passNumber',picked.pass_number,
    'windowIndex',picked.window_index,'pageNumber',picked.page_number,'rows',picked.rows)
    order by picked.pass_number,picked.window_index,picked.page_number),'[]'::jsonb)
    into result_pages
    from (select page_row.pass_number,page_row.window_index,page_row.page_number,page_row.rows
      from internal.jiaowubao_schedule_horizon_pages page_row where page_row.run_id = p_run_id
      order by page_row.pass_number,page_row.window_index,page_row.page_number
      offset p_offset limit 4) picked;
  return jsonb_build_object('runId',p_run_id,'state','ready','pageCount',total_count,
    'pages',result_pages,'hasMore',p_offset + jsonb_array_length(result_pages) < total_count);
end;
$$;
revoke all on function public.read_jiaowubao_schedule_horizon_pages(text,text,uuid,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.read_jiaowubao_schedule_horizon_pages(text,text,uuid,integer,text) to anon, authenticated;

create or replace function public.close_jiaowubao_schedule_horizon_collection(
  p_secret text, p_run_key text, p_run_id uuid, p_published_revision text, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_schedule_horizon_runs%rowtype;
begin
  if internal.verify_ops_secret(p_secret) is not true or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_schedule_horizon_forbidden';
  end if;
  select * into saved from internal.jiaowubao_schedule_horizon_runs r where r.id = p_run_id for update;
  if not found or saved.state not in ('ready','closed') or p_published_revision is null
     or p_published_revision !~ '^sha256:[a-f0-9]{64}$'
     or saved.lease_run_key is distinct from p_run_key
     or not internal.jiaowubao_schedule_horizon_lease_matches(p_run_key)
     or saved.window_start <> (clock_timestamp() at time zone 'Australia/Melbourne')::date
     or not internal.jiaowubao_schedule_horizon_current_matches(p_published_revision) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_horizon_close_forbidden';
  end if;
  if saved.state = 'ready' then
    delete from internal.jiaowubao_schedule_horizon_items where run_id = p_run_id;
    delete from internal.jiaowubao_schedule_horizon_pages where run_id = p_run_id;
    update internal.jiaowubao_schedule_horizon_runs
      set state = 'closed', closed_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = p_run_id;
  end if;
  return jsonb_build_object('runId',p_run_id,'closed',true);
end;
$$;
revoke all on function public.close_jiaowubao_schedule_horizon_collection(text,text,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.close_jiaowubao_schedule_horizon_collection(text,text,uuid,text,text) to anon, authenticated;

create or replace function public.abort_jiaowubao_schedule_horizon_collection(
  p_secret text, p_run_key text, p_run_id uuid, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_schedule_horizon_runs%rowtype;
begin
  if internal.verify_ops_secret(p_secret) is not true or p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_schedule_horizon_forbidden';
  end if;
  select * into saved from internal.jiaowubao_schedule_horizon_runs r where r.id = p_run_id for update;
  if not found or saved.state not in ('collecting','ready','aborted')
     or saved.lease_run_key is distinct from p_run_key
     or not internal.jiaowubao_schedule_horizon_lease_matches(p_run_key) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_horizon_abort_forbidden';
  end if;
  if saved.state in ('collecting','ready') then
    delete from internal.jiaowubao_schedule_horizon_items where run_id = p_run_id;
    delete from internal.jiaowubao_schedule_horizon_pages where run_id = p_run_id;
    update internal.jiaowubao_schedule_horizon_runs
      set state = 'aborted', closed_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = p_run_id;
  end if;
  return jsonb_build_object('runId',p_run_id,'aborted',true);
end;
$$;
revoke all on function public.abort_jiaowubao_schedule_horizon_collection(text,text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.abort_jiaowubao_schedule_horizon_collection(text,text,uuid,text) to anon, authenticated;

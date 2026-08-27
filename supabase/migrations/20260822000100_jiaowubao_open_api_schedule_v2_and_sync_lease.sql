-- Extends the private JWB schedule source snapshot with every documented
-- non-price field. This remains source evidence only: it cannot create or
-- mutate students, native bookings, lesson packages, payroll, AVA, tasks,
-- attendance, or classrooms.

create or replace function internal.assert_jiaowubao_open_api_schedule_snapshot_envelope(p_envelope jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object'
     or p_envelope - ARRAY['apiSourceKey','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[] <> '{}'::jsonb
     or not (p_envelope ?& ARRAY['apiSourceKey','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[])
     or p_envelope ->> 'apiSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
     or nullif(btrim(p_envelope ->> 'revision'), '') is null
     or p_envelope ->> 'revision' <> btrim(p_envelope ->> 'revision')
     or length(p_envelope ->> 'revision') > 240
     or p_envelope ->> 'revision' !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'query') <> 'object'
     or octet_length((p_envelope -> 'query')::text) not between 2 and 32768
     or (p_envelope -> 'query') - ARRAY['start','end','limit','order']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'query') ?& ARRAY['start','end','limit','order']::text[])
     or jsonb_typeof(p_envelope -> 'query' -> 'start') <> 'string'
     or (p_envelope -> 'query' ->> 'start') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_envelope -> 'query' -> 'end') <> 'string'
     or (p_envelope -> 'query' ->> 'end') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_envelope -> 'query' -> 'limit') <> 'number'
     or (p_envelope -> 'query' ->> 'limit')::integer <> 100
     or jsonb_typeof(p_envelope -> 'query' -> 'order') <> 'string'
     or p_envelope -> 'query' ->> 'order' <> 'asc'
     or jsonb_typeof(p_envelope -> 'expectedPageCount') <> 'number'
     or (p_envelope ->> 'expectedPageCount')::integer not between 0 and 60
     or jsonb_typeof(p_envelope -> 'expectedRowCount') <> 'number'
     or (p_envelope ->> 'expectedRowCount')::integer not between 0 and 6000
     or (
       jsonb_typeof(p_envelope -> 'expectedCurrentRevision') <> 'null'
       and (
         jsonb_typeof(p_envelope -> 'expectedCurrentRevision') <> 'string'
         or p_envelope ->> 'expectedCurrentRevision' !~ '^sha256:[a-f0-9]{64}$'
       )
     )
     or jsonb_typeof(p_envelope -> 'externalManifestSha256') <> 'string'
     or p_envelope ->> 'externalManifestSha256' !~ '^sha256:[a-f0-9]{64}$'
     or p_envelope ->> 'revision' <> p_envelope ->> 'externalManifestSha256'
     or lower((p_envelope -> 'query')::text) ~ '"(sk|secret|token|password)"\s*:'
     or jsonb_typeof(p_envelope -> 'sourceMetadata') <> 'object'
     or octet_length((p_envelope -> 'sourceMetadata')::text) not between 2 and 32768
     or (p_envelope -> 'sourceMetadata') - ARRAY['exportFormat','manifestSha256','recordsSha256']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'sourceMetadata') ?& ARRAY['exportFormat','manifestSha256','recordsSha256']::text[])
     or p_envelope -> 'sourceMetadata' ->> 'exportFormat' not in ('jiaowubao-schedule-export/v1','jiaowubao-schedule-export/v2')
     or p_envelope -> 'sourceMetadata' ->> 'manifestSha256' <> p_envelope ->> 'externalManifestSha256'
     or p_envelope -> 'sourceMetadata' ->> 'recordsSha256' !~ '^sha256:[a-f0-9]{64}$'
     or lower((p_envelope -> 'sourceMetadata')::text) ~ '"(sk|secret|token|password)"\s*:' then
    raise exception using errcode = '22023', message = 'jiaowubao_open_api_schedule_snapshot_envelope_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_open_api_schedule_snapshot_envelope(jsonb) from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_open_api_schedule_snapshot_page(p_rows jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 100
     or octet_length(p_rows::text) > 2097152
     or exists (
       select 1
       from jsonb_array_elements(p_rows) item_value
       where jsonb_typeof(item_value) is distinct from 'object'
          or not (item_value ?& ARRAY['sourceKey','record']::text[])
          or item_value - ARRAY['sourceKey','record']::text[] <> '{}'::jsonb
          or jsonb_typeof(item_value -> 'sourceKey') is distinct from 'string'
          or item_value ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
          or jsonb_typeof(item_value -> 'record') is distinct from 'object'
          or not ((item_value -> 'record') ?& ARRAY['cal_id']::text[])
          or (item_value -> 'record') - ARRAY[
            'cal_id','type','appoint','team_id','team_title','course_id','course_title',
            'room_id','room_title','teacher_id','teacher_title','teacher_hour',
            'teacher_s','teacher_s_title','teacher_s_hour','teacher_t','teacher_t_title','teacher_t_hour',
            'dated','time_start','time_end','cal_length','hours','cont','created','color','live',
            'max_num','mem_max','mem_num','mem_num_sign','mem_num_not_sign','mem_num_leave',
            'mem_leave','mem_arrive','arrive_percent','mem_not_comment','all_leave','over',
            'over_state','over_time','ks_num','ks_mem','ks_reception','ks_not','try_arrive','stu_list'
          ]::text[] <> '{}'::jsonb
          or (item_value -> 'record') ? 'price_mem'
          or jsonb_typeof(item_value -> 'record' -> 'cal_id') <> 'string'
          or item_value -> 'record' ->> 'cal_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
          or (item_value ->> 'sourceKey') <> ('jwb-open-api:schedule:' || (item_value -> 'record' ->> 'cal_id'))
          or octet_length((item_value -> 'record')::text) > 262144
          or (
            (item_value -> 'record') ? 'stu_list'
            and (
              jsonb_typeof(item_value -> 'record' -> 'stu_list') <> 'array'
              or jsonb_array_length(item_value -> 'record' -> 'stu_list') > 1000
              or exists (
                select 1
                from jsonb_array_elements(item_value -> 'record' -> 'stu_list') student_value
                where jsonb_typeof(student_value) <> 'object'
                   or student_value - ARRAY['lesson_id','mem_id','type','name','logo','sign','sign_title','arrive_title','comment','is_wx']::text[] <> '{}'::jsonb
                   or student_value ? 'price'
              )
            )
          )
     )
     or exists (
       select 1 from jsonb_array_elements(p_rows) item_value
       group by item_value ->> 'sourceKey' having count(*) > 1
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_open_api_schedule_snapshot_page_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_open_api_schedule_snapshot_page(jsonb) from public, anon, authenticated;

-- The Vercel scheduler can deliver duplicate events or start a second
-- instance before a slow upstream pull finishes. A short durable lease stops
-- duplicate 18-page pulls; the immutable snapshot's pointer CAS remains the
-- final publication guard.
create table if not exists internal.jiaowubao_open_api_schedule_sync_leases (
  api_source_key text primary key check (api_source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  run_key text not null check (run_key = btrim(run_key) and char_length(run_key) between 1 and 240),
  acquired_at timestamptz not null,
  lease_expires_at timestamptz not null check (lease_expires_at > acquired_at)
);
alter table internal.jiaowubao_open_api_schedule_sync_leases enable row level security;
revoke all on table internal.jiaowubao_open_api_schedule_sync_leases from public, anon, authenticated;

create or replace function public.claim_jiaowubao_open_api_schedule_sync_lease(
  p_secret text,
  p_api_source_key text,
  p_run_key text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_open_api_schedule_sync_leases%rowtype; now_at timestamptz := clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_api_source_key <> 'jwb-open-api-schedule'
     or p_run_key !~ '^jwb-open-api-schedule-sync:[0-9]{10,16}$'
     or p_actor <> 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_sync_lease_forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-open-api-schedule-sync:' || p_api_source_key, 0));
  select * into saved
  from internal.jiaowubao_open_api_schedule_sync_leases lease_row
  where lease_row.api_source_key = p_api_source_key
  for update;
  if found and saved.lease_expires_at > now_at then
    return jsonb_build_object('acquired', false, 'runKey', saved.run_key, 'retryAfterSeconds', greatest(1, ceil(extract(epoch from saved.lease_expires_at - now_at))::integer));
  end if;
  insert into internal.jiaowubao_open_api_schedule_sync_leases(api_source_key,run_key,acquired_at,lease_expires_at)
  values (p_api_source_key,p_run_key,now_at,now_at + interval '10 minutes')
  on conflict (api_source_key) do update set run_key=excluded.run_key,acquired_at=excluded.acquired_at,lease_expires_at=excluded.lease_expires_at;
  return jsonb_build_object('acquired', true, 'runKey', p_run_key, 'retryAfterSeconds', 0);
end;
$$;
revoke all on function public.claim_jiaowubao_open_api_schedule_sync_lease(text,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_jiaowubao_open_api_schedule_sync_lease(text,text,text,text) to anon, authenticated;

create or replace function public.release_jiaowubao_open_api_schedule_sync_lease(
  p_secret text,
  p_api_source_key text,
  p_run_key text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_open_api_schedule_sync_leases%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_api_source_key <> 'jwb-open-api-schedule'
     or p_run_key !~ '^jwb-open-api-schedule-sync:[0-9]{10,16}$'
     or p_actor <> 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_sync_lease_forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-open-api-schedule-sync:' || p_api_source_key, 0));
  select * into saved
  from internal.jiaowubao_open_api_schedule_sync_leases lease_row
  where lease_row.api_source_key = p_api_source_key
  for update;
  if not found or saved.run_key <> p_run_key then
    return jsonb_build_object('released', false);
  end if;
  update internal.jiaowubao_open_api_schedule_sync_leases
  set lease_expires_at = clock_timestamp()
  where api_source_key = p_api_source_key;
  return jsonb_build_object('released', true);
end;
$$;
revoke all on function public.release_jiaowubao_open_api_schedule_sync_lease(text,text,text,text) from public, anon, authenticated;
grant execute on function public.release_jiaowubao_open_api_schedule_sync_lease(text,text,text,text) to anon, authenticated;

comment on table internal.jiaowubao_open_api_schedule_sync_leases is 'Private short-lived lease for duplicate-safe Vercel JWB schedule source pulls; not operational scheduling.';

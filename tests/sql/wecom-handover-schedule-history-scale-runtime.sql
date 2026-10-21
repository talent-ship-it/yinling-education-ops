\set ON_ERROR_STOP on
\ir wecom-handover-schedule-evidence-runtime.sql
\ir ../../supabase/migrations/20261021080306_stabilize_wecom_handover_schedule_history_plan.sql

set jit = off;
set plan_cache_mode = force_generic_plan;

create function internal.fixture_wecom_history_scale_record(p_id text,p_date text)
returns jsonb language sql as $$
  select jsonb_set(internal.fixture_wecom_schedule_record(p_id,p_date),'{record,course_title}','"Synthetic trial - Draft Student"');
$$;

create function internal.fixture_wecom_history_scale_run(
  p_seed text, p_start date, p_end date, p_completed timestamptz, p_rows jsonb
) returns uuid language plpgsql as $$
declare run uuid; audit uuid; row_count integer := jsonb_array_length(p_rows);
begin
  audit := internal.append_operational_contract_audit('fixture.schedule.scale','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(api_source_key,revision,query,
    expected_page_count,expected_row_count,external_manifest_sha256,source_metadata,staged_by,staging_audit_id)
  values('jwb-open-api-schedule','sha256:'||md5(p_seed)||md5('scale:'||p_seed),
    jsonb_build_object('start',p_start,'end',p_end,'limit',100,'order','asc'),
    (row_count+99)/100,row_count,'sha256:'||repeat('a',64),'{}','fixture',audit) returning id into run;
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_pages(
    run_id,page_index,page_sha256,rows,row_count,content_bytes,audit_id)
  select run,page_index,'sha256:'||repeat('b',64),page_rows,jsonb_array_length(page_rows),octet_length(page_rows::text),audit
  from (
    select ((position-1)/100)::integer as page_index,jsonb_agg(value order by position) as page_rows
    from jsonb_array_elements(p_rows) with ordinality as rows(value,position) group by (position-1)/100
  ) pages;
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(
    run_id,page_index,item_index,source_key,canonical_json,item_sha256,item)
  select run,((position-1)/100)::integer,((position-1)%100)::integer,value ->> 'sourceKey',
    value::text,'sha256:'||repeat('c',64),value
  from jsonb_array_elements(p_rows) with ordinality as rows(value,position);
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='complete',
    canonical_rows_sha256='sha256:'||repeat('d',64),payload_sha256='sha256:'||repeat('e',64),
    completed_at=p_completed,completion_audit_id=audit where id=run;
  return run;
end;
$$;

begin;
do $history_scale$
declare current_run uuid; base_run uuid; moved_run uuid; run uuid; audit uuid; records jsonb; input jsonb; custom_input jsonb;
  revision text; n integer; day date; historical_count integer; item_count bigint;
begin
  for n in 1..48 loop
    select jsonb_agg(internal.fixture_wecom_history_scale_record('scale-unrelated-'||n||'-'||i,'2080-01-20') order by i)
      into records from generate_series(1,2048) i;
    perform internal.fixture_wecom_history_scale_run('unrelated-'||n,'2080-01-01','2080-01-31',
      '2080-02-01T00:00:00Z'::timestamptz+n*interval '1 minute',records);
  end loop;
  select jsonb_agg(internal.fixture_wecom_history_scale_record('scale-day-'||i,('2098-12-31'::date+i)::text) order by i)
    into records from generate_series(0,64) i;
  records := records || jsonb_build_array(internal.fixture_wecom_history_scale_record('scale-moved','2099-01-03'),
    internal.fixture_wecom_history_scale_record('scale-cancelled','2099-01-15'),
    internal.fixture_wecom_history_scale_record('scale-current-priority','2099-01-15'));
  base_run := internal.fixture_wecom_history_scale_run('base','2098-12-31','2099-03-05','2099-01-10T00:00:00Z',records);
  for n in 1..32 loop
    day := '2098-12-31'::date+n;
    select jsonb_agg(internal.fixture_wecom_history_scale_record('scale-dense-'||i,'2098-12-31') order by i)
      into records from generate_series(1,2048) i;
    records := records || jsonb_build_array(internal.fixture_wecom_history_scale_record('scale-day-0','2098-12-31'),
      internal.fixture_wecom_history_scale_record('scale-dense-boundary-'||n,day::text));
    if day >= '2099-01-03'::date then
      records := records || jsonb_build_array(internal.fixture_wecom_history_scale_record('scale-moved','2099-01-03'));
    end if;
    if day >= '2099-01-15'::date then
      records := records || jsonb_build_array(internal.fixture_wecom_history_scale_record('scale-cancelled','2099-01-15'),
        internal.fixture_wecom_history_scale_record('scale-current-priority','2099-01-15'));
    end if;
    perform internal.fixture_wecom_history_scale_run('dense-'||n,'2098-12-31',day,
      '2099-01-11T00:00:00Z'::timestamptz+(64-n)*interval '1 minute',records);
  end loop;
  for n in 1..64 loop
    select jsonb_agg(internal.fixture_wecom_history_scale_record('scale-version-'||i,'2099-01-20') order by i)
      into records from generate_series(1,64) i;
    run := internal.fixture_wecom_history_scale_run('versions-'||n,'2099-01-20','2099-01-20',
      '2099-01-12T00:00:00Z'::timestamptz+n*interval '1 minute',records);
  end loop;
  moved_run := internal.fixture_wecom_history_scale_run('moved','2099-04-01','2099-04-01','2099-01-13T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_scale_record('scale-moved','2099-04-01')));
  records := jsonb_build_array(jsonb_set(internal.fixture_wecom_history_scale_record('scale-current-priority','2099-01-15'),
    '{record,course_title}','"Synthetic trial current snapshot wins"'),internal.fixture_wecom_history_scale_record('scale-current-only','2099-01-15'));
  current_run := internal.fixture_wecom_history_scale_run('current','2099-01-15','2099-01-16','2099-01-09T00:00:00Z',records);
  select r.revision into revision from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=current_run;
  audit := internal.append_operational_contract_audit('fixture.pointer.scale','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',current_run,revision,2,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
  select count(*) into item_count from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  if item_count < 160000 or (select count(*) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs) <> 147
      or (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:scale-moved') <> moved_run
      or (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:scale-current-priority') = current_run then
    raise exception 'history_scale_seed_incomplete';
  end if;
  analyze internal.jiaowubao_open_api_schedule_snapshot_ingest_runs;
  analyze internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  analyze internal.wecom_schedule_latest_complete_source;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  select count(*) into historical_count from jsonb_array_elements(input -> 'coverage') c where (c ->> 'historical')::boolean;
  if jsonb_array_length(input -> 'coverage') <> 65 or historical_count <> 63
      or jsonb_array_length(input -> 'events') <> 2176
      or not exists(select 1 from jsonb_array_elements(input -> 'coverage') c
        where (c ->> 'startsAt')::timestamptz='2098-12-31T00:00:00+11')
      or not exists(select 1 from jsonb_array_elements(input -> 'coverage') c
        where (c ->> 'startsAt')::timestamptz='2099-03-05T00:00:00+11'
          and (c ->> 'endsAt')::timestamptz='2099-03-06T00:00:00+11')
      or exists(select 1 from jsonb_array_elements(input -> 'events') e
        where e ->> 'eventId' in ('jwb-open-api:schedule:scale-cancelled','jwb-open-api:schedule:scale-moved')
          or e ->> 'eventId' like 'jwb-open-api:schedule:scale-unrelated-%')
      or not exists(select 1 from jsonb_array_elements(input -> 'events') e
        where e ->> 'eventId'='jwb-open-api:schedule:scale-current-priority'
          and e ->> 'sourceRunId'=current_run::text and not(e ->> 'historical')::boolean
          and e ->> 'courseName'='Synthetic trial current snapshot wins')
      or not exists(select 1 from jsonb_array_elements(input -> 'events') e
        where e ->> 'eventId'='jwb-open-api:schedule:scale-day-64' and e ->> 'sourceRunId'=base_run::text)
      or (select count(*) from jsonb_array_elements(input -> 'events') e
        where e ->> 'eventId' like 'jwb-open-api:schedule:scale-version-%' and e ->> 'sourceRunId'=run::text) <> 64 then
    raise exception 'history_scale_generic_semantics_failed';
  end if;
  perform set_config('plan_cache_mode','force_custom_plan',true);
  custom_input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  if input is distinct from custom_input then raise exception 'history_scale_custom_generic_differ'; end if;
  perform set_config('plan_cache_mode','force_generic_plan',true);
  if input is distinct from public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']) then
    raise exception 'history_scale_replayed_generic_differ';
  end if;
end;
$history_scale$;
rollback;

begin;
do $leap_month$
declare run uuid; audit uuid; revision text; input jsonb; custom_input jsonb;
begin
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,
    classification,guardian_wechat_hint,operations_owner_hint,match_status,ingested_by)
  values('bot:schedule:scale-leap',repeat('f',64),'scale-leap-room','fixture-sales','2104-02-01T00:00:00Z','text',
    E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Synthetic Leap Parent','handover','Synthetic Leap Parent','Abby','pending','WeCom Bot Receiver');
  run := internal.fixture_wecom_history_scale_run('leap','2104-01-01','2104-05-01','2104-02-02T00:00:00Z',jsonb_build_array(
    internal.fixture_wecom_history_scale_record('scale-leap-lower','2104-01-31'),
    internal.fixture_wecom_history_scale_record('scale-leap-day','2104-02-29'),
    internal.fixture_wecom_history_scale_record('scale-leap-upper','2104-04-02'),
    internal.fixture_wecom_history_scale_record('scale-leap-outside-one','2104-04-03'),
    internal.fixture_wecom_history_scale_record('scale-leap-outside-two','2104-04-04')));
  select r.revision into revision from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=run;
  audit := internal.append_operational_contract_audit('fixture.pointer.scale.leap','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',run,revision,5,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:schedule:scale-leap']);
  if jsonb_array_length(input -> 'coverage') <> 63 or jsonb_array_length(input -> 'events') <> 3
      or exists(select 1 from jsonb_array_elements(input -> 'coverage') c where (c ->> 'historical')::boolean)
      or exists(select 1 from jsonb_array_elements(input -> 'events') e where e ->> 'eventId' like '%outside%')
      or not exists(select 1 from jsonb_array_elements(input -> 'events') e where e ->> 'sourceDate'='2104-02-29')
      or not exists(select 1 from jsonb_array_elements(input -> 'coverage') c
        where (c ->> 'startsAt')::timestamptz='2104-01-31T00:00:00+11')
      or not exists(select 1 from jsonb_array_elements(input -> 'coverage') c
        where (c ->> 'startsAt')::timestamptz=('2104-04-02'::timestamp at time zone 'Australia/Melbourne')
          and (c ->> 'endsAt')::timestamptz=('2104-04-03'::timestamp at time zone 'Australia/Melbourne')) then
    raise exception 'history_scale_leap_month_endpoints_failed';
  end if;
  perform set_config('plan_cache_mode','force_custom_plan',true);
  custom_input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:schedule:scale-leap']);
  if input is distinct from custom_input then raise exception 'history_scale_leap_custom_generic_differ'; end if;
end;
$leap_month$;
rollback;
reset plan_cache_mode;
reset jit;
select 'wecom_handover_schedule_history_scale_runtime_ok';

do $fixture$
declare start_day date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
  initial jsonb; step_result jsonb; batch jsonb; second jsonb; pointer_id uuid := gen_random_uuid();
  lease_key text := 'jwb-open-api-schedule-sync:1760000000000:00000000-0000-4000-8000-000000000001';
  next_lease_key text := 'jwb-open-api-schedule-sync:1760000000000:00000000-0000-4000-8000-000000000002';
  third_lease_key text := 'jwb-open-api-schedule-sync:1760000000000:00000000-0000-4000-8000-000000000003';
  fourth_lease_key text := 'jwb-open-api-schedule-sync:1760000000000:00000000-0000-4000-8000-000000000004';
  fifth_lease_key text := 'jwb-open-api-schedule-sync:1760000000000:00000000-0000-4000-8000-000000000005';
  revision_one text := 'sha256:' || repeat('1',64);
  revision_two text := 'sha256:' || repeat('2',64);
begin
  begin
    perform public.begin_jiaowubao_schedule_horizon_collection('wrong',lease_key,start_day,start_day+92,null,'Ops Admin');
    raise exception 'bad secret was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.begin_jiaowubao_schedule_horizon_collection(
      'schedule-horizon-fixture-secret',lease_key,start_day,start_day+92,null,null);
    raise exception 'null actor was accepted';
  exception when insufficient_privilege then null;
  end;
  if has_table_privilege('anon','internal.jiaowubao_schedule_horizon_runs','select')
     or has_table_privilege('authenticated','internal.jiaowubao_schedule_horizon_pages','select')
     or has_table_privilege('service_role','internal.jiaowubao_schedule_horizon_items','insert') then
    raise exception 'private collector table exposed';
  end if;

  initial := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',lease_key,start_day,start_day+92,null,'Ops Admin');
  if initial ->> 'state' <> 'collecting' or (initial ->> 'nextPage')::integer <> 1 then
    raise exception 'initial cursor invalid';
  end if;
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,0,1,
    '[{"sourceKey":"jwb-open-api:schedule:first","record":{"cal_id":"first"}}]'::jsonb,'Ops Admin');
  if (step_result ->> 'windowIndex')::integer <> 1 then raise exception 'first window not checkpointed'; end if;
  second := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',lease_key,start_day,start_day+92,null,'Ops Admin');
  if second ->> 'runId' <> initial ->> 'runId' or (second ->> 'windowIndex')::integer <> 1 then
    raise exception 'checkpoint did not survive invocation';
  end if;
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,1,1,'[]'::jsonb,'Ops Admin');
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,2,1,'[]'::jsonb,'Ops Admin');
  if step_result ->> 'state' <> 'collecting' or (step_result ->> 'passNumber')::integer <> 1 then
    raise exception 'resumed first pass did not require confirmation';
  end if;
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,1,0,1,
    '[{"sourceKey":"jwb-open-api:schedule:new","record":{"cal_id":"new"}}]'::jsonb,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,1,1,1,'[]'::jsonb,'Ops Admin');
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,1,2,1,'[]'::jsonb,'Ops Admin');
  if step_result ->> 'state' <> 'ready' then raise exception 'second pass not ready'; end if;
  batch := public.read_jiaowubao_schedule_horizon_pages(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,'Ops Admin');
  if (batch ->> 'pageCount')::integer <> 6 or jsonb_array_length(batch -> 'pages') <> 4
     or batch ->> 'hasMore' <> 'true'
     or batch #>> '{pages,3,rows,0,record,cal_id}' <> 'new' then
    raise exception 'ready page reader lost new lesson';
  end if;
  begin
    perform public.close_jiaowubao_schedule_horizon_collection(
      'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,revision_one,'Ops Admin');
    raise exception 'unpublished run closed';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.close_jiaowubao_schedule_horizon_collection(
      'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,null,'Ops Admin');
    raise exception 'null revision closed unpublished run';
  exception when object_not_in_prerequisite_state then null;
  end;
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count)
    values('jwb-open-api-schedule',pointer_id,revision_one,1);
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,source_key,item)
    values(pointer_id,'jwb-open-api:schedule:missing','{}'::jsonb);
  perform public.close_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,revision_one,'Ops Admin');
  if exists(select 1 from internal.jiaowubao_schedule_horizon_pages p where p.run_id=(initial ->> 'runId')::uuid)
     or exists(select 1 from internal.jiaowubao_schedule_horizon_items i where i.run_id=(initial ->> 'runId')::uuid) then
    raise exception 'closed run retained source rows';
  end if;

  initial := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',lease_key,start_day,start_day+92,revision_one,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,0,1,'[]'::jsonb,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,1,1,'[]'::jsonb,'Ops Admin');
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,0,2,1,'[]'::jsonb,'Ops Admin');
  if step_result ->> 'state' <> 'collecting' or (step_result ->> 'passNumber')::integer <> 1
     or (step_result ->> 'windowIndex')::integer <> 0 then
    raise exception 'missing current row did not require confirmation';
  end if;
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,1,0,1,'[]'::jsonb,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,1,1,1,'[]'::jsonb,'Ops Admin');
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,1,2,1,'[]'::jsonb,'Ops Admin');
  if step_result ->> 'state' <> 'ready' then raise exception 'confirmation not ready'; end if;
  batch := public.read_jiaowubao_schedule_horizon_pages(
    'schedule-horizon-fixture-secret',lease_key,(initial ->> 'runId')::uuid,4,'Ops Admin');
  if (batch ->> 'pageCount')::integer <> 6 or jsonb_array_length(batch -> 'pages') <> 2 then
    raise exception 'confirmation pages unavailable';
  end if;
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision = revision_two
    where api_source_key = 'jwb-open-api-schedule';
  second := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',lease_key,start_day,start_day+92,revision_two,'Ops Admin');
  if second ->> 'runId' = initial ->> 'runId' then raise exception 'pointer drift reused stale run'; end if;
  if not exists(select 1 from internal.jiaowubao_schedule_horizon_runs r
    where r.id = (initial ->> 'runId')::uuid and r.state = 'aborted') then
    raise exception 'stale run not aborted';
  end if;
  if exists(select 1 from internal.jiaowubao_schedule_horizon_pages p where p.run_id=(initial ->> 'runId')::uuid)
     or exists(select 1 from internal.jiaowubao_schedule_horizon_items i where i.run_id=(initial ->> 'runId')::uuid) then
    raise exception 'aborted run retained source rows';
  end if;
  update internal.jiaowubao_open_api_schedule_sync_leases
    set run_key = next_lease_key where api_source_key = 'jwb-open-api-schedule';
  begin
    perform public.stage_jiaowubao_schedule_horizon_page(
      'schedule-horizon-fixture-secret',lease_key,(second ->> 'runId')::uuid,0,0,1,'[]'::jsonb,'Ops Admin');
    raise exception 'expired lease staged a page';
  exception when object_not_in_prerequisite_state then null;
  end;
  second := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',next_lease_key,start_day,start_day+92,revision_two,'Ops Admin');
  if second ->> 'state' <> 'collecting' then raise exception 'new lease did not resume'; end if;
  perform public.abort_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',next_lease_key,(second ->> 'runId')::uuid,'Ops Admin');
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id = pointer_id;
  update internal.jiaowubao_open_api_schedule_snapshot_current set row_count = 0
    where api_source_key = 'jwb-open-api-schedule';
  update internal.jiaowubao_open_api_schedule_sync_leases
    set run_key = third_lease_key where api_source_key = 'jwb-open-api-schedule';
  initial := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',third_lease_key,start_day,start_day+92,revision_two,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',third_lease_key,(initial ->> 'runId')::uuid,0,0,1,'[]'::jsonb,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',third_lease_key,(initial ->> 'runId')::uuid,0,1,1,'[]'::jsonb,'Ops Admin');
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',third_lease_key,(initial ->> 'runId')::uuid,0,2,1,'[]'::jsonb,'Ops Admin');
  if step_result ->> 'state' <> 'ready' or (step_result ->> 'passNumber')::integer <> 0 then
    raise exception 'single-call first pass did not reach ready';
  end if;
  update internal.jiaowubao_open_api_schedule_sync_leases
    set run_key = fourth_lease_key where api_source_key = 'jwb-open-api-schedule';
  second := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',fourth_lease_key,start_day,start_day+92,revision_two,'Ops Admin');
  if second ->> 'runId' <> initial ->> 'runId' or second ->> 'state' <> 'collecting'
     or (second ->> 'passNumber')::integer <> 1 then
    raise exception 'deferred ready first pass was discarded instead of confirmed';
  end if;
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',fourth_lease_key,(initial ->> 'runId')::uuid,1,0,1,'[]'::jsonb,'Ops Admin');
  perform public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',fourth_lease_key,(initial ->> 'runId')::uuid,1,1,1,'[]'::jsonb,'Ops Admin');
  step_result := public.stage_jiaowubao_schedule_horizon_page(
    'schedule-horizon-fixture-secret',fourth_lease_key,(initial ->> 'runId')::uuid,1,2,1,'[]'::jsonb,'Ops Admin');
  if step_result ->> 'state' <> 'ready' then raise exception 'deferred confirmation did not reach ready'; end if;
  update internal.jiaowubao_open_api_schedule_sync_leases
    set run_key = fifth_lease_key where api_source_key = 'jwb-open-api-schedule';
  second := public.begin_jiaowubao_schedule_horizon_collection(
    'schedule-horizon-fixture-secret',fifth_lease_key,start_day,start_day+92,revision_two,'Ops Admin');
  if second ->> 'runId' <> initial ->> 'runId' or second ->> 'state' <> 'ready' then
    raise exception 'ready confirmation was discarded before publication';
  end if;
end;
$fixture$;

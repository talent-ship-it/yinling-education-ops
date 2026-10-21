create or replace function public.read_wecom_handover_schedule_input(
  p_secret text, p_snapshot_revision text, p_source_message_ids text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '12s' set work_mem = '32MB' as $$
declare current_run uuid; current_revision text; epoch text; target_month date; target_ids text[];
  source_rows jsonb; state_rows jsonb; coverage_rows jsonb; event_rows jsonb; source_count bigint;
  range_start date; range_end date; missing_cache_count bigint; validated_record_count bigint;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  select run_id, revision into current_run, current_revision from internal.jiaowubao_open_api_schedule_snapshot_current
    where api_source_key = 'jwb-open-api-schedule';
  if current_run is null or current_revision is distinct from p_snapshot_revision then
    raise exception using errcode = '40001', message = 'wecom_schedule_snapshot_changed';
  end if;
  select revision::text into epoch from internal.wecom_handover_schedule_epoch where singleton;
  if p_source_message_ids is not null and (cardinality(p_source_message_ids) not between 1 and 50
     or exists(select 1 from unnest(p_source_message_ids) id where nullif(btrim(id),'') is null)
     or cardinality(p_source_message_ids) <> (select count(distinct id) from unnest(p_source_message_ids) id)) then
    raise exception using errcode = '22023', message = 'invalid_wecom_schedule_targets';
  end if;
  with eligible as (
    select m.message_id, date_trunc('month',m.sent_at at time zone 'Australia/Melbourne')::date as month,
      e.checked_at, m.sent_at
    from internal.wecom_archive_messages m
    join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
    left join internal.wecom_handover_schedule_evidence e on e.source_message_id = m.message_id
    where m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text' and m.classification = 'handover'
      and internal.wecom_is_lp_template(m.body)
      and not exists(select 1 from internal.wecom_lp_confirmations x where x.source_message_id = m.message_id)
      and (p_source_message_ids is not null or e.source_message_id is null or e.input_revision is distinct from epoch
        or e.snapshot_revision is distinct from current_revision
        or e.source_revision is distinct from internal.wecom_lp_draft_source(m.message_id) ->> 'sourceRevision')
      and (p_source_message_ids is null or m.message_id = any(p_source_message_ids))
  ) select month into target_month from eligible order by checked_at nulls first, sent_at, message_id limit 1;
  if target_month is null then
    if p_source_message_ids is not null then raise exception using errcode = '40001', message = 'wecom_schedule_source_changed'; end if;
    return jsonb_build_object('snapshotRevision',current_revision,'inputRevision',epoch,'targetSourceMessageIds','[]'::jsonb,
      'sources','[]'::jsonb,'rows','[]'::jsonb,'coverage','[]'::jsonb,'events','[]'::jsonb);
  end if;
  if p_source_message_ids is not null and (
    (select count(*) from internal.wecom_archive_messages m where m.message_id = any(p_source_message_ids)
      and date_trunc('month',m.sent_at at time zone 'Australia/Melbourne')::date = target_month
      and internal.wecom_lp_draft_source(m.message_id) is not null
      and not exists(select 1 from internal.wecom_lp_confirmations c where c.source_message_id = m.message_id)) <> cardinality(p_source_message_ids)) then
    raise exception using errcode = '40001', message = 'wecom_schedule_source_changed';
  end if;
  select array_agg(message_id order by checked_at nulls first,sent_at,message_id) into target_ids from (
    select m.message_id, e.checked_at, m.sent_at from internal.wecom_archive_messages m
    join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
    left join internal.wecom_handover_schedule_evidence e on e.source_message_id = m.message_id
    where m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text' and m.classification = 'handover'
      and internal.wecom_is_lp_template(m.body)
      and date_trunc('month',m.sent_at at time zone 'Australia/Melbourne')::date = target_month
      and not exists(select 1 from internal.wecom_lp_confirmations x where x.source_message_id = m.message_id)
      and (p_source_message_ids is not null or e.source_message_id is null or e.input_revision is distinct from epoch
        or e.snapshot_revision is distinct from current_revision
        or e.source_revision is distinct from internal.wecom_lp_draft_source(m.message_id) ->> 'sourceRevision')
      and (p_source_message_ids is null or m.message_id = any(p_source_message_ids))
    order by e.checked_at nulls first,m.sent_at,m.message_id limit 50
  ) targets;
  range_start := target_month - 1;
  range_end := (target_month + interval '1 month')::date + 32;
  select count(*) into source_count
  from internal.wecom_archive_messages m join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
  where m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text' and m.classification = 'handover'
    and internal.wecom_is_lp_template(m.body)
    and (m.sent_at at time zone 'Australia/Melbourne')::date between range_start - 32 and range_end + 1
    and not exists(select 1 from internal.wecom_lp_confirmations x where x.source_message_id = m.message_id);
  if source_count > 2000 then raise exception using errcode = '54000', message = 'wecom_schedule_source_limit'; end if;
  select coalesce(jsonb_agg(internal.wecom_lp_draft_source(m.message_id) || jsonb_build_object('handoverAt',m.sent_at) order by m.sent_at,m.message_id),'[]'::jsonb) into source_rows
  from internal.wecom_archive_messages m join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
  where m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text' and m.classification = 'handover'
    and internal.wecom_is_lp_template(m.body)
    and (m.sent_at at time zone 'Australia/Melbourne')::date between range_start - 32 and range_end + 1
    and not exists(select 1 from internal.wecom_lp_confirmations x where x.source_message_id = m.message_id);
  select coalesce(jsonb_agg(to_jsonb(s) order by s.entity),'[]'::jsonb) into state_rows from public.ops_state s
    where s.entity in ('students','teachers','lpItems');
  if jsonb_array_length(state_rows) <> 3 or exists(select 1 from public.ops_state s
      where s.entity in ('students','teachers','lpItems') and jsonb_typeof(s.payload) is distinct from 'array') then
    raise exception using errcode = '55000', message = 'wecom_schedule_state_missing';
  end if;
  with runs as materialized (
    select r.id,r.revision,r.completed_at,internal.wecom_schedule_date(r.query ->> 'start') as first_day,
      internal.wecom_schedule_date(r.query ->> 'end') as last_day
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
    where r.api_source_key = 'jwb-open-api-schedule' and r.state = 'complete'
  ), days as (
    select range_start + n as day from generate_series(0,64) n where n <= range_end-range_start
  ), selected as materialized (
    select d.day,r.* from days d cross join lateral (
      select r.* from runs r where d.day between r.first_day and r.last_day
      order by (r.id = current_run) desc,r.completed_at desc,r.id desc limit 1
    ) r
  ), selected_runs as (select distinct id,revision,completed_at from selected), raw_records as materialized (
    select s.*,i.source_key,coalesce(i.item -> 'record' ->> 'dated','') collate "C" as source_date_text
    from selected_runs s cross join lateral (
      select i.source_key,i.item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i
      where i.run_id = s.id offset 0
    ) i
  ), date_values as materialized (
    select distinct source_date_text from raw_records
  ), date_map as materialized (
    select source_date_text,internal.wecom_schedule_date(source_date_text) as source_day from date_values
  ), records as materialized (
    select r.id,r.revision,r.completed_at,r.source_key,d.source_day
    from raw_records r join date_map d using(source_date_text)
  ), current_source_keys as materialized (
    select i.source_key from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id = current_run
  ), candidate_items as materialized (
    select s.day,i.id,i.revision,i.completed_at,i.source_key,latest.run_id as latest_run_id
    from selected s join records i on i.id=s.id and i.source_day=s.day
    left join internal.wecom_schedule_latest_complete_source latest on latest.source_key=i.source_key
  ), surviving as (
    select i.* from candidate_items i left join current_source_keys current_item on current_item.source_key=i.source_key
    where i.id = current_run or (i.latest_run_id = i.id and current_item.source_key is null)
  ), shaped as (
    select s.*,i.item -> 'record' as record from surviving s
    join internal.jiaowubao_open_api_schedule_snapshot_ingest_items i on i.run_id=s.id and i.source_key=s.source_key
  ) select coalesce((select jsonb_agg(jsonb_build_object(
      'startsAt',day::timestamp at time zone 'Australia/Melbourne',
      'endsAt',(day+1)::timestamp at time zone 'Australia/Melbourne','historical',id <> current_run) order by day) from selected),'[]'::jsonb),
    coalesce((select jsonb_agg(internal.wecom_schedule_event(source_key,record,revision,id,id <> current_run)
      order by day,source_key) from shaped where internal.is_wecom_schedule_trial_record(record)),'[]'::jsonb),
    (select count(*) from candidate_items where id <> current_run and latest_run_id is null),
    (select count(source_day) from records)
    into coverage_rows,event_rows,missing_cache_count,validated_record_count;
  if missing_cache_count > 0 then raise exception using errcode = '55000', message = 'wecom_schedule_latest_source_missing'; end if;
  if jsonb_array_length(event_rows) > 20000 then raise exception using errcode = '54000', message = 'wecom_schedule_event_limit'; end if;
  return jsonb_build_object('snapshotRevision',current_revision,'inputRevision',epoch,'targetSourceMessageIds',to_jsonb(target_ids),
    'sources',source_rows,'rows',state_rows,'coverage',coverage_rows,'events',event_rows);
end;
$$;
revoke all on function public.read_wecom_handover_schedule_input(text,text,text[]) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_handover_schedule_input(text,text,text[]) to anon, authenticated;

alter function public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)
  set statement_timeout = '13s';

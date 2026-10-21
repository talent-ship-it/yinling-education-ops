create function internal.assert_wecom_schedule_metadata_write_isolation()
returns void language plpgsql stable set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode='25000',message='wecom_schedule_metadata_requires_read_committed';
  end if;
end;
$$;
revoke all on function internal.assert_wecom_schedule_metadata_write_isolation() from public, anon, authenticated, service_role;

create function internal.wecom_schedule_trial_rule_fingerprint()
returns text language sql stable set search_path = '' as $$
  select md5(pg_get_functiondef('internal.is_wecom_schedule_trial_record(jsonb)'::regprocedure));
$$;
revoke all on function internal.wecom_schedule_trial_rule_fingerprint() from public, anon, authenticated, service_role;

create function internal.wecom_schedule_trial_keys_valid(p_dates jsonb,p_trial_keys jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_dates) is distinct from 'object' or jsonb_typeof(p_trial_keys) is distinct from 'object' then false
    else not exists(select 1 from jsonb_each(p_trial_keys) k where k.value is distinct from 'true'::jsonb or not(p_dates ? k.key)) end;
$$;
revoke all on function internal.wecom_schedule_trial_keys_valid(jsonb,jsonb) from public, anon, authenticated, service_role;

create table internal.wecom_schedule_run_metadata (
  run_id uuid primary key references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id) on delete cascade,
  revision text not null,
  completed_at timestamptz not null,
  canonical_rows_sha256 text not null,
  payload_sha256 text not null,
  expected_row_count integer not null,
  item_count bigint not null check (item_count >= 0),
  source_dates jsonb not null check (jsonb_typeof(source_dates) = 'object'),
  trial_source_keys jsonb not null check (jsonb_typeof(trial_source_keys) = 'object'),
  trial_rule_fingerprint text not null check (trial_rule_fingerprint ~ '^[a-f0-9]{32}$'),
  check (internal.wecom_schedule_trial_keys_valid(source_dates,trial_source_keys))
);
alter table internal.wecom_schedule_run_metadata enable row level security;
revoke all on internal.wecom_schedule_run_metadata from public, anon, authenticated, service_role;

create function internal.refresh_wecom_schedule_run_metadata(p_run_id uuid)
returns bigint language plpgsql set search_path = '' set work_mem = '32MB' as $$
declare run internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; count_items bigint; dates jsonb; trial_keys jsonb; rows_hash text; trial_rule text; prior_trial_rule text;
begin
  perform internal.assert_wecom_schedule_metadata_write_isolation();
  select * into run from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id=p_run_id for share;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-schedule-run-metadata:'||p_run_id::text,0));
  if run.id is null or run.api_source_key <> 'jwb-open-api-schedule' or run.state <> 'complete' then return 0; end if;
  trial_rule := internal.wecom_schedule_trial_rule_fingerprint();
  select c.trial_rule_fingerprint into prior_trial_rule from internal.wecom_schedule_run_metadata c where c.run_id=p_run_id;
  select count(*),coalesce(jsonb_object_agg(i.source_key,coalesce(i.item->'record'->>'dated','') collate "C"),'{}'::jsonb),
    coalesce(jsonb_object_agg(i.source_key,true) filter(where internal.is_wecom_schedule_trial_record(i.item->'record')),'{}'::jsonb),
    'sha256:'||encode(extensions.digest(coalesce(string_agg(i.item::text,'' order by i.page_index,i.item_index),''),'sha256'),'hex')
    into count_items,dates,trial_keys,rows_hash from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id=p_run_id;
  insert into internal.wecom_schedule_run_metadata as cached(run_id,revision,completed_at,canonical_rows_sha256,
    payload_sha256,expected_row_count,item_count,source_dates,trial_source_keys,trial_rule_fingerprint)
    values(run.id,run.revision,run.completed_at,rows_hash,run.payload_sha256,run.expected_row_count,count_items,dates,trial_keys,trial_rule)
    on conflict(run_id) do update set revision=excluded.revision,completed_at=excluded.completed_at,
      canonical_rows_sha256=excluded.canonical_rows_sha256,payload_sha256=excluded.payload_sha256,
      expected_row_count=excluded.expected_row_count,item_count=excluded.item_count,source_dates=excluded.source_dates,trial_source_keys=excluded.trial_source_keys,trial_rule_fingerprint=excluded.trial_rule_fingerprint;
  if prior_trial_rule is not null and prior_trial_rule is distinct from trial_rule then
    update internal.wecom_handover_schedule_epoch set revision=revision+1 where singleton;
  end if;
  return count_items;
end;
$$;
revoke all on function internal.refresh_wecom_schedule_run_metadata(uuid) from public, anon, authenticated, service_role;

create function internal.invalidate_wecom_schedule_item_metadata()
returns trigger language plpgsql security definer set search_path = '' as $$
declare metadata_run_id uuid; run_ids uuid[]; removed bigint; removed_total bigint := 0;
begin
  perform internal.assert_wecom_schedule_metadata_write_isolation();
  run_ids := case when tg_op='INSERT' then array[new.run_id] when tg_op='DELETE' then array[old.run_id]
    else array[old.run_id,new.run_id] end;
  perform 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id=any(run_ids) order by id for share;
  for metadata_run_id in select distinct id from unnest(run_ids) id order by id loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-schedule-run-metadata:'||metadata_run_id::text,0));
    delete from internal.wecom_schedule_run_metadata c where c.run_id=metadata_run_id;
    get diagnostics removed = row_count;
    removed_total := removed_total + removed;
  end loop;
  if removed_total > 0 or exists(select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
      where id=any(run_ids) and api_source_key='jwb-open-api-schedule' and state='complete') then
    update internal.wecom_handover_schedule_epoch set revision=revision+1 where singleton;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
revoke all on function internal.invalidate_wecom_schedule_item_metadata() from public, anon, authenticated, service_role;
create trigger wecom_schedule_invalidate_item_metadata
  before insert or update or delete on internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  for each row execute function internal.invalidate_wecom_schedule_item_metadata();

create function internal.index_wecom_schedule_run_metadata()
returns trigger language plpgsql security definer set search_path = '' as $$
declare removed bigint; metadata_run_id uuid;
begin
  perform internal.assert_wecom_schedule_metadata_write_isolation();
  metadata_run_id:=case when tg_op='DELETE' then old.id else new.id end;
  perform 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id=metadata_run_id for share;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-schedule-run-metadata:'||metadata_run_id::text,0));
  if tg_op <> 'INSERT' then
    delete from internal.wecom_schedule_run_metadata where run_id=old.id;
    get diagnostics removed = row_count;
    if removed > 0 or (old.api_source_key='jwb-open-api-schedule' and old.state='complete') then
      update internal.wecom_handover_schedule_epoch set revision=revision+1 where singleton;
    end if;
  end if;
  if tg_op <> 'DELETE' and new.api_source_key='jwb-open-api-schedule' and new.state='complete'
      and (tg_op='INSERT' or old.state <> 'complete') then
    perform internal.refresh_wecom_schedule_run_metadata(new.id);
  end if;
  return null;
end;
$$;
revoke all on function internal.index_wecom_schedule_run_metadata() from public, anon, authenticated, service_role;
create trigger wecom_handover_cache_run_metadata
  after insert or update or delete on internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
  for each row execute function internal.index_wecom_schedule_run_metadata();

create function internal.backfill_wecom_schedule_run_metadata(p_max_runs integer default 1)
returns jsonb language plpgsql set search_path = '' set work_mem = '32MB' as $$
declare run_id uuid; built_runs integer := 0; built_items bigint := 0; remaining_runs bigint; trial_rule text; run_ids uuid[];
begin
  perform internal.assert_wecom_schedule_metadata_write_isolation();
  if p_max_runs is null or p_max_runs not between 1 and 4 then
    raise exception using errcode='22023',message='invalid_wecom_schedule_metadata_batch';
  end if;
  trial_rule := internal.wecom_schedule_trial_rule_fingerprint();
  select array_agg(id order by id) into run_ids from (
    select r.id from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
    left join internal.wecom_schedule_run_metadata c on c.run_id=r.id
      and (c.revision,c.completed_at,c.canonical_rows_sha256,c.payload_sha256,c.expected_row_count)
        = (r.revision,r.completed_at,r.canonical_rows_sha256,r.payload_sha256,r.expected_row_count) and c.item_count=r.expected_row_count
      and c.trial_rule_fingerprint=trial_rule
      and internal.wecom_schedule_trial_keys_valid(c.source_dates,c.trial_source_keys)
    where r.api_source_key='jwb-open-api-schedule' and r.state='complete' and c.run_id is null
    order by r.id limit p_max_runs
  ) targets;
  perform 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id=any(run_ids) order by id for share;
  foreach run_id in array coalesce(run_ids,array[]::uuid[]) loop
    built_items := built_items + internal.refresh_wecom_schedule_run_metadata(run_id);
    built_runs := built_runs + 1;
  end loop;
  select count(*) into remaining_runs from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
    left join internal.wecom_schedule_run_metadata c on c.run_id=r.id
      and (c.revision,c.completed_at,c.canonical_rows_sha256,c.payload_sha256,c.expected_row_count)
        = (r.revision,r.completed_at,r.canonical_rows_sha256,r.payload_sha256,r.expected_row_count) and c.item_count=r.expected_row_count
      and c.trial_rule_fingerprint=trial_rule
      and internal.wecom_schedule_trial_keys_valid(c.source_dates,c.trial_source_keys)
    where r.api_source_key='jwb-open-api-schedule' and r.state='complete' and c.run_id is null;
  return jsonb_build_object('builtRuns',built_runs,'builtItems',built_items,'remainingRuns',remaining_runs);
end;
$$;
revoke all on function internal.backfill_wecom_schedule_run_metadata(integer) from public, anon, authenticated, service_role;

do $advance_wecom_schedule_metadata_epoch$
begin
  update internal.wecom_handover_schedule_epoch set revision=revision+1 where singleton;
  if not found then raise exception using errcode='55000',message='wecom_schedule_epoch_missing'; end if;
end;
$advance_wecom_schedule_metadata_epoch$;

create or replace function public.read_wecom_handover_schedule_input(
  p_secret text, p_snapshot_revision text, p_source_message_ids text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '12s' set work_mem = '32MB' set enable_indexscan = off as $$
declare current_run uuid; current_revision text; epoch text; target_month date; target_ids text[];
  source_rows jsonb; state_rows jsonb; coverage_rows jsonb; event_rows jsonb; source_count bigint;
  range_start date; range_end date; missing_cache_count bigint; validated_record_count bigint; missing_metadata_count bigint; missing_record_count bigint;
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
        or e.evidence -> 'algorithmVersion' is distinct from to_jsonb(internal.wecom_handover_schedule_algorithm_version())
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
        or e.evidence -> 'algorithmVersion' is distinct from to_jsonb(internal.wecom_handover_schedule_algorithm_version())
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
  with trial_rule as materialized (
    select internal.wecom_schedule_trial_rule_fingerprint() as fingerprint
  ), runs as materialized (
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
  ), metadata_runs as materialized (
    select r.id,c.item_count,c.trial_source_keys,
      coalesce((c.revision,c.completed_at,c.canonical_rows_sha256,c.payload_sha256,c.expected_row_count)
        = (r.revision,r.completed_at,r.canonical_rows_sha256,r.payload_sha256,r.expected_row_count) and c.item_count=r.expected_row_count
        and c.trial_rule_fingerprint=(select fingerprint from trial_rule)
        and internal.wecom_schedule_trial_keys_valid(c.source_dates,c.trial_source_keys),false) as metadata_valid,
      case when (c.revision,c.completed_at,c.canonical_rows_sha256,c.payload_sha256,c.expected_row_count)
        = (r.revision,r.completed_at,r.canonical_rows_sha256,r.payload_sha256,r.expected_row_count) and c.item_count=r.expected_row_count
        and c.trial_rule_fingerprint=(select fingerprint from trial_rule)
        and internal.wecom_schedule_trial_keys_valid(c.source_dates,c.trial_source_keys)
        then c.source_dates else '{}'::jsonb end as source_dates
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
    left join internal.wecom_schedule_run_metadata c on c.run_id=r.id
    where r.id=current_run or exists(select 1 from selected s where s.id=r.id)
  ), metadata_records as materialized (
    select s.id,i.key as source_key,i.value collate "C" as source_date_text,s.trial_source_keys ? i.key as is_trial
    from metadata_runs s cross join lateral jsonb_each_text(s.source_dates) i
  ), raw_records as materialized (
    select m.* from metadata_records m where exists(select 1 from selected s where s.id=m.id)
  ), metadata_counts as materialized (
    select id,count(*) as item_count from metadata_records group by id
  ), date_values as materialized (
    select distinct source_date_text from raw_records
  ), date_map as materialized (
    select source_date_text,internal.wecom_schedule_date(source_date_text) as source_day from date_values
  ), records as materialized (
    select r.id,r.source_key,r.is_trial,d.source_day
    from raw_records r join date_map d using(source_date_text)
  ), current_source_keys as materialized (
    select source_key from metadata_records where id=current_run
  ), candidate_items as materialized (
    select s.day,i.id,s.revision,i.source_key,i.is_trial,latest.run_id as latest_run_id
    from selected s join records i on i.id=s.id and i.source_day=s.day
    left join internal.wecom_schedule_latest_complete_source latest on latest.source_key=i.source_key
  ), surviving as materialized (
    select i.* from candidate_items i
    where i.id = current_run or (i.latest_run_id = i.id and not exists(
      select 1 from current_source_keys current_item where current_item.source_key=i.source_key))
  ), surviving_trials as materialized (
    select * from surviving where is_trial
  ), shaped as materialized (
    select s.*,i.item -> 'record' as record,i.run_id is not null as has_record
    from surviving_trials s left join lateral (
      select i.run_id,i.item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i
      where i.run_id=s.id and i.source_key=s.source_key offset 0
    ) i on true
  ) select coalesce((select jsonb_agg(jsonb_build_object(
      'startsAt',day::timestamp at time zone 'Australia/Melbourne',
      'endsAt',(day+1)::timestamp at time zone 'Australia/Melbourne','historical',id <> current_run) order by day) from selected),'[]'::jsonb),
    coalesce((select jsonb_agg(internal.wecom_schedule_event(source_key,record,revision,id,id <> current_run)
      order by day,source_key) from shaped where has_record and internal.is_wecom_schedule_trial_record(record)),'[]'::jsonb),
    (select count(*) from candidate_items where id <> current_run and latest_run_id is null),
    (select count(source_day) from records),
    (select count(*) from metadata_runs m left join metadata_counts c using(id)
      where not m.metadata_valid or m.item_count is distinct from coalesce(c.item_count,0)),
    (select count(*) from shaped where not has_record)
    into coverage_rows,event_rows,missing_cache_count,validated_record_count,missing_metadata_count,missing_record_count;
  if missing_metadata_count > 0 then raise exception using errcode='55000',message='wecom_schedule_run_metadata_missing'; end if;
  if missing_record_count > 0 then raise exception using errcode='55000',message='wecom_schedule_source_record_missing'; end if;
  if missing_cache_count > 0 then raise exception using errcode = '55000', message = 'wecom_schedule_latest_source_missing'; end if;
  if jsonb_array_length(event_rows) > 20000 then raise exception using errcode = '54000', message = 'wecom_schedule_event_limit'; end if;
  return jsonb_build_object('snapshotRevision',current_revision,'inputRevision',epoch,'targetSourceMessageIds',to_jsonb(target_ids),
    'sources',source_rows,'rows',state_rows,'coverage',coverage_rows,'events',event_rows);
end;
$$;
revoke all on function public.read_wecom_handover_schedule_input(text,text,text[]) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_handover_schedule_input(text,text,text[]) to anon, authenticated;

create or replace function public.read_wecom_handover_schedule_evidence(
  p_secret text,p_source_message_ids text[],p_actor text,p_full_admin boolean
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; current_trial_rule text;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_source_message_ids is null or cardinality(p_source_message_ids) > 50 or nullif(btrim(p_actor),'') is null
      or length(p_actor) > 120 or p_full_admin is null then
    raise exception using errcode = '22023', message = 'invalid_wecom_schedule_scope';
  end if;
  current_trial_rule := internal.wecom_schedule_trial_rule_fingerprint();
  if exists(select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
    left join internal.wecom_schedule_run_metadata c on c.run_id=r.id
      and (c.revision,c.completed_at,c.canonical_rows_sha256,c.payload_sha256,c.expected_row_count)
        = (r.revision,r.completed_at,r.canonical_rows_sha256,r.payload_sha256,r.expected_row_count)
      and c.item_count=r.expected_row_count and c.trial_rule_fingerprint=current_trial_rule
    where r.api_source_key='jwb-open-api-schedule' and r.state='complete' and c.run_id is null) then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(e.evidence order by e.source_message_id),'[]'::jsonb) into result
  from internal.wecom_handover_schedule_evidence e
  cross join lateral (select internal.wecom_lp_draft_source(e.source_message_id) as value) source
  where e.source_message_id = any(p_source_message_ids)
    and e.evidence -> 'algorithmVersion' = to_jsonb(internal.wecom_handover_schedule_algorithm_version())
    and e.input_revision = (select revision::text from internal.wecom_handover_schedule_epoch where singleton)
    and e.snapshot_revision = (select revision from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule')
    and source.value ->> 'sourceRevision' = e.source_revision and source.value -> 'confirmed' = 'null'::jsonb
    and (p_full_admin or source.value ->> 'operationsOwner' = btrim(p_actor))
    and not exists(select 1 from jsonb_array_elements(e.evidence -> 'candidates') candidate
      where case when candidate -> 'studentId' = 'null'::jsonb then not p_full_admin else not exists(
        select 1 from public.ops_state r cross join jsonb_array_elements(r.payload) student
        where r.entity='students' and student ->> 'id'=candidate ->> 'studentId'
          and coalesce(student ->> 'importArchived','false') <> 'true'
          and (p_full_admin or student ->> 'owner'=btrim(p_actor))) end);
  return result;
end;
$$;
revoke all on function public.read_wecom_handover_schedule_evidence(text,text[],text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_handover_schedule_evidence(text,text[],text,boolean) to anon, authenticated;

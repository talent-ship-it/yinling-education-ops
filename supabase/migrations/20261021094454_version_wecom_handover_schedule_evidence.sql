create function internal.wecom_handover_schedule_algorithm_version()
returns text language sql immutable set search_path = '' as $$ select '2'::text; $$;
revoke all on function internal.wecom_handover_schedule_algorithm_version() from public, anon, authenticated, service_role;

do $advance_wecom_handover_schedule_algorithm$
begin
  update internal.wecom_handover_schedule_epoch set revision = revision + 1 where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'wecom_schedule_epoch_missing';
  end if;
end;
$advance_wecom_handover_schedule_algorithm$;

create or replace function public.read_wecom_handover_schedule_input(
  p_secret text, p_snapshot_revision text, p_source_message_ids text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '12s' set work_mem = '32MB' set enable_indexscan = off as $$
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
  ), selected_runs as (
    select id,revision,completed_at,array_agg(day::text collate "C") as selected_dates
    from selected group by id,revision,completed_at
  ), raw_records as materialized (
    select s.id,s.revision,s.completed_at,i.source_key,raw_date.source_date_text,
      case when raw_date.source_date_text = any(s.selected_dates) then
        case when internal.is_wecom_schedule_trial_record(i.item -> 'record') then i.item -> 'record' end
      end as record
    from selected_runs s cross join lateral (
      select i.source_key,i.item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i
      where i.run_id = s.id offset 0
    ) i cross join lateral (
      select coalesce(i.item -> 'record' ->> 'dated','') collate "C" as source_date_text offset 0
    ) raw_date
  ), date_values as materialized (
    select distinct source_date_text from raw_records
  ), date_map as materialized (
    select source_date_text,internal.wecom_schedule_date(source_date_text) as source_day from date_values
  ), records as materialized (
    select r.id,r.revision,r.completed_at,r.source_key,r.record,d.source_day
    from raw_records r join date_map d using(source_date_text)
  ), current_source_keys as materialized (
    select i.source_key from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id = current_run
  ), candidate_items as materialized (
    select s.day,i.id,i.revision,i.completed_at,i.source_key,i.record,latest.run_id as latest_run_id
    from selected s join records i on i.id=s.id and i.source_day=s.day
    left join internal.wecom_schedule_latest_complete_source latest on latest.source_key=i.source_key
  ), surviving as (
    select i.* from candidate_items i left join current_source_keys current_item on current_item.source_key=i.source_key
    where i.id = current_run or (i.latest_run_id = i.id and current_item.source_key is null)
  ), shaped as (
    select * from surviving where record is not null
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

create or replace function internal.wecom_schedule_account_letter(p_label text)
returns text language sql immutable set search_path = '' as $$
  with label as (select lower(btrim(normalize(p_label, NFKC))) as value), compact as (
    select regexp_replace(value, '[[:space:][:punct:]＋＝￥€£●★☆✓✔♡♥・·｜—–～±×÷]+', '', 'g') as value from label
  ) select case when (select value from label) ~ '^试听学员a\(tara龙\)[[:space:]]*2026$' then 'a'
    else substring(value from U&'^(?:[试视]听(?:学[员生]|账号)?|trial(?:student|account)?)([abc])(?:(?:校长号|账号|account)[[:digit:]\FE0F\20E3]*|(?:year)?(?:19|20)[0-9]{2})*$') end from compact;
$$;
revoke all on function internal.wecom_schedule_account_letter(text) from public, anon, authenticated, service_role;

create function internal.wecom_schedule_title_student_name(p_course text)
returns text language plpgsql immutable set search_path = '' as $wecom_title_name$
declare hint text; compact text;
begin
  hint := substring(btrim(normalize(coalesce(p_course,''),NFKC))
    from '^.*[-–—][[:space:]]+(.{1,80}?)[[:space:]]*试听(?:课)?[[:space:]]*$');
  hint := btrim(hint);
  if coalesce(hint,'') !~ '^[A-Za-z ''’.一-鿿-]+$' then return null; end if;
  hint := regexp_replace(hint,'([A-Za-z])[ .''’_-]+(?=[一-鿿])','\1','g');
  if hint !~ '^[A-Za-z''’.-]+( +[A-Za-z''’.-]+){0,3}[一-鿿]{0,8}$'
      or hint !~ '[A-Za-z]' or internal.wecom_schedule_account_letter(hint) is not null then return null; end if;
  compact := replace(lower(hint),' ','');
  if compact ~ '^(?:(?:english|mathematics|maths?|verbalreasoning|reading|writing|science|physics|chemistry|biology|aes|trial))+$'
      or compact ~ '^(?:unknown|tbd|na|none|null|student|unknownstudent|newstudent|trialstudent|placeholder|pending|notprovided|notknown)$' then return null; end if;
  return hint;
end;
$wecom_title_name$;
revoke all on function internal.wecom_schedule_title_student_name(text) from public, anon, authenticated, service_role;

create or replace function public.save_wecom_handover_schedule_evidence(
  p_secret text,p_snapshot_revision text,p_input_revision text,p_evidence jsonb,p_actor text default 'Ops Admin'
) returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '13s' set work_mem = '32MB' as $$
declare epoch text; input jsonb; entry jsonb; candidate jsonb; schedule jsonb; source jsonb; event jsonb; student jsonb;
  ids text[]; checked timestamptz; account_metadata jsonb; title_name text; title_only boolean; count_matched integer := 0; count_candidate integer := 0;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or jsonb_typeof(p_evidence) is distinct from 'array'
      or jsonb_array_length(p_evidence) not between 1 and 50 or octet_length(p_evidence::text) > 2097152 then
    raise exception using errcode = '22023', message = 'invalid_wecom_schedule_evidence';
  end if;
  if exists(select 1 from jsonb_array_elements(p_evidence) item
      where jsonb_typeof(item) is distinct from 'object'
        or item -> 'algorithmVersion' is distinct from to_jsonb(internal.wecom_handover_schedule_algorithm_version())) then
    raise exception using errcode = '40001', message = 'wecom_schedule_algorithm_changed';
  end if;
  select revision::text into epoch from internal.wecom_handover_schedule_epoch where singleton for share;
  if epoch is distinct from p_input_revision then raise exception using errcode = '40001', message = 'wecom_schedule_input_changed'; end if;
  select array_agg(value ->> 'sourceMessageId') into ids from jsonb_array_elements(p_evidence);
  input := public.read_wecom_handover_schedule_input(p_secret,p_snapshot_revision,ids);
  if input ->> 'inputRevision' is distinct from p_input_revision then raise exception using errcode = '40001', message = 'wecom_schedule_input_changed'; end if;
  for entry in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(entry) is distinct from 'object'
       or entry - array['sourceMessageId','sourceRevision','snapshotRevision','checkedAt','status','matchedStudentId','candidates','algorithmVersion']::text[] <> '{}'::jsonb
       or not(entry ?& array['sourceMessageId','sourceRevision','snapshotRevision','checkedAt','status','matchedStudentId','candidates','algorithmVersion'])
       or exists(select 1 from unnest(array['sourceMessageId','sourceRevision','snapshotRevision','checkedAt','status','algorithmVersion']) key
         where jsonb_typeof(entry -> key) is distinct from 'string')
       or jsonb_typeof(entry -> 'matchedStudentId') not in ('null','string')
       or entry ->> 'snapshotRevision' is distinct from p_snapshot_revision
       or coalesce(entry ->> 'status','') not in ('matched','candidate','ambiguous','needs_identity','outside_window','no_match','identity_conflict')
       or jsonb_typeof(entry -> 'candidates') is distinct from 'array'
       or jsonb_array_length(entry -> 'candidates') > 8 then
      raise exception using errcode = '22023', message = 'invalid_wecom_schedule_evidence';
    end if;
    select value into source from jsonb_array_elements(input -> 'sources') where value ->> 'sourceMessageId' = entry ->> 'sourceMessageId';
    if source is null or source ->> 'sourceRevision' is distinct from entry ->> 'sourceRevision' or source -> 'confirmed' <> 'null'::jsonb then
      raise exception using errcode = '40001', message = 'wecom_schedule_source_changed';
    end if;
    if (entry ->> 'status' = 'matched' and (jsonb_array_length(entry -> 'candidates') <> 1
          or nullif(entry ->> 'matchedStudentId','') is null
          or entry ->> 'matchedStudentId' is distinct from entry -> 'candidates' -> 0 ->> 'studentId'))
       or (entry ->> 'status' <> 'matched' and entry -> 'matchedStudentId' <> 'null'::jsonb)
       or (entry ->> 'status' = 'candidate' and jsonb_array_length(entry -> 'candidates') <> 1)
       or (entry ->> 'status' in ('needs_identity','outside_window','no_match','identity_conflict') and jsonb_array_length(entry -> 'candidates') <> 0)
       or (source ->> 'status' in ('identity_conflict','identity_ambiguous') and entry ->> 'status' <> 'identity_conflict') then
      raise exception using errcode = '22023', message = 'invalid_wecom_schedule_status';
    end if;
    begin checked := (entry ->> 'checkedAt')::timestamptz;
    exception when others then raise exception using errcode = '22023', message = 'invalid_wecom_schedule_checked_at'; end;
    if checked is null or not isfinite(checked) or checked > now() + interval '5 minutes' then
      raise exception using errcode = '22023', message = 'invalid_wecom_schedule_checked_at';
    end if;
    for candidate in select value from jsonb_array_elements(entry -> 'candidates') loop
      if jsonb_typeof(candidate) is distinct from 'object'
         or candidate - array['studentId','studentName','schedule','sourceRunId']::text[] <> '{}'::jsonb
         or not(candidate ?& array['studentId','studentName','schedule','sourceRunId'])
         or exists(select 1 from unnest(array['studentName','sourceRunId']) key
           where jsonb_typeof(candidate -> key) is distinct from 'string')
         or jsonb_typeof(candidate -> 'studentId') not in ('string','null')
         or (candidate -> 'studentId' <> 'null'::jsonb and nullif(candidate ->> 'studentId','') is null)
         or jsonb_typeof(candidate -> 'schedule') is distinct from 'object' then
        raise exception using errcode = '22023', message = 'invalid_wecom_schedule_candidate';
      end if;
      title_only := candidate -> 'studentId' = 'null'::jsonb;
      if title_only then
        student := null;
        if entry ->> 'status' not in ('candidate','ambiguous') then
          raise exception using errcode = '22023', message = 'invalid_wecom_schedule_title_candidate';
        end if;
      else
        select s into student from public.ops_state r cross join jsonb_array_elements(r.payload) s
          where r.entity = 'students' and s ->> 'id' = candidate ->> 'studentId' and coalesce(s ->> 'importArchived','false') <> 'true';
        if student is null or student ->> 'name' is distinct from candidate ->> 'studentName' then
          raise exception using errcode = '22023', message = 'invalid_wecom_schedule_student';
        end if;
      end if;
      schedule := candidate -> 'schedule';
      if schedule - array['source','eventId','startsAt','endsAt','courseName','studentName','teacherId','teacherName','plannerHint','matchedAt','sourceRevision','durationMinutes','sharedAccountLabel','sharedAccountLetter']::text[] <> '{}'::jsonb
         or not(schedule ?& array['source','eventId','startsAt','endsAt','courseName','studentName','teacherId','teacherName','plannerHint','matchedAt','sourceRevision'])
         or exists(select 1 from unnest(array['source','eventId','startsAt','endsAt','studentName','teacherName','matchedAt','sourceRevision']) key
           where jsonb_typeof(schedule -> key) is distinct from 'string')
         or jsonb_typeof(schedule -> 'courseName') not in ('null','string')
         or jsonb_typeof(schedule -> 'teacherId') not in ('null','string')
         or jsonb_typeof(schedule -> 'plannerHint') not in ('null','string')
         or (schedule ? 'durationMinutes' and jsonb_typeof(schedule -> 'durationMinutes') is distinct from 'number')
         or schedule ->> 'source' is distinct from 'jiaowubao-open-api'
         or schedule ->> 'studentName' is distinct from candidate ->> 'studentName'
         or schedule ->> 'matchedAt' is distinct from entry ->> 'checkedAt' then
        raise exception using errcode = '22023', message = 'invalid_wecom_schedule_link';
      end if;
      select value into event from jsonb_array_elements(input -> 'events')
        where value ->> 'eventId' = schedule ->> 'eventId' and value ->> 'sourceRunId' = candidate ->> 'sourceRunId';
      account_metadata := internal.wecom_schedule_account_metadata(event -> 'sourceParticipants');
      if title_only then
        title_name := internal.wecom_schedule_title_student_name(event ->> 'courseName');
        if title_name is null or candidate ->> 'studentName' is distinct from title_name
            or nullif(account_metadata ->> 'sharedAccountLetter','') is null
            or jsonb_array_length(event -> 'sourceParticipants') = 0
            or exists(select 1 from jsonb_array_elements(event -> 'sourceParticipants') participant
              where internal.wecom_schedule_account_letter(participant ->> 'label')
                is distinct from account_metadata ->> 'sharedAccountLetter') then
          raise exception using errcode = '22023', message = 'invalid_wecom_schedule_title_candidate';
        end if;
      end if;
      if event is null or coalesce((event ->> 'sourceStudentsTruncated')::boolean,true)
         or schedule ->> 'sourceRevision' is distinct from event ->> 'sourceRevision'
         or (schedule ->> 'startsAt')::timestamptz is distinct from (event ->> 'startsAt')::timestamptz
         or (schedule ->> 'endsAt')::timestamptz is distinct from (event ->> 'endsAt')::timestamptz
         or schedule -> 'courseName' is distinct from event -> 'courseName'
         or schedule ->> 'teacherName' is distinct from coalesce(event ->> 'sourceTeacherLabel','')
         or schedule -> 'plannerHint' is distinct from account_metadata -> 'plannerHint'
         or coalesce(schedule -> 'sharedAccountLabel','null'::jsonb) is distinct from account_metadata -> 'sharedAccountLabel'
         or coalesce(schedule -> 'sharedAccountLetter','null'::jsonb) is distinct from account_metadata -> 'sharedAccountLetter'
         or (schedule ? 'durationMinutes' and (schedule ->> 'durationMinutes')::numeric is distinct from
            extract(epoch from ((event ->> 'endsAt')::timestamptz-(event ->> 'startsAt')::timestamptz))/60)
         or (schedule -> 'teacherId' <> 'null'::jsonb and not exists(
           select 1 from public.ops_state r cross join jsonb_array_elements(r.payload) t
           where r.entity = 'teachers' and t ->> 'id' = schedule ->> 'teacherId'
             and regexp_replace(lower(normalize(t ->> 'name',NFKC)),'[[:space:]]+','','g')
               = regexp_replace(lower(normalize(event ->> 'sourceTeacherLabel',NFKC)),'[[:space:]]+','','g')
             and (select count(distinct teacher ->> 'id') from public.ops_state tr cross join jsonb_array_elements(tr.payload) teacher
               where tr.entity='teachers' and regexp_replace(lower(normalize(teacher ->> 'name',NFKC)),'[[:space:]]+','','g')
                 = regexp_replace(lower(normalize(event ->> 'sourceTeacherLabel',NFKC)),'[[:space:]]+','','g'))=1)) then
        raise exception using errcode = '22023', message = 'invalid_wecom_schedule_event';
      end if;
    end loop;
    insert into internal.wecom_handover_schedule_evidence(source_message_id,source_revision,snapshot_revision,input_revision,checked_at,evidence)
      values(entry ->> 'sourceMessageId',entry ->> 'sourceRevision',p_snapshot_revision,p_input_revision,checked,entry)
      on conflict(source_message_id) do update set source_revision=excluded.source_revision,snapshot_revision=excluded.snapshot_revision,
        input_revision=excluded.input_revision,checked_at=excluded.checked_at,evidence=excluded.evidence;
    count_matched := count_matched + (entry ->> 'status' = 'matched')::integer;
    count_candidate := count_candidate + (entry ->> 'status' = 'candidate')::integer;
  end loop;
  return jsonb_build_object('checkedCount',jsonb_array_length(p_evidence),'matchedCount',count_matched,'candidateCount',count_candidate);
end;
$$;
revoke all on function public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text) to anon, authenticated;


create or replace function public.read_wecom_handover_schedule_evidence(
  p_secret text,p_source_message_ids text[],p_actor text,p_full_admin boolean
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_source_message_ids is null or cardinality(p_source_message_ids) > 50 or nullif(btrim(p_actor),'') is null
      or length(p_actor) > 120 or p_full_admin is null then
    raise exception using errcode = '22023', message = 'invalid_wecom_schedule_scope';
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

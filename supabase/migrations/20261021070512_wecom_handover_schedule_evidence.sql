create table internal.wecom_handover_schedule_epoch (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 1 check (revision > 0)
);
insert into internal.wecom_handover_schedule_epoch(singleton) values(true);
alter table internal.wecom_handover_schedule_epoch enable row level security;
revoke all on internal.wecom_handover_schedule_epoch from public, anon, authenticated, service_role;

create table internal.wecom_handover_schedule_evidence (
  source_message_id text primary key references internal.wecom_archive_messages(message_id) on delete cascade,
  source_revision text not null,
  snapshot_revision text not null,
  input_revision text not null,
  checked_at timestamptz not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object')
);
alter table internal.wecom_handover_schedule_evidence enable row level security;
revoke all on internal.wecom_handover_schedule_evidence from public, anon, authenticated, service_role;
create index wecom_handover_evidence_checked_idx on internal.wecom_handover_schedule_evidence(checked_at, source_message_id);
create index if not exists jwb_schedule_items_source_run_idx on internal.jiaowubao_open_api_schedule_snapshot_ingest_items(source_key, run_id);

create function internal.advance_wecom_handover_schedule_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'wecom_archive_messages' then
    if not (coalesce(new.ingested_by='WeCom Bot Receiver' and new.message_type='text' and new.classification='handover',false)
      or coalesce(old.ingested_by='WeCom Bot Receiver' and old.message_type='text' and old.classification='handover',false)) then return null; end if;
    if tg_op='UPDATE' and (new.message_id,new.trial_handover_id,new.body,new.sent_at,new.student_id,new.student_name_hint,
        new.guardian_wechat_hint,new.operations_owner_hint,new.course_planner_hint,new.ingested_by,new.ingested_at,new.classification,new.message_type)
      is not distinct from (old.message_id,old.trial_handover_id,old.body,old.sent_at,old.student_id,old.student_name_hint,
        old.guardian_wechat_hint,old.operations_owner_hint,old.course_planner_hint,old.ingested_by,old.ingested_at,old.classification,old.message_type) then return null; end if;
  elsif tg_table_name = 'ops_state' then
    if coalesce(new.entity,'') not in ('students','teachers','lpItems')
       and coalesce(old.entity,'') not in ('students','teachers','lpItems') then return null; end if;
    if tg_op = 'UPDATE' and new.entity is not distinct from old.entity and new.payload is not distinct from old.payload then return null; end if;
  elsif tg_table_name = 'jiaowubao_open_api_schedule_snapshot_current' then
    if coalesce(new.api_source_key,'') <> 'jwb-open-api-schedule'
       and coalesce(old.api_source_key,'') <> 'jwb-open-api-schedule' then return null; end if;
    if tg_op = 'UPDATE' and (new.api_source_key,new.run_id,new.revision) is not distinct from (old.api_source_key,old.run_id,old.revision) then return null; end if;
  elsif tg_table_name = 'jiaowubao_open_api_schedule_snapshot_ingest_runs' then
    if new.api_source_key <> 'jwb-open-api-schedule' or new.state <> 'complete' then return null; end if;
    if tg_op = 'UPDATE' and old.state = 'complete' then return null; end if;
  end if;
  update internal.wecom_handover_schedule_epoch set revision = revision + 1 where singleton;
  return null;
end;
$$;
revoke all on function internal.advance_wecom_handover_schedule_epoch() from public, anon, authenticated, service_role;
create trigger wecom_handover_epoch_archive after insert or update or delete on internal.wecom_archive_messages
  for each row execute function internal.advance_wecom_handover_schedule_epoch();
create trigger wecom_handover_epoch_cases after insert or update or delete on internal.wecom_trial_handover_cases
  for each row execute function internal.advance_wecom_handover_schedule_epoch();
create trigger wecom_handover_epoch_confirmations after insert or update or delete on internal.wecom_lp_confirmations
  for each row execute function internal.advance_wecom_handover_schedule_epoch();
create trigger wecom_handover_epoch_ops after insert or update or delete on public.ops_state
  for each row execute function internal.advance_wecom_handover_schedule_epoch();
create trigger wecom_handover_epoch_pointer after insert or update or delete on internal.jiaowubao_open_api_schedule_snapshot_current
  for each row execute function internal.advance_wecom_handover_schedule_epoch();
create trigger wecom_handover_epoch_runs after insert or update on internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
  for each row execute function internal.advance_wecom_handover_schedule_epoch();

create function internal.wecom_schedule_date(p_value text)
returns date language plpgsql immutable set search_path = '' as $$
declare result date;
begin
  if coalesce(p_value, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'wecom_schedule_invalid_source_date';
  end if;
  result := p_value::date;
  if result::text <> p_value then raise exception using errcode = '22023', message = 'wecom_schedule_invalid_source_date'; end if;
  return result;
end;
$$;
revoke all on function internal.wecom_schedule_date(text) from public, anon, authenticated, service_role;

create function internal.wecom_schedule_event(p_source_key text, p_record jsonb, p_revision text, p_run_id uuid, p_historical boolean)
returns jsonb language plpgsql stable set search_path = '' as $$
declare day date; starts_at timestamptz; ends_at timestamptz; members jsonb; member_count integer;
begin
  day := internal.wecom_schedule_date(p_record ->> 'dated');
  if coalesce(p_record ->> 'time_start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
     or coalesce(p_record ->> 'time_end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
     or (p_record ->> 'time_end')::time <= (p_record ->> 'time_start')::time
     or jsonb_typeof(p_record -> 'stu_list') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'wecom_schedule_invalid_source_event';
  end if;
  starts_at := (day + (p_record ->> 'time_start')::time) at time zone 'Australia/Melbourne';
  ends_at := (day + (p_record ->> 'time_end')::time) at time zone 'Australia/Melbourne';
  with participants as (
    select distinct nullif(btrim(member ->> 'mem_id'),'') as member_id, nullif(btrim(member ->> 'name'),'') as label
    from jsonb_array_elements(p_record -> 'stu_list') member
  ), numbered as (
    select *, row_number() over(order by member_id nulls last, label nulls last) as position from participants
  ) select coalesce(jsonb_agg(jsonb_build_object('memberId',member_id,'label',label) order by position)
      filter(where position <= 101),'[]'::jsonb), count(*) into members, member_count from numbered;
  return jsonb_build_object('eventId',p_source_key,'sourceDate',day::text,'startsAt',starts_at,'endsAt',ends_at,
    'courseName',nullif(btrim(p_record ->> 'course_title'),''),'sourceTeacherId',nullif(btrim(p_record ->> 'teacher_id'),''),
    'sourceTeacherLabel',nullif(btrim(p_record ->> 'teacher_title'),''),'sourceParticipants',members,
    'sourceStudentsTruncated',member_count > 100,'sourceRevision',p_revision,'sourceRunId',p_run_id,'historical',p_historical);
end;
$$;
revoke all on function internal.wecom_schedule_event(text,jsonb,text,uuid,boolean) from public, anon, authenticated, service_role;

create function internal.wecom_schedule_account_letter(p_label text)
returns text language sql immutable set search_path = '' as $$
  with label as (select lower(btrim(normalize(p_label, NFKC))) as value), compact as (
    select regexp_replace(value, '[[:space:][:punct:]＋＝￥€£●★☆✓✔♡♥・·｜—–～±×÷]+', '', 'g') as value from label
  ) select case when (select value from label) ~ '^试听学员a\(tara龙\)[[:space:]]*2026$' then 'a'
    else substring(value from '^(?:[试视]听(?:学[员生]|账号)?|trial(?:student|account)?)([abc])(?:(?:校长号|账号|account)[[:digit:]]*|(?:year)?(?:19|20)[0-9]{2})*$') end from compact;
$$;
revoke all on function internal.wecom_schedule_account_letter(text) from public, anon, authenticated, service_role;

create function internal.wecom_schedule_account_metadata(p_participants jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with accounts as (
    select value ->> 'label' as label, internal.wecom_schedule_account_letter(value ->> 'label') as letter,position
    from jsonb_array_elements(p_participants) with ordinality as participants(value,position)
  ), distinct_letters as (select count(distinct letter) as count from accounts)
  select case when (select count from distinct_letters)=1 then (
    select jsonb_build_object('plannerHint',case letter when 'a' then 'Tara' when 'b' then 'Eileen' when 'c' then 'Abby' end,
      'sharedAccountLetter',letter,'sharedAccountLabel',btrim(label)) from accounts where letter is not null order by position limit 1
  ) else '{"plannerHint":null,"sharedAccountLetter":null,"sharedAccountLabel":null}'::jsonb end;
$$;
revoke all on function internal.wecom_schedule_account_metadata(jsonb) from public, anon, authenticated, service_role;

create function public.read_wecom_handover_schedule_input(
  p_secret text, p_snapshot_revision text, p_source_message_ids text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_run uuid; current_revision text; epoch text; target_month date; target_ids text[];
  source_rows jsonb; state_rows jsonb; coverage_rows jsonb; event_rows jsonb; source_count bigint;
  range_start date; range_end date;
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
    select range_start + n as day from generate_series(0,range_end-range_start) n
  ), selected as materialized (
    select d.day,r.* from days d cross join lateral (
      select r.* from runs r where d.day between r.first_day and r.last_day
      order by (r.id = current_run) desc,r.completed_at desc,r.id desc limit 1
    ) r
  ), selected_runs as (select distinct id,revision,completed_at from selected), records as materialized (
    select s.*,i.source_key,i.item -> 'record' as record,internal.wecom_schedule_date(i.item -> 'record' ->> 'dated') as source_day
    from selected_runs s join internal.jiaowubao_open_api_schedule_snapshot_ingest_items i on i.run_id = s.id
  ), candidate_items as materialized (
    select s.day,i.id,i.revision,i.completed_at,i.source_key,i.record
    from selected s join records i on i.id=s.id and i.source_day=s.day
  ), surviving as (
    select i.* from candidate_items i where not exists (
      select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_items newer
      join runs nr on nr.id = newer.run_id
      where newer.source_key = i.source_key and nr.id <> i.id
        and ((nr.id = current_run and i.id <> current_run)
          or (i.id <> current_run and (nr.completed_at,nr.id) > (i.completed_at,i.id)))
    )
  ) select coalesce((select jsonb_agg(jsonb_build_object(
      'startsAt',day::timestamp at time zone 'Australia/Melbourne',
      'endsAt',(day+1)::timestamp at time zone 'Australia/Melbourne','historical',id <> current_run) order by day) from selected),'[]'::jsonb),
    coalesce((select jsonb_agg(internal.wecom_schedule_event(source_key,record,revision,id,id <> current_run)
      order by day,source_key) from surviving),'[]'::jsonb) into coverage_rows,event_rows;
  if jsonb_array_length(event_rows) > 20000 then raise exception using errcode = '54000', message = 'wecom_schedule_event_limit'; end if;
  return jsonb_build_object('snapshotRevision',current_revision,'inputRevision',epoch,'targetSourceMessageIds',to_jsonb(target_ids),
    'sources',source_rows,'rows',state_rows,'coverage',coverage_rows,'events',event_rows);
end;
$$;
revoke all on function public.read_wecom_handover_schedule_input(text,text,text[]) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_handover_schedule_input(text,text,text[]) to anon, authenticated;

create function public.save_wecom_handover_schedule_evidence(
  p_secret text,p_snapshot_revision text,p_input_revision text,p_evidence jsonb,p_actor text default 'Ops Admin'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare epoch text; input jsonb; entry jsonb; candidate jsonb; schedule jsonb; source jsonb; event jsonb; student jsonb;
  ids text[]; checked timestamptz; account_metadata jsonb; count_matched integer := 0; count_candidate integer := 0;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or jsonb_typeof(p_evidence) is distinct from 'array'
      or jsonb_array_length(p_evidence) not between 1 and 50 or octet_length(p_evidence::text) > 2097152 then
    raise exception using errcode = '22023', message = 'invalid_wecom_schedule_evidence';
  end if;
  select revision::text into epoch from internal.wecom_handover_schedule_epoch where singleton for share;
  if epoch is distinct from p_input_revision then raise exception using errcode = '40001', message = 'wecom_schedule_input_changed'; end if;
  select array_agg(value ->> 'sourceMessageId') into ids from jsonb_array_elements(p_evidence);
  input := public.read_wecom_handover_schedule_input(p_secret,p_snapshot_revision,ids);
  if input ->> 'inputRevision' is distinct from p_input_revision then raise exception using errcode = '40001', message = 'wecom_schedule_input_changed'; end if;
  for entry in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(entry) is distinct from 'object'
       or entry - array['sourceMessageId','sourceRevision','snapshotRevision','checkedAt','status','matchedStudentId','candidates']::text[] <> '{}'::jsonb
       or not(entry ?& array['sourceMessageId','sourceRevision','snapshotRevision','checkedAt','status','matchedStudentId','candidates'])
       or exists(select 1 from unnest(array['sourceMessageId','sourceRevision','snapshotRevision','checkedAt','status']) key
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
         or exists(select 1 from unnest(array['studentId','studentName','sourceRunId']) key
           where jsonb_typeof(candidate -> key) is distinct from 'string')
         or nullif(candidate ->> 'studentId','') is null or jsonb_typeof(candidate -> 'schedule') is distinct from 'object' then
        raise exception using errcode = '22023', message = 'invalid_wecom_schedule_candidate';
      end if;
      select s into student from public.ops_state r cross join jsonb_array_elements(r.payload) s
        where r.entity = 'students' and s ->> 'id' = candidate ->> 'studentId' and coalesce(s ->> 'importArchived','false') <> 'true';
      if student is null or student ->> 'name' is distinct from candidate ->> 'studentName' then
        raise exception using errcode = '22023', message = 'invalid_wecom_schedule_student';
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
         or schedule ->> 'studentName' is distinct from student ->> 'name'
         or schedule ->> 'matchedAt' is distinct from entry ->> 'checkedAt' then
        raise exception using errcode = '22023', message = 'invalid_wecom_schedule_link';
      end if;
      select value into event from jsonb_array_elements(input -> 'events')
        where value ->> 'eventId' = schedule ->> 'eventId' and value ->> 'sourceRunId' = candidate ->> 'sourceRunId';
      account_metadata := internal.wecom_schedule_account_metadata(event -> 'sourceParticipants');
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

create function public.read_wecom_handover_schedule_evidence(
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
    and e.input_revision = (select revision::text from internal.wecom_handover_schedule_epoch where singleton)
    and e.snapshot_revision = (select revision from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule')
    and source.value ->> 'sourceRevision' = e.source_revision and source.value -> 'confirmed' = 'null'::jsonb
    and (p_full_admin or source.value ->> 'operationsOwner' = btrim(p_actor))
    and not exists(select 1 from jsonb_array_elements(e.evidence -> 'candidates') candidate where not exists(
      select 1 from public.ops_state r cross join jsonb_array_elements(r.payload) student
      where r.entity='students' and student ->> 'id'=candidate ->> 'studentId'
        and coalesce(student ->> 'importArchived','false') <> 'true'
        and (p_full_admin or student ->> 'owner'=btrim(p_actor))));
  return result;
end;
$$;
revoke all on function public.read_wecom_handover_schedule_evidence(text,text[],text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_handover_schedule_evidence(text,text[],text,boolean) to anon, authenticated;

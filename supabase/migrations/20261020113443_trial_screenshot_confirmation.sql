create table internal.trial_screenshot_commands (
  command_key uuid primary key,
  command_intent jsonb not null,
  actor text not null,
  student_id text not null,
  lp_item_id text not null,
  audit_id uuid not null references internal.operational_contract_audit(id),
  created_at timestamptz not null default now()
);
alter table internal.trial_screenshot_commands enable row level security;
alter table internal.trial_screenshot_commands force row level security;
revoke all on internal.trial_screenshot_commands from public, anon, authenticated, service_role;

create function internal.trial_screenshot_text_key(p_value text)
returns text language sql immutable security invoker set search_path = '' as $$
  select lower(regexp_replace(normalize(btrim(coalesce(p_value,'')), NFKC), '[[:space:]]+', ' ', 'g'))
$$;
revoke all on function internal.trial_screenshot_text_key(text) from public, anon, authenticated, service_role;

create function internal.trial_screenshot_student_scope(p_lp jsonb, p_students jsonb, p_actor text, p_full_admin boolean)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare student jsonb;
begin
  if p_full_admin is null or nullif(btrim(p_actor),'') is null or length(p_actor)>120 then
    raise exception using errcode='22023',message='invalid_trial_screenshot_actor';
  end if;
  if p_lp is null or p_lp->>'workflowType' not in ('试听 LP','换老师试听') then
    raise exception using errcode='P0002',message='trial_screenshot_lp_not_found';
  end if;
  select value into student from jsonb_array_elements(p_students) where value->>'id'=p_lp->>'studentId';
  if student is null or coalesce(student->>'importArchived','false')='true' or not p_full_admin and (
    internal.trial_screenshot_text_key(student->>'owner')<>internal.trial_screenshot_text_key(p_actor)
    or internal.trial_screenshot_text_key(coalesce(nullif(p_lp#>>'{fields,responsibleOperations}',''),student->>'owner'))<>internal.trial_screenshot_text_key(p_actor)
  ) then raise exception using errcode='42501',message='trial_screenshot_owner_scope_forbidden'; end if;
  return student->>'id';
end;
$$;
revoke all on function internal.trial_screenshot_student_scope(jsonb,jsonb,text,boolean) from public, anon, authenticated, service_role;

create function public.get_trial_screenshot_command_result(
  p_secret text,p_command_uuid text,p_command_intent jsonb,p_actor text,p_full_admin boolean
)
returns table(command_key text,applied boolean,student_id text,lp_item_id text,lp_items_row public.ops_state,tasks_row public.ops_state,audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare prior internal.trial_screenshot_commands%rowtype; s public.ops_state%rowtype; l public.ops_state%rowtype; t public.ops_state%rowtype; lp jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if coalesce(p_command_uuid,'')!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_command_intent) is distinct from 'object' or p_full_admin is null or nullif(btrim(p_actor),'') is null or length(p_actor)>120 then
    raise exception using errcode='22023',message='invalid_trial_screenshot_command';
  end if;
  select * into prior from internal.trial_screenshot_commands c where c.command_key=p_command_uuid::uuid;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor<>btrim(p_actor) then raise exception using errcode='23505',message='trial_screenshot_idempotency_conflict'; end if;
  select * into s from public.ops_state where entity='students';
  select * into l from public.ops_state where entity='lpItems';
  select * into t from public.ops_state where entity='tasks';
  select value into lp from jsonb_array_elements(l.payload) where value->>'id'=prior.lp_item_id;
  perform internal.trial_screenshot_student_scope(lp,s.payload,p_actor,p_full_admin);
  return query select prior.command_key::text,false,prior.student_id,prior.lp_item_id,l,t,prior.audit_id;
end;
$$;
revoke all on function public.get_trial_screenshot_command_result(text,text,jsonb,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.get_trial_screenshot_command_result(text,text,jsonb,text,boolean) to anon, authenticated;

create function public.confirm_trial_screenshot_atomic(
  p_secret text,p_command_uuid text,p_command_intent jsonb,p_expected_versions jsonb,p_next_lp_items jsonb,p_next_tasks jsonb,p_actor text,p_full_admin boolean
)
returns table(command_key text,applied boolean,student_id text,lp_item_id text,lp_items_row public.ops_state,tasks_row public.ops_state,audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  s public.ops_state%rowtype; l public.ops_state%rowtype; t public.ops_state%rowtype;
  prior internal.trial_screenshot_commands%rowtype;
  pointer internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  source_run internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  source_record jsonb; before_lp jsonb; next_lp jsonb; enriched_lp jsonb; enriched_items jsonb;
  before_fields jsonb; next_fields jsonb; before_intake jsonb; next_intake jsonb; schedule jsonb;
  target_student_id text; target_student jsonb; source_date date; source_start timestamptz; source_end timestamptz;
  source_teacher text; source_course text; source_hint text; next_name text; source_duration numeric;
  window_value jsonb; matches jsonb; next_versions jsonb; delegate_intent jsonb; receipt record; audit_id_value uuid;
  fields_changed boolean;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if coalesce(p_command_uuid,'')!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_command_intent) is distinct from 'object'
    or p_command_intent-'lpItemId'-'eventId'-'sourceRevision'-'sourceDate'-'expectedVersions'<>'{}'::jsonb
    or coalesce(p_command_intent->>'lpItemId','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or coalesce(p_command_intent->>'eventId','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    or coalesce(p_command_intent->>'sourceRevision','')!~'^sha256:[a-f0-9]{64}$'
    or coalesce(p_command_intent->>'sourceDate','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or p_command_intent->'expectedVersions' is distinct from p_expected_versions
    or jsonb_typeof(p_expected_versions) is distinct from 'object'
    or p_expected_versions-'students'-'lpItems'-'tasks'<>'{}'::jsonb
    or coalesce(p_expected_versions->>'students','')!~'^[1-9][0-9]{0,14}$'
    or coalesce(p_expected_versions->>'lpItems','')!~'^[1-9][0-9]{0,14}$'
    or coalesce(p_expected_versions->>'tasks','')!~'^[1-9][0-9]{0,14}$'
    or jsonb_typeof(p_next_lp_items) is distinct from 'array' or jsonb_typeof(p_next_tasks) is distinct from 'array'
    or nullif(btrim(p_actor),'') is null or length(p_actor)>120 or p_full_admin is null then
    raise exception using errcode='22023',message='invalid_trial_screenshot_request';
  end if;
  select * into s from public.ops_state where entity='students' for share;
  select * into l from public.ops_state where entity='lpItems' for update;
  select * into t from public.ops_state where entity='tasks' for update;
  if s.entity is null or l.entity is null or t.entity is null or jsonb_typeof(s.payload) is distinct from 'array'
    or jsonb_typeof(l.payload) is distinct from 'array' or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode='55000',message='trial_screenshot_state_unavailable';
  end if;
  select value into before_lp from jsonb_array_elements(l.payload) where value->>'id'=p_command_intent->>'lpItemId';
  target_student_id:=internal.trial_screenshot_student_scope(before_lp,s.payload,p_actor,p_full_admin);
  select value into target_student from jsonb_array_elements(s.payload) where value->>'id'=target_student_id;
  select * into prior from internal.trial_screenshot_commands c where c.command_key=p_command_uuid::uuid;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor<>btrim(p_actor) then raise exception using errcode='23505',message='trial_screenshot_idempotency_conflict'; end if;
    return query select prior.command_key::text,false,prior.student_id,prior.lp_item_id,l,t,prior.audit_id;
    return;
  end if;
  if exists(select 1 from internal.jiaowubao_trial_sync_commands c where c.command_key=p_command_uuid::uuid) then raise exception using errcode='23505',message='trial_screenshot_idempotency_conflict'; end if;
  if s.version<>(p_expected_versions->>'students')::bigint or l.version<>(p_expected_versions->>'lpItems')::bigint or t.version<>(p_expected_versions->>'tasks')::bigint then
    raise exception using errcode='40001',message='version_conflict';
  end if;
  if before_lp->>'stage'='完成' or before_lp->>'resultStatus'='已取消' or nullif(before_lp#>>'{trialScheduleReview,eventId}','') is not null and before_lp#>>'{trialScheduleReview,eventId}' is distinct from p_command_intent->>'eventId' or nullif(before_lp#>>'{trialSchedule,eventId}','') is not null and before_lp#>>'{trialSchedule,eventId}' is distinct from p_command_intent->>'eventId' then
    raise exception using errcode='40001',message='trial_screenshot_existing_event_conflict';
  end if;
  select * into pointer from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key='jwb-open-api-schedule' for share;
  select * into source_run from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=pointer.run_id and r.api_source_key=pointer.api_source_key and r.revision=pointer.revision and r.state='complete';
  if pointer.api_source_key is null or pointer.published_at is null or pointer.revision is distinct from p_command_intent->>'sourceRevision' or source_run.id is null or pointer.published_at < clock_timestamp()-interval '2 hours'
    or coalesce(source_run.query->>'start','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(source_run.query->>'end','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode='40001',message='trial_screenshot_source_changed';
  end if;
  select i.item->'record' into source_record from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id=pointer.run_id and i.source_key=p_command_intent->>'eventId';
  if source_record is null or source_record->>'dated' is distinct from p_command_intent->>'sourceDate'
    or coalesce(source_record->>'time_start','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(source_record->>'time_end','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or source_record->>'time_end'<=source_record->>'time_start' or jsonb_typeof(source_record->'stu_list') is distinct from 'array' or jsonb_array_length(source_record->'stu_list')>100 then
    raise exception using errcode='40001',message='trial_screenshot_source_event_changed';
  end if;
  begin
    source_date:=(p_command_intent->>'sourceDate')::date;
    if to_char(source_date,'YYYY-MM-DD')<>p_command_intent->>'sourceDate' or extract(year from source_date) not between 1900 and 9998
      or source_date<(source_run.query->>'start')::date or source_date>(source_run.query->>'end')::date then
      raise exception using errcode='22023',message='trial_screenshot_source_date_invalid';
    end if;
    source_start:=((source_date::text||' '||(source_record->>'time_start'))::timestamp at time zone 'Australia/Melbourne');
    source_end:=((source_date::text||' '||(source_record->>'time_end'))::timestamp at time zone 'Australia/Melbourne');
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception using errcode='22023',message='trial_screenshot_source_date_invalid';
  end;
  source_teacher:=nullif(btrim(source_record->>'teacher_title'),''); source_course:=nullif(btrim(source_record->>'course_title'),'');
  source_duration:=extract(epoch from source_end-source_start)/60;
  if source_teacher is null or source_end<=source_start then raise exception using errcode='40001',message='trial_screenshot_source_teacher_missing'; end if;
  select value into next_lp from jsonb_array_elements(p_next_lp_items) where value->>'id'=before_lp->>'id';
  before_fields:=coalesce(before_lp->'fields','{}'::jsonb); next_fields:=next_lp->'fields';
  before_intake:=before_lp->'trialIntake'; next_intake:=next_lp->'trialIntake'; schedule:=next_lp->'trialSchedule';
  if next_lp is null or jsonb_typeof(before_fields) is distinct from 'object' or jsonb_typeof(next_fields) is distinct from 'object'
    or (next_lp-'fields'-'trialIntake'-'trialSchedule'-'trialScheduleReview') is distinct from (before_lp-'fields'-'trialIntake'-'trialSchedule'-'trialScheduleReview')
    or (next_fields-'assignedTeacher'-'studentNameKnown'-'studentName'-'trialDurationMinutes') is distinct from (before_fields-'assignedTeacher'-'studentNameKnown'-'studentName'-'trialDurationMinutes')
    or next_fields->>'assignedTeacher' is distinct from source_teacher
    or next_lp->'trialScheduleReview' is distinct from jsonb_build_object('source','screenshot-review','eventId',p_command_intent->>'eventId')
    or jsonb_typeof(schedule) is distinct from 'object'
    or schedule-'source'-'confirmation'-'sourceRevision'-'eventId'-'startsAt'-'endsAt'-'courseName'-'studentName'-'teacherId'-'teacherName'-'plannerHint'-'matchedAt'<>'{}'::jsonb
    or schedule->>'confirmation' is distinct from 'screenshot-review'
    or schedule->>'courseName' is distinct from source_course or schedule->>'teacherName' is distinct from source_teacher
    or schedule->>'startsAt' is distinct from to_char(source_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or schedule->>'endsAt' is distinct from to_char(source_end at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') then
    raise exception using errcode='22023',message='trial_screenshot_projection_invalid';
  end if;
  source_hint:=substring(normalize(coalesce(source_course,''),NFKC) from '^.*[-–—][[:space:]]+(.{1,80}?)[[:space:]]*试听(?:课)?[[:space:]]*$');
  if source_hint is null then source_hint:=substring(normalize(coalesce(source_course,''),NFKC) from '^(.{1,80}?)[[:space:]]*试听(?:课)?[[:space:]]*$'); end if;
  if coalesce(source_hint,'')!~'^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''’ .-]{0,60}[一-鿿]{0,8}$' then source_hint:=null; end if;
  if source_hint is not null and nullif(btrim(target_student->>'name'),'') is not null
    and internal.trial_screenshot_text_key(target_student->>'name')<>internal.trial_screenshot_text_key(target_student->>'guardianWechat')
    and internal.trial_screenshot_text_key(target_student->>'name') !~ '^(试听|视听|trial)'
    and regexp_replace(internal.trial_screenshot_text_key(source_hint),'[[:space:][:punct:]]','','g')<>regexp_replace(internal.trial_screenshot_text_key(target_student->>'name'),'[[:space:][:punct:]]','','g') then
    raise exception using errcode='40001',message='trial_screenshot_student_name_conflict';
  end if;
  if not p_full_admin and not coalesce((
    source_hint is not null and (
      before_fields->'studentNameKnown'='true'::jsonb and regexp_replace(internal.trial_screenshot_text_key(source_hint),'[[:space:][:punct:]]','','g')=regexp_replace(internal.trial_screenshot_text_key(before_fields->>'studentName'),'[[:space:][:punct:]]','','g')
      or internal.trial_screenshot_text_key(target_student->>'name')<>internal.trial_screenshot_text_key(target_student->>'guardianWechat') and regexp_replace(internal.trial_screenshot_text_key(source_hint),'[[:space:][:punct:]]','','g')=regexp_replace(internal.trial_screenshot_text_key(target_student->>'name'),'[[:space:][:punct:]]','','g')
    )
    or nullif(target_student->>'jwbSourceRow','') is not null
      and (select count(*) from jsonb_array_elements(s.payload) st where st->>'jwbSourceRow'=target_student->>'jwbSourceRow' and coalesce(st->>'importArchived','false')<>'true')=1
      and exists(select 1 from jsonb_array_elements(source_record->'stu_list') participant where participant->>'mem_id'=target_student->>'jwbSourceRow'
        and regexp_replace(internal.trial_screenshot_text_key(participant->>'name'),'[[:space:][:punct:]]','','g') !~ '^(试听|视听|trial)')
  ),false) then raise exception using errcode='42501',message='trial_screenshot_source_scope_forbidden'; end if;
  next_name:=next_fields->>'studentName';
  if before_fields->'studentNameKnown'='true'::jsonb then
    if next_fields->'studentNameKnown' is distinct from before_fields->'studentNameKnown' or next_fields->'studentName' is distinct from before_fields->'studentName'
      or source_hint is not null and regexp_replace(internal.trial_screenshot_text_key(source_hint),'[[:space:][:punct:]]','','g')<>regexp_replace(internal.trial_screenshot_text_key(next_name),'[[:space:][:punct:]]','','g') then
      raise exception using errcode='40001',message='trial_screenshot_student_name_conflict';
    end if;
  elsif next_fields->'studentNameKnown' is distinct from before_fields->'studentNameKnown' or next_fields->'studentName' is distinct from before_fields->'studentName' then
    if next_fields->'studentNameKnown' is distinct from 'true'::jsonb or source_hint is null or nullif(btrim(next_name),'') is null
      or regexp_replace(internal.trial_screenshot_text_key(source_hint),'[[:space:][:punct:]]','','g')<>regexp_replace(internal.trial_screenshot_text_key(next_name),'[[:space:][:punct:]]','','g') then
      raise exception using errcode='22023',message='trial_screenshot_name_projection_invalid';
    end if;
  end if;
  if source_duration in (45,60) then
    if next_fields->'trialDurationMinutes' is distinct from to_jsonb(source_duration::integer) then raise exception using errcode='22023',message='trial_screenshot_duration_invalid'; end if;
  elsif next_fields->'trialDurationMinutes' is distinct from before_fields->'trialDurationMinutes' then raise exception using errcode='22023',message='trial_screenshot_duration_invalid'; end if;
  if before_intake is null then
    if next_intake is not null then raise exception using errcode='22023',message='trial_screenshot_intake_invalid'; end if;
  elsif jsonb_typeof(next_intake) is distinct from 'object' or next_intake-'studentName'-'trialDurationMinutes' is distinct from before_intake-'studentName'-'trialDurationMinutes'
    or (case when before_fields->'studentNameKnown' is distinct from 'true'::jsonb and next_fields->'studentNameKnown'='true'::jsonb then next_intake->>'studentName' is distinct from next_name else next_intake->'studentName' is distinct from before_intake->'studentName' end)
    or (case when source_duration in (45,60) then next_intake->'trialDurationMinutes' is distinct from to_jsonb(source_duration::integer) else next_intake->'trialDurationMinutes' is distinct from before_intake->'trialDurationMinutes' end) then
    raise exception using errcode='22023',message='trial_screenshot_intake_invalid';
  end if;
  enriched_lp:=jsonb_set(jsonb_set(before_lp,'{fields}',next_fields),'{trialScheduleReview}',next_lp->'trialScheduleReview');
  if next_intake is not null then enriched_lp:=jsonb_set(enriched_lp,'{trialIntake}',next_intake); end if;
  select jsonb_agg(case when value->>'id'=before_lp->>'id' then enriched_lp else value end order by ordinality) into enriched_items from jsonb_array_elements(l.payload) with ordinality;
  if p_next_lp_items is distinct from (select jsonb_agg(case when value->>'id'=before_lp->>'id' then next_lp else value end order by ordinality) from jsonb_array_elements(l.payload) with ordinality) then
    raise exception using errcode='22023',message='trial_screenshot_other_lp_changed';
  end if;
  fields_changed:=enriched_items is distinct from l.payload;
  if fields_changed then
    update public.ops_state set payload=enriched_items,version=l.version+1,updated_at=now(),updated_by=btrim(p_actor) where entity='lpItems' returning * into l;
    insert into public.ops_mutation_log(entity,version,actor) values('lpItems',l.version,btrim(p_actor));
  end if;
  next_versions:=jsonb_build_object('lpItems',l.version,'tasks',t.version);
  window_value:=jsonb_build_object('startsAt',to_char((source_date::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(((source_date+1)::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  matches:=jsonb_build_array(jsonb_build_object('lpItemId',before_lp->>'id','eventId',p_command_intent->>'eventId','startsAt',schedule->>'startsAt'));
  delegate_intent:=jsonb_build_object('snapshotRevision',pointer.revision,'window',window_value,'matches',matches,'revocations','[]'::jsonb,'expectedVersions',next_versions);
  select * into receipt from public.sync_jiaowubao_trial_matches_atomic_v2(p_secret,p_command_uuid,delegate_intent,pointer.revision,matches,'[]'::jsonb,next_versions,p_next_lp_items,p_next_tasks,p_actor);
  audit_id_value:=internal.append_operational_contract_audit('trial.screenshot.confirm',btrim(p_actor),'lp_item',before_lp->>'id',jsonb_build_object(
    'commandKey',p_command_uuid,'eventId',p_command_intent->>'eventId','sourceRevision',pointer.revision,'sourceDate',p_command_intent->>'sourceDate',
    'studentId',target_student_id,'fieldsBefore',before_fields,'fieldsAfter',next_fields,'intakeBefore',before_intake,'intakeAfter',next_intake,
    'versionsBefore',p_expected_versions,'versionsAfter',jsonb_build_object('students',s.version,'lpItems',(receipt.lp_items_row).version,'tasks',(receipt.tasks_row).version),'scheduleAuditId',receipt.audit_entry_id));
  insert into internal.trial_screenshot_commands(command_key,command_intent,actor,student_id,lp_item_id,audit_id) values(p_command_uuid::uuid,p_command_intent,btrim(p_actor),target_student_id,before_lp->>'id',audit_id_value);
  return query select p_command_uuid,fields_changed or receipt.applied,target_student_id,before_lp->>'id',receipt.lp_items_row,receipt.tasks_row,audit_id_value;
end;
$$;
revoke all on function public.confirm_trial_screenshot_atomic(text,text,jsonb,jsonb,jsonb,jsonb,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.confirm_trial_screenshot_atomic(text,text,jsonb,jsonb,jsonb,jsonb,text,boolean) to anon, authenticated;

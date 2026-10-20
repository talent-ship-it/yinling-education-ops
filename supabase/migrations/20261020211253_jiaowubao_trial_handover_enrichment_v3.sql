create function internal.trial_handover_name_key(p_value text)
returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(normalize(coalesce(p_value,''),NFKC),'[[:space:]]+','','g'))
$$;
revoke all on function internal.trial_handover_name_key(text) from public,anon,authenticated,service_role;

create function internal.trial_handover_trim(p_value text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(p_value,'^[[:space:]]+|[[:space:]]+$','','g')
$$;
revoke all on function internal.trial_handover_trim(text) from public,anon,authenticated,service_role;

create function internal.trial_handover_empty(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p_value is null or p_value='null'::jsonb
    or jsonb_typeof(p_value)='string' and internal.trial_handover_name_key(p_value#>>'{}')=''
$$;
revoke all on function internal.trial_handover_empty(jsonb) from public,anon,authenticated,service_role;

create function internal.trial_handover_account_letter(p_label text)
returns text language plpgsql immutable set search_path = '' as $$
declare label text:=lower(internal.trial_handover_trim(normalize(coalesce(p_label,''),NFKC)));
begin
  if label ~ '^试听学员a\(tara龙\)[[:space:]]*2026$' then return 'a'; end if;
  return substring(regexp_replace(label,'[[:space:][:punct:]]+','','g') from '^(?:[试视]听(?:学[员生]|账号)?|trial(?:student|account)?)([abc])(?:(?:校长号|账号|account)[[:digit:]]*|(?:year)?(?:19|20)[[:digit:]]{2})*$');
end;
$$;
revoke all on function internal.trial_handover_account_letter(text) from public,anon,authenticated,service_role;

create function internal.trial_handover_schedule_metadata_valid(p_schedule jsonb,p_record jsonb,p_start timestamptz,p_end timestamptz)
returns boolean language plpgsql immutable set search_path = '' as $$
declare account_letter text; account_label text; letters integer;
begin
  if jsonb_typeof(p_schedule) is distinct from 'object' or jsonb_typeof(p_record->'stu_list') is distinct from 'array' then return false; end if;
  select count(distinct internal.trial_handover_account_letter(value->>'name')) into letters from jsonb_array_elements(p_record->'stu_list');
  if letters=1 then
    select internal.trial_handover_account_letter(value->>'name'),internal.trial_handover_trim(value->>'name') into account_letter,account_label
    from jsonb_array_elements(p_record->'stu_list') with ordinality
    where internal.trial_handover_account_letter(value->>'name') is not null order by ordinality limit 1;
  end if;
  return (not p_schedule?'durationMinutes' or p_schedule->'durationMinutes'=to_jsonb(extract(epoch from p_end-p_start)/60))
    and (not p_schedule?'sharedAccountLetter' or p_schedule->'sharedAccountLetter'=coalesce(to_jsonb(account_letter),'null'::jsonb))
    and (not p_schedule?'sharedAccountLabel' or p_schedule->'sharedAccountLabel'=coalesce(to_jsonb(account_label),'null'::jsonb));
end;
$$;
revoke all on function internal.trial_handover_schedule_metadata_valid(jsonb,jsonb,timestamptz,timestamptz) from public,anon,authenticated,service_role;

create function internal.trial_handover_enriched_lp(p_lp jsonb,p_record jsonb,p_students jsonb,p_duration numeric)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare fields jsonb; next_fields jsonb; intake jsonb; result jsonb:=p_lp; hint text; identity_id text; identities integer;
begin
  fields:=case when jsonb_typeof(p_lp->'fields')='object' then p_lp->'fields' else '{}'::jsonb end;
  next_fields:=fields;
  if internal.trial_handover_empty(fields->'assignedTeacher') and nullif(internal.trial_handover_trim(p_record->>'teacher_title'),'') is not null then
    next_fields:=next_fields||jsonb_build_object('assignedTeacher',internal.trial_handover_trim(p_record->>'teacher_title'));
  end if;
  if internal.trial_handover_empty(fields->'trialDurationMinutes') and p_duration in (45,60) then
    next_fields:=next_fields||jsonb_build_object('trialDurationMinutes',p_duration::integer);
  end if;
  hint:=substring(normalize(coalesce(p_record->>'course_title',''),NFKC) from '^.*[-–—][[:space:]]+(.{1,80}?)[[:space:]]*试听(?:课)?[[:space:]]*$');
  if hint is null then hint:=substring(normalize(coalesce(p_record->>'course_title',''),NFKC) from '^(.{1,80}?)[[:space:]]*试听(?:课)?[[:space:]]*$'); end if;
  hint:=regexp_replace(internal.trial_handover_trim(hint),'([A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ0-9])[[:space:]]+([一-鿿])','\1\2','g');
  if coalesce(hint,'') !~ '^[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ''’.-]+([[:space:]]+[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ''’.-]+){0,3}[一-鿿]{0,8}$' then hint:=null; end if;
  if hint is not null then
    select count(*),min(value->>'id') into identities,identity_id from jsonb_array_elements(p_students)
    where internal.trial_handover_name_key(value->>'name')=internal.trial_handover_name_key(hint);
    if identities<>1 or identity_id is distinct from p_lp->>'studentId' then hint:=null; end if;
  end if;
  if fields->'studentNameKnown' is distinct from 'true'::jsonb and internal.trial_handover_empty(fields->'studentName') and hint is not null then
    next_fields:=next_fields||jsonb_build_object('studentNameKnown',true,'studentName',hint);
  end if;
  if fields is distinct from next_fields then result:=jsonb_set(result,'{fields}',next_fields); end if;
  if jsonb_typeof(p_lp->'trialIntake')='object' then
    intake:=p_lp->'trialIntake';
    if internal.trial_handover_empty(intake->'studentName') and hint is not null then intake:=intake||jsonb_build_object('studentName',hint); end if;
    if internal.trial_handover_empty(intake->'trialDurationMinutes') and p_duration in (45,60) then intake:=intake||jsonb_build_object('trialDurationMinutes',p_duration::integer); end if;
    result:=jsonb_set(result,'{trialIntake}',intake);
  end if;
  return result;
end;
$$;
revoke all on function internal.trial_handover_enriched_lp(jsonb,jsonb,jsonb,numeric) from public,anon,authenticated,service_role;

create function public.sync_jiaowubao_trial_matches_atomic_v3(
  p_secret text,p_command_uuid text,p_command_intent jsonb,p_snapshot_revision text,
  p_matches jsonb,p_revocations jsonb,p_expected_versions jsonb,p_next_lp_items jsonb,p_next_tasks jsonb,p_actor text
)
returns table(command_key text,applied boolean,snapshot_revision text,lp_item_ids jsonb,student_ids jsonb,
  lp_items_row public.ops_state,tasks_row public.ops_state,audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  s public.ops_state%rowtype; l public.ops_state%rowtype; t public.ops_state%rowtype;
  pointer internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  source_run internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  match jsonb; source_record jsonb; before_lp jsonb; after_lp jsonb; expected_lp jsonb; enriched_lp jsonb;
  enriched_items jsonb; enriched_changes jsonb:='[]'::jsonb; schedule jsonb; source_day date; source_start timestamptz; source_end timestamptz;
  receipt record; final_l public.ops_state%rowtype; enrichment_audit uuid; command_id uuid; item_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if coalesce(p_command_uuid,'')!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_matches) is distinct from 'array' or jsonb_typeof(p_revocations) is distinct from 'array'
    or jsonb_typeof(p_next_lp_items) is distinct from 'array' or jsonb_typeof(p_next_tasks) is distinct from 'array' or jsonb_typeof(p_expected_versions) is distinct from 'object'
    or p_expected_versions-'lpItems'-'tasks'<>'{}'::jsonb or coalesce(p_expected_versions->>'lpItems','')!~'^[1-9][0-9]*$' or coalesce(p_expected_versions->>'tasks','')!~'^[1-9][0-9]*$'
    or jsonb_typeof(p_command_intent) is distinct from 'object' or coalesce(p_snapshot_revision,'')!~'^sha256:[a-f0-9]{64}$'
    or jsonb_array_length(p_matches)+jsonb_array_length(p_revocations) not between 1 and 24 or nullif(btrim(p_actor),'') is null or length(btrim(p_actor))>120 then raise exception using errcode='22023',message='invalid_trial_handover_request'; end if;
  command_id:=p_command_uuid::uuid;
  select * into s from public.ops_state where entity='students' for share;
  select * into l from public.ops_state where entity='lpItems' for update;
  select * into t from public.ops_state where entity='tasks' for update;
  if exists(select 1 from internal.jiaowubao_trial_sync_commands c where c.command_key=command_id) then
    return query select * from public.sync_jiaowubao_trial_matches_atomic_v2(p_secret,p_command_uuid,p_command_intent,p_snapshot_revision,p_matches,p_revocations,p_expected_versions,p_next_lp_items,p_next_tasks,p_actor);
    return;
  end if;
  if l.version is distinct from (p_expected_versions->>'lpItems')::bigint or t.version is distinct from (p_expected_versions->>'tasks')::bigint then raise exception using errcode='40001',message='version_conflict'; end if;
  if jsonb_typeof(s.payload) is distinct from 'array' or jsonb_typeof(l.payload) is distinct from 'array' then raise exception using errcode='55000',message='trial_handover_state_unavailable'; end if;
  select * into pointer from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key='jwb-open-api-schedule' for share;
  select * into source_run from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=pointer.run_id and r.api_source_key=pointer.api_source_key and r.revision=pointer.revision and r.state='complete';
  if pointer.api_source_key is null or pointer.revision is distinct from p_snapshot_revision or pointer.published_at is null or pointer.published_at<clock_timestamp()-interval '2 hours'
    or source_run.id is null or coalesce(source_run.query->>'start','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(source_run.query->>'end','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode='40001',message='trial_handover_source_changed';
  end if;
  enriched_items:=l.payload;
  for match in select value from jsonb_array_elements(p_matches) loop
    select value into before_lp from jsonb_array_elements(l.payload) where value->>'id'=match->>'lpItemId';
    select value into after_lp from jsonb_array_elements(p_next_lp_items) where value->>'id'=match->>'lpItemId';
    if before_lp is null or after_lp is null or before_lp->>'resultStatus'='已取消'
      or not exists(select 1 from jsonb_array_elements(s.payload) student where student->>'id'=before_lp->>'studentId' and coalesce(student->>'importArchived','false')<>'true') then
      raise exception using errcode='P0002',message='trial_handover_lp_not_found';
    end if;
    select count(*),jsonb_agg(i.item->'record')->0 into item_count,source_record from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id=pointer.run_id and i.source_key=match->>'eventId';
    if item_count<>1 or jsonb_typeof(source_record) is distinct from 'object'
      or coalesce(source_record->>'dated','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(source_record->>'time_start','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(source_record->>'time_end','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or source_record->>'time_end'<=source_record->>'time_start' or jsonb_typeof(source_record->'stu_list') is distinct from 'array' or jsonb_array_length(source_record->'stu_list')>100 then
      raise exception using errcode='40001',message='trial_handover_source_event_changed';
    end if;
    begin
      source_day:=(source_record->>'dated')::date;
      if to_char(source_day,'YYYY-MM-DD')<>source_record->>'dated' or extract(year from source_day) not between 1900 and 9998
        or source_day<(source_run.query->>'start')::date or source_day>(source_run.query->>'end')::date then raise exception using errcode='22023',message='trial_handover_source_date_invalid'; end if;
      source_start:=((source_day::text||' '||(source_record->>'time_start'))::timestamp at time zone 'Australia/Melbourne');
      source_end:=((source_day::text||' '||(source_record->>'time_end'))::timestamp at time zone 'Australia/Melbourne');
    exception when datetime_field_overflow or invalid_datetime_format then raise exception using errcode='22023',message='trial_handover_source_date_invalid'; end;
    schedule:=after_lp->'trialSchedule';
    if source_end<=source_start or nullif(internal.trial_handover_trim(source_record->>'teacher_title'),'') is null
      or schedule->>'source' is distinct from 'jiaowubao-open-api' or schedule->>'sourceRevision' is distinct from p_snapshot_revision or schedule->>'eventId' is distinct from match->>'eventId'
      or schedule-'source'-'confirmation'-'sourceRevision'-'eventId'-'startsAt'-'endsAt'-'courseName'-'studentName'-'teacherId'-'teacherName'-'plannerHint'-'matchedAt'-'durationMinutes'-'sharedAccountLabel'-'sharedAccountLetter'<>'{}'::jsonb
      or (schedule->>'startsAt')::timestamptz is distinct from source_start or (schedule->>'endsAt')::timestamptz is distinct from source_end
      or schedule->>'teacherName' is distinct from internal.trial_handover_trim(source_record->>'teacher_title') or schedule->>'courseName' is distinct from nullif(internal.trial_handover_trim(source_record->>'course_title'),'')
      or not internal.trial_handover_schedule_metadata_valid(schedule,source_record,source_start,source_end)
      or (schedule->'confirmation') is distinct from (case when before_lp#>>'{trialScheduleReview,source}'='screenshot-review' and before_lp#>>'{trialScheduleReview,eventId}'=match->>'eventId' then to_jsonb('screenshot-review'::text) else before_lp#>'{trialSchedule,confirmation}' end) then raise exception using errcode='22023',message='trial_handover_source_projection_invalid'; end if;
    expected_lp:=internal.trial_handover_enriched_lp(before_lp,source_record,s.payload,extract(epoch from source_end-source_start)/60);
    if (before_lp-'fields'-'trialIntake'-'trialSchedule') is distinct from (after_lp-'fields'-'trialIntake'-'trialSchedule')
      or after_lp->'fields' is distinct from before_lp->'fields' and after_lp->'fields' is distinct from expected_lp->'fields'
      or after_lp->'trialIntake' is distinct from before_lp->'trialIntake' and after_lp->'trialIntake' is distinct from expected_lp->'trialIntake' then raise exception using errcode='22023',message='trial_handover_fields_projection_invalid'; end if;
    enriched_lp:=before_lp-'fields'-'trialIntake';
    if after_lp?'fields' then enriched_lp:=enriched_lp||jsonb_build_object('fields',after_lp->'fields'); end if;
    if after_lp?'trialIntake' then enriched_lp:=enriched_lp||jsonb_build_object('trialIntake',after_lp->'trialIntake'); end if;
    if enriched_lp is distinct from before_lp then
      select jsonb_agg(case when value->>'id'=before_lp->>'id' then enriched_lp else value end order by ordinality) into enriched_items from jsonb_array_elements(enriched_items) with ordinality;
      enriched_changes:=enriched_changes||jsonb_build_array(jsonb_build_object('lpItemId',before_lp->>'id','fieldsBefore',before_lp->'fields','fieldsAfter',enriched_lp->'fields','intakeBefore',before_lp->'trialIntake','intakeAfter',enriched_lp->'trialIntake'));
    end if;
  end loop;
  if enriched_items is distinct from l.payload then update public.ops_state set payload=enriched_items where entity='lpItems'; end if;
  select * into receipt from public.sync_jiaowubao_trial_matches_atomic_v2(p_secret,p_command_uuid,p_command_intent,p_snapshot_revision,p_matches,p_revocations,p_expected_versions,p_next_lp_items,p_next_tasks,p_actor);
  final_l:=receipt.lp_items_row;
  if jsonb_array_length(enriched_changes)>0 then
    if final_l.version=l.version then
      update public.ops_state set version=l.version+1,updated_at=now(),updated_by=btrim(p_actor) where entity='lpItems' returning * into final_l;
      insert into public.ops_mutation_log(entity,version,actor) values('lpItems',final_l.version,btrim(p_actor));
    end if;
    enrichment_audit:=internal.append_operational_contract_audit('trial.jiaowubao.handover_enrich',btrim(p_actor),'jiaowubao_trial_sync',p_command_uuid,jsonb_build_object(
      'snapshotRevision',p_snapshot_revision,'matches',p_matches,'changes',enriched_changes,'scheduleAuditId',receipt.audit_entry_id,'versionsBefore',p_expected_versions,'versionsAfter',jsonb_build_object('lpItems',final_l.version,'tasks',(receipt.tasks_row).version)));
    update internal.jiaowubao_trial_sync_commands set lp_items_version=final_l.version,applied=true,audit_id=enrichment_audit,
      command_hash=encode(extensions.digest(jsonb_build_object('commandIntent',p_command_intent,'lpItems',p_next_lp_items,'tasks',p_next_tasks)::text,'sha256'),'hex') where internal.jiaowubao_trial_sync_commands.command_key=command_id;
    receipt.applied:=true; receipt.audit_entry_id:=enrichment_audit;
  end if;
  return query select receipt.command_key,receipt.applied,receipt.snapshot_revision,receipt.lp_item_ids,receipt.student_ids,final_l,receipt.tasks_row,receipt.audit_entry_id;
end;
$$;
revoke all on function public.sync_jiaowubao_trial_matches_atomic_v3(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.sync_jiaowubao_trial_matches_atomic_v3(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text) to anon,authenticated;

do $screenshot_metadata$
declare definition text; needle text; replacement text;
begin
  select pg_catalog.pg_get_functiondef('public.confirm_trial_screenshot_atomic(text,text,jsonb,jsonb,jsonb,jsonb,text,boolean)'::regprocedure) into definition;
  needle:=$old$schedule-'source'-'confirmation'-'sourceRevision'-'eventId'-'startsAt'-'endsAt'-'courseName'-'studentName'-'teacherId'-'teacherName'-'plannerHint'-'matchedAt'<>'{}'::jsonb$old$;
  replacement:=$new$schedule-'source'-'confirmation'-'sourceRevision'-'eventId'-'startsAt'-'endsAt'-'courseName'-'studentName'-'teacherId'-'teacherName'-'plannerHint'-'matchedAt'-'durationMinutes'-'sharedAccountLabel'-'sharedAccountLetter'<>'{}'::jsonb
    or not internal.trial_handover_schedule_metadata_valid(schedule,source_record,source_start,source_end)$new$;
  if strpos(definition,needle)=0 then raise exception 'trial_screenshot_metadata_guard_changed'; end if;
  execute replace(definition,needle,replacement);
end;
$screenshot_metadata$;

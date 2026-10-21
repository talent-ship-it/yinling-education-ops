\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-lp-draft-setup.sql
\ir ../../supabase/migrations/20260821220000_jiaowubao_open_api_schedule_snapshot_ingest.sql
\ir ../../supabase/migrations/20261021070512_wecom_handover_schedule_evidence.sql

insert into public.ops_state(entity,payload,version,updated_by) values('teachers','[{"id":"TEA-DRAFT","name":"Grace"}]',1,'fixture');

create function internal.fixture_wecom_schedule_run(p_revision text,p_start text,p_end text,p_completed timestamptz,p_rows jsonb)
returns uuid language plpgsql as $$
declare run uuid; audit uuid; item jsonb; position integer := 0;
begin
  audit := internal.append_operational_contract_audit('fixture.schedule','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(api_source_key,revision,query,
    expected_page_count,expected_row_count,external_manifest_sha256,source_metadata,staged_by,staging_audit_id)
  values('jwb-open-api-schedule',p_revision,jsonb_build_object('start',p_start,'end',p_end,'limit',100,'order','asc'),
    case when jsonb_array_length(p_rows)>0 then 1 else 0 end,jsonb_array_length(p_rows),'sha256:'||repeat('a',64),'{}','fixture',audit) returning id into run;
  if jsonb_array_length(p_rows)>0 then
    insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_pages(run_id,page_index,page_sha256,rows,row_count,content_bytes,audit_id)
    values(run,0,'sha256:'||repeat('b',64),p_rows,jsonb_array_length(p_rows),octet_length(p_rows::text),audit);
    for item in select value from jsonb_array_elements(p_rows) loop
      insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item)
      values(run,0,position,item ->> 'sourceKey',item::text,'sha256:'||repeat('c',64),item);
      position := position+1;
    end loop;
  end if;
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='complete',canonical_rows_sha256='sha256:'||repeat('d',64),
    payload_sha256='sha256:'||repeat('e',64),completed_at=p_completed,completion_audit_id=audit where id=run;
  return run;
end;
$$;
create function internal.fixture_wecom_schedule_record(p_id text,p_date text,p_name text default 'Draft Student')
returns jsonb language sql as $$
  select jsonb_build_object('sourceKey','jwb-open-api:schedule:'||p_id,'record',jsonb_build_object(
    'cal_id',p_id,'dated',p_date,'time_start','15:00','time_end','16:00','teacher_id','SOURCE-GRACE','teacher_title','Grace',
    'course_title','English - '||p_name,'stu_list',jsonb_build_array(jsonb_build_object('mem_id','SYNTHETIC-MEMBER','name',p_name))));
$$;
create function internal.fixture_wecom_schedule_entry(p_input jsonb,p_status text default 'candidate',p_student text default 'STU-DRAFT-1')
returns jsonb language plpgsql as $$
declare source jsonb; event jsonb; name text; checked text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
begin
  select value into source from jsonb_array_elements(p_input -> 'sources') where value ->> 'sourceMessageId'='bot:lp-draft:one';
  select value into event from jsonb_array_elements(p_input -> 'events') where value ->> 'eventId'='jwb-open-api:schedule:live';
  select s ->> 'name' into name from public.ops_state r cross join jsonb_array_elements(r.payload) s where r.entity='students' and s ->> 'id'=p_student;
  return jsonb_build_object('sourceMessageId','bot:lp-draft:one','sourceRevision',source ->> 'sourceRevision',
    'snapshotRevision',p_input ->> 'snapshotRevision','checkedAt',checked,'status',p_status,
    'matchedStudentId',case when p_status='matched' then p_student else null end,
    'candidates',jsonb_build_array(jsonb_build_object('studentId',p_student,'studentName',name,'sourceRunId',event ->> 'sourceRunId',
      'schedule',jsonb_build_object('source','jiaowubao-open-api','sourceRevision',event ->> 'sourceRevision','eventId',event ->> 'eventId',
        'startsAt',event ->> 'startsAt','endsAt',event ->> 'endsAt','courseName',event -> 'courseName','studentName',name,
        'teacherId','TEA-DRAFT','teacherName',coalesce(event ->> 'sourceTeacherLabel',''),'plannerHint',null,'matchedAt',checked,'durationMinutes',60))));
end;
$$;

begin;
do $evidence_runtime$
declare historical uuid; current_run uuid; moved uuid; input jsonb; entry jsonb; result jsonb; old_input jsonb; old_entry jsonb;
  before_state jsonb; before_sources jsonb; before_epoch text; revision text := 'sha256:'||repeat('1',64); audit uuid; source jsonb; hidden jsonb;
begin
  historical := internal.fixture_wecom_schedule_run('sha256:'||repeat('2',64),'2098-12-31','2099-01-05','2099-01-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_schedule_record('cancelled','2099-01-02'),internal.fixture_wecom_schedule_record('moved','2099-01-01'),
      internal.fixture_wecom_schedule_record('history','2098-12-31')));
  moved := internal.fixture_wecom_schedule_run('sha256:'||repeat('3',64),'2099-01-06','2099-01-06','2099-01-02T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_schedule_record('moved','2099-01-06')));
  current_run := internal.fixture_wecom_schedule_run(revision,'2099-01-02','2099-01-03','2099-01-03T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_schedule_record('live','2099-01-02')));
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',current_run,revision,1,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
  begin perform public.read_wecom_handover_schedule_input(null,revision,null); raise exception 'null_secret_input_allowed';
    exception when insufficient_privilege then null; end;
  begin perform public.read_wecom_handover_schedule_input('bad',revision,null); raise exception 'bad_secret_input_allowed';
    exception when insufficient_privilege then null; end;
  begin perform public.save_wecom_handover_schedule_evidence('bad',revision,'1','[]'); raise exception 'bad_secret_save_allowed';
    exception when insufficient_privilege then null; end;
  begin perform public.read_wecom_handover_schedule_evidence('bad',array['bot:lp-draft:one'],'Abby',false); raise exception 'bad_secret_cache_allowed';
    exception when insufficient_privilege then null; end;
  if has_table_privilege('anon','internal.wecom_handover_schedule_evidence','select')
      or has_table_privilege('authenticated','internal.wecom_handover_schedule_epoch','select')
      or has_function_privilege('service_role','public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)','execute')
      or not has_function_privilege('anon','public.read_wecom_handover_schedule_evidence(text,text[],text,boolean)','execute') then
    raise exception 'private_privilege_boundary_failed';
  end if;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  if not exists(select 1 from jsonb_array_elements(input -> 'sources') s where s ->> 'sourceMessageId'='bot:lp-draft:one'
      and (s ->> 'handoverAt')::timestamptz='2099-01-01T00:00:00Z'
      and (s ->> 'handoverAt')::timestamptz is distinct from (s ->> 'createdAt')::timestamptz)
      or jsonb_array_length(input -> 'sources') <> 4 or jsonb_array_length(input -> 'coverage') <> 7
      or jsonb_array_length(input -> 'events') <> 3
      or exists(select 1 from jsonb_array_elements(input -> 'events') e where e ->> 'eventId'='jwb-open-api:schedule:cancelled'
        or (e ->> 'eventId'='jwb-open-api:schedule:moved' and e ->> 'sourceDate'='2099-01-01'))
      or not exists(select 1 from jsonb_array_elements(input -> 'events') e where e ->> 'eventId'='jwb-open-api:schedule:history' and (e ->> 'historical')::boolean)
      or not exists(select 1 from jsonb_array_elements(input -> 'coverage') c where (c ->> 'startsAt')::timestamptz='2099-01-03T00:00:00+11' and not(c ->> 'historical')::boolean)
      or exists(select 1 from jsonb_array_elements(input -> 'coverage') c where (c ->> 'startsAt')::timestamptz='2099-01-07T00:00:00+11') then
    raise exception 'historical_coverage_current_absence_or_reschedule_failed: %',input;
  end if;
  select jsonb_object_agg(entity,to_jsonb(s)) into before_state from public.ops_state s;
  select jsonb_agg(to_jsonb(m) order by message_id) into before_sources from internal.wecom_archive_messages m;
  entry := internal.fixture_wecom_schedule_entry(input);
  result := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
  if result <> '{"checkedCount":1,"matchedCount":0,"candidateCount":1}'::jsonb then raise exception 'candidate_receipt_failed'; end if;
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
  if (select count(*) from internal.wecom_handover_schedule_evidence) <> 1
      or (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) <> before_state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) <> before_sources then
    raise exception 'replay_or_business_immutability_failed';
  end if;
  if jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Abby',false)) <> 1
      or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ella',false) <> '[]'::jsonb then
    raise exception 'owner_scope_failed';
  end if;
  hidden := internal.fixture_wecom_schedule_entry(input,'candidate','STU-OTHER') -> 'candidates' -> 0;
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
    jsonb_build_array(entry || jsonb_build_object('status','ambiguous','candidates',jsonb_build_array(entry -> 'candidates' -> 0,hidden))));
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Abby',false) <> '[]'::jsonb
      or jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) -> 0 -> 'candidates') <> 2 then
    raise exception 'hidden_sibling_became_unique_or_admin_failed';
  end if;
  begin
    perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
      jsonb_build_array(entry,entry || '{"sourceMessageId":"bot:lp-draft:two","sourceRevision":"invalid"}'));
    raise exception 'partial_batch_accepted';
  exception when serialization_failure then null; end;
  if (select evidence ->> 'status' from internal.wecom_handover_schedule_evidence where source_message_id='bot:lp-draft:one') <> 'ambiguous' then
    raise exception 'batch_did_not_rollback';
  end if;
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
    jsonb_build_array(jsonb_set(entry,'{candidates,0,schedule,startsAt}','"2099-01-02T01:00:00Z"'))); raise exception 'forged_time_accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
    jsonb_build_array(jsonb_set(entry,'{candidates,0,sourceRunId}',to_jsonb(historical::text)))); raise exception 'forged_run_accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
    jsonb_build_array(jsonb_set(entry,'{candidates,0,secret}','"unapproved"'))); raise exception 'extra_candidate_key_accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry),'Abby');
    raise exception 'non_admin_save_accepted'; exception when invalid_parameter_value then null; end;
  old_input := input; old_entry := entry;
  update public.ops_state set payload = payload || '[{"id":"STU-NEW","name":"Synthetic Competitor","owner":"Ella"}]'::jsonb,version=version+1 where entity='students';
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]'::jsonb then raise exception 'epoch_cache_not_invalidated'; end if;
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,old_input ->> 'inputRevision',jsonb_build_array(old_entry));
    raise exception 'stale_epoch_save_accepted'; exception when serialization_failure then null; end;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  entry := internal.fixture_wecom_schedule_entry(input,'matched');
  result := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
  if result <> '{"checkedCount":1,"matchedCount":1,"candidateCount":0}'::jsonb then raise exception 'matched_receipt_failed'; end if;
  update internal.wecom_archive_messages set body=body||E'\nSynthetic source edit' where message_id='bot:lp-draft:one';
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
    raise exception 'stale_source_save_accepted'; exception when serialization_failure then null; end;
  entry := internal.fixture_wecom_schedule_entry(input);
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('9',64) where api_source_key='jwb-open-api-schedule';
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
    raise exception 'stale_snapshot_save_accepted'; exception when serialization_failure then null; end;
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('1',64) where api_source_key='jwb-open-api-schedule';
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  source := internal.wecom_lp_draft_source('bot:lp-draft:one');
  insert into internal.wecom_lp_confirmations(source_message_id,case_id,command_uuid,confirmation_intent,student_id,lp_item_id,actor,audit_id)
    values('bot:lp-draft:one',(source ->> 'caseId')::uuid,'10000000-0000-4000-8000-000000000009','{}','STU-DRAFT-1','LP-FIXTURE','Abby',audit);
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]'::jsonb then raise exception 'confirmed_cache_visible'; end if;
  begin perform public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']); raise exception 'confirmed_target_accepted';
    exception when serialization_failure then null; end;
  begin update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item='{}' where run_id=current_run; raise exception 'immutable_event_mutable';
    exception when object_not_in_prerequisite_state then null; end;
end;
$evidence_runtime$;
rollback;

begin;
do $shared_and_fairness$
declare run uuid; revision text := 'sha256:'||repeat('4',64); audit uuid; row jsonb; input jsonb; entry jsonb; batch jsonb;
  epoch text; source jsonb; source_ids text[]; event jsonb; members jsonb;
begin
  row := jsonb_set(internal.fixture_wecom_schedule_record('live','2099-01-02'),'{record,stu_list}',
    '[{"mem_id":"SYNTHETIC-B","name":"试听学员Ｂ"},{"mem_id":"SYNTHETIC-NAME","name":"Draft Student"}]');
  run := internal.fixture_wecom_schedule_run(revision,'2099-01-01','2099-01-31','2099-01-04T00:00:00Z',jsonb_build_array(row));
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',run,revision,1,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
  update public.ops_state set payload='[{"id":"TEA-DRAFT","name":"  ＧＲＡＣＥ  "}]' where entity='teachers';
  update public.ops_state set payload=jsonb_set(payload,'{0,name}','"  Draft Student  "') where entity='students';
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  entry := internal.fixture_wecom_schedule_entry(input);
  entry := jsonb_set(entry,'{candidates,0,schedule}',entry -> 'candidates' -> 0 -> 'schedule'
    || '{"plannerHint":"Eileen","sharedAccountLetter":"b","sharedAccountLabel":"试听学员Ｂ"}');
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
    jsonb_build_array(jsonb_set(entry,'{candidates,0,schedule,plannerHint}','"Tara"'))); raise exception 'forged_shared_planner_accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',
    jsonb_build_array(jsonb_set(entry,'{candidates,0,schedule,sharedAccountLabel}','"试听学员A"'))); raise exception 'forged_shared_label_accepted';
    exception when invalid_parameter_value then null; end;
  if internal.wecom_schedule_account_letter('试听学员A(Tara龙) 2026') <> 'a'
      or internal.wecom_schedule_account_letter('Actual Student A') is not null then raise exception 'shared_account_label_contract_failed'; end if;
  select jsonb_agg(jsonb_build_object('mem_id','SYNTHETIC-'||n,'name','Synthetic '||n)) into members from generate_series(1,102) n;
  event := internal.wecom_schedule_event('jwb-open-api:schedule:truncated',
    (internal.fixture_wecom_schedule_record('truncated','2099-01-02') -> 'record') || jsonb_build_object('stu_list',members),revision,run,false);
  if jsonb_array_length(event -> 'sourceParticipants')<>101 or not(event ->> 'sourceStudentsTruncated')::boolean then
    raise exception 'participant_limit_did_not_fail_closed';
  end if;
  begin perform internal.wecom_schedule_event('jwb-open-api:schedule:bad',
    (internal.fixture_wecom_schedule_record('bad','2099-01-02') -> 'record') || '{"time_start":"bad"}',revision,run,false);
    raise exception 'invalid_event_was_silently_dropped'; exception when invalid_parameter_value then null; end;
  begin perform public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array_fill('bot:lp-draft:one'::text,array[51]));
    raise exception 'target_cap_accepted'; exception when invalid_parameter_value then null; end;
  epoch := input ->> 'inputRevision';
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,match_status,ingested_by)
    values('bot:schedule:unrelated',repeat('f',64),'unrelated-room','fixture-sales',now(),'text','Unrelated synthetic message','other','pending','WeCom Bot Receiver');
  update internal.wecom_archive_messages set updated_at=now()+interval '1 second' where message_id='bot:lp-draft:one';
  update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now()+interval '1 second';
  update public.ops_state set version=version+1 where entity='students';
  if (select e.revision::text from internal.wecom_handover_schedule_epoch e where e.singleton) <> epoch
      or jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true))<>1 then
    raise exception 'unrelated_or_unchanged_input_invalidated_cache';
  end if;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,null);
  select jsonb_agg(jsonb_build_object('sourceMessageId',s ->> 'sourceMessageId','sourceRevision',s ->> 'sourceRevision',
    'snapshotRevision',revision,'checkedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'status','no_match','matchedStudentId',null,'candidates','[]'::jsonb)) into batch
    from jsonb_array_elements(input -> 'sources') s where s ->> 'sourceMessageId' in
      (select jsonb_array_elements_text(input -> 'targetSourceMessageIds'));
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',batch);
  if jsonb_array_length(public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,null) -> 'targetSourceMessageIds') <> 0 then
    raise exception 'current_sources_selected_again';
  end if;
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,
    guardian_wechat_hint,operations_owner_hint,match_status,ingested_by)
    values('bot:schedule:february',repeat('f',64),'schedule-feb-room','fixture-sales','2099-02-01T00:00:00Z','text',
      E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：February Parent','handover','February Parent','Abby','pending','WeCom Bot Receiver');
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,null);
  if input -> 'targetSourceMessageIds' <> '["bot:schedule:february"]'::jsonb then raise exception 'never_checked_month_starved: %',input -> 'targetSourceMessageIds'; end if;
  begin perform public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:schedule:february','bot:lp-draft:one']);
    raise exception 'mixed_month_targets_accepted'; exception when serialization_failure then null; end;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  entry := internal.fixture_wecom_schedule_entry(input,'ambiguous') || '{"candidates":[]}';
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
  update public.ops_state set payload=jsonb_set(payload,'{0,importArchived}','true') where entity='students';
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]' then
    raise exception 'archived_input_not_invalidated';
  end if;
end;
$shared_and_fairness$;
rollback;


begin;
do $nullable_teacher$
declare run uuid; revision text := 'sha256:'||repeat('6',64); audit uuid; input jsonb; entry jsonb;
begin
  run := internal.fixture_wecom_schedule_run(revision,'2099-01-01','2099-01-31','2099-01-04T00:00:00Z',
    jsonb_build_array(jsonb_set(internal.fixture_wecom_schedule_record('live','2099-01-02'),'{record,teacher_title}','null')));
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',run,revision,1,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret',revision,array['bot:lp-draft:one']);
  entry := jsonb_set(internal.fixture_wecom_schedule_entry(input),'{candidates,0,schedule,teacherId}','null');
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',revision,input ->> 'inputRevision',jsonb_build_array(entry));
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) -> 0 -> 'candidates' -> 0 -> 'schedule' ->> 'teacherName' <> '' then
    raise exception 'nullable_source_teacher_contract_failed';
  end if;
end;
$nullable_teacher$;
rollback;

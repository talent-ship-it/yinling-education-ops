\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-algorithm-runtime.sql

create function internal.fixture_wecom_title_entry(p_input jsonb,p_event text default 'title-valid',p_status text default 'candidate')
returns jsonb language plpgsql as $$
declare source jsonb; event jsonb; metadata jsonb; name text; checked text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
begin
  select value into source from jsonb_array_elements(p_input->'sources') where value->>'sourceMessageId'='bot:title-only:one';
  select value into event from jsonb_array_elements(p_input->'events') where value->>'eventId'='jwb-open-api:schedule:'||p_event;
  metadata := internal.wecom_schedule_account_metadata(event->'sourceParticipants');
  name := coalesce(internal.wecom_schedule_title_student_name(event->>'courseName'),'Synthetic Child晓晓');
  return jsonb_build_object('algorithmVersion','2','sourceMessageId','bot:title-only:one','sourceRevision',source->>'sourceRevision',
    'snapshotRevision',p_input->>'snapshotRevision','checkedAt',checked,'status',p_status,'matchedStudentId',null,
    'candidates',jsonb_build_array(jsonb_build_object('studentId',null,'studentName',name,'sourceRunId',event->>'sourceRunId',
      'schedule',jsonb_build_object('source','jiaowubao-open-api','sourceRevision',event->>'sourceRevision','eventId',event->>'eventId',
        'startsAt',event->>'startsAt','endsAt',event->>'endsAt','courseName',event->'courseName','studentName',name,
        'teacherId','TEA-DRAFT','teacherName',event->>'sourceTeacherLabel','plannerHint',metadata->'plannerHint',
        'sharedAccountLetter',metadata->'sharedAccountLetter','sharedAccountLabel',metadata->'sharedAccountLabel',
        'matchedAt',checked,'durationMinutes',60))));
end;
$$;

do $title_parser_and_account_contract$
declare title text; label text; expected text;
begin
  foreach title in array array['English - Synthetic Child 晓晓试听','English — Synthetic Child-晓晓试听课',
      'English – Synthetic Child.晓晓试听','English - Ｓｙｎｔｈｅｔｉｃ Child晓晓试听'] loop
    if internal.wecom_schedule_title_student_name(title) is distinct from 'Synthetic Child晓晓' then
      raise exception 'title_supported_subset_differed';
    end if;
  end loop;
  foreach title in array array['English试听','English - English试听','English - Math Reading试听',
      'English - Student试听','English - Unknown Student试听','English - Pending试听','English - Trial Account B试听',
      'English - Synthetic_Child试听','English - Synthetic😀晓晓试听','English - Émil晓晓试听',
      U&'English - E\0301mil晓晓试听',U&'English - Synthetic\+020000试听'] loop
    if internal.wecom_schedule_title_student_name(title) is not null then
      raise exception 'title_generic_or_unsupported_name_accepted';
    end if;
  end loop;
  foreach label in array array['试听学员Ｂ2026','试听学员B账号1',U&'试听学员B校长号1\FE0F\20E3',
      U&'试听学员B账号20261\FE0F\20E3',U&'TrialAccountBaccount1\FE0F\20E3'] loop
    if internal.wecom_schedule_account_letter(label) is distinct from 'b'
        or internal.wecom_schedule_account_metadata(jsonb_build_array(jsonb_build_object('label',label)))->>'plannerHint' is distinct from 'Eileen' then
      raise exception 'title_keycap_account_not_recognized';
    end if;
  end loop;
  foreach label in array array[U&'试听学员B校长号1\FE0F\20E3other',U&'试听学员B校长号x\FE0F\20E3','English Student B'] loop
    if internal.wecom_schedule_account_letter(label) is not null then
      raise exception 'title_account_invalid_suffix_accepted';
    end if;
  end loop;
  if has_function_privilege('public','internal.wecom_schedule_title_student_name(text)','execute')
      or has_function_privilege('anon','internal.wecom_schedule_title_student_name(text)','execute')
      or has_function_privilege('authenticated','internal.wecom_schedule_title_student_name(text)','execute')
      or has_function_privilege('service_role','internal.wecom_schedule_title_student_name(text)','execute')
      or has_function_privilege('anon','internal.wecom_schedule_account_letter(text)','execute') then
    raise exception 'title_private_helper_exposed';
  end if;
end;
$title_parser_and_account_contract$;

insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,
  guardian_wechat_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by)
values('bot:title-only:one',repeat('a',64),'title-only-room','fixture-sales','2099-01-01T00:00:00Z','text',
  E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Synthetic New Parent\n【教务老师】：Abby',
  'handover','Synthetic New Parent','Abby','Eileen','pending','WeCom Bot Receiver');

do $title_only_schedule_fixtures$
declare rows jsonb := '[]'; row jsonb; kind text; members jsonb;
begin
  foreach kind in array array['title-valid','title-generic','title-placeholder','title-no-delimiter','title-nonshared',
      'title-mixed','title-multiple','title-empty','title-truncated'] loop
    row := jsonb_set(internal.fixture_wecom_schedule_record(kind,'2099-01-02'),'{record,course_title}','"English - Synthetic Child 晓晓试听"');
    members := jsonb_build_array(jsonb_build_object('mem_id','SYNTHETIC-SHARED','name',U&'试听学员B校长号1\FE0F\20E3'));
    if kind='title-generic' then row := jsonb_set(row,'{record,course_title}','"English - English试听"');
    elsif kind='title-placeholder' then row := jsonb_set(row,'{record,course_title}','"English - Unknown Student试听"');
    elsif kind='title-no-delimiter' then row := jsonb_set(row,'{record,course_title}','"Synthetic Child 晓晓试听"');
    elsif kind='title-nonshared' then members := '[{"mem_id":"SYNTHETIC-REAL","name":"Draft Student"}]';
    elsif kind='title-mixed' then members := members || '[{"mem_id":"SYNTHETIC-REAL","name":"Draft Student"}]';
    elsif kind='title-multiple' then members := members || '[{"mem_id":"SYNTHETIC-SHARED-C","name":"试听学员C"}]';
    elsif kind='title-empty' then members := '[]';
    elsif kind='title-truncated' then
      select jsonb_agg(jsonb_build_object('mem_id','SYNTHETIC-SHARED-'||n,'name',U&'试听学员B校长号1\FE0F\20E3')) into members from generate_series(1,101) n;
    end if;
    rows := rows || jsonb_build_array(jsonb_set(row,'{record,stu_list}',members));
  end loop;
  rows := rows || jsonb_build_array(jsonb_set(internal.fixture_wecom_schedule_record('live','2099-01-02'),'{record,course_title}','"English - Draft Student试听"'));
  perform internal.fixture_wecom_schedule_run('title-only-history','2099-01-01','2099-01-31','2099-02-01T00:00:00Z',rows);
end;
$title_only_schedule_fixtures$;

do $title_only_save_visibility_and_no_identity_writes$
declare input jsonb; entry jsonb; native_entry jsonb; receipt jsonb; visible jsonb; bad jsonb; kind text;
  before_state jsonb; before_sources jsonb; before_cases jsonb; before_confirmations jsonb; before_evidence jsonb;
begin
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
  entry := internal.fixture_wecom_title_entry(input);
  if entry->'candidates'->0->'studentId' <> 'null'::jsonb
      or entry->'candidates'->0->'schedule'->>'plannerHint' <> 'Eileen'
      or not exists(select 1 from jsonb_array_elements(input->'events') e
        where e->>'eventId'='jwb-open-api:schedule:title-valid' and (e->>'historical')::boolean) then
    raise exception 'title_candidate_fixture_missing_historical_shared_metadata';
  end if;
  select jsonb_object_agg(entity,to_jsonb(s)) into before_state from public.ops_state s;
  select jsonb_agg(to_jsonb(m) order by message_id) into before_sources from internal.wecom_archive_messages m;
  select jsonb_agg(to_jsonb(c) order by id) into before_cases from internal.wecom_trial_handover_cases c;
  select jsonb_agg(to_jsonb(c) order by source_message_id) into before_confirmations from internal.wecom_lp_confirmations c;
  receipt := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  visible := public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true);
  if receipt <> '{"checkedCount":1,"matchedCount":0,"candidateCount":1}'::jsonb or visible <> jsonb_build_array(entry)
      or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Abby',false) <> '[]'
      or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ella',false) <> '[]' then
    raise exception 'title_candidate_save_or_fulladmin_visibility_failed';
  end if;
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if (select count(*) from internal.wecom_handover_schedule_evidence where source_message_id='bot:title-only:one') <> 1 then
    raise exception 'title_idempotence_created_records';
  end if;
  select jsonb_agg(to_jsonb(e) order by source_message_id) into before_evidence from internal.wecom_handover_schedule_evidence e;
  foreach kind in array array['title-generic','title-placeholder','title-no-delimiter','title-nonshared','title-mixed','title-multiple','title-empty','title-truncated',
      'forged-name','forged-schedule-name','forged-letter','forged-planner','matched','no_match','empty-id','unknown-id','forged-run','forged-time'] loop
    bad := case when kind like 'title-%' then internal.fixture_wecom_title_entry(input,kind) else entry end;
    if kind='forged-name' then bad := jsonb_set(jsonb_set(bad,'{candidates,0,studentName}','"Forged Name"'),'{candidates,0,schedule,studentName}','"Forged Name"');
    elsif kind='forged-schedule-name' then bad := jsonb_set(bad,'{candidates,0,schedule,studentName}','"Forged Name"');
    elsif kind='forged-letter' then bad := jsonb_set(bad,'{candidates,0,schedule,sharedAccountLetter}','"a"');
    elsif kind='forged-planner' then bad := jsonb_set(bad,'{candidates,0,schedule,plannerHint}','"Tara"');
    elsif kind='matched' then bad := jsonb_set(jsonb_set(bad,'{status}','"matched"'),'{matchedStudentId}','"STU-DRAFT-1"');
    elsif kind='no_match' then bad := jsonb_set(bad,'{status}','"no_match"');
    elsif kind='empty-id' then bad := jsonb_set(bad,'{candidates,0,studentId}','""');
    elsif kind='unknown-id' then bad := jsonb_set(bad,'{candidates,0,studentId}','"STU-DOES-NOT-EXIST"');
    elsif kind='forged-run' then bad := jsonb_set(bad,'{candidates,0,sourceRunId}','"10000000-0000-4000-8000-000000000009"');
    elsif kind='forged-time' then bad := jsonb_set(bad,'{candidates,0,schedule,startsAt}','"2099-01-02T05:30:00Z"');
    end if;
    begin
      perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry,bad));
      raise exception 'title_invalid_candidate_accepted_%',kind;
    exception when invalid_parameter_value then null; end;
    if (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) is distinct from before_evidence then
      raise exception 'title_invalid_candidate_partially_saved_%',kind;
    end if;
  end loop;
  native_entry := internal.fixture_wecom_schedule_entry(input,'matched') || '{"algorithmVersion":"2"}';
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(native_entry));
  if jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Abby',false)) <> 1 then
    raise exception 'title_native_candidate_branch_changed';
  end if;
  entry := jsonb_set(entry,'{status}','"ambiguous"') || jsonb_build_object('candidates',(entry->'candidates')||(native_entry->'candidates'));
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true)) <> 1
      or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Abby',false) <> '[]' then
    raise exception 'title_mixed_candidates_leaked_partial_evidence';
  end if;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_sources
      or (select jsonb_agg(to_jsonb(c) order by id) from internal.wecom_trial_handover_cases c) is distinct from before_cases
      or (select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c) is distinct from before_confirmations then
    raise exception 'title_candidate_modified_business_identity';
  end if;
end;
$title_only_save_visibility_and_no_identity_writes$;

select 'wecom_handover_schedule_title_runtime_ok' as result;

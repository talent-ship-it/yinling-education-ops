\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-lp-draft-setup.sql

begin;
do $draft_runtime$
declare page jsonb; source jsonb; source_two jsonb; fields jsonb := internal.fixture_wecom_lp_fields();
  versions jsonb := internal.fixture_wecom_lp_versions(); receipt record; replay record; created record;
  state_before jsonb; audit_before bigint; case_value uuid; new_source jsonb; new_fields jsonb;
  new_student jsonb; caught_state text; caught_message text;
begin
  page := public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false,null,1);
  if page ->> 'total' <> '3' or jsonb_array_length(page -> 'rows') <> 1 or page ->> 'nextCursor' is null then
    raise exception 'draft_page_scope_or_keyset_failed: %', page;
  end if;
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:lp-draft:one','Abby',false);
  source_two := public.read_wecom_lp_draft('wecom-fixture-secret','bot:lp-draft:two','Abby',false);
  if source ->> 'studentName' <> 'Draft Student' or jsonb_array_length(source -> 'messages') <> 2
     or source_two ->> 'studentName' <> 'Draft Student' or jsonb_array_length(source_two -> 'messages') <> 1
     or source -> 'messages' -> 1 ->> 'messageId' <> 'bot:lp-draft:identity'
     or source ->> 'sourceRevision' !~ '^[a-f0-9]{64}$' then
    raise exception 'draft_source_temporal_boundary_failed';
  end if;
  if public.read_wecom_lp_draft('wecom-fixture-secret','bot:lp-draft:identity','Abby',false) is not null then
    raise exception 'identity_only_message_became_draft';
  end if;
  begin
    perform public.read_wecom_lp_draft('wecom-fixture-secret','bot:lp-draft:other','Abby',false);
    raise exception 'draft_cross_owner_read_allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.read_wecom_lp_drafts('wrong','Abby',true);
    raise exception 'draft_bad_secret_allowed';
  exception when insufficient_privilege then null; end;
  if jsonb_array_length((public.read_wecom_lp_drafts('wecom-fixture-secret','Nixon',true))->'rows') <> 4 then
    raise exception 'draft_full_admin_read_failed';
  end if;
  case_value := (source ->> 'caseId')::uuid;
  select jsonb_object_agg(entity, jsonb_build_object('payload',payload,'version',version)) into state_before from public.ops_state;
  select count(*) into audit_before from internal.operational_contract_audit;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',repeat('f',64),
      '10000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,fields,
      '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
    raise exception 'stale_source_revision_allowed';
  exception when serialization_failure then
    get stacked diagnostics caught_message = message_text;
    if caught_message <> 'wecom_lp_source_changed' then raise; end if;
  end;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000001','STU-OTHER',null,fields,
      '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
    raise exception 'cross_owner_student_allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,fields,
      '{"owner":"Ella","planner":"Tara","mayReassign":true}',versions,'Abby',false);
    raise exception 'assignment_escalation_allowed';
  exception when insufficient_privilege then null; end;
  update internal.wecom_trial_handover_cases set status='identity_conflict' where id=case_value;
  source := internal.wecom_lp_draft_source('bot:lp-draft:one');
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,fields,
      '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
    raise exception 'identity_conflict_allowed';
  exception when unique_violation then
    get stacked diagnostics caught_message = message_text;
    if caught_message <> 'wecom_lp_identity_conflict' then raise; end if;
  end;
  update internal.wecom_trial_handover_cases set status='identified' where id=case_value;
  source := internal.wecom_lp_draft_source('bot:lp-draft:one');
  if (select jsonb_object_agg(entity, jsonb_build_object('payload',payload,'version',version)) from public.ops_state) <> state_before
     or (select count(*) from internal.operational_contract_audit) <> audit_before then
    raise exception 'rejected_draft_changed_business_state';
  end if;
  select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,fields,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
  if not receipt.applied or receipt.student_id <> 'STU-DRAFT-1'
     or (select count(*) from internal.wecom_lp_confirmations) <> 1
     or jsonb_array_length((receipt.lp_items_row).payload) <> 1 then
    raise exception 'draft_confirmation_failed';
  end if;
  if exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task
    where task ->> 'anchorBookingId'=receipt.lp_item_id and task ->> 'status'='done')
     or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task
       where task ->> 'anchorBookingId'=receipt.lp_item_id and task ->> 'ruleKey'='trial.scheduling') then
    raise exception 'draft_falsely_completed_scheduling';
  end if;
  select jsonb_object_agg(entity, version) into state_before from public.ops_state;
  select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,fields,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
  if replay.applied or replay.lp_item_id <> receipt.lp_item_id or replay.audit_entry_id <> receipt.audit_entry_id then
    raise exception 'same_command_retry_failed';
  end if;
  select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000002','STU-DRAFT-1',null,fields,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
  if replay.applied or replay.lp_item_id <> receipt.lp_item_id
     or (select jsonb_object_agg(entity, version) from public.ops_state) <> state_before then
    raise exception 'different_command_source_retry_duplicated_lp';
  end if;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:one',source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000002','STU-DRAFT-1',null,fields || '{"assignedTeacher":"Different"}'::jsonb,
      '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false);
    raise exception 'confirmed_source_conflict_allowed';
  exception when unique_violation then null; end;
  if (public.read_wecom_lp_draft('wecom-fixture-secret','bot:lp-draft:one','Abby',false))->'confirmed'->>'lpItemId' <> receipt.lp_item_id
     or (public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false))->>'total' <> '2' then
    raise exception 'confirmed_draft_read_contract_failed';
  end if;
  source_two := internal.wecom_lp_draft_source('bot:lp-draft:two');
  select * into created from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value,'bot:lp-draft:two',source_two ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000003','STU-DRAFT-1',null,fields || '{"subject":"Maths","assignedTeacher":"Tynan"}'::jsonb,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',internal.fixture_wecom_lp_versions(),'Abby',false);
  if not created.applied or created.lp_item_id = receipt.lp_item_id or jsonb_array_length((created.lp_items_row).payload) <> 2 then
    raise exception 'second_trial_same_guardian_blocked';
  end if;
  new_source := internal.wecom_lp_draft_source('bot:lp-draft:new');
  new_fields := internal.fixture_wecom_lp_fields('New Draft Student') || '{"planner":"Abby"}'::jsonb;
  new_student := '{"name":"New Draft Student","course":"English","segment":"试听","lpNeed":"试听LP","owner":"Abby","planner":"Abby","grade":"待确认","location":"VIC","timezone":"Australia/Melbourne","guardianWechat":"New Draft Parent","notes":"无特殊备注"}';
  versions := internal.fixture_wecom_lp_versions();
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(new_source->>'caseId')::uuid,'bot:lp-draft:new',new_source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000004',null,new_student,new_fields - 'trialDurationMinutes',
      '{"owner":"Abby","planner":"Abby","mayReassign":false}',versions,'Abby',false);
    raise exception 'invalid_lp_after_student_creation_allowed';
  exception when invalid_parameter_value then null; end;
  if (select count(*) from internal.student_creation_commands) <> 0
     or internal.fixture_wecom_lp_versions() <> versions
     or exists (select 1 from jsonb_array_elements((select payload from public.ops_state where entity='students')) student
       where student ->> 'name'='New Draft Student') then
    raise exception 'new_student_survived_rejected_lp';
  end if;
  select * into created from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(new_source->>'caseId')::uuid,'bot:lp-draft:new',new_source ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000004',null,new_student,new_fields,
    '{"owner":"Abby","planner":"Abby","mayReassign":false}',versions,'Abby',false);
  if not created.applied or (select count(*) from internal.student_creation_commands) <> 1
     or not exists (select 1 from jsonb_array_elements((created.students_row).payload) student
       where student ->> 'id'=created.student_id and student ->> 'name'='New Draft Student'
         and student ->> 'planner'='Abby' and student ->> 'timezone'='Australia/Melbourne') then
    raise exception 'new_named_student_atomic_trial_failed';
  end if;
  select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(new_source->>'caseId')::uuid,'bot:lp-draft:new',new_source ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000005',null,new_student,new_fields,
    '{"owner":"Abby","planner":"Abby","mayReassign":false}',versions,'Abby',false);
  if replay.applied or replay.student_id <> created.student_id or replay.lp_item_id <> created.lp_item_id then
    raise exception 'new_student_retry_created_duplicate';
  end if;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, student_name_hint, guardian_wechat_hint,
    operations_owner_hint, course_planner_hint, match_status, ingested_by)
  select 'bot:lp-draft:new-again', repeat('a',64), chat_id, sender_id, sent_at + interval '1 day',
    message_type, body, classification, student_name_hint, guardian_wechat_hint,
    operations_owner_hint, course_planner_hint, match_status, ingested_by
  from internal.wecom_archive_messages where message_id='bot:lp-draft:new';
  new_source := internal.wecom_lp_draft_source('bot:lp-draft:new-again');
  versions := internal.fixture_wecom_lp_versions();
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(new_source->>'caseId')::uuid,'bot:lp-draft:new-again',new_source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000006',null,new_student,new_fields,
      '{"owner":"Abby","planner":"Abby","mayReassign":false}',versions,'Abby',false);
    raise exception 'second_source_created_duplicate_student';
  exception when unique_violation then
    get stacked diagnostics caught_message = message_text;
    if caught_message <> 'wecom_lp_student_already_exists' then raise; end if;
  end;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(new_source->>'caseId')::uuid,'bot:lp-draft:new-again',new_source ->> 'sourceRevision',
      '10000000-0000-4000-8000-000000000006',null,new_student || '{"name":"New Draft Parent"}'::jsonb,
      new_fields || '{"studentNameKnown":false,"studentName":""}'::jsonb,
      '{"owner":"Abby","planner":"Abby","mayReassign":false}',versions,'Abby',false);
    raise exception 'unnamed_source_bypassed_existing_guardian';
  exception when unique_violation then
    get stacked diagnostics caught_message = message_text;
    if caught_message <> 'wecom_lp_student_already_exists' then raise; end if;
  end;
  if internal.fixture_wecom_lp_versions() <> versions then
    raise exception 'duplicate_student_rejection_changed_state';
  end if;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, guardian_wechat_hint,
    operations_owner_hint, course_planner_hint, match_status, ingested_by)
  values('bot:lp-draft:unnamed',repeat('f',64),'draft-unnamed-room','fixture-sales','2099-01-05T00:00:00Z',
    'text',E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Unnamed Draft Parent','handover',
    'Unnamed Draft Parent','Abby','Tara','pending','WeCom Bot Receiver');
  new_source := internal.wecom_lp_draft_source('bot:lp-draft:unnamed');
  select * into created from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(new_source->>'caseId')::uuid,'bot:lp-draft:unnamed',new_source ->> 'sourceRevision',
    '10000000-0000-4000-8000-000000000007',null,
    new_student || '{"name":"Unnamed Draft Parent","guardianWechat":"Unnamed Draft Parent","planner":"Tara"}'::jsonb,
    fields || '{"studentNameKnown":false,"studentName":""}'::jsonb,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',internal.fixture_wecom_lp_versions(),'Abby',false);
  if not created.applied or not exists (select 1 from jsonb_array_elements((created.students_row).payload) student
    where student->>'id'=created.student_id and student->>'name'='Unnamed Draft Parent') then
    raise exception 'unnamed_guardian_placeholder_trial_failed';
  end if;
  if has_table_privilege('anon','internal.wecom_lp_confirmations','select')
     or has_function_privilege('anon','internal.wecom_lp_draft_source(text)','execute')
     or has_function_privilege('service_role','public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean)','execute') then
    raise exception 'draft_private_table_or_function_exposed';
  end if;
end;
$draft_runtime$;
select 'wecom_lp_draft_runtime_ok' as result;
rollback;

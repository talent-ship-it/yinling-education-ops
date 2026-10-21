\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
do $business_handover$
declare source jsonb; fields jsonb; receipt record; replay record; legacy record;
  before_versions jsonb; assignment jsonb := '{"owner":"Abby","planner":"Tara","mayReassign":false}';
  common jsonb := '{"responsibleOperations":"Abby","specifiedContentStatus":"无需指定","preparationFollowUp":"是","isUniversityStudent":false,"requestSentAt":"2099-01-03T00:00:00.000Z"}';
  item jsonb; kind text; message_id_value text; command_value text; caught text; lp_count int;
begin
  if internal.wecom_lp_draft_source('bot:business:historical') is null then raise exception 'historical_business_source_not_backfilled'; end if;
  select * into legacy from internal.fixture_legacy_wecom_confirmation;
  source := internal.wecom_lp_draft_source('bot:lp-draft:one');
  select * into replay from public.confirm_wecom_lp_draft_atomic(
    'wecom-fixture-secret',(source->>'caseId')::uuid,'bot:lp-draft:one',
    (select confirmation_intent->>'sourceRevision' from internal.wecom_lp_confirmations where source_message_id='bot:lp-draft:one'),
    legacy.command_key,'STU-DRAFT-1',null,internal.fixture_wecom_lp_fields(),assignment,
    internal.fixture_wecom_lp_versions(),'Abby',false
  );
  if replay.applied or replay.lp_item_id <> legacy.lp_item_id or replay.audit_entry_id <> legacy.audit_entry_id then
    raise exception 'legacy_confirmation_default_type_replay_failed';
  end if;
  begin
    perform public.confirm_wecom_lp_draft_atomic(
      'wecom-fixture-secret',(source->>'caseId')::uuid,'bot:lp-draft:one',
      (select confirmation_intent->>'sourceRevision' from internal.wecom_lp_confirmations where source_message_id='bot:lp-draft:one'),
      legacy.command_key,'STU-DRAFT-1',null,internal.fixture_wecom_lp_fields(),assignment,
      internal.fixture_wecom_lp_versions(),'Abby',false,'老师新 LP'
    );
    raise exception 'legacy_confirmation_changed_type_allowed';
  exception when unique_violation then null; end;

  if not internal.wecom_is_lp_template(E'[Rose]二次试听 信息交接[Rose]\n学生：Draft Student\n安排教师：Tynan\n二次试听原因 + 注意事项：换教学方式')
     or not internal.wecom_is_lp_template(E'[Rose]老生LP修改 信息交接[Rose]\n学生姓名：Draft Student\n涉及科目：English\n变动内容：增加写作')
     or internal.wecom_is_lp_template(E'二次试听要不要换老师？\n学生：Draft Student') then
    raise exception 'document_template_shape_classification_failed';
  end if;
  if internal.wecom_lp_template_type(E'老生新 LP 信息交接\n备注：老生LP修改 信息交接') <> '老师新 LP'
     or internal.wecom_lp_template_type(E'备注：老生新LP 信息交接\n安排教师：Grace\n安排科目：English') <> '试听 LP'
     or internal.wecom_lp_template_type(E'[Rose]老生加课ｌｐ 信息交接表[Rose]') <> '老师新 LP'
     or internal.wecom_lp_template_type(E'【LP类型】：二次试听') <> '换老师试听'
     or internal.wecom_lp_template_type(E'业务类型：老师LP修改') <> '老师 LP 修改'
     or internal.wecom_lp_template_type(E'老生新LP 信息交接\n老师LP修改 信息交接') is not null then
    raise exception 'explicit_business_type_anchor_alias_or_conflict_failed';
  end if;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, match_status, ingested_by)
  values
    ('bot:business:new',repeat('c',64),'business-new','sales','2099-01-03T00:00:00Z','text',
      E'[Rose]老生新LP 信息交接[Rose]\n学生姓名：Draft Student\n安排教师：Grace\n安排科目：English',
      'handover','pending','WeCom Bot Receiver'),
    ('bot:business:repeat',repeat('d',64),'business-repeat','sales','2099-01-03T00:00:00Z','text',
      E'[Rose]二次试听 信息交接[Rose]\n学生：Draft Student\n安排教师：Tynan\n二次试听原因 + 注意事项：换教学方式',
      'handover','pending','WeCom Bot Receiver'),
    ('bot:business:modify',repeat('e',64),'business-modify','sales','2099-01-03T00:00:00Z','text',
      E'[Rose]老生LP修改 信息交接[Rose]\n学生姓名：Draft Student\n涉及科目：English\n变动内容：增加写作',
      'handover','pending','WeCom Bot Receiver');
  if exists (select 1 from internal.wecom_archive_messages where message_id like 'bot:business:%'
      and (trial_handover_id is null or guardian_wechat_hint <> 'Draft Parent' or operations_owner_hint <> 'Abby')) then
    raise exception 'unique_student_business_source_without_wechat_not_eligible';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2099-01-03','2099-01-04'))->>'total' <> '3' then
    raise exception 'business_sources_missing_from_range_reader';
  end if;

  source := internal.wecom_lp_draft_source('bot:business:new');
  before_versions := internal.fixture_wecom_lp_versions();
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      'bot:business:new',source->>'sourceRevision','20000000-0000-4000-8000-000000000020',
      'STU-DRAFT-1',null,common||'{"subject":"English","modificationRequirements":"valid different-type fields"}'::jsonb,
      assignment,before_versions,'Abby',false,'老师 LP 修改');
    raise exception 'forged_business_source_type_allowed';
  exception when invalid_parameter_value then
    get stacked diagnostics caught = message_text;
    if caught <> 'wecom_lp_source_workflow_mismatch' then raise; end if;
  end;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, student_name_hint, guardian_wechat_hint,
    operations_owner_hint, course_planner_hint, match_status, ingested_by)
  values('bot:business:mixed',repeat('b',64),'business-mixed','sales','2099-01-05','text',
    E'老生新LP 信息交接\n老师LP修改 信息交接\n学生姓名：Draft Student\n安排教师：Grace\n安排科目：English',
    'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver');
  source := internal.wecom_lp_draft_source('bot:business:mixed');
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      'bot:business:mixed',source->>'sourceRevision','20000000-0000-4000-8000-000000000021',
      'STU-DRAFT-1',null,common||'{"teacher":"Grace","subject":"English","writingRequired":false,"paperRequired":false}'::jsonb,
      assignment,before_versions,'Abby',false,'老师新 LP');
    raise exception 'conflicting_business_source_headings_allowed';
  exception when invalid_parameter_value then
    get stacked diagnostics caught = message_text;
    if caught <> 'wecom_lp_source_workflow_mismatch' then raise; end if;
  end;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, student_name_hint, guardian_wechat_hint,
    operations_owner_hint, course_planner_hint, match_status, ingested_by)
  values('bot:business:followup','bb'||repeat('b',62),'business-followup','sales','2099-01-05','text',
    E'老生新LP 信息交接\n学生姓名：Draft Student\n安排教师：Grace\n安排科目：English',
    'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:business:followup-type','bb'||repeat('c',62),'business-followup','sales','2099-01-05T01:00:00Z','text',
    E'业务类型：二次试听\n学生姓名：Draft Student',
    'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver');
  source := internal.wecom_lp_draft_source('bot:business:followup');
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      'bot:business:followup',source->>'sourceRevision','20000000-0000-4000-8000-000000000022',
      'STU-DRAFT-1',null,common||'{"teacher":"Grace","subject":"English","writingRequired":false,"paperRequired":false}'::jsonb,
      assignment,before_versions,'Abby',false,'老师新 LP');
    raise exception 'conflicting_business_followup_type_allowed';
  exception when invalid_parameter_value then
    get stacked diagnostics caught = message_text;
    if caught <> 'wecom_lp_source_workflow_mismatch' then raise; end if;
  end;
  if internal.fixture_wecom_lp_versions() <> before_versions then raise exception 'rejected_business_source_type_changed_state'; end if;

  for kind,message_id_value,command_value,fields in select * from (values
    ('老师新 LP','bot:business:new','20000000-0000-4000-8000-000000000001',common||'{"teacher":"Grace","subject":"English","writingRequired":true,"paperRequired":true}'::jsonb),
    ('换老师试听','bot:business:repeat','20000000-0000-4000-8000-000000000002',common||'{"newTeacher":"Tynan","subject":"English","changeReason":"换教学方式"}'::jsonb),
    ('老师 LP 修改','bot:business:modify','20000000-0000-4000-8000-000000000003',common||'{"subject":"English","modificationRequirements":"增加写作"}'::jsonb)
  ) cases(kind,message_id_value,command_value,fields) loop
    source := public.read_wecom_lp_draft('wecom-fixture-secret',message_id_value,'Abby',false);
    if source is null then raise exception 'business_draft_not_readable: %',kind; end if;
    before_versions := internal.fixture_wecom_lp_versions();
    if kind = '老师新 LP' then
      begin
        perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
          message_id_value,source->>'sourceRevision',command_value,'STU-DRAFT-1',null,fields-'writingRequired',assignment,
          before_versions,'Abby',false,kind);
        raise exception 'missing_material_flag_allowed';
      exception when invalid_parameter_value then null; end;
    end if;
    begin
      perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
        message_id_value,source->>'sourceRevision',command_value,null,'{}',fields,assignment,
        before_versions,'Abby',false,kind);
      raise exception 'business_type_created_new_student: %',kind;
    exception when invalid_parameter_value then null; end;
    begin
      perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
        message_id_value,source->>'sourceRevision',command_value,'STU-DRAFT-1',null,fields-'requestSentAt',assignment,
        before_versions,'Abby',false,kind);
      raise exception 'business_request_time_missing_allowed: %',kind;
    exception when invalid_parameter_value then null; end;
    begin
      perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
        message_id_value,source->>'sourceRevision',command_value,'STU-DRAFT-1',null,fields,assignment,
        before_versions,'Ella',false,kind);
      raise exception 'business_owner_scope_allowed: %',kind;
    exception when insufficient_privilege then null; end;
    if internal.fixture_wecom_lp_versions() <> before_versions then raise exception 'rejected_business_changed_state'; end if;
    select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      message_id_value,source->>'sourceRevision',command_value,'STU-DRAFT-1',null,fields,assignment,
      before_versions,'Abby',false,kind);
    select value into item from jsonb_array_elements((receipt.lp_items_row).payload) where value->>'id'=receipt.lp_item_id;
    if not receipt.applied or item->>'workflowType' <> kind or item->'fields' <> fields then
      raise exception 'business_type_not_persisted: %',kind;
    end if;
    if item ->> 'requestedAt' <> '2099-01-03T00:00:00.000Z' then raise exception 'business_request_clock_not_preserved'; end if;
    if kind = '老师新 LP' and (
      not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='lp.scheduling' and task->>'dueAt'='2099-01-05T00:00:00.000Z')
      or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='lp.writing')
      or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='lp.paper-send')
      or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='lp.paper-receive' and task->>'dueAt'='2099-01-04T00:00:00.000Z')
    ) then raise exception 'old_student_lp_full_intake_or_n_plus_two_missing'; end if;
    if kind = '换老师试听' and (
      not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='trial.scheduling' and task->>'dueAt'='2099-01-04T00:00:00.000Z')
      or exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey' in ('lp.writing','lp.paper-send','trial.parent-no-reply-follow-up','trial.teaching-control-escalation'))
    ) then raise exception 'repeat_trial_generated_initial_trial_intake'; end if;
    if kind = '老师 LP 修改' and (
      not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='lp.handover' and task->>'dueAt'='2099-01-03T00:00:00.000Z')
      or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey'='lp.modification-review' and task->>'dueAt'='2099-01-10T00:00:00.000Z')
      or exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) task where task->>'anchorBookingId'=receipt.lp_item_id and task->>'ruleKey' in ('lp.preparation-follow-up','lp.specified-content'))
    ) then raise exception 'lp_modification_immediate_or_weekly_review_missing'; end if;
    before_versions := internal.fixture_wecom_lp_versions();
    select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      message_id_value,source->>'sourceRevision',command_value,'STU-DRAFT-1',null,fields,assignment,
      before_versions,'Abby',false,kind);
    if replay.applied or replay.lp_item_id <> receipt.lp_item_id or internal.fixture_wecom_lp_versions() <> before_versions then
      raise exception 'business_retry_not_idempotent: %',kind;
    end if;
    begin
      perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
        message_id_value,source->>'sourceRevision',command_value,'STU-DRAFT-1',null,fields,assignment,
        before_versions,'Abby',false,'试听 LP');
      raise exception 'business_type_replay_changed_kind: %',kind;
    exception when unique_violation then null; end;
  end loop;

  update public.ops_state set payload=payload||'[{"id":"STU-DUPLICATE","name":"Draft Student","guardianWechat":"Different Parent","owner":"Abby","planner":"Tara"}]'::jsonb
  where entity='students';
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, student_name_hint, match_status, ingested_by)
  values('bot:business:ambiguous',repeat('f',64),'business-ambiguous','sales','2099-01-04','text',
    E'老生LP修改 信息交接\n学生姓名：Draft Student\n涉及科目：English\n变动内容：修改教学目标',
    'handover','Draft Student','ambiguous','WeCom Bot Receiver');
  if exists (select 1 from internal.wecom_archive_messages where message_id='bot:business:ambiguous'
     and (guardian_wechat_hint is not null or trial_handover_id is not null)) then
    raise exception 'ambiguous_business_identity_auto_bound';
  end if;
  if to_regprocedure('public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean)') is not null
     or has_function_privilege('service_role','public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)','execute')
     or not has_function_privilege('authenticated','public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)','execute')
     or has_function_privilege('anon','internal.resolve_wecom_lp_business_identity()','execute') then
    raise exception 'business_endpoint_grants_or_overloads_changed';
  end if;
end;
$business_handover$;
rollback;
select 'wecom_lp_business_handover_runtime_ok' as result;

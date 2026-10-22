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
  if public.read_wecom_lp_draft('wecom-fixture-secret','bot:independent:historical','Abby',false)->>'sourceKind' is distinct from 'business' then raise exception 'historical_independent_source_not_backfilled'; end if;
  if internal.wecom_lp_template_type((select body from internal.wecom_archive_messages where message_id='bot:lp-draft:one')) <> '老师新 LP' then
    raise exception 'legacy_replay_fixture_missing_reclassified_heading';
  end if;
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

  begin
    perform public.confirm_wecom_lp_draft_atomic(
      'wecom-fixture-secret',(source->>'caseId')::uuid,'bot:lp-draft:one',
      (select confirmation_intent->>'sourceRevision' from internal.wecom_lp_confirmations where source_message_id='bot:lp-draft:one'),
      legacy.command_key,'STU-DRAFT-1',null,internal.fixture_wecom_lp_fields() || '{"assignedTeacher":"Changed Teacher"}'::jsonb,assignment,
      internal.fixture_wecom_lp_versions(),'Abby',false
    );
    raise exception 'legacy_confirmation_changed_fields_allowed';
  exception when unique_violation then null; end;

  if not internal.wecom_is_lp_template(E'[Rose]换老师试听 信息交接[Rose]\n学生：Draft Student\n安排教师：Tynan\n二次试听原因 + 注意事项：换教学方式')
     or not internal.wecom_is_lp_template(E'[Rose]老生LP修改 信息交接[Rose]\n学生姓名：Draft Student\n涉及科目：English\n变动内容：增加写作')
     or internal.wecom_is_lp_template(E'二次试听要不要换老师？\n学生：Draft Student') then
    raise exception 'document_template_shape_classification_failed';
  end if;
  if internal.wecom_lp_template_type(E'老生新 LP 信息交接\n备注：老生LP修改 信息交接') <> '老师新 LP'
     or internal.wecom_lp_template_type(E'备注：老生新LP 信息交接\n安排教师：Grace\n安排科目：English') <> '试听 LP'
     or internal.wecom_lp_template_type(E'[Rose]老生加课ｌｐ 信息交接表[Rose]') <> '老师新 LP'
     or internal.wecom_lp_template_type(E'【LP类型】：二次试听') <> '试听 LP'
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
      E'[Rose]换老师试听 信息交接[Rose]\n学生：Draft Student\n安排教师：Tynan\n二次试听原因 + 注意事项：换教学方式',
      'handover','pending','WeCom Bot Receiver'),
    ('bot:business:modify',repeat('e',64),'business-modify','sales','2099-01-03T00:00:00Z','text',
      E'[Rose]老生LP修改 信息交接[Rose]\n学生姓名：Draft Student\n涉及科目：English\n变动内容：增加写作',
      'handover','pending','WeCom Bot Receiver');
  if exists (select 1 from internal.wecom_archive_messages where message_id like 'bot:business:%'
      and (trial_handover_id is not null or guardian_wechat_hint is not null
        or operations_owner_hint is distinct from 'Abby' or course_planner_hint is distinct from 'Tara')) then
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
    E'业务类型：换老师试听\n学生姓名：Draft Student',
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
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:business:ambiguous','Nixon',true);
  if source is null or source->>'sourceKind' <> 'business' or source->>'wechatName' <> ''
     or source->'messages'->0->>'studentId' is not null then raise exception 'ambiguous_business_source_lost_or_auto_selected'; end if;
  begin
    perform public.read_wecom_lp_draft('wecom-fixture-secret','bot:business:ambiguous','Abby',false);
    raise exception 'unowned_business_source_visible_to_non_admin';
  exception when insufficient_privilege then null; end;
  fields := common || '{"subject":"English","modificationRequirements":"人工核对重名学生","requestSentAt":"2099-01-04T00:00:00.000Z"}'::jsonb;
  select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
    'bot:business:ambiguous',source->>'sourceRevision','20000000-0000-4000-8000-000000000030','STU-DUPLICATE',null,
    fields,assignment,internal.fixture_wecom_lp_versions(),'Nixon',true,'老师 LP 修改');
  if not receipt.applied or receipt.student_id <> 'STU-DUPLICATE' or not exists (
    select 1 from internal.wecom_lp_confirmations c where c.source_message_id='bot:business:ambiguous'
      and c.case_id is null and c.business_case_id=(source->>'caseId')::uuid
  ) then raise exception 'ambiguous_business_manual_confirmation_failed'; end if;

  update public.ops_state set payload=payload||'[{"id":"STU-NO-GUARDIAN","name":"Business No Guardian","owner":"Abby","planner":"Tara","files":0}]'::jsonb where entity='students';
  before_versions := internal.fixture_wecom_lp_versions();
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, student_name_hint, match_status, ingested_by)
  values('bot:business:no-guardian',repeat('1',64),'business-no-guardian','sales','2099-01-06','text',
    E'老师LP修改 信息交接\n学生姓名：Business No Guardian\n涉及科目：English\n变动内容：调整目标',
    'handover','Business No Guardian','pending','WeCom Bot Receiver');
  if internal.fixture_wecom_lp_versions() <> before_versions then raise exception 'independent_business_source_created_operational_data'; end if;
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:business:no-guardian','Abby',false);
  if source is null or source->>'wechatName' <> '' or source->>'sourceKind' <> 'business'
     or source->>'studentName' <> 'Business No Guardian' or source->>'operationsOwner' <> 'Abby'
     or exists (select 1 from internal.wecom_archive_messages m where m.message_id='bot:business:no-guardian' and m.trial_handover_id is not null) then
    raise exception 'business_without_guardian_hidden_or_fabricated_wechat';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2099-01-06','2099-01-07'))->>'total' <> '1'
     or not exists (select 1 from jsonb_array_elements((public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false))->'rows') draft where draft->>'sourceMessageId'='bot:business:no-guardian') then
    raise exception 'independent_business_source_missing_from_scoped_readers';
  end if;
  begin
    perform public.read_wecom_lp_draft('wecom-fixture-secret','bot:business:no-guardian','Ella',false);
    raise exception 'independent_business_read_crossed_owner_scope';
  exception when insufficient_privilege then null; end;
  fields := common || '{"subject":"English","modificationRequirements":"调整目标","requestSentAt":"2099-01-06T00:00:00.000Z"}'::jsonb;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      'bot:business:no-guardian',source->>'sourceRevision','20000000-0000-4000-8000-000000000031','STU-NO-GUARDIAN',null,
      fields,assignment,before_versions,'Ella',false,'老师 LP 修改');
    raise exception 'independent_business_confirmation_crossed_owner_scope';
  exception when insufficient_privilege then null; end;
  update internal.wecom_archive_messages set body=body||E'\n备注：已核对' where message_id='bot:business:no-guardian';
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      'bot:business:no-guardian',source->>'sourceRevision','20000000-0000-4000-8000-000000000031','STU-NO-GUARDIAN',null,
      fields,assignment,before_versions,'Abby',false,'老师 LP 修改');
    raise exception 'independent_business_source_revision_not_checked';
  exception when serialization_failure then null; end;
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:business:no-guardian','Abby',false);
  select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
    'bot:business:no-guardian',source->>'sourceRevision','20000000-0000-4000-8000-000000000031','STU-NO-GUARDIAN',null,
    fields,assignment,before_versions,'Abby',false,'老师 LP 修改');
  select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
    'bot:business:no-guardian',source->>'sourceRevision','20000000-0000-4000-8000-000000000031','STU-NO-GUARDIAN',null,
    fields,assignment,before_versions,'Abby',false,'老师 LP 修改');
  if not receipt.applied or replay.applied or receipt.lp_item_id <> replay.lp_item_id then raise exception 'independent_business_retry_duplicated_lp'; end if;
  begin
    update internal.wecom_lp_confirmations set business_case_id=(select id from internal.wecom_lp_business_sources where source_message_id='bot:business:ambiguous') where source_message_id='bot:business:no-guardian';
    raise exception 'independent_business_case_not_bound_to_source_fk';
  exception when foreign_key_violation then null; end;
  if exists (select 1 from jsonb_array_elements((public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false))->'rows') draft where draft->>'sourceMessageId'='bot:business:no-guardian')
     or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2099-01-06','2099-01-07'))->'rows'->0->'confirmed'->>'lpItemId' <> receipt.lp_item_id
     or has_table_privilege('anon','internal.wecom_lp_business_sources','select')
     or has_function_privilege('anon','internal.wecom_lp_trial_draft_source(text)','execute') then
    raise exception 'independent_business_confirmation_readback_or_privacy_failed';
  end if;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type, body, classification, student_name_hint, operations_owner_hint, course_planner_hint, match_status, ingested_by)
  values('bot:independent:new',repeat('2',64),'independent-new','sales','2099-01-07','text',
    E'老生新LP 信息交接\n学生姓名：Business No Guardian\n安排教师：Grace\n安排科目：English',
    'handover','Business No Guardian','Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:independent:repeat',repeat('3',64),'independent-repeat','sales','2099-01-07','text',
    E'换老师试听 信息交接\n学生：Business No Guardian\n安排教师：Tynan\n重听原因：更换教学方式',
    'handover','Business No Guardian','Abby','Tara','pending','WeCom Bot Receiver');
  for kind,message_id_value,command_value,fields in select * from (values
    ('老师新 LP','bot:independent:new','20000000-0000-4000-8000-000000000032',common||'{"teacher":"Grace","subject":"English","writingRequired":false,"paperRequired":false}'::jsonb),
    ('换老师试听','bot:independent:repeat','20000000-0000-4000-8000-000000000033',common||'{"newTeacher":"Tynan","subject":"English","changeReason":"更换教学方式"}'::jsonb)
  ) cases(kind,message_id_value,command_value,fields) loop
    source := public.read_wecom_lp_draft('wecom-fixture-secret',message_id_value,'Abby',false);
    if source is null or source->>'sourceKind' <> 'business' then raise exception 'independent_other_business_type_not_readable'; end if;
    select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      message_id_value,source->>'sourceRevision',command_value,'STU-NO-GUARDIAN',null,fields,assignment,
      internal.fixture_wecom_lp_versions(),'Abby',false,kind);
    if not receipt.applied or not exists (select 1 from jsonb_array_elements((receipt.lp_items_row).payload) lp where lp->>'id'=receipt.lp_item_id and lp->>'workflowType'=kind) then
      raise exception 'independent_business_type_confirmation_failed';
    end if;
  end loop;
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


begin;
do $trial_source_scope$
declare input jsonb; pending jsonb; source jsonb; bad_id text;
begin
  update public.ops_state set payload=payload||'[{"id":"STU-SCOPE-NO-GUARDIAN","name":"Scope No Guardian","owner":"Abby","planner":"Tara"}]'::jsonb where entity='students';
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
    message_type,body,classification,student_name_hint,guardian_wechat_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by)
  values
    ('bot:scope:trial',repeat('1',64),'scope-trial','sales','2099-01-09','text',
      E'试听LP 信息交接\n学生姓名：Draft Student\n安排教师：Grace\n安排科目：English',
      'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:scope:new',repeat('2',64),'scope-new','sales','2099-01-09','text',
      E'老生新LP 信息交接\n学生姓名：Draft Student\n安排教师：Grace\n安排科目：English',
      'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:scope:modify',repeat('3',64),'scope-modify','sales','2099-01-09','text',
      E'老生LP修改 信息交接\n学生姓名：Draft Student\n安排教师：Grace\n安排科目：English\n变动内容：更改重点',
      'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:scope:repeat',repeat('4',64),'scope-repeat','sales','2099-01-09','text',
      E'换老师试听 信息交接\n学生姓名：Draft Student\n安排教师：Tynan\n安排科目：English\n重听原因：更换教师',
      'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:scope:repeat-independent',repeat('5',64),'scope-repeat-independent','sales','2099-01-09','text',
      E'换老师试听 信息交接\n学生姓名：Scope No Guardian\n安排教师：Tynan\n重听原因：更换教师',
      'handover','Scope No Guardian',null,'Abby','Tara','pending','WeCom Bot Receiver'),
    ('bot:scope:modify-independent',repeat('6',64),'scope-modify-independent','sales','2099-01-09','text',
      E'老生LP修改 信息交接\n学生姓名：Scope No Guardian\n涉及科目：English\n变动内容：更改重点',
      'handover','Scope No Guardian',null,'Abby','Tara','pending','WeCom Bot Receiver');
  if not exists(select 1 from internal.wecom_archive_messages where message_id='bot:scope:modify' and trial_handover_id is not null)
      or not exists(select 1 from internal.wecom_lp_business_sources where source_message_id='bot:scope:repeat-independent') then
    raise exception 'trial_source_scope_case_fixture_missing';
  end if;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:scope:trial']);
  if exists(select 1 from jsonb_array_elements(input->'sources') s where s->>'sourceMessageId' in ('bot:scope:new','bot:scope:modify','bot:scope:modify-independent'))
      or not exists(select 1 from jsonb_array_elements(input->'sources') s where s->>'sourceMessageId'='bot:scope:repeat')
      or not exists(select 1 from jsonb_array_elements(input->'sources') s where s->>'sourceMessageId'='bot:scope:repeat-independent' and s->>'sourceKind'='business') then
    raise exception 'trial_source_scope_competition_includes_nontrial_or_loses_repeat';
  end if;
  pending := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null);
  if pending->'targetSourceMessageIds' ?| array['bot:scope:new','bot:scope:modify','bot:scope:modify-independent']
      or not(pending->'targetSourceMessageIds' ?& array['bot:scope:trial','bot:scope:repeat','bot:scope:repeat-independent']) then
    raise exception 'trial_source_scope_pending_targets_incorrect';
  end if;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:scope:repeat-independent']);
  if input->'targetSourceMessageIds' <> '["bot:scope:repeat-independent"]'::jsonb then
    raise exception 'trial_source_scope_independent_repeat_not_targetable';
  end if;
  foreach bad_id in array array['bot:scope:new','bot:scope:modify','bot:scope:modify-independent'] loop
    begin
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:scope:trial',bad_id]);
      raise exception 'trial_source_scope_explicit_nontrial_target_allowed';
    exception when serialization_failure then
      if sqlerrm <> 'wecom_schedule_source_changed' then raise; end if;
    end;
  end loop;
  if has_function_privilege('anon','internal.wecom_is_trial_lp_template(text)','execute')
      or has_function_privilege('authenticated','internal.wecom_is_trial_lp_template(text)','execute')
      or has_function_privilege('service_role','internal.wecom_is_trial_lp_template(text)','execute') then
    raise exception 'trial_source_scope_helper_grants_changed';
  end if;
end;
$trial_source_scope$;
rollback;
select 'wecom_lp_trial_source_scope_runtime_ok' as result;


begin;
do $name_only_siblings$
declare source jsonb; sibling_source jsonb; receipt record; message_id_value text; selected_id text; command_value text;
  assignment jsonb := '{"owner":"Abby","planner":"Tara","mayReassign":false}';
  fields jsonb := '{"responsibleOperations":"Abby","subject":"English","specifiedContentStatus":"无需指定","preparationFollowUp":"否","isUniversityStudent":false,"modificationRequirements":"增加写作","requestSentAt":"2099-01-10T00:00:00.000Z"}';
begin
  update public.ops_state set payload=payload||'[
    {"id":"STU-SIBLING-ONE","name":"Sibling One","guardianWechat":"Shared Sibling Parent","owner":"Abby","planner":"Tara"},
    {"id":"STU-SIBLING-TWO","name":"Sibling Two","guardianWechat":"Shared Sibling Parent","owner":"Abby","planner":"Tara"}
  ]'::jsonb where entity='students';
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
    message_type,body,classification,match_status,ingested_by)
  values ('bot:sibling:one',repeat('7',64),'shared-sibling-chat','sales','2099-01-10','text',
    E'老生LP修改 信息交接\n学生姓名：Sibling One\n涉及科目：English\n变动内容：增加写作','handover','pending','WeCom Bot Receiver'),
    ('bot:sibling:two',repeat('8',64),'shared-sibling-chat','sales','2099-01-10T01:00:00Z','text',
    E'老生LP修改 信息交接\n学生姓名：Sibling Two\n涉及科目：English\n变动内容：增加写作','handover','pending','WeCom Bot Receiver');
  if exists(select 1 from internal.wecom_archive_messages where message_id in ('bot:sibling:one','bot:sibling:two')
      and (guardian_wechat_hint is not null or trial_handover_id is not null or operations_owner_hint <> 'Abby' or course_planner_hint <> 'Tara'))
      or (select count(distinct id) from internal.wecom_lp_business_sources where source_message_id in ('bot:sibling:one','bot:sibling:two')) <> 2 then
    raise exception 'name_only_siblings_promoted_roster_guardian_or_shared_case';
  end if;
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:sibling:one','Abby',false);
  sibling_source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:sibling:two','Abby',false);
  if source is null or sibling_source is null or source->>'caseId'=sibling_source->>'caseId'
      or source->>'sourceKind' <> 'business' or sibling_source->>'sourceKind' <> 'business'
      or source->>'wechatName' <> '' or sibling_source->>'wechatName' <> ''
      or source->>'studentName' <> 'Sibling One' or sibling_source->>'studentName' <> 'Sibling Two'
      or source->>'status' in ('identity_conflict','identity_ambiguous')
      or sibling_source->>'status' in ('identity_conflict','identity_ambiguous')
      or not exists(select 1 from jsonb_array_elements(public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false)->'rows') s where s->>'sourceMessageId'='bot:sibling:one')
      or not exists(select 1 from jsonb_array_elements(public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false)->'rows') s where s->>'sourceMessageId'='bot:sibling:two') then
    raise exception 'name_only_siblings_not_independently_reviewable';
  end if;
  for message_id_value,selected_id,command_value in select * from (values
    ('bot:sibling:one','STU-SIBLING-ONE','20000000-0000-4000-8000-000000000040'),
    ('bot:sibling:two','STU-SIBLING-TWO','20000000-0000-4000-8000-000000000041')
  ) selections(message_id_value,selected_id,command_value) loop
    source := public.read_wecom_lp_draft('wecom-fixture-secret',message_id_value,'Abby',false);
    select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      message_id_value,source->>'sourceRevision',command_value,selected_id,null,fields,assignment,
      internal.fixture_wecom_lp_versions(),'Abby',false,'老师 LP 修改');
    if not receipt.applied or receipt.student_id <> selected_id
        or not exists(select 1 from internal.wecom_lp_confirmations c where c.source_message_id=message_id_value
          and c.student_id=selected_id and c.case_id is null and c.business_case_id=(source->>'caseId')::uuid)
        or not exists(select 1 from jsonb_array_elements((receipt.lp_items_row).payload) lp
          where lp->>'id'=receipt.lp_item_id and lp->>'studentId'=selected_id and lp->>'workflowType'='老师 LP 修改') then
      raise exception 'name_only_sibling_manual_confirmation_failed';
    end if;
    if message_id_value='bot:sibling:one'
        and public.read_wecom_lp_draft('wecom-fixture-secret','bot:sibling:two','Abby',false) is distinct from sibling_source then
      raise exception 'name_only_sibling_confirmation_mutated_other_source';
    end if;
  end loop;
end;
$name_only_siblings$;
rollback;
select 'wecom_lp_name_only_siblings_runtime_ok' as result;


begin;
do $ordinary_repeat_trials$
declare source jsonb; before_state jsonb; receipt record; replay record; case_value text;
  fields jsonb := internal.fixture_wecom_lp_fields();
  assignment jsonb := '{"owner":"Abby","planner":"Tara","mayReassign":false}';
begin
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:repeat:historical','Abby',false);
  if source is null or source->>'caseId' is distinct from (select id::text from internal.fixture_repeat_before)
     or source->'messages'->0->>'text' is distinct from (select body from internal.fixture_repeat_before)
     or internal.wecom_lp_template_type(source->'messages'->0->>'text') is distinct from '试听 LP'
     or exists(select 1 from internal.wecom_lp_confirmations where source_message_id='bot:repeat:historical') then
    raise exception 'historical_repeat_reclassification_lost_source_or_created_lp';
  end if;
  select jsonb_object_agg(entity,to_jsonb(s)) into before_state from public.ops_state s;
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
    message_type,body,classification,student_name_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by)
  values ('bot:ordinary:repeat',repeat('9',64),'ordinary-repeat','sales','2099-01-03','text',
    E'[Rose]二次试听 信息交接[Rose]\n学生：Draft Student\n安排教师：Grace\n二次试听原因+注意事项：很久以前上过写作，现在想重新试听',
    'handover','Draft Student','Abby','Tara','pending','WeCom Bot Receiver');
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:ordinary:repeat','Abby',false);
  case_value := source->>'caseId';
  if source is null or source->>'sourceKind' <> 'business' or source->>'wechatName' <> ''
     or internal.wecom_lp_template_type(source->'messages'->0->>'text') <> '试听 LP'
     or not internal.wecom_is_trial_lp_template(source->'messages'->0->>'text')
     or exists(select 1 from internal.wecom_archive_messages where message_id='bot:ordinary:repeat'
       and (guardian_wechat_hint is not null or trial_handover_id is not null))
     or not exists(select 1 from jsonb_array_elements(public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false)->'rows') d
       where d->>'sourceMessageId'='bot:ordinary:repeat') then
    raise exception 'ordinary_repeat_not_readable_without_guardian';
  end if;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_state then
    raise exception 'ordinary_repeat_ingest_mutated_business_state';
  end if;
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value::uuid,
      'bot:ordinary:repeat',source->>'sourceRevision','30000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,
      '{"newTeacher":"Grace","subject":"English","changeReason":"repeat"}',assignment,
      internal.fixture_wecom_lp_versions(),'Abby',false,'换老师试听');
    raise exception 'ordinary_repeat_teacher_change_confirmation_allowed';
  exception when invalid_parameter_value then
    if sqlerrm <> 'wecom_lp_source_workflow_mismatch' then raise; end if;
  end;
  fields := fields || '{"specialNotes":"很久以前上过写作，现在想重新试听"}'::jsonb;
  select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value::uuid,
    'bot:ordinary:repeat',source->>'sourceRevision','30000000-0000-4000-8000-000000000002','STU-DRAFT-1',null,
    fields,assignment,internal.fixture_wecom_lp_versions(),'Abby',false,'试听 LP');
  if not receipt.applied or not exists(select 1 from jsonb_array_elements((receipt.lp_items_row).payload) lp
    where lp->>'id'=receipt.lp_item_id and lp->>'workflowType'='试听 LP'
      and lp->'fields'->>'assignedTeacher'=fields->>'assignedTeacher'
      and lp->'fields'->>'specialNotes'=fields->>'specialNotes') then
    raise exception 'ordinary_repeat_confirmation_failed';
  end if;
  select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',case_value::uuid,
    'bot:ordinary:repeat',source->>'sourceRevision','30000000-0000-4000-8000-000000000002','STU-DRAFT-1',null,
    fields,assignment,internal.fixture_wecom_lp_versions(),'Abby',false,'试听 LP');
  if replay.applied or replay.lp_item_id <> receipt.lp_item_id then raise exception 'ordinary_repeat_replay_failed'; end if;
end;
$ordinary_repeat_trials$;
rollback;
select 'wecom_ordinary_repeat_trials_runtime_ok' as result;

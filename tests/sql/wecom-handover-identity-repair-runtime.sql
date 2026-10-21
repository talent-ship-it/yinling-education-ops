\ir assert-disposable-database.sql

insert into internal.wecom_trial_handover_cases(chat_id,wechat_name,wechat_name_key,status)
values ('repair-room','-@教务AI助手','-@教务ai助手','awaiting_student_name');
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
 message_type,body,classification,student_name_hint,guardian_wechat_hint,match_status,ingested_by)
values
 ('repair-empty',repeat('a',64),'repair-room','fixture','2099-02-01','text',E'【微信名】:-@教务AI助手','handover',null,'-@教务AI助手','pending','WeCom Bot Receiver'),
 ('repair-aster',repeat('b',64),'repair-room','fixture','2099-02-02','text',E'【安排教师】:Grace\n【安排科目】:English\n【微信名】:Aster@教务AI助手','handover','Student A','Aster@教务AI助手','pending','WeCom Bot Receiver'),
 ('repair-birch',repeat('c',64),'repair-room','fixture','2099-02-03','text',E'【安排教师】:Grace\n【安排科目】:Maths\n【微信名】:Birch@教务AI助手','handover','Student B','Birch@教务AI助手','pending','WeCom Bot Receiver'),
 ('repair-aster-repeat',repeat('d',64),'repair-room','fixture','2099-02-04','text',E'【安排教师】:Grace\n【安排科目】:English\n【微信名】:Aster@教务AI助手','handover',null,'Aster@教务AI助手','pending','WeCom Bot Receiver');

\ir ../../scripts/repair-wecom-handover-identity.sql

do $$
declare case_id uuid; caught boolean := false;
begin
 select id into case_id from internal.wecom_trial_handover_cases where chat_id='repair-room';
 begin
  perform pg_temp.repair_wecom_handover_identity(case_id,null,'fixture',false);
 exception when others then
  if sqlerrm <> 'wecom_identity_repair_safe_matching_required' then raise; end if;
  caught := true;
 end;
 if not caught then raise exception 'repair_accepted_unsafe_matcher'; end if;
end;
$$;

\ir ../../supabase/migrations/20261019000100_wecom_safe_guardian_identity.sql

create temporary table repair_source as select * from internal.wecom_archive_messages;
create temporary table repair_business_state as select * from public.ops_state;
create temporary table repair_legacy as select * from internal.wecom_trial_handover_cases where chat_id='repair-room';
create temporary table repair_plan as
select pg_temp.repair_wecom_handover_identity(id,null,'fixture',false) plan
from internal.wecom_trial_handover_cases where chat_id='repair-room';

do $$
declare plan jsonb; result jsonb; caught boolean := false; count_before integer;
begin
 select p.plan into plan from repair_plan p;
 if plan ->> 'totalMessages' <> '4' or plan ->> 'repairableMessages' <> '3'
   or plan ->> 'retainedMessages' <> '1' then raise exception 'repair_plan_wrong'; end if;
 if exists(select 1 from internal.wecom_archive_messages where message_id like 'repair-%'
   and trial_handover_id is distinct from (plan ->> 'caseId')::uuid) then raise exception 'preview_mutated_associations'; end if;
 begin
  perform pg_temp.repair_wecom_handover_identity((plan ->> 'caseId')::uuid,repeat('0',64),'fixture',true);
 exception when others then
  if sqlerrm <> 'wecom_identity_repair_revision_changed' then raise; end if;
  caught := true;
 end;
 if not caught then raise exception 'repair_accepted_stale_revision'; end if;
 update internal.wecom_archive_messages set projected_message_id='synthetic-projection' where message_id='repair-aster';
 caught := false;
 begin
  perform pg_temp.repair_wecom_handover_identity((plan ->> 'caseId')::uuid,plan ->> 'sourceRevision','fixture',true);
 exception when others then
  if sqlerrm <> 'wecom_identity_repair_protected_records' then raise; end if;
  caught := true;
 end;
 if not caught then raise exception 'repair_accepted_projected_message'; end if;
 update internal.wecom_archive_messages set projected_message_id=null where message_id='repair-aster';
 insert into internal.wecom_lp_confirmations(source_message_id,case_id,command_uuid,confirmation_intent,student_id,lp_item_id,actor,audit_id)
 select 'repair-aster',(plan ->> 'caseId')::uuid,'source-protection','{}','SYNTHETIC-STUDENT','SYNTHETIC-LP','fixture',id
 from internal.operational_contract_audit order by created_at limit 1;
 caught := false;
 begin
  perform pg_temp.repair_wecom_handover_identity((plan ->> 'caseId')::uuid,plan ->> 'sourceRevision','fixture',true);
 exception when others then
  if sqlerrm <> 'wecom_identity_repair_protected_records' then raise; end if;
  caught := true;
 end;
 if not caught then raise exception 'repair_accepted_confirmed_source'; end if;
 delete from internal.wecom_lp_confirmations where command_uuid='source-protection';
 result := pg_temp.repair_wecom_handover_identity((plan ->> 'caseId')::uuid,plan ->> 'sourceRevision','fixture',true);
 if result ->> 'applied' <> 'true' then raise exception 'repair_did_not_apply'; end if;
 select count(*) into count_before from internal.operational_contract_audit;
 result := pg_temp.repair_wecom_handover_identity((plan ->> 'caseId')::uuid,plan ->> 'sourceRevision','fixture',true);
 if result ->> 'replayed' <> 'true' or result ->> 'applied' <> 'false'
   or (select count(*) from internal.operational_contract_audit) <> count_before then raise exception 'repair_replay_changed_data'; end if;
 if (select count(distinct trial_handover_id) from internal.wecom_archive_messages where message_id like 'repair-%') <> 3
   or (select trial_handover_id from internal.wecom_archive_messages where message_id='repair-aster')
     is distinct from (select trial_handover_id from internal.wecom_archive_messages where message_id='repair-aster-repeat')
 then raise exception 'repair_did_not_separate_families'; end if;
 if (select trial_handover_id from internal.wecom_archive_messages where message_id='repair-empty') <> (plan ->> 'caseId')::uuid
 then raise exception 'repair_guessed_missing_guardian'; end if;
 if (select count(*) from internal.wecom_trial_handover_cases where chat_id='repair-room' and status='identified') <> 2
 then raise exception 'repair_wrong_student_status'; end if;
 if (internal.wecom_lp_draft_source('repair-aster') ->> 'status') is distinct from 'identified'
    or (internal.wecom_lp_draft_source('repair-birch') ->> 'wechatName') is distinct from 'Birch'
 then raise exception 'repaired_draft_reader_still_conflicted'; end if;
end;
$$;

do $$
begin
 if exists(select 1 from internal.wecom_trial_handover_cases c join repair_legacy l using(id)
   where to_jsonb(c) is distinct from to_jsonb(l)) then raise exception 'repair_changed_quarantined_case'; end if;
 if exists(select 1 from internal.wecom_archive_messages m join repair_source s using(message_id)
   where (to_jsonb(m)-'trial_handover_id'-'updated_at') is distinct from (to_jsonb(s)-'trial_handover_id'-'updated_at'))
 then raise exception 'repair_changed_source_evidence'; end if;
 if exists((table public.ops_state except table repair_business_state)
   union all (table repair_business_state except table public.ops_state))
 then raise exception 'repair_changed_business_state'; end if;
end;
$$;

insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
 message_type,body,classification,student_name_hint,guardian_wechat_hint,match_status,ingested_by)
values ('repair-real-conflict',repeat('e',64),'repair-room','fixture','2099-02-05','text',
 E'【学生姓名】:Different Student\n【微信名】:Aster','handover','Different Student','Aster','pending','WeCom Bot Receiver');

do $$
declare case_id uuid; caught boolean := false;
begin
 select trial_handover_id into case_id from internal.wecom_archive_messages where message_id='repair-real-conflict';
 if (select status from internal.wecom_trial_handover_cases where id=case_id) <> 'identity_conflict'
 then raise exception 'repair_disabled_real_conflicts'; end if;
 begin
  perform pg_temp.repair_wecom_handover_identity(case_id,null,'fixture',false);
 exception when others then
  if sqlerrm <> 'wecom_identity_repair_case_not_eligible' then raise; end if;
  caught := true;
 end;
 if not caught then raise exception 'repair_accepted_valid_guardian_conflict'; end if;
end;
$$;

do $$
declare legacy_id uuid; destination_id uuid; plan jsonb; caught boolean; count_before integer;
begin
 begin
  select id into legacy_id from repair_legacy;
  select trial_handover_id into destination_id from internal.wecom_archive_messages where message_id='repair-birch';
  insert into internal.wecom_lp_confirmations(source_message_id,case_id,command_uuid,confirmation_intent,student_id,lp_item_id,actor,audit_id)
  select 'repair-birch',destination_id,'destination-protection','{}','SYNTHETIC-STUDENT','SYNTHETIC-LP','fixture',id
  from internal.operational_contract_audit order by created_at limit 1;
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
    message_type,classification,guardian_wechat_hint,match_status,ingested_by)
  values ('repair-destination',repeat('f',64),'repair-room','fixture','2099-03-01','text','handover','Birch','pending','WeCom Bot Receiver');
  update internal.wecom_archive_messages set trial_handover_id=legacy_id where message_id='repair-destination';
  plan := pg_temp.repair_wecom_handover_identity(legacy_id,null,'fixture',false);
  select count(*) into count_before from internal.operational_contract_audit;
  caught := false;
  begin
   perform pg_temp.repair_wecom_handover_identity(legacy_id,plan ->> 'sourceRevision','fixture',true);
  exception when others then
   if sqlerrm <> 'wecom_identity_repair_protected_destination' then raise; end if;
   caught := true;
  end;
  if not caught or (select count(*) from internal.operational_contract_audit) <> count_before
    or (select trial_handover_id from internal.wecom_archive_messages where message_id='repair-destination') is distinct from legacy_id
  then raise exception 'repair_changed_confirmed_destination'; end if;
  raise exception sqlstate 'PT001' using message='rollback_fixture';
 exception when sqlstate 'PT001' then null;
 end;
end;
$$;

do $$
declare legacy_id uuid; plan jsonb; caught boolean; count_before integer;
begin
 begin
  select id into legacy_id from repair_legacy;
  insert into internal.wecom_trial_handover_cases(chat_id,wechat_name,wechat_name_key,status)
  values ('repair-room','Ambig','ambig','awaiting_student_name'),
    ('repair-room','Ambig妈妈','ambig妈妈','awaiting_student_name');
  insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
    message_type,classification,guardian_wechat_hint,match_status,ingested_by)
  values ('repair-rollback-first',repeat('f',64),'repair-room','fixture','2099-03-01','text','handover','Cedar','pending','WeCom Bot Receiver'),
    ('repair-rollback-ambiguous',repeat('f',64),'repair-room','fixture','2099-03-02','text','handover','Ambig','pending','WeCom Bot Receiver');
  update internal.wecom_archive_messages set trial_handover_id=legacy_id where message_id in ('repair-rollback-first','repair-rollback-ambiguous');
  plan := pg_temp.repair_wecom_handover_identity(legacy_id,null,'fixture',false);
  select count(*) into count_before from internal.operational_contract_audit;
  caught := false;
  begin
   perform pg_temp.repair_wecom_handover_identity(legacy_id,plan ->> 'sourceRevision','fixture',true);
  exception when others then
   if sqlerrm <> 'wecom_identity_repair_match_not_unique' then raise; end if;
   caught := true;
  end;
  if not caught or (select count(*) from internal.operational_contract_audit) <> count_before
    or exists(select 1 from internal.wecom_archive_messages where message_id in ('repair-rollback-first','repair-rollback-ambiguous')
      and trial_handover_id is distinct from legacy_id)
  then raise exception 'repair_partial_changes_survived_ambiguity'; end if;
  raise exception sqlstate 'PT001' using message='rollback_fixture';
 exception when sqlstate 'PT001' then null;
 end;
end;
$$;

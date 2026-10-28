\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

begin;
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,
 student_name_hint,guardian_wechat_hint,operations_owner_hint,course_planner_hint,student_id,match_status,ingested_by)
values('bot:tasks:source',repeat('9',64),'tasks-room','sales',now(),'text',
 E'试听LP 信息交接\n【安排教师】：Grace\n【安排科目】：English\n【是否“要指定内容”】：是\n【是否“要写作”】：否\n【是否“发试卷 收试卷”】：否\n【是否“跟进老师备课内容”】：是\n【学生姓名】：Draft Student\n【微信名】：Draft Parent\n【教务老师】：Abby\n【课程规划老师】：Tara',
 'handover','Draft Student','Draft Parent','Abby','Tara',null,'pending','WeCom Bot Receiver');

create temporary table fixture_tasks_command as select public.read_wecom_handover_task_input('wecom-fixture-secret') as authority,
 internal.wecom_lp_draft_source('bot:tasks:source') as source;
create function pg_temp.fixture_tasks_payload() returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('id',internal.trial_manual_task_id('bot:tasks:source','trial.manual-request.specified-content'),
 'studentId','WECOM:'||(source->>'caseId'),'owner','Abby','title','Synthetic specified content',
 'anchorBookingId','bot:tasks:source','ruleKey','trial.manual-request.specified-content','status','done','tone','green','category','LP',
 'completionOutcome','done','closedAt','2026-10-28T08:00:00.000Z','dueAt','2026-10-29T08:00:00.000Z',
 'completionNote','Synthetic durable note','completionNoteUpdatedAt','2026-10-28T08:00:00.000Z'),
 jsonb_build_object('id',internal.trial_manual_task_id('bot:tasks:source','wecom.handover.identity'),
 'studentId','WECOM:'||(source->>'caseId'),'owner','Abby','title','Previously unresolved identity',
 'anchorBookingId','bot:tasks:source','ruleKey','wecom.handover.identity','status','overdue','tone','blue','category','试听',
 'dueAt','2026-10-29T08:00:00.000Z','completionNote','Preserve identity note')) from fixture_tasks_command;
$$;

do $saved_tasks$
declare command fixture_tasks_command%rowtype; result bigint; caught text; receipt record; fields jsonb;
 tasks jsonb; versions jsonb; source jsonb;
begin
 select * into command from fixture_tasks_command;
 if not exists(select 1 from jsonb_array_elements(command.authority->'sources') s where s->>'sourceMessageId'='bot:tasks:source') then
  raise exception 'task_source_missing'; end if;
 begin
  perform public.read_wecom_handover_task_input('wrong'); raise exception 'task_bad_secret_allowed';
 exception when insufficient_privilege then null; end;
 begin
  perform public.save_wecom_handover_tasks('wecom-fixture-secret','bot:tasks:source',command.source->>'sourceRevision',
   command.authority->>'snapshotRevision',command.authority->>'inputRevision',0,pg_temp.fixture_tasks_payload(),'Ella',false);
  raise exception 'task_other_owner_allowed';
 exception when insufficient_privilege then null; end;
 begin
  perform public.save_wecom_handover_tasks('wecom-fixture-secret','bot:tasks:source',command.source->>'sourceRevision',
   command.authority->>'snapshotRevision',command.authority->>'inputRevision',0,
   jsonb_set(pg_temp.fixture_tasks_payload(),'{0,studentId}','"WECOM:other"'),'Abby',false);
  raise exception 'task_other_student_allowed';
 exception when invalid_parameter_value then null; end;
 result := public.save_wecom_handover_tasks('wecom-fixture-secret','bot:tasks:source',command.source->>'sourceRevision',
   command.authority->>'snapshotRevision',command.authority->>'inputRevision',0,pg_temp.fixture_tasks_payload(),'Abby',false);
 if result<>1 or (select s.tasks from internal.wecom_handover_task_state s where s.source_message_id='bot:tasks:source')<>pg_temp.fixture_tasks_payload() then
  raise exception 'task_save_readback_failed'; end if;
 if not exists(select 1 from jsonb_array_elements(public.read_wecom_handover_task_input('wecom-fixture-secret')->'states') s
   where s->>'sourceMessageId'='bot:tasks:source' and s->'tasks'=pg_temp.fixture_tasks_payload()) then raise exception 'task_feed_readback_failed'; end if;
 begin
  perform public.save_wecom_handover_tasks('wecom-fixture-secret','bot:tasks:source',command.source->>'sourceRevision',
   command.authority->>'snapshotRevision',command.authority->>'inputRevision',0,pg_temp.fixture_tasks_payload(),'Abby',false);
  raise exception 'task_stale_version_allowed';
 exception when sqlstate 'PT409' then null; end;
 select jsonb_object_agg(entity,version) into versions from public.ops_state where entity in ('files','students','lpItems','tasks');
 fields := internal.fixture_wecom_lp_fields();
 fields := fields || jsonb_build_object('requestSentAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(command.source->>'caseId')::uuid,
  'bot:tasks:source',command.source->>'sourceRevision','00000000-0000-4000-8000-000000000091','STU-DRAFT-1',null,fields,
  '{"owner":"Abby","planner":"Tara","mayReassign":false}',versions,'Abby',false,'试听 LP');
 select payload into tasks from public.ops_state where entity='tasks';
 if (receipt.tasks_row).payload is distinct from tasks or (receipt.tasks_row).version is distinct from (select version from public.ops_state where entity='tasks') then
  raise exception 'task_confirmation_receipt_stale'; end if;
 if not exists(select 1 from jsonb_array_elements(tasks) t where t->>'anchorBookingId'=receipt.lp_item_id
  and t->>'studentId'='STU-DRAFT-1' and t->>'ruleKey'='trial.manual-request.specified-content' and t->>'status'='done'
  and t->>'completionNote'='Synthetic durable note') then raise exception 'task_confirmation_lost_history'; end if;
 if (select count(*) from jsonb_array_elements(tasks) t where t->>'anchorBookingId'=receipt.lp_item_id
   and t->>'ruleKey'='trial.manual-request.specified-content')<>1 then raise exception 'task_confirmation_duplicate_action'; end if;
 if not exists(select 1 from jsonb_array_elements(tasks) t where t->>'anchorBookingId'=receipt.lp_item_id
   and t->>'ruleKey'='wecom.handover.identity' and t->>'status'='done' and t->>'completionOutcome'='done'
  and t->>'completionNote'='Preserve identity note') then raise exception 'task_confirmation_identity_lost'; end if;
 if exists(select 1 from jsonb_array_elements(public.read_wecom_handover_task_input('wecom-fixture-secret')->'sources') s
   where s->>'sourceMessageId'='bot:tasks:source') then raise exception 'task_confirmed_still_pending'; end if;
 begin
  perform public.save_wecom_handover_tasks('wecom-fixture-secret','bot:tasks:source',command.source->>'sourceRevision',
   command.authority->>'snapshotRevision',command.authority->>'inputRevision',1,pg_temp.fixture_tasks_payload(),'Abby',false);
  raise exception 'task_confirmed_write_allowed';
 exception when sqlstate 'PT409' then null; end;
end;
$saved_tasks$;

set local role anon;
do $private_tasks_denied$
begin
 begin perform 1 from internal.wecom_handover_task_state; raise exception 'task_private_table_accessible';
 exception when insufficient_privilege then null; end;
 begin perform public.read_wecom_handover_task_input('wrong'); raise exception 'task_anon_bad_secret_allowed';
 exception when insufficient_privilege then null; end;
end;
$private_tasks_denied$;
reset role;
rollback;
select 'wecom handover task input/save/confirmation/ACL: PASS' as result;

\ir assert-disposable-database.sql
\set ON_ERROR_STOP on
begin;
\ir trial-screenshot-confirmation-setup.sql

do $$
declare
  revision text:='sha256:'||repeat('a',64); run_id uuid:=extensions.gen_random_uuid(); command_id text:=extensions.gen_random_uuid()::text;
  source_day text:=to_char((now()+interval '2 days') at time zone 'Australia/Melbourne','YYYY-MM-DD');
  started text; ended text; student jsonb; lp jsonb; next_lp jsonb; fields jsonb; intake jsonb; link jsonb; done_task jsonb; unrelated_task jsonb;
  intent jsonb; versions jsonb:='{"students":1,"lpItems":1,"tasks":1}'; statement text; receipt record; old_students jsonb; mutations integer; audits integer;
begin
  started:=to_char(((source_day||' 09:00')::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ended:=to_char(((source_day||' 10:00')::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  student:='{"id":"S-1","name":"Synthetic Parent","guardianWechat":"Synthetic Parent","owner":"Ella","planner":"Tara","jwbSourceRow":null}';
  fields:='{"responsibleOperations":"Ella","assignedTeacher":"Old Teacher","studentNameKnown":false,"subject":"Keep reviewed subject","trialDurationMinutes":45,"trialPaymentMethod":"赠送"}';
  intake:=jsonb_build_object('planner','Tara','requestSentAt',started,'studentName','Synthetic Parent','trialDurationMinutes',45,'contactParents',true,'contactStudent',false,'writingRequired',false,'paperRequired',false);
  lp:=jsonb_build_object('id','LP-1','studentId','S-1','workflowType','试听 LP','stage','待跟进','owner','Ella','trialPaid',true,'fields',fields,'trialIntake',intake,'ledger',jsonb_build_object('scheduledAt','manual override','result','human result'));
  link:=jsonb_build_object('source','jiaowubao-open-api','confirmation','screenshot-review','sourceRevision',revision,'eventId','jwb-open-api:schedule:1','startsAt',started,'endsAt',ended,'courseName','English - Synthetic Child试听','teacherId',null,'teacherName','Synthetic Teacher','studentName','Synthetic Child','plannerHint','Tara','matchedAt',started);
  next_lp:=lp||jsonb_build_object('fields',fields||'{"assignedTeacher":"Synthetic Teacher","studentNameKnown":true,"studentName":"Synthetic Child","trialDurationMinutes":60}'::jsonb,'trialIntake',intake||'{"studentName":"Synthetic Child","trialDurationMinutes":60}'::jsonb,'trialSchedule',link,'trialScheduleReview',jsonb_build_object('source','screenshot-review','eventId','jwb-open-api:schedule:1'));
  done_task:='{"id":"DONE","studentId":"S-1","title":"Synthetic done history","owner":"Ella","status":"done","ruleKey":"trial.jiaowubao.today","anchorBookingId":"JWB:old","requestAnchorBookingId":"LP-1","result":"human-done"}';
  unrelated_task:='{"id":"OTHER","studentId":"S-2","title":"Private unrelated reminder","owner":"Tiffany","status":"upcoming"}';
  insert into public.ops_state(entity,payload,version,updated_by) values('students',jsonb_build_array(student),1,'fixture'),('lpItems',jsonb_build_array(lp),1,'fixture'),('tasks',jsonb_build_array(done_task,unrelated_task),1,'fixture');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values(run_id,'jwb-open-api-schedule',revision,'complete',jsonb_build_object('start',source_day,'end',source_day));
  insert into internal.jiaowubao_open_api_schedule_snapshot_current values('jwb-open-api-schedule',run_id,revision,now());
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items values(run_id,'jwb-open-api:schedule:1',jsonb_build_object('record',jsonb_build_object('dated',source_day,'time_start','09:00','time_end','10:00','teacher_title','Synthetic Teacher','course_title','English - Synthetic Child试听','stu_list','[{"mem_id":"8001","name":"试听学员A"}]'::jsonb)));
  intent:=jsonb_build_object('lpItemId','LP-1','eventId','jwb-open-api:schedule:1','sourceRevision',revision,'sourceDate',source_day,'expectedVersions',versions);
  statement:=format('select * from public.confirm_trial_screenshot_atomic(%L,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L,%L::boolean)',
    'local-jwb-fixture',command_id,intent,versions,jsonb_build_array(next_lp),jsonb_build_array(done_task,unrelated_task),'Ella','true');
  perform internal.fixture_expect_failure(replace(statement,quote_literal('local-jwb-fixture'),quote_literal('wrong-secret')),'invalid_ops_secret');
  perform internal.fixture_expect_failure(replace(replace(statement,quote_literal('Ella'),quote_literal('Tiffany')),quote_literal('true')||'::boolean',quote_literal('false')||'::boolean'),'trial_screenshot_owner_scope_forbidden');
  update public.ops_state set version=2 where entity='students';
  perform internal.fixture_expect_failure(statement,'version_conflict');
  update public.ops_state set version=1 where entity='students';
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('b',64);
  perform internal.fixture_expect_failure(statement,'trial_screenshot_source_changed');
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('a',64),published_at=now()-interval '3 hours';
  perform internal.fixture_expect_failure(statement,'trial_screenshot_source_changed');
  update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now();
  perform internal.fixture_expect_failure(replace(statement,'Keep reviewed subject','Injected subject'),'trial_screenshot_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'human result','Injected result'),'trial_screenshot_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'Synthetic Child','Other Child'),'trial_screenshot_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,quote_literal(jsonb_build_array(next_lp)::text),quote_literal(jsonb_build_array(jsonb_set(next_lp,'{fields,trialDurationMinutes}','45'::jsonb))::text)),'trial_screenshot_duration_invalid');
  update public.ops_state set payload=jsonb_build_array(jsonb_set(lp,'{fields}',fields||'{"studentNameKnown":true,"studentName":"Other Child"}'::jsonb)) where entity='lpItems';
  perform internal.fixture_expect_failure(statement,'trial_screenshot_student_name_conflict');
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  update public.ops_state set payload=jsonb_build_array(lp||'{"resultStatus":"已取消"}'::jsonb) where entity='lpItems';
  perform internal.fixture_expect_failure(statement,'trial_screenshot_existing_event_conflict');
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  mutations:=(select count(*) from public.ops_mutation_log); audits:=(select count(*) from internal.operational_contract_audit);
  perform internal.fixture_expect_failure(replace(statement,quote_literal(jsonb_build_array(done_task,unrelated_task)::text),quote_literal(jsonb_build_array(unrelated_task)::text)),'jiaowubao_trial_completed_history_changed');
  if (select payload from public.ops_state where entity='lpItems')<>jsonb_build_array(lp) or (select version from public.ops_state where entity='lpItems')<>1
    or (select count(*) from public.ops_mutation_log)<>mutations or (select count(*) from internal.operational_contract_audit)<>audits then raise exception 'Nested transaction failed to roll back field enrichment'; end if;
  perform internal.fixture_expect_failure(replace(statement,quote_literal('true')||'::boolean',quote_literal('false')||'::boolean'),'trial_screenshot_source_scope_forbidden');
  begin
    update public.ops_state set payload=jsonb_build_array(student||'{"name":"Synthetic Child"}'::jsonb) where entity='students';
    execute replace(statement,quote_literal('true')||'::boolean',quote_literal('false')||'::boolean') into receipt;
    if not receipt.applied then raise exception 'Ordinary owner with exact current source identity did not confirm'; end if;
    raise exception using errcode='P0042',message='synthetic_scope_rollback';
  exception when sqlstate 'P0042' then null;
  end;
  update public.ops_state set payload=jsonb_build_array(lp,lp||jsonb_build_object('id','LP-2','stage','完成','trialSchedule',link)) where entity='lpItems';
  perform internal.fixture_expect_failure(replace(statement,quote_literal(jsonb_build_array(next_lp)::text),quote_literal(jsonb_build_array(next_lp,lp||jsonb_build_object('id','LP-2','stage','完成','trialSchedule',link))::text)),'jiaowubao_trial_event_already_linked');
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  old_students:=(select payload from public.ops_state where entity='students');
  execute statement into receipt;
  if not receipt.applied or (select payload from public.ops_state where entity='lpItems')<>jsonb_build_array(next_lp)
    or (select payload from public.ops_state where entity='students')<>old_students or (select version from public.ops_state where entity='students')<>1
    or (select payload from public.ops_state where entity='tasks')<>jsonb_build_array(done_task,unrelated_task)
    or not exists(select 1 from internal.trial_screenshot_commands c where c.command_key=command_id::uuid and c.command_intent=intent)
    or not exists(select 1 from internal.operational_contract_audit where action='trial.screenshot.confirm' and metadata->'fieldsBefore'=fields and metadata->'fieldsAfter'=next_lp->'fields') then raise exception 'Confirmation changed unrelated business data or lost audit'; end if;
  audits:=(select count(*) from internal.operational_contract_audit); mutations:=(select count(*) from public.ops_mutation_log);
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('c',64);
  execute statement into receipt;
  if receipt.applied or (select count(*) from internal.operational_contract_audit)<>audits or (select count(*) from public.ops_mutation_log)<>mutations then raise exception 'Uncertain-outcome replay wrote twice'; end if;
  select * into receipt from public.get_trial_screenshot_command_result('local-jwb-fixture',command_id,intent,'Ella',true);
  if receipt.command_key<>command_id or receipt.applied then raise exception 'Receipt replay missing'; end if;
  perform internal.fixture_expect_failure(replace(statement,quote_literal('Ella'),quote_literal('Tiffany')),'trial_screenshot_idempotency_conflict');
  perform internal.fixture_expect_failure(format('select * from public.get_trial_screenshot_command_result(%L,%L,%L::jsonb,%L,false)','local-jwb-fixture',command_id,intent,'Tiffany'),'trial_screenshot_idempotency_conflict');
  update public.ops_state set payload=jsonb_build_array(jsonb_set(student,'{owner}','"Tiffany"')) where entity='students';
  perform internal.fixture_expect_failure(format('select * from public.get_trial_screenshot_command_result(%L,%L,%L::jsonb,%L,false)','local-jwb-fixture',command_id,intent,'Ella'),'trial_screenshot_owner_scope_forbidden');
end;
$$;
rollback;

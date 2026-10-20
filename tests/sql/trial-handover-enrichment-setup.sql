\ir trial-screenshot-confirmation-setup.sql

create function internal.fixture_trial_handover_seed()
returns jsonb language plpgsql as $$
declare source_day text:=to_char((now()+interval '2 days') at time zone 'Australia/Melbourne','YYYY-MM-DD');
  started text; ended text; revision text:='sha256:'||repeat('a',64); run_id uuid:='36000000-0000-4000-8000-000000000001';
  student jsonb; lp jsonb; fields jsonb; link jsonb; tasks jsonb;
begin
  started:=to_char(((source_day||' 09:00')::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ended:=to_char(((source_day||' 10:00')::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  student:='{"id":"S-1","name":"Synthetic Child","guardianWechat":"Synthetic Parent","owner":"Ella","planner":"Tara","jwbSourceRow":null}';
  fields:='{"responsibleOperations":"Ella","assignedTeacher":" ","studentNameKnown":false,"studentName":"","subject":"Human subject","preferredTime":"Human preferred time","trialDurationMinutes":null,"trialPaymentMethod":"免费试听"}';
  lp:=jsonb_build_object('id','LP-1','studentId','S-1','workflowType','试听 LP','stage','待跟进','owner','Ella','trialPaid',true,'fields',fields,'trialIntake',jsonb_build_object('planner','Tara','requestSentAt',started,'contactParents',true,'contactStudent',false,'writingRequired',false,'paperRequired',false,'trialDurationMinutes',null,'studentName',''),'ledger',jsonb_build_object('scheduledAt','Manual display','result','Human result'));
  link:=jsonb_build_object('source','jiaowubao-open-api','sourceRevision',revision,'eventId','jwb-open-api:schedule:1','startsAt',started,'endsAt',ended,'courseName','English - Synthetic Child试听','teacherId',null,'teacherName','Synthetic Teacher','studentName','Synthetic Child','plannerHint','Tara','matchedAt',started,'durationMinutes',60,'sharedAccountLabel','试听学员A','sharedAccountLetter','a');
  tasks:='[{"id":"DONE","studentId":"S-1","title":"Completed history","owner":"Ella","status":"done","ruleKey":"trial.jiaowubao.today","anchorBookingId":"JWB:old","requestAnchorBookingId":"LP-1","result":"Human completion"},{"id":"OTHER","studentId":"S-2","title":"Unrelated task","owner":"Tiffany","status":"upcoming"}]';
  insert into public.ops_state(entity,payload,version,updated_by) values('students',jsonb_build_array(student),1,'fixture'),('lpItems',jsonb_build_array(lp),1,'fixture'),('tasks',tasks,1,'fixture');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values(run_id,'jwb-open-api-schedule',revision,'complete',jsonb_build_object('start',source_day,'end',source_day));
  insert into internal.jiaowubao_open_api_schedule_snapshot_current values('jwb-open-api-schedule',run_id,revision,now());
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items values(run_id,'jwb-open-api:schedule:1',jsonb_build_object('record',jsonb_build_object('dated',source_day,'time_start','09:00','time_end','10:00','teacher_title','Synthetic Teacher','course_title','English - Synthetic Child试听','stu_list','[{"mem_id":"8001","name":"试听学员A"}]'::jsonb)));
  return jsonb_build_object('lp',lp,'link',link,'student',student,'revision',revision,'sourceDay',source_day,'tasks',tasks,'runId',run_id);
end;
$$;

create function internal.fixture_trial_handover_call(p_key text,p_next jsonb,p_tasks jsonb,p_versions jsonb default '{"lpItems":1,"tasks":1}',p_version integer default 3)
returns text language sql as $$
  select format('select * from public.sync_jiaowubao_trial_matches_atomic_v%s(%L,%L,%L::jsonb,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L)',p_version,'local-jwb-fixture',p_key,
    jsonb_build_object('snapshotRevision',p_next#>>'{0,trialSchedule,sourceRevision}','window',jsonb_build_object('startsAt',p_next#>>'{0,trialSchedule,startsAt}','endsAt',p_next#>>'{0,trialSchedule,endsAt}'),'matches',jsonb_build_array(jsonb_build_object('lpItemId','LP-1','eventId','jwb-open-api:schedule:1','startsAt',p_next#>>'{0,trialSchedule,startsAt}')),'revocations','[]'::jsonb,'expectedVersions',p_versions),p_next#>>'{0,trialSchedule,sourceRevision}',
    jsonb_build_array(jsonb_build_object('lpItemId','LP-1','eventId','jwb-open-api:schedule:1','startsAt',p_next#>>'{0,trialSchedule,startsAt}')),'[]'::jsonb,p_versions,p_next,p_tasks,'Ella')
$$;

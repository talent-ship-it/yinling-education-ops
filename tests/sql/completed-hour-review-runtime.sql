\set ON_ERROR_STOP on
begin;
create function internal.expect_hour_failure(statement text,expected text)
returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm)=0 then raise exception 'Expected %, received %',expected,sqlerrm; end if;
    failed := true;
  end;
  if not failed then raise exception 'Expected failure: %',expected; end if;
end;
$$;

do $validator$
declare
  lesson jsonb := '{"kind":"lesson","sourceKey":"jwb-open-api:lesson:B1:C1:M1","completed":true,"branchId":"B1","calendarId":"C1","memberId":"M1","memberName":"Synthetic Student","lessonDate":"2026-09-01","timeTitle":"10:00","hours":1,"lessonType":1,"isTrial":false,"attendanceCode":1,"attendanceTitle":"Present","courseId":"1","courseTitle":"Math","teamId":null,"teamTitle":null,"teachers":[{"role":"primary","id":"J1","name":"Synthetic Tutor"}],"completedAt":null}'::jsonb;
  schedule jsonb := '{"kind":"schedule","sourceKey":"jwb-open-api:schedule:C1","completed":true,"calendarId":"C1","lessonDate":"2026-09-01","timeTitle":"10:00","courseId":"1","courseTitle":"Math","teamId":null,"teamTitle":null,"teachers":[{"role":"primary","id":"J1","name":"Synthetic Tutor","hours":1}],"completedAt":null}'::jsonb;
  lesson_page jsonb;
  schedule_page jsonb;
begin
  lesson_page := jsonb_build_array(jsonb_build_object('sourceKey',lesson->>'sourceKey','record',lesson));
  schedule_page := jsonb_build_array(jsonb_build_object('sourceKey',schedule->>'sourceKey','record',schedule));
  perform internal.assert_jiaowubao_completed_lesson_snapshot_page(lesson_page,date '2026-09-01');
  perform internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(schedule_page,date '2026-09-01');
  perform internal.assert_jiaowubao_completed_lesson_snapshot_page(jsonb_set(lesson_page,'{0,record}',lesson||'{"hours":58.53,"hoursIssue":"out_of_range"}'::jsonb),date '2026-09-01');
  perform internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(jsonb_set(schedule_page,'{0,record,teachers,0,hours}','null'::jsonb),date '2026-09-01');
  perform internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(jsonb_set(jsonb_set(schedule_page,'{0,record,teachers,0,hours}','null'::jsonb),'{0,record,teachers,0,hoursIssue}','"non_numeric"'::jsonb),date '2026-09-01');
  perform internal.expect_hour_failure(format('select internal.assert_jiaowubao_completed_lesson_snapshot_page(%L::jsonb,date %L)',
    jsonb_set(lesson_page,'{0,record,hours}','null'::jsonb)::text,'2026-09-01'), 'snapshot_page_invalid');
  perform internal.expect_hour_failure(format('select internal.assert_jiaowubao_completed_lesson_snapshot_page(%L::jsonb,date %L)',
    jsonb_set(lesson_page,'{0,record,hours}','58.53'::jsonb)::text,'2026-09-01'), 'snapshot_page_invalid');
  perform internal.expect_hour_failure(format('select internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(%L::jsonb,date %L)',
    jsonb_set(schedule_page,'{0,record,teachers,0,hours}','58.53'::jsonb)::text,'2026-09-01'), 'snapshot_schedule_page_invalid');
  perform internal.expect_hour_failure(format('select internal.assert_jiaowubao_completed_lesson_snapshot_page(%L::jsonb,date %L)',
    jsonb_set(lesson_page,'{0,record,hoursIssue}','null'::jsonb)::text,'2026-09-01'), 'snapshot_page_invalid');
  perform internal.expect_hour_failure(format('select internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(%L::jsonb,date %L)',
    jsonb_set(schedule_page,'{0,record,teachers,0,hoursIssue}','"missing"'::jsonb)::text,'2026-09-01'), 'snapshot_schedule_page_invalid');
end
$validator$;

do $teacher_identity$
declare
  role jsonb := '{"id":"J1","name":"Synthetic Tutor"}'::jsonb;
  roster jsonb := '[{"id":"T1","name":"Synthetic Tutor","jwbSourceRow":"J1"},{"id":"T2","name":"Other Tutor","jwbSourceRow":"J2"}]'::jsonb;
begin
  if not internal.jiaowubao_payroll_role_matches_teacher(role,roster,'T1')
     or not internal.jiaowubao_payroll_role_matches_teacher(role - 'id',roster,'T1')
     or not internal.jiaowubao_payroll_role_matches_teacher(role || '{"id":"J9"}'::jsonb,roster,'T1')
     or not internal.jiaowubao_payroll_role_matches_teacher(role,roster || '[{"id":"T3","name":"Third Tutor","jwbSourceRow":"J2"}]'::jsonb,'T1') then
    raise exception 'valid source-id or unique-name teacher match rejected';
  end if;
  if internal.jiaowubao_payroll_role_matches_teacher(role || '{"name":"Other Tutor"}'::jsonb,roster,'T1')
     or internal.jiaowubao_payroll_role_matches_teacher(role,roster || '[{"id":"T3","name":"Synthetic Tutor"}]'::jsonb,'T1')
     or internal.jiaowubao_payroll_role_matches_teacher(role,roster || '[{"id":"T3","name":"Third Tutor","jwbSourceRow":"J1"}]'::jsonb,'T1')
     or internal.jiaowubao_payroll_role_matches_teacher(role,'[{"id":"T1","name":null,"jwbSourceRow":"J1"}]'::jsonb,'T1') then
    raise exception 'ambiguous or invalid teacher identity accepted';
  end if;
  if not internal.jiaowubao_payroll_role_matches_teacher(
      '{"id":"J9","name":"龦龦 Zhang"}'::jsonb,
      '[{"id":"T1","name":"龦龦"}]'::jsonb,'T1')
     or not internal.jiaowubao_payroll_role_matches_teacher(
      '{"id":"J9","name":" ＳＹＮＴＨＥＴＩＣ   tutor "}'::jsonb,
      '[{"id":"T1","name":"synthetic Tutor"}]'::jsonb,'T1')
     or not internal.jiaowubao_payroll_role_matches_teacher(
      '{"id":"J9","name":"Synthetic Tutor (VIC)"}'::jsonb,
      '[{"id":"T1","name":"Synthetic Tutor"}]'::jsonb,'T1') then
    raise exception 'existing normalized teacher name match rejected';
  end if;
end
$teacher_identity$;

do $test$
declare
  run_id uuid := extensions.gen_random_uuid();
  source_revision text := 'sha256:'||repeat('a',64);
  projection_revision text;
  base_lesson jsonb;
  base_schedule jsonb;
  base_summary jsonb;
  payroll_next jsonb;
  teacher_payload jsonb;
  students_row public.ops_state%rowtype;
  teachers_row public.ops_state%rowtype;
begin
  teacher_payload := '[{"id":"T1","name":"Synthetic Tutor","jwbSourceRow":"J1"},{"id":"T2","name":"Other Tutor"}]'::jsonb;
  insert into public.ops_state(entity,payload,version,updated_at,updated_by) values
    ('bookings','[]',1,'2026-10-01 00:00:00+00','Nixon'),
    ('students','[]',3,'2026-10-01 00:00:00+00','Nixon'),
    ('teachers',teacher_payload,4,'2026-10-01 00:00:00+00','Nixon'),
    ('payroll','[]',1,'2026-10-01 00:00:00+00','Nixon');
  select * into students_row from public.ops_state where entity='students';
  select * into teachers_row from public.ops_state where entity='teachers';
  projection_revision := 'sha256:'||encode(extensions.digest(
    format('[{"entity":"students","version":%s,"updatedAt":"%s"},{"entity":"teachers","version":%s,"updatedAt":"%s"}]',
      students_row.version,to_char(students_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      teachers_row.version,to_char(teachers_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'sha256'),'hex');
  if projection_revision is distinct from 'sha256:fc736fcfcec7d3b814e1f13cdf8618e15f5a4370627b6c1eb6e1b56ed57054d7' then
    raise exception 'projection hash differs from JavaScript fixed vector';
  end if;
  insert into internal.jiaowubao_completed_lesson_snapshot_current(api_source_key,period_month,run_id,revision)
    values('jwb-open-api-completed-lessons','2026-09-01',run_id,source_revision);
  base_lesson := jsonb_build_object('sourceKey','jwb-open-api:lesson:B1:C1:M1','branchId','B1','calendarId','C1',
    'lessonDate','2026-09-01','timeTitle','10:00-11:00','courseTitle','Math','teamTitle','One',
    'hours',1,'isTrial',false,'teachers',jsonb_build_array(jsonb_build_object('role','primary','id','J1','name','Synthetic Tutor')));
  base_schedule := jsonb_build_object('calendarId','C1','lessonDate','2026-09-01','timeTitle','10:00-11:00',
    'courseTitle','Math','teamTitle','One','teachers',jsonb_build_array(jsonb_build_object(
      'role','primary','id','J1','name','Synthetic Tutor','hours',1)));
  insert into internal.jiaowubao_completed_lesson_snapshot_items(run_id,source_key,item)
    values(run_id,base_lesson->>'sourceKey',base_lesson);
  insert into internal.jiaowubao_completed_lesson_snapshot_schedule_events(run_id,calendar_id,event)
    values(run_id,'C1',base_schedule);
  base_summary := jsonb_build_object('id','P1','teacherId','T1','source','jiaowubao-completed-lessons',
    'month','2026-09','sourceRevision',source_revision,'sourceProjectionRevision',projection_revision,
    'sourceHours',1,'teacherTotalHours',1,'sourceLessonCount',1,'trialLessons',0,'lessons',1,
    'lines',jsonb_build_array(jsonb_build_object('sourceKey',base_lesson->>'sourceKey','hours',1,'evidenceOnly',true)));
  payroll_next := jsonb_build_array(base_summary);
  perform public.put_scoped_ops_state('synthetic-hour-secret','payroll',payroll_next,1,'Nixon',null);
  if (select version from public.ops_state where entity='payroll') <> 2 then raise exception 'normal source payroll not saved'; end if;
  insert into internal.jiaowubao_completed_lesson_snapshot_schedule_events(run_id,calendar_id,event)
    values(run_id,'C2',base_schedule || jsonb_build_object('calendarId','C2',
      'teachers',jsonb_build_array(jsonb_build_object('role','primary','id','J1','name','Other Tutor','hours',1))));
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_teacher_unverified');
  delete from internal.jiaowubao_completed_lesson_snapshot_schedule_events
    where calendar_id='C2';
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'bad-secret','payroll',payroll_next::text,2,'Nixon'), 'invalid_ops_secret');
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',payroll_next::text,2,'Other'), 'jiaowubao_payroll_actor_forbidden');
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('sourceHours',2))::text,2,'Nixon'),
    'jiaowubao_payroll_source_unverified');
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('lines','[]'::jsonb))::text,2,'Nixon'),
    'jiaowubao_payroll_source_unverified');
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('sourceRevision','sha256:'||repeat('b',64)))::text,2,'Nixon'),
    'jiaowubao_payroll_source_stale');
  update internal.jiaowubao_completed_lesson_snapshot_current set revision='sha256:'||repeat('b',64);
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_source_stale');
  update internal.jiaowubao_completed_lesson_snapshot_current set revision=source_revision;
  update public.ops_state set version=5 where entity='teachers';
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_projection_stale');
  update public.ops_state set version=4 where entity='teachers';
  update internal.jiaowubao_completed_lesson_snapshot_items set item=jsonb_set(item,'{hours}','58.53'::jsonb)||'{"hoursIssue":"out_of_range"}'::jsonb;
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_student_hours_unresolved');
  update internal.jiaowubao_completed_lesson_snapshot_items set item=base_lesson;
  update internal.jiaowubao_completed_lesson_snapshot_schedule_events
    set event=jsonb_set(event,'{teachers,0,hours}','58.53'::jsonb);
  update internal.jiaowubao_completed_lesson_snapshot_schedule_events
    set event=jsonb_set(event,'{teachers,0,hoursIssue}','"out_of_range"'::jsonb);
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_teacher_hours_unresolved');
  update internal.jiaowubao_completed_lesson_snapshot_schedule_events set event=base_schedule;
  update internal.jiaowubao_completed_lesson_snapshot_items set item=jsonb_set(item,'{branchId}','"~"'::jsonb);
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_student_hours_unresolved');
  update internal.jiaowubao_completed_lesson_snapshot_items set item=base_lesson;
  update internal.jiaowubao_completed_lesson_snapshot_items set item=jsonb_set(item,'{courseTitle}','"English"'::jsonb);
  perform internal.expect_hour_failure(
    format('select public.put_scoped_ops_state(%L,%L,%L::jsonb,%s,%L,null)',
      'synthetic-hour-secret','payroll',jsonb_build_array(base_summary||jsonb_build_object('status','已锁定'))::text,2,'Nixon'),
    'jiaowubao_payroll_student_hours_unresolved');
  update internal.jiaowubao_completed_lesson_snapshot_items set item=base_lesson;
  update public.ops_state set payload='[{"id":"T1","name":"Synthetic Tutor"}]'::jsonb,
    version=5,updated_at='2026-10-01 00:00:01+00' where entity='teachers';
  select * into teachers_row from public.ops_state where entity='teachers';
  projection_revision := 'sha256:'||encode(extensions.digest(
    format('[{"entity":"students","version":%s,"updatedAt":"%s"},{"entity":"teachers","version":%s,"updatedAt":"%s"}]',
      students_row.version,to_char(students_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      teachers_row.version,to_char(teachers_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'sha256'),'hex');
  base_summary := base_summary || jsonb_build_object('sourceProjectionRevision',projection_revision,'status','已锁定');
  perform public.put_scoped_ops_state('synthetic-hour-secret','payroll',jsonb_build_array(base_summary),2,'Nixon',null);
  if (select version from public.ops_state where entity='payroll') <> 3 then
    raise exception 'unique-name-only teacher source payroll not saved';
  end if;
end
$test$;
do $performance$
declare
  perf_run_id uuid := extensions.gen_random_uuid();
  roster jsonb;
  payroll_next jsonb;
  source_revision text := 'sha256:'||repeat('c',64);
  projection_revision text;
  students_row public.ops_state%rowtype;
  teachers_row public.ops_state%rowtype;
  started_at timestamptz;
  elapsed_ms numeric;
begin
  select jsonb_agg(jsonb_build_object('id','T'||lpad(n::text,3,'0'),
    'name','Synthetic Tutor '||n,'jwbSourceRow','J'||lpad(n::text,3,'0')))
    into roster from generate_series(1,102) n;
  update public.ops_state set payload=roster,version=6,updated_at='2026-10-01 00:00:02+00'
    where entity='teachers';
  select * into students_row from public.ops_state where entity='students';
  select * into teachers_row from public.ops_state where entity='teachers';
  projection_revision := 'sha256:'||encode(extensions.digest(
    format('[{"entity":"students","version":%s,"updatedAt":"%s"},{"entity":"teachers","version":%s,"updatedAt":"%s"}]',
      students_row.version,to_char(students_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      teachers_row.version,to_char(teachers_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'sha256'),'hex');
  update internal.jiaowubao_completed_lesson_snapshot_current
    set run_id=perf_run_id,revision=source_revision;
  insert into internal.jiaowubao_completed_lesson_snapshot_schedule_events(run_id,calendar_id,event)
  select perf_run_id,'C'||lpad(n::text,4,'0'),jsonb_build_object(
    'calendarId','C'||lpad(n::text,4,'0'),'lessonDate','2026-09-01',
    'timeTitle','10:00','courseTitle','Math','teamTitle','One',
    'teachers',jsonb_build_array(jsonb_build_object('role','primary',
      'id','J'||lpad((((n-1)%102)+1)::text,3,'0'),
      'name','Synthetic Tutor '||(((n-1)%102)+1),'hours',1)))
  from generate_series(1,2045) n;
  insert into internal.jiaowubao_completed_lesson_snapshot_items(run_id,source_key,item)
  select perf_run_id,'jwb-open-api:lesson:B1:C'||lpad(n::text,4,'0')||':M'||lpad(n::text,4,'0'),
    jsonb_build_object('sourceKey','jwb-open-api:lesson:B1:C'||lpad(n::text,4,'0')||':M'||lpad(n::text,4,'0'),
      'branchId','B1','calendarId','C'||lpad(n::text,4,'0'),'lessonDate','2026-09-01',
      'timeTitle','10:00','courseTitle','Math','teamTitle','One','hours',1,'isTrial',false,
      'teachers',jsonb_build_array(jsonb_build_object('role','primary',
        'id','J'||lpad((((n-1)%102)+1)::text,3,'0'),
        'name','Synthetic Tutor '||(((n-1)%102)+1))))
  from generate_series(1,2045) n;
  select jsonb_agg(jsonb_build_object(
    'id','P'||lpad(t::text,3,'0'),'teacherId','T'||lpad(t::text,3,'0'),
    'source','jiaowubao-completed-lessons','month','2026-09',
    'sourceRevision',source_revision,'sourceProjectionRevision',projection_revision,
    'sourceHours',source_lesson_count,'teacherTotalHours',source_lesson_count,
    'sourceLessonCount',source_lesson_count,'trialLessons',0,'lessons',source_lesson_count,
    'lines',source_lines)) into payroll_next
  from generate_series(1,102) t
  cross join lateral (
    select count(*) as source_lesson_count,
      jsonb_agg(jsonb_build_object('sourceKey','jwb-open-api:lesson:B1:C'||lpad(n::text,4,'0')||':M'||lpad(n::text,4,'0'),
        'hours',1,'evidenceOnly',true)) as source_lines
    from generate_series(1,2045) n where ((n-1)%102)+1=t
  ) lessons;
  payroll_next := (select payload from public.ops_state where entity='payroll') || payroll_next;
  started_at := clock_timestamp();
  perform public.put_scoped_ops_state('synthetic-hour-secret','payroll',payroll_next,3,'Nixon',null);
  elapsed_ms := extract(milliseconds from clock_timestamp()-started_at);
  if (select version from public.ops_state where entity='payroll') <> 4 then
    raise exception 'September-scale payroll batch not saved';
  end if;
  raise notice 'September-scale synthetic payroll guard: 2045 events, 102 teachers, % ms',elapsed_ms;
end
$performance$;
rollback;

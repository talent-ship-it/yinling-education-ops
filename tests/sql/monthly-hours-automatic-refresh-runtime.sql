\ir assert-disposable-database.sql
\set ON_ERROR_STOP on
create function internal.expect_monthly_failure(statement text, expected text) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm) = 0 then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Expected failure: %', expected; end if;
end;
$$;

insert into internal.student_import_source_rows values
 ('jwb','synthetic-catalog','synthetic-revision','[{"sourceRow":1}]',1,
 encode(extensions.digest('[{"sourceRow":1}]'::jsonb::text,'sha256'),'hex'));

create function internal.fixture_monthly_envelope(month_value date, cutoff date, revision_value text, previous_revision text)
returns jsonb language sql as $$
 select jsonb_build_object('apiSourceKey','jwb-open-api-completed-lessons','month',to_char(month_value,'YYYY-MM'),
 'revision',revision_value,'expectedCurrentRevision',previous_revision,
 'expectedPageCount',0,'expectedRowCount',0,'expectedSchedulePageCount',0,'expectedScheduleRowCount',0,
 'externalManifestSha256',revision_value,'query',jsonb_build_object(
 'lessons',jsonb_build_object('start',month_value::text,'end',cutoff::text,'sign',-1,'over',1,'limit',100),
 'schedules',jsonb_build_object('start',month_value::text,'end',cutoff::text,'over',1,'limit',100,'order','asc')),
 'sourceMetadata',jsonb_build_object('exportFormat','jiaowubao-completed-month-evidence/v1','manifestSha256',revision_value,
 'lessonManifestSha256',revision_value,'lessonRecordsSha256',revision_value,'scheduleManifestSha256',revision_value,
 'scheduleRecordsSha256',revision_value,'joinRule','schedule-cal-id-v1'))
$$;

create function internal.fixture_begin_month(month_value date, cutoff date, previous_revision text default null)
returns jsonb language plpgsql as $$
begin
 perform public.claim_jiaowubao_completed_lesson_sync_lease('synthetic-hour-secret',to_char(month_value,'YYYY-MM'),'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),'Ops Admin');
 return public.begin_jiaowubao_completed_lesson_member_collection_window('synthetic-hour-secret',to_char(month_value,'YYYY-MM'),cutoff::text,
 'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),'sha256:'||repeat('a',64),'[]','sha256:'||encode(extensions.digest('','sha256'),'hex'),previous_revision,false,'Ops Admin');
end;
$$;

create function internal.fixture_publish_full_month(month_value date) returns void language plpgsql as $$
declare envelope jsonb; receipt jsonb; revision_value text := 'sha256:'||encode(extensions.digest(month_value::text,'sha256'),'hex');
begin
 envelope := internal.fixture_monthly_envelope(month_value,(month_value+interval '1 month - 1 day')::date,revision_value,null);
 receipt := public.begin_jiaowubao_completed_lesson_snapshot_ingest('synthetic-hour-secret',envelope,'Ops Admin');
 perform public.complete_jiaowubao_completed_lesson_snapshot_ingest('synthetic-hour-secret',(receipt->>'runId')::uuid,'Ops Admin');
end;
$$;

begin;
do $window$
declare
 today date := timezone('Australia/Melbourne',clock_timestamp())::date;
 month_value date := date_trunc('month',today)::date;
 cutoff date;
 first_run jsonb; second_run jsonb; receipt jsonb; envelope jsonb; page_value jsonb;
 revision_value text := 'sha256:'||repeat('b',64);
 source_run uuid;
begin
 if today = month_value then month_value := (month_value-interval '1 month')::date; end if;
 cutoff := least(today-1,(month_value+interval '1 month - 2 days')::date);
 first_run := internal.fixture_begin_month(month_value,cutoff);
 second_run := internal.fixture_begin_month(month_value,cutoff);
 if first_run->>'runId' is distinct from second_run->>'runId' or first_run->>'dataThrough' is distinct from cutoff::text then
   raise exception 'same cutoff did not resume exact run';
 end if;
 perform internal.expect_monthly_failure(format('update internal.jiaowubao_completed_lesson_member_runs set data_through=%L::date where id=%L::uuid',
 cutoff-1,first_run->>'runId'),'immutable');
 perform internal.expect_monthly_failure(format('select internal.fixture_begin_month(%L::date,%L::date)',month_value,today),'cutoff_invalid');
 envelope := internal.fixture_monthly_envelope(month_value,cutoff,revision_value,null);
 perform internal.expect_monthly_failure(format('select public.begin_jiaowubao_completed_lesson_snapshot_ingest(%L,%L::jsonb,%L)',
 'synthetic-hour-secret',envelope,'Ops Admin'),'cutoff_unverified');
 receipt := public.stage_jiaowubao_completed_lesson_member_page('synthetic-hour-secret',(first_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),1,1,0,0,'[]','Ops Admin');
 perform public.prepare_jiaowubao_completed_lesson_member_publication('synthetic-hour-secret',(first_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),revision_value,'Ops Admin');
 receipt := public.begin_jiaowubao_completed_lesson_snapshot_ingest('synthetic-hour-secret',envelope,'Ops Admin');
 source_run := (receipt->>'runId')::uuid;
 if exists(select 1 from internal.jiaowubao_completed_lesson_snapshot_current where period_month=month_value) then
   raise exception 'staging moved pointer before complete';
 end if;
 perform public.complete_jiaowubao_completed_lesson_snapshot_ingest('synthetic-hour-secret',source_run,'Ops Admin');
 receipt := public.complete_jiaowubao_completed_lesson_member_publication('synthetic-hour-secret',(first_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),revision_value,'Ops Admin');
 if receipt->>'publishedAt' is null then raise exception 'refresh receipt lacks completion time'; end if;
 page_value := public.get_jiaowubao_completed_lesson_snapshot_page('synthetic-hour-secret',to_char(month_value,'YYYY-MM'),0,null,'Ops Admin');
 if page_value->>'state' <> 'complete' or page_value->>'dataThrough' <> cutoff::text or page_value->>'provisional' <> 'true' then
   raise exception 'learner reader lost cutoff metadata: %',page_value;
 end if;
 page_value := public.get_jiaowubao_completed_lesson_snapshot_schedule_page('synthetic-hour-secret',to_char(month_value,'YYYY-MM'),0,null,'Ops Admin');
 if page_value->>'dataThrough' <> cutoff::text or page_value->>'provisional' <> 'true' then raise exception 'dual source coverage differs'; end if;
 perform internal.expect_monthly_failure(format('select internal.assert_jiaowubao_payroll_source_summary(%L::jsonb,%L::jsonb,%L::jsonb)',
 jsonb_build_object('source','jiaowubao-completed-lessons','month',to_char(month_value,'YYYY-MM'),'teacherId','T1',
 'sourceRevision',revision_value,'sourceProjectionRevision',revision_value,'lines','[]'::jsonb),
 '[]',jsonb_build_object('runId',source_run,'revision',revision_value)),'month_provisional');
 second_run := internal.fixture_begin_month(month_value,cutoff,revision_value);
 if first_run->>'runId' = second_run->>'runId' then raise exception 'refresh reused terminal run'; end if;
 receipt := public.stage_jiaowubao_completed_lesson_member_page('synthetic-hour-secret',(second_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),1,1,0,0,'[]','Ops Admin');
 perform public.prepare_jiaowubao_completed_lesson_member_publication('synthetic-hour-secret',(second_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),revision_value,'Ops Admin');
 receipt := public.complete_jiaowubao_completed_lesson_member_publication('synthetic-hour-secret',(second_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),revision_value,'Ops Admin');
 if receipt->>'state' <> 'published' or (receipt->>'publishedAt')::timestamptz <=
   (select published_at from internal.jiaowubao_completed_lesson_member_runs where id=(first_run->>'runId')::uuid) then
   raise exception 'same revision refresh did not record a new successful check time';
 end if;
 second_run := internal.fixture_begin_month(month_value,cutoff,revision_value);
 page_value := public.get_jiaowubao_completed_lesson_snapshot_page('synthetic-hour-secret',to_char(month_value,'YYYY-MM'),0,null,'Ops Admin');
 if page_value->>'revision' <> revision_value or page_value->>'state' <> 'complete' then raise exception 'refresh hid published evidence'; end if;
 perform public.abort_jiaowubao_completed_lesson_member_collection('synthetic-hour-secret',(second_run->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM'),'caller_failure','Ops Admin');
 receipt := internal.fixture_begin_month(month_value,cutoff,revision_value);
 if receipt->>'runId' <> second_run->>'runId' or receipt->>'state' <> 'blocked' then raise exception 'blocked run restarted'; end if;
end;
$window$;
rollback;

begin;
do $fairness$
declare
 today date := timezone('Australia/Melbourne',clock_timestamp())::date;
 current_month date := date_trunc('month',today)::date;
 previous_month date := (current_month-interval '1 month')::date;
 older_month date := (current_month-interval '2 months')::date;
 oldest_month date := (current_month-interval '3 months')::date;
 receipt jsonb; chosen text; expected text;
begin
 perform internal.fixture_publish_full_month(previous_month);
 perform internal.fixture_publish_full_month(older_month);
 perform internal.fixture_publish_full_month(oldest_month);
 if today > current_month then
   receipt := internal.fixture_begin_month(current_month,today-1);
   if public.get_jiaowubao_completed_lesson_pending_month('synthetic-hour-secret','Ops Admin')->>'month' <> to_char(current_month,'YYYY-MM') then
     raise exception 'active current month was not selected';
   end if;
   perform public.abort_jiaowubao_completed_lesson_member_collection('synthetic-hour-secret',(receipt->>'runId')::uuid,'jwb-completed-lessons-sync:1000000000000:'||to_char(current_month,'YYYY-MM'),'caller_failure','Ops Admin');
 end if;
 update internal.jiaowubao_completed_lesson_snapshot_current set published_at=clock_timestamp()-interval '10 days' where period_month=oldest_month;
 update internal.jiaowubao_completed_lesson_snapshot_current set published_at=clock_timestamp()-interval '8 days' where period_month=older_month;
 chosen := public.get_jiaowubao_completed_lesson_pending_month('synthetic-hour-secret','Ops Admin')->>'month';
 if chosen <> to_char(oldest_month,'YYYY-MM') then raise exception 'oldest overdue month starved: %', chosen; end if;
 update internal.jiaowubao_completed_lesson_snapshot_current set published_at=clock_timestamp() where period_month=oldest_month;
 chosen := public.get_jiaowubao_completed_lesson_pending_month('synthetic-hour-secret','Ops Admin')->>'month';
 if chosen <> to_char(older_month,'YYYY-MM') then raise exception 'rotation repeated completed month'; end if;
 update internal.jiaowubao_completed_lesson_snapshot_current set published_at=clock_timestamp() where period_month=older_month;
 chosen := public.get_jiaowubao_completed_lesson_pending_month('synthetic-hour-secret','Ops Admin')->>'month';
 if chosen is not null then raise exception 'fresh/blocked months should not start work: %',chosen; end if;
 update internal.jiaowubao_completed_lesson_snapshot_current set published_at=clock_timestamp()-interval '25 hours' where period_month=previous_month;
 chosen := public.get_jiaowubao_completed_lesson_pending_month('synthetic-hour-secret','Ops Admin')->>'month';
 if chosen <> to_char(previous_month,'YYYY-MM') then raise exception 'previous month did not refresh daily'; end if;
 receipt := internal.fixture_begin_month(older_month,(older_month+interval '1 month - 1 day')::date,
   (select revision from internal.jiaowubao_completed_lesson_snapshot_current where period_month=older_month));
 chosen := public.get_jiaowubao_completed_lesson_pending_month('synthetic-hour-secret','Ops Admin')->>'month';
 if chosen <> to_char(older_month,'YYYY-MM') then raise exception 'active work was restarted behind overdue work'; end if;
end;
$fairness$;
rollback;

begin;
do $bounded_pages$
declare
 today date := timezone('Australia/Melbourne',clock_timestamp())::date;
 month_value date := date_trunc('month',today)::date;
 cutoff date; run_key text; member_run jsonb; receipt jsonb; envelope jsonb; lesson jsonb; schedule_row jsonb; rows_value jsonb;
 revision_value text := 'sha256:'||repeat('c',64);
 snapshot_id uuid;
begin
 if today = month_value then month_value := (month_value-interval '1 month')::date; end if;
 cutoff := least(today-1,(month_value+interval '1 month - 2 days')::date);
 run_key := 'jwb-completed-lessons-sync:1000000000000:'||to_char(month_value,'YYYY-MM');
 member_run := internal.fixture_begin_month(month_value,cutoff);
 lesson := '{"kind":"lesson","sourceKey":"jwb-open-api:lesson:B1:C1:1","completed":true,"branchId":"B1","calendarId":"C1","memberId":"1","memberName":"Synthetic Student","timeTitle":"10:00","hours":1,"lessonType":1,"isTrial":false,"attendanceCode":1,"attendanceTitle":"Present","courseId":"1","courseTitle":"Math","teamId":null,"teamTitle":null,"teachers":[{"role":"primary","id":"J1","name":"Synthetic Tutor"}],"completedAt":null}'::jsonb || jsonb_build_object('lessonDate',cutoff);
 rows_value := jsonb_build_array(jsonb_build_object('sourceKey',lesson->>'sourceKey','record',lesson));
 perform internal.expect_monthly_failure(format('select public.stage_jiaowubao_completed_lesson_member_page(%L,%L::uuid,%L,1,1,0,1,%L::jsonb,%L)',
 'synthetic-hour-secret',member_run->>'runId',run_key,jsonb_set(rows_value,'{0,record,lessonDate}',to_jsonb((cutoff+1)::text)),'Ops Admin'),'cutoff_invalid');
 receipt := public.stage_jiaowubao_completed_lesson_member_page('synthetic-hour-secret',(member_run->>'runId')::uuid,run_key,1,1,0,1,rows_value,'Ops Admin');
 perform public.prepare_jiaowubao_completed_lesson_member_publication('synthetic-hour-secret',(member_run->>'runId')::uuid,run_key,revision_value,'Ops Admin');
 envelope := internal.fixture_monthly_envelope(month_value,cutoff,revision_value,null)
   || '{"expectedPageCount":1,"expectedRowCount":1,"expectedSchedulePageCount":1,"expectedScheduleRowCount":1}'::jsonb;
 receipt := public.begin_jiaowubao_completed_lesson_snapshot_ingest('synthetic-hour-secret',envelope,'Ops Admin');
 snapshot_id := (receipt->>'runId')::uuid;
 perform internal.expect_monthly_failure(format('select public.stage_jiaowubao_completed_lesson_snapshot_page(%L,%L::uuid,0,%L::jsonb,%L)',
 'synthetic-hour-secret',snapshot_id,jsonb_set(rows_value,'{0,record,lessonDate}',to_jsonb((cutoff+1)::text)),'Ops Admin'),'cutoff_invalid');
 perform public.stage_jiaowubao_completed_lesson_snapshot_page('synthetic-hour-secret',snapshot_id,0,rows_value,'Ops Admin');
 schedule_row := '{"kind":"schedule","sourceKey":"jwb-open-api:schedule:C1","completed":true,"calendarId":"C1","timeTitle":"10:00","courseId":"1","courseTitle":"Math","teamId":null,"teamTitle":null,"teachers":[{"role":"primary","id":"J1","name":"Synthetic Tutor","hours":1}],"completedAt":null}'::jsonb || jsonb_build_object('lessonDate',cutoff);
 rows_value := jsonb_build_array(jsonb_build_object('sourceKey',schedule_row->>'sourceKey','record',schedule_row));
 perform internal.expect_monthly_failure(format('select public.stage_jiaowubao_completed_lesson_snapshot_schedule_page(%L,%L::uuid,0,%L::jsonb,%L)',
 'synthetic-hour-secret',snapshot_id,jsonb_set(rows_value,'{0,record,lessonDate}',to_jsonb((cutoff+1)::text)),'Ops Admin'),'cutoff_invalid');
 perform internal.expect_monthly_failure(format('select public.complete_jiaowubao_completed_lesson_snapshot_ingest(%L,%L::uuid,%L)',
 'synthetic-hour-secret',snapshot_id,'Ops Admin'),'incomplete');
 perform public.stage_jiaowubao_completed_lesson_snapshot_schedule_page('synthetic-hour-secret',snapshot_id,0,rows_value,'Ops Admin');
 receipt := public.complete_jiaowubao_completed_lesson_snapshot_ingest('synthetic-hour-secret',snapshot_id,'Ops Admin');
 if receipt->>'rowCount' <> '1' or receipt->>'scheduleRowCount' <> '1' then raise exception 'bounded dual-source publication lost rows'; end if;
end;
$bounded_pages$;
rollback;

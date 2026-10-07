\ir assert-disposable-database.sql
set jit = off;
set work_mem = '2184kB';
select internal.fixture_seed_reader(16);
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||jsonb_build_object('dated','2026-10-04'));
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record,stu_list}','[{"mem_id":"shared-a","name":"Shared Name"}]')
where source_key in ('jwb-open-api:schedule:1','jwb-open-api:schedule:2');
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||'{"dated":"2026-12-31","stu_list":[{"mem_id":"shared-b","name":"Shared Name"}]}')
where source_key='jwb-open-api:schedule:2';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||'{"stu_list":[{"mem_id":"missing-a","name":"Missing Name"}]}')
where source_key='jwb-open-api:schedule:3';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||'{"time_start":"bad","stu_list":[{"name":"Missing Name"}]}')
where source_key='jwb-open-api:schedule:4';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record,stu_list}','{"not":"an array"}')
where source_key='jwb-open-api:schedule:5';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record,stu_list}','[{"mem_id":" duplicate ","name":"Z label"},{"mem_id":"duplicate","name":"A label"},{"name":" Name only "},{"name":"Name only"},{"mem_id":"","name":" "}]')
where source_key='jwb-open-api:schedule:6';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record,stu_list}',(select jsonb_agg(jsonb_build_object('mem_id','crowd-'||i,'name','Crowd '||i)) from generate_series(1,105) i))
where source_key='jwb-open-api:schedule:7';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record,stu_list}','[{"mem_id":"unique-a","name":"张三 Zhang San"}]')
where source_key='jwb-open-api:schedule:8';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||'{"dated":"2026-12-30","time_end":"12:00"}')
where source_key='jwb-open-api:schedule:9';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||'{"teacher_title":"Other Teacher","dated":"2026-99-99"}')
where source_key='jwb-open-api:schedule:10';
update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
set item=jsonb_set(item,'{record}',(item->'record')||'{"time_start":"01:30","time_end":"03:30"}')
where source_key='jwb-open-api:schedule:11';
insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values (
  '20000000-0000-4000-8000-000000000002','jwb-open-api-schedule','sha256:'||repeat('b',64),'complete','{"start":"2026-10-02","end":"2027-01-02"}');
insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items
select '20000000-0000-4000-8000-000000000002',source_key,
  jsonb_set(item,'{record,course_title}','"Wrong revision course"')
from internal.jiaowubao_open_api_schedule_snapshot_ingest_items
where run_id='10000000-0000-4000-8000-000000000001';

create function internal.fixture_reader_semantics() returns void language plpgsql as $$
declare actual jsonb; item jsonb; request jsonb; cursor_value jsonb; seen text[]:='{}'; scope_request jsonb;
begin
  actual:=internal.fixture_assert_reader_equal('{}')->'result';
  assert actual->>'state'='complete' and jsonb_array_length(actual->'events')=12;
  assert actual->>'invalidTimeEventCount'='3';
  assert not exists(select 1 from jsonb_array_elements(actual->'events') e where e->>'courseName'='Wrong revision course');
  select e into item from jsonb_array_elements(actual->'events') e where e->>'eventId'='jwb-open-api:schedule:6';
  assert jsonb_array_length(item->'sourceParticipants')=2;
  assert item->'sourceParticipants' @> '[{"memberId":"duplicate","label":"A label"}]';
  select e into item from jsonb_array_elements(actual->'events') e where e->>'eventId'='jwb-open-api:schedule:7';
  assert jsonb_array_length(item->'sourceParticipants')=101 and (item->>'sourceStudentsTruncated')::boolean;
  select e into item from jsonb_array_elements(actual->'events') e where e->>'eventId'='jwb-open-api:schedule:5';
  assert item->'sourceParticipants'='[]'::jsonb;
  select e into item from jsonb_array_elements(actual->'events') e where e->>'eventId'='jwb-open-api:schedule:11';
  assert (item->>'endsAt')::timestamptz-(item->>'startsAt')::timestamptz=interval '1 hour';
  for scope_request in select value from jsonb_array_elements('[
    {},{"scope":"teacher","teacherLabels":[" Synthetic Teacher "]},
    {"scope":"teacher","teacherLabels":["synthetic teacher"]},
    {"scope":"teacher","teacherLabels":["Other Teacher"]},
    {"scope":"student","memberIds":["shared-a"]},
    {"scope":"student","nameKeys":["shared name"]},
    {"scope":"student","nameKeys":["missing name"]},
    {"scope":"student","nameKeys":["张三"]},
    {"scope":"student","memberIds":["s4"],"nameKeys":["shared name"]},
    {"scope":"availability","teacherLabels":["Synthetic Teacher"]}
  ]') loop
    perform internal.fixture_assert_reader_equal(scope_request);
  end loop;
  actual:=internal.fixture_assert_reader_equal('{"scope":"student","nameKeys":["shared name"]}')->'result';
  assert actual->'events'='[]'::jsonb;
  actual:=internal.fixture_assert_reader_equal('{"scope":"student","nameKeys":["missing name"]}')->'result';
  assert actual->'events'='[]'::jsonb and actual->>'invalidTimeEventCount'='0';
  actual:=internal.fixture_assert_reader_equal('{"scope":"student","nameKeys":["张三"]}')->'result';
  assert jsonb_array_length(actual->'events')=1;
  actual:=internal.fixture_assert_reader_equal('{"scope":"availability","teacherLabels":["Synthetic Teacher"]}')->'result';
  assert actual->>'invalidTimeEventCount'='0';
  assert not exists(select 1 from jsonb_array_elements(actual->'events') e where e->'sourceParticipants'<>'[]'::jsonb or (e->>'sourceStudentsTruncated')::boolean);
  request:='{"limit":3}';
  loop
    actual:=internal.fixture_assert_reader_equal(request)->'result';
    assert actual is not null;
    for item in select value from jsonb_array_elements(actual->'events') loop
      assert not ((item->>'eventId')=any(seen));
      seen:=array_append(seen,item->>'eventId');
    end loop;
    exit when not (actual->>'hasMore')::boolean;
    cursor_value:=actual->'nextCursor';
    request:=jsonb_build_object('limit',3,'cursorStart',cursor_value->>'startsAt','cursorEvent',cursor_value->>'eventId');
  end loop;
  assert cardinality(seen)=12;
  actual:=internal.fixture_assert_reader_equal(jsonb_build_object('revision','sha256:'||repeat('b',64)))->'result';
  assert actual->>'state'='reset';
  for request in select value from jsonb_array_elements('[
    {"secret":"wrong"},{"scope":"unknown"},{"limit":251},{"limit":0},
    {"start":"infinity"},{"end":"2027-01-01"},{"cursorEvent":"invalid event"},
    {"cursorStart":"2026-10-02T00:00:00Z"},{"revision":"invalid"},
    {"scope":"all","memberIds":["s1"]},
    {"scope":"teacher","teacherLabels":["Synthetic Teacher","synthetic teacher"]},
    {"scope":"student","nameKeys":["same","same"]},
    {"scope":"availability","teacherLabels":["Synthetic Teacher"],"memberIds":["s1"]}
  ]') loop
    actual:=internal.fixture_assert_reader_equal(request);
    assert actual ? 'sqlstate';
  end loop;
  assert (internal.fixture_assert_reader_equal('{"secret":"wrong"}')->>'sqlstate')='42501';
end;
$$;
select internal.fixture_reader_semantics();
set plan_cache_mode = force_generic_plan;
select internal.fixture_reader_semantics();
set plan_cache_mode = auto;
do $$
declare actual jsonb; routine regprocedure:='public.get_jiaowubao_open_api_schedule_snapshot_window(text,timestamptz,timestamptz,text,text[],text[],integer,timestamptz,text,text,text[])'::regprocedure;
begin
  assert has_function_privilege('anon',routine,'execute');
  assert has_function_privilege('authenticated',routine,'execute');
  assert not exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=routine and a.grantee=0 and a.privilege_type='EXECUTE');
  assert (select prosecdef and provolatile='s' and proconfig=array['search_path=""'] from pg_proc where oid=routine);
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='collecting' where id='10000000-0000-4000-8000-000000000001';
  actual:=internal.fixture_assert_reader_equal('{}'); assert actual->>'sqlstate'='55000';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='complete',query='{"start":"bad","end":"2027-01-02"}' where id='10000000-0000-4000-8000-000000000001';
  actual:=internal.fixture_assert_reader_equal('{}'); assert actual->>'sqlstate'='55000';
  delete from internal.jiaowubao_open_api_schedule_snapshot_current;
  actual:=internal.fixture_assert_reader_equal('{}')->'result'; assert actual->>'state'='absent';
end;
$$;

create function internal.fixture_assert_reader_page(p_case jsonb) returns void language plpgsql as $$
declare actual jsonb;
begin
  actual:=internal.fixture_reader_call('public.get_jiaowubao_open_api_schedule_snapshot_window',p_case)->'result';
  assert actual->>'state'='complete';
  assert jsonb_array_length(actual->'events')=250;
  assert (actual->>'hasMore')::boolean;
  assert actual->>'invalidTimeEventCount'='0';
end;
$$;
\timing on
select internal.fixture_seed_reader(4470);
set statement_timeout='3s';
select internal.fixture_assert_reader_page('{}');
select internal.fixture_assert_reader_page('{"cursorStart":"2026-10-05T01:00:00Z","cursorEvent":"jwb-open-api:schedule:4"}');
set plan_cache_mode=force_generic_plan;
select internal.fixture_assert_reader_page('{}');
select internal.fixture_assert_reader_page('{"cursorStart":"2026-10-05T01:00:00Z","cursorEvent":"jwb-open-api:schedule:4"}');
set statement_timeout=0;
select internal.fixture_seed_reader(6000);
set statement_timeout='3s';
select internal.fixture_assert_reader_page('{}');
select internal.fixture_assert_reader_page('{"cursorStart":"2026-10-05T01:00:00Z","cursorEvent":"jwb-open-api:schedule:4"}');
set plan_cache_mode=force_custom_plan;
select internal.fixture_assert_reader_page('{}');
select internal.fixture_assert_reader_page('{"cursorStart":"2026-10-05T01:00:00Z","cursorEvent":"jwb-open-api:schedule:4"}');
reset statement_timeout;
reset plan_cache_mode;
reset work_mem;

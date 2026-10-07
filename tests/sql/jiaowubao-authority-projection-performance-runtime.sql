\ir assert-disposable-database.sql

set statement_timeout = '3s';
set work_mem = '4MB';
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert internal.fixture_authority_result() = (select result from internal.fixture_authority_expected where phase = 'initial'),
    'Grouped matching must exactly preserve native state, mappings, ambiguity and quarantine';
  assert (select count(*) from internal.jiaowubao_authority_native_quarantine where active) = 2;
  assert not has_function_privilege('anon', 'public.apply_jiaowubao_open_api_authority_native(text,uuid,text)', 'execute');
  assert not has_function_privilege('anon', 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)', 'execute');
  assert has_function_privilege('anon', 'public.project_jiaowubao_open_api_authority(text,text,text)', 'execute');
  assert (select proconfig @> array['statement_timeout=110s'] from pg_proc
    where oid = 'public.project_jiaowubao_open_api_authority(text,text,text)'::regprocedure);
end;
$$;

do $$
declare
  source_row internal.jiaowubao_authority_projection_entities%rowtype;
  validation_case record;
  legacy_reason text;
  grouped_reason text;
begin
  select entity.* into strict source_row
  from internal.jiaowubao_authority_projection_entities entity
  where entity.projection_run_id = (select projection_run_id from internal.jiaowubao_authority_current)
    and entity.entity_type = 'schedule' and entity.source_native_id = '7';
  assert internal.jiaowubao_authority_native_schedule_skip_reason(
    source_row.projection_run_id, source_row.source_key, '7', source_row.payload) is null;
  assert internal.jiaowubao_authority_native_schedule_skip_reason(
    source_row.projection_run_id, source_row.source_key, '7', source_row.payload, false) is null,
    'The current source key alone is not a duplicate';
  begin
    insert into internal.jiaowubao_authority_projection_entities
    select (jsonb_populate_record(null::internal.jiaowubao_authority_projection_entities,
      to_jsonb(source_row) || jsonb_build_object('source_key', 'sha256:' || repeat('d', 64)))).*;
    assert (select count(*) from internal.jiaowubao_authority_projection_entities
      where projection_run_id = source_row.projection_run_id and entity_type = 'schedule' and source_native_id = '7') = 2;
    for validation_case in
      select * from (values
        ('7'::text, source_row.payload, 'duplicate_source_id'::text),
        (null, source_row.payload, 'missing_source_id'),
        (' 7', source_row.payload, 'invalid_source_id'),
        ('7', '[]'::jsonb, 'invalid_payload'),
        ('7', jsonb_set(jsonb_set(source_row.payload, '{dated}', '"invalid"'), '{teacher_id}', 'null'), 'invalid_date'),
        ('7', jsonb_set(source_row.payload, '{time_start}', '"25:00"'), 'invalid_start_time'),
        ('7', jsonb_set(source_row.payload, '{stu_list}', '{}'), 'invalid_student_list'),
        ('7', jsonb_set(source_row.payload, '{stu_list}', '[]'), 'participant_count_not_one'),
        ('7', jsonb_set(source_row.payload, '{stu_list,0,mem_id}', 'null'), 'missing_student_id'),
        ('7', jsonb_set(source_row.payload, '{teacher_id}', 'null'), 'missing_teacher_id'),
        ('7', jsonb_set(source_row.payload, '{course_id}', 'null'), 'missing_course_id')
      ) cases(source_id, payload, reason)
    loop
      legacy_reason := internal.jiaowubao_authority_native_schedule_skip_reason(
        source_row.projection_run_id, source_row.source_key, validation_case.source_id, validation_case.payload);
      grouped_reason := internal.jiaowubao_authority_native_schedule_skip_reason(
        source_row.projection_run_id, source_row.source_key, validation_case.source_id, validation_case.payload, true);
      assert legacy_reason = validation_case.reason and grouped_reason = legacy_reason,
        'Grouped duplicate lookup must preserve every earlier invalid-field reason';
    end loop;
    perform public.apply_jiaowubao_open_api_authority_native(
      'projection-job-fixture-secret', source_row.projection_run_id, 'Ops Admin');
    assert (select count(*) from internal.jiaowubao_authority_native_quarantine
      where projection_run_id = source_row.projection_run_id and entity_type = 'schedule'
        and source_native_id = '7' and reason = 'duplicate_source_id' and active) = 2;
    assert not exists (select 1 from internal.jiaowubao_authority_native_links
      where entity_type = 'schedule' and source_native_id = '7' and active),
      'Both conflicting source keys must remain quarantined rather than become native bookings';
    raise exception using errcode = 'Z0003';
  exception when sqlstate 'Z0003' then null;
  end;
  assert (select count(*) from internal.jiaowubao_authority_projection_entities
    where projection_run_id = source_row.projection_run_id and entity_type = 'schedule' and source_native_id = '7') = 1;
  assert not has_function_privilege('anon', 'internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb,boolean)', 'execute');
  assert not has_function_privilege('authenticated', 'internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb,boolean)', 'execute');
  assert not has_function_privilege('service_role', 'internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb,boolean)', 'execute');
  assert current_setting('work_mem') = '4MB', 'Function-local working memory must restore the caller setting';
end;
$$;

select internal.fixture_authority_native_edit();
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
declare rejected boolean := false;
begin
  assert internal.fixture_authority_result() = (select result from internal.fixture_authority_expected where phase = 'native_edit'),
    'A changed native version must refresh exact schedule matches without reusing old matches';
  assert (select projection.native_state_versions
    from internal.jiaowubao_authority_projection_runs projection
    join internal.jiaowubao_authority_current current_projection on current_projection.projection_run_id = projection.id)
    = (select jsonb_object_agg(entity, version) from public.ops_state);
  begin
    update internal.jiaowubao_authority_projection_entities set
      match_status = 'unmatched', match_strategy = null, matched_entity_id = null, conflict_type = 'not_found'
    where projection_run_id = (select projection_run_id from internal.jiaowubao_authority_current)
      and entity_type = 'schedule' and source_native_id = '7';
  exception when sqlstate '55000' then rejected := true;
  end;
  assert rejected, 'Inserting finalized schedule matches must not weaken completed projection immutability';
end;
$$;

select internal.fixture_seed_authority(4470, 6503, 754, 271, 2183);
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert (select count(*) from internal.jiaowubao_authority_native_links where entity_type = 'schedule' and active) = 4470;
  assert (select jsonb_array_length(payload) from public.ops_state where entity = 'bookings') = 6503;
  assert (select payload #>> '{0,unrelated}' from public.ops_state where entity = 'bookings') = 'preserved';
  assert (select count(*) from internal.jiaowubao_authority_native_quarantine where active) = 0;
end;
$$;

select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
declare before_result jsonb := internal.fixture_authority_result(); rejected boolean := false;
begin
  begin
    perform public.project_jiaowubao_open_api_authority('wrong', 'sha256:' || repeat('a', 64), 'Ops Admin');
  exception when insufficient_privilege then rejected := true;
  end;
  assert rejected;
  rejected := false;
  begin
    perform public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('b', 64), 'Ops Admin');
  exception when serialization_failure then rejected := true;
  end;
  assert rejected;
  assert internal.fixture_authority_result() = before_result, 'Rejected calls must leave all authority and native state unchanged';
  assert (select jsonb_array_length(payload) from public.ops_state where entity = 'bookings') = 6503;
end;
$$;

select internal.fixture_seed_authority(6000, 12000, 1109, 271, 2183);
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert (select count(*) from internal.jiaowubao_authority_native_links where entity_type = 'schedule' and active) = 6000;
  assert (select jsonb_array_length(payload) from public.ops_state where entity = 'bookings') = 12000;
end;
$$;

insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
select '10000000-0000-4000-8000-000000000002', api_source_key, 'sha256:' || repeat('b', 64), state, query, completed_at, expected_row_count
from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs;
insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items
select '10000000-0000-4000-8000-000000000002', source_key,
  case when source_key = 'jwb-open-api:schedule:1' then jsonb_set(item, '{record,dated}', '"2026-10-02"') else item end
from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
update internal.jiaowubao_open_api_schedule_snapshot_current set
  run_id = '10000000-0000-4000-8000-000000000002', revision = 'sha256:' || repeat('b', 64);
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('b', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert (select item ->> 'date' from public.ops_state,
    lateral jsonb_array_elements(payload) item where entity = 'bookings' and item ->> 'id' = 'book1') = '2026-10-02',
    'A new immutable snapshot must not reuse normalized entities from an older snapshot';
  assert (select snapshot_revision from internal.jiaowubao_authority_current) = 'sha256:' || repeat('b', 64);
end;
$$;

select internal.fixture_seed_authority(16, 20, 16, 16, 16);
create function internal.fixture_reject_teacher_write() returns trigger language plpgsql as $$
begin
  if new.entity = 'teachers' then raise exception using errcode = 'Z0002'; end if;
  return new;
end;
$$;
create trigger fixture_reject_teacher_write before update on public.ops_state
for each row execute function internal.fixture_reject_teacher_write();
do $$
declare before_result jsonb := internal.fixture_authority_result(); rejected boolean := false;
begin
  begin
    perform public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
  exception when sqlstate 'Z0002' then rejected := true;
  end;
  assert rejected;
  assert internal.fixture_authority_result() = before_result, 'A late write failure must roll back projection, links, quarantine and native documents together';
  assert (select count(*) from internal.operational_contract_audit) = 0;
  assert (select count(*) from internal.jiaowubao_authority_projection_runs) = 0;
  assert (select count(*) from internal.jiaowubao_authority_current) = 0;
  assert (select count(*) from public.ops_source_snapshots) = 0;
end;
$$;
reset statement_timeout;
reset work_mem;

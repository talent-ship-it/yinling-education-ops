\ir assert-disposable-database.sql

set statement_timeout = '3s';
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

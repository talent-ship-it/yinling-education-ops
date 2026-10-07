\ir assert-disposable-database.sql

set statement_timeout = '3s';
set work_mem = '4MB';
create temporary table fixture_preparation_receipt(receipt jsonb not null);
create temporary table fixture_visible_before as
select internal.fixture_authority_result() as result,
  (select jsonb_agg(to_jsonb(c)) from internal.jiaowubao_authority_current c) as current_pointer,
  (select jsonb_agg(to_jsonb(s)) from public.ops_source_snapshots s) as health;
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
do $$
declare
  repeated jsonb;
  original_id uuid := (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt);
  run_count integer := (select count(*) from internal.jiaowubao_authority_projection_runs);
  entity_count integer := (select count(*) from internal.jiaowubao_authority_projection_entities);
  rejected boolean;
  bad_input record;
begin
  assert internal.fixture_authority_result() = (select result from fixture_visible_before);
  assert (select jsonb_agg(to_jsonb(c)) from internal.jiaowubao_authority_current c)
    is not distinct from (select current_pointer from fixture_visible_before);
  assert (select jsonb_agg(to_jsonb(s)) from public.ops_source_snapshots s)
    is not distinct from (select health from fixture_visible_before),
    'Preparation must leave native documents, links, quarantine, public health and current projection untouched';
  repeated := public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
  assert (repeated ->> 'projectionRunId')::uuid = original_id and (repeated ->> 'replayed')::boolean;
  assert run_count = (select count(*) from internal.jiaowubao_authority_projection_runs)
    and entity_count = (select count(*) from internal.jiaowubao_authority_projection_entities),
    'An interrupted worker must reuse the exact immutable preparation';
  assert (select count(*) from internal.jiaowubao_authority_current) = 0;
  assert (select count(*) from public.ops_source_snapshots) = 0;
  for bad_input in select * from (values
    ('wrong'::text, 'Ops Admin'::text), (null, 'Ops Admin'),
    ('projection-job-fixture-secret', 'Nixon'), ('projection-job-fixture-secret', null)
  ) inputs(secret, actor)
  loop
    rejected := false;
    begin
      perform public.prepare_jiaowubao_open_api_authority(bad_input.secret, 'sha256:' || repeat('a', 64), bad_input.actor);
    exception when insufficient_privilege then rejected := true;
    end;
    assert rejected;
    rejected := false;
    begin
      perform public.complete_jiaowubao_open_api_authority(bad_input.secret, 'sha256:' || repeat('a', 64), original_id, bad_input.actor);
    exception when insufficient_privilege then rejected := true;
    end;
    assert rejected;
  end loop;
  rejected := false;
  begin
    perform public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), gen_random_uuid(), 'Ops Admin');
  exception when serialization_failure then
    assert sqlerrm = 'jiaowubao_authority_prepare_stale'; rejected := true;
  end;
  assert rejected;
  rejected := false;
  begin
    perform public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('b', 64), original_id, 'Ops Admin');
  exception when serialization_failure then
    assert sqlerrm = 'jiaowubao_authority_snapshot_revision_changed'; rejected := true;
  end;
  assert rejected;
  assert not has_function_privilege('anon', 'public.project_jiaowubao_open_api_authority_read_model(text,text,text,boolean)', 'execute');
  assert not has_function_privilege('authenticated', 'public.project_jiaowubao_open_api_authority_read_model(text,text,text,boolean)', 'execute');
  assert not has_function_privilege('service_role', 'public.project_jiaowubao_open_api_authority_read_model(text,text,text,boolean)', 'execute');
  assert has_function_privilege('anon', 'public.prepare_jiaowubao_open_api_authority(text,text,text)', 'execute');
  assert has_function_privilege('authenticated', 'public.complete_jiaowubao_open_api_authority(text,text,uuid,text)', 'execute');
end;
$$;
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
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
do $$
declare before_result jsonb := internal.fixture_authority_result(); rejected boolean := false;
  before_runs integer := (select count(*) from internal.jiaowubao_authority_projection_runs);
  before_pointer jsonb := (select to_jsonb(c) from internal.jiaowubao_authority_current c);
  before_health jsonb := (select to_jsonb(s) from public.ops_source_snapshots s);
begin
  begin
    perform public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
      (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin');
  exception when serialization_failure then
    assert sqlerrm = 'jiaowubao_authority_prepare_stale'; rejected := true;
  end;
  assert rejected;
  assert before_runs = (select count(*) from internal.jiaowubao_authority_projection_runs);
  assert before_result = internal.fixture_authority_result();
  assert before_pointer = (select to_jsonb(c) from internal.jiaowubao_authority_current c);
  assert before_health = (select to_jsonb(s) from public.ops_source_snapshots s),
    'Native-version drift must require preparation again without recomputing or publishing inside completion';
end;
$$;
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
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
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert (select count(*) from internal.jiaowubao_authority_native_links where entity_type = 'schedule' and active) = 4470;
  assert (select jsonb_array_length(payload) from public.ops_state where entity = 'bookings') = 6503;
  assert (select payload #>> '{0,unrelated}' from public.ops_state where entity = 'bookings') = 'preserved';
  assert (select count(*) from internal.jiaowubao_authority_native_quarantine where active) = 0;
end;
$$;

truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
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
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
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
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('b', 64), 'Ops Admin');
do $$
declare rejected boolean := false;
  before_pointer jsonb := (select to_jsonb(c) from internal.jiaowubao_authority_current c);
  before_health jsonb := (select to_jsonb(s) from public.ops_source_snapshots s);
  prior_id uuid := (select projection_run_id from internal.jiaowubao_authority_current);
begin
  assert before_pointer ->> 'snapshot_revision' = 'sha256:' || repeat('a', 64);
  assert before_health #>> '{payload,snapshotRevision}' = 'sha256:' || repeat('a', 64),
    'Preparing a new source revision must keep the previous published revision visible';
  begin
    perform public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('b', 64), prior_id, 'Ops Admin');
  exception when serialization_failure then
    assert sqlerrm = 'jiaowubao_authority_prepare_stale'; rejected := true;
  end;
  assert rejected, 'A prepared ID from another snapshot must never be applied';
  assert before_pointer = (select to_jsonb(c) from internal.jiaowubao_authority_current c);
  assert before_health = (select to_jsonb(s) from public.ops_source_snapshots s);
end;
$$;
select public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('b', 64),
  (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert (select item ->> 'date' from public.ops_state,
    lateral jsonb_array_elements(payload) item where entity = 'bookings' and item ->> 'id' = 'book1') = '2026-10-02',
    'A new immutable snapshot must not reuse normalized entities from an older snapshot';
  assert (select snapshot_revision from internal.jiaowubao_authority_current) = 'sha256:' || repeat('b', 64);
end;
$$;

select internal.fixture_seed_authority(16, 20, 16, 16, 16);
truncate fixture_preparation_receipt;
insert into fixture_preparation_receipt
select public.prepare_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
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
    perform public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
      (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin');
  exception when sqlstate 'Z0002' then rejected := true;
  end;
  assert rejected;
  assert internal.fixture_authority_result() = before_result, 'A late write failure must roll back projection, links, quarantine and native documents together';
  assert (select count(*) from internal.operational_contract_audit) = 1;
  assert (select count(*) from internal.jiaowubao_authority_projection_runs) = 1;
  assert (select summary <> '{}'::jsonb from internal.jiaowubao_authority_projection_runs),
    'A failed completion must preserve the earlier committed immutable preparation';
  assert (select count(*) from internal.jiaowubao_authority_current) = 0;
  assert (select count(*) from public.ops_source_snapshots) = 0;
end;
$$;
drop trigger fixture_reject_teacher_write on public.ops_state;
create function internal.fixture_reject_final_authority_health() returns trigger language plpgsql as $$
begin
  if new.payload ? 'nativeApply' then
    assert exists (select 1 from public.ops_state where version > 1),
      'The final publication failure must occur after native writes';
    raise exception using errcode = 'Z0004';
  end if;
  return new;
end;
$$;
create trigger fixture_reject_final_authority_health before update on public.ops_source_snapshots
for each row execute function internal.fixture_reject_final_authority_health();
do $$
declare before_result jsonb := internal.fixture_authority_result(); rejected boolean := false;
begin
  begin
    perform public.complete_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64),
      (select (receipt ->> 'projectionRunId')::uuid from fixture_preparation_receipt), 'Ops Admin');
  exception when sqlstate 'Z0004' then rejected := true;
  end;
  assert rejected;
  assert internal.fixture_authority_result() = before_result,
    'A final publication failure must roll back already written native data and the final projection together';
  assert (select count(*) from internal.operational_contract_audit) = 1;
  assert (select count(*) from internal.jiaowubao_authority_projection_runs) = 1;
  assert (select count(*) from internal.jiaowubao_authority_current) = 0;
  assert (select count(*) from public.ops_source_snapshots) = 0;
end;
$$;
drop trigger fixture_reject_final_authority_health on public.ops_source_snapshots;
select public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin') #> '{nativeApply,nativeCounts}';
do $$
begin
  assert (select count(*) from internal.jiaowubao_authority_current) = 1,
    'The original monolithic RPC must remain compatible';
end;
$$;
reset statement_timeout;
reset work_mem;

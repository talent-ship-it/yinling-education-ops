\set ON_ERROR_STOP on

-- Run against a disposable database migrated through 20260818000800. Capture
-- the exact provenance-trigger behavior before 170017, then apply it inside
-- the same transaction and compare JSONB, canonical ::text, and every tested
-- SQLSTATE/SQLERRM. All fixture values are synthetic and roll back.

begin;

-- A migrated-but-empty disposable database need not have application state
-- rows yet. Seed only the two rows this self-contained fixture touches; the
-- surrounding rollback leaves no residue.
insert into public.ops_state (entity, payload, version, updated_by)
values
  ('students', '[]'::jsonb, 1, 'provenance-parity-fixture'),
  ('tasks', '[]'::jsonb, 1, 'provenance-parity-fixture')
on conflict (entity) do update
set payload = excluded.payload,
  version = excluded.version,
  updated_by = excluded.updated_by;

create function pg_temp.provenance_seed_students(p_payload jsonb)
returns void
language plpgsql
as $$
begin
  perform pg_catalog.set_config('session_replication_role', 'replica', true);
  update public.ops_state
  set payload = p_payload,
    version = 1,
    updated_by = 'provenance-parity-fixture'
  where entity = 'students';
  perform pg_catalog.set_config('session_replication_role', 'origin', true);
  delete from internal.student_number_reservations reservation
  where reservation.student_id like 'PROV-PARITY-%'
     or reservation.student_id = '1'
     or reservation.student_number like '2088%';
end;
$$;

create function pg_temp.provenance_seed_tasks(p_payload jsonb)
returns void
language plpgsql
as $$
begin
  perform pg_catalog.set_config('session_replication_role', 'replica', true);
  update public.ops_state
  set payload = p_payload,
    version = 1,
    updated_by = 'provenance-parity-fixture'
  where entity = 'tasks';
  perform pg_catalog.set_config('session_replication_role', 'origin', true);
end;
$$;

create function pg_temp.provenance_try_students_update(p_payload jsonb)
returns jsonb
language plpgsql
as $$
declare
  output_payload jsonb;
begin
  update public.ops_state
  set payload = p_payload,
    updated_by = 'provenance-parity-fixture'
  where entity = 'students'
  returning payload into output_payload;
  return jsonb_build_object('ok', output_payload);
exception when others then
  return jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
end;
$$;

create function pg_temp.provenance_try_tasks_update(p_payload jsonb)
returns jsonb
language plpgsql
as $$
declare
  output_payload jsonb;
begin
  update public.ops_state
  set payload = p_payload,
    updated_by = 'provenance-parity-fixture'
  where entity = 'tasks'
  returning payload into output_payload;
  return jsonb_build_object('ok', output_payload);
exception when others then
  return jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
end;
$$;

create function pg_temp.capture_direct_provenance_cases()
returns jsonb
language plpgsql
as $$
declare
  results jsonb := '{}'::jsonb;
  bulk_old jsonb;
begin
  -- Generic allocation is disabled only for direct provenance edge cases.
  -- Numeric old id 1 and string old id "1" both use raw ->> "1"; first
  -- ordinality must choose the formal source, not the later JWB source.
  perform pg_temp.provenance_seed_students($first_old$[
    {"id":1,"studentNumber":"20880101011","studentNumberDateSource":"formal_import_date"},
    {"id":"1","studentNumber":"20880101012","studentNumberDateSource":"jwb_first_positive_contract"}
  ]$first_old$::jsonb);
  results := results || jsonb_build_object('old_first_ordinal',
    pg_temp.provenance_try_students_update($first_new$[
      {"id":"1","studentNumber":"20880101011","studentNumberDateSource":"formal_import_date"}
    ]$first_new$::jsonb)
  );

  -- The first matching row upgrades a NULL registry source. The next matching
  -- row must see that latest source and hydrate it rather than leave NULL.
  -- The final suffix is unchanged after the transformed middle row, so the
  -- ordered output buffer cannot accidentally truncate or rewrite it.
  perform pg_temp.provenance_seed_students('[]'::jsonb);
  insert into internal.student_number_reservations(
    student_number, student_id, student_number_date_source
  ) values ('20880101004', 'PROV-PARITY-HYDRATE', null);
  results := results || jsonb_build_object('pending_hydration',
    pg_temp.provenance_try_students_update($pending_rows$[
      {"id":"PROV-PARITY-PREFIX","name":"Prefix"},
      {"id":"PROV-PARITY-HYDRATE","importSource":"master","studentNumber":"20880101004","studentNumberDateSource":"formal_import_date"},
      {"id":"PROV-PARITY-HYDRATE","importSource":"master","studentNumber":"20880101004"},
      {"id":"PROV-PARITY-SUFFIX","name":"Suffix"}
    ]$pending_rows$::jsonb)
  );

  -- Both directional maps exist but point to different rows. ID-first remains
  -- the selected source record and either mismatch is a reservation conflict.
  perform pg_temp.provenance_seed_students('[]'::jsonb);
  insert into internal.student_number_reservations(
    student_number, student_id, student_number_date_source
  ) values
    ('20880101021', 'PROV-PARITY-CROSS-ID', 'formal_import_date'),
    ('20880101022', 'PROV-PARITY-CROSS-NUM', 'formal_import_date');
  results := results || jsonb_build_object('cross_id_number_conflict',
    pg_temp.provenance_try_students_update($cross_rows$[
      {"id":"PROV-PARITY-CROSS-ID","importSource":"master","studentNumber":"20880101022","studentNumberDateSource":"formal_import_date"}
    ]$cross_rows$::jsonb)
  );

  perform pg_temp.provenance_seed_students($immutable_old$[
    {"id":"PROV-PARITY-IMMUTABLE","studentNumber":"20880101031","studentNumberDateSource":"formal_import_date"}
  ]$immutable_old$::jsonb);
  results := results || jsonb_build_object('immutable_source_removal',
    pg_temp.provenance_try_students_update($immutable_new$[
      {"id":"PROV-PARITY-IMMUTABLE","studentNumber":"20880101031"}
    ]$immutable_new$::jsonb)
  );

  perform pg_temp.provenance_seed_students('[]'::jsonb);
  insert into internal.student_number_reservations(
    student_number, student_id, student_number_date_source
  ) values ('20880101041', 'PROV-PARITY-RESTORE', 'jwb_first_positive_contract');
  results := results || jsonb_build_object('registry_source_fill',
    pg_temp.provenance_try_students_update($restore_rows$[
      {"id":"PROV-PARITY-RESTORE","importSource":"master","studentNumber":"20880101041"}
    ]$restore_rows$::jsonb)
  );

  perform pg_temp.provenance_seed_students('[]'::jsonb);
  results := results || jsonb_build_object('invalid_source',
    pg_temp.provenance_try_students_update($invalid_source$[
      {"id":"PROV-PARITY-INVALID-SOURCE","studentNumber":"20880101051","studentNumberDateSource":"wrong"}
    ]$invalid_source$::jsonb)
  );
  results := results || jsonb_build_object('source_requires_number',
    pg_temp.provenance_try_students_update($source_without_number$[
      {"id":"PROV-PARITY-SOURCE-WITHOUT-NUMBER","studentNumberDateSource":"formal_import_date"}
    ]$source_without_number$::jsonb)
  );
  results := results || jsonb_build_object('invalid_number',
    pg_temp.provenance_try_students_update($invalid_number$[
      {"id":"PROV-PARITY-INVALID-NUMBER","studentNumber":"not-a-number"}
    ]$invalid_number$::jsonb)
  );

  -- A legacy existing record with a number but no provenance must stay
  -- source-less. `system_entry_date` is only truthful for a newly allocated
  -- non-master number, never as a backfill for this historical record.
  perform pg_temp.provenance_seed_students($legacy_no_source_old$[
    {"id":"PROV-PARITY-LEGACY-NO-SOURCE","importSource":"manual_trial","studentNumber":"20880101061"}
  ]$legacy_no_source_old$::jsonb);
  results := results || jsonb_build_object('legacy_old_number_no_source',
    pg_temp.provenance_try_students_update($legacy_no_source_new$[
      {"id":"PROV-PARITY-LEGACY-NO-SOURCE","importSource":"manual_trial","studentNumber":"20880101061"}
    ]$legacy_no_source_new$::jsonb)
  );

  -- A direct 500-row formal payload verifies input order and a no-change
  -- replay path without involving the generic allocator.
  select jsonb_agg(jsonb_build_object(
    'id', 'PROV-PARITY-BULK-' || lpad(n::text, 3, '0'),
    'importSource', 'master',
    'studentNumber', '20880201' || lpad(n::text, 3, '0'),
    'studentNumberDateSource', 'formal_import_date'
  ) order by n)
  into bulk_old
  from generate_series(1, 500) n;
  perform pg_temp.provenance_seed_students(bulk_old);
  results := results || jsonb_build_object('bulk_direct', pg_temp.provenance_try_students_update(bulk_old));
  return results;
end;
$$;

create function pg_temp.capture_stacked_provenance_cases()
returns jsonb
language plpgsql
as $$
declare
  results jsonb := '{}'::jsonb;
  formal_payload jsonb := $formal_payload$[
    {"id":"PROV-PARITY-FORMAL-REPLAY","importSource":"master","studentNumber":"20880301001","studentNumberDateSource":"formal_import_date"}
  ]$formal_payload$::jsonb;
  bulk_payload jsonb;
  first_bulk jsonb;
begin
  perform pg_temp.provenance_seed_students('[]'::jsonb);
  results := results || jsonb_build_object('generic_system_entry',
    pg_temp.provenance_try_students_update($manual_new$[
      {"id":"PROV-PARITY-MANUAL","importSource":"manual_trial","name":"Manual"}
    ]$manual_new$::jsonb)
  );

  perform pg_temp.provenance_seed_students('[]'::jsonb);
  results := results || jsonb_build_object('formal_first',
    pg_temp.provenance_try_students_update(formal_payload)
  );
  results := results || jsonb_build_object('formal_replay',
    pg_temp.provenance_try_students_update(formal_payload)
  );

  perform pg_temp.provenance_seed_students('[]'::jsonb);
  results := results || jsonb_build_object('empty_students',
    pg_temp.provenance_try_students_update('[]'::jsonb)
  );

  -- This exercises the complete trigger stack (generic allocator followed by
  -- provenance) for an old source-less historical record.
  perform pg_temp.provenance_seed_students($legacy_stacked_old$[
    {"id":"PROV-PARITY-LEGACY-STACKED","importSource":"manual_trial","studentNumber":"20880301002"}
  ]$legacy_stacked_old$::jsonb);
  results := results || jsonb_build_object('legacy_old_number_no_source',
    pg_temp.provenance_try_students_update($legacy_stacked_new$[
      {"id":"PROV-PARITY-LEGACY-STACKED","importSource":"manual_trial","studentNumber":"20880301002"}
    ]$legacy_stacked_new$::jsonb)
  );

  perform pg_temp.provenance_seed_tasks('[{"id":"PROV-PARITY-TASK","studentId":"PROV-PARITY-MANUAL"}]'::jsonb);
  results := results || jsonb_build_object('nonstudents',
    pg_temp.provenance_try_tasks_update('[{"id":"PROV-PARITY-TASK","studentId":"PROV-PARITY-MANUAL"}]'::jsonb)
  );

  select jsonb_agg(jsonb_build_object(
    'id', 'PROV-PARITY-STACK-' || lpad(n::text, 3, '0'),
    'importSource', 'master',
    'studentNumber', '20880401' || lpad(n::text, 3, '0'),
    'studentNumberDateSource', 'formal_import_date'
  ) order by n)
  into bulk_payload
  from generate_series(1, 500) n;
  perform pg_temp.provenance_seed_students('[]'::jsonb);
  first_bulk := pg_temp.provenance_try_students_update(bulk_payload);
  results := results || jsonb_build_object('bulk_first', first_bulk);
  results := results || jsonb_build_object('bulk_replay',
    pg_temp.provenance_try_students_update(first_bulk -> 'ok')
  );
  return results;
end;
$$;

create temporary table provenance_trigger_parity (
  direct_baseline jsonb not null,
  direct_baseline_text text not null,
  stacked_baseline jsonb not null,
  stacked_baseline_text text not null
) on commit drop;

create temporary table provenance_direct_baseline (
  direct_result jsonb not null
) on commit drop;

alter table public.ops_state disable trigger ops_state_assign_new_student_numbers;
insert into provenance_direct_baseline(direct_result)
select pg_temp.capture_direct_provenance_cases();
alter table public.ops_state enable trigger ops_state_assign_new_student_numbers;

insert into provenance_trigger_parity(
  direct_baseline, direct_baseline_text, stacked_baseline, stacked_baseline_text
)
select direct.direct_result, direct.direct_result::text,
  stacked.stacked_result, stacked.stacked_result::text
from provenance_direct_baseline direct
cross join lateral (
  select pg_temp.capture_stacked_provenance_cases() as stacked_result
) stacked;

-- The direct cases require the generic trigger to stay disabled only during
-- their own execution. Re-run exactly the same harness after the patch below.
\ir ../../supabase/migrations/20260818000900_optimize_student_number_provenance_trigger.sql

do $provenance_trigger_parity_assertion$
declare
  expected provenance_trigger_parity%rowtype;
  direct_actual jsonb;
  stacked_actual jsonb;
  direct_actual_text text;
  stacked_actual_text text;
begin
  select * into expected from provenance_trigger_parity;

  alter table public.ops_state disable trigger ops_state_assign_new_student_numbers;
  direct_actual := pg_temp.capture_direct_provenance_cases();
  alter table public.ops_state enable trigger ops_state_assign_new_student_numbers;
  stacked_actual := pg_temp.capture_stacked_provenance_cases();
  direct_actual_text := direct_actual::text;
  stacked_actual_text := stacked_actual::text;

  if direct_actual is distinct from expected.direct_baseline
     or direct_actual_text <> expected.direct_baseline_text
     or stacked_actual is distinct from expected.stacked_baseline
     or stacked_actual_text <> expected.stacked_baseline_text then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_trigger_parity_failed';
  end if;

  if jsonb_typeof(expected.stacked_baseline #> '{bulk_first,ok}') <> 'array' then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_trigger_bulk_fixture_failed',
      detail = jsonb_build_object(
        'bulkType', jsonb_typeof(expected.stacked_baseline -> 'bulk_first'),
        'outputType', jsonb_typeof(expected.stacked_baseline #> '{bulk_first,ok}'),
        'state', expected.stacked_baseline #>> '{bulk_first,state}',
        'message', expected.stacked_baseline #>> '{bulk_first,message}'
      )::text;
  end if;

  if expected.direct_baseline #>> '{old_first_ordinal,ok,0,studentNumberDateSource}'
       <> 'formal_import_date'
     or expected.direct_baseline #>> '{pending_hydration,ok,2,studentNumberDateSource}'
       <> 'formal_import_date'
     or (expected.direct_baseline #> '{pending_hydration,ok,3}')
        is distinct from '{"id":"PROV-PARITY-SUFFIX","name":"Suffix"}'::jsonb
     or expected.direct_baseline #>> '{cross_id_number_conflict,state}'
       <> '23505'
     or expected.direct_baseline #>> '{cross_id_number_conflict,message}'
       <> 'student_number_reservation_conflict'
     or expected.direct_baseline #>> '{immutable_source_removal,message}'
       <> 'student_number_date_source_immutable'
     or expected.direct_baseline #>> '{registry_source_fill,ok,0,studentNumberDateSource}'
       <> 'jwb_first_positive_contract'
     or expected.direct_baseline #>> '{invalid_source,message}'
       <> 'student_number_date_source_invalid'
     or expected.direct_baseline #>> '{source_requires_number,message}'
       <> 'student_number_date_source_requires_number'
     or expected.direct_baseline #>> '{invalid_number,message}'
       <> 'student_number_invalid'
     or (expected.direct_baseline #> '{legacy_old_number_no_source,ok,0}')
        ? 'studentNumberDateSource'
     or expected.stacked_baseline #>> '{generic_system_entry,ok,0,studentNumberDateSource}'
       <> 'system_entry_date'
     or expected.stacked_baseline #>> '{formal_replay,ok,0,studentNumberDateSource}'
       <> 'formal_import_date'
     or expected.stacked_baseline #>> '{empty_students,ok}' <> '[]'
     or (expected.stacked_baseline #> '{legacy_old_number_no_source,ok,0}')
        ? 'studentNumberDateSource'
     or expected.stacked_baseline #>> '{nonstudents,ok,0,id}' <> 'PROV-PARITY-TASK'
     or jsonb_array_length(expected.stacked_baseline #> '{bulk_first,ok}') <> 500
     or (expected.stacked_baseline #> '{bulk_first,ok}')
        is distinct from (expected.stacked_baseline #> '{bulk_replay,ok}') then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_trigger_parity_fixture_boundary_failed';
  end if;
end;
$provenance_trigger_parity_assertion$;

rollback;

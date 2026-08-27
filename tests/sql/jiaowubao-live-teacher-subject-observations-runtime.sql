\set ON_ERROR_STOP on

-- Disposable runtime fixture for
-- 20260821200000_record_pinned_jwb_live_teacher_subject_observations.sql.
--
-- Run only against a scratch/local PostgreSQL database:
--   psql ... -f tests/sql/jiaowubao-live-teacher-subject-observations-runtime.sql
-- The target database must be empty: this fixture transactionally drops and
-- recreates its `internal`, `extensions`, and `public.ops_state` test objects.
-- Never run it against a database with extension-owned schemas or application
-- data, including any Supabase database.
--
-- The complete setup, migration, assertions, and rollback happen in one
-- transaction.  The final post-rollback assertions prove that no fixture
-- object or row remains.  This file never connects to Jiaowubao or Supabase.

begin;

-- The fixture is intentionally self-contained.  These objects exist only in
-- this transaction and are all removed by the rollback at the end.
drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_state cascade;

create schema internal;
create schema extensions;

do $fixture_roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$fixture_roles$;

create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text not null
);

-- The production migration deliberately pins the real teachers JSON digest.
-- This disposable fixture does not carry that private production payload, so
-- it supplies only the two pgcrypto functions the migration calls.  The digest
-- shim returns the pinned digest exclusively for this fixture's teachers row;
-- every other input receives a non-matching sentinel.  It exercises the
-- migration's authority gate without weakening the production SQL.
create function extensions.gen_random_uuid()
returns uuid
language sql
immutable
as $$
  select '00000000-0000-0000-0000-000000000001'::uuid
$$;

create function extensions.digest(p_value bytea, p_algorithm text)
returns bytea
language plpgsql
security invoker
set search_path = ''
as $fixture_digest$
begin
  if p_algorithm = 'sha256' and exists (
    select 1
    from public.ops_state state_row
    where state_row.entity = 'teachers'
      and convert_to(state_row.payload::text, 'UTF8') = p_value
  ) then
    return decode(
      '119ccefda4aa431bc6a190adeea4aa6d533ba228ceb925747fe7a9cbf1e90012',
      'hex'
    );
  end if;
  return decode(repeat('00', 32), 'hex');
end;
$fixture_digest$;

create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create or replace function internal.append_operational_contract_audit(
  p_action text,
  p_actor text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $fixture_append_operational_contract_audit$
declare
  saved_id uuid;
begin
  insert into internal.operational_contract_audit (
    action, actor, target_type, target_id, metadata
  ) values (
    p_action, p_actor, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb)
  ) returning id into saved_id;
  return saved_id;
end;
$fixture_append_operational_contract_audit$;

create table internal.jiaowubao_direct_import_runs (
  id uuid primary key,
  state text not null,
  revision text not null
);

create table internal.jiaowubao_direct_schedule_mapping_candidate_snapshots (
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id),
  mapping_key text not null,
  source_revision text not null,
  source_evidence_sha256 text not null,
  source_event_count integer not null,
  teacher_label text not null,
  course_label text not null,
  primary key (run_id, mapping_key)
);

create or replace function internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(
  p_run_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $fixture_assert_snapshot_integrity$
begin
  if not exists (
    select 1 from internal.jiaowubao_direct_import_runs
    where id = p_run_id and state = 'complete'
  ) then
    raise exception using errcode = '23503', message = 'fixture_snapshot_run_missing';
  end if;
end;
$fixture_assert_snapshot_integrity$;

-- This table is deliberately not touched by the migration.  Its zero-row
-- snapshot is the regression guard against accidentally confirming mappings.
create table internal.jiaowubao_direct_schedule_label_mapping_decisions (
  id uuid primary key default extensions.gen_random_uuid(),
  mapping_key text not null
);

insert into public.ops_state (entity, payload, version, updated_by) values
  ('teachers', jsonb_build_array(jsonb_build_object(
    'id', 'TEA-FIXTURE',
    'name', 'Fixture teacher',
    'subjects', jsonb_build_array('Existing subject')
  )), 32, 'fixture'),
  ('students', jsonb_build_array(jsonb_build_object(
    'id', 'STU-FIXTURE', 'name', 'Fixture student'
  )), 18, 'fixture');

insert into internal.jiaowubao_direct_import_runs (id, state, revision) values (
  '0c143cc3-5951-4a9a-9b28-cba291e81475',
  'complete',
  'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b'
);

insert into internal.jiaowubao_direct_schedule_mapping_candidate_snapshots (
  run_id, mapping_key, source_revision, source_evidence_sha256,
  source_event_count, teacher_label, course_label
)
values
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:07e4cbefb4ed00b40c84c5b4f797e4e788bda93e1830f175fb43e0351c36faef', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '433a4a706e218e62048c5765da548b3de4cc91b11139a0177b52b957fcfab470', 179, 'Stephen Li', 'VCE EAL'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:40722c06d11e2d27b4eea1fa105ed7e83dec99907dfdc4461854bb5ec4be1121', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '9a170f46875081380d1e44aeb53ee38dad9af706b238fc611faf8260b883d86c', 90, 'Isobel Gee', 'Year9 English'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:e75e87290b284d48bf79aae792bfa3d3fadc6e57e8c07dcdfba880b75ba03e55', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', 'e95a7f39610fa5c6bc65a2ec34a484e7070098b9883c76008416a24ab637f386', 197, 'Shirley Li', '澳洲衔接-英文'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:5cbaeae1a7c5a1469070c3b225f380e65c648b122dbfb256871874f089d90b7f', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', 'c58ae526011fedca777673244af87dfbb83fe0b74c969fd6c56db348fbfd18d4', 119, 'Kevin Ung', 'Year7 Science'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:5cb598cd33497b15edb979cf10525873fdf2440836af918a056c1eb8682acd99', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', 'e9c152ad65df1a16d8c05058e32d33c2043a15ba132f6be214e88579f884f410', 43, 'Tom Choe', 'Y9 EAL Writing'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:549caeed9dcaa20d9bae8f33b92cc1e333ed8504e7a632c9e2357eb0c119ac37', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '26a19a70610cbdee0106c561d4481f12114f8b0657e564c2695388444de07d3f', 64, 'Emina Karovic', 'Year4 English'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:ac79ee4de56b64b9fa93dc29bae44eade46dabae7c919fdeae5d0e2bd34782a3', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '834e12d04262645483a1c461a9626f93f37bc0953a778696b625ec304093ec07', 38, 'Leandrie De Villiers', 'Y5 English 听口衔接'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:02e22160d355a809794e13e7afdb353612c9810b3a57db5136737ae060ab3b2a', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '9db9d185d083a5175ca1e2663d41057f96c63138c02db2885be791c486d1312f', 111, 'Leigh Key', 'Year8 English'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:07d2e19e2602c3ac3bd14dc1ab658a39f3f8dcf0b23d9fafb611bb8178f45ffc', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '0c3d1e1224ae0b58de8543e4c6aa9351e39b2bd3fd38fdf20d11b546cfd5ce88', 77, 'Li Love', 'Year8 English'),
  ('0c143cc3-5951-4a9a-9b28-cba291e81475', 'sha256:ad8a183ffeec76542b2b36e8aabbee2e55d09d97b715219c7ff2ce1324e49665', 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b', '91d2d31be4d247236fcbd5e56b19a3592ed47792b0f1615c8a130cbc50455cb8', 21, 'Paul Qiu', '物理');

create temporary table fixture_baseline (
  teachers_payload jsonb not null,
  teachers_version bigint not null,
  decisions_count integer not null
) on commit drop;

insert into fixture_baseline
select
  (select payload from public.ops_state where entity = 'teachers'),
  (select version from public.ops_state where entity = 'teachers'),
  (select count(*)::integer from internal.jiaowubao_direct_schedule_label_mapping_decisions);

\ir ../../supabase/migrations/20260821200000_record_pinned_jwb_live_teacher_subject_observations.sql

do $assert_observation_runtime$
declare
  observed_count integer;
  batch_count integer;
  observed_state_count integer;
  current_teachers jsonb;
  current_teacher_version bigint;
  current_decisions_count integer;
begin
  select count(*)::integer into observed_count
  from internal.jiaowubao_live_teacher_subject_observations;
  if observed_count <> 10 then
    raise exception 'fixture_observation_count_expected_10_got_%', observed_count;
  end if;

  select count(*)::integer into batch_count
  from internal.jiaowubao_live_teacher_subject_observation_batches;
  if batch_count <> 1 then
    raise exception 'fixture_observation_batch_count_expected_1_got_%', batch_count;
  end if;

  select count(*)::integer into observed_state_count
  from internal.jiaowubao_live_teacher_subject_observations
  where observation_state = 'observed_only';
  if observed_state_count <> 10 then
    raise exception 'fixture_observation_state_count_expected_10_got_%', observed_state_count;
  end if;

  select payload, version into current_teachers, current_teacher_version
  from public.ops_state where entity = 'teachers';
  if current_teachers is distinct from (select teachers_payload from fixture_baseline)
     or current_teacher_version is distinct from (select teachers_version from fixture_baseline) then
    raise exception 'fixture_teachers_authority_mutated';
  end if;

  select count(*)::integer into current_decisions_count
  from internal.jiaowubao_direct_schedule_label_mapping_decisions;
  if current_decisions_count <> (select decisions_count from fixture_baseline) then
    raise exception 'fixture_mapping_decisions_mutated';
  end if;

  begin
    update internal.jiaowubao_live_teacher_subject_observation_batches
    set recorded_by = 'not-allowed';
    raise exception 'fixture_observation_batch_update_was_not_rejected';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    delete from internal.jiaowubao_live_teacher_subject_observations;
    raise exception 'fixture_observation_delete_was_not_rejected';
  exception when sqlstate '42501' then
    null;
  end;

  if not (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'internal.jiaowubao_live_teacher_subject_observation_batches'::regclass
  ) or not (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'internal.jiaowubao_live_teacher_subject_observations'::regclass
  ) then
    raise exception 'fixture_observation_rls_not_enabled';
  end if;
end;
$assert_observation_runtime$;

rollback;

do $assert_rollback$
begin
  if to_regclass('internal.jiaowubao_live_teacher_subject_observations') is not null
     or to_regclass('internal.jiaowubao_live_teacher_subject_observation_batches') is not null
     or to_regclass('public.ops_state') is not null then
    raise exception 'fixture_rollback_left_objects';
  end if;
end;
$assert_rollback$;

\echo 'jiaowubao live teacher subject observation runtime: PASS (10 observed_only rows; authority/decisions unchanged; rollback clean)'

-- Record the first reviewed set of live Jiaowubao teacher/course observations.
--
-- This is evidence only. A lesson observed in Jiaowubao establishes neither
-- current subject authority nor a current capacity/AVA grant. In particular,
-- this migration must not alter `public.ops_state`, schedule mapping decisions,
-- bookings, tasks, operations, classrooms, payroll, or imported source rows.
--
-- The external Jiaowubao identifiers below were read once from the authenticated
-- Jiaowubao API/browser export and are release-pinned facts. PostgreSQL cannot
-- independently call Jiaowubao, so it verifies the independently imported
-- schedule candidate proof (run, mapping key, source evidence hash and count)
-- before retaining those external observations.

set local lock_timeout = '1s';

create table if not exists internal.jiaowubao_live_teacher_subject_observation_batches (
  batch_key text primary key check (batch_key ~ '^sha256:[a-f0-9]{64}$'),
  observation_state text not null check (observation_state = 'observed_only'),
  source_revision text not null check (
    source_revision = 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b'
  ),
  source_run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  item_count integer not null check (item_count = 10),
  source_bundle_sha256 text not null check (
    source_bundle_sha256 = '4b9b8a6d9260ab9f76db99d0f8ee2fec5ae73a32d5ee5a18bc131e996870dac5'
  ),
  static_plan_sha256 text not null check (
    static_plan_sha256 = '449a5b399ea9efb91c67a91c5a48e863071e320d0aabe18b4d4177c9a1f898a1'
  ),
  source_crosswalk_sha256 text not null check (
    source_crosswalk_sha256 = '01d017edc5944a37b0d415d9f0afb579f375d4b9d905532a63838f732462ac6f'
  ),
  authority_review_sha256 text not null check (
    authority_review_sha256 = '33b75f379e61223e6075d132e8be3055d4026f5e96a20984b2af61677b4cc3e2'
  ),
  recorded_by text not null check (recorded_by = 'Nixon'),
  recorded_at timestamptz not null default now(),
  audit_id uuid not null unique references internal.operational_contract_audit(id) on delete restrict
);

create table if not exists internal.jiaowubao_live_teacher_subject_observations (
  batch_key text not null references internal.jiaowubao_live_teacher_subject_observation_batches(batch_key) on delete restrict,
  source_run_id uuid not null,
  mapping_key text not null check (mapping_key ~ '^sha256:[a-f0-9]{64}$'),
  source_revision text not null check (
    source_revision = 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b'
  ),
  source_evidence_sha256 text not null check (source_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  source_event_count integer not null check (source_event_count between 1 and 200000),
  native_teacher_id text not null check (
    native_teacher_id = btrim(native_teacher_id) and char_length(native_teacher_id) between 1 and 240
  ),
  native_teacher_name text not null check (
    native_teacher_name = btrim(native_teacher_name) and char_length(native_teacher_name) between 1 and 240
  ),
  course_label text not null check (
    course_label = btrim(course_label) and char_length(course_label) between 1 and 240
  ),
  jwb_teacher_id text not null check (jwb_teacher_id ~ '^[0-9]+$'),
  jwb_course_id text not null check (jwb_course_id ~ '^[0-9]+$'),
  sample_cal_id text not null check (sample_cal_id ~ '^[0-9]+$'),
  sample_lesson_count integer not null check (sample_lesson_count between 1 and 100),
  observation_state text not null check (observation_state = 'observed_only'),
  recorded_at timestamptz not null default now(),
  primary key (batch_key, mapping_key),
  unique (source_run_id, mapping_key),
  foreign key (source_run_id, mapping_key)
    references internal.jiaowubao_direct_schedule_mapping_candidate_snapshots(run_id, mapping_key)
    on delete restrict
);

alter table internal.jiaowubao_live_teacher_subject_observation_batches enable row level security;
alter table internal.jiaowubao_live_teacher_subject_observations enable row level security;
revoke all on table internal.jiaowubao_live_teacher_subject_observation_batches from public, anon, authenticated;
revoke all on table internal.jiaowubao_live_teacher_subject_observations from public, anon, authenticated;

create or replace function internal.prevent_jiaowubao_live_teacher_subject_observation_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $prevent_jiaowubao_live_teacher_subject_observation_mutation$
begin
  raise exception using errcode = '42501', message = 'jiaowubao_live_teacher_subject_observation_immutable';
end;
$prevent_jiaowubao_live_teacher_subject_observation_mutation$;

revoke all on function internal.prevent_jiaowubao_live_teacher_subject_observation_mutation()
  from public, anon, authenticated;

-- Install append-only protection after the release-owned seed is recorded.
do $record_pinned_jiaowubao_live_teacher_subject_observations$
declare
  v_source_revision constant text := 'sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b';
  source_run_id constant uuid := '0c143cc3-5951-4a9a-9b28-cba291e81475';
  batch_key constant text := 'sha256:4b9b8a6d9260ab9f76db99d0f8ee2fec5ae73a32d5ee5a18bc131e996870dac5';
  expected_teachers_version constant bigint := 32;
  expected_teachers_sha256 constant text := '119ccefda4aa431bc6a190adeea4aa6d533ba228ceb925747fe7a9cbf1e90012';
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  complete_run_count integer;
  teachers_version bigint;
  teachers_sha256 text;
  final_teachers_version bigint;
  final_teachers_sha256 text;
  audit_entry_id uuid;
  inserted_count integer;
begin
  -- Hold the same order used by mapping confirmation so a concurrent import or
  -- teacher update cannot make this migration mix source and authority states.
  lock table internal.jiaowubao_direct_import_runs in share mode;
  select count(*)::integer into complete_run_count
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = source_run_id
    and run_state.state = 'complete'
    and run_state.revision = v_source_revision;
  if complete_run_count <> 1 then
    raise exception using errcode = '55000', message = 'pinned_jiaowubao_live_observation_source_run_ambiguous';
  end if;
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = source_run_id
    and run_state.state = 'complete'
    and run_state.revision = v_source_revision
  for share;

  -- Reconcile the compact candidate snapshot once before depending on it.
  perform internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(saved_run.id);

  select
    state_row.version,
    encode(extensions.digest(convert_to(state_row.payload::text, 'UTF8'), 'sha256'), 'hex')
  into teachers_version, teachers_sha256
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for share;
  if teachers_version is distinct from expected_teachers_version
     or teachers_sha256 is distinct from expected_teachers_sha256 then
    raise exception using errcode = '40001', message = 'pinned_jiaowubao_live_observation_teachers_authority_changed';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'jiaowubao.live_teacher_subject_observations_recorded',
    'Nixon',
    'jiaowubao_live_teacher_subject_observation_batch',
    batch_key,
    jsonb_build_object(
      'observationState', 'observed_only',
      'sourceRevisionSha256', substring(v_source_revision from 8),
      'sourceRunIdSha256', encode(extensions.digest(convert_to(saved_run.id::text, 'UTF8'), 'sha256'), 'hex'),
      'itemCount', 10,
      'sourceBundleSha256', substring(batch_key from 8),
      'staticPlanSha256', '449a5b399ea9efb91c67a91c5a48e863071e320d0aabe18b4d4177c9a1f898a1',
      'sourceCrosswalkSha256', '01d017edc5944a37b0d415d9f0afb579f375d4b9d905532a63838f732462ac6f',
      'authorityReviewSha256', '33b75f379e61223e6075d132e8be3055d4026f5e96a20984b2af61677b4cc3e2',
      'teacherStateVerifiedUntouched', true,
      'writesIssuedByMigration', jsonb_build_array(
        'operational_contract_audit',
        'jiaowubao_live_teacher_subject_observation_batches',
        'jiaowubao_live_teacher_subject_observations'
      ),
      'postDeployChecksRequired', jsonb_build_array(
        'mapping decision count',
        'booking/task/AVA state versions'
      )
    )
  );

  insert into internal.jiaowubao_live_teacher_subject_observation_batches (
    batch_key, observation_state, source_revision, source_run_id, item_count,
    source_bundle_sha256, static_plan_sha256, source_crosswalk_sha256,
    authority_review_sha256, recorded_by, audit_id
  ) values (
    batch_key, 'observed_only', v_source_revision, saved_run.id, 10,
    substring(batch_key from 8),
    '449a5b399ea9efb91c67a91c5a48e863071e320d0aabe18b4d4177c9a1f898a1',
    '01d017edc5944a37b0d415d9f0afb579f375d4b9d905532a63838f732462ac6f',
    '33b75f379e61223e6075d132e8be3055d4026f5e96a20984b2af61677b4cc3e2',
    'Nixon', audit_entry_id
  );

  with expected (
    mapping_key, source_evidence_sha256, source_event_count,
    native_teacher_id, native_teacher_name, course_label,
    jwb_teacher_id, jwb_course_id, sample_cal_id, sample_lesson_count
  ) as (
    values
      ('sha256:07e4cbefb4ed00b40c84c5b4f797e4e788bda93e1830f175fb43e0351c36faef', '433a4a706e218e62048c5765da548b3de4cc91b11139a0177b52b957fcfab470', 179, 'TEA-R0183', 'Stephen Li', 'VCE EAL', '266677', '66612', '60098275', 7),
      ('sha256:40722c06d11e2d27b4eea1fa105ed7e83dec99907dfdc4461854bb5ec4be1121', '9a170f46875081380d1e44aeb53ee38dad9af706b238fc611faf8260b883d86c', 90, 'TEA-R0074', 'Isobel Gee', 'Year9 English', '374185', '162648', '58407053', 5),
      ('sha256:e75e87290b284d48bf79aae792bfa3d3fadc6e57e8c07dcdfba880b75ba03e55', 'e95a7f39610fa5c6bc65a2ec34a484e7070098b9883c76008416a24ab637f386', 197, 'TEA-R0176', 'Shirley Li', '澳洲衔接-英文', '266728', '62310', '58212718', 4),
      ('sha256:5cbaeae1a7c5a1469070c3b225f380e65c648b122dbfb256871874f089d90b7f', 'c58ae526011fedca777673244af87dfbb83fe0b74c969fd6c56db348fbfd18d4', 119, 'TEA-R0108', 'Kevin Ung', 'Year7 Science', '344068', '173102', '60045884', 4),
      ('sha256:5cb598cd33497b15edb979cf10525873fdf2440836af918a056c1eb8682acd99', 'e9c152ad65df1a16d8c05058e32d33c2043a15ba132f6be214e88579f884f410', 43, 'TEA-R0195', 'Tom Choe', 'Y9 EAL Writing', '366738', '246990', '58238719', 3),
      ('sha256:549caeed9dcaa20d9bae8f33b92cc1e333ed8504e7a632c9e2357eb0c119ac37', '26a19a70610cbdee0106c561d4481f12114f8b0657e564c2695388444de07d3f', 64, 'TEA-R0045', 'Emina Karovic', 'Year4 English', '266674', '172577', '60173917', 3),
      ('sha256:ac79ee4de56b64b9fa93dc29bae44eade46dabae7c919fdeae5d0e2bd34782a3', '834e12d04262645483a1c461a9626f93f37bc0953a778696b625ec304093ec07', 38, 'TEA-R0115', 'Leandrie De Villiers', 'Y5 English 听口衔接', '366723', '241224', '59933848', 3),
      ('sha256:02e22160d355a809794e13e7afdb353612c9810b3a57db5136737ae060ab3b2a', '9db9d185d083a5175ca1e2663d41057f96c63138c02db2885be791c486d1312f', 111, 'TEA-R0117', 'Leigh Key', 'Year8 English', '266717', '153220', '58725817', 3),
      ('sha256:07d2e19e2602c3ac3bd14dc1ab658a39f3f8dcf0b23d9fafb611bb8178f45ffc', '0c3d1e1224ae0b58de8543e4c6aa9351e39b2bd3fd38fdf20d11b546cfd5ce88', 77, 'TEA-R0124', 'Li Love', 'Year8 English', '366707', '153220', '56693273', 4),
      ('sha256:ad8a183ffeec76542b2b36e8aabbee2e55d09d97b715219c7ff2ce1324e49665', '91d2d31be4d247236fcbd5e56b19a3592ed47792b0f1615c8a130cbc50455cb8', 21, 'TEA-R0152', 'Paul Qiu', '物理', '266718', '41231', '60244742', 3)
  )
  insert into internal.jiaowubao_live_teacher_subject_observations (
    batch_key, source_run_id, mapping_key, source_revision,
    source_evidence_sha256, source_event_count,
    native_teacher_id, native_teacher_name, course_label,
    jwb_teacher_id, jwb_course_id, sample_cal_id, sample_lesson_count,
    observation_state
  )
  select
    batch_key, saved_run.id, expected.mapping_key, v_source_revision,
    expected.source_evidence_sha256, expected.source_event_count,
    expected.native_teacher_id, expected.native_teacher_name, expected.course_label,
    expected.jwb_teacher_id, expected.jwb_course_id, expected.sample_cal_id, expected.sample_lesson_count,
    'observed_only'
  from expected
  join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
    on snapshot.run_id = saved_run.id
   and snapshot.mapping_key = expected.mapping_key
   and snapshot.source_revision = v_source_revision
   and snapshot.source_evidence_sha256 = expected.source_evidence_sha256
   and snapshot.source_event_count = expected.source_event_count
   and snapshot.teacher_label = expected.native_teacher_name
   and snapshot.course_label = expected.course_label;
  get diagnostics inserted_count = row_count;
  if inserted_count <> 10 then
    raise exception using errcode = '23503', message = 'pinned_jiaowubao_live_observation_candidate_mismatch';
  end if;

  select
    state_row.version,
    encode(extensions.digest(convert_to(state_row.payload::text, 'UTF8'), 'sha256'), 'hex')
  into final_teachers_version, final_teachers_sha256
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for share;
  if final_teachers_version is distinct from teachers_version
     or final_teachers_sha256 is distinct from teachers_sha256 then
    raise exception using errcode = '55000', message = 'pinned_jiaowubao_live_observation_teachers_mutated';
  end if;
end;
$record_pinned_jiaowubao_live_teacher_subject_observations$;

create trigger jiaowubao_live_teacher_subject_observation_batch_immutable
before update or delete on internal.jiaowubao_live_teacher_subject_observation_batches
for each row execute function internal.prevent_jiaowubao_live_teacher_subject_observation_mutation();

create trigger jiaowubao_live_teacher_subject_observation_immutable
before update or delete on internal.jiaowubao_live_teacher_subject_observations
for each row execute function internal.prevent_jiaowubao_live_teacher_subject_observation_mutation();

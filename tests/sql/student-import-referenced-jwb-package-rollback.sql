\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Runtime regression for the master-authoritative JWB history transition.
-- Run only against a disposable database that has the complete migration
-- chain applied, for example:
--   psql -h /private/tmp -p 55438 -d student_import_test \
--     -v ops_secret=... -f tests/sql/student-import-referenced-jwb-package-rollback.sql
-- The outer ROLLBACK is intentional: this fixture proves that the final
-- commit RPC refuses to move a referenced, now-unverifiable PKG-JWB package
-- into read-only history and makes no state mutation.
\if :{?ops_secret}
\else
  \echo 'ops_secret psql variable is required'
  \quit
\endif

begin;
set local app.student_import_fixture_ops_secret = :'ops_secret';

create temporary table student_import_referenced_jwb_fixture (
  plan_fingerprint text not null,
  source_revisions jsonb not null,
  expected_students jsonb not null,
  expected_student_version bigint not null,
  student_id text not null,
  package_id text not null,
  prior_students jsonb not null
) on commit drop;

-- Start from a small, fully canonical operational state. All edits occur
-- inside this transaction and are rolled back below.
insert into public.ops_state (entity, payload, version, updated_by)
select entity, '[]'::jsonb, 1, 'fixture'
from unnest(array[
  'bookings', 'files', 'lpItems', 'messages', 'operations', 'payroll',
  'renewals', 'students', 'tasks'
]::text[]) entity
on conflict (entity) do update set
  payload = excluded.payload,
  version = excluded.version,
  updated_by = excluded.updated_by;

do $initial_complete_ledger$
declare
  fixture_secret text := current_setting('app.student_import_fixture_ops_secret');
  master_rows jsonb := jsonb_build_array(jsonb_build_object(
    'sourceRow', 'M-REFERENCED-PKG-1',
    'name', 'Referenced JWB Package Learner',
    'status', '在读'
  ));
  jwb_rows jsonb := jsonb_build_array(jsonb_build_object(
    'sourceRow', 'J-REFERENCED-PKG-1',
    'name', 'Referenced JWB Package Learner',
    'remainingHours', 5,
    'contractHours', 10,
    'firstJwbHourEntryDate', '2026-01-02',
    'packageCoverage', 'complete',
    'lessonPackages', jsonb_build_array(jsonb_build_object(
      'sourcePackageId', 'PKG-REFERENCED-1',
      'name', 'Referenced JWB package',
      'subjectIds', jsonb_build_array('English'),
      'purchaseRecords', jsonb_build_array(jsonb_build_object(
        'sourcePurchaseId', 'BUY-REFERENCED-1',
        'purchasedAt', '2026-01-02',
        'hours', 10
      )),
      'consumedHours', 5
    )),
    'attributes', jsonb_build_object('jiaowubaoPackageImport', jsonb_build_object(
      'status', 'packages_from_current_course_balances',
      'currentTotalHours', 10,
      'currentUsedHours', 5,
      'currentRemainingHours', 5,
      'adjustmentContracts', '[]'::jsonb
    ))
  ));
  master_source internal.student_import_source_rows%rowtype;
  jwb_source internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  fixture_link_fingerprint text := 'sha256:' || repeat('0', 64);
  duplicate_fingerprint text;
  attachment_fingerprint text;
  formal_date text := to_char(clock_timestamp() at time zone 'Australia/Melbourne', 'YYYY-MM-DD');
  source_revisions jsonb;
  expected_students jsonb;
  fixture_audit_id uuid;
  student_id text;
  package_id text;
begin
  perform public.put_student_import_source_rows(
    fixture_secret,
    'master',
    'referenced-package-fixture-master',
    'referenced-package-fixture-master-r1',
    master_rows,
    'Nixon'
  );
  perform public.put_student_import_source_rows(
    fixture_secret,
    'jwb',
    'referenced-package-fixture-jwb',
    'referenced-package-fixture-jwb-r1',
    jwb_rows,
    'Nixon'
  );
  select * into master_source
  from internal.student_import_source_rows
  where source_kind = 'master';
  select * into jwb_source
  from internal.student_import_source_rows
  where source_kind = 'jwb';
  select * into students_state
  from public.ops_state
  where entity = 'students';

  -- No reviewed identity is needed for this exact-name fixture, but commit
  -- requires a source- and version-bound singleton link-set snapshot.
  fixture_audit_id := internal.append_operational_contract_audit(
    'student_import.fixture_empty_link_set',
    'Nixon',
    'student_import_identity_link_set',
    'singleton',
    '{}'::jsonb
  );
  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, audit_id
  ) values (
    true, master_source.source_id, master_source.revision,
    jwb_source.source_id, jwb_source.revision,
    students_state.version, 0, '[]'::jsonb, 0, fixture_link_fingerprint,
    'Nixon', fixture_audit_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    audit_id = excluded.audit_id;

  duplicate_fingerprint := internal.student_import_master_duplicate_snapshot(
    master_source, students_state
  ) ->> 'fingerprint';
  attachment_fingerprint := internal.student_fu_attachment_reference_snapshot() ->> 'fingerprint';
  source_revisions := jsonb_build_object(
    'master', master_source.revision,
    'jwb', jwb_source.revision,
    'identityLinks', fixture_link_fingerprint,
    'masterDuplicateResolutions', duplicate_fingerprint,
    'fuAttachments', attachment_fingerprint,
    'bookingsVersion', students_state.version,
    'formalImportDate', formal_date
  );
  expected_students := internal.student_import_canonical_projection(
    master_source.source_id,
    master_source.rows,
    jwb_source.rows,
    students_state.payload,
    '[]'::jsonb,
    '[]'::jsonb
  );
  expected_students := internal.student_import_assign_student_numbers(expected_students, formal_date);

  perform public.commit_student_import_plan_atomic(
    fixture_secret,
    'sha256:' || repeat('a', 64),
    students_state.version,
    source_revisions,
    expected_students,
    'Nixon'
  );

  select payload into expected_students
  from public.ops_state
  where entity = 'students';
  student_id := expected_students -> 0 ->> 'id';
  package_id := expected_students -> 0 -> 'lessonPackages' -> 0 ->> 'id';
  if student_id is null or package_id is null
     or expected_students -> 0 ->> 'jwbMatchStatus' <> 'matched' then
    raise exception using errcode = 'P0001',
      message = 'student_import_referenced_package_fixture_initial_ledger_missing';
  end if;

  update public.ops_state
  set payload = jsonb_build_array(jsonb_build_object(
    'id', 'BOOK-REFERENCED-JWB-PACKAGE',
    'studentId', student_id,
    'packageId', package_id,
    'subjectId', 'English'
  )),
  version = 1,
  updated_by = 'fixture'
  where entity = 'bookings';

  -- JWB now has aggregate-only evidence. The canonical wrapper correctly
  -- moves its old PKG-JWB ledger to historicalJwbSnapshot and clears the
  -- active ledger. That transition must be rejected because the booking above
  -- still references the old package.
  perform public.put_student_import_source_rows(
    fixture_secret,
    'jwb',
    'referenced-package-fixture-jwb',
    'referenced-package-fixture-jwb-r2',
    jsonb_build_array(jsonb_build_object(
      'sourceRow', 'J-REFERENCED-PKG-1',
      'name', 'Referenced JWB Package Learner',
      'remainingHours', 5,
      'contractHours', 10,
      'firstJwbHourEntryDate', '2026-01-02',
      'packageCoverage', 'none',
      'attributes', jsonb_build_object('jiaowubaoPackageImport', jsonb_build_object(
        'status', 'aggregate_only_no_current_courses',
        'currentTotalHours', 10,
        'currentUsedHours', 5,
        'currentRemainingHours', 5,
        'adjustmentContracts', '[]'::jsonb
      ))
    )),
    'Nixon'
  );
  select * into jwb_source
  from internal.student_import_source_rows
  where source_kind = 'jwb';
  select * into students_state
  from public.ops_state
  where entity = 'students';

  fixture_audit_id := internal.append_operational_contract_audit(
    'student_import.fixture_empty_link_set',
    'Nixon',
    'student_import_identity_link_set',
    'singleton',
    '{}'::jsonb
  );
  update internal.student_import_identity_link_sets
  set jwb_source_id = jwb_source.source_id,
    jwb_revision = jwb_source.revision,
    students_version = students_state.version,
    links = '[]'::jsonb,
    link_count = 0,
    link_fingerprint = fixture_link_fingerprint,
    updated_by = 'Nixon',
    audit_id = fixture_audit_id
  where singleton;

  duplicate_fingerprint := internal.student_import_master_duplicate_snapshot(
    master_source, students_state
  ) ->> 'fingerprint';
  attachment_fingerprint := internal.student_fu_attachment_reference_snapshot() ->> 'fingerprint';
  source_revisions := jsonb_build_object(
    'master', master_source.revision,
    'jwb', jwb_source.revision,
    'identityLinks', fixture_link_fingerprint,
    'masterDuplicateResolutions', duplicate_fingerprint,
    'fuAttachments', attachment_fingerprint,
    'bookingsVersion', (select version from public.ops_state where entity = 'bookings'),
    'formalImportDate', formal_date
  );
  expected_students := internal.student_import_canonical_projection(
    master_source.source_id,
    master_source.rows,
    jwb_source.rows,
    students_state.payload,
    '[]'::jsonb,
    '[]'::jsonb
  );
  expected_students := internal.student_import_assign_student_numbers(expected_students, formal_date);
  if expected_students -> 0 ? 'lessonPackages'
     or expected_students -> 0 #>> '{historicalJwbSnapshot,retained,lessonPackages,0,id}' <> package_id then
    raise exception using errcode = 'P0001',
      message = 'student_import_referenced_package_fixture_snapshot_transition_missing';
  end if;

  insert into student_import_referenced_jwb_fixture (
    plan_fingerprint, source_revisions, expected_students, expected_student_version,
    student_id, package_id, prior_students
  ) values (
    'sha256:' || repeat('b', 64),
    source_revisions,
    expected_students,
    students_state.version,
    student_id,
    package_id,
    students_state.payload
  );
end;
$initial_complete_ledger$;

do $referenced_package_must_reject$
declare
  fixture student_import_referenced_jwb_fixture%rowtype;
  fixture_secret text := current_setting('app.student_import_fixture_ops_secret');
  after_students jsonb;
begin
  select * into fixture from student_import_referenced_jwb_fixture;

  begin
    perform public.commit_student_import_plan_atomic(
      fixture_secret,
      fixture.plan_fingerprint,
      fixture.expected_student_version,
      fixture.source_revisions,
      fixture.expected_students,
      'Nixon'
    );
    raise exception using errcode = 'P0001',
      message = 'student_import_referenced_package_fixture_expected_rejection_missing';
  exception when others then
    if sqlstate <> '23503' or sqlerrm <> 'student_import_referenced_package_removed' then
      raise;
    end if;
  end;

  select payload into after_students
  from public.ops_state
  where entity = 'students';
  if after_students is distinct from fixture.prior_students
     or exists (
       select 1 from internal.student_import_commits
       where plan_fingerprint = fixture.plan_fingerprint
     ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_referenced_package_fixture_mutated_after_rejection';
  end if;
end;
$referenced_package_must_reject$;

rollback;
\echo 'student_import_referenced_jwb_package_rollback: PASS'

\set ON_ERROR_STOP on

-- Run against a disposable database migrated through 20260817000800 (but not
-- 170009/170010).  This captures the exact pre-optimization wrapper result,
-- applies all forward performance patches in the same transaction, then
-- proves JSONB and canonical `::text` parity before rolling everything back.
begin;
set local plpgsql.variable_conflict = use_column;

create temporary table projection_accumulator_parity (
  expected_projection jsonb not null,
  expected_empty_projection jsonb not null
) on commit drop;

create temporary table package_accumulator_parity (
  valid_packages jsonb not null,
  expected_packages jsonb not null,
  expected_errors jsonb not null
) on commit drop;

create function pg_temp.student_import_jwb_package_error_cases()
returns jsonb
language plpgsql
as $$
declare
  case_item record;
  did_raise boolean;
  errors jsonb := '{}'::jsonb;
begin
  for case_item in
    select value
    from jsonb_array_elements($error_cases$[
      {"name":"duplicate_package","packages":[
        {"sourcePackageId":"DUP","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0},
        {"sourcePackageId":"DUP","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
      ]},
      {"name":"duplicate_purchase","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"DUP-BUY","purchasedAt":"2026-01-01","hours":1},{"sourcePurchaseId":"DUP-BUY","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
      ]},
      {"name":"malformed_date","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"not-a-date","hours":1}],"consumedHours":0}
      ]},
      {"name":"invalid_precision","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1.0000001}],"consumedHours":0}
      ]},
      {"name":"overflow_total","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":5000000000},{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":5000000000}],"consumedHours":0}
      ]}
    ]$error_cases$::jsonb)
  loop
    did_raise := false;
    begin
      perform internal.student_import_canonical_jwb_packages(
        'HELPER-PARITY', case_item.value -> 'packages'
      );
    exception when others then
      did_raise := true;
      errors := errors || jsonb_build_object(
        case_item.value ->> 'name',
        jsonb_build_object('state', SQLSTATE, 'message', SQLERRM)
      );
    end;
    if not did_raise then
      raise exception using errcode = 'P0001',
        message = 'student_import_jwb_package_error_fixture_did_not_reject';
    end if;
  end loop;
  return errors;
end;
$$;

do $package_accumulator_baseline$
declare
  valid_packages jsonb := $valid_packages$[
    {"sourcePackageId":"PKG-A","name":"English","subjectIds":["ENG","Writing"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A1","purchasedAt":"2026-01-01","hours":1.5,"note":"first"},{"sourcePurchaseId":"BUY-A2","purchasedAt":"2026-01-02T10:11:12.345+10:00","hours":2}],"consumedHours":0.25},
    {"sourcePackageId":"PKG-B","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B1","purchasedAt":"2026-02-03T04:05:06.789Z","hours":3,"note":"final"}],"consumedHours":1}
  ]$valid_packages$::jsonb;
  expected_errors jsonb;
begin
  expected_errors := pg_temp.student_import_jwb_package_error_cases();
  if expected_errors is distinct from jsonb_build_object(
    'duplicate_package', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_package'),
    'duplicate_purchase', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_purchase'),
    'malformed_date', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_purchase_date'),
    'invalid_precision', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_purchase'),
    'overflow_total', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_package_total')
  ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_jwb_package_error_fixture_baseline_failed';
  end if;
  insert into package_accumulator_parity(valid_packages, expected_packages, expected_errors)
  values (
    valid_packages,
    internal.student_import_canonical_jwb_packages('HELPER-PARITY', valid_packages),
    expected_errors
  );
end;
$package_accumulator_baseline$;

do $projection_accumulator_baseline$
declare
  fixture_master_rows jsonb := $fixture_master_rows$[
    {"sourceRow":"M-EXACT","name":"Exact","status":"在读"},
    {"sourceRow":"M-ANNO","name":"Anne","status":"在读"},
    {"sourceRow":"M-STALE","name":"Stale","status":"不活跃 + 无课时"}
  ]$fixture_master_rows$::jsonb;
  fixture_jwb_rows jsonb := $fixture_jwb_rows$[
    {"sourceRow":101,"name":"Exact","remainingHours":3,"contractHours":5,"packageCoverage":"none"},
    {"sourceRow":"J-ANNO","name":"Anne(VIC)","remainingHours":2,"contractHours":2,"packageCoverage":"partial","lessonPackages":[{"sourcePackageId":"ANNO-PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"ANNO-BUY","purchasedAt":"2026-01-01","hours":2}],"consumedHours":0}]}
  ]$fixture_jwb_rows$::jsonb;
  fixture_current_students jsonb := $fixture_current_students$[
    {"id":"LEGACY-EXACT","name":"Exact"},
    {"id":"LEGACY-ANNO","name":"Anne"},
    {"id":"LEGACY-STALE","name":"Stale","lessonPackages":[{"id":"PKG-MANUAL-STALE","name":"Manual","subjectIds":["MAN"],"purchaseRecords":[{"id":"BUY-MANUAL-STALE","purchasedAt":"2025-01-01T00:00:00.000Z","hours":2}],"consumedHours":0},{"id":"PKG-JWB-STALE","name":"Historic","subjectIds":["ENG"],"purchaseRecords":[{"id":"BUY-JWB-STALE","purchasedAt":"2025-01-02T00:00:00.000Z","hours":3}],"consumedHours":1}],"packageCoverage":"partial","remainingHours":2,"contractHours":3,"historicalJwbSnapshot":{"currentAggregate":{"remainingHours":7,"contractHours":8,"packageCoverage":"none","jwbSourceRow":101}}},
    {"id":"MANUAL-ONLY","name":"Manual only","importSource":"manual_trial"},
    {"id":"ARCHIVE-ONLY","name":"Archive only","segment":"已报名"}
  ]$fixture_current_students$::jsonb;
  fixture_links jsonb := $fixture_links$[
    {"masterSourceRow":"M-EXACT","jwbSourceRow":101,"studentId":"LEGACY-EXACT"},
    {"masterSourceRow":"M-ANNO","jwbSourceRow":"J-ANNO","studentId":"LEGACY-ANNO","matchStrategy":"jwb_latin_parenthetical_annotation_v1"},
    {"masterSourceRow":"M-STALE","jwbSourceRow":"J-MISSING","studentId":"LEGACY-STALE"}
  ]$fixture_links$::jsonb;
begin
  insert into projection_accumulator_parity(expected_projection, expected_empty_projection)
  values (
    internal.student_import_canonical_projection(
      'fixture-170010', fixture_master_rows, fixture_jwb_rows,
      fixture_current_students, fixture_links, '["ARCHIVE-ONLY"]'::jsonb
    ),
    internal.student_import_canonical_projection(
      'fixture-170010-empty', '[]'::jsonb, '[]'::jsonb,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
    )
  );
end;
$projection_accumulator_baseline$;

\ir ../../supabase/migrations/20260818000100_optimize_student_import_projection_wrapper.sql
\ir ../../supabase/migrations/20260818000200_optimize_student_import_projection_accumulators.sql
\ir ../../supabase/migrations/20260818000300_optimize_student_import_jwb_package_buffers.sql
\ir ../../supabase/migrations/20260818000400_reuse_base_jwb_ledger_packages.sql
\ir ../../supabase/migrations/20260818000500_validate_jwb_package_preflight.sql
\ir ../../supabase/migrations/20260818001000_reuse_prevalidated_jwb_package_projection.sql

do $projection_accumulator_assertion$
declare
  fixture_master_rows jsonb := $fixture_master_rows$[
    {"sourceRow":"M-EXACT","name":"Exact","status":"在读"},
    {"sourceRow":"M-ANNO","name":"Anne","status":"在读"},
    {"sourceRow":"M-STALE","name":"Stale","status":"不活跃 + 无课时"}
  ]$fixture_master_rows$::jsonb;
  fixture_jwb_rows jsonb := $fixture_jwb_rows$[
    {"sourceRow":101,"name":"Exact","remainingHours":3,"contractHours":5,"packageCoverage":"none"},
    {"sourceRow":"J-ANNO","name":"Anne(VIC)","remainingHours":2,"contractHours":2,"packageCoverage":"partial","lessonPackages":[{"sourcePackageId":"ANNO-PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"ANNO-BUY","purchasedAt":"2026-01-01","hours":2}],"consumedHours":0}]}
  ]$fixture_jwb_rows$::jsonb;
  fixture_current_students jsonb := $fixture_current_students$[
    {"id":"LEGACY-EXACT","name":"Exact"},
    {"id":"LEGACY-ANNO","name":"Anne"},
    {"id":"LEGACY-STALE","name":"Stale","lessonPackages":[{"id":"PKG-MANUAL-STALE","name":"Manual","subjectIds":["MAN"],"purchaseRecords":[{"id":"BUY-MANUAL-STALE","purchasedAt":"2025-01-01T00:00:00.000Z","hours":2}],"consumedHours":0},{"id":"PKG-JWB-STALE","name":"Historic","subjectIds":["ENG"],"purchaseRecords":[{"id":"BUY-JWB-STALE","purchasedAt":"2025-01-02T00:00:00.000Z","hours":3}],"consumedHours":1}],"packageCoverage":"partial","remainingHours":2,"contractHours":3,"historicalJwbSnapshot":{"currentAggregate":{"remainingHours":7,"contractHours":8,"packageCoverage":"none","jwbSourceRow":101}}},
    {"id":"MANUAL-ONLY","name":"Manual only","importSource":"manual_trial"},
    {"id":"ARCHIVE-ONLY","name":"Archive only","segment":"已报名"}
  ]$fixture_current_students$::jsonb;
  fixture_links jsonb := $fixture_links$[
    {"masterSourceRow":"M-EXACT","jwbSourceRow":101,"studentId":"LEGACY-EXACT"},
    {"masterSourceRow":"M-ANNO","jwbSourceRow":"J-ANNO","studentId":"LEGACY-ANNO","matchStrategy":"jwb_latin_parenthetical_annotation_v1"},
    {"masterSourceRow":"M-STALE","jwbSourceRow":"J-MISSING","studentId":"LEGACY-STALE"}
  ]$fixture_links$::jsonb;
  baseline_projection jsonb;
  baseline_empty_projection jsonb;
  actual_projection jsonb;
  actual_empty_projection jsonb;
begin
  select parity.expected_projection, parity.expected_empty_projection
  into baseline_projection, baseline_empty_projection
  from projection_accumulator_parity parity;
  actual_projection := internal.student_import_canonical_projection(
    'fixture-170010', fixture_master_rows, fixture_jwb_rows,
    fixture_current_students, fixture_links, '["ARCHIVE-ONLY"]'::jsonb
  );
  if actual_projection is distinct from baseline_projection
     or actual_projection::text <> baseline_projection::text then
    raise exception using errcode = 'P0001',
      message = 'student_import_projection_accumulator_parity_failed';
  end if;
  actual_empty_projection := internal.student_import_canonical_projection(
    'fixture-170010-empty', '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
  );
  if actual_empty_projection is distinct from baseline_empty_projection
     or actual_empty_projection::text <> baseline_empty_projection::text
     or actual_empty_projection <> '[]'::jsonb then
    raise exception using errcode = 'P0001',
      message = 'student_import_projection_accumulator_empty_parity_failed';
  end if;
  if (actual_projection #>> '{0,jwbMatchStatus}') is distinct from 'matched'
     or (actual_projection #>> '{0,jwbSourceRow}') is distinct from 'J-ANNO'
     or (actual_projection #>> '{1,jwbMatchStatus}') is distinct from 'matched'
     or (actual_projection #>> '{1,historicalJwbSnapshot,currentAggregate,jwbSourceRow}') is distinct from '101'
     or (actual_projection #>> '{2,jwbMatchStatus}') is distinct from 'unmatched'
     or (actual_projection #>> '{2,historicalJwbSnapshot,retained,lessonPackages,0,id}') is distinct from 'PKG-JWB-STALE'
     or (actual_projection #>> '{3,importSource}') is distinct from 'manual_trial'
     or (actual_projection #>> '{4,importArchivedReason}') is distinct from 'referenced_history' then
    raise exception using errcode = 'P0001',
      message = 'student_import_projection_accumulator_fixture_boundary_failed';
  end if;
end;
$projection_accumulator_assertion$;

do $package_accumulator_assertion$
declare
  parity package_accumulator_parity%rowtype;
  actual_packages jsonb;
  actual_prevalidated_packages jsonb;
  actual_errors jsonb;
begin
  select * into parity from package_accumulator_parity;
  actual_packages := internal.student_import_canonical_jwb_packages(
    'HELPER-PARITY', parity.valid_packages
  );
  actual_prevalidated_packages := internal.student_import_project_prevalidated_jwb_packages(
    'HELPER-PARITY', parity.valid_packages
  );
  actual_errors := pg_temp.student_import_jwb_package_error_cases();
  if actual_packages is distinct from parity.expected_packages
     or actual_packages::text <> parity.expected_packages::text
     or actual_prevalidated_packages is distinct from parity.expected_packages
     or actual_prevalidated_packages::text <> parity.expected_packages::text
     or actual_errors is distinct from parity.expected_errors
     or actual_errors::text <> parity.expected_errors::text then
    raise exception using errcode = 'P0001',
      message = 'student_import_jwb_package_accumulator_parity_failed';
  end if;
end;
$package_accumulator_assertion$;

rollback;

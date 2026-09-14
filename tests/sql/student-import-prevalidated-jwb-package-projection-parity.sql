\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Run against a disposable database migrated through 20260818000900. Capture
-- the exact public helper and full projection output before 170018, apply the
-- forward-only patch in this transaction, then require JSONB and canonical
-- `::text` parity. The direct public-helper error cases ensure callers which
-- do not use the base preflight retain the established validation contract.
begin;

create temporary table prevalidated_jwb_package_projection_parity (
  helper_packages jsonb not null,
  helper_projection jsonb not null,
  helper_projection_text text not null,
  helper_errors jsonb not null,
  helper_errors_text text not null,
  full_projection jsonb not null,
  full_projection_text text not null,
  full_projection_error jsonb not null
) on commit drop;

create function pg_temp.capture_prevalidated_jwb_helper_errors()
returns jsonb
language plpgsql
as $capture_prevalidated_jwb_helper_errors$
declare
  case_item record;
  errors jsonb := '{}'::jsonb;
  did_raise boolean;
begin
  for case_item in
    select value
    from jsonb_array_elements($helper_error_cases$[
      {"name":"duplicate_package","packages":[
        {"sourcePackageId":"DUP","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0},
        {"sourcePackageId":"DUP","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
      ]},
      {"name":"duplicate_purchase","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"DUP","purchasedAt":"2026-01-01","hours":1},{"sourcePurchaseId":"DUP","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
      ]},
      {"name":"malformed_date","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-02-30","hours":1}],"consumedHours":0}
      ]},
      {"name":"aggregate_overflow","packages":[
        {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":9007199254.740991},{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":9007199254.740991}],"consumedHours":0}
      ]}
    ]$helper_error_cases$::jsonb)
  loop
    did_raise := false;
    begin
      perform internal.student_import_canonical_jwb_packages(
        'STU-PREVALIDATED-HELPER', case_item.value -> 'packages'
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
        message = 'student_import_prevalidated_jwb_helper_error_fixture_missing';
    end if;
  end loop;
  return errors;
end;
$capture_prevalidated_jwb_helper_errors$;

do $prevalidated_jwb_package_projection_baseline$
declare
  valid_helper_packages jsonb := $valid_helper_packages$[
    {"sourcePackageId":"PKG-Z","name":"  Mathematics ","subjectIds":[" MAT ","Science"],"purchaseRecords":[{"sourcePurchaseId":"BUY-Z2","purchasedAt":"2026-03-04T05:06:07.891+10:00","hours":2.125,"note":"  second  "},{"sourcePurchaseId":"BUY-Z1","purchasedAt":"2026-03-03","hours":1}],"consumedHours":0.125},
    {"sourcePackageId":"PKG-A","name":"English","subjectIds":["ENG","Writing"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A1","purchasedAt":"2026-04-05T04:05:06.789Z","hours":3,"note":" first "}],"consumedHours":1}
  ]$valid_helper_packages$::jsonb;
  projection_master_rows jsonb := $projection_master_rows$[
    {"sourceRow":"M-PROJECTION","name":"Package Learner","status":"在读"}
  ]$projection_master_rows$::jsonb;
  projection_jwb_rows jsonb := $projection_jwb_rows$[
    {"sourceRow":"J-PROJECTION","name":"Package Learner","packageCoverage":"complete","remainingHours":2,"contractHours":3,"lessonPackages":[
      {"sourcePackageId":"PROJ-PKG-2","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"PROJ-BUY-2","purchasedAt":"2026-01-02T11:12:13.456+10:00","hours":2,"note":" late "}],"consumedHours":0},
      {"sourcePackageId":"PROJ-PKG-1","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"PROJ-BUY-1","purchasedAt":"2026-01-01","hours":1}],"consumedHours":1}
    ]}
  ]$projection_jwb_rows$::jsonb;
  bad_projection_jwb_rows jsonb := $bad_projection_jwb_rows$[
    {"sourceRow":"J-BAD-PACKAGE","name":"Bad package","lessonPackages":[
      {"sourcePackageId":"DUP","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0},
      {"sourcePackageId":"DUP","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
    ]},
    {"sourceRow":"J-BAD-DATE","name":"Bad date","lessonPackages":[
      {"sourcePackageId":"DATE","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-DATE","purchasedAt":"bad-date","hours":1}],"consumedHours":0}
    ]}
  ]$bad_projection_jwb_rows$::jsonb;
  helper_errors jsonb;
  projection_error jsonb;
begin
  helper_errors := pg_temp.capture_prevalidated_jwb_helper_errors();
  if helper_errors is distinct from jsonb_build_object(
    'duplicate_package', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_package'),
    'duplicate_purchase', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_purchase'),
    'malformed_date', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_purchase_date'),
    'aggregate_overflow', jsonb_build_object('state', '22023', 'message', 'invalid_student_import_jwb_package_total')
  ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_helper_error_baseline_failed';
  end if;

  begin
    perform internal.student_import_canonical_projection(
      'prevalidated-projection-error',
      '[{"sourceRow":"M-BAD","name":"Master","status":"在读"}]'::jsonb,
      bad_projection_jwb_rows,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
    );
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_error_fixture_missing';
  exception when others then
    if SQLSTATE = 'P0001'
       and SQLERRM = 'student_import_prevalidated_jwb_projection_error_fixture_missing' then
      raise;
    end if;
    projection_error := jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
  end;
  if projection_error is distinct from jsonb_build_object(
    'state', '22023', 'message', 'invalid_student_import_jwb_package'
  ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_error_baseline_failed';
  end if;

  insert into prevalidated_jwb_package_projection_parity(
    helper_packages,
    helper_projection,
    helper_projection_text,
    helper_errors,
    helper_errors_text,
    full_projection,
    full_projection_text,
    full_projection_error
  )
  values (
    valid_helper_packages,
    internal.student_import_canonical_jwb_packages(
      'STU-PREVALIDATED-HELPER', valid_helper_packages
    ),
    internal.student_import_canonical_jwb_packages(
      'STU-PREVALIDATED-HELPER', valid_helper_packages
    )::text,
    helper_errors,
    helper_errors::text,
    internal.student_import_canonical_projection(
      'prevalidated-projection', projection_master_rows, projection_jwb_rows,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
    ),
    internal.student_import_canonical_projection(
      'prevalidated-projection', projection_master_rows, projection_jwb_rows,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
    )::text,
    projection_error
  );
end;
$prevalidated_jwb_package_projection_baseline$;

\ir ../../supabase/migrations/20260818001000_reuse_prevalidated_jwb_package_projection.sql

do $prevalidated_jwb_package_projection_assertion$
declare
  parity prevalidated_jwb_package_projection_parity%rowtype;
  projection_master_rows jsonb := $projection_master_rows$[
    {"sourceRow":"M-PROJECTION","name":"Package Learner","status":"在读"}
  ]$projection_master_rows$::jsonb;
  projection_jwb_rows jsonb := $projection_jwb_rows$[
    {"sourceRow":"J-PROJECTION","name":"Package Learner","packageCoverage":"complete","remainingHours":2,"contractHours":3,"lessonPackages":[
      {"sourcePackageId":"PROJ-PKG-2","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"PROJ-BUY-2","purchasedAt":"2026-01-02T11:12:13.456+10:00","hours":2,"note":" late "}],"consumedHours":0},
      {"sourcePackageId":"PROJ-PKG-1","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"PROJ-BUY-1","purchasedAt":"2026-01-01","hours":1}],"consumedHours":1}
    ]}
  ]$projection_jwb_rows$::jsonb;
  bad_projection_jwb_rows jsonb := $bad_projection_jwb_rows$[
    {"sourceRow":"J-BAD-PACKAGE","name":"Bad package","lessonPackages":[
      {"sourcePackageId":"DUP","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0},
      {"sourcePackageId":"DUP","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
    ]},
    {"sourceRow":"J-BAD-DATE","name":"Bad date","lessonPackages":[
      {"sourcePackageId":"DATE","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-DATE","purchasedAt":"bad-date","hours":1}],"consumedHours":0}
    ]}
  ]$bad_projection_jwb_rows$::jsonb;
  actual_helper_projection jsonb;
  actual_private_projection jsonb;
  actual_helper_errors jsonb;
  actual_full_projection jsonb;
  actual_projection_error jsonb;
begin
  select * into parity from prevalidated_jwb_package_projection_parity;
  actual_helper_projection := internal.student_import_canonical_jwb_packages(
    'STU-PREVALIDATED-HELPER', parity.helper_packages
  );
  actual_private_projection := internal.student_import_project_prevalidated_jwb_packages(
    'STU-PREVALIDATED-HELPER', parity.helper_packages
  );
  actual_helper_errors := pg_temp.capture_prevalidated_jwb_helper_errors();
  actual_full_projection := internal.student_import_canonical_projection(
    'prevalidated-projection', projection_master_rows, projection_jwb_rows,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
  );
  begin
    perform internal.student_import_canonical_projection(
      'prevalidated-projection-error',
      '[{"sourceRow":"M-BAD","name":"Master","status":"在读"}]'::jsonb,
      bad_projection_jwb_rows,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
    );
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_error_fixture_missing';
  exception when others then
    if SQLSTATE = 'P0001'
       and SQLERRM = 'student_import_prevalidated_jwb_projection_error_fixture_missing' then
      raise;
    end if;
    actual_projection_error := jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
  end;

  if actual_helper_projection is distinct from parity.helper_projection
     or actual_helper_projection::text <> parity.helper_projection_text
     or actual_private_projection is distinct from parity.helper_projection
     or actual_private_projection::text <> parity.helper_projection_text
     or actual_helper_errors is distinct from parity.helper_errors
     or actual_helper_errors::text <> parity.helper_errors_text
     or actual_full_projection is distinct from parity.full_projection
     or actual_full_projection::text <> parity.full_projection_text
     or actual_projection_error is distinct from parity.full_projection_error then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_package_projection_parity_failed';
  end if;

  if (actual_full_projection #>> '{0,jwbMatchStatus}') <> 'matched'
     or jsonb_array_length(actual_full_projection #> '{0,lessonPackages}') <> 2
     or (actual_full_projection #>> '{0,lessonPackages,0,purchaseRecords,0,purchasedAt}')
        <> '2026-01-02T01:12:13.456Z' then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_package_projection_fixture_boundary_failed';
  end if;
end;
$prevalidated_jwb_package_projection_assertion$;

rollback;

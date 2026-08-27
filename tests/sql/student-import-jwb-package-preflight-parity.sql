\set ON_ERROR_STOP on

-- Run against a disposable database migrated through 20260818000400. The
-- preflight helper is applied only inside this transaction. Each fixture calls
-- both the original output-producing canonicalizer and the new validation-only
-- helper, then requires the exact same success/failure and SQLSTATE/message.
begin;
\ir ../../supabase/migrations/20260818000500_validate_jwb_package_preflight.sql

do $student_import_jwb_package_preflight_parity$
declare
  case_item record;
  canonical_state text;
  canonical_message text;
  validator_state text;
  validator_message text;
begin
  for case_item in
    with static_cases(case_name, packages, expected_state, expected_message) as (
      values
        (
          'valid_date_forms_notes_and_microhours',
          $valid$[
            {"sourcePackageId":"PKG-A","name":"English","subjectIds":["ENG","Writing"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A1","purchasedAt":"2026-01-01","hours":1.5,"note":"first"},{"sourcePurchaseId":"BUY-A2","purchasedAt":"2026-01-02T10:11:12.345+10:00","hours":2}],"consumedHours":0.25},
            {"sourcePackageId":"PKG-B","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B1","purchasedAt":"2026-02-03T04:05:06.789Z","hours":3,"note":"final"}],"consumedHours":1}
          ]$valid$::jsonb,
          null::text, null::text
        ),
        ('root_object', '{}'::jsonb, '22023', 'invalid_student_import_jwb_packages'),
        ('empty_packages', '[]'::jsonb, '22023', 'invalid_student_import_jwb_packages'),
        (
          'package_extra_key',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0,"extra":true}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package'
        ),
        (
          'invalid_package_source_key',
          $case$[{"sourcePackageId":1.5,"name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package'
        ),
        (
          'blank_package_name',
          $case$[{"sourcePackageId":"PKG","name":" ","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package'
        ),
        (
          'invalid_subject_value',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":[" "],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_subjects'
        ),
        (
          'duplicate_subject',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG","ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_subjects'
        ),
        (
          'non_string_subject',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":[1],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_subjects'
        ),
        (
          'negative_consumed_hours',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1}],"consumedHours":-0.1}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package'
        ),
        (
          'empty_purchase_records',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package'
        ),
        (
          'purchase_extra_key',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1,"extra":true}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase'
        ),
        (
          'invalid_purchase_source_key',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":1.5,"purchasedAt":"2026-01-01","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase'
        ),
        (
          'duplicate_purchase_source_key',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1},{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase'
        ),
        (
          'malformed_purchase_date',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-02-30","hours":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase_date'
        ),
        (
          'purchase_precision',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1.0000001}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase'
        ),
        (
          'non_positive_purchase_hours',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":0}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase'
        ),
        (
          'purchase_note_type',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY","purchasedAt":"2026-01-01","hours":1,"note":1}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_purchase'
        ),
        (
          'duplicate_package_source_key',
          $case$[
            {"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":1}],"consumedHours":0},
            {"sourcePackageId":"PKG","name":"Maths","subjectIds":["MAT"],"purchaseRecords":[{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":1}],"consumedHours":0}
          ]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package'
        ),
        (
          'aggregate_overflow',
          $case$[{"sourcePackageId":"PKG","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"BUY-A","purchasedAt":"2026-01-01","hours":9007199254.740991},{"sourcePurchaseId":"BUY-B","purchasedAt":"2026-01-02","hours":9007199254.740991}],"consumedHours":0}]$case$::jsonb,
          '22023', 'invalid_student_import_jwb_package_total'
        )
    ), generated_cases(case_name, packages, expected_state, expected_message) as (
      select
        'package_count_over_limit',
        jsonb_agg(jsonb_build_object(
          'sourcePackageId', 'PKG-' || n,
          'name', 'English',
          'subjectIds', jsonb_build_array('ENG'),
          'purchaseRecords', jsonb_build_array(jsonb_build_object(
            'sourcePurchaseId', 'BUY-' || n,
            'purchasedAt', '2026-01-01',
            'hours', 1
          )),
          'consumedHours', 0
        ) order by n),
        '22023', 'invalid_student_import_jwb_packages'
      from generate_series(1, 101) n
      union all
      select
        'purchase_count_over_limit',
        jsonb_build_array(jsonb_build_object(
          'sourcePackageId', 'PKG',
          'name', 'English',
          'subjectIds', jsonb_build_array('ENG'),
          'purchaseRecords', (
            select jsonb_agg(jsonb_build_object(
              'sourcePurchaseId', 'BUY-' || n,
              'purchasedAt', '2026-01-01',
              'hours', 1
            ) order by n)
            from generate_series(1, 1001) n
          ),
          'consumedHours', 0
        )),
        '22023', 'invalid_student_import_jwb_package'
      union all
      select
        'purchase_note_length',
        jsonb_build_array(jsonb_build_object(
          'sourcePackageId', 'PKG',
          'name', 'English',
          'subjectIds', jsonb_build_array('ENG'),
          'purchaseRecords', jsonb_build_array(jsonb_build_object(
            'sourcePurchaseId', 'BUY',
            'purchasedAt', '2026-01-01',
            'hours', 1,
            'note', repeat('n', 1001)
          )),
          'consumedHours', 0
        )),
        '22023', 'invalid_student_import_jwb_purchase'
    )
    select * from static_cases
    union all
    select * from generated_cases
    order by case_name
  loop
    canonical_state := null;
    canonical_message := null;
    begin
      perform internal.student_import_canonical_jwb_packages(
        'STU-JWB-VALIDATION-PARITY', case_item.packages
      );
    exception when others then
      canonical_state := SQLSTATE;
      canonical_message := SQLERRM;
    end;

    validator_state := null;
    validator_message := null;
    begin
      perform internal.student_import_validate_jwb_packages(case_item.packages);
    exception when others then
      validator_state := SQLSTATE;
      validator_message := SQLERRM;
    end;

    if canonical_state is distinct from validator_state
       or canonical_message is distinct from validator_message then
      raise exception using errcode = 'P0001', message = format(
        'student_import_jwb_package_preflight_differential_failed:%s:%s:%s:%s:%s',
        case_item.case_name,
        coalesce(canonical_state, 'ok'), coalesce(canonical_message, 'ok'),
        coalesce(validator_state, 'ok'), coalesce(validator_message, 'ok')
      );
    end if;
    if case_item.expected_state is null then
      if canonical_state is not null then
        raise exception using errcode = 'P0001', message = format(
          'student_import_jwb_package_preflight_valid_fixture_failed:%s:%s:%s',
          case_item.case_name, canonical_state, canonical_message
        );
      end if;
    elsif canonical_state is distinct from case_item.expected_state
       or canonical_message is distinct from case_item.expected_message then
      raise exception using errcode = 'P0001', message = format(
        'student_import_jwb_package_preflight_expected_error_failed:%s:%s:%s',
        case_item.case_name, coalesce(canonical_state, 'ok'), coalesce(canonical_message, 'ok')
      );
    end if;
  end loop;
end;
$student_import_jwb_package_preflight_parity$;

rollback;

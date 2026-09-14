\ir assert-disposable-database.sql
begin;

\ir ../../supabase/migrations/20260819000400_archive_referenced_student_jwb_facts.sql

do $archive_jwb_facts_regression$
declare
  manual_package jsonb := '{
    "id":"PKG-MANUAL-ARCHIVE","name":"Manual","subjectIds":["English"],
    "purchaseRecords":[{"id":"BUY-MANUAL-ARCHIVE","purchasedAt":"2025-01-01T00:00:00.000Z","hours":3}],
    "consumedHours":1
  }'::jsonb;
  jwb_package jsonb := '{
    "id":"PKG-JWB-ARCHIVE","name":"JWB","subjectIds":["Maths"],
    "purchaseRecords":[{"id":"BUY-JWB-ARCHIVE","purchasedAt":"2025-02-01T00:00:00.000Z","hours":8}],
    "consumedHours":2
  }'::jsonb;
  source_student jsonb;
  archived jsonb;
  replayed jsonb;
begin
  source_student := jsonb_build_object(
    'id', 'STU-ARCHIVE-JWB',
    'studentNumber', '20250201001',
    'studentNumberDateSource', 'jwb_first_positive_contract',
    'name', 'Archive JWB Learner',
    'status', '在读',
    'sourceRow', 45,
    'masterSourceKey', 'MSK-ARCHIVE-45',
    'importSource', 'master',
    'jwbMatchStatus', 'matched',
    'jwbSourceRow', 'JWB-45',
    'remainingHours', -2,
    'contractHours', 8,
    'contractEffectiveDate', '2025-02-01',
    'firstJwbHourEntryDate', '2025-02-01',
    'packageCoverage', 'none',
    'lessonPackages', jsonb_build_array(manual_package, jwb_package),
    'historicalJwbSnapshot', jsonb_build_object(
      'retained', jsonb_build_object('remainingHours', 1, 'jwbSourceRow', 'JWB-OLD'),
      'currentAggregate', jsonb_build_object(
        'remainingHours', 4, 'packageCoverage', 'none', 'jwbSourceRow', 'JWB-CURRENT'
      )
    ),
    'customSourceEvidence', 'preserve-me'
  );

  archived := internal.student_import_canonical_archive(source_student);

  if archived ? 'importSource'
     or archived ? 'jwbMatchStatus'
     or archived ? 'jwbSourceRow'
     or archived ? 'remainingHours'
     or archived ? 'contractHours'
     or archived ? 'contractEffectiveDate'
     or archived ? 'firstJwbHourEntryDate'
  then
    raise exception using errcode = 'P0001', message = 'archive_jwb_active_fields_not_stripped';
  end if;
  if archived ->> 'packageCoverage' <> 'partial'
     or archived -> 'lessonPackages' <> jsonb_build_array(manual_package, jwb_package)
  then
    raise exception using errcode = 'P0001', message = 'archive_package_references_not_preserved';
  end if;
  if archived #>> '{historicalJwbSnapshot,retained,remainingHours}' <> '-2'
     or archived #>> '{historicalJwbSnapshot,retained,contractHours}' <> '8'
     or archived #>> '{historicalJwbSnapshot,retained,packageCoverage}' <> 'none'
     or archived #>> '{historicalJwbSnapshot,retained,jwbSourceRow}' <> 'JWB-45'
     or archived #> '{historicalJwbSnapshot,retained,lessonPackages}' <> jsonb_build_array(jwb_package)
     or archived #>> '{historicalJwbSnapshot,currentAggregate,remainingHours}' <> '4'
  then
    raise exception using errcode = 'P0001', message = 'archive_jwb_history_not_preserved';
  end if;
  if archived ->> 'studentNumber' <> '20250201001'
     or archived ->> 'studentNumberDateSource' <> 'jwb_first_positive_contract'
     or archived ->> 'sourceRow' <> '45'
     or archived ->> 'masterSourceKey' <> 'MSK-ARCHIVE-45'
     or archived ->> 'customSourceEvidence' <> 'preserve-me'
  then
    raise exception using errcode = 'P0001', message = 'archive_identity_or_source_history_lost';
  end if;

  replayed := internal.student_import_canonical_archive(archived);
  if replayed <> archived then
    raise exception using errcode = 'P0001', message = 'archive_jwb_canonical_replay_changed';
  end if;
end;
$archive_jwb_facts_regression$;

rollback;

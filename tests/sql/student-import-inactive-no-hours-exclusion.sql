\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Disposable runtime regression for the approved Tencent roster exception.
-- Run against a throwaway database migrated through the deployed
-- 20260817000800 predecessor only (do not apply 20260818000100–010):
--   psql -h /private/tmp -p 55438 -d student_import_test \
--     -f tests/sql/student-import-inactive-no-hours-exclusion.sql
--
-- No persistent state is touched.  This verifies that an exact
-- `不活跃 + 无课时` row remains source evidence only, cannot block an active
-- same-name peer or consume its JWB identity, and still preserves a referenced
-- pre-existing student as read-only historical evidence.

begin;
set local plpgsql.variable_conflict = use_column;

-- Applying the forward policy patch inside this disposable transaction proves
-- it can be deployed directly after 20260817000800 without importing any
-- unrelated performance follow-up.
\ir ../../supabase/migrations/20260818001200_restore_inactive_no_hours_roster_exclusion.sql

do $inactive_no_hours_projection_fixture$
declare
  master_rows jsonb := $master_rows$[
    {"sourceRow":"M-ACTIVE","name":"Current Learner","status":"在读","jwbMemId":"J-CURRENT"},
    {"sourceRow":"M-INACTIVE","name":"Current Learner","status":"不活跃 + 无课时","jwbMemId":"J-CURRENT"}
  ]$master_rows$::jsonb;
  jwb_rows jsonb := $jwb_rows$[
    {"sourceRow":"J-CURRENT","name":"Current Learner","remainingHours":3,"contractHours":5,"packageCoverage":"none"},
    {"sourceRow":"J-ONLY","name":"No Tencent Master","remainingHours":8,"contractHours":8,"packageCoverage":"none"}
  ]$jwb_rows$::jsonb;
  current_students jsonb := $current_students$[
    {"id":"HISTORICAL-INACTIVE","name":"Historical Learner","status":"在读","segment":"VIP"}
  ]$current_students$::jsonb;
  stale_links jsonb := $stale_links$[
    {"masterSourceRow":"M-INACTIVE","studentId":"HISTORICAL-INACTIVE","jwbSourceRow":"J-CURRENT"}
  ]$stale_links$::jsonb;
  projection jsonb;
  duplicate_candidates jsonb;
  source_state internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
begin
  if internal.student_import_master_jwb_member_id_error(
    master_rows, jwb_rows, '[]'::jsonb
  ) is not null then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_member_id_reservation_regression';
  end if;

  projection := internal.student_import_canonical_projection(
    'inactive-no-hours-fixture',
    master_rows,
    jwb_rows,
    current_students,
    stale_links,
    '["HISTORICAL-INACTIVE"]'::jsonb
  );

  if (select count(*) from jsonb_array_elements(projection) student
      where student ->> 'importSource' = 'master') <> 1
     or not exists (
       select 1 from jsonb_array_elements(projection) student
       where student ->> 'importSource' = 'master'
         and student ->> 'sourceRow' = 'M-ACTIVE'
         and student ->> 'jwbMatchStatus' = 'matched'
         and student #>> '{historicalJwbSnapshot,currentAggregate,jwbSourceRow}' = 'J-CURRENT'
     )
     or exists (
       select 1 from jsonb_array_elements(projection) student
       where student ->> 'sourceRow' = 'M-INACTIVE'
          or student ->> 'name' = 'No Tencent Master'
     )
     or not exists (
       select 1 from jsonb_array_elements(projection) student
       where student ->> 'id' = 'HISTORICAL-INACTIVE'
         and student ->> 'importArchived' = 'true'
         and student ->> 'importArchivedReason' = 'referenced_history'
     ) then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_projection_regression';
  end if;

  source_state.source_id := 'inactive-no-hours-fixture';
  source_state.revision := 'r1';
  source_state.rows := master_rows;
  students_state.version := 1;
  duplicate_candidates := internal.student_import_master_duplicate_candidates(
    source_state, students_state
  );
  if jsonb_array_length(duplicate_candidates) <> 0 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_duplicate_review_regression';
  end if;
end;
$inactive_no_hours_projection_fixture$;

rollback;

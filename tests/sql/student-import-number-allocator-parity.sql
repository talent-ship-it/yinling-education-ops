\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Run against a disposable database migrated through 20260818000600, before
-- the allocator optimization.  The fixture first captures the old two-arg
-- allocator, applies the forward patch only inside this transaction, then
-- requires both JSONB and canonical `::text` parity.  Nothing survives the
-- final ROLLBACK.
begin;

do $student_import_number_allocator_predecessor_guard$
declare
  definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_assign_student_numbers(jsonb,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_import_number_allocator_parity_allocator_missing';
  end if;
  if position('row_number() over (' in definition) <> 0
     or position('reservation_assignments jsonb' in definition) <> 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_number_allocator_parity_requires_pre_180007_shape';
  end if;
end;
$student_import_number_allocator_predecessor_guard$;

-- Keep every test number away from the normal fixture period.  A collision
-- means this is not a clean predecessor-shaped database, rather than silently
-- changing the serial floors which this test is intended to exercise.
do $student_import_number_allocator_fixture_reservation_collision$
begin
  if exists (
    select 1
    from internal.student_number_reservations reservation
    where reservation.student_id in (
      'ALLOCATOR-PARITY-RESTORE',
      'ALLOCATOR-PARITY-EXPLICIT',
      'ALLOCATOR-PARITY-OVERFLOW'
    )
      or reservation.student_number in (
        '20991231007',
        '20800101017',
        '20821231999'
      )
  ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_number_allocator_parity_fixture_reservation_collision';
  end if;
end;
$student_import_number_allocator_fixture_reservation_collision$;

insert into internal.student_number_reservations(
  student_number,
  student_id,
  student_number_date_source
)
values
  ('20991231007', 'ALLOCATOR-PARITY-RESTORE', 'system_entry_date'),
  ('20800101017', 'ALLOCATOR-PARITY-EXPLICIT', 'system_entry_date'),
  ('20821231999', 'ALLOCATOR-PARITY-OVERFLOW', 'system_entry_date');

create temporary table student_import_number_allocator_parity (
  fixture_students jsonb not null,
  expected_students jsonb not null,
  expected_students_text text not null
) on commit drop;

create temporary table student_import_number_allocator_error_cases (
  case_name text primary key,
  students jsonb not null,
  expected_state text not null,
  expected_message text not null,
  baseline_error jsonb
) on commit drop;

create function pg_temp.student_import_number_allocator_error(
  p_students jsonb
)
returns jsonb
language plpgsql
as $student_import_number_allocator_error$
begin
  perform internal.student_import_assign_student_numbers(
    p_students,
    '2099-12-31'
  );
  return jsonb_build_object('state', null, 'message', null);
exception when others then
  return jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
end;
$student_import_number_allocator_error$;

do $student_import_number_allocator_baseline$
declare
  generated_students jsonb;
  fixture_students jsonb;
  expected_students jsonb;
  numbered_count integer;
  date_key_count integer;
  formal_fallback_count integer;
  jwb_candidate_count integer;
  system_entry_count integer;
begin
  -- 540 formal-master allocations span 245 JWB days plus one formal-import
  -- fallback day.  Three same-day UTF-16-diverse IDs make the per-day
  -- ordering observable without depending on the incoming JSON order.
  select coalesce(jsonb_agg(
    (case
      when n > 520 then jsonb_build_object(
        'id', 'ALLOCATOR-PARITY-' || lpad(n::text, 4, '0'),
        'importSource', 'master',
        'name', 'Formal fallback ' || n
      )
      when n = 2 then jsonb_build_object(
        'id', 'ALLOCATOR-PARITY-' || lpad(n::text, 4, '0'),
        'importSource', 'master',
        'name', 'First JWB candidate ' || n,
        'firstJwbHourEntryDate', to_char(
          date '2080-01-01' + ((n - 1) % 245),
          'YYYY-MM-DD'
        )
      )
      else jsonb_build_object(
        'id', case n
          when 1 then 'ALLOCATOR-PARITY-😀'
          when 246 then 'ALLOCATOR-PARITY-𝄞'
          when 491 then 'ALLOCATOR-PARITY-Ａ'
          else 'ALLOCATOR-PARITY-' || lpad(n::text, 4, '0')
        end,
        'importSource', 'master',
        'name', 'JWB candidate ' || n,
        'studentNumberJwbDateCandidate', case
          when n = 3 then to_char(
            date '2080-01-01' + ((n - 1) % 245),
            'YYYY-MM-DD'
          ) || 'T13:00:00+10:00'
          else to_char(
            date '2080-01-01' + ((n - 1) % 245),
            'YYYY-MM-DD'
          )
        end
      )
    end)
    order by n
    ), '[]'::jsonb)
  into generated_students
  from generate_series(1, 540) n;

  fixture_students := generated_students || jsonb_build_array(
    -- A reservation makes even this malformed JWB candidate restorable.
    jsonb_build_object(
      'id', 'ALLOCATOR-PARITY-RESTORE',
      'importSource', 'master',
      'name', 'Reservation restore',
      'studentNumberJwbDateCandidate', 'not-a-date'
    ),
    -- An explicit number is retained and picks up its durable source.
    jsonb_build_object(
      'id', 'ALLOCATOR-PARITY-EXPLICIT',
      'importSource', 'master',
      'name', 'Explicit reservation',
      'studentNumber', '20800101017'
    ),
    -- Manual current students are deliberately not allocated by this helper.
    jsonb_build_object(
      'id', 'ALLOCATOR-PARITY-MANUAL',
      'importSource', 'manual_trial',
      'name', 'Manual current student'
    )
  );

  expected_students := internal.student_import_assign_student_numbers(
    fixture_students,
    '2099-12-31'
  );

  select count(*)::integer,
    count(distinct left(student.value ->> 'studentNumber', 8))
      filter (where student.value ? 'studentNumber')::integer,
    count(*) filter (
      where student.value ->> 'studentNumberDateSource' = 'formal_import_date'
    )::integer,
    count(*) filter (
      where student.value ->> 'studentNumberDateSource' =
        'jwb_first_positive_contract'
    )::integer,
    count(*) filter (
      where student.value ->> 'studentNumberDateSource' = 'system_entry_date'
    )::integer
  into numbered_count,
    date_key_count,
    formal_fallback_count,
    jwb_candidate_count,
    system_entry_count
  from jsonb_array_elements(expected_students) student(value)
  where student.value ? 'studentNumber';

  if jsonb_array_length(fixture_students) <> 543
     or jsonb_array_length(expected_students) <> 543
     or numbered_count <> 542
     or date_key_count <> 246
     or formal_fallback_count <> 20
     or jwb_candidate_count <> 520
     or system_entry_count <> 2
     or expected_students #>> '{540,studentNumber}' <> '20991231007'
     or expected_students #>> '{540,studentNumberDateSource}' <> 'system_entry_date'
     or expected_students #>> '{541,studentNumber}' <> '20800101017'
     or expected_students #>> '{541,studentNumberDateSource}' <> 'system_entry_date'
     or expected_students #> '{542,studentNumber}' is not null
     or exists (
       select 1
       from jsonb_array_elements(expected_students) student(value)
       where student.value ? 'studentNumberJwbDateCandidate'
     ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_number_allocator_parity_fixture_boundary_failed';
  end if;

  insert into student_import_number_allocator_parity(
    fixture_students,
    expected_students,
    expected_students_text
  )
  values (fixture_students, expected_students, expected_students::text);
end;
$student_import_number_allocator_baseline$;

insert into student_import_number_allocator_error_cases(
  case_name,
  students,
  expected_state,
  expected_message
)
values
  (
    'duplicate_student_id',
    $duplicate_student_id$[
      {"id":"ALLOCATOR-PARITY-DUPLICATE","importSource":"master"},
      {"id":"ALLOCATOR-PARITY-DUPLICATE","importSource":"master","studentNumber":"20800101234"}
    ]$duplicate_student_id$::jsonb,
    '23505',
    'duplicate_student_id'
  ),
  (
    'duplicate_student_number',
    $duplicate_student_number$[
      {"id":"ALLOCATOR-PARITY-DUPLICATE-NUMBER-A","importSource":"master","studentNumber":"20800101234"},
      {"id":"ALLOCATOR-PARITY-DUPLICATE-NUMBER-B","importSource":"master","studentNumber":"20800101234"}
    ]$duplicate_student_number$::jsonb,
    '23505',
    'duplicate_student_number'
  ),
  (
    'student_number_reservation_conflict',
    $reservation_conflict$[
      {"id":"ALLOCATOR-PARITY-CONFLICT-OWNER","importSource":"master","studentNumber":"20800101017"}
    ]$reservation_conflict$::jsonb,
    '23505',
    'student_number_reservation_conflict'
  ),
  (
    'daily_overflow_before_malformed_candidate',
    $daily_overflow$[
      {"id":"ALLOCATOR-PARITY-OVERFLOW-VALID","importSource":"master","studentNumberJwbDateCandidate":"2082-12-31"},
      {"id":"ALLOCATOR-PARITY-OVERFLOW-MALFORMED","importSource":"master","studentNumberJwbDateCandidate":"not-a-date"}
    ]$daily_overflow$::jsonb,
    '22023',
    'student_number_daily_sequence_exhausted'
  ),
  (
    'malformed_jwb_date',
    $malformed_jwb_date$[
      {"id":"ALLOCATOR-PARITY-MALFORMED","importSource":"master","studentNumberJwbDateCandidate":"not-a-date"}
    ]$malformed_jwb_date$::jsonb,
    '22023',
    'student_number_jwb_first_positive_date_invalid'
  );

do $student_import_number_allocator_error_baseline$
declare
  case_item record;
  captured_error jsonb;
begin
  for case_item in
    select *
    from student_import_number_allocator_error_cases
    order by case_name
  loop
    captured_error := pg_temp.student_import_number_allocator_error(
      case_item.students
    );
    if captured_error is distinct from jsonb_build_object(
      'state', case_item.expected_state,
      'message', case_item.expected_message
    ) then
      raise exception using errcode = 'P0001', message = format(
        'student_import_number_allocator_parity_baseline_error_failed:%s:%s',
        case_item.case_name,
        captured_error::text
      );
    end if;
    update student_import_number_allocator_error_cases
    set baseline_error = captured_error
    where case_name = case_item.case_name;
  end loop;
end;
$student_import_number_allocator_error_baseline$;

\ir ../../supabase/migrations/20260818000700_optimize_student_number_allocator.sql

do $student_import_number_allocator_parity_assertion$
declare
  parity student_import_number_allocator_parity%rowtype;
  case_item record;
  actual_students jsonb;
  actual_error jsonb;
begin
  select * into parity
  from student_import_number_allocator_parity;

  actual_students := internal.student_import_assign_student_numbers(
    parity.fixture_students,
    '2099-12-31'
  );
  if actual_students is distinct from parity.expected_students
     or actual_students::text <> parity.expected_students_text then
    raise exception using errcode = 'P0001',
      message = 'student_import_number_allocator_parity_failed';
  end if;

  for case_item in
    select *
    from student_import_number_allocator_error_cases
    order by case_name
  loop
    actual_error := pg_temp.student_import_number_allocator_error(
      case_item.students
    );
    if actual_error is distinct from case_item.baseline_error
       or actual_error::text <> case_item.baseline_error::text
       or actual_error is distinct from jsonb_build_object(
         'state', case_item.expected_state,
         'message', case_item.expected_message
       ) then
      raise exception using errcode = 'P0001', message = format(
        'student_import_number_allocator_differential_failed:%s:%s:%s',
        case_item.case_name,
        case_item.baseline_error::text,
        actual_error::text
      );
    end if;
  end loop;
end;
$student_import_number_allocator_parity_assertion$;

rollback;

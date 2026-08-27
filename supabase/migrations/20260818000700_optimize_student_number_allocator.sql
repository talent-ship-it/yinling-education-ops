-- The formal import can allocate hundreds of student numbers across hundreds
-- of Melbourne date keys.  The original allocator rebuilt JSONB maps and the
-- whole result array for each reservation/candidate/student.  Keep its
-- validation and allocation contract intact, but aggregate immutable maps,
-- serial floors, generated assignments, and the final ordered output once.

set local lock_timeout = '1s';

do $student_import_number_allocator_set_based$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_assign_student_numbers(jsonb,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_missing';
  end if;

  anchor := $allocator_declaration_anchor$  reservation_date_source_by_student_id jsonb := '{}'::jsonb;
begin
$allocator_declaration_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $allocator_declaration_replacement$  reservation_date_source_by_student_id jsonb := '{}'::jsonb;
  reservation_assignments jsonb := '{}'::jsonb;
  generated_assignments jsonb := '{}'::jsonb;
  allocation_exhausted boolean := false;
begin
$allocator_declaration_replacement$);

  anchor := $reservation_loop_anchor$  -- The permanent reservation registry is both the non-reuse boundary and
  -- the durable origin snapshot for students absent from a later roster.
  for reservation_item in
    select reservation.student_number, reservation.student_id,
      reservation.student_number_date_source
    from internal.student_number_reservations reservation
    order by reservation.student_number collate "C"
  loop
    if reservation_item.student_number !~ '^[0-9]{11}$'
       or nullif(btrim(reservation_item.student_id), '') is null
       or (reservation_item.student_number_date_source is not null
         and reservation_item.student_number_date_source not in (
           'jwb_first_positive_contract', 'formal_import_date'
           , 'system_entry_date'
         )) then
      raise exception using errcode = '22023', message = 'student_number_reservation_invalid';
    end if;
    reservation_by_student_id := jsonb_set(
      reservation_by_student_id,
      array[reservation_item.student_id],
      to_jsonb(reservation_item.student_number),
      true
    );
    reservation_by_number := jsonb_set(
      reservation_by_number,
      array[reservation_item.student_number],
      to_jsonb(reservation_item.student_id),
      true
    );
    if reservation_item.student_number_date_source is not null then
      reservation_date_source_by_student_id := jsonb_set(
        reservation_date_source_by_student_id,
        array[reservation_item.student_id],
        to_jsonb(reservation_item.student_number_date_source),
        true
      );
    end if;
    date_key := left(reservation_item.student_number, 8);
    serial := right(reservation_item.student_number, 3)::integer;
    serials := jsonb_set(
      serials,
      array[date_key],
      to_jsonb(greatest(coalesce((serials ->> date_key)::integer, 0), serial)),
      true
    );
  end loop;
$reservation_loop_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_reservation_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $reservation_loop_replacement$  -- Validate every persisted reservation before constructing its lookup maps.
  -- The existing table is one-to-one by student ID and number, so a set-based
  -- aggregate preserves the prior lookup semantics after this validation.
  if exists (
    select 1
    from internal.student_number_reservations reservation
    where reservation.student_number !~ '^[0-9]{11}$'
       or nullif(btrim(reservation.student_id), '') is null
       or (reservation.student_number_date_source is not null
         and reservation.student_number_date_source not in (
           'jwb_first_positive_contract', 'formal_import_date', 'system_entry_date'
         ))
  ) then
    raise exception using errcode = '22023', message = 'student_number_reservation_invalid';
  end if;

  select
    coalesce(jsonb_object_agg(
      reservation.student_id, to_jsonb(reservation.student_number)
    ), '{}'::jsonb),
    coalesce(jsonb_object_agg(
      reservation.student_number, to_jsonb(reservation.student_id)
    ), '{}'::jsonb),
    coalesce(jsonb_object_agg(
      reservation.student_id, to_jsonb(reservation.student_number_date_source)
    ) filter (where reservation.student_number_date_source is not null), '{}'::jsonb)
  into reservation_by_student_id,
    reservation_by_number,
    reservation_date_source_by_student_id
  from internal.student_number_reservations reservation;
$reservation_loop_replacement$);

  anchor := $input_validation_tail_anchor$      seen_numbers := array_append(seen_numbers, current_number);
      date_key := left(current_number, 8);
      serial := right(current_number, 3)::integer;
      serials := jsonb_set(
        serials,
        array[date_key],
        to_jsonb(greatest(coalesce((serials ->> date_key)::integer, 0), serial)),
        true
      );
    elsif reserved_number is not null then
      assignments := jsonb_set(
        assignments,
        array[student_item.value ->> 'id'],
        jsonb_strip_nulls(jsonb_build_object(
          'studentNumber', reserved_number,
          'studentNumberDateSource', reserved_date_source
        )),
        true
      );
    end if;
$input_validation_tail_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_validation_tail_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $input_validation_tail_replacement$      seen_numbers := array_append(seen_numbers, current_number);
    end if;
$input_validation_tail_replacement$);

  anchor := $allocation_loop_anchor$  -- Only formal master records can receive a no-JWB fallback. Current manual
  -- students remain governed by the normal write trigger, never this import
  -- date. A present but malformed JWB historical date fails closed rather
  -- than silently changing its provenance to formal_import_date.
  for number_item in
    select
      student.value ->> 'id' as student_id,
      case
        when student.value ? 'studentNumberJwbDateCandidate' then
          replace(left(student.value ->> 'studentNumberJwbDateCandidate', 10), '-', '')
        when student.value ? 'firstJwbHourEntryDate' then
          replace(left(student.value ->> 'firstJwbHourEntryDate', 10), '-', '')
        else replace(p_formal_import_date, '-', '')
      end as date_key,
      case when student.value ? 'studentNumberJwbDateCandidate'
        or student.value ? 'firstJwbHourEntryDate'
        then 'jwb_first_positive_contract'
        else 'formal_import_date'
      end as date_source
    from jsonb_array_elements(p_students) student(value)
    where coalesce(student.value ->> 'importSource', '') = 'master'
      and not (student.value ? 'studentNumber')
      and not (assignments ? (student.value ->> 'id'))
      and (
        not (student.value ? 'studentNumberJwbDateCandidate')
          and not (student.value ? 'firstJwbHourEntryDate')
        or (
          jsonb_typeof(case when student.value ? 'studentNumberJwbDateCandidate'
            then student.value -> 'studentNumberJwbDateCandidate'
            else student.value -> 'firstJwbHourEntryDate' end) = 'string'
          and left(case when student.value ? 'studentNumberJwbDateCandidate'
            then student.value ->> 'studentNumberJwbDateCandidate'
            else student.value ->> 'firstJwbHourEntryDate' end, 10) ~ '^\d{4}-\d{2}-\d{2}$'
          and to_char(
            to_date(left(case when student.value ? 'studentNumberJwbDateCandidate'
              then student.value ->> 'studentNumberJwbDateCandidate'
              else student.value ->> 'firstJwbHourEntryDate' end, 10), 'YYYY-MM-DD'),
            'YYYY-MM-DD'
          ) = left(case when student.value ? 'studentNumberJwbDateCandidate'
            then student.value ->> 'studentNumberJwbDateCandidate'
            else student.value ->> 'firstJwbHourEntryDate' end, 10)
        )
      )
    order by
      case
        when student.value ? 'studentNumberJwbDateCandidate' then
          replace(left(student.value ->> 'studentNumberJwbDateCandidate', 10), '-', '')
        when student.value ? 'firstJwbHourEntryDate' then
          replace(left(student.value ->> 'firstJwbHourEntryDate', 10), '-', '')
        else replace(p_formal_import_date, '-', '')
      end,
      internal.student_import_utf16_sort_key(student.value ->> 'id')
  loop
    serial := coalesce((serials ->> number_item.date_key)::integer, 0) + 1;
    if serial > 999 then
      raise exception using errcode = '22023', message = 'student_number_daily_sequence_exhausted';
    end if;
    current_number := number_item.date_key || lpad(serial::text, 3, '0');
    serials := jsonb_set(serials, array[number_item.date_key], to_jsonb(serial), true);
    assignments := jsonb_set(
      assignments,
      array[number_item.student_id],
      jsonb_build_object(
        'studentNumber', current_number,
        'studentNumberDateSource', number_item.date_source
      ),
      true
    );
  end loop;
$allocation_loop_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_allocation_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $allocation_loop_replacement$  -- Only formal master records can receive a no-JWB fallback. Current manual
  -- students remain governed by the normal write trigger, never this import
  -- date. A present but malformed JWB historical date fails closed rather
  -- than silently changing its provenance to formal_import_date.
  select coalesce(jsonb_object_agg(
    student.value ->> 'id',
    jsonb_strip_nulls(jsonb_build_object(
      'studentNumber', reservation_by_student_id ->> (student.value ->> 'id'),
      'studentNumberDateSource', reservation_date_source_by_student_id ->> (student.value ->> 'id')
    ))
  ), '{}'::jsonb)
  into reservation_assignments
  from jsonb_array_elements(p_students) student(value)
  where not (student.value ? 'studentNumber')
    and reservation_by_student_id ? (student.value ->> 'id');

  with serial_values as (
    select left(reservation.student_number, 8) as serial_date_key,
      right(reservation.student_number, 3)::integer as serial_value
    from internal.student_number_reservations reservation

    union all

    select left(student.value ->> 'studentNumber', 8) as serial_date_key,
      right(student.value ->> 'studentNumber', 3)::integer as serial_value
    from jsonb_array_elements(p_students) student(value)
    where student.value ? 'studentNumber'
  ), serial_floors as (
    select serial_values.serial_date_key,
      max(serial_values.serial_value)::integer as max_serial
    from serial_values
    group by serial_values.serial_date_key
  ), candidate_inputs as (
    select
      student.value ->> 'id' as student_id,
      case
        when student.value ? 'studentNumberJwbDateCandidate' then
          replace(left(student.value ->> 'studentNumberJwbDateCandidate', 10), '-', '')
        when student.value ? 'firstJwbHourEntryDate' then
          replace(left(student.value ->> 'firstJwbHourEntryDate', 10), '-', '')
        else replace(p_formal_import_date, '-', '')
      end as candidate_date_key,
      case when student.value ? 'studentNumberJwbDateCandidate'
        or student.value ? 'firstJwbHourEntryDate'
        then 'jwb_first_positive_contract'
        else 'formal_import_date'
      end as candidate_date_source
    from jsonb_array_elements(p_students) student(value)
    where coalesce(student.value ->> 'importSource', '') = 'master'
      and not (student.value ? 'studentNumber')
      and not (reservation_assignments ? (student.value ->> 'id'))
      and (
        not (student.value ? 'studentNumberJwbDateCandidate')
          and not (student.value ? 'firstJwbHourEntryDate')
        or (
          jsonb_typeof(case when student.value ? 'studentNumberJwbDateCandidate'
            then student.value -> 'studentNumberJwbDateCandidate'
            else student.value -> 'firstJwbHourEntryDate' end) = 'string'
          and left(case when student.value ? 'studentNumberJwbDateCandidate'
            then student.value ->> 'studentNumberJwbDateCandidate'
            else student.value ->> 'firstJwbHourEntryDate' end, 10) ~ '^\d{4}-\d{2}-\d{2}$'
          and to_char(
            to_date(left(case when student.value ? 'studentNumberJwbDateCandidate'
              then student.value ->> 'studentNumberJwbDateCandidate'
              else student.value ->> 'firstJwbHourEntryDate' end, 10), 'YYYY-MM-DD'),
            'YYYY-MM-DD'
          ) = left(case when student.value ? 'studentNumberJwbDateCandidate'
            then student.value ->> 'studentNumberJwbDateCandidate'
            else student.value ->> 'firstJwbHourEntryDate' end, 10)
        )
      )
  ), candidate_allocations as (
    select candidate.student_id,
      candidate.candidate_date_key,
      candidate.candidate_date_source,
      coalesce(serial_floor.max_serial, 0) + row_number() over (
        partition by candidate.candidate_date_key
        order by internal.student_import_utf16_sort_key(candidate.student_id)
      )::integer as allocated_serial
    from candidate_inputs candidate
    left join serial_floors serial_floor
      on serial_floor.serial_date_key = candidate.candidate_date_key
  )
  select coalesce(jsonb_object_agg(
    allocation.student_id,
    jsonb_build_object(
      'studentNumber', allocation.candidate_date_key || lpad(allocation.allocated_serial::text, 3, '0'),
      'studentNumberDateSource', allocation.candidate_date_source
    )
  ) filter (where allocation.allocated_serial <= 999), '{}'::jsonb),
    coalesce(bool_or(allocation.allocated_serial > 999), false)
  into generated_assignments, allocation_exhausted
  from candidate_allocations allocation;

  if allocation_exhausted then
    raise exception using errcode = '22023', message = 'student_number_daily_sequence_exhausted';
  end if;
  assignments := reservation_assignments || generated_assignments;
$allocation_loop_replacement$);

  anchor := $result_loop_anchor$  for student_item in
    select value, ordinal
    from jsonb_array_elements(p_students) with ordinality as student(value, ordinal)
    order by ordinal
  loop
    reserved_date_source := reservation_date_source_by_student_id ->>
      (student_item.value ->> 'id');
    result := result || jsonb_build_array(
      case
        when assignments ? (student_item.value ->> 'id') then
          (student_item.value - 'studentNumberJwbDateCandidate') ||
            (assignments -> (student_item.value ->> 'id'))
        when student_item.value ? 'studentNumber'
          and not (student_item.value ? 'studentNumberDateSource')
          and reserved_date_source is not null then
          (student_item.value - 'studentNumberJwbDateCandidate') || jsonb_build_object(
            'studentNumberDateSource', reserved_date_source
          )
        else student_item.value - 'studentNumberJwbDateCandidate'
      end
    );
  end loop;
  return result;
$result_loop_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_result_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $result_loop_replacement$  select coalesce(jsonb_agg(
    case
      when assignments ? (student.value ->> 'id') then
        (student.value - 'studentNumberJwbDateCandidate') ||
          (assignments -> (student.value ->> 'id'))
      when student.value ? 'studentNumber'
        and not (student.value ? 'studentNumberDateSource')
        and reservation_date_source_by_student_id ->> (student.value ->> 'id') is not null then
        (student.value - 'studentNumberJwbDateCandidate') || jsonb_build_object(
          'studentNumberDateSource',
          reservation_date_source_by_student_id ->> (student.value ->> 'id')
        )
      else student.value - 'studentNumberJwbDateCandidate'
    end
    order by student.ordinal
  ), '[]'::jsonb)
  into result
  from jsonb_array_elements(p_students) with ordinality as student(value, ordinal);
  return result;
$result_loop_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_assign_student_numbers(jsonb,text)'::regprocedure
  ) into definition;
  if position('reservation_assignments jsonb' in definition) = 0
     or position('generated_assignments jsonb' in definition) = 0
     or position('row_number() over (' in definition) = 0
     or position('jsonb_object_agg(' in definition) = 0
     or position('jsonb_agg(' in definition) = 0
     or position('serials := jsonb_set' in definition) <> 0
     or position('assignments := jsonb_set' in definition) <> 0
     or position('result := result ||' in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_number_allocator_patch_verification_failed';
  end if;
end;
$student_import_number_allocator_set_based$;

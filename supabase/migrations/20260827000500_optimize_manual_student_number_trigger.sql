-- Normal student creation updates the complete students JSONB projection. The
-- original number trigger rebuilt lookup maps one reservation at a time and
-- performed three reservation-table statements for every existing student.
-- At the current roster size that work exceeds the API statement timeout.
-- Keep the same validation, immutable-number, allocation and two-way registry
-- proof while materialising maps and writing reservations once per statement.

set local lock_timeout = '1s';

do $manual_student_number_trigger_set_based$
declare
  definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.assign_new_student_numbers()'::regprocedure
  ) into definition;

  if definition is null then
    raise exception using errcode = 'P0001',
      message = 'assign_new_student_numbers_trigger_missing';
  end if;
  if position('reservation_maps_set_based_v1' in definition) > 0 then
    return;
  end if;
  if position('for reservation_item in' in definition) = 0
     or position('old_by_id := jsonb_set' in definition) = 0
     or position('result := result || jsonb_build_array' in definition) = 0
     or position('insert into internal.student_number_reservations(student_number, student_id)' in definition) = 0
     or position('student_number_reserved_identity' in definition) = 0 then
    raise exception using errcode = 'P0001',
      message = 'assign_new_student_numbers_predecessor_mismatch';
  end if;

  execute $replacement$
create or replace function internal.assign_new_student_numbers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  student_item record;
  prior_value jsonb;
  current_number text;
  reserved_number text;
  reserved_student_id text;
  date_key text := to_char(current_timestamp at time zone 'Australia/Melbourne', 'YYYYMMDD');
  serial integer := 0;
  old_by_id jsonb := '{}'::jsonb;
  assignments jsonb := '{}'::jsonb;
  reserved_assignments jsonb := '{}'::jsonb;
  generated_assignments jsonb := '{}'::jsonb;
  reservation_by_student_id jsonb := '{}'::jsonb;
  reservation_by_number jsonb := '{}'::jsonb;
  is_formal_import boolean;
  candidate_count integer := 0;
begin
  -- reservation_maps_set_based_v1
  if new.entity <> 'students' then
    return new;
  end if;
  if jsonb_typeof(new.payload) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
  end if;
  if tg_op = 'UPDATE' and jsonb_typeof(old.payload) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'previous_students_payload_must_be_array';
  end if;

  -- The students state row serialises ordinary writes. Keep the registry lock
  -- for future alternate writers before taking its immutable snapshot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('internal.student_number_reservations', 0)
  );

  if exists (
    select 1
    from internal.student_number_reservations reservation
    where reservation.student_number !~ '^[0-9]{11}$'
       or nullif(btrim(reservation.student_id), '') is null
  ) then
    raise exception using errcode = '22023', message = 'student_number_reservation_invalid';
  end if;

  select coalesce(jsonb_object_agg(
      reservation.student_id, to_jsonb(reservation.student_number)
    ), '{}'::jsonb),
    coalesce(jsonb_object_agg(
      reservation.student_number, to_jsonb(reservation.student_id)
    ), '{}'::jsonb),
    coalesce(max(right(reservation.student_number, 3)::integer)
      filter (where left(reservation.student_number, 8) = date_key), 0)
  into reservation_by_student_id, reservation_by_number, serial
  from internal.student_number_reservations reservation;

  if tg_op = 'UPDATE' then
    if exists (
      select 1
      from jsonb_array_elements(old.payload) old_student(value)
      where jsonb_typeof(old_student.value) is distinct from 'object'
         or jsonb_typeof(old_student.value -> 'id') is distinct from 'string'
         or nullif(btrim(old_student.value ->> 'id'), '') is null
    ) then
      raise exception using errcode = '22023', message = 'previous_student_payload_item_or_id_invalid';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(old.payload) old_student(value)
      group by old_student.value ->> 'id'
      having count(*) > 1
    ) then
      raise exception using errcode = '23505', message = 'previous_duplicate_student_id';
    end if;
    select coalesce(jsonb_object_agg(
      old_student.value ->> 'id', old_student.value
    ), '{}'::jsonb)
    into old_by_id
    from jsonb_array_elements(old.payload) old_student(value);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.payload) student(value)
    where jsonb_typeof(student.value) is distinct from 'object'
       or jsonb_typeof(student.value -> 'id') is distinct from 'string'
       or nullif(btrim(student.value ->> 'id'), '') is null
  ) then
    raise exception using errcode = '22023', message = 'student_payload_item_or_id_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(new.payload) student(value)
    group by student.value ->> 'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'duplicate_student_id';
  end if;

  -- Preserve the predecessor's per-student validation ordering while every
  -- old/reservation lookup is now an in-memory JSONB map lookup.
  for student_item in
    select value, ordinal
    from jsonb_array_elements(new.payload) with ordinality student(value, ordinal)
    order by ordinal
  loop
    prior_value := old_by_id -> (student_item.value ->> 'id');
    is_formal_import := coalesce(student_item.value ->> 'importSource', '') = 'master';
    if prior_value is not null and not (prior_value ? 'studentNumber')
       and student_item.value ? 'studentNumber'
       and not is_formal_import then
      raise exception using errcode = '22023', message = 'student_number_server_assigned';
    end if;
    if prior_value is null and not is_formal_import
       and student_item.value ? 'studentNumber' then
      raise exception using errcode = '22023', message = 'student_number_server_assigned';
    end if;
    if prior_value ? 'studentNumber' then
      if jsonb_typeof(prior_value -> 'studentNumber') is distinct from 'string'
         or prior_value ->> 'studentNumber' !~ '^[0-9]{11}$' then
        raise exception using errcode = '22023', message = 'previous_student_number_invalid';
      end if;
      if student_item.value ->> 'studentNumber'
         is distinct from prior_value ->> 'studentNumber' then
        raise exception using errcode = '22023', message = 'student_number_immutable';
      end if;
      current_number := prior_value ->> 'studentNumber';
    elsif is_formal_import and student_item.value ? 'studentNumber' then
      if jsonb_typeof(student_item.value -> 'studentNumber') is distinct from 'string'
         or student_item.value ->> 'studentNumber' !~ '^[0-9]{11}$' then
        raise exception using errcode = '22023', message = 'student_number_invalid';
      end if;
      current_number := student_item.value ->> 'studentNumber';
    else
      current_number := null;
    end if;

    reserved_number := reservation_by_student_id ->> (student_item.value ->> 'id');
    if current_number is null and reserved_number is not null then
      if not is_formal_import then
        raise exception using errcode = '22023', message = 'student_number_reserved_identity';
      end if;
      current_number := reserved_number;
    end if;
    if current_number is not null then
      reserved_student_id := reservation_by_number ->> current_number;
      if (reserved_number is not null and reserved_number <> current_number)
         or (reserved_student_id is not null
           and reserved_student_id <> student_item.value ->> 'id') then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
    end if;
  end loop;

  if exists (
    with effective_numbers as (
      select case
        when (old_by_id -> (student.value ->> 'id')) ? 'studentNumber'
          then old_by_id -> (student.value ->> 'id') ->> 'studentNumber'
        when coalesce(student.value ->> 'importSource', '') = 'master'
          and student.value ? 'studentNumber' then student.value ->> 'studentNumber'
        when coalesce(student.value ->> 'importSource', '') = 'master'
          then reservation_by_student_id ->> (student.value ->> 'id')
        else null
      end as student_number
      from jsonb_array_elements(new.payload) student(value)
    )
    select 1 from effective_numbers
    where student_number is not null
    group by student_number having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'duplicate_student_number';
  end if;

  select greatest(serial, coalesce(max(right(number_row.student_number, 3)::integer)
    filter (where left(number_row.student_number, 8) = date_key), 0))
  into serial
  from (
    select case
      when (old_by_id -> (student.value ->> 'id')) ? 'studentNumber'
        then old_by_id -> (student.value ->> 'id') ->> 'studentNumber'
      when coalesce(student.value ->> 'importSource', '') = 'master'
        and student.value ? 'studentNumber' then student.value ->> 'studentNumber'
      when coalesce(student.value ->> 'importSource', '') = 'master'
        then reservation_by_student_id ->> (student.value ->> 'id')
      else null
    end as student_number
    from jsonb_array_elements(new.payload) student(value)
  ) number_row;

  select coalesce(jsonb_object_agg(
    student.value ->> 'id',
    to_jsonb(reservation_by_student_id ->> (student.value ->> 'id'))
  ), '{}'::jsonb)
  into reserved_assignments
  from jsonb_array_elements(new.payload) student(value)
  where coalesce(student.value ->> 'importSource', '') = 'master'
    and not (student.value ? 'studentNumber')
    and not ((old_by_id -> (student.value ->> 'id')) ? 'studentNumber')
    and reservation_by_student_id ? (student.value ->> 'id');

  select count(*)::integer
  into candidate_count
  from jsonb_array_elements(new.payload) student(value)
  where not (old_by_id ? (student.value ->> 'id'))
    and coalesce(student.value ->> 'importSource', '') <> 'master'
    and not (reservation_by_student_id ? (student.value ->> 'id'));
  if serial + candidate_count > 999 then
    raise exception using errcode = '22023', message = 'student_number_daily_sequence_exhausted';
  end if;

  select coalesce(jsonb_object_agg(
    candidate.student_id,
    to_jsonb(date_key || lpad((serial + candidate.ordinal)::text, 3, '0'))
  ), '{}'::jsonb)
  into generated_assignments
  from (
    select student.value ->> 'id' as student_id,
      row_number() over (
        order by internal.student_import_utf16_sort_key(student.value ->> 'id')
      )::integer as ordinal
    from jsonb_array_elements(new.payload) student(value)
    where not (old_by_id ? (student.value ->> 'id'))
      and coalesce(student.value ->> 'importSource', '') <> 'master'
      and not (reservation_by_student_id ? (student.value ->> 'id'))
  ) candidate;

  assignments := reserved_assignments || generated_assignments;
  if assignments <> '{}'::jsonb then
    select coalesce(jsonb_agg(
      case when assignments ? (student.value ->> 'id')
        then student.value || jsonb_build_object(
          'studentNumber', assignments ->> (student.value ->> 'id')
        )
        else student.value
      end order by student.ordinal
    ), '[]'::jsonb)
    into new.payload
    from jsonb_array_elements(new.payload) with ordinality student(value, ordinal);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.payload) student(value)
    where student.value ? 'studentNumber'
    group by student.value ->> 'studentNumber'
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'duplicate_student_number';
  end if;

  insert into internal.student_number_reservations(student_number, student_id)
  select student.value ->> 'studentNumber', student.value ->> 'id'
  from jsonb_array_elements(new.payload) student(value)
  where student.value ? 'studentNumber'
  on conflict do nothing;

  if exists (
    select 1
    from jsonb_array_elements(new.payload) student(value)
    left join internal.student_number_reservations number_reservation
      on number_reservation.student_number = student.value ->> 'studentNumber'
    left join internal.student_number_reservations student_reservation
      on student_reservation.student_id = student.value ->> 'id'
    where student.value ? 'studentNumber'
      and (number_reservation.student_id is distinct from student.value ->> 'id'
        or student_reservation.student_number is distinct from student.value ->> 'studentNumber')
  ) then
    raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
  end if;
  return new;
end;
$function$;
$replacement$;

  select pg_catalog.pg_get_functiondef(
    'internal.assign_new_student_numbers()'::regprocedure
  ) into definition;
  if position('reservation_maps_set_based_v1' in definition) = 0
     or position('for reservation_item in' in definition) <> 0
     or position('insert into internal.student_number_reservations(student_number, student_id)' in definition) = 0
     or position('on conflict do nothing' in definition) = 0
     or position('number_reservation.student_id is distinct from' in definition) = 0 then
    raise exception using errcode = 'P0001',
      message = 'assign_new_student_numbers_patch_verification_failed';
  end if;
end;
$manual_student_number_trigger_set_based$;

revoke all on function internal.assign_new_student_numbers()
  from public, anon, authenticated, service_role;

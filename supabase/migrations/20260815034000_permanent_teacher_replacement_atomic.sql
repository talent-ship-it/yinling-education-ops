-- A permanent teacher handover changes four authoritative projections.  The
-- browser submits only an operation id, replacement teacher id and OCC
-- versions; the server derives the proposed payloads, and this contract
-- independently derives the complete occurrence/capacity closure again from
-- the locked database rows before accepting those payloads.

create table if not exists internal.permanent_teacher_replacement_commands (
  command_key text primary key
    check (command_key ~ '^permanent-teacher-replacement:[a-f0-9]{64}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  operation_id text not null check (length(operation_id) between 1 and 120),
  student_id text not null check (length(student_id) between 1 and 120),
  source_teacher_id text not null check (length(source_teacher_id) between 1 and 120),
  replacement_teacher_id text not null check (length(replacement_teacher_id) between 1 and 120),
  effective_date date not null,
  affected_occurrence_ids jsonb not null check (jsonb_typeof(affected_occurrence_ids) = 'array'),
  changed_teacher_ids jsonb not null check (jsonb_typeof(changed_teacher_ids) = 'array'),
  booking_version bigint not null check (booking_version > 0),
  operation_version bigint not null check (operation_version > 0),
  student_version bigint not null check (student_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.permanent_teacher_replacement_commands enable row level security;
revoke all on table internal.permanent_teacher_replacement_commands from public, anon, authenticated;
revoke all on table internal.permanent_teacher_replacement_commands from service_role;

-- Project the exact finite set of confirmed lessons belonging to one
-- teacher/student relationship on or after the effective date.  An unbounded
-- matching series is represented only when p_reject_unbounded is false; the
-- source-teacher projection always rejects it so a permanent handover can
-- never silently truncate future lessons.
create or replace function internal.permanent_teacher_replacement_occurrence_projection(
  p_bookings jsonb,
  p_student_id text,
  p_teacher_id text,
  p_effective_date text,
  p_reject_unbounded boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  booking_record record;
  booking jsonb;
  override_item jsonb;
  occurrence_override jsonb;
  source_date date;
  target_date_text text;
  target_date date;
  occurrence_id text;
  resolved_teacher_id text;
  resolved_student_id text;
  occurrence_status text;
  repeat_count integer;
  occurrence_index integer;
  can_contain boolean;
  unbounded boolean := false;
  occurrence_ids jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array'
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_teacher_id), '') is null
     or coalesce(p_effective_date, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or p_reject_unbounded is null then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_projection';
  end if;
  begin
    if pg_catalog.to_char(p_effective_date::date, 'YYYY-MM-DD') <> p_effective_date then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_effective_date';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_effective_date';
  end;

  for booking_record in
    select item.value as value, item.ordinality as ordinality
    from jsonb_array_elements(p_bookings) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    booking := booking_record.value;
    if jsonb_typeof(booking) <> 'object' then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_booking';
    end if;
    if booking ->> 'kind' = '代课' then continue; end if;

    can_contain := coalesce((jsonb_typeof(booking -> 'teacherId') = 'string'
      and booking ->> 'teacherId' = p_teacher_id
      and jsonb_typeof(booking -> 'studentId') = 'string'
      and booking ->> 'studentId' = p_student_id), false);
    if not can_contain then
      if booking ? 'occurrenceOverrides'
         and jsonb_typeof(booking -> 'occurrenceOverrides') not in ('array', 'null') then
        raise exception using errcode = '22023', message = 'invalid_permanent_replacement_overrides';
      end if;
      if jsonb_typeof(booking -> 'occurrenceOverrides') = 'array' then
        for override_item in
          select value from jsonb_array_elements(booking -> 'occurrenceOverrides')
        loop
          if jsonb_typeof(override_item) <> 'object' then
            raise exception using errcode = '22023', message = 'invalid_permanent_replacement_override';
          end if;
          resolved_teacher_id := case when override_item ? 'teacherId'
            then case when jsonb_typeof(override_item -> 'teacherId') = 'string'
              then override_item ->> 'teacherId' else null end
            else case when jsonb_typeof(booking -> 'teacherId') = 'string'
              then booking ->> 'teacherId' else null end end;
          resolved_student_id := case when override_item ? 'studentId'
            then case when jsonb_typeof(override_item -> 'studentId') = 'string'
              then override_item ->> 'studentId' else null end
            else case when jsonb_typeof(booking -> 'studentId') = 'string'
              then booking ->> 'studentId' else null end end;
          if resolved_teacher_id = p_teacher_id
             and resolved_student_id = p_student_id then
            can_contain := true;
            exit;
          end if;
        end loop;
      end if;
    end if;
    if not can_contain then continue; end if;

    if coalesce(booking ->> 'id', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
       or coalesce(booking ->> 'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or coalesce(booking ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or jsonb_typeof(booking -> 'duration') is distinct from 'number'
       or (booking ->> 'duration')::numeric <= 0 then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_booking';
    end if;
    begin
      source_date := (booking ->> 'date')::date;
      if pg_catalog.to_char(source_date, 'YYYY-MM-DD') <> booking ->> 'date' then
        raise exception using errcode = '22023', message = 'invalid_permanent_replacement_booking_date';
      end if;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_booking_date';
    end;

    if booking ? 'occurrenceOverrides'
       and jsonb_typeof(booking -> 'occurrenceOverrides') not in ('array', 'null') then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_overrides';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
        then booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
         or nullif(trim(item.value ->> 'occurrenceId'), '') is null
    ) or exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
        then booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
      group by item.value ->> 'occurrenceId'
      having count(*) > 1
    ) or exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
        then booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
      where (item.value ? 'teacherId'
          and jsonb_typeof(item.value -> 'teacherId') not in ('string', 'null'))
         or (item.value ? 'studentId'
          and jsonb_typeof(item.value -> 'studentId') not in ('string', 'null'))
    ) then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_override';
    end if;

    if booking -> 'recurring' = 'true'::jsonb then
      if not (booking ? 'repeatCount') then
        if p_reject_unbounded then
          raise exception using errcode = '22023', message = 'unbounded_permanent_replacement_series';
        end if;
        unbounded := true;
        continue;
      end if;
      if jsonb_typeof(booking -> 'repeatCount') is distinct from 'number'
         or (booking ->> 'repeatCount')::numeric <> trunc((booking ->> 'repeatCount')::numeric)
         or (booking ->> 'repeatCount')::numeric not between 1 and 104 then
        raise exception using errcode = '22023', message = 'invalid_permanent_replacement_repeat_count';
      end if;
      repeat_count := (booking ->> 'repeatCount')::integer;
    else
      repeat_count := 1;
    end if;

    for occurrence_index in 0..repeat_count - 1
    loop
      source_date := (booking ->> 'date')::date + occurrence_index * 7;
      occurrence_id := booking ->> 'id' || ':' || pg_catalog.to_char(source_date, 'YYYY-MM-DD');
      select item.value into occurrence_override
      from jsonb_array_elements(case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
        then booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
      where item.value ->> 'occurrenceId' = occurrence_id
      limit 1;

      target_date_text := coalesce(occurrence_override ->> 'date', pg_catalog.to_char(source_date, 'YYYY-MM-DD'));
      if target_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or coalesce(occurrence_override ->> 'start', booking ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (
           occurrence_override ? 'durationMinutes'
           and occurrence_override -> 'durationMinutes' <> 'null'::jsonb
           and (
             jsonb_typeof(occurrence_override -> 'durationMinutes') is distinct from 'number'
             or (occurrence_override ->> 'durationMinutes')::numeric <= 0
           )
         ) then
        raise exception using errcode = '22023', message = 'invalid_permanent_replacement_occurrence';
      end if;
      begin
        target_date := target_date_text::date;
        if pg_catalog.to_char(target_date, 'YYYY-MM-DD') <> target_date_text then
          raise exception using errcode = '22023', message = 'invalid_permanent_replacement_occurrence_date';
        end if;
      exception when others then
        raise exception using errcode = '22023', message = 'invalid_permanent_replacement_occurrence_date';
      end;

      resolved_teacher_id := case when occurrence_override ? 'teacherId'
        then case when jsonb_typeof(occurrence_override -> 'teacherId') = 'string'
          then nullif(trim(occurrence_override ->> 'teacherId'), '') else null end
        else case when jsonb_typeof(booking -> 'teacherId') = 'string'
          then nullif(trim(booking ->> 'teacherId'), '') else null end end;
      resolved_student_id := case when occurrence_override ? 'studentId'
        then case when jsonb_typeof(occurrence_override -> 'studentId') = 'string'
          then nullif(trim(occurrence_override ->> 'studentId'), '') else null end
        else case when jsonb_typeof(booking -> 'studentId') = 'string'
          then nullif(trim(booking ->> 'studentId'), '') else null end end;
      occurrence_status := coalesce(occurrence_override ->> 'status', 'confirmed');
      if target_date >= p_effective_date::date
         and occurrence_status = 'confirmed'
         and resolved_teacher_id = trim(p_teacher_id)
         and resolved_student_id = trim(p_student_id) then
        occurrence_ids := occurrence_ids || jsonb_build_array(occurrence_id);
      end if;
      occurrence_override := null;
    end loop;
  end loop;

  select coalesce(jsonb_agg(value order by value #>> '{}' collate "C"), '[]'::jsonb)
  into occurrence_ids
  from jsonb_array_elements(occurrence_ids) item(value);
  return jsonb_build_object('occurrenceIds', occurrence_ids, 'unbounded', unbounded);
end;
$$;

revoke all on function internal.permanent_teacher_replacement_occurrence_projection(jsonb, text, text, text, boolean)
  from public, anon, authenticated, service_role;

create or replace function internal.permanent_teacher_replacement_upsert_override(
  p_overrides jsonb,
  p_occurrence_id text,
  p_patch jsonb
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(value order by value ->> 'occurrenceId' collate "C"), '[]'::jsonb)
  from (
    select case when item.value ->> 'occurrenceId' = p_occurrence_id
      then item.value || p_patch || jsonb_build_object('occurrenceId', p_occurrence_id)
      else item.value end as value
    from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) item(value)
    union all
    select jsonb_build_object('occurrenceId', p_occurrence_id) || p_patch
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) item(value)
      where item.value ->> 'occurrenceId' = p_occurrence_id
    )
  ) merged;
$$;

revoke all on function internal.permanent_teacher_replacement_upsert_override(jsonb, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.permanent_teacher_replacement_expected_bookings(
  p_bookings jsonb,
  p_student_id text,
  p_source_teacher_id text,
  p_replacement_teacher_id text,
  p_affected_occurrence_ids jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  booking_record record;
  booking jsonb;
  next_booking jsonb;
  overrides jsonb;
  occurrence_override jsonb;
  occurrence_id text;
  source_date date;
  resolved_teacher_id text;
  repeat_count integer;
  occurrence_index integer;
  changes_default boolean;
  result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array'
     or jsonb_typeof(p_affected_occurrence_ids) is distinct from 'array'
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_source_teacher_id), '') is null
     or nullif(trim(p_replacement_teacher_id), '') is null
     or trim(p_source_teacher_id) = trim(p_replacement_teacher_id) then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_booking_projection';
  end if;

  for booking_record in
    select item.value as value, item.ordinality as ordinality
    from jsonb_array_elements(p_bookings) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    booking := booking_record.value;
    next_booking := booking;
    overrides := case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
      then booking -> 'occurrenceOverrides' else '[]'::jsonb end;
    for occurrence_id in
      select value from jsonb_array_elements_text(p_affected_occurrence_ids)
      where pg_catalog.left(value, length(value) - 11) = booking ->> 'id'
      order by value collate "C"
    loop
      overrides := internal.permanent_teacher_replacement_upsert_override(
        overrides,
        occurrence_id,
        jsonb_build_object('status', 'confirmed', 'teacherId', trim(p_replacement_teacher_id))
      );
    end loop;

    changes_default := nullif(trim(booking ->> 'studentId'), '') = trim(p_student_id)
      and nullif(trim(booking ->> 'teacherId'), '') = trim(p_source_teacher_id)
      and exists (
        select 1 from jsonb_array_elements_text(p_affected_occurrence_ids) item(value)
        where pg_catalog.left(item.value, length(item.value) - 11) = booking ->> 'id'
      );
    if changes_default then
      next_booking := jsonb_set(next_booking, '{teacherId}', to_jsonb(trim(p_replacement_teacher_id)), true);
      repeat_count := case when booking -> 'recurring' = 'true'::jsonb
        then (booking ->> 'repeatCount')::integer else 1 end;
      for occurrence_index in 0..repeat_count - 1
      loop
        source_date := (booking ->> 'date')::date + occurrence_index * 7;
        occurrence_id := booking ->> 'id' || ':' || pg_catalog.to_char(source_date, 'YYYY-MM-DD');
        select item.value into occurrence_override
        from jsonb_array_elements(case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
          then booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
        where item.value ->> 'occurrenceId' = occurrence_id
        limit 1;
        resolved_teacher_id := case when occurrence_override ? 'teacherId'
          then case when jsonb_typeof(occurrence_override -> 'teacherId') = 'string'
            then nullif(trim(occurrence_override ->> 'teacherId'), '') else null end
          else case when jsonb_typeof(booking -> 'teacherId') = 'string'
            then nullif(trim(booking ->> 'teacherId'), '') else null end end;
        if resolved_teacher_id = trim(p_source_teacher_id)
           and not p_affected_occurrence_ids @> jsonb_build_array(occurrence_id) then
          overrides := internal.permanent_teacher_replacement_upsert_override(
            overrides,
            occurrence_id,
            jsonb_build_object('teacherId', trim(p_source_teacher_id))
          );
        end if;
        occurrence_override := null;
      end loop;
    end if;

    if exists (
      select 1 from jsonb_array_elements_text(p_affected_occurrence_ids) item(value)
      where pg_catalog.left(item.value, length(item.value) - 11) = booking ->> 'id'
    ) then
      next_booking := jsonb_set(next_booking, '{occurrenceOverrides}', overrides, true);
    end if;
    result := result || jsonb_build_array(next_booking);
  end loop;
  return result;
end;
$$;

revoke all on function internal.permanent_teacher_replacement_expected_bookings(jsonb, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.permanent_teacher_replacement_expected_teachers(
  p_bookings jsonb,
  p_teachers jsonb,
  p_student_id text,
  p_source_teacher_id text,
  p_replacement_teacher_id text,
  p_effective_date text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  source_teacher jsonb;
  replacement_teacher jsonb;
  next_source jsonb;
  next_replacement jsonb;
  source_assignments jsonb;
  replacement_assignments jsonb;
  replacement_projection jsonb;
  replacement_already_active boolean;
  source_assigned boolean;
  replacement_assigned boolean;
  source_capacity numeric;
  replacement_capacity numeric;
  source_capacity_valid boolean;
  replacement_capacity_valid boolean;
  changed_ids jsonb := '[]'::jsonb;
  next_teachers jsonb;
begin
  if jsonb_typeof(p_teachers) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_teachers';
  end if;
  select item.value into source_teacher from jsonb_array_elements(p_teachers) item(value)
  where item.value ->> 'id' = p_source_teacher_id limit 1;
  select item.value into replacement_teacher from jsonb_array_elements(p_teachers) item(value)
  where item.value ->> 'id' = p_replacement_teacher_id limit 1;
  if source_teacher is null or replacement_teacher is null
     or p_source_teacher_id = p_replacement_teacher_id then
    raise exception using errcode = '22023', message = 'permanent_replacement_teacher_not_found';
  end if;

  if source_teacher ? 'capacityAssignments'
     and jsonb_typeof(source_teacher -> 'capacityAssignments') <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_capacity_assignments';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(source_teacher -> 'capacityAssignments', '[]'::jsonb)) item(value)
    where jsonb_typeof(item.value) <> 'string' or nullif(trim(item.value #>> '{}'), '') is null
  ) then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_capacity_assignments';
  end if;
  select coalesce(jsonb_agg(to_jsonb(id) order by id collate "C"), '[]'::jsonb)
  into source_assignments
  from (
    select distinct trim(item.value #>> '{}') as id
    from jsonb_array_elements(coalesce(source_teacher -> 'capacityAssignments', '[]'::jsonb)) item(value)
  ) valueset;
  source_assigned := source_assignments @> jsonb_build_array(trim(p_student_id));
  source_capacity_valid := jsonb_typeof(source_teacher -> 'newStudentCapacity') = 'number'
    and (source_teacher ->> 'newStudentCapacity')::numeric = trunc((source_teacher ->> 'newStudentCapacity')::numeric)
    and (source_teacher ->> 'newStudentCapacity')::numeric between 0 and 9007199254740991;
  if source_teacher ? 'newStudentCapacity' and not source_capacity_valid then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_capacity';
  end if;
  next_source := source_teacher;
  if source_assigned then
    select coalesce(jsonb_agg(value order by value #>> '{}' collate "C"), '[]'::jsonb)
    into source_assignments
    from jsonb_array_elements(source_assignments) item(value)
    where item.value #>> '{}' <> trim(p_student_id);
    next_source := jsonb_set(next_source, '{capacityAssignments}', source_assignments, true);
    if source_capacity_valid then
      source_capacity := (source_teacher ->> 'newStudentCapacity')::numeric + 1;
      next_source := jsonb_set(next_source, '{newStudentCapacity}', to_jsonb(source_capacity), true);
    end if;
    changed_ids := changed_ids || jsonb_build_array(trim(p_source_teacher_id));
  end if;

  replacement_projection := internal.permanent_teacher_replacement_occurrence_projection(
    p_bookings, p_student_id, p_replacement_teacher_id, p_effective_date, false
  );
  replacement_already_active := coalesce((replacement_projection ->> 'unbounded')::boolean, false)
    or jsonb_array_length(replacement_projection -> 'occurrenceIds') > 0;
  next_replacement := replacement_teacher;
  if not replacement_already_active then
    if replacement_teacher ? 'capacityAssignments'
       and jsonb_typeof(replacement_teacher -> 'capacityAssignments') <> 'array' then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_capacity_assignments';
    end if;
    if exists (
      select 1 from jsonb_array_elements(coalesce(replacement_teacher -> 'capacityAssignments', '[]'::jsonb)) item(value)
      where jsonb_typeof(item.value) <> 'string' or nullif(trim(item.value #>> '{}'), '') is null
    ) then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_capacity_assignments';
    end if;
    select coalesce(jsonb_agg(to_jsonb(id) order by id collate "C"), '[]'::jsonb)
    into replacement_assignments
    from (
      select distinct trim(item.value #>> '{}') as id
      from jsonb_array_elements(coalesce(replacement_teacher -> 'capacityAssignments', '[]'::jsonb)) item(value)
    ) valueset;
    replacement_assigned := replacement_assignments @> jsonb_build_array(trim(p_student_id));
    replacement_capacity_valid := jsonb_typeof(replacement_teacher -> 'newStudentCapacity') = 'number'
      and (replacement_teacher ->> 'newStudentCapacity')::numeric = trunc((replacement_teacher ->> 'newStudentCapacity')::numeric)
      and (replacement_teacher ->> 'newStudentCapacity')::numeric between 0 and 9007199254740991;
    if replacement_teacher ? 'newStudentCapacity' and not replacement_capacity_valid then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_capacity';
    end if;
    if not replacement_assigned then
      if not replacement_capacity_valid then
        raise exception using errcode = '22023', message = 'permanent_replacement_capacity_unconfigured';
      end if;
      replacement_capacity := (replacement_teacher ->> 'newStudentCapacity')::numeric;
      if replacement_capacity <= 0 then
        raise exception using errcode = '22023', message = 'permanent_replacement_capacity_exhausted';
      end if;
      replacement_assignments := replacement_assignments || jsonb_build_array(trim(p_student_id));
      select coalesce(jsonb_agg(value order by value #>> '{}' collate "C"), '[]'::jsonb)
      into replacement_assignments from jsonb_array_elements(replacement_assignments) item(value);
      next_replacement := jsonb_set(next_replacement, '{capacityAssignments}', replacement_assignments, true);
      next_replacement := jsonb_set(
        next_replacement, '{newStudentCapacity}', to_jsonb(replacement_capacity - 1), true
      );
      changed_ids := changed_ids || jsonb_build_array(trim(p_replacement_teacher_id));
    end if;
  end if;

  select jsonb_agg(
    case item.value ->> 'id'
      when p_source_teacher_id then next_source
      when p_replacement_teacher_id then next_replacement
      else item.value
    end
    order by item.ordinality
  ) into next_teachers
  from jsonb_array_elements(p_teachers) with ordinality as item(value, ordinality);
  select coalesce(jsonb_agg(value order by value #>> '{}' collate "C"), '[]'::jsonb)
  into changed_ids from jsonb_array_elements(changed_ids) item(value);
  return jsonb_build_object('teachers', next_teachers, 'changedTeacherIds', changed_ids);
end;
$$;

revoke all on function internal.permanent_teacher_replacement_expected_teachers(jsonb, jsonb, text, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_permanent_teacher_replacement_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  operation_id text,
  affected_occurrence_ids jsonb,
  changed_teacher_ids jsonb,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.permanent_teacher_replacement_commands%rowtype;
  expected_key text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent - 'operationId' - 'chosenTeacherId' <> '{}'::jsonb
     or coalesce(p_command_intent ->> 'operationId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_command_intent ->> 'chosenTeacherId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or nullif(trim(p_actor), '') is null
     or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_replay_lookup';
  end if;
  expected_key := 'permanent-teacher-replacement:' || encode(extensions.digest(
    '{"operationId":"' || (p_command_intent ->> 'operationId')
      || '","chosenTeacherId":"' || (p_command_intent ->> 'chosenTeacherId') || '"}',
    'sha256'
  ), 'hex');
  if p_command_key is distinct from expected_key then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_command_key';
  end if;

  select * into prior from internal.permanent_teacher_replacement_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> trim(p_actor)
     or prior.operation_id <> p_command_intent ->> 'operationId'
     or prior.replacement_teacher_id <> p_command_intent ->> 'chosenTeacherId' then
    raise exception using errcode = '23505', message = 'permanent_replacement_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.operation_id,
    prior.affected_occurrence_ids, prior.changed_teacher_ids, prior.audit_id;
end;
$$;

revoke all on function public.get_permanent_teacher_replacement_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_permanent_teacher_replacement_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.confirm_permanent_teacher_replacement_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_operation_id text,
  p_student_id text,
  p_source_teacher_id text,
  p_replacement_teacher_id text,
  p_effective_date text,
  p_expected_versions jsonb,
  p_bookings jsonb,
  p_operations jsonb,
  p_teachers jsonb,
  p_students jsonb,
  p_affected_occurrence_ids jsonb,
  p_changed_teacher_ids jsonb,
  p_actor text
)
returns table (
  command_key text,
  operation_id text,
  applied boolean,
  affected_occurrence_ids jsonb,
  changed_teacher_ids jsonb,
  bookings_row public.ops_state,
  operations_row public.ops_state,
  teachers_row public.ops_state,
  students_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_state public.ops_state%rowtype;
  operation_state public.ops_state%rowtype;
  student_state public.ops_state%rowtype;
  teacher_state public.ops_state%rowtype;
  saved_booking_state public.ops_state%rowtype;
  saved_operation_state public.ops_state%rowtype;
  saved_student_state public.ops_state%rowtype;
  saved_teacher_state public.ops_state%rowtype;
  prior internal.permanent_teacher_replacement_commands%rowtype;
  expected_booking_version bigint;
  expected_operation_version bigint;
  expected_student_version bigint;
  expected_teacher_version bigint;
  expected_key text;
  expected_projection jsonb;
  replacement_relationship_projection jsonb;
  replacement_already_active boolean;
  replacement_already_assigned boolean;
  expected_bookings jsonb;
  expected_teacher_projection jsonb;
  expected_teachers jsonb;
  expected_changed_teacher_ids jsonb;
  expected_students jsonb;
  current_operation jsonb;
  next_operation jsonb;
  current_student jsonb;
  current_source_teacher jsonb;
  current_replacement_teacher jsonb;
  replacement_teacher_name text;
  confirmed_at_text text;
  confirmed_at_value timestamptz;
  payload_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent - 'operationId' - 'chosenTeacherId' <> '{}'::jsonb
     or p_command_intent ->> 'operationId' is distinct from p_operation_id
     or p_command_intent ->> 'chosenTeacherId' is distinct from p_replacement_teacher_id
     or coalesce(p_operation_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_student_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_source_teacher_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_replacement_teacher_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or p_source_teacher_id = p_replacement_teacher_id
     or coalesce(p_effective_date, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'operations' - 'students' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'operations') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') is distinct from 'number'
     or jsonb_typeof(p_bookings) is distinct from 'array'
     or jsonb_typeof(p_operations) is distinct from 'array'
     or jsonb_typeof(p_teachers) is distinct from 'array'
     or jsonb_typeof(p_students) is distinct from 'array'
     or jsonb_typeof(p_affected_occurrence_ids) is distinct from 'array'
     or jsonb_typeof(p_changed_teacher_ids) is distinct from 'array'
     or nullif(trim(p_actor), '') is null
     or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_command';
  end if;
  expected_key := 'permanent-teacher-replacement:' || encode(extensions.digest(
    '{"operationId":"' || p_operation_id || '","chosenTeacherId":"'
      || p_replacement_teacher_id || '"}', 'sha256'
  ), 'hex');
  if p_command_key is distinct from expected_key then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_command_key';
  end if;
  begin
    expected_booking_version := (p_expected_versions ->> 'bookings')::bigint;
    expected_operation_version := (p_expected_versions ->> 'operations')::bigint;
    expected_student_version := (p_expected_versions ->> 'students')::bigint;
    expected_teacher_version := (p_expected_versions ->> 'teachers')::bigint;
    if pg_catalog.to_char(p_effective_date::date, 'YYYY-MM-DD') <> p_effective_date then
      raise exception using errcode = '22023', message = 'invalid_permanent_replacement_versions';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_versions';
  end;
  if expected_booking_version < 1 or expected_operation_version < 1
     or expected_student_version < 1 or expected_teacher_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_versions';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_affected_occurrence_ids) item(value)
    where jsonb_typeof(item.value) <> 'string'
       or (item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ) or (select count(*) from jsonb_array_elements(p_affected_occurrence_ids))
       <> (select count(distinct value) from jsonb_array_elements_text(p_affected_occurrence_ids) item(value))
     or jsonb_array_length(p_affected_occurrence_ids) = 0
     or exists (
       select 1 from jsonb_array_elements(p_changed_teacher_ids) item(value)
       where jsonb_typeof(item.value) <> 'string'
          or (item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     ) or (select count(*) from jsonb_array_elements(p_changed_teacher_ids))
       <> (select count(distinct value) from jsonb_array_elements_text(p_changed_teacher_ids) item(value)) then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_change_ids';
  end if;

  payload_hash := encode(extensions.digest(jsonb_build_object(
    'commandIntent', p_command_intent,
    'operationId', p_operation_id,
    'studentId', p_student_id,
    'sourceTeacherId', p_source_teacher_id,
    'replacementTeacherId', p_replacement_teacher_id,
    'effectiveDate', p_effective_date,
    'expectedVersions', p_expected_versions,
    'bookings', p_bookings,
    'operations', p_operations,
    'teachers', p_teachers,
    'students', p_students,
    'affectedOccurrenceIds', p_affected_occurrence_ids,
    'changedTeacherIds', p_changed_teacher_ids
  )::text, 'sha256'), 'hex');

  -- Global lock order for every four-projection permanent handover:
  -- bookings -> operations -> students -> teachers.
  select * into booking_state from public.ops_state s where s.entity = 'bookings' for update;
  select * into operation_state from public.ops_state s where s.entity = 'operations' for update;
  select * into student_state from public.ops_state s where s.entity = 'students' for update;
  select * into teacher_state from public.ops_state s where s.entity = 'teachers' for update;
  if booking_state.entity is null or operation_state.entity is null
     or student_state.entity is null or teacher_state.entity is null
     or jsonb_typeof(booking_state.payload) is distinct from 'array'
     or jsonb_typeof(operation_state.payload) is distinct from 'array'
     or jsonb_typeof(student_state.payload) is distinct from 'array'
     or jsonb_typeof(teacher_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'permanent_replacement_state_missing';
  end if;

  -- Observe a concurrent identical commit only after the authoritative rows
  -- are locked.  Replay is bound to intent + actor and returns the immutable
  -- first result; it deliberately does not revalidate the caller timestamp.
  select * into prior from internal.permanent_teacher_replacement_commands c
  where c.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> trim(p_actor)
       or prior.operation_id <> p_operation_id
       or prior.student_id <> p_student_id
       or prior.source_teacher_id <> p_source_teacher_id
       or prior.replacement_teacher_id <> p_replacement_teacher_id
       or pg_catalog.to_char(prior.effective_date, 'YYYY-MM-DD') <> p_effective_date
       or prior.affected_occurrence_ids is distinct from p_affected_occurrence_ids
       or prior.changed_teacher_ids is distinct from p_changed_teacher_ids then
      raise exception using errcode = '23505', message = 'permanent_replacement_idempotency_conflict';
    end if;
    return query select prior.command_key, prior.operation_id, false,
      prior.affected_occurrence_ids, prior.changed_teacher_ids,
      booking_state, operation_state, teacher_state, student_state, prior.audit_id;
    return;
  end if;

  current_operation := (
    select item.value from jsonb_array_elements(operation_state.payload) item(value)
    where item.value ->> 'id' = p_operation_id limit 1
  );
  if current_operation is null then
    raise exception using errcode = '22023', message = 'permanent_replacement_operation_not_found';
  end if;
  if nullif(trim(current_operation ->> 'status'), '') = '已确认' then
    raise exception using errcode = '40001', message = 'permanent_replacement_confirmed_without_ledger';
  end if;
  if booking_state.version is distinct from expected_booking_version
     or operation_state.version is distinct from expected_operation_version
     or student_state.version is distinct from expected_student_version
     or teacher_state.version is distinct from expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  if exists (
    select 1 from jsonb_array_elements(booking_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(operation_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(student_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(teacher_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'duplicate_permanent_replacement_identity';
  end if;
  if nullif(trim(current_operation ->> 'type'), '') is distinct from '老师离职'
     or nullif(trim(current_operation ->> 'status'), '') is distinct from '待处理'
     or nullif(trim(current_operation ->> 'studentId'), '') is distinct from p_student_id
     or nullif(trim(current_operation ->> 'teacherId'), '') is distinct from p_source_teacher_id
     or nullif(trim(current_operation ->> 'eventEnd'), '') is distinct from p_effective_date
     or (
       nullif(trim(current_operation ->> 'chosenTeacherId'), '') is not null
       and nullif(trim(current_operation ->> 'chosenTeacherId'), '') <> p_replacement_teacher_id
     )
     or jsonb_typeof(current_operation -> 'recommendedTeacherIds') is distinct from 'array'
     or not (current_operation -> 'recommendedTeacherIds') @> jsonb_build_array(p_replacement_teacher_id)
     or coalesce(current_operation ->> 'creationCommandKey', '')
       !~ '^teacher-departure-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     or p_operation_id is distinct from 'OPS-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
       (current_operation ->> 'creationCommandKey') || chr(31) || p_student_id, 'sha256'
     ), 'hex'), 24)
     or not exists (
       select 1
       from internal.teacher_departure_creation_commands creation
       cross join lateral jsonb_array_elements(creation.affected_groups) creation_group(value)
       where creation.command_key = current_operation ->> 'creationCommandKey'
         and creation.source_teacher_id = p_source_teacher_id
         and pg_catalog.to_char(creation.effective_date, 'YYYY-MM-DD') = p_effective_date
         and creation_group.value ->> 'operationId' = p_operation_id
         and creation_group.value ->> 'studentId' = p_student_id
         and creation_group.value -> 'affectedOccurrenceIds'
           is not distinct from current_operation -> 'affectedOccurrenceIds'
     ) then
    raise exception using errcode = '22023', message = 'permanent_replacement_operation_mismatch';
  end if;
  current_student := (
    select item.value from jsonb_array_elements(student_state.payload) item(value)
    where item.value ->> 'id' = p_student_id limit 1
  );
  current_source_teacher := (
    select item.value from jsonb_array_elements(teacher_state.payload) item(value)
    where item.value ->> 'id' = p_source_teacher_id limit 1
  );
  current_replacement_teacher := (
    select item.value from jsonb_array_elements(teacher_state.payload) item(value)
    where item.value ->> 'id' = p_replacement_teacher_id limit 1
  );
  if current_student is null or current_source_teacher is null or current_replacement_teacher is null then
    raise exception using errcode = '22023', message = 'permanent_replacement_subject_not_found';
  end if;
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_operation_read_only';
  end if;
  replacement_relationship_projection := internal.permanent_teacher_replacement_occurrence_projection(
    booking_state.payload, p_student_id, p_replacement_teacher_id, p_effective_date, false
  );
  replacement_already_active := coalesce(
    (replacement_relationship_projection ->> 'unbounded')::boolean, false
  ) or jsonb_array_length(replacement_relationship_projection -> 'occurrenceIds') > 0;
  replacement_already_assigned := coalesce(
    current_replacement_teacher -> 'capacityAssignments' @> jsonb_build_array(p_student_id), false
  );
  replacement_teacher_name := nullif(trim(current_replacement_teacher ->> 'name'), '');
  if replacement_teacher_name is null
     or nullif(trim(current_source_teacher ->> 'name'), '') is null
     or (
       not replacement_already_active
       and not replacement_already_assigned
       and current_replacement_teacher -> 'acceptsStudents' is distinct from 'true'::jsonb
     )
     or (
       nullif(trim(current_student ->> 'teacher'), '') is not null
       and nullif(trim(current_student ->> 'teacher'), '') not in (
         nullif(trim(current_source_teacher ->> 'name'), ''), '待匹配', '待确认'
       )
     ) then
    raise exception using errcode = '22023', message = 'permanent_replacement_assignment_mismatch';
  end if;

  expected_projection := internal.permanent_teacher_replacement_occurrence_projection(
    booking_state.payload, p_student_id, p_source_teacher_id, p_effective_date, true
  );
  if (expected_projection ->> 'unbounded')::boolean
     or jsonb_array_length(expected_projection -> 'occurrenceIds') = 0
     or expected_projection -> 'occurrenceIds' is distinct from p_affected_occurrence_ids then
    raise exception using errcode = '22023', message = 'permanent_replacement_occurrence_closure_mismatch';
  end if;
  if jsonb_typeof(current_replacement_teacher -> 'subjects') is distinct from 'array'
     or exists (
       select 1
       from jsonb_array_elements_text(p_affected_occurrence_ids) affected(value)
       join jsonb_array_elements(booking_state.payload) booking(value)
         on pg_catalog.left(affected.value, length(affected.value) - 11)
           = booking.value ->> 'id'
       where nullif(trim(booking.value ->> 'teacherSubjectId'), '') is null
          or not (current_replacement_teacher -> 'subjects')
            @> jsonb_build_array(booking.value ->> 'teacherSubjectId')
     ) then
    raise exception using errcode = '22023', message = 'permanent_replacement_subject_mismatch';
  end if;

  expected_bookings := internal.permanent_teacher_replacement_expected_bookings(
    booking_state.payload, p_student_id, p_source_teacher_id,
    p_replacement_teacher_id, p_affected_occurrence_ids
  );
  if expected_bookings is not distinct from booking_state.payload
     or p_bookings is distinct from expected_bookings then
    raise exception using errcode = '22023', message = 'permanent_replacement_booking_payload_mismatch';
  end if;

  expected_teacher_projection := internal.permanent_teacher_replacement_expected_teachers(
    booking_state.payload, teacher_state.payload, p_student_id,
    p_source_teacher_id, p_replacement_teacher_id, p_effective_date
  );
  expected_teachers := expected_teacher_projection -> 'teachers';
  expected_changed_teacher_ids := expected_teacher_projection -> 'changedTeacherIds';
  if p_changed_teacher_ids is distinct from expected_changed_teacher_ids
     or p_teachers is distinct from expected_teachers then
    raise exception using errcode = '22023', message = 'permanent_replacement_teacher_payload_mismatch';
  end if;

  select jsonb_agg(
    case when item.value ->> 'id' = p_student_id
      then jsonb_set(item.value, '{teacher}', to_jsonb(replacement_teacher_name), true)
      else item.value end
    order by item.ordinality
  ) into expected_students
  from jsonb_array_elements(student_state.payload) with ordinality as item(value, ordinality);
  if p_students is distinct from expected_students then
    raise exception using errcode = '22023', message = 'permanent_replacement_student_payload_mismatch';
  end if;

  next_operation := (
    select item.value from jsonb_array_elements(p_operations) item(value)
    where item.value ->> 'id' = p_operation_id limit 1
  );
  if next_operation is null
     or next_operation ->> 'status' is distinct from '已确认'
     or next_operation ->> 'chosenTeacherId' is distinct from p_replacement_teacher_id
     or next_operation -> 'affectedOccurrenceIds' is distinct from p_affected_occurrence_ids
     or next_operation -> 'changedTeacherIds' is distinct from p_changed_teacher_ids
     or next_operation ->> 'confirmationAction' is distinct from 'permanent_replacement'
     or next_operation ->> 'confirmationCommandKey' is distinct from p_command_key
     or next_operation ->> 'confirmedBy' is distinct from trim(p_actor)
     or (current_operation - 'status' - 'chosenTeacherId' - 'affectedOccurrenceIds'
       - 'changedTeacherIds' - 'confirmationAction' - 'confirmationCommandKey'
       - 'confirmedAt' - 'confirmedBy') is distinct from
       (next_operation - 'status' - 'chosenTeacherId' - 'affectedOccurrenceIds'
       - 'changedTeacherIds' - 'confirmationAction' - 'confirmationCommandKey'
       - 'confirmedAt' - 'confirmedBy') then
    raise exception using errcode = '22023', message = 'permanent_replacement_operation_payload_mismatch';
  end if;
  confirmed_at_text := next_operation ->> 'confirmedAt';
  if coalesce(confirmed_at_text, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_confirmed_at';
  end if;
  begin
    confirmed_at_value := confirmed_at_text::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_confirmed_at';
  end;
  if confirmed_at_value < clock_timestamp() - interval '15 minutes'
     or confirmed_at_value > clock_timestamp() + interval '2 minutes' then
    raise exception using errcode = '22023', message = 'invalid_permanent_replacement_confirmed_at';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(operation_state.payload) old_item(value)
    full join jsonb_array_elements(p_operations) new_item(value)
      on old_item.value ->> 'id' = new_item.value ->> 'id'
    where coalesce(old_item.value ->> 'id', new_item.value ->> 'id') <> p_operation_id
      and old_item.value is distinct from new_item.value
  ) or exists (
    select 1 from jsonb_array_elements(p_operations) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(operation_state.payload) with ordinality old_item(value, ordinality)
    full join jsonb_array_elements(p_operations) with ordinality new_item(value, ordinality)
      on old_item.ordinality = new_item.ordinality
    where old_item.value ->> 'id' is distinct from new_item.value ->> 'id'
  ) then
    raise exception using errcode = '22023', message = 'unrelated_permanent_replacement_operation_changed';
  end if;

  saved_booking_state := booking_state;
  saved_operation_state := operation_state;
  saved_student_state := student_state;
  saved_teacher_state := teacher_state;
  if booking_state.payload is distinct from expected_bookings then
    update public.ops_state s set payload = expected_bookings, version = s.version + 1,
      updated_at = now(), updated_by = trim(p_actor)
    where s.entity = 'bookings' returning s.* into saved_booking_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('bookings', saved_booking_state.version, saved_booking_state.updated_by);
  end if;
  if operation_state.payload is distinct from p_operations then
    update public.ops_state s set payload = p_operations, version = s.version + 1,
      updated_at = now(), updated_by = trim(p_actor)
    where s.entity = 'operations' returning s.* into saved_operation_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('operations', saved_operation_state.version, saved_operation_state.updated_by);
  end if;
  if student_state.payload is distinct from expected_students then
    update public.ops_state s set payload = expected_students, version = s.version + 1,
      updated_at = now(), updated_by = trim(p_actor)
    where s.entity = 'students' returning s.* into saved_student_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('students', saved_student_state.version, saved_student_state.updated_by);
  end if;
  if teacher_state.payload is distinct from expected_teachers then
    update public.ops_state s set payload = expected_teachers, version = s.version + 1,
      updated_at = now(), updated_by = trim(p_actor)
    where s.entity = 'teachers' returning s.* into saved_teacher_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('teachers', saved_teacher_state.version, saved_teacher_state.updated_by);
  end if;

  audit_id := internal.append_operational_contract_audit(
    'operation.permanent_teacher_replacement', trim(p_actor), 'operation', p_operation_id,
    jsonb_build_object(
      'commandKey', p_command_key,
      'studentId', p_student_id,
      'sourceTeacherId', p_source_teacher_id,
      'replacementTeacherId', p_replacement_teacher_id,
      'effectiveDate', p_effective_date,
      'affectedOccurrenceIds', p_affected_occurrence_ids,
      'changedTeacherIds', p_changed_teacher_ids,
      'versionsBefore', p_expected_versions,
      'versionsAfter', jsonb_build_object(
        'bookings', saved_booking_state.version,
        'operations', saved_operation_state.version,
        'students', saved_student_state.version,
        'teachers', saved_teacher_state.version
      ),
      'payloadSha256', payload_hash
    )
  );
  insert into internal.permanent_teacher_replacement_commands (
    command_key, command_intent, command_hash, operation_id, student_id,
    source_teacher_id, replacement_teacher_id, effective_date,
    affected_occurrence_ids, changed_teacher_ids, booking_version,
    operation_version, student_version, teacher_version, actor, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, p_operation_id, p_student_id,
    p_source_teacher_id, p_replacement_teacher_id, p_effective_date::date,
    p_affected_occurrence_ids, p_changed_teacher_ids, saved_booking_state.version,
    saved_operation_state.version, saved_student_state.version,
    saved_teacher_state.version, trim(p_actor), audit_id
  );

  return query select p_command_key, p_operation_id, true,
    p_affected_occurrence_ids, p_changed_teacher_ids,
    saved_booking_state, saved_operation_state, saved_teacher_state,
    saved_student_state, audit_id;
end;
$$;

revoke all on function public.confirm_permanent_teacher_replacement_atomic(text, text, jsonb, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_permanent_teacher_replacement_atomic(text, text, jsonb, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text)
  to anon, authenticated;

-- Executable migration fixtures protect the two most delicate projections:
-- the complete future occurrence closure/history overrides and the exact
-- capacity transfer. They execute during migration and roll back the whole
-- migration if PostgreSQL semantics drift from the reviewed contract.
do $$
declare
  old_bookings jsonb := '[{"id":"B-1","studentId":"S-1","teacherId":"T-1","date":"2026-09-01","start":"17:00","duration":60,"recurring":true,"repeatCount":3,"kind":"常规课","teacherSubjectId":"Math","occurrenceOverrides":[{"occurrenceId":"B-1:2026-09-01","status":"completed"}]}]'::jsonb;
  collision_bookings jsonb;
  affected jsonb;
  projected jsonb;
  teachers jsonb;
  teacher_projection jsonb;
begin
  projected := internal.permanent_teacher_replacement_occurrence_projection(
    old_bookings, 'S-1', 'T-1', '2026-09-08', true
  );
  affected := projected -> 'occurrenceIds';
  if affected is distinct from '["B-1:2026-09-08","B-1:2026-09-15"]'::jsonb then
    raise exception 'permanent_replacement_fixture_occurrence_closure_mismatch';
  end if;
  projected := internal.permanent_teacher_replacement_expected_bookings(
    old_bookings, 'S-1', 'T-1', 'T-2', affected
  );
  if projected #>> '{0,teacherId}' <> 'T-2'
     or projected #>> '{0,occurrenceOverrides,0,teacherId}' <> 'T-1'
     or projected #>> '{0,occurrenceOverrides,1,teacherId}' <> 'T-2'
     or projected #>> '{0,occurrenceOverrides,2,teacherId}' <> 'T-2' then
    raise exception 'permanent_replacement_fixture_booking_history_mismatch';
  end if;

  -- Booking ids may themselves contain colons.  An occurrence belongs to the
  -- series obtained by removing only its final :YYYY-MM-DD suffix; a prefix
  -- match would incorrectly mutate the first booking below as well.
  collision_bookings := '[{"id":"B","studentId":"S-1","teacherId":"T-1","date":"2026-09-08","start":"16:00","duration":60,"recurring":false},{"id":"B:2026-09-08","studentId":"S-1","teacherId":"T-1","date":"2026-09-08","start":"17:00","duration":60,"recurring":false}]'::jsonb;
  projected := internal.permanent_teacher_replacement_expected_bookings(
    collision_bookings, 'S-1', 'T-1', 'T-2',
    '["B:2026-09-08:2026-09-08"]'::jsonb
  );
  if projected #>> '{0,teacherId}' <> 'T-1'
     or projected #> '{0,occurrenceOverrides}' is not null
     or projected #>> '{1,teacherId}' <> 'T-2'
     or projected #>> '{1,occurrenceOverrides,0,occurrenceId}'
       <> 'B:2026-09-08:2026-09-08' then
    raise exception 'permanent_replacement_fixture_colon_booking_id_collision';
  end if;

  teachers := '[{"id":"T-1","name":"One","newStudentCapacity":0,"capacityAssignments":["S-1"]},{"id":"T-2","name":"Two","newStudentCapacity":2,"capacityAssignments":[]}]'::jsonb;
  teacher_projection := internal.permanent_teacher_replacement_expected_teachers(
    old_bookings, teachers, 'S-1', 'T-1', 'T-2', '2026-09-08'
  );
  if teacher_projection -> 'changedTeacherIds' is distinct from '["T-1","T-2"]'::jsonb
     or teacher_projection #>> '{teachers,0,newStudentCapacity}' <> '1'
     or teacher_projection #> '{teachers,0,capacityAssignments}' is distinct from '[]'::jsonb
     or teacher_projection #>> '{teachers,1,newStudentCapacity}' <> '1'
     or teacher_projection #> '{teachers,1,capacityAssignments}' is distinct from '["S-1"]'::jsonb then
    raise exception 'permanent_replacement_fixture_capacity_mismatch';
  end if;

  begin
    perform internal.permanent_teacher_replacement_occurrence_projection(
      '[{"id":"B-BAD","studentId":"S-1","teacherId":"T-1","date":"2026-09-08","start":"17:00","duration":60,"recurring":false,"occurrenceOverrides":[{"occurrenceId":"B-BAD:2026-09-08","teacherId":7}]}]'::jsonb,
      'S-1', 'T-1', '2026-09-08', true
    );
    raise exception 'permanent_replacement_fixture_non_string_override_accepted';
  exception when sqlstate '22023' then
    if sqlerrm <> 'invalid_permanent_replacement_override' then raise; end if;
  end;
end;
$$;

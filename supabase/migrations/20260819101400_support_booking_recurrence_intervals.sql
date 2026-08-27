-- Recurrence intervals are persisted on booking JSON.  This forward migration
-- patches only the currently deployed function definitions; it does not alter
-- a prior migration, create tables, or widen any RPC ACL.

create or replace function internal.booking_recurrence_interval_days(p_booking jsonb)
returns integer
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  interval_days integer;
begin
  if jsonb_typeof(p_booking) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'booking_recurrence_payload_invalid';
  end if;
  if p_booking ? 'recurring' and jsonb_typeof(p_booking -> 'recurring') is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'booking_recurrence_payload_invalid';
  end if;
  if coalesce(p_booking ->> 'recurring', 'false') <> 'true' then
    return 1;
  end if;
  -- Legacy recurring=true rows were weekly. New rows must persist this value.
  interval_days := case when p_booking ? 'recurrenceIntervalDays'
    then case when jsonb_typeof(p_booking -> 'recurrenceIntervalDays') = 'number'
      and (p_booking ->> 'recurrenceIntervalDays') ~ '^[1-9][0-9]*$'
      then (p_booking ->> 'recurrenceIntervalDays')::integer else null end
    else 7 end;
  if interval_days is null or interval_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'booking_recurrence_interval_out_of_range';
  end if;
  return interval_days;
end;
$$;

revoke all on function internal.booking_recurrence_interval_days(jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.booking_recurrence_repeat_count(p_booking jsonb)
returns integer
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  repeat_count integer;
begin
  if jsonb_typeof(p_booking) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'booking_recurrence_payload_invalid';
  end if;
  if p_booking ? 'recurring' and jsonb_typeof(p_booking -> 'recurring') is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'booking_recurrence_payload_invalid';
  end if;
  if coalesce(p_booking ->> 'recurring', 'false') <> 'true' then
    if p_booking ? 'repeatCount'
       and (jsonb_typeof(p_booking -> 'repeatCount') is distinct from 'number'
         or p_booking ->> 'repeatCount' <> '1') then
      raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_out_of_range';
    end if;
    return 1;
  end if;
  if not (p_booking ? 'repeatCount') then
    -- Count-less rows are legacy weekly series. New creates are rejected by
    -- the native mutation patch below; updates retain the old series safely.
    return 104;
  end if;
  if jsonb_typeof(p_booking -> 'repeatCount') is distinct from 'number'
     or (p_booking ->> 'repeatCount') !~ '^[1-9][0-9]*$' then
    raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_required';
  end if;
  repeat_count := (p_booking ->> 'repeatCount')::integer;
  if repeat_count not between 1 and 104 then
    raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_out_of_range';
  end if;
  return repeat_count;
end;
$$;

revoke all on function internal.booking_recurrence_repeat_count(jsonb)
  from public, anon, authenticated, service_role;

-- The explicit end date is a second, independent upper bound. Keep date
-- parsing strict here because this helper is called by SECURITY DEFINER RPCs
-- and by every server-side recurrence projection.
create or replace function internal.booking_recurrence_end_date(p_booking jsonb)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  booking_date date;
  end_date date;
  raw_date text;
begin
  if jsonb_typeof(p_booking) is distinct from 'object'
     or jsonb_typeof(p_booking -> 'date') is distinct from 'string'
     or (p_booking ->> 'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'booking_recurrence_date_invalid';
  end if;
  begin
    booking_date := (p_booking ->> 'date')::date;
    if pg_catalog.to_char(booking_date, 'YYYY-MM-DD') <> p_booking ->> 'date' then
      raise exception using errcode = '22023', message = 'booking_recurrence_date_invalid';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'booking_recurrence_date_invalid';
  end;
  raw_date := p_booking ->> 'recurrenceEndDate';
  if p_booking ? 'recurrenceEndDate'
     and jsonb_typeof(p_booking -> 'recurrenceEndDate') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'booking_recurrence_end_date_invalid';
  end if;
  if raw_date is null then
    return null;
  end if;
  if raw_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'booking_recurrence_end_date_invalid';
  end if;
  begin
    end_date := raw_date::date;
    if pg_catalog.to_char(end_date, 'YYYY-MM-DD') <> raw_date then
      raise exception using errcode = '22023', message = 'booking_recurrence_end_date_invalid';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'booking_recurrence_end_date_invalid';
  end;
  if end_date < booking_date then
    raise exception using errcode = '22023', message = 'booking_recurrence_end_date_before_start';
  end if;
  return end_date;
end;
$$;

revoke all on function internal.booking_recurrence_end_date(jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.booking_recurrence_source_end_date(p_booking jsonb)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  booking_date date;
  count_end date;
  explicit_end date;
  interval_days integer;
  repeat_count integer;
begin
  -- The end-date helper validates the booking date and any explicit bound.
  explicit_end := internal.booking_recurrence_end_date(p_booking);
  booking_date := (p_booking ->> 'date')::date;
  repeat_count := internal.booking_recurrence_repeat_count(p_booking);
  if coalesce(p_booking ->> 'recurring', 'false') <> 'true' then
    return booking_date;
  end if;
  interval_days := internal.booking_recurrence_interval_days(p_booking);
  if p_booking ? 'repeatCount' then
    count_end := booking_date + ((repeat_count - 1) * interval_days);
  end if;
  if count_end is not null and explicit_end is not null then
    return least(count_end, explicit_end);
  end if;
  return coalesce(count_end, explicit_end);
end;
$$;

revoke all on function internal.booking_recurrence_source_end_date(jsonb)
  from public, anon, authenticated, service_role;

-- Return the exact number of source occurrences represented by the two
-- authoritative bounds.  In particular, a legacy row with no repeatCount but
-- an explicit end date must not be silently reduced to the compatibility
-- horizon of 104 occurrences when the end date is farther away.
create or replace function internal.booking_recurrence_occurrence_count(p_booking jsonb)
returns integer
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  booking_date date;
  source_end date;
  interval_days integer;
begin
  source_end := internal.booking_recurrence_source_end_date(p_booking);
  if source_end is null then
    return null;
  end if;
  booking_date := (p_booking ->> 'date')::date;
  if coalesce(p_booking ->> 'recurring', 'false') <> 'true' then
    return 1;
  end if;
  interval_days := internal.booking_recurrence_interval_days(p_booking);
  return ((source_end - booking_date) / interval_days) + 1;
end;
$$;

revoke all on function internal.booking_recurrence_occurrence_count(jsonb)
  from public, anon, authenticated, service_role;

-- Replace the deployed JWB conflict helper in full.  The old 190003 body
-- required repeatCount on every recurring row, which rejected legacy weekly
-- bookings before the interval helpers could apply their compatibility rule.
-- Count-less weekly legacy rows are bounded to 104 checks; count-less rows
-- with an explicit end date are finite but capped at 366 occurrences so a
-- hostile end date cannot turn the SECURITY DEFINER guard into an unbounded
-- loop.  A count-less non-weekly row must provide that finite end date.
create or replace function internal.assert_jiaowubao_direct_booking_interval_available(
  p_student_id text,
  p_teacher_id text,
  p_booking jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $assert_jiaowubao_direct_booking_interval_available$
declare
  source_date_text text;
  source_start_text text;
  source_timezone text;
  source_date date;
  source_start time;
  source_local_start timestamp;
  occurrence_date date;
  occurrence_index integer;
  occurrence_count integer;
  duration_minutes integer;
  candidate_count integer;
  source_end_date date;
  interval_days integer;
  end_date_occurrence_limit constant integer := 366;
begin
  if p_booking is null
     or jsonb_typeof(p_booking) <> 'object'
     or p_student_id is null or p_student_id <> btrim(p_student_id)
     or char_length(p_student_id) not between 1 and 240
     or p_teacher_id is null or p_teacher_id <> btrim(p_teacher_id)
     or char_length(p_teacher_id) not between 1 and 240
     or jsonb_typeof(p_booking -> 'date') <> 'string'
     or jsonb_typeof(p_booking -> 'start') <> 'string'
     or jsonb_typeof(p_booking -> 'timezone') <> 'string'
     or jsonb_typeof(p_booking -> 'duration') <> 'number'
     or jsonb_typeof(p_booking -> 'recurring') <> 'boolean' then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end if;

  source_date_text := p_booking ->> 'date';
  source_start_text := p_booking ->> 'start';
  source_timezone := p_booking ->> 'timezone';
  if source_date_text !~ '^\d{4}-\d{2}-\d{2}$'
     or source_start_text !~ '^([01]\d|2[0-3]):[0-5]\d$'
     or source_timezone <> btrim(source_timezone)
     or char_length(source_timezone) not between 1 and 120
     or p_booking ->> 'duration' not in ('60', '90', '120') then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names timezone_name
    where timezone_name.name = source_timezone
  ) then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end if;

  begin
    source_date := source_date_text::date;
    source_start := source_start_text::time;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end;
  if source_date::text <> source_date_text then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end if;
  duration_minutes := (p_booking ->> 'duration')::integer;

  if p_booking ->> 'recurring' = 'true' then
    interval_days := internal.booking_recurrence_interval_days(p_booking);
    source_end_date := internal.booking_recurrence_source_end_date(p_booking);
    if not (p_booking ? 'repeatCount') and source_end_date is null and interval_days <> 7 then
      raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_required';
    end if;
    if source_end_date is not null then
      occurrence_count := internal.booking_recurrence_occurrence_count(p_booking);
      if occurrence_count is null or occurrence_count < 1 or occurrence_count > end_date_occurrence_limit then
        raise exception using errcode = '22023', message = 'booking_recurrence_end_date_too_far';
      end if;
    elsif p_booking ? 'repeatCount' then
      -- The shared helper validates the strict 1..104 count and applies the
      -- earlier of count/endDate as the authoritative source end.
      occurrence_count := internal.booking_recurrence_occurrence_count(p_booking);
      if occurrence_count is null or occurrence_count not between 1 and 104 then
        raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_out_of_range';
      end if;
    else
      -- Legacy recurring=true rows had no bound.  Keep the weekly contract
      -- readable while bounding this conflict projection to 104 checks.
      occurrence_count := 104;
    end if;
  else
    interval_days := 1;
    if p_booking ? 'repeatCount'
       and (jsonb_typeof(p_booking -> 'repeatCount') <> 'number'
         or p_booking ->> 'repeatCount' <> '1') then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end if;
    occurrence_count := 1;
  end if;

  perform pg_catalog.set_config('lock_timeout', '1s', true);
  lock table internal.jiaowubao_direct_import_runs in share mode;

  for occurrence_index in 0..(occurrence_count - 1)
  loop
    occurrence_date := source_date + (occurrence_index * interval_days);
    if source_end_date is not null and occurrence_date > source_end_date then
      exit;
    end if;
    source_local_start := occurrence_date + source_start;

    -- A nonexistent wall clock has no exact round-trip instant and must fail,
    -- matching the existing JavaScript booking validation.  A repeated DST
    -- clock remains accepted, but every exact candidate is checked below.
    select count(*) into candidate_count
    from (
      select (
        (source_local_start - pg_catalog.make_interval(mins => offset_grid.offset_minutes))
        at time zone 'UTC'
      ) as instant
      from pg_catalog.generate_series(-720, 840, 15) offset_grid(offset_minutes)
    ) candidate
    where candidate.instant at time zone source_timezone = source_local_start;
    if candidate_count < 1 then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end if;

    if exists (
      select 1
      from (
        select (
          (source_local_start - pg_catalog.make_interval(mins => offset_grid.offset_minutes))
          at time zone 'UTC'
        ) as starts_at
        from pg_catalog.generate_series(-720, 840, 15) offset_grid(offset_minutes)
      ) candidate
      join internal.jiaowubao_direct_current_schedule_blocks imported_block
        on imported_block.occupied_range && tstzrange(
          candidate.starts_at,
          candidate.starts_at + pg_catalog.make_interval(mins => duration_minutes),
          '[)'
        )
      where candidate.starts_at at time zone source_timezone = source_local_start
        and (
          imported_block.teacher_id = p_teacher_id
          or p_student_id = any(imported_block.student_ids)
        )
    ) then
      raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_schedule_conflict';
    end if;
  end loop;
end;
$assert_jiaowubao_direct_booking_interval_available$;

revoke all on function internal.assert_jiaowubao_direct_booking_interval_available(text, text, jsonb)
  from public, anon, authenticated;

do $patch_booking_recurrence_functions$
declare
  target_oid oid;
  source_definition text;
  patched_definition text;
begin
  -- The authoritative JWB helper was replaced above in full.  Verify the
  -- active signature and recurrence anchors before patching the dependent
  -- native mutation, rather than inheriting the old repeatCount-only body.
  target_oid := to_regprocedure('internal.assert_jiaowubao_direct_booking_interval_available(text,text,jsonb)');
  if target_oid is null then
    raise exception using errcode = '55000', message = 'recurrence_jiaowubao_guard_target_missing';
  end if;
  select pg_get_functiondef(target_oid) into source_definition;
  if position('internal.booking_recurrence_interval_days(p_booking)' in source_definition) = 0
     or position('internal.booking_recurrence_source_end_date(p_booking)' in source_definition) = 0
     or position('end_date_occurrence_limit' in source_definition) = 0
     or position('booking_recurrence_repeat_count_required' in source_definition) = 0 then
    raise exception using errcode = '55000', message = 'recurrence_jiaowubao_guard_contract_mismatch';
  end if;

  -- Native booking mutation revalidates recurrence under its state locks;
  -- callers cannot bypass the interval/count contract by skipping Next.js.
  target_oid := to_regprocedure('public.mutate_booking_capacity_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text)');
  if target_oid is null then
    raise exception using errcode = '55000', message = 'recurrence_booking_mutation_target_missing';
  end if;
  select pg_get_functiondef(target_oid) into source_definition;
  patched_definition := replace(
    source_definition,
    E'  update public.ops_state s set\n    payload = p_bookings,',
    E'  if p_action <> ''delete'' then\n'
      || E'    perform internal.booking_recurrence_interval_days(next_booking);\n'
      || E'    perform internal.booking_recurrence_end_date(next_booking);\n'
      || E'    if p_action = ''create''\n'
      || E'       and next_booking ->> ''recurring'' = ''true''\n'
      || E'       and not (next_booking ? ''repeatCount'') then\n'
      || E'      raise exception using errcode = ''22023'', message = ''booking_recurrence_repeat_count_required'';\n'
      || E'    end if;\n'
      || E'    if p_action = ''create''\n'
      || E'       and next_booking ->> ''recurring'' = ''true''\n'
      || E'       and not (next_booking ? ''recurrenceIntervalDays'') then\n'
      || E'      raise exception using errcode = ''22023'', message = ''booking_recurrence_interval_required'';\n'
      || E'    end if;\n'
      || E'    if p_action = ''create''\n'
      || E'       and coalesce(next_booking ->> ''recurring'', ''false'') <> ''true''\n'
      || E'       and (not (next_booking ? ''repeatCount'')\n'
      || E'         or jsonb_typeof(next_booking -> ''repeatCount'') is distinct from ''number''\n'
      || E'         or next_booking ->> ''repeatCount'' <> ''1'') then\n'
      || E'      raise exception using errcode = ''22023'', message = ''booking_recurrence_repeat_count_required'';\n'
      || E'    end if;\n'
      || E'    if p_action = ''update''\n'
      || E'       and next_booking ->> ''recurring'' = ''true''\n'
      || E'       and not (next_booking ? ''repeatCount'')\n'
      || E'       and internal.booking_recurrence_interval_days(next_booking) <> 7\n'
      || E'       and coalesce(next_booking ->> ''recurrenceEndDate'', '''') = '''' then\n'
      || E'      raise exception using errcode = ''22023'', message = ''booking_recurrence_legacy_frequency_requires_bounds'';\n'
      || E'    end if;\n'
      || E'    perform internal.booking_recurrence_repeat_count(next_booking);\n'
      || E'    perform internal.booking_recurrence_source_end_date(next_booking);\n'
      || E'  end if;\n\n'
      || E'  update public.ops_state s set\n    payload = p_bookings,'
  );
  if patched_definition = source_definition then
    raise exception using errcode = '55000', message = 'recurrence_booking_mutation_anchor_mismatch';
  end if;
  execute patched_definition;

  -- Permanent replacement and its expected-booking projection must preserve
  -- stable occurrenceId/sourceDate while deriving the new interval.
  foreach target_oid in array ARRAY[
    to_regprocedure('internal.permanent_teacher_replacement_occurrence_projection(jsonb,text,text,text,boolean)'),
    to_regprocedure('internal.permanent_teacher_replacement_expected_bookings(jsonb,text,text,text,jsonb)')
  ] loop
    if target_oid is null then
      raise exception using errcode = '55000', message = 'recurrence_replacement_target_missing';
    end if;
    select pg_get_functiondef(target_oid) into source_definition;
    patched_definition := source_definition;
    if target_oid = to_regprocedure('internal.permanent_teacher_replacement_occurrence_projection(jsonb,text,text,text,boolean)') then
      patched_definition := replace(
        patched_definition,
        E'      if not (booking ? ''repeatCount'') then\n'
          || E'        if p_reject_unbounded then\n'
          || E'          raise exception using errcode = ''22023'', message = ''unbounded_permanent_replacement_series'';\n'
          || E'        end if;\n'
          || E'        unbounded := true;\n'
          || E'        continue;\n'
          || E'      end if;\n'
          || E'      if jsonb_typeof(booking -> ''repeatCount'') is distinct from ''number''\n'
          || E'         or (booking ->> ''repeatCount'')::numeric <> trunc((booking ->> ''repeatCount'')::numeric)\n'
          || E'         or (booking ->> ''repeatCount'')::numeric not between 1 and 104 then\n'
          || E'        raise exception using errcode = ''22023'', message = ''invalid_permanent_replacement_repeat_count'';\n'
          || E'      end if;\n'
          || E'      repeat_count := (booking ->> ''repeatCount'')::integer;',
        E'      if not (booking ? ''repeatCount'') then\n'
          || E'        if internal.booking_recurrence_source_end_date(booking) is null then\n'
          || E'          if p_reject_unbounded then\n'
          || E'            raise exception using errcode = ''22023'', message = ''unbounded_permanent_replacement_series'';\n'
          || E'          end if;\n'
          || E'          unbounded := true;\n'
          || E'          continue;\n'
          || E'        end if;\n'
          || E'        repeat_count := coalesce(internal.booking_recurrence_occurrence_count(booking), 104);\n'
          || E'      else\n'
          || E'        if jsonb_typeof(booking -> ''repeatCount'') is distinct from ''number''\n'
          || E'           or (booking ->> ''repeatCount'')::numeric <> trunc((booking ->> ''repeatCount'')::numeric)\n'
          || E'           or (booking ->> ''repeatCount'')::numeric not between 1 and 104 then\n'
          || E'          raise exception using errcode = ''22023'', message = ''invalid_permanent_replacement_repeat_count'';\n'
          || E'        end if;\n'
          || E'        repeat_count := (booking ->> ''repeatCount'')::integer;\n'
          || E'      end if;'
      );
      if patched_definition = source_definition then
        raise exception using errcode = '55000', message = 'recurrence_replacement_legacy_anchor_mismatch';
      end if;
    elsif target_oid = to_regprocedure('internal.permanent_teacher_replacement_expected_bookings(jsonb,text,text,text,jsonb)') then
      patched_definition := replace(
        patched_definition,
        E'      repeat_count := case when booking -> ''recurring'' = ''true''::jsonb\n'
          || E'        then (booking ->> ''repeatCount'')::integer else 1 end;',
        E'      perform internal.booking_recurrence_interval_days(booking);\n'
          || E'      perform internal.booking_recurrence_end_date(booking);\n'
          || E'      perform internal.booking_recurrence_repeat_count(booking);\n'
          || E'      if booking -> ''recurring'' = ''true''::jsonb\n'
          || E'         and internal.booking_recurrence_source_end_date(booking) is null then\n'
          || E'        raise exception using errcode = ''22023'', message = ''unbounded_permanent_replacement_series'';\n'
          || E'      end if;\n'
          || E'      repeat_count := case when booking -> ''recurring'' = ''true''::jsonb\n'
          || E'        then coalesce((booking ->> ''repeatCount'')::integer, internal.booking_recurrence_occurrence_count(booking), 104) else 1 end;'
      );
      if patched_definition = source_definition then
        raise exception using errcode = '55000', message = 'recurrence_replacement_expected_anchor_mismatch';
      end if;
    end if;
    patched_definition := replace(
      patched_definition,
      'source_date := (booking ->> ''date'')::date + occurrence_index * ' || pg_catalog.chr(55) || ';',
      E'      source_date := (booking ->> ''date'')::date + occurrence_index * internal.booking_recurrence_interval_days(booking);\n'
        || E'      if internal.booking_recurrence_source_end_date(booking) is not null\n'
        || E'         and source_date > internal.booking_recurrence_source_end_date(booking) then\n'
        || E'        exit;\n'
        || E'      end if;'
    );
    if position('internal.booking_recurrence_interval_days(booking)' in patched_definition) = 0
       or position('internal.booking_recurrence_source_end_date(booking)' in patched_definition) = 0 then
      raise exception using errcode = '55000', message = 'recurrence_replacement_interval_anchor_mismatch';
    end if;
    execute patched_definition;
  end loop;

  -- Attendance settlement validates occurrenceId against its source date.
  target_oid := to_regprocedure('public.complete_lesson_occurrence_atomic(text,text,bigint,jsonb,text,jsonb,text,text,text,text)');
  if target_oid is null then
    raise exception using errcode = '55000', message = 'recurrence_settlement_target_missing';
  end if;
  select pg_get_functiondef(target_oid) into source_definition;
  patched_definition := replace(source_definition,
    'recurrence_offset % 7 <> 0',
    'recurrence_offset % internal.booking_recurrence_interval_days(booking) <> 0');
  patched_definition := replace(patched_definition,
    E'recurrence_offset < 0\n     or (',
    E'recurrence_offset < 0\n     or (internal.booking_recurrence_source_end_date(booking) is not null\n         and source_date::date > internal.booking_recurrence_source_end_date(booking))\n     or (');
  patched_definition := replace(patched_definition,
    'recurrence_offset / 7 >= (booking ->> ''repeatCount'')::integer',
    'recurrence_offset / internal.booking_recurrence_interval_days(booking) >= (booking ->> ''repeatCount'')::integer');
  if patched_definition = source_definition
     or position('internal.booking_recurrence_source_end_date(booking)' in patched_definition) = 0
     or position('internal.booking_recurrence_interval_days(booking)' in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'recurrence_settlement_anchor_mismatch';
  end if;
  execute patched_definition;
end;
$patch_booking_recurrence_functions$;

-- Reassert the existing narrow ACLs after CREATE OR REPLACE/dynamic replacement.
revoke all on function public.complete_lesson_occurrence_atomic(text,text,bigint,jsonb,text,jsonb,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.complete_lesson_occurrence_atomic(text,text,bigint,jsonb,text,jsonb,text,text,text,text)
  to anon, authenticated;

-- Replace the currently active departure timeline projector from 191011 in
-- this forward migration.  The public departure RPC keeps its stable
-- signature and continues to call this v2 projector, while the source range
-- now follows the same interval/end-date contract as the application.
create or replace function internal.teacher_departure_creation_tasks_v2(
  p_command_key text,
  p_operation_id text,
  p_student_id text,
  p_student_owner text,
  p_source_teacher_id text,
  p_bookings jsonb,
  p_effective_date date,
  p_submitted_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  definition jsonb;
  task_owner text;
  due_date date;
  due_at_text text;
  task_status text;
  task_tone text;
  source_teacher_name text;
  lp_due_date date;
  result jsonb := '[]'::jsonb;
begin
  if coalesce(p_command_key, '') !~ '^teacher-departure-create:'
     or nullif(trim(p_operation_id), '') is null
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_source_teacher_id), '') is null
     or jsonb_typeof(p_bookings) is distinct from 'array'
     or p_effective_date is null
     or p_submitted_at is null then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_task_projection';
  end if;

  -- A count-less legacy series is safe only when it has an explicit end date.
  -- Otherwise there is no truthful penultimate lesson and the whole mutation
  -- must fail closed rather than silently projecting 104 guessed weeks.
  if exists (
    select 1
    from jsonb_array_elements(p_bookings) booking(value)
    where booking.value ->> 'kind' is distinct from '代课'
      and booking.value ->> 'recurring' = 'true'
      and (
        (
          booking.value ->> 'studentId' = p_student_id
          and booking.value ->> 'teacherId' = p_source_teacher_id
        )
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(booking.value -> 'occurrenceOverrides') = 'array'
            then booking.value -> 'occurrenceOverrides' else '[]'::jsonb end) override_item(value)
          where coalesce(
              case when override_item.value ? 'studentId'
                and jsonb_typeof(override_item.value -> 'studentId') = 'string'
                then nullif(trim(override_item.value ->> 'studentId'), '') end,
              booking.value ->> 'studentId'
            ) = p_student_id
            and coalesce(
              case when override_item.value ? 'teacherId'
                and jsonb_typeof(override_item.value -> 'teacherId') = 'string'
                then nullif(trim(override_item.value ->> 'teacherId'), '') end,
              booking.value ->> 'teacherId'
            ) = p_source_teacher_id
        )
      )
      and internal.booking_recurrence_source_end_date(booking.value) is null
  ) then
    raise exception using errcode = '22023', message = 'unbounded_teacher_departure_series';
  end if;

  select nullif(trim(item.value ->> 'name'), '')
    into source_teacher_name
  from public.ops_state state
  cross join lateral jsonb_array_elements(state.payload) item(value)
  where state.entity = 'teachers'
    and item.value ->> 'id' = p_source_teacher_id
  limit 1;
  if source_teacher_name is null then
    raise exception using errcode = '22023', message = 'teacher_departure_source_teacher_name_missing';
  end if;

  with booking_rows as (
    select booking.value as booking
    from jsonb_array_elements(p_bookings) booking(value)
    where booking.value ->> 'kind' is distinct from '代课'
      and (
        (
          booking.value ->> 'studentId' = p_student_id
          and booking.value ->> 'teacherId' = p_source_teacher_id
        )
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(booking.value -> 'occurrenceOverrides') = 'array'
            then booking.value -> 'occurrenceOverrides' else '[]'::jsonb end) override_item(value)
          where coalesce(
              case when override_item.value ? 'studentId'
                and jsonb_typeof(override_item.value -> 'studentId') = 'string'
                then nullif(trim(override_item.value ->> 'studentId'), '') end,
              booking.value ->> 'studentId'
            ) = p_student_id
            and coalesce(
              case when override_item.value ? 'teacherId'
                and jsonb_typeof(override_item.value -> 'teacherId') = 'string'
                then nullif(trim(override_item.value ->> 'teacherId'), '') end,
              booking.value ->> 'teacherId'
            ) = p_source_teacher_id
        )
      )
  ), source_occurrences as (
    select
      booking,
      source_date::date as source_date,
      booking ->> 'id' || ':' || pg_catalog.to_char(source_date::date, 'YYYY-MM-DD') as occurrence_id
    from booking_rows
    cross join lateral (
      select internal.booking_recurrence_source_end_date(booking) as source_end_date,
             internal.booking_recurrence_interval_days(booking) as interval_days
    ) recurrence
    cross join lateral generate_series(
      (booking ->> 'date')::date,
      case when booking ->> 'recurring' = 'true'
        then recurrence.source_end_date
        else (booking ->> 'date')::date end,
      pg_catalog.make_interval(days => recurrence.interval_days)
    ) source_date
  ), resolved_occurrences as (
    select
      source.occurrence_id,
      (coalesce(override.value ->> 'date', source.source_date::text))::date as lesson_date,
      coalesce(override.value ->> 'start', source.booking ->> 'start') as lesson_start,
      case when override.value ? 'teacherId'
        then case when jsonb_typeof(override.value -> 'teacherId') = 'string'
          then nullif(trim(override.value ->> 'teacherId'), '') else null end
        else nullif(trim(source.booking ->> 'teacherId'), '') end as teacher_id,
      case when override.value ? 'studentId'
        then case when jsonb_typeof(override.value -> 'studentId') = 'string'
          then nullif(trim(override.value ->> 'studentId'), '') else null end
        else nullif(trim(source.booking ->> 'studentId'), '') end as student_id,
      coalesce(override.value ->> 'status', 'confirmed') as lesson_status,
      case when override.value ? 'durationMinutes'
        and override.value -> 'durationMinutes' <> 'null'::jsonb
        then (override.value ->> 'durationMinutes')::numeric
        else (source.booking ->> 'duration')::numeric end as duration_minutes,
      coalesce(nullif(trim(source.booking ->> 'timezone'), ''), 'Australia/Melbourne') as timezone_name
    from source_occurrences source
    left join lateral (
      select item.value
      from jsonb_array_elements(case when jsonb_typeof(source.booking -> 'occurrenceOverrides') = 'array'
        then source.booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
      where item.value ->> 'occurrenceId' = source.occurrence_id
      limit 1
    ) override on true
  ), ranked as (
    select *,
      row_number() over (order by lesson_date, lesson_start, occurrence_id) as lesson_number,
      count(*) over () as lesson_count
    from resolved_occurrences
    where student_id = p_student_id
      and teacher_id = p_source_teacher_id
      and lesson_date < p_effective_date
      and lesson_status not in ('cancelled', 'leave')
  )
  select (
    (((lesson_date::timestamp + lesson_start::time
      + duration_minutes * interval '1 minute') at time zone timezone_name)
      at time zone 'Australia/Melbourne')::date + 1
  )
  into lp_due_date
  from ranked
  where lesson_number = lesson_count - 1;

  for definition in
    select item.value from jsonb_array_elements('[
      {"rule":"recommendation","title":"筛选并确认推荐老师名单","owner":"Tiffany","offset":-14,"tone":"red","trigger":"老师离职：推荐老师名单"},
      {"rule":"new-teacher-contact","title":"开启新老师沟通","owner":"student","offset":-14,"tone":"amber","trigger":"老师离职：新老师沟通"},
      {"rule":"handover","title":"确认 Handover Notes 与原老师约定 DDL","owner":"student","offset":-7,"tone":"blue","trigger":"老师离职：交接资料"},
      {"rule":"parent-contact","title":"告知家长并记录最终安排","owner":"student","offset":-7,"tone":"red","trigger":"老师离职：家长沟通"},
      {"rule":"management-watcher","title":"向龙老师汇报离职交接进度","owner":"思佳","offset":-7,"tone":"amber","trigger":"老师离职：管理确认"}
    ]'::jsonb) item(value)
  loop
    task_owner := case when definition ->> 'owner' = 'student'
      then coalesce(nullif(trim(p_student_owner), ''), '待分配')
      else definition ->> 'owner' end;
    due_date := p_effective_date + (definition ->> 'offset')::integer;
    due_at_text := pg_catalog.to_char(
      ((due_date::timestamp + interval '18 hours') at time zone 'Australia/Melbourne') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    if due_date < (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'overdue'; task_tone := 'red';
    elsif due_date = (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'today'; task_tone := 'amber';
    else
      task_status := 'upcoming'; task_tone := definition ->> 'tone';
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'id', 'TSK-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
        p_command_key || chr(31) || p_student_id || chr(31) || (definition ->> 'rule'), 'sha256'
      ), 'hex'), 24),
      'title', definition ->> 'title', 'owner', task_owner,
      'assignees', jsonb_build_array(task_owner), 'watchers', jsonb_build_array('Ops Admin'),
      'studentId', p_student_id, 'due', pg_catalog.to_char(due_date, 'YYYY-MM-DD') || ' 18:00',
      'dueAt', due_at_text, 'status', task_status, 'tone', task_tone,
      'category', '请假代课', 'trigger', definition ->> 'trigger',
      'ruleKey', 'teacher-departure:' || p_operation_id || ':' || (definition ->> 'rule'),
      'anchorBookingId', p_operation_id
    ));
  end loop;

  if lp_due_date is not null then
    due_date := lp_due_date;
    due_at_text := pg_catalog.to_char(
      ((due_date::timestamp + interval '18 hours') at time zone 'Australia/Melbourne') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    if due_date < (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'overdue'; task_tone := 'red';
    elsif due_date = (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'today'; task_tone := 'amber';
    else
      task_status := 'upcoming'; task_tone := 'blue';
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'id', 'TSK-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
        p_command_key || chr(31) || p_student_id || chr(31) || 'lp-to-new-teacher', 'sha256'
      ), 'hex'), 24),
      'title', '写 LP 给新老师', 'owner', source_teacher_name,
      'assignees', jsonb_build_array(source_teacher_name), 'watchers', jsonb_build_array('Ops Admin'),
      'studentId', p_student_id, 'due', pg_catalog.to_char(due_date, 'YYYY-MM-DD') || ' 18:00',
      'dueAt', due_at_text, 'status', task_status, 'tone', task_tone,
      'category', '请假代课', 'trigger', '老师离职：写 LP 给新老师',
      'ruleKey', 'teacher-departure:' || p_operation_id || ':lp-to-new-teacher',
      'anchorBookingId', p_operation_id
    ));
  end if;
  return result;
end;
$function$;

revoke all on function internal.teacher_departure_creation_tasks_v2(text, text, text, text, text, jsonb, date, timestamptz)
  from public, anon, authenticated, service_role;

do $departure_projector_guard$
declare
  definition text;
begin
  select pg_get_functiondef('public.create_teacher_departure_atomic(text,text,jsonb,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure)
    into definition;
  if definition is null or position('teacher_departure_creation_tasks_v2' in definition) = 0 then
    raise exception using errcode = '55000', message = 'teacher_departure_projector_not_active';
  end if;
end;
$departure_projector_guard$;

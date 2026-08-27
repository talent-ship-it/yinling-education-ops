-- Teacher leave/cover creation is a single reviewed command.  Creation only
-- records the pending operation and its reminders; lesson occurrence status is
-- deliberately unchanged until the existing operation-confirm RPC confirms
-- leave or a substitute.  This keeps the existing human confirmation contract
-- while making the batch derivation and task insert atomic.

create table if not exists internal.teacher_absence_creation_commands (
  command_key text primary key check (command_key ~ '^teacher-absence-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  source_teacher_id text not null,
  event_start date not null,
  event_end date not null,
  operation_ids jsonb not null check (jsonb_typeof(operation_ids) = 'array'),
  affected_student_ids jsonb not null check (jsonb_typeof(affected_student_ids) = 'array'),
  affected_groups jsonb not null check (jsonb_typeof(affected_groups) = 'array'),
  booking_version bigint not null check (booking_version > 0),
  operation_version bigint not null check (operation_version > 0),
  student_version bigint not null check (student_version > 0),
  task_version bigint not null check (task_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor text not null,
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);
alter table internal.teacher_absence_creation_commands enable row level security;
create index if not exists teacher_absence_creation_commands_audit_id_idx on internal.teacher_absence_creation_commands(audit_id);
revoke all on table internal.teacher_absence_creation_commands from public, anon, authenticated, service_role;

-- PostgreSQL's default wall-clock conversion matches scheduleOccurrenceInstant
-- for lessons.  AVA uses explicit earlier/later disambiguation, so enumerate
-- the small set of transition-adjacent candidates and round-trip them.
create or replace function internal.teacher_absence_ava_instant(p_date date, p_time text, p_timezone text, p_later boolean)
returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
declare wall_clock timestamp; base_instant timestamptz; resolved timestamptz;
begin
  if p_date is null or coalesce(p_time, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or nullif(trim(p_timezone), '') is null then return null; end if;
  begin
    wall_clock := p_date::timestamp + p_time::time;
    base_instant := wall_clock at time zone p_timezone;
    select case when p_later then max(candidate) else min(candidate) end into resolved
    from generate_series(base_instant - interval '3 hours', base_instant + interval '3 hours', interval '15 minutes') candidate
    where candidate at time zone p_timezone = wall_clock;
  exception when others then
    return null;
  end;
  return resolved;
end;
$$;
revoke all on function internal.teacher_absence_ava_instant(date, text, text, boolean) from public, anon, authenticated, service_role;

-- Mirrors normalizeBookingRecurrence/expandLessonOccurrences.  An explicit
-- count stays capped at the reviewed UI limit, while a legacy count-less
-- series is expanded only as far as the caller's finite authority window.
create or replace function internal.teacher_absence_occurrence_count(p_booking jsonb, p_range_end date)
returns integer language plpgsql stable security invoker set search_path = '' as $$
declare base_date date; recurrence_end date; interval_days integer := 7; explicit_count integer; possible_count integer; is_recurring boolean;
begin
  begin base_date := (p_booking ->> 'date')::date; exception when others then raise exception using errcode = '22023', message = 'teacher_absence_booking_date_missing'; end;
  is_recurring := jsonb_typeof(p_booking -> 'recurring') = 'boolean' and p_booking ->> 'recurring' = 'true';
  if not is_recurring then return 1; end if;
  if p_booking ? 'recurrenceIntervalDays' then
    if jsonb_typeof(p_booking -> 'recurrenceIntervalDays') is distinct from 'number' or coalesce(p_booking ->> 'recurrenceIntervalDays', '') !~ '^[1-9][0-9]*$' then raise exception using errcode = '22023', message = 'teacher_absence_recurrence_interval_out_of_range'; end if;
    interval_days := (p_booking ->> 'recurrenceIntervalDays')::integer;
    if interval_days > 365 then raise exception using errcode = '22023', message = 'teacher_absence_recurrence_interval_out_of_range'; end if;
  end if;
  if p_booking ? 'recurrenceEndDate' then
    if jsonb_typeof(p_booking -> 'recurrenceEndDate') is distinct from 'string' or coalesce(p_booking ->> 'recurrenceEndDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception using errcode = '22023', message = 'teacher_absence_recurrence_end_invalid'; end if;
    begin recurrence_end := (p_booking ->> 'recurrenceEndDate')::date; exception when others then raise exception using errcode = '22023', message = 'teacher_absence_recurrence_end_invalid'; end;
  end if;
  if p_booking ? 'repeatCount' then
    if jsonb_typeof(p_booking -> 'repeatCount') is distinct from 'number' or coalesce(p_booking ->> 'repeatCount', '') !~ '^[1-9][0-9]*$' then raise exception using errcode = '22023', message = 'teacher_absence_repeat_count_out_of_range'; end if;
    explicit_count := (p_booking ->> 'repeatCount')::integer;
    if explicit_count > 104 then raise exception using errcode = '22023', message = 'teacher_absence_repeat_count_out_of_range'; end if;
  end if;
  if recurrence_end is not null and recurrence_end < p_range_end then p_range_end := recurrence_end; end if;
  if p_range_end < base_date then return 0; end if;
  possible_count := ((p_range_end - base_date) / interval_days) + 1;
  return case when explicit_count is null then possible_count else least(possible_count, explicit_count) end;
end;
$$;
revoke all on function internal.teacher_absence_occurrence_count(jsonb, date) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_recurrence_interval(p_booking jsonb)
returns integer language plpgsql stable security invoker set search_path = '' as $$
begin
  if not (jsonb_typeof(p_booking -> 'recurring') = 'boolean' and p_booking ->> 'recurring' = 'true') then return 0; end if;
  if not (p_booking ? 'recurrenceIntervalDays') then return 7; end if;
  if jsonb_typeof(p_booking -> 'recurrenceIntervalDays') is distinct from 'number' or coalesce(p_booking ->> 'recurrenceIntervalDays', '') !~ '^[1-9][0-9]*$' or (p_booking ->> 'recurrenceIntervalDays')::numeric > 365 then raise exception using errcode = '22023', message = 'teacher_absence_recurrence_interval_out_of_range'; end if;
  return (p_booking ->> 'recurrenceIntervalDays')::integer;
end;
$$;
revoke all on function internal.teacher_absence_recurrence_interval(jsonb) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_resolve_occurrence(p_booking jsonb, p_occurrence_id text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare booking_id text; source_date date; base_date date; occurrence_index integer; repeat_count integer; interval_days integer; override_item jsonb;
  resolved_date date; resolved_start text; resolved_duration numeric; resolved_status text; resolved_teacher text; resolved_student text; resolved_timezone text; starts_at timestamptz; ends_at timestamptz;
begin
  booking_id := case when jsonb_typeof(p_booking -> 'id') = 'string' then nullif(trim(p_booking ->> 'id'), '') end;
  if booking_id is null or p_occurrence_id is distinct from booking_id || ':' || right(p_occurrence_id, 10) or right(p_occurrence_id, 10) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  begin source_date := right(p_occurrence_id, 10)::date; base_date := (p_booking ->> 'date')::date; exception when others then return null; end;
  if jsonb_typeof(p_booking -> 'recurring') = 'boolean' and p_booking ->> 'recurring' = 'true' then
    interval_days := internal.teacher_absence_recurrence_interval(p_booking);
    if source_date < base_date or (source_date - base_date) % interval_days <> 0 then return null; end if;
    occurrence_index := (source_date - base_date) / interval_days;
    repeat_count := internal.teacher_absence_occurrence_count(p_booking, source_date);
    if occurrence_index >= repeat_count then return null; end if;
  elsif source_date <> base_date then
    return null;
  end if;
  if p_booking ? 'occurrenceOverrides' and jsonb_typeof(p_booking -> 'occurrenceOverrides') is distinct from 'array' then return null; end if;
  if (select count(*) from jsonb_array_elements(case when jsonb_typeof(p_booking -> 'occurrenceOverrides') = 'array' then p_booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value) where value ->> 'occurrenceId' = p_occurrence_id) > 1 then raise exception using errcode = '22023', message = 'teacher_absence_duplicate_occurrence_override'; end if;
  select value into override_item from jsonb_array_elements(case when jsonb_typeof(p_booking -> 'occurrenceOverrides') = 'array' then p_booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value) where value ->> 'occurrenceId' = p_occurrence_id limit 1;
  begin
    resolved_date := coalesce((override_item ->> 'date')::date, source_date);
    resolved_start := coalesce(override_item ->> 'start', p_booking ->> 'start');
    if override_item ? 'durationMinutes' and jsonb_typeof(override_item -> 'durationMinutes') not in ('number', 'null') then return null; end if;
    if jsonb_typeof(p_booking -> 'duration') is distinct from 'number' then return null; end if;
    resolved_duration := coalesce((override_item ->> 'durationMinutes')::numeric, (p_booking ->> 'duration')::numeric);
    resolved_timezone := nullif(trim(p_booking ->> 'timezone'), '');
    if resolved_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or resolved_duration < 1 or resolved_timezone is null then return null; end if;
    starts_at := (resolved_date::timestamp + resolved_start::time) at time zone resolved_timezone;
    ends_at := starts_at + make_interval(secs => (resolved_duration * 60)::double precision);
  exception when others then return null; end;
  resolved_status := coalesce(override_item ->> 'status', 'confirmed');
  resolved_teacher := case when override_item ? 'teacherId' then case when jsonb_typeof(override_item -> 'teacherId') = 'string' then nullif(trim(override_item ->> 'teacherId'), '') end else case when jsonb_typeof(p_booking -> 'teacherId') = 'string' then nullif(trim(p_booking ->> 'teacherId'), '') end end;
  resolved_student := case when override_item ? 'studentId' then case when jsonb_typeof(override_item -> 'studentId') = 'string' then nullif(trim(override_item ->> 'studentId'), '') end else case when jsonb_typeof(p_booking -> 'studentId') = 'string' then nullif(trim(p_booking ->> 'studentId'), '') end end;
  return jsonb_build_object('occurrenceId', p_occurrence_id, 'sourceDate', to_char(source_date, 'YYYY-MM-DD'), 'date', to_char(resolved_date, 'YYYY-MM-DD'), 'start', resolved_start, 'durationMinutes', resolved_duration, 'status', resolved_status, 'teacherId', resolved_teacher, 'studentId', resolved_student, 'timezone', resolved_timezone, 'startsAt', starts_at, 'endsAt', ends_at);
end;
$$;
revoke all on function internal.teacher_absence_resolve_occurrence(jsonb, text) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_source_range_end(p_booking jsonb, p_target_start date, p_target_end date)
returns date language plpgsql stable security invoker set search_path = '' as $$
declare override_item jsonb; source_date date; result date := p_target_end;
begin
  for override_item in select value from jsonb_array_elements(case when jsonb_typeof(p_booking -> 'occurrenceOverrides') = 'array' then p_booking -> 'occurrenceOverrides' else '[]'::jsonb end) loop
    begin
      if override_item ->> 'date' is not null and (override_item ->> 'date')::date between p_target_start and p_target_end then
        source_date := right(override_item ->> 'occurrenceId', 10)::date;
        if source_date > result then result := source_date; end if;
      end if;
    exception when others then raise exception using errcode = '22023', message = 'teacher_absence_override_date_invalid'; end;
  end loop;
  return result;
end;
$$;
revoke all on function internal.teacher_absence_source_range_end(jsonb, date, date) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_creation_projection(
  p_bookings jsonb, p_source_teacher_id text, p_event_start text, p_event_end text
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  booking jsonb; occurrence jsonb; base_date date; range_end date; repeats integer; interval_days integer; i integer;
  student_id text; subject text; occurrence_id text; first_at text; groups jsonb := '{}'::jsonb; existing jsonb;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array'
     or coalesce(p_source_teacher_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_event_start, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(p_event_end, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or p_event_start > p_event_end then
    raise exception using errcode = '22023', message = 'invalid_teacher_absence_projection';
  end if;
  for booking in select value from jsonb_array_elements(p_bookings) loop
    begin base_date := (booking ->> 'date')::date; exception when others then raise exception using errcode = '22023', message = 'teacher_absence_booking_date_missing'; end;
    range_end := internal.teacher_absence_source_range_end(booking, p_event_start::date, p_event_end::date);
    repeats := internal.teacher_absence_occurrence_count(booking, range_end);
    interval_days := internal.teacher_absence_recurrence_interval(booking);
    if repeats < 1 then continue; end if;
    for i in 0..repeats - 1 loop
      occurrence_id := coalesce(booking ->> 'id', '') || ':' || to_char(base_date + (i * case when interval_days = 0 then 0 else interval_days end), 'YYYY-MM-DD');
      occurrence := internal.teacher_absence_resolve_occurrence(booking, occurrence_id);
      if occurrence is not null and occurrence ->> 'teacherId' = p_source_teacher_id
         and occurrence ->> 'status' not in ('cancelled', 'leave')
         and (occurrence ->> 'date')::date between p_event_start::date and p_event_end::date then
        student_id := occurrence ->> 'studentId';
        if coalesce(student_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' then raise exception using errcode = '22023', message = 'teacher_absence_student_identity_missing'; end if;
        subject := case when jsonb_typeof(booking -> 'teacherSubjectId') = 'string' then nullif(trim(booking ->> 'teacherSubjectId'), '') end;
        if subject is null then raise exception using errcode = '22023', message = 'teacher_absence_subject_missing'; end if;
        first_at := to_char((occurrence ->> 'startsAt')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
        existing := coalesce(groups -> student_id, jsonb_build_object('studentId', student_id, 'affectedOccurrenceIds', '[]'::jsonb, 'subjects', '[]'::jsonb));
        groups := jsonb_set(groups, array[student_id], existing || jsonb_build_object(
          'affectedOccurrenceIds', (existing -> 'affectedOccurrenceIds') || jsonb_build_array(occurrence_id),
          'subjects', case when (existing -> 'subjects') @> jsonb_build_array(subject) then existing -> 'subjects' else (existing -> 'subjects') || jsonb_build_array(subject) end,
          'firstAffectedAt', case when existing ->> 'firstAffectedAt' is null or first_at < existing ->> 'firstAffectedAt' then first_at else existing ->> 'firstAffectedAt' end
        ), true);
      end if;
    end loop;
  end loop;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'studentId', value ->> 'studentId',
    'affectedOccurrenceIds', (select coalesce(jsonb_agg(item.value order by item.value #>> '{}' collate "C"), '[]'::jsonb) from jsonb_array_elements(value -> 'affectedOccurrenceIds') item),
    'subjects', (select coalesce(jsonb_agg(item.value order by item.value #>> '{}' collate "C"), '[]'::jsonb) from jsonb_array_elements(value -> 'subjects') item),
    'firstAffectedAt', value ->> 'firstAffectedAt'
  ) order by value ->> 'studentId' collate "C") from jsonb_each(groups)), '[]'::jsonb);
end;
$$;
revoke all on function internal.teacher_absence_creation_projection(jsonb, text, text, text) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_historical_due_date(p_bookings jsonb, p_source_teacher_id text, p_student_id text, p_before text)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare booking jsonb; occurrence jsonb; last_occurrence jsonb; base_date date; target_start date; target_end date; range_end date; repeats integer; interval_days integer; i integer; occurrence_id text; sort_key text; last_sort_key text;
begin
  target_start := p_before::date - 730;
  target_end := p_before::date - 1;
  for booking in select value from jsonb_array_elements(coalesce(p_bookings, '[]'::jsonb)) loop
    begin base_date := (booking ->> 'date')::date; exception when others then raise exception using errcode = '22023', message = 'teacher_absence_booking_date_missing'; end;
    range_end := internal.teacher_absence_source_range_end(booking, target_start, target_end);
    repeats := internal.teacher_absence_occurrence_count(booking, range_end);
    interval_days := internal.teacher_absence_recurrence_interval(booking);
    if repeats < 1 then continue; end if;
    for i in 0..repeats - 1 loop
      occurrence_id := coalesce(booking ->> 'id', '') || ':' || to_char(base_date + (i * case when interval_days = 0 then 0 else interval_days end), 'YYYY-MM-DD');
      occurrence := internal.teacher_absence_resolve_occurrence(booking, occurrence_id);
      if occurrence is null or occurrence ->> 'teacherId' is distinct from p_source_teacher_id or occurrence ->> 'studentId' is distinct from p_student_id or occurrence ->> 'status' in ('cancelled', 'leave') or (occurrence ->> 'date')::date not between target_start and target_end then continue; end if;
      sort_key := (occurrence ->> 'date') || chr(31) || (occurrence ->> 'start') || chr(31) || occurrence_id;
      if last_sort_key is null or sort_key > last_sort_key then last_sort_key := sort_key; last_occurrence := occurrence; end if;
    end loop;
  end loop;
  if last_occurrence is null then return null; end if;
  return to_char(((last_occurrence ->> 'endsAt')::timestamptz at time zone 'Australia/Melbourne')::date + 1, 'YYYY-MM-DD');
end;
$$;
revoke all on function internal.teacher_absence_historical_due_date(jsonb, text, text, text) from public, anon, authenticated, service_role;

create or replace function public.get_teacher_absence_creation_command_result(p_secret text, p_command_key text, p_command_intent jsonb, p_actor text)
returns table(command_key text, source_teacher_id text, event_start text, event_end text, operation_ids jsonb, affected_student_ids jsonb, audit_entry_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare prior internal.teacher_absence_creation_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if coalesce(p_command_key, '') !~ '^teacher-absence-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' or jsonb_typeof(p_command_intent) is distinct from 'object' or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then raise exception using errcode = '22023', message = 'invalid_teacher_absence_replay_lookup'; end if;
  select * into prior from internal.teacher_absence_creation_commands where command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then raise exception using errcode = '23505', message = 'teacher_absence_creation_idempotency_conflict'; end if;
  return query select prior.command_key, prior.source_teacher_id, to_char(prior.event_start, 'YYYY-MM-DD'), to_char(prior.event_end, 'YYYY-MM-DD'), prior.operation_ids, prior.affected_student_ids, prior.audit_id;
end;
$$;
revoke all on function public.get_teacher_absence_creation_command_result(text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.get_teacher_absence_creation_command_result(text, text, jsonb, text) to anon, authenticated;

-- Re-check structured AVA from the locked teacher snapshot.  This mirrors one
-- expandTeacherAvailability call over the complete affected instant range,
-- including JS Sunday=0, each window's timezone, DST disambiguation,
-- exclusions/overrides, cross-midnight windows and overlap rejection.
create or replace function internal.teacher_absence_candidate_ranges(p_teacher jsonb, p_target_start timestamptz, p_target_end timestamptz)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare window_item jsonb; override_item jsonb; source_date date; valid_from date; valid_to date; local_start_date date; local_end_date date; range_from date; range_to date; window_start text; window_end text; end_date date; ava_start timestamptz; ava_end timestamptz; day_value integer; ava_ranges jsonb := '[]'::jsonb;
begin
  if p_target_start is null or p_target_end is null or p_target_end <= p_target_start or jsonb_typeof(p_teacher -> 'availabilityWindows') is distinct from 'array' then return null; end if;
  if exists (select 1 from jsonb_array_elements(p_teacher -> 'availabilityWindows') item(value) where jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(value -> 'id') is distinct from 'string' or nullif(trim(value ->> 'id'), '') is null) then return null; end if;
  if exists (select 1 from jsonb_array_elements(p_teacher -> 'availabilityWindows') parent(value) cross join lateral jsonb_array_elements(case when jsonb_typeof(parent.value -> 'overrides') = 'array' then parent.value -> 'overrides' else '[]'::jsonb end) moved(value) where jsonb_typeof(moved.value) is distinct from 'object' or jsonb_typeof(moved.value -> 'id') is distinct from 'string' or nullif(trim(moved.value ->> 'id'), '') is null) then return null; end if;
  if exists (
    select 1 from (
      select value ->> 'id' as id from jsonb_array_elements(p_teacher -> 'availabilityWindows')
      union all
      select moved.value ->> 'id' from jsonb_array_elements(p_teacher -> 'availabilityWindows') parent(value)
      cross join lateral jsonb_array_elements(case when jsonb_typeof(parent.value -> 'overrides') = 'array' then parent.value -> 'overrides' else '[]'::jsonb end) moved(value)
    ) ids group by id having count(*) > 1
  ) then return null; end if;
  for window_item in select value from jsonb_array_elements(p_teacher -> 'availabilityWindows') loop
    if jsonb_typeof(window_item -> 'teacherId') is distinct from 'string' or window_item ->> 'teacherId' is distinct from p_teacher ->> 'id'
       or jsonb_typeof(window_item -> 'day') is distinct from 'number' or coalesce(window_item ->> 'day', '') !~ '^[0-6]$'
       or jsonb_typeof(window_item -> 'start') is distinct from 'string' or coalesce(window_item ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or jsonb_typeof(window_item -> 'end') is distinct from 'string' or coalesce(window_item ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or window_item ->> 'start' = window_item ->> 'end'
       or jsonb_typeof(window_item -> 'timezone') is distinct from 'string' or nullif(trim(window_item ->> 'timezone'), '') is null
       or jsonb_typeof(window_item -> 'validFrom') is distinct from 'string' or coalesce(window_item ->> 'validFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(window_item -> 'validTo') is distinct from 'string' or coalesce(window_item ->> 'validTo', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(window_item -> 'excludedDates') is distinct from 'array' or jsonb_typeof(window_item -> 'overrides') is distinct from 'array' then return null; end if;
    begin
      valid_from := (window_item ->> 'validFrom')::date; valid_to := (window_item ->> 'validTo')::date; day_value := (window_item ->> 'day')::integer;
      local_start_date := (p_target_start at time zone (window_item ->> 'timezone'))::date;
      local_end_date := (p_target_end at time zone (window_item ->> 'timezone'))::date;
    exception when others then return null; end;
    if valid_to < valid_from or valid_to - valid_from > 370 then return null; end if;
    if range_from is null or least(local_start_date, local_end_date) < range_from then range_from := least(local_start_date, local_end_date); end if;
    if range_to is null or greatest(local_start_date, local_end_date) > range_to then range_to := greatest(local_start_date, local_end_date); end if;
    if exists (select 1 from jsonb_array_elements(window_item -> 'excludedDates') excluded(value) where jsonb_typeof(value) is distinct from 'string') then return null; end if;
    if exists (select 1 from jsonb_array_elements_text(window_item -> 'excludedDates') excluded(value) group by value having count(*) > 1) then return null; end if;
    if exists (select 1 from jsonb_array_elements(window_item -> 'overrides') moved(value) group by value ->> 'date' having count(*) > 1) then return null; end if;
    begin
      if exists (select 1 from jsonb_array_elements_text(window_item -> 'excludedDates') excluded(value) where value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or value::date not between valid_from and valid_to or extract(dow from value::date)::integer <> day_value) then return null; end if;
      if exists (select 1 from jsonb_array_elements(window_item -> 'overrides') moved(value) where jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(value -> 'date') is distinct from 'string' or coalesce(value ->> 'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (value ->> 'date')::date not between valid_from and valid_to or extract(dow from (value ->> 'date')::date)::integer <> day_value or jsonb_typeof(value -> 'start') is distinct from 'string' or coalesce(value ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or jsonb_typeof(value -> 'end') is distinct from 'string' or coalesce(value ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or value ->> 'start' = value ->> 'end' or (window_item -> 'excludedDates') @> jsonb_build_array(value ->> 'date')) then return null; end if;
    exception when others then return null; end;
  end loop;
  if range_from is null then return '[]'::jsonb; end if;
  range_from := range_from - 1; range_to := range_to + 1;
  for window_item in select value from jsonb_array_elements(p_teacher -> 'availabilityWindows') loop
    valid_from := (window_item ->> 'validFrom')::date; valid_to := (window_item ->> 'validTo')::date; day_value := (window_item ->> 'day')::integer;
    source_date := greatest(valid_from, range_from);
    while source_date <= least(valid_to, range_to) loop
      if extract(dow from source_date)::integer = day_value and not (window_item -> 'excludedDates') @> jsonb_build_array(to_char(source_date, 'YYYY-MM-DD')) then
        select value into override_item from jsonb_array_elements(window_item -> 'overrides') item(value) where value ->> 'date' = to_char(source_date, 'YYYY-MM-DD') limit 1;
        window_start := coalesce(override_item ->> 'start', window_item ->> 'start'); window_end := coalesce(override_item ->> 'end', window_item ->> 'end');
        end_date := case when window_end < window_start then source_date + 1 else source_date end;
        ava_start := internal.teacher_absence_ava_instant(source_date, window_start, window_item ->> 'timezone', false);
        ava_end := internal.teacher_absence_ava_instant(end_date, window_end, window_item ->> 'timezone', true);
        if ava_start is null or ava_end is null or ava_end <= ava_start then return null; end if;
        ava_ranges := ava_ranges || jsonb_build_array(jsonb_build_object('startsAt', ava_start, 'endsAt', ava_end));
      end if;
      source_date := source_date + 1;
    end loop;
  end loop;
  if exists (select 1 from jsonb_array_elements(ava_ranges) with ordinality first_range(value, position), jsonb_array_elements(ava_ranges) with ordinality second_range(value, position) where first_range.position < second_range.position and (first_range.value ->> 'startsAt')::timestamptz < (second_range.value ->> 'endsAt')::timestamptz and (second_range.value ->> 'startsAt')::timestamptz < (first_range.value ->> 'endsAt')::timestamptz) then return null; end if;
  return ava_ranges;
end;
$$;
revoke all on function internal.teacher_absence_candidate_ranges(jsonb, timestamptz, timestamptz) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_candidate_available(p_teacher jsonb, p_occurrence jsonb)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare target_start timestamptz; target_end timestamptz; ava_ranges jsonb;
begin
  begin target_start := (p_occurrence ->> 'startsAt')::timestamptz; target_end := (p_occurrence ->> 'endsAt')::timestamptz; exception when others then return false; end;
  ava_ranges := internal.teacher_absence_candidate_ranges(p_teacher, target_start, target_end);
  if ava_ranges is null then return false; end if;
  return exists (select 1 from jsonb_array_elements(ava_ranges) item(value) where (value ->> 'startsAt')::timestamptz <= target_start and (value ->> 'endsAt')::timestamptz >= target_end);
end;
$$;
revoke all on function internal.teacher_absence_candidate_available(jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_group_bounds(p_bookings jsonb, p_group jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare occurrence_id text; series_id text; booking jsonb; occurrence jsonb; first_date date; last_date date;
begin
  for occurrence_id in select value from jsonb_array_elements_text(p_group -> 'affectedOccurrenceIds') loop
    series_id := left(occurrence_id, length(occurrence_id) - 11);
    select value into booking from jsonb_array_elements(p_bookings) item(value) where value ->> 'id' = series_id limit 1;
    occurrence := internal.teacher_absence_resolve_occurrence(booking, occurrence_id);
    if occurrence is null then return null; end if;
    if first_date is null or (occurrence ->> 'date')::date < first_date then first_date := (occurrence ->> 'date')::date; end if;
    if last_date is null or (occurrence ->> 'date')::date > last_date then last_date := (occurrence ->> 'date')::date; end if;
  end loop;
  if first_date is null then return null; end if;
  return jsonb_build_object('start', to_char(first_date, 'YYYY-MM-DD'), 'end', to_char(last_date, 'YYYY-MM-DD'));
end;
$$;
revoke all on function internal.teacher_absence_group_bounds(jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_existing_relationship(p_bookings jsonb, p_teacher_id text, p_student_id text, p_group jsonb)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare target_occurrence_id text; target_series_id text; target_booking jsonb; target_occurrence jsonb; target_min timestamptz; target_max timestamptz; booking_timezone text; target_start date; target_end date; booking jsonb; occurrence jsonb; base_date date; range_end date; repeats integer; interval_days integer; i integer; occurrence_id text;
begin
  for booking in select value from jsonb_array_elements(p_bookings) loop
    -- Temporary cover lessons do not establish the lasting relationship used
    -- for new-student capacity exemptions. They remain real conflicts below.
    if booking ->> 'kind' = '代课' then continue; end if;
    begin base_date := (booking ->> 'date')::date; exception when others then return false; end;
    booking_timezone := case when jsonb_typeof(booking -> 'timezone') = 'string' then nullif(trim(booking ->> 'timezone'), '') end;
    if booking_timezone is null then return false; end if;
    target_min := null; target_max := null;
    for target_occurrence_id in select value from jsonb_array_elements_text(p_group -> 'affectedOccurrenceIds') loop
      target_series_id := left(target_occurrence_id, length(target_occurrence_id) - 11);
      select value into target_booking from jsonb_array_elements(p_bookings) item(value) where value ->> 'id' = target_series_id limit 1;
      target_occurrence := internal.teacher_absence_resolve_occurrence(target_booking, target_occurrence_id);
      if target_occurrence is null then return false; end if;
      if target_min is null or (target_occurrence ->> 'startsAt')::timestamptz < target_min then target_min := (target_occurrence ->> 'startsAt')::timestamptz; end if;
      if target_max is null or (target_occurrence ->> 'endsAt')::timestamptz > target_max then target_max := (target_occurrence ->> 'endsAt')::timestamptz; end if;
    end loop;
    if target_min is null then return false; end if;
    begin target_start := (target_min at time zone booking_timezone)::date - 1; target_end := (target_max at time zone booking_timezone)::date + 1; exception when others then return false; end;
    range_end := internal.teacher_absence_source_range_end(booking, target_start, target_end);
    repeats := internal.teacher_absence_occurrence_count(booking, range_end);
    interval_days := internal.teacher_absence_recurrence_interval(booking);
    if repeats < 1 then continue; end if;
    for i in 0..repeats - 1 loop
      occurrence_id := coalesce(booking ->> 'id', '') || ':' || to_char(base_date + i * case when interval_days = 0 then 0 else interval_days end, 'YYYY-MM-DD'); occurrence := internal.teacher_absence_resolve_occurrence(booking, occurrence_id);
      if occurrence is not null and occurrence ->> 'teacherId' = p_teacher_id and occurrence ->> 'studentId' = p_student_id and occurrence ->> 'status' not in ('cancelled', 'leave') and (occurrence ->> 'date')::date between target_start and target_end then return true; end if;
    end loop;
  end loop;
  return false;
end;
$$;
revoke all on function internal.teacher_absence_existing_relationship(jsonb, text, text, jsonb) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_candidate_eligible(p_bookings jsonb, p_teacher jsonb, p_group jsonb)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare target_start date; target_end date; target_id text; target_series_id text; target_booking jsonb; target_occurrence jsonb; target_occurrences jsonb := '[]'::jsonb; ava_ranges jsonb; existing_booking jsonb; existing_occurrence jsonb; base_date date; range_end date; repeats integer; interval_days integer; i integer; existing_id text; target_starts_at timestamptz; target_ends_at timestamptz; existing_starts_at timestamptz; existing_ends_at timestamptz; target_min timestamptz; target_max timestamptz; existing_timezone text;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array' or jsonb_typeof(p_teacher -> 'availabilityWindows') is distinct from 'array' then return false; end if;
  for target_id in select value from jsonb_array_elements_text(p_group -> 'affectedOccurrenceIds') loop
    target_series_id := left(target_id, length(target_id) - 11);
    select value into target_booking from jsonb_array_elements(p_bookings) item(value) where value ->> 'id' = target_series_id limit 1;
    target_occurrence := internal.teacher_absence_resolve_occurrence(target_booking, target_id);
    if target_occurrence is null then return false; end if;
    target_occurrences := target_occurrences || jsonb_build_array(target_occurrence);
    if target_min is null or (target_occurrence ->> 'startsAt')::timestamptz < target_min then target_min := (target_occurrence ->> 'startsAt')::timestamptz; end if;
    if target_max is null or (target_occurrence ->> 'endsAt')::timestamptz > target_max then target_max := (target_occurrence ->> 'endsAt')::timestamptz; end if;
  end loop;
  if target_min is null then return false; end if;
  ava_ranges := internal.teacher_absence_candidate_ranges(p_teacher, target_min, target_max);
  if ava_ranges is null or exists (
    select 1 from jsonb_array_elements(target_occurrences) target(value)
    where not exists (
      select 1 from jsonb_array_elements(ava_ranges) ava(value)
      where (ava.value ->> 'startsAt')::timestamptz <= (target.value ->> 'startsAt')::timestamptz
        and (ava.value ->> 'endsAt')::timestamptz >= (target.value ->> 'endsAt')::timestamptz
    )
  ) then return false; end if;
  for existing_booking in select value from jsonb_array_elements(p_bookings) loop
    begin base_date := (existing_booking ->> 'date')::date; exception when others then return false; end;
    existing_timezone := case when jsonb_typeof(existing_booking -> 'timezone') = 'string' then nullif(trim(existing_booking ->> 'timezone'), '') end;
    if existing_timezone is null then return false; end if;
    begin target_start := (target_min at time zone existing_timezone)::date - 1; target_end := (target_max at time zone existing_timezone)::date + 1; exception when others then return false; end;
    range_end := internal.teacher_absence_source_range_end(existing_booking, target_start, target_end);
    repeats := internal.teacher_absence_occurrence_count(existing_booking, range_end);
    interval_days := internal.teacher_absence_recurrence_interval(existing_booking);
    if repeats < 1 then continue; end if;
    for i in 0..repeats - 1 loop
      existing_id := coalesce(existing_booking ->> 'id', '') || ':' || to_char(base_date + i * case when interval_days = 0 then 0 else interval_days end, 'YYYY-MM-DD'); existing_occurrence := internal.teacher_absence_resolve_occurrence(existing_booking, existing_id);
      if existing_occurrence is null or existing_occurrence ->> 'teacherId' is distinct from p_teacher ->> 'id' or existing_occurrence ->> 'status' in ('cancelled', 'leave') or (existing_occurrence ->> 'date')::date not between target_start and target_end then continue; end if;
      existing_starts_at := (existing_occurrence ->> 'startsAt')::timestamptz; existing_ends_at := (existing_occurrence ->> 'endsAt')::timestamptz;
      for target_id in select value from jsonb_array_elements_text(p_group -> 'affectedOccurrenceIds') loop
        target_series_id := left(target_id, length(target_id) - 11); select value into target_booking from jsonb_array_elements(p_bookings) item(value) where value ->> 'id' = target_series_id limit 1; target_occurrence := internal.teacher_absence_resolve_occurrence(target_booking, target_id);
        target_starts_at := (target_occurrence ->> 'startsAt')::timestamptz; target_ends_at := (target_occurrence ->> 'endsAt')::timestamptz;
        if target_starts_at < existing_ends_at and existing_starts_at < target_ends_at then return false; end if;
      end loop;
    end loop;
  end loop;
  return true;
end;
$$;
revoke all on function internal.teacher_absence_candidate_eligible(jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function internal.teacher_absence_candidate_ids(p_bookings jsonb, p_teachers jsonb, p_source_teacher_id text, p_group jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare teacher_item jsonb; candidate_ids jsonb := '[]'::jsonb; teacher_id text; student_id text; subjects jsonb; assignments jsonb; existing_relationship boolean;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array' or jsonb_typeof(p_teachers) is distinct from 'array' then return '[]'::jsonb; end if;
  student_id := p_group ->> 'studentId'; subjects := coalesce(p_group -> 'subjects', '[]'::jsonb);
  for teacher_item in select value from jsonb_array_elements(p_teachers) loop
    teacher_id := case when jsonb_typeof(teacher_item -> 'id') = 'string' then nullif(trim(teacher_item ->> 'id'), '') end; assignments := case when jsonb_typeof(teacher_item -> 'capacityAssignments') = 'array' then teacher_item -> 'capacityAssignments' else '[]'::jsonb end;
    existing_relationship := internal.teacher_absence_existing_relationship(p_bookings, teacher_id, student_id, p_group);
    if teacher_id is null or teacher_id = p_source_teacher_id or jsonb_typeof(teacher_item -> 'subjects') is distinct from 'array' or jsonb_typeof(teacher_item -> 'availabilityWindows') is distinct from 'array' or jsonb_array_length(teacher_item -> 'availabilityWindows') = 0
       or exists (select 1 from jsonb_array_elements_text(subjects) subject(value) where not (teacher_item -> 'subjects') @> jsonb_build_array(subject.value))
       or (not existing_relationship and not assignments @> jsonb_build_array(student_id) and (jsonb_typeof(teacher_item -> 'acceptsStudents') is distinct from 'boolean' or (teacher_item ->> 'acceptsStudents') is distinct from 'true' or jsonb_typeof(teacher_item -> 'newStudentCapacity') is distinct from 'number' or coalesce(teacher_item ->> 'newStudentCapacity', '') !~ '^[1-9][0-9]*$' or (teacher_item ->> 'newStudentCapacity')::numeric > 9007199254740991))
       or not internal.teacher_absence_candidate_eligible(p_bookings, teacher_item, p_group) then continue; end if;
    candidate_ids := candidate_ids || jsonb_build_array(teacher_id);
  end loop;
  return coalesce((select jsonb_agg(item.value order by item.value #>> '{}' collate "C") from jsonb_array_elements(candidate_ids) item), '[]'::jsonb);
end;
$$;
revoke all on function internal.teacher_absence_candidate_ids(jsonb, jsonb, text, jsonb) from public, anon, authenticated, service_role;

create or replace function public.create_teacher_absence_atomic(
  p_secret text, p_command_key text, p_command_intent jsonb, p_source_teacher_id text,
  p_event_start text, p_event_end text, p_type text, p_detail text,
  p_expected_versions jsonb, p_operations jsonb, p_tasks jsonb, p_affected_groups jsonb,
  p_submitted_at text, p_actor text
) returns table(command_key text, applied boolean, source_teacher_id text, event_start text, event_end text, operation_ids jsonb, affected_student_ids jsonb, affected_occurrence_count integer, generated_task_count integer, operations_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare b public.ops_state%rowtype; o public.ops_state%rowtype; s public.ops_state%rowtype; t public.ops_state%rowtype; h public.ops_state%rowtype; so public.ops_state%rowtype; st public.ops_state%rowtype;
  prior internal.teacher_absence_creation_commands%rowtype; expected jsonb; supplied jsonb; generated_ops jsonb := '[]'::jsonb; generated_tasks jsonb := '[]'::jsonb; expected_task jsonb; op_ids jsonb := '[]'::jsonb; student_ids jsonb := '[]'::jsonb; item jsonb; student_item jsonb; teacher_item jsonb; candidate_id text; operation_id text; student_id text; payload_hash text; audit_id uuid; submitted_at_value timestamptz; rule text; expected_task_id text; task_owner text; expected_owner text; expected_title text; expected_trigger text; expected_due_date text; expected_due_at text; expected_offset integer; expected_status text; expected_tone text; historical_due_date text;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if coalesce(p_command_key, '') !~ '^teacher-absence-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     or coalesce(p_source_teacher_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or p_type not in ('老师请假', '请假', '代课')
     or nullif(trim(p_detail), '') is null or length(trim(p_detail)) > 2000
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent is distinct from jsonb_build_object('sourceTeacherId', trim(p_source_teacher_id), 'eventStart', p_event_start, 'eventEnd', p_event_end, 'type', p_type, 'detail', trim(p_detail))
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or not p_expected_versions ?& array['bookings','operations','students','tasks','teachers']
     or exists (select 1 from jsonb_each(case when jsonb_typeof(p_expected_versions) = 'object' then p_expected_versions else '{}'::jsonb end) version_item(key, value) where key not in ('bookings','operations','students','tasks','teachers') or jsonb_typeof(value) is distinct from 'number' or value #>> '{}' !~ '^[1-9][0-9]*$' or (value #>> '{}')::numeric > 9007199254740991)
     or jsonb_typeof(p_operations) is distinct from 'array' or jsonb_typeof(p_tasks) is distinct from 'array'
     or jsonb_typeof(p_affected_groups) is distinct from 'array' or p_event_start !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_event_end !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_event_start > p_event_end or coalesce(p_submitted_at, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then raise exception using errcode = '22023', message = 'invalid_teacher_absence_creation_request'; end if;
  begin submitted_at_value := p_submitted_at::timestamptz; exception when others then raise exception using errcode = '22023', message = 'invalid_teacher_absence_submitted_at'; end;
  if submitted_at_value < clock_timestamp() - interval '15 minutes' or submitted_at_value > clock_timestamp() + interval '2 minutes' then raise exception using errcode = '22023', message = 'invalid_teacher_absence_submitted_at'; end if;
  -- Same global five-entity order as teacher departure creation prevents a
  -- leave/departure pair from deadlocking: bookings -> operations -> students
  -- -> tasks -> teachers.
  select * into b from public.ops_state s where s.entity = 'bookings' for update; select * into o from public.ops_state s where s.entity = 'operations' for update; select * into s from public.ops_state s where s.entity = 'students' for update; select * into t from public.ops_state s where s.entity = 'tasks' for update; select * into h from public.ops_state s where s.entity = 'teachers' for update;
  if b.entity is null or o.entity is null or s.entity is null or t.entity is null or h.entity is null then raise exception using errcode = '55000', message = 'teacher_absence_creation_state_missing'; end if;
  if (select count(*) from jsonb_array_elements(h.payload) teacher(value) where jsonb_typeof(value -> 'id') = 'string' and value ->> 'id' = p_source_teacher_id) <> 1 then raise exception using errcode = '22023', message = 'teacher_absence_source_teacher_not_found'; end if;
  select * into prior from internal.teacher_absence_creation_commands where command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then raise exception using errcode = '23505', message = 'teacher_absence_creation_idempotency_conflict'; end if;
    return query select prior.command_key, false, prior.source_teacher_id, to_char(prior.event_start, 'YYYY-MM-DD'), to_char(prior.event_end, 'YYYY-MM-DD'), prior.operation_ids, prior.affected_student_ids, 0, 0, o, t, prior.audit_id; return;
  end if;
  if b.version <> (p_expected_versions ->> 'bookings')::bigint or o.version <> (p_expected_versions ->> 'operations')::bigint or s.version <> (p_expected_versions ->> 'students')::bigint or t.version <> (p_expected_versions ->> 'tasks')::bigint or h.version <> (p_expected_versions ->> 'teachers')::bigint then raise exception using errcode = '40001', message = 'version_conflict'; end if;
  if exists (select 1 from jsonb_array_elements(o.payload) item(value) where value ->> 'type' in ('老师请假', '请假', '代课') and value ->> 'teacherId' = p_source_teacher_id and value ->> 'eventStart' = p_event_start and value ->> 'eventEnd' = p_event_end and coalesce(value ->> 'status', '') not in ('已取消', 'closed', 'done')) then raise exception using errcode = '40001', message = 'teacher_absence_workflow_already_exists'; end if;
  expected := internal.teacher_absence_creation_projection(b.payload, p_source_teacher_id, p_event_start, p_event_end);
  if jsonb_array_length(expected) = 0 then raise exception using errcode = '22023', message = 'teacher_absence_occurrence_not_found'; end if;
  supplied := coalesce((select jsonb_agg(jsonb_build_object('studentId', value ->> 'studentId', 'affectedOccurrenceIds', value -> 'affectedOccurrenceIds', 'subjects', value -> 'subjects', 'firstAffectedAt', value ->> 'firstAffectedAt') order by value ->> 'studentId' collate "C") from jsonb_array_elements(p_affected_groups) item(value)), '[]'::jsonb);
  if supplied is distinct from expected then raise exception using errcode = '22023', message = 'teacher_absence_occurrence_closure_mismatch'; end if;
  for item in select value from jsonb_array_elements(p_affected_groups) order by value ->> 'studentId' collate "C" loop
    student_id := item ->> 'studentId'; operation_id := 'OPS-ABSENCE-' || left(encode(extensions.digest(p_command_key || chr(31) || student_id, 'sha256'), 'hex'), 24);
    if item ->> 'operationId' is distinct from operation_id or coalesce(item ->> 'firstAffectedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' or jsonb_typeof(item -> 'candidateTeacherIds') is distinct from 'array' then raise exception using errcode = '22023', message = 'teacher_absence_operation_identity_mismatch'; end if;
    select value into student_item from jsonb_array_elements(s.payload) where jsonb_typeof(value -> 'id') = 'string' and value ->> 'id' = student_id limit 1;
    if student_item is null then raise exception using errcode = '22023', message = 'teacher_absence_student_not_found'; end if;
    if item -> 'candidateTeacherIds' is distinct from internal.teacher_absence_candidate_ids(b.payload, h.payload, p_source_teacher_id, item) then raise exception using errcode = '22023', message = 'teacher_absence_candidate_set_mismatch'; end if;
    for teacher_item in select value from jsonb_array_elements(item -> 'candidateTeacherIds') loop
      candidate_id := teacher_item #>> '{}';
      select value into teacher_item from jsonb_array_elements(h.payload) where jsonb_typeof(value -> 'id') = 'string' and value ->> 'id' = candidate_id limit 1;
      if teacher_item is null or teacher_item ->> 'id' = p_source_teacher_id or jsonb_typeof(teacher_item -> 'subjects') is distinct from 'array' or jsonb_typeof(teacher_item -> 'availabilityWindows') is distinct from 'array' or jsonb_array_length(teacher_item -> 'availabilityWindows') = 0 or exists (select 1 from jsonb_array_elements(teacher_item -> 'availabilityWindows') availability(value) where value ->> 'teacherId' is distinct from teacher_item ->> 'id' or nullif(trim(value ->> 'start'), '') is null or nullif(trim(value ->> 'end'), '') is null) or exists (select 1 from jsonb_array_elements_text(item -> 'subjects') subject(value) where not (teacher_item -> 'subjects') @> jsonb_build_array(subject.value)) or not internal.teacher_absence_candidate_eligible(b.payload, teacher_item, item) then raise exception using errcode = '22023', message = 'teacher_absence_candidate_identity_mismatch'; end if;
    end loop;
    generated_ops := generated_ops || jsonb_build_array(jsonb_build_object('id', operation_id, 'studentId', student_id, 'type', p_type, 'detail', trim(p_detail), 'status', '待处理', 'createdAt', p_submitted_at, 'teacherId', p_source_teacher_id, 'eventStart', p_event_start, 'eventEnd', p_event_end, 'firstAffectedAt', item ->> 'firstAffectedAt', 'affectedLessonCount', jsonb_array_length(item -> 'affectedOccurrenceIds'), 'affectedOccurrenceIds', item -> 'affectedOccurrenceIds', 'subjectIds', item -> 'subjects', 'recommendedTeacherIds', coalesce(item -> 'candidateTeacherIds', '[]'::jsonb), 'creationCommandKey', p_command_key));
    op_ids := op_ids || jsonb_build_array(operation_id); student_ids := student_ids || jsonb_build_array(student_id);
  end loop;
  if p_operations is distinct from (generated_ops || o.payload) then raise exception using errcode = '22023', message = 'teacher_absence_payload_mismatch'; end if;
  for item in select value from jsonb_array_elements(p_affected_groups) order by value ->> 'studentId' collate "C" loop
    operation_id := item ->> 'operationId'; student_id := item ->> 'studentId';
    select value into student_item from jsonb_array_elements(s.payload) where jsonb_typeof(value -> 'id') = 'string' and value ->> 'id' = student_id limit 1;
    historical_due_date := internal.teacher_absence_historical_due_date(b.payload, p_source_teacher_id, student_id, p_event_start);
    for rule in select unnest(array['candidate', 'candidate-confirm', 'parent-contact']) loop
      expected_task_id := 'TSK-ABSENCE-' || left(encode(extensions.digest(p_command_key || chr(31) || student_id || chr(31) || rule, 'sha256'), 'hex'), 24);
      expected_offset := -14;
      expected_title := case rule when 'candidate' then '选择可代课老师' when 'candidate-confirm' then '确认最终推荐老师并交龙老师确认' else '完成家长沟通并记录请假/代课原因' end;
      expected_trigger := case rule when 'candidate' then '老师请假：候选代课老师筛选' when 'candidate-confirm' then '老师请假：最终推荐确认' else '老师请假：教务必须写明原因' end;
      expected_owner := case when rule = 'candidate' then 'Tiffany' when rule = 'candidate-confirm' then '思佳' else coalesce(case when jsonb_typeof(student_item -> 'owner') = 'string' then nullif(trim(student_item ->> 'owner'), '') end, '待分配') end;
      expected_due_date := to_char(p_event_start::date + expected_offset, 'YYYY-MM-DD') || ' 18:00';
      expected_due_at := to_char((((p_event_start::date + expected_offset)::timestamp + time '18:00') at time zone 'Australia/Melbourne') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      expected_status := case when (p_event_start::date + expected_offset) < (submitted_at_value at time zone 'Australia/Melbourne')::date then 'overdue' when (p_event_start::date + expected_offset) = (submitted_at_value at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end;
      expected_tone := case when expected_status = 'overdue' then 'red' when expected_status = 'today' then 'amber' else case when rule in ('candidate', 'parent-contact') then 'red' else 'amber' end end;
      expected_task := jsonb_build_object('id', expected_task_id, 'title', expected_title, 'owner', expected_owner, 'assignees', jsonb_build_array(expected_owner), 'watchers', jsonb_build_array('Ops Admin'), 'studentId', student_id, 'due', expected_due_date, 'dueAt', expected_due_at, 'status', expected_status, 'tone', expected_tone, 'category', '请假代课', 'trigger', expected_trigger, 'ruleKey', 'teacher-absence:' || operation_id || ':' || rule, 'anchorBookingId', operation_id);
      generated_tasks := generated_tasks || jsonb_build_array(expected_task);
    end loop;
    if historical_due_date is not null then
      select coalesce(case when jsonb_typeof(value -> 'name') = 'string' then nullif(trim(value ->> 'name'), '') end, p_source_teacher_id) into task_owner from jsonb_array_elements(h.payload) where jsonb_typeof(value -> 'id') = 'string' and value ->> 'id' = p_source_teacher_id limit 1;
      expected_task_id := 'TSK-ABSENCE-' || left(encode(extensions.digest(p_command_key || chr(31) || student_id || chr(31) || 'lp-handover', 'sha256'), 'hex'), 24);
      expected_due_date := historical_due_date || ' 18:00';
      expected_due_at := to_char(((historical_due_date::date::timestamp + time '18:00') at time zone 'Australia/Melbourne') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      expected_status := case when historical_due_date < (submitted_at_value at time zone 'Australia/Melbourne')::date::text then 'overdue' when historical_due_date = (submitted_at_value at time zone 'Australia/Melbourne')::date::text then 'today' else 'upcoming' end;
      expected_tone := case when expected_status = 'overdue' then 'red' when expected_status = 'today' then 'amber' else 'blue' end;
      expected_task := jsonb_build_object('id', expected_task_id, 'title', '请原老师补充代课 LP 指定内容与资料', 'owner', task_owner, 'assignees', jsonb_build_array(task_owner), 'watchers', jsonb_build_array('Ops Admin'), 'studentId', student_id, 'due', expected_due_date, 'dueAt', expected_due_at, 'status', expected_status, 'tone', expected_tone, 'category', '请假代课', 'trigger', '老师请假：代课 LP 交接', 'ruleKey', 'teacher-absence:' || operation_id || ':lp-handover', 'anchorBookingId', operation_id);
      generated_tasks := generated_tasks || jsonb_build_array(expected_task);
    end if;
    rule := 'cover-prep'; expected_owner := coalesce(case when jsonb_typeof(student_item -> 'owner') = 'string' then nullif(trim(student_item ->> 'owner'), '') end, '待分配'); expected_task_id := 'TSK-ABSENCE-' || left(encode(extensions.digest(p_command_key || chr(31) || student_id || chr(31) || rule, 'sha256'), 'hex'), 24);
    expected_due_date := to_char(p_event_start::date - 7, 'YYYY-MM-DD') || ' 18:00'; expected_due_at := to_char((((p_event_start::date - 7)::timestamp + time '18:00') at time zone 'Australia/Melbourne') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    expected_status := case when p_event_start::date - 7 < (submitted_at_value at time zone 'Australia/Melbourne')::date then 'overdue' when p_event_start::date - 7 = (submitted_at_value at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end; expected_tone := case when expected_status = 'overdue' then 'red' when expected_status = 'today' then 'amber' else 'amber' end;
    expected_task := jsonb_build_object('id', expected_task_id, 'title', '确认代课老师已完成备课', 'owner', expected_owner, 'assignees', jsonb_build_array(expected_owner), 'watchers', jsonb_build_array('Ops Admin'), 'studentId', student_id, 'due', expected_due_date, 'dueAt', expected_due_at, 'status', expected_status, 'tone', expected_tone, 'category', '请假代课', 'trigger', '老师请假：代课老师一周备课', 'ruleKey', 'teacher-absence:' || operation_id || ':' || rule, 'anchorBookingId', operation_id);
    generated_tasks := generated_tasks || jsonb_build_array(expected_task);
  end loop;
  if p_tasks is distinct from (generated_tasks || t.payload) then raise exception using errcode = '22023', message = 'teacher_absence_task_payload_mismatch'; end if;
  update public.ops_state set payload = p_operations, version = o.version + 1, updated_at = now(), updated_by = trim(p_actor) where entity = 'operations' returning * into so;
  insert into public.ops_mutation_log(entity, version, actor) values ('operations', so.version, so.updated_by);
  update public.ops_state set payload = p_tasks, version = t.version + 1, updated_at = now(), updated_by = trim(p_actor) where entity = 'tasks' returning * into st;
  insert into public.ops_mutation_log(entity, version, actor) values ('tasks', st.version, st.updated_by);
  payload_hash := encode(extensions.digest(jsonb_build_object('commandIntent', p_command_intent, 'expectedVersions', p_expected_versions, 'operations', p_operations, 'tasks', p_tasks, 'affectedGroups', p_affected_groups)::text, 'sha256'), 'hex');
  audit_id := internal.append_operational_contract_audit('operation.teacher_absence_create', trim(p_actor), 'teacher', p_source_teacher_id, jsonb_build_object('commandKey', p_command_key, 'eventStart', p_event_start, 'eventEnd', p_event_end, 'operationIds', op_ids, 'affectedStudentIds', student_ids, 'versionsBefore', p_expected_versions, 'payloadSha256', payload_hash));
  insert into internal.teacher_absence_creation_commands(command_key, command_intent, command_hash, source_teacher_id, event_start, event_end, operation_ids, affected_student_ids, affected_groups, booking_version, operation_version, student_version, task_version, teacher_version, actor, audit_id) values (p_command_key, p_command_intent, payload_hash, p_source_teacher_id, p_event_start::date, p_event_end::date, op_ids, student_ids, p_affected_groups, b.version, so.version, s.version, st.version, h.version, trim(p_actor), audit_id);
  return query select p_command_key, true, p_source_teacher_id, p_event_start, p_event_end, op_ids, student_ids, (select sum(jsonb_array_length(value -> 'affectedOccurrenceIds'))::integer from jsonb_array_elements(p_affected_groups)), jsonb_array_length(generated_tasks), so, st, audit_id;
end;
$$;
revoke all on function public.create_teacher_absence_atomic(text,text,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text) from public, anon, authenticated, service_role;
grant execute on function public.create_teacher_absence_atomic(text,text,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text) to anon, authenticated;

do $$
declare projected jsonb; resolved jsonb; target_booking jsonb; target_occurrence jsonb; candidate_teacher jsonb; candidate_group jsonb; conflict_bookings jsonb; historical_due text;
begin
  projected := internal.teacher_absence_creation_projection('[{"id":"B-ABS","studentId":"S-1","teacherId":"T-1","date":"2026-09-01","start":"17:00","duration":60,"timezone":"Australia/Melbourne","recurring":true,"repeatCount":2,"kind":"常规课","teacherSubjectId":"Maths"}]'::jsonb, 'T-1', '2026-09-01', '2026-09-08');
  if jsonb_array_length(projected) <> 1 or projected #>> '{0,studentId}' <> 'S-1' or jsonb_array_length(projected #> '{0,affectedOccurrenceIds}') <> 2 then raise exception 'teacher_absence_creation_fixture_projection_mismatch'; end if;
  projected := internal.teacher_absence_creation_projection('[{"id":"B-SUB-ABS","studentId":"S-1","teacherId":"T-1","date":"2026-09-15","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"代课","teacherSubjectId":"Maths"}]'::jsonb, 'T-1', '2026-09-15', '2026-09-15');
  if jsonb_array_length(projected) <> 1 or projected #>> '{0,affectedOccurrenceIds,0}' <> 'B-SUB-ABS:2026-09-15' then raise exception 'teacher_absence_creation_fixture_substitute_projection_mismatch'; end if;
  historical_due := internal.teacher_absence_historical_due_date('[{"id":"B-SUB-HISTORY","studentId":"S-1","teacherId":"T-1","date":"2026-09-14","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"代课","teacherSubjectId":"Maths"}]'::jsonb, 'T-1', 'S-1', '2026-09-15');
  if historical_due <> '2026-09-15' then raise exception 'teacher_absence_creation_fixture_substitute_history_mismatch'; end if;
  projected := internal.teacher_absence_creation_projection('[{"id":"B-IN","studentId":"S-2","teacherId":"T-OTHER","date":"2026-09-15","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"常规课","teacherSubjectId":"Maths","occurrenceOverrides":[{"occurrenceId":"B-IN:2026-09-15","teacherId":"T-1"}]}]'::jsonb, 'T-1', '2026-09-15', '2026-09-15');
  if jsonb_array_length(projected) <> 1 or projected #>> '{0,studentId}' <> 'S-2' then raise exception 'teacher_absence_creation_fixture_moved_in_mismatch'; end if;
  projected := internal.teacher_absence_creation_projection('[{"id":"B-UNBOUND","studentId":"S-3","teacherId":"T-1","date":"2026-01-01","start":"17:00","duration":60,"timezone":"Australia/Melbourne","recurring":true,"kind":"常规课","teacherSubjectId":"Maths"}]'::jsonb, 'T-1', '2026-01-01', '2027-12-30');
  if jsonb_array_length(projected) <> 1 or jsonb_array_length(projected #> '{0,affectedOccurrenceIds}') <> 105 then raise exception 'teacher_absence_creation_fixture_unbounded_mismatch'; end if;
  projected := internal.teacher_absence_creation_projection('[{"id":"B-CUSTOM","studentId":"S-4","teacherId":"T-1","date":"2026-09-01","start":"17:00","duration":60,"timezone":"Australia/Melbourne","recurring":true,"repeatCount":5,"recurrenceIntervalDays":2,"recurrenceEndDate":"2026-09-05","kind":"常规课","teacherSubjectId":"Maths"}]'::jsonb, 'T-1', '2026-09-01', '2026-09-30');
  if jsonb_array_length(projected) <> 1 or jsonb_array_length(projected #> '{0,affectedOccurrenceIds}') <> 3 or projected #>> '{0,affectedOccurrenceIds,2}' <> 'B-CUSTOM:2026-09-05' then raise exception 'teacher_absence_creation_fixture_custom_recurrence_mismatch'; end if;
  begin
    perform internal.teacher_absence_creation_projection('[{"id":"B-TOO-MANY","studentId":"S-4","teacherId":"T-1","date":"2026-09-01","start":"17:00","duration":60,"timezone":"Australia/Melbourne","recurring":true,"repeatCount":105,"kind":"常规课","teacherSubjectId":"Maths"}]'::jsonb, 'T-1', '2026-09-01', '2026-09-01');
    raise exception 'teacher_absence_creation_fixture_repeat_limit_not_rejected';
  exception when sqlstate '22023' then
    if sqlerrm <> 'teacher_absence_repeat_count_out_of_range' then raise; end if;
  end;

  resolved := internal.teacher_absence_resolve_occurrence('{"id":"B-RESOLVE","studentId":"S-1","teacherId":"T-1","date":"2026-09-15","start":"17:00","duration":60,"timezone":"Australia/Melbourne","occurrenceOverrides":[{"occurrenceId":"B-RESOLVE:2026-09-15","date":null,"start":null,"durationMinutes":120,"studentId":null}]}'::jsonb, 'B-RESOLVE:2026-09-15');
  if resolved ->> 'date' <> '2026-09-15' or resolved ->> 'start' <> '17:00' or (resolved ->> 'durationMinutes')::integer <> 120 or resolved ->> 'studentId' is not null then raise exception 'teacher_absence_creation_fixture_override_nullish_mismatch'; end if;

  target_booking := '{"id":"B-TZ","studentId":"S-1","teacherId":"T-1","date":"2026-10-03","start":"16:30","duration":60,"timezone":"America/Los_Angeles","kind":"常规课","teacherSubjectId":"Maths"}'::jsonb;
  target_occurrence := internal.teacher_absence_resolve_occurrence(target_booking, 'B-TZ:2026-10-03');
  candidate_teacher := '{"id":"T-SUN","subjects":["Maths"],"acceptsStudents":true,"newStudentCapacity":1,"capacityAssignments":[],"availabilityWindows":[{"id":"A-SUN","teacherId":"T-SUN","day":0,"start":"09:30","end":"11:30","timezone":"Australia/Melbourne","validFrom":"2026-10-01","validTo":"2026-10-31","excludedDates":[],"overrides":[],"source":"submission"}]}'::jsonb;
  if not internal.teacher_absence_candidate_available(candidate_teacher, target_occurrence) then raise exception 'teacher_absence_creation_fixture_sunday_dst_mismatch'; end if;
  if internal.teacher_absence_candidate_available(jsonb_set(candidate_teacher, '{availabilityWindows,0,excludedDates}', '["2026-10-04"]'::jsonb), target_occurrence) then raise exception 'teacher_absence_creation_fixture_exclusion_mismatch'; end if;
  candidate_teacher := jsonb_set(jsonb_set(candidate_teacher, '{availabilityWindows,0,start}', '"12:00"'::jsonb), '{availabilityWindows,0,end}', '"13:00"'::jsonb);
  candidate_teacher := jsonb_set(candidate_teacher, '{availabilityWindows,0,overrides}', '[{"id":"A-SUN-OV","date":"2026-10-04","start":"09:30","end":"11:30"}]'::jsonb);
  if not internal.teacher_absence_candidate_available(candidate_teacher, target_occurrence) then raise exception 'teacher_absence_creation_fixture_ava_override_mismatch'; end if;
  if internal.teacher_absence_candidate_ranges('{"id":"T-OVERLAP","availabilityWindows":[{"id":"A-ONE","teacherId":"T-OVERLAP","day":1,"start":"09:00","end":"11:00","timezone":"Australia/Melbourne","validFrom":"2026-09-01","validTo":"2026-09-30","excludedDates":[],"overrides":[],"source":"submission"},{"id":"A-TWO","teacherId":"T-OVERLAP","day":1,"start":"10:00","end":"12:00","timezone":"Australia/Melbourne","validFrom":"2026-09-01","validTo":"2026-09-30","excludedDates":[],"overrides":[],"source":"submission"}]}'::jsonb, '2026-09-01T00:00:00Z'::timestamptz, '2026-09-30T00:00:00Z'::timestamptz) is not null then raise exception 'teacher_absence_creation_fixture_ava_overlap_mismatch'; end if;

  candidate_group := jsonb_build_object('studentId', 'S-1', 'subjects', jsonb_build_array('Maths'), 'affectedOccurrenceIds', jsonb_build_array('B-TZ:2026-10-03'));
  conflict_bookings := jsonb_build_array(target_booking, '{"id":"B-UTC-CONFLICT","studentId":"S-OTHER","teacherId":"T-SUN","date":"2026-10-03","start":"23:45","duration":30,"timezone":"UTC","kind":"常规课","teacherSubjectId":"Maths"}'::jsonb);
  if internal.teacher_absence_candidate_eligible(conflict_bookings, candidate_teacher, candidate_group) then raise exception 'teacher_absence_creation_fixture_cross_timezone_conflict_mismatch'; end if;
  conflict_bookings := jsonb_build_array(target_booking, '{"id":"B-SUB-CONFLICT","studentId":"S-OTHER","teacherId":"T-SUN","date":"2026-10-03","start":"23:45","duration":30,"timezone":"UTC","kind":"代课","teacherSubjectId":"Maths"}'::jsonb);
  if internal.teacher_absence_candidate_eligible(conflict_bookings, candidate_teacher, candidate_group) then raise exception 'teacher_absence_creation_fixture_substitute_conflict_mismatch'; end if;
  conflict_bookings := jsonb_build_array(target_booking, '{"id":"B-UTC-CANCELLED","studentId":"S-OTHER","teacherId":"T-SUN","date":"2026-10-03","start":"23:45","duration":30,"timezone":"UTC","kind":"常规课","teacherSubjectId":"Maths","occurrenceOverrides":[{"occurrenceId":"B-UTC-CANCELLED:2026-10-03","status":"cancelled"}]}'::jsonb);
  if not internal.teacher_absence_candidate_eligible(conflict_bookings, candidate_teacher, candidate_group) then raise exception 'teacher_absence_creation_fixture_cancelled_override_mismatch'; end if;
end;
$$;

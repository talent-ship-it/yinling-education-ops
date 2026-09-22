-- Require overlapping presence during the scheduled lesson, not independent
-- accumulated totals. Historical duration-only evidence remains reviewable via
-- the existing authorized manual override; it cannot silently bill a lesson.
set local lock_timeout = '2s';

create or replace function internal.lesson_joint_attendance_seconds(
  p_evidence jsonb,
  p_lesson_date text,
  p_start text,
  p_timezone text,
  p_minutes numeric
)
returns bigint
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  party text;
  spans jsonb;
  span jsonb;
  joined_at timestamptz;
  left_at timestamptz;
  ranges tstzmultirange;
  joint tstzmultirange;
  lesson_start timestamptz;
  zone text := coalesce(nullif(trim(split_part(p_timezone, ' · ', 1)), ''), 'Australia/Melbourne');
  seconds bigint;
begin
  if p_minutes is null or p_minutes <= 0 then return null; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = zone) then zone := 'Australia/Melbourne'; end if;
  lesson_start := (p_lesson_date || ' ' || p_start)::timestamp at time zone zone;
  if not isfinite(lesson_start) then return null; end if;
  joint := tstzmultirange(tstzrange(lesson_start, lesson_start + p_minutes * interval '1 minute', '[)'));
  foreach party in array array['student', 'teacher'] loop
    spans := p_evidence -> party -> 'joinLeave';
    if jsonb_typeof(spans) is distinct from 'array' then return null; end if;
    if jsonb_array_length(spans) > 200 then return null; end if;
    ranges := '{}'::tstzmultirange;
    for span in select value from jsonb_array_elements(spans) loop
      if jsonb_typeof(span -> 'joinedAt') is distinct from 'string'
         or jsonb_typeof(span -> 'leftAt') is distinct from 'string' then return null; end if;
      joined_at := (span ->> 'joinedAt')::timestamptz;
      left_at := (span ->> 'leftAt')::timestamptz;
      if not isfinite(joined_at) or not isfinite(left_at) or left_at < joined_at then return null; end if;
      -- Multirange union avoids double counting reconnect/overlap evidence.
      ranges := ranges + tstzmultirange(tstzrange(joined_at, left_at, '[)'));
    end loop;
    joint := joint * ranges;
  end loop;
  select floor(coalesce(sum(extract(epoch from (upper(r) - lower(r)))), 0))::bigint
  into seconds from unnest(joint) r;
  return seconds;
exception when invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
  return null;
end;
$function$;

revoke all on function internal.lesson_joint_attendance_seconds(jsonb, text, text, text, numeric)
  from public, anon, authenticated;

-- Patch only the evidence classifier, preserving subsequent fixes to the
-- settlement's OCC, callback nonce, manual adjustment and idempotency guards.
do $migration$
declare
  target regprocedure := 'public.complete_lesson_occurrence_atomic(text,text,bigint,jsonb,text,jsonb,text,text,text,text)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target);
  old_guard text := $old$      and jsonb_typeof(attendance_row.evidence -> 'student' -> 'accumulatedSeconds') = 'number'
      and jsonb_typeof(attendance_row.evidence -> 'teacher' -> 'accumulatedSeconds') = 'number'
      and (attendance_row.evidence -> 'student' ->> 'accumulatedSeconds')::numeric >= greatest(1, lesson_minutes * 60 - 300)
      and (attendance_row.evidence -> 'teacher' ->> 'accumulatedSeconds')::numeric >= greatest(1, lesson_minutes * 60 - 300)$old$;
  new_guard text := $new$      and internal.lesson_joint_attendance_seconds(
        attendance_row.evidence, expected_lesson_date, expected_start,
        booking ->> 'timezone', lesson_minutes
      ) >= greatest(1, lesson_minutes * 60 - 300)$new$;
begin
  if (length(definition) - length(replace(definition, old_guard, ''))) / length(old_guard) <> 1 then
    raise exception 'lesson attendance classifier changed; review before applying migration';
  end if;
  execute replace(definition, old_guard, new_guard);
end;
$migration$;

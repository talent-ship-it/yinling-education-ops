-- The direct Jiaowubao projection is read-only, but its latest completed
-- schedule must still be an authoritative occupied interval for a later
-- manual booking.  Keep the proof in PostgreSQL: a stale calendar browser or
-- a caller that bypasses the UI must not be able to write a conflicting
-- booking into public.ops_state.
--
-- This helper has no public grant.  The only intended caller is the existing
-- secret-gated booking-capacity transaction below.  It locks the run ledger in
-- SHARE mode before taking the latest-complete view so a direct import cannot
-- publish a new completed projection between the conflict check and the
-- booking-state update in this transaction.

set local lock_timeout = '1s';

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
begin
  -- The outer mutation has already checked identity and action shape.  These
  -- checks deliberately validate the submitted persisted booking fields again
  -- before deriving every recurrence instant.  A malformed direct RPC call
  -- therefore fails closed instead of silently escaping the imported blocks.
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
    if jsonb_typeof(p_booking -> 'repeatCount') <> 'number'
       or p_booking ->> 'repeatCount' !~ '^(?:[1-9]|[1-9][0-9]|10[0-4])$' then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end if;
    occurrence_count := (p_booking ->> 'repeatCount')::integer;
  else
    if p_booking ? 'repeatCount'
       and (jsonb_typeof(p_booking -> 'repeatCount') <> 'number'
         or p_booking ->> 'repeatCount' <> '1') then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end if;
    occurrence_count := 1;
  end if;

  -- Completion changes which run is "latest".  Serialise that state change
  -- with this short booking transaction so the conflict decision and write
  -- observe one immutable current projection.
  perform pg_catalog.set_config('lock_timeout', '1s', true);
  lock table internal.jiaowubao_direct_import_runs in share mode;

  for occurrence_index in 0..(occurrence_count - 1)
  loop
    occurrence_date := source_date + (occurrence_index * 7);
    source_local_start := occurrence_date + source_start;

    -- A nonexistent wall clock has no exact round-trip instant and must fail,
    -- matching the existing JavaScript booking validation.  A repeated DST
    -- clock remains accepted by that established validator, so retain that
    -- behavior but test every exact candidate below: ambiguity can never be
    -- used to route around an imported block.
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

-- Patch the already-reviewed atomic booking function only if the deployed
-- definition is the expected 12-argument SECURITY DEFINER contract and has
-- exactly the original booking-write anchor.  Do not replace it from a stale
-- copied body: that would erase unrelated hardening shipped before this
-- migration.  Any drift aborts the migration before writes become possible.
do $patch_booking_capacity_with_jiaowubao_guard$
declare
  target_oid regprocedure := to_regprocedure(
    'public.mutate_booking_capacity_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text)'
  );
  source_definition text;
  patched_definition text;
  anchor text := E'  update public.ops_state s set\n    payload = p_bookings,\n    version = s.version + 1,\n    updated_at = now(),\n    updated_by = left(trim(p_actor), 120)\n  where s.entity = ''bookings''\n  returning s.* into saved_booking_state;';
  guard text := $booking_capacity_jiaowubao_guard$
  -- Imported class events are not normal bookings, but they are still an
  -- authoritative conflict surface for this exact teacher or student.
  if p_action <> 'delete' then
    perform internal.assert_jiaowubao_direct_booking_interval_available(
      p_student_id,
      p_teacher_id,
      next_booking
    );
  end if;

$booking_capacity_jiaowubao_guard$;
  target_proc pg_catalog.pg_proc%rowtype;
  plpgsql_language_oid oid;
begin
  if target_oid is null
     or to_regclass('internal.jiaowubao_direct_current_schedule_blocks') is null then
    raise exception using errcode = '55000', message = 'jiaowubao_booking_capacity_guard_target_missing';
  end if;

  select * into target_proc from pg_catalog.pg_proc proc where proc.oid = target_oid;
  select language.oid into plpgsql_language_oid
  from pg_catalog.pg_language language
  where language.lanname = 'plpgsql';
  if target_proc.oid is null
     or plpgsql_language_oid is null
     or target_proc.prolang <> plpgsql_language_oid
     or target_proc.prosecdef is not true
     -- A RETURNS TABLE function stores its output-column names after the
     -- input argument names in pg_proc.proargnames. Bind this contract to the
     -- exact twelve inputs selected by the regprocedure signature without
     -- treating the seven stable output names as extra inputs.
     or target_proc.pronargs <> 12
     or target_proc.proargnames[1:target_proc.pronargs] is distinct from ARRAY[
       'p_secret', 'p_command_key', 'p_command_intent', 'p_action', 'p_booking_id',
       'p_expected_versions', 'p_bookings', 'p_teachers', 'p_changed_teacher_ids',
       'p_student_id', 'p_teacher_id', 'p_actor'
     ]::text[]
     or not exists (
       select 1
       from unnest(coalesce(target_proc.proconfig, ARRAY[]::text[])) config(value)
       where config.value like 'search_path=%'
     ) then
    raise exception using errcode = '55000', message = 'jiaowubao_booking_capacity_guard_target_contract_mismatch';
  end if;

  select pg_get_functiondef(target_oid) into source_definition;
  if source_definition is null
     or position('jiaowubao_direct_import_schedule_conflict' in source_definition) <> 0
     or position(anchor in source_definition) = 0
     or position(anchor in substr(source_definition, position(anchor in source_definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_booking_capacity_guard_anchor_mismatch';
  end if;

  patched_definition := replace(source_definition, anchor, guard || anchor);
  if patched_definition = source_definition
     or position('internal.assert_jiaowubao_direct_booking_interval_available' in patched_definition) = 0
     or position(guard in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_booking_capacity_guard_patch_failed';
  end if;
  execute patched_definition;

  select pg_get_functiondef(target_oid) into patched_definition;
  if position('internal.assert_jiaowubao_direct_booking_interval_available' in patched_definition) = 0
     or position('jiaowubao_direct_import_schedule_conflict' in patched_definition) <> 0
     or position(anchor in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_booking_capacity_guard_postcheck_failed';
  end if;
end;
$patch_booking_capacity_with_jiaowubao_guard$;

-- Reassert the original narrow RPC ACL after CREATE OR REPLACE FUNCTION.
revoke all on function public.mutate_booking_capacity_atomic(text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mutate_booking_capacity_atomic(text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  to anon, authenticated;

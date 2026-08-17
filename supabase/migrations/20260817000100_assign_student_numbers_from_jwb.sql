-- Human-facing student numbers use YYYYMMDD + a same-day three-digit serial.
-- Formal imported students use their earliest positive JWB contract date. New
-- in-app students use the database transaction date in Australia/Melbourne.
-- Existing numbers are never renumbered.

-- A visible number stays occupied forever, even if a later formal roster
-- no longer projects the student's record. This is deliberately separate
-- from ops_state: a roster replacement may safely remove an unreferenced
-- profile, but must never make its issued number available to someone else.
create table internal.student_number_reservations (
  student_number text primary key
    check (student_number ~ '^[0-9]{11}$'),
  student_id text not null unique
    check (student_id = btrim(student_id) and char_length(student_id) between 1 and 240),
  reserved_at timestamptz not null default current_timestamp
);

alter table internal.student_number_reservations enable row level security;
revoke all on table internal.student_number_reservations from public, anon, authenticated;

create or replace function internal.student_number_reservation_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $student_number_reservation_snapshot$
  select coalesce(jsonb_agg(jsonb_build_object(
    'studentId', reservation.student_id,
    'studentNumber', reservation.student_number
  ) order by internal.student_import_utf16_sort_key(reservation.student_id)), '[]'::jsonb)
  from internal.student_number_reservations reservation
$student_number_reservation_snapshot$;

revoke all on function internal.student_number_reservation_snapshot()
  from public, anon, authenticated;

create or replace function internal.student_import_assign_student_numbers(p_students jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $student_numbers$
declare
  student_item record;
  number_item record;
  reservation_item record;
  current_number text;
  reserved_number text;
  reserved_student_id text;
  date_key text;
  serial integer;
  serials jsonb := '{}'::jsonb;
  assignments jsonb := '{}'::jsonb;
  result jsonb := '[]'::jsonb;
  seen_ids text[] := array[]::text[];
  seen_numbers text[] := array[]::text[];
  reservation_by_student_id jsonb := '{}'::jsonb;
  reservation_by_number jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_students) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
  end if;

  -- The reservation registry includes students omitted by a later canonical
  -- roster projection. It is the durable source of same-day serial maxima
  -- and of the original number for a returning stable student ID.
  for reservation_item in
    select reservation.student_number, reservation.student_id
    from internal.student_number_reservations reservation
    order by reservation.student_number collate "C"
  loop
    if reservation_item.student_number !~ '^[0-9]{11}$'
       or nullif(btrim(reservation_item.student_id), '') is null then
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
    date_key := left(reservation_item.student_number, 8);
    serial := right(reservation_item.student_number, 3)::integer;
    serials := jsonb_set(
      serials,
      array[date_key],
      to_jsonb(greatest(coalesce((serials ->> date_key)::integer, 0), serial)),
      true
    );
  end loop;

  for student_item in
    select value, ordinal
    from jsonb_array_elements(p_students) with ordinality as student(value, ordinal)
    order by ordinal
  loop
    if jsonb_typeof(student_item.value) is distinct from 'object'
       or jsonb_typeof(student_item.value -> 'id') is distinct from 'string'
       or nullif(btrim(student_item.value ->> 'id'), '') is null then
      raise exception using errcode = '22023', message = 'student_payload_item_or_id_invalid';
    end if;
    if student_item.value ->> 'id' = any(seen_ids) then
      raise exception using errcode = '23505', message = 'duplicate_student_id';
    end if;
    seen_ids := array_append(seen_ids, student_item.value ->> 'id');

    if student_item.value ? 'studentNumber' then
      if jsonb_typeof(student_item.value -> 'studentNumber') is distinct from 'string'
         or student_item.value ->> 'studentNumber' !~ '^[0-9]{11}$' then
        raise exception using errcode = '22023', message = 'student_number_invalid';
      end if;
      current_number := student_item.value ->> 'studentNumber';
      if current_number = any(seen_numbers) then
        raise exception using errcode = '23505', message = 'duplicate_student_number';
      end if;
      reserved_number := reservation_by_student_id ->> (student_item.value ->> 'id');
      reserved_student_id := reservation_by_number ->> current_number;
      if (reserved_number is not null and reserved_number <> current_number)
         or (reserved_student_id is not null
             and reserved_student_id <> student_item.value ->> 'id') then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
      seen_numbers := array_append(seen_numbers, current_number);
      date_key := left(current_number, 8);
      serial := right(current_number, 3)::integer;
      serials := jsonb_set(
        serials,
        array[date_key],
        to_jsonb(greatest(coalesce((serials ->> date_key)::integer, 0), serial)),
        true
      );
    else
      -- If an old formal student returns after its row was absent from a
      -- previous projection, restore the original immutable number before
      -- considering a new historical allocation.
      reserved_number := reservation_by_student_id ->> (student_item.value ->> 'id');
      if reserved_number is not null then
        assignments := jsonb_set(
          assignments,
          array[student_item.value ->> 'id'],
          to_jsonb(reserved_number),
          true
        );
      end if;
    end if;
  end loop;

  -- `firstJwbHourEntryDate` carries the earliest positive JWB contract date
  -- (not a claimed JWB created_at). A missing link/date remains unnumbered;
  -- no historical date is fabricated.
  for number_item in
    select
      student.value ->> 'id' as student_id,
      replace(left(student.value ->> 'firstJwbHourEntryDate', 10), '-', '') as date_key
    from jsonb_array_elements(p_students) as student(value)
    where not (student.value ? 'studentNumber')
      and not (assignments ? (student.value ->> 'id'))
      and jsonb_typeof(student.value -> 'firstJwbHourEntryDate') = 'string'
      and left(student.value ->> 'firstJwbHourEntryDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and to_char(
        to_date(left(student.value ->> 'firstJwbHourEntryDate', 10), 'YYYY-MM-DD'),
        'YYYY-MM-DD'
      ) = left(student.value ->> 'firstJwbHourEntryDate', 10)
    -- JavaScript's string comparison is UTF-16 code-unit order. The import
    -- fingerprint includes these assignments, so the database must use the
    -- same order rather than PostgreSQL's UTF-8/C collation.
    order by replace(left(student.value ->> 'firstJwbHourEntryDate', 10), '-', ''),
      internal.student_import_utf16_sort_key(student.value ->> 'id')
  loop
    serial := coalesce((serials ->> number_item.date_key)::integer, 0) + 1;
    if serial > 999 then
      raise exception using errcode = '22023', message = 'student_number_daily_sequence_exhausted';
    end if;
    current_number := number_item.date_key || lpad(serial::text, 3, '0');
    serials := jsonb_set(serials, array[number_item.date_key], to_jsonb(serial), true);
    assignments := jsonb_set(assignments, array[number_item.student_id], to_jsonb(current_number), true);
  end loop;

  for student_item in
    select value, ordinal
    from jsonb_array_elements(p_students) with ordinality as student(value, ordinal)
    order by ordinal
  loop
    result := result || jsonb_build_array(
      case when assignments ? (student_item.value ->> 'id')
        then student_item.value || jsonb_build_object(
          'studentNumber', assignments ->> (student_item.value ->> 'id')
        )
        else student_item.value
      end
    );
  end loop;
  return result;
end;
$student_numbers$;

revoke all on function internal.student_import_assign_student_numbers(jsonb)
  from public, anon, authenticated;

create or replace function internal.assign_new_student_numbers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $new_student_numbers$
declare
  student_item record;
  old_item record;
  candidate record;
  reservation_item record;
  prior_value jsonb;
  current_number text;
  reserved_number text;
  reserved_student_id text;
  date_key text := to_char(current_timestamp at time zone 'Australia/Melbourne', 'YYYYMMDD');
  serial integer;
  old_by_id jsonb := '{}'::jsonb;
  serials jsonb := '{}'::jsonb;
  assignments jsonb := '{}'::jsonb;
  result jsonb := '[]'::jsonb;
  seen_ids text[] := array[]::text[];
  seen_numbers text[] := array[]::text[];
  reservation_by_student_id jsonb := '{}'::jsonb;
  reservation_by_number jsonb := '{}'::jsonb;
  is_formal_import boolean;
begin
  if new.entity <> 'students' then
    return new;
  end if;
  if jsonb_typeof(new.payload) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
  end if;
  if tg_op = 'UPDATE' and jsonb_typeof(old.payload) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'previous_students_payload_must_be_array';
  end if;

  -- The students ops_state row serializes normal writes. The explicit lock
  -- also covers a future alternate writer, so it cannot allocate from a
  -- stale reservation snapshot between another writer's calculation and
  -- registry insert.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('internal.student_number_reservations', 0)
  );
  for reservation_item in
    select reservation.student_number, reservation.student_id
    from internal.student_number_reservations reservation
    order by reservation.student_number collate "C"
  loop
    if reservation_item.student_number !~ '^[0-9]{11}$'
       or nullif(btrim(reservation_item.student_id), '') is null then
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
    serial := right(reservation_item.student_number, 3)::integer;
    serials := jsonb_set(
      serials,
      array[left(reservation_item.student_number, 8)],
      to_jsonb(greatest(
        coalesce((serials ->> left(reservation_item.student_number, 8))::integer, 0),
        serial
      )),
      true
    );
  end loop;

  if tg_op = 'UPDATE' then
    for old_item in select value from jsonb_array_elements(old.payload) as student(value)
    loop
      if jsonb_typeof(old_item.value) is distinct from 'object'
         or jsonb_typeof(old_item.value -> 'id') is distinct from 'string'
         or nullif(btrim(old_item.value ->> 'id'), '') is null then
        raise exception using errcode = '22023', message = 'previous_student_payload_item_or_id_invalid';
      end if;
      if old_by_id ? (old_item.value ->> 'id') then
        raise exception using errcode = '23505', message = 'previous_duplicate_student_id';
      end if;
      old_by_id := jsonb_set(old_by_id, array[old_item.value ->> 'id'], old_item.value, true);
    end loop;
  end if;

  for student_item in
    select value, ordinal
    from jsonb_array_elements(new.payload) with ordinality as student(value, ordinal)
    order by ordinal
  loop
    if jsonb_typeof(student_item.value) is distinct from 'object'
       or jsonb_typeof(student_item.value -> 'id') is distinct from 'string'
       or nullif(btrim(student_item.value ->> 'id'), '') is null then
      raise exception using errcode = '22023', message = 'student_payload_item_or_id_invalid';
    end if;
    if student_item.value ->> 'id' = any(seen_ids) then
      raise exception using errcode = '23505', message = 'duplicate_student_id';
    end if;
    seen_ids := array_append(seen_ids, student_item.value ->> 'id');
    prior_value := old_by_id -> (student_item.value ->> 'id');
    is_formal_import := coalesce(student_item.value ->> 'importSource', '') = 'master';
    if prior_value is not null and not (prior_value ? 'studentNumber')
       and student_item.value ? 'studentNumber'
       and not is_formal_import then
      raise exception using errcode = '22023', message = 'student_number_server_assigned';
    end if;
    if prior_value is null and not is_formal_import and student_item.value ? 'studentNumber' then
      raise exception using errcode = '22023', message = 'student_number_server_assigned';
    end if;
    if prior_value ? 'studentNumber' then
      if jsonb_typeof(prior_value -> 'studentNumber') is distinct from 'string'
         or prior_value ->> 'studentNumber' !~ '^[0-9]{11}$' then
        raise exception using errcode = '22023', message = 'previous_student_number_invalid';
      end if;
      if student_item.value ->> 'studentNumber' is distinct from prior_value ->> 'studentNumber' then
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
      -- A stable ID can only regain its historical number through the formal
      -- import path. A generic browser write must not resurrect an omitted
      -- identity by choosing its old ID.
      if not is_formal_import then
        raise exception using errcode = '22023', message = 'student_number_reserved_identity';
      end if;
      current_number := reserved_number;
      assignments := jsonb_set(
        assignments,
        array[student_item.value ->> 'id'],
        to_jsonb(current_number),
        true
      );
    end if;
    if current_number is not null then
      reserved_student_id := reservation_by_number ->> current_number;
      if (reserved_number is not null and reserved_number <> current_number)
         or (reserved_student_id is not null
             and reserved_student_id <> student_item.value ->> 'id') then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
      if current_number = any(seen_numbers) then
        raise exception using errcode = '23505', message = 'duplicate_student_number';
      end if;
      seen_numbers := array_append(seen_numbers, current_number);
      serial := right(current_number, 3)::integer;
      serials := jsonb_set(
        serials,
        array[left(current_number, 8)],
        to_jsonb(greatest(coalesce((serials ->> left(current_number, 8))::integer, 0), serial)),
        true
      );
    end if;
  end loop;

  -- Only a newly-created, non-imported student is allocated here. Formal
  -- JWB imports use the canonical helper above before their atomic commit.
  for candidate in
    select student.value ->> 'id' as student_id
    from jsonb_array_elements(new.payload) as student(value)
    where not (old_by_id ? (student.value ->> 'id'))
      and coalesce(student.value ->> 'importSource', '') <> 'master'
      and not (reservation_by_student_id ? (student.value ->> 'id'))
    order by internal.student_import_utf16_sort_key(student.value ->> 'id')
  loop
    serial := coalesce((serials ->> date_key)::integer, 0) + 1;
    if serial > 999 then
      raise exception using errcode = '22023', message = 'student_number_daily_sequence_exhausted';
    end if;
    current_number := date_key || lpad(serial::text, 3, '0');
    serials := jsonb_set(serials, array[date_key], to_jsonb(serial), true);
    assignments := jsonb_set(assignments, array[candidate.student_id], to_jsonb(current_number), true);
  end loop;

  if assignments <> '{}'::jsonb then
    for student_item in
      select value, ordinal
      from jsonb_array_elements(new.payload) with ordinality as student(value, ordinal)
      order by ordinal
    loop
      result := result || jsonb_build_array(
        case when assignments ? (student_item.value ->> 'id')
          then student_item.value || jsonb_build_object(
            'studentNumber', assignments ->> (student_item.value ->> 'id')
          )
          else student_item.value
        end
      );
    end loop;
    new.payload := result;
  end if;

  -- Reserve every resulting number in the same transaction as the ops_state
  -- write. ON CONFLICT plus both post-write mapping checks is intentional:
  -- it safely handles an idempotent replay while refusing either direction of
  -- a one-to-one number/ID conflict.
  for student_item in select value from jsonb_array_elements(new.payload) as student(value)
  loop
    if not (student_item.value ? 'studentNumber') then
      continue;
    end if;
    current_number := student_item.value ->> 'studentNumber';
    insert into internal.student_number_reservations(student_number, student_id)
    values (current_number, student_item.value ->> 'id')
    on conflict do nothing;
    select reservation.student_id into reserved_student_id
    from internal.student_number_reservations reservation
    where reservation.student_number = current_number;
    select reservation.student_number into reserved_number
    from internal.student_number_reservations reservation
    where reservation.student_id = student_item.value ->> 'id';
    if reserved_student_id is distinct from student_item.value ->> 'id'
       or reserved_number is distinct from current_number then
      raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
    end if;
  end loop;
  return new;
end;
$new_student_numbers$;

revoke all on function internal.assign_new_student_numbers()
  from public, anon, authenticated;

-- Install the trigger before taking the `students` row lock for the initial
-- reservation snapshot below. CREATE TRIGGER takes a table-level DDL lock
-- that conflicts with normal writers. Acquiring it first prevents the
-- deadlock where a writer holds RowExclusiveLock and waits for the row while
-- this migration holds the row and waits for the DDL lock. Do not use DROP
-- TRIGGER here: it requests an unnecessary AccessExclusiveLock even when the
-- named trigger is absent.
--
-- This migration is unapplied and transactional, so either trigger name
-- already existing means an unexpected/manual partial installation. Abort
-- rather than silently replacing or running both trigger implementations.
--
-- Acquire the relation lock as a no-wait deployment gate before inspecting
-- triggers or locking the students row. AccessExclusive also rejects a
-- pre-existing SELECT FOR UPDATE (which ShareRowExclusive would allow), so
-- a concurrent PostgREST request cannot create a later lock-upgrade cycle.
-- A busy system gets 55P03 immediately and the deployment can retry; a
-- successful migration holds this short read/write freeze through commit.
do $student_number_ops_state_lock$
begin
  lock table public.ops_state in access exclusive mode nowait;
exception when lock_not_available then
  raise exception using
    errcode = '55P03',
    message = 'student_number_migration_ops_state_busy',
    hint = 'Retry this migration after active ops_state requests finish.';
end;
$student_number_ops_state_lock$;

do $student_number_trigger_preflight$
declare
  existing_trigger_names text;
begin
  select string_agg(trigger_row.tgname, ', ' order by trigger_row.tgname)
  into existing_trigger_names
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.ops_state'::pg_catalog.regclass
    and trigger_row.tgname in (
      'ops_state_assign_student_numbers_from_jwb',
      'ops_state_assign_new_student_numbers'
    )
    and not trigger_row.tgisinternal;

  if existing_trigger_names is not null then
    raise exception using
      errcode = '42710',
      message = 'student_number_trigger_already_exists',
      detail = 'Existing trigger(s): ' || existing_trigger_names;
  end if;
end;
$student_number_trigger_preflight$;

create trigger ops_state_assign_new_student_numbers
before insert or update of payload on public.ops_state
for each row execute function internal.assign_new_student_numbers();

-- The CREATE TRIGGER lock above is held until this migration commits, so no
-- students write can enter between this backfill snapshot and enforcement.
do $student_number_reservation_backfill$
declare
  students_payload jsonb;
begin
  select state_row.payload into students_payload
  from public.ops_state state_row
  where state_row.entity = 'students'
  for update;

  if students_payload is null then
    return;
  end if;
  if jsonb_typeof(students_payload) <> 'array' then
    raise exception using errcode = '22023', message = 'student_number_backfill_students_payload_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(students_payload) student(value)
    where student.value ? 'studentNumber'
      and (
        jsonb_typeof(student.value) <> 'object'
        or jsonb_typeof(student.value -> 'id') <> 'string'
        or nullif(btrim(student.value ->> 'id'), '') is null
        or char_length(student.value ->> 'id') > 240
        or jsonb_typeof(student.value -> 'studentNumber') <> 'string'
        or student.value ->> 'studentNumber' !~ '^[0-9]{11}$'
      )
  ) then
    raise exception using errcode = '22023', message = 'student_number_backfill_record_invalid';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(students_payload) student(value)
    where student.value ? 'studentNumber'
  ) <> (
    select count(distinct student.value ->> 'studentNumber')
    from jsonb_array_elements(students_payload) student(value)
    where student.value ? 'studentNumber'
  ) or (
    select count(*)
    from jsonb_array_elements(students_payload) student(value)
    where student.value ? 'studentNumber'
  ) <> (
    select count(distinct student.value ->> 'id')
    from jsonb_array_elements(students_payload) student(value)
    where student.value ? 'studentNumber'
  ) then
    raise exception using errcode = '23505', message = 'student_number_backfill_not_one_to_one';
  end if;

  insert into internal.student_number_reservations(student_number, student_id)
  select student.value ->> 'studentNumber', student.value ->> 'id'
  from jsonb_array_elements(students_payload) student(value)
  where student.value ? 'studentNumber';
end;
$student_number_reservation_backfill$;

-- Migration-time behavior fixtures run only against a temporary table. They
-- prove permanent reservation, returning-ID restoration, UTF-16 ordering,
-- and server-owned manual allocation without leaving fixture data behind.
do $student_number_fixture$
declare
  historical jsonb;
  restored jsonb;
  utf16_ordered jsonb;
  manual jsonb;
  formal jsonb;
  returning_formal jsonb;
  fixture_prefix text := 'STU-NUMBER-MIGRATION-FIXTURE-' || pg_backend_pid() || '-';
  retired_student_id text;
begin
  retired_student_id := fixture_prefix || 'RETIRED';
  insert into internal.student_number_reservations(student_number, student_id)
  values ('20990101007', retired_student_id);

  historical := internal.student_import_assign_student_numbers(jsonb_build_array(
    jsonb_build_object('id', fixture_prefix || 'B', 'firstJwbHourEntryDate', '2099-01-01'),
    jsonb_build_object('id', fixture_prefix || 'A', 'firstJwbHourEntryDate', '2099-01-01')
  ));
  if historical #>> '{0,studentNumber}' <> '20990101009'
     or historical #>> '{1,studentNumber}' <> '20990101008' then
    raise exception using errcode = 'P0001', message = 'student_number_jwb_date_fixture_failed';
  end if;

  restored := internal.student_import_assign_student_numbers(jsonb_build_array(
    jsonb_build_object('id', retired_student_id)
  ));
  if restored #>> '{0,studentNumber}' <> '20990101007' then
    raise exception using errcode = 'P0001', message = 'student_number_reservation_restore_fixture_failed';
  end if;

  -- `😀` begins with UTF-16 high surrogate D83D and must therefore precede
  -- BMP private-use E000, despite PostgreSQL C/UTF-8 byte order doing the
  -- opposite. Input order is intentionally reversed from expected serials.
  utf16_ordered := internal.student_import_assign_student_numbers(jsonb_build_array(
    jsonb_build_object('id', fixture_prefix || chr(57344), 'firstJwbHourEntryDate', '2099-01-02'),
    jsonb_build_object('id', fixture_prefix || chr(128512), 'firstJwbHourEntryDate', '2099-01-02')
  ));
  if utf16_ordered #>> '{0,studentNumber}' <> '20990102002'
     or utf16_ordered #>> '{1,studentNumber}' <> '20990102001' then
    raise exception using errcode = 'P0001', message = 'student_number_utf16_sort_fixture_failed';
  end if;

  create temporary table student_number_fixture (
    entity text not null,
    payload jsonb not null
  ) on commit drop;
  create trigger student_number_fixture_trigger
  before insert or update of payload on student_number_fixture
  for each row execute function internal.assign_new_student_numbers();
  insert into student_number_fixture(entity, payload)
  values ('students', jsonb_build_array(jsonb_build_object(
    'id', fixture_prefix || 'MANUAL'
  )))
  returning payload into manual;
  if not (manual #>> '{0,studentNumber}' ~ (
    '^' || to_char(current_timestamp at time zone 'Australia/Melbourne', 'YYYYMMDD') || '[0-9]{3}$'
  )) then
    raise exception using errcode = 'P0001', message = 'student_number_manual_fixture_failed';
  end if;

  -- A formal canonical import is allowed to supply the historical number
  -- generated by the internal projection; ordinary browser writes are not.
  insert into student_number_fixture(entity, payload)
  values ('students', jsonb_build_array(jsonb_build_object(
    'id', fixture_prefix || 'FORMAL',
    'importSource', 'master',
    'studentNumber', '20990101020'
  )))
  returning payload into formal;
  if formal #>> '{0,studentNumber}' <> '20990101020' then
    raise exception using errcode = 'P0001', message = 'student_number_formal_fixture_failed';
  end if;

  insert into student_number_fixture(entity, payload)
  values ('students', jsonb_build_array(jsonb_build_object(
    'id', retired_student_id,
    'importSource', 'master'
  )))
  returning payload into returning_formal;
  if returning_formal #>> '{0,studentNumber}' <> '20990101007' then
    raise exception using errcode = 'P0001', message = 'student_number_trigger_restore_fixture_failed';
  end if;

  begin
    insert into student_number_fixture(entity, payload)
    values ('students', jsonb_build_array(jsonb_build_object(
      'id', fixture_prefix || 'CONFLICT',
      'importSource', 'master',
      'studentNumber', '20990101007'
    )));
    raise exception using errcode = 'P0001', message = 'student_number_reservation_conflict_fixture_missing';
  exception when sqlstate '23505' then
    if sqlerrm <> 'student_number_reservation_conflict' then
      raise;
    end if;
  end;

  begin
    insert into student_number_fixture(entity, payload)
    values ('students', jsonb_build_array(jsonb_build_object(
      'id', fixture_prefix || 'FORGED',
      'studentNumber', '19990101001'
    )));
    raise exception using errcode = 'P0001', message = 'student_number_forged_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_number_server_assigned' then
      raise;
    end if;
  end;
  delete from internal.student_number_reservations reservation
  where left(reservation.student_id, char_length(fixture_prefix)) = fixture_prefix;
end;
$student_number_fixture$;

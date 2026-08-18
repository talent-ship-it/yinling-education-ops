-- Tencent's hand-maintained master roster is the authority for student
-- existence. JWB remains a strictly exact, optional enrichment source: an
-- absent or ambiguous JWB identity must never drop a named master-row
-- student, attach guessed balances, or block a formal roster commit.
--
-- A master-only student number deliberately records the formal import day,
-- rather than pretending it is a historical JWB registration date. The
-- durable provenance below survives later JWB linkage and roster replays.

-- This migration changes both the students state trigger path and its durable
-- number/commit registries. Acquire the same three relations in one fixed
-- order before any DDL, so a normal students write cannot hold ops_state and
-- wait for reservations while this migration waits in the opposite direction.
-- NOWAIT makes an already-active formal import a fast, retryable migration
-- failure instead of freezing it for five seconds. The short local timeout
-- remains a secondary guard for dependent DDL locks; a transactional runner
-- rolls the whole file back if either guard fires.
set local lock_timeout = '1s';
lock table public.ops_state in access exclusive mode nowait;
lock table internal.student_number_reservations in access exclusive mode nowait;
lock table internal.student_import_commits in access exclusive mode nowait;

alter table internal.student_number_reservations
  add column if not exists student_number_date_source text;

alter table internal.student_number_reservations
  add constraint student_number_reservations_date_source_check
  check (
    student_number_date_source is null
    or student_number_date_source in (
      'jwb_first_positive_contract',
      'formal_import_date',
      'system_entry_date'
    )
  );

create or replace function internal.student_number_reservation_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $student_number_reservation_snapshot$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'studentId', reservation.student_id,
    'studentNumber', reservation.student_number,
    'studentNumberDateSource', reservation.student_number_date_source
  )) order by internal.student_import_utf16_sort_key(reservation.student_id)), '[]'::jsonb)
  from internal.student_number_reservations reservation
$student_number_reservation_snapshot$;

revoke all on function internal.student_number_reservation_snapshot()
  from public, anon, authenticated;

-- The two-argument form is used only by formal roster commit/replay. It has a
-- caller-supplied-but-commit-verified Melbourne calendar day so the preview,
-- commit and lost-response replay can agree byte-for-byte even across
-- midnight. The one-argument compatibility wrapper below is retained for
-- older internal fixtures and never receives browser input.
create or replace function internal.student_import_assign_student_numbers(
  p_students jsonb,
  p_formal_import_date text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $student_numbers_with_formal_date$
declare
  student_item record;
  number_item record;
  reservation_item record;
  current_number text;
  current_date_source text;
  reserved_number text;
  reserved_student_id text;
  reserved_date_source text;
  date_key text;
  serial integer;
  serials jsonb := '{}'::jsonb;
  assignments jsonb := '{}'::jsonb;
  result jsonb := '[]'::jsonb;
  seen_ids text[] := array[]::text[];
  seen_numbers text[] := array[]::text[];
  reservation_by_student_id jsonb := '{}'::jsonb;
  reservation_by_number jsonb := '{}'::jsonb;
  reservation_date_source_by_student_id jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_students) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
  end if;
  if p_formal_import_date !~ '^\d{4}-\d{2}-\d{2}$'
     or to_char(to_date(p_formal_import_date, 'YYYY-MM-DD'), 'YYYY-MM-DD')
        <> p_formal_import_date then
    raise exception using errcode = '22023', message = 'student_import_formal_date_invalid';
  end if;

  -- The permanent reservation registry is both the non-reuse boundary and
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

    if student_item.value ? 'studentNumberDateSource'
       and (
         jsonb_typeof(student_item.value -> 'studentNumberDateSource') <> 'string'
         or student_item.value ->> 'studentNumberDateSource' not in (
           'jwb_first_positive_contract', 'formal_import_date'
           , 'system_entry_date'
         )
       ) then
      raise exception using errcode = '22023', message = 'student_number_date_source_invalid';
    end if;
    if student_item.value ? 'studentNumberDateSource'
       and not (student_item.value ? 'studentNumber') then
      raise exception using errcode = '22023', message = 'student_number_date_source_requires_number';
    end if;

    reserved_number := reservation_by_student_id ->> (student_item.value ->> 'id');
    reserved_date_source := reservation_date_source_by_student_id ->> (student_item.value ->> 'id');
    if student_item.value ? 'studentNumber' then
      if jsonb_typeof(student_item.value -> 'studentNumber') is distinct from 'string'
         or student_item.value ->> 'studentNumber' !~ '^[0-9]{11}$' then
        raise exception using errcode = '22023', message = 'student_number_invalid';
      end if;
      current_number := student_item.value ->> 'studentNumber';
      current_date_source := student_item.value ->> 'studentNumberDateSource';
      if current_number = any(seen_numbers) then
        raise exception using errcode = '23505', message = 'duplicate_student_number';
      end if;
      reserved_student_id := reservation_by_number ->> current_number;
      if (reserved_number is not null and reserved_number <> current_number)
         or (reserved_student_id is not null
             and reserved_student_id <> student_item.value ->> 'id')
         or (reserved_date_source is not null
             and current_date_source is not null
             and reserved_date_source <> current_date_source) then
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
  end loop;

  -- Only formal master records can receive a no-JWB fallback. Current manual
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

  -- A malformed explicit historical JWB date is not eligible above. Detect it
  -- explicitly so it cannot disappear from the candidate set and leave an
  -- unnumbered formal record without a deterministic failure.
  if exists (
    select 1
    from jsonb_array_elements(p_students) student(value)
    where coalesce(student.value ->> 'importSource', '') = 'master'
      and not (student.value ? 'studentNumber')
      and not (assignments ? (student.value ->> 'id'))
      and (student.value ? 'studentNumberJwbDateCandidate'
        or student.value ? 'firstJwbHourEntryDate')
  ) then
    raise exception using errcode = '22023', message = 'student_number_jwb_first_positive_date_invalid';
  end if;

  for student_item in
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
end;
$student_numbers_with_formal_date$;

create or replace function internal.student_import_assign_student_numbers(p_students jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $student_numbers_compatibility$
  select internal.student_import_assign_student_numbers(
    p_students,
    to_char(current_timestamp at time zone 'Australia/Melbourne', 'YYYY-MM-DD')
  )
$student_numbers_compatibility$;

revoke all on function internal.student_import_assign_student_numbers(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_assign_student_numbers(jsonb, text)
  from public, anon, authenticated;

-- Runs after the older allocation trigger (alphabetical trigger order) and
-- upgrades every newly issued generic/manual number to explicit provenance.
-- It also makes a source immutable and fills a legacy payload from its durable
-- reservation when one already exists. Old source-less rows remain valid; no
-- historical date is invented for them.
create or replace function internal.enforce_student_number_date_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $student_number_date_provenance$
declare
  student_item record;
  old_item jsonb;
  next_item jsonb;
  current_number text;
  current_source text;
  prior_source text;
  reserved_number text;
  reserved_student_id text;
  reserved_source text;
  next_payload jsonb := '[]'::jsonb;
begin
  if new.entity <> 'students' then
    return new;
  end if;
  if jsonb_typeof(new.payload) is distinct from 'array'
     or (tg_op = 'UPDATE' and jsonb_typeof(old.payload) is distinct from 'array') then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
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
    next_item := student_item.value;
    old_item := null;
    if tg_op = 'UPDATE' then
      select candidate.value into old_item
      from jsonb_array_elements(old.payload) candidate(value)
      where candidate.value ->> 'id' = next_item ->> 'id';
    end if;
    current_number := next_item ->> 'studentNumber';
    current_source := next_item ->> 'studentNumberDateSource';
    prior_source := old_item ->> 'studentNumberDateSource';
    if current_source is not null and current_source not in (
      'jwb_first_positive_contract', 'formal_import_date', 'system_entry_date'
    ) then
      raise exception using errcode = '22023', message = 'student_number_date_source_invalid';
    end if;
    if current_source is not null and current_number is null then
      raise exception using errcode = '22023', message = 'student_number_date_source_requires_number';
    end if;
    if prior_source is not null and current_source is distinct from prior_source then
      raise exception using errcode = '22023', message = 'student_number_date_source_immutable';
    end if;
    if current_number is not null then
      if current_number !~ '^[0-9]{11}$' then
        raise exception using errcode = '22023', message = 'student_number_invalid';
      end if;
      select reservation.student_number, reservation.student_id,
        reservation.student_number_date_source
      into reserved_number, reserved_student_id, reserved_source
      from internal.student_number_reservations reservation
      where reservation.student_id = next_item ->> 'id'
         or reservation.student_number = current_number
      order by case when reservation.student_id = next_item ->> 'id' then 0 else 1 end
      limit 1;
      if (reserved_number is not null and reserved_number <> current_number)
         or (reserved_student_id is not null and reserved_student_id <> next_item ->> 'id')
         or (reserved_source is not null and current_source is not null
             and reserved_source <> current_source) then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
      if current_source is null and reserved_source is not null then
        current_source := reserved_source;
        next_item := next_item || jsonb_build_object('studentNumberDateSource', current_source);
      elsif current_source is null and old_item is null
        and coalesce(next_item ->> 'importSource', '') <> 'master' then
        -- The older trigger allocated this number from the transaction's
        -- Melbourne system date. Label that fact explicitly for future users.
        current_source := 'system_entry_date';
        next_item := next_item || jsonb_build_object('studentNumberDateSource', current_source);
      elsif current_source is null and prior_source is not null then
        current_source := prior_source;
        next_item := next_item || jsonb_build_object('studentNumberDateSource', current_source);
      end if;

      insert into internal.student_number_reservations(
        student_number, student_id, student_number_date_source
      ) values (
        current_number, next_item ->> 'id', current_source
      ) on conflict (student_number) do update
      set student_number_date_source = coalesce(
        internal.student_number_reservations.student_number_date_source,
        excluded.student_number_date_source
      )
      where internal.student_number_reservations.student_id = excluded.student_id;

      select reservation.student_number, reservation.student_id,
        reservation.student_number_date_source
      into reserved_number, reserved_student_id, reserved_source
      from internal.student_number_reservations reservation
      where reservation.student_number = current_number;
      if reserved_number is distinct from current_number
         or reserved_student_id is distinct from next_item ->> 'id'
         or (current_source is not null and reserved_source is distinct from current_source) then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
    elsif current_source is not null then
      raise exception using errcode = '22023', message = 'student_number_date_source_requires_number';
    end if;
    next_payload := next_payload || jsonb_build_array(next_item);
  end loop;
  new.payload := next_payload;
  return new;
end;
$student_number_date_provenance$;

revoke all on function internal.enforce_student_number_date_provenance()
  from public, anon, authenticated;

create trigger ops_state_enforce_student_number_date_provenance
before insert or update of payload on public.ops_state
for each row execute function internal.enforce_student_number_date_provenance();

-- Keep all non-empty master names eligible for duplicate review. A duplicate
-- remains a hard clerical conflict until an explicit reviewed decision; the
-- change here is only that inactive named rows participate too.
create or replace function internal.student_import_master_duplicate_candidates(
  p_master internal.student_import_source_rows,
  p_students public.ops_state
)
returns jsonb
language sql
stable
set search_path = ''
as $master_duplicate_candidates_all_named$
  with eligible as (
    select row_item.value as row_value,
      row_item.value -> 'sourceRow' as source_row,
      row_item.value ->> 'sourceRow' as source_row_text,
      internal.student_import_name_key(row_item.value ->> 'name') as name_key
    from jsonb_array_elements(p_master.rows) row_item(value)
    where internal.student_import_name_key(row_item.value ->> 'name') <> ''
  ), duplicate_groups as (
    select name_key,
      jsonb_agg(source_row order by internal.student_import_utf16_sort_key(source_row_text)) as source_rows,
      jsonb_agg(row_value order by internal.student_import_utf16_sort_key(source_row_text)) as source_values
    from eligible group by name_key having count(*) > 1
  ), group_options as (
    select g.*,
      internal.student_import_master_duplicate_key(
        p_master.source_id, p_master.revision, p_students.version, g.source_rows
      ) as group_key
    from duplicate_groups g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'resolutionGroupKey', group_key,
    'sourceRows', source_rows,
    'options', (
      select coalesce(jsonb_agg(option_value order by option_value ->> 'resolutionKey'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'resolutionKey', internal.student_import_master_duplicate_key(
            p_master.source_id, p_master.revision, p_students.version, source_rows,
            'select', source_value ->> 'sourceRow', case when trim(coalesce(source_value ->> 'status', '')) = '' then status_value else null end
          ),
          'decision', 'select',
          'selectedSourceRow', source_value -> 'sourceRow',
          'selectedStatus', case when trim(coalesce(source_value ->> 'status', '')) = '' then to_jsonb(status_value) else null end
        ) as option_value
        from jsonb_array_elements(source_values) source_value
        cross join lateral unnest(case
          when trim(coalesce(source_value ->> 'status', '')) = '' then array[
            '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
            '不活跃 + 有课时', '在读 + 加课待排'
          ]::text[] else array[null]::text[] end
        ) status_value
        union all
        select jsonb_build_object(
          'resolutionKey', internal.student_import_master_duplicate_key(
            p_master.source_id, p_master.revision, p_students.version, source_rows, 'ignore'
          ),
          'decision', 'ignore'
        )
      ) options
    )
  ) order by group_key), '[]'::jsonb)
  from group_options
$master_duplicate_candidates_all_named$;

revoke all on function internal.student_import_master_duplicate_candidates(
  internal.student_import_source_rows, public.ops_state
) from public, anon, authenticated;

-- A member ID is a strict enrichment selector, not an import-existence gate.
-- Keep malformed values/duplicate declared IDs fail-closed as source errors,
-- but unknown/cross-name IDs merely cause the JWB leg to be ignored.
create or replace function internal.student_import_master_jwb_member_id_error(
  p_master_rows jsonb,
  p_jwb_rows jsonb,
  p_identity_links jsonb
)
returns text
language sql
immutable
set search_path = ''
as $master_jwb_member_id_structural_error$
  select case
    when jsonb_typeof(p_master_rows) <> 'array'
      or jsonb_typeof(p_jwb_rows) <> 'array'
      or jsonb_typeof(p_identity_links) <> 'array'
    then 'invalid_student_import_master_jwb_member_id'
    when exists (
      select 1
      from jsonb_array_elements(p_master_rows) master(value)
      where master.value ? 'jwbMemId'
        and (
          jsonb_typeof(master.value -> 'jwbMemId') not in ('string', 'number', 'null')
          or (
            jsonb_typeof(master.value -> 'jwbMemId') = 'number'
            and internal.student_import_source_key(master.value -> 'jwbMemId') is null
          )
          or (
            jsonb_typeof(master.value -> 'jwbMemId') = 'string'
            and nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
            and master.value ->> 'jwbMemId' <> internal.student_import_source_key(master.value -> 'jwbMemId')
          )
        )
    ) then 'invalid_student_import_master_jwb_member_id'
    when (
      select count(*)
      from jsonb_array_elements(p_master_rows) master(value)
      where nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
    ) <> (
      select count(distinct internal.student_import_source_key(master.value -> 'jwbMemId'))
      from jsonb_array_elements(p_master_rows) master(value)
      where nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
    ) then 'duplicate_student_import_master_jwb_member_id'
    else null
  end
$master_jwb_member_id_structural_error$;

revoke all on function internal.student_import_master_jwb_member_id_error(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- These server-owned fields may never be supplied through master/JWB
-- attributes. The transient candidate exists only inside canonical allocation
-- and is stripped by the number allocator before client equality comparison.
create or replace function internal.student_import_managed_fields()
returns text[]
language sql
immutable
set search_path = ''
as $student_import_managed_fields_v9$
  select array[
    'id', 'studentNumber', 'studentNumberDateSource', 'name', 'status',
    'sourceRow', 'masterSourceKey', 'importSource', 'jwbMatchStatus',
    'jwbSourceRow', 'remainingHours', 'contractHours',
    'contractEffectiveDate', 'firstJwbHourEntryDate',
    'historicalJwbSnapshot', 'studentNumberJwbDateCandidate',
    'lessonPackages', 'packageCoverage', 'importArchived',
    'importArchivedReason'
  ]::text[]
$student_import_managed_fields_v9$;

revoke all on function internal.student_import_managed_fields()
  from public, anon, authenticated;

-- Clone and narrowly patch the currently deployed canonical projection before
-- wrapping its JWB-ledger output below. This keeps all reviewed annotation and
-- identity hardening from the preceding migrations while changing only this
-- authorized master-first policy. Every anchor is counted and fails closed.
do $master_authoritative_projection_base$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_missing';
  end if;

  anchor := E'    if clean_name = \'\' or row_value ->> \'status\' = \'不活跃 + 无课时\' then\n      continue;\n    end if;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_inactive_projection_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, E'    if clean_name = \'\' then\n      continue;\n    end if;');

  anchor := E'  master_jwb_member_id_error text;\n  preserve_existing_aggregate boolean;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_member_id_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, E'  master_jwb_member_id_error text;\n  master_jwb_member_id_safe boolean;\n  preserve_existing_aggregate boolean;');

  anchor := E'    master_jwb_member_id := nullif(\n      internal.student_import_source_key(row_value -> \'jwbMemId\'), \'\'\n    );';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_member_id_assignment_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, anchor || $safe_member_id$
    master_jwb_member_id_safe := master_jwb_member_id is null or exists (
      select 1
      from jsonb_array_elements(p_jwb_rows) candidate
      where internal.student_import_source_key(candidate -> 'sourceRow') = master_jwb_member_id
        and internal.student_import_name_key(row_value ->> 'name') <> ''
        and internal.student_import_name_key(row_value ->> 'name') =
          internal.student_import_name_key(candidate ->> 'name')
    );$safe_member_id$);

  anchor := 'if linked and identity_link ? ''jwbSourceRow'' then';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_linked_member_id_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, 'if linked and identity_link ? ''jwbSourceRow'' and master_jwb_member_id_safe then');

  anchor := 'elsif master_jwb_member_id is not null then';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_member_id_branch_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, 'elsif master_jwb_member_id is not null and master_jwb_member_id_safe then');

  anchor := 'elsif not linked then';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_automatic_member_id_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, 'elsif not linked and master_jwb_member_id_safe then');

  anchor := E'        and candidate ->> \'status\' <> \'不活跃 + 无课时\'\n';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_auto_inactive_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '');

  anchor := 'internal.student_import_canonical_projection(';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_rename_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, 'internal.student_import_canonical_projection_170008_base(');
  execute definition;
end;
$master_authoritative_projection_base$;

-- Build local lookup maps inside the validated base projection. The detailed
-- replacements below retain its validators and output loop while avoiding a
-- full JSON-array scan for each formal master row.
do $master_authoritative_projection_lookup_maps$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_base_missing';
  end if;

  anchor := $projection_maps_anchor$  master_jwb_member_id_safe boolean;
  preserve_existing_aggregate boolean;
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$  master_jwb_member_id_safe boolean;
  link_by_master jsonb := '{}'::jsonb;
  student_by_id jsonb := '{}'::jsonb;
  jwb_by_source jsonb := '{}'::jsonb;
  linked_jwb_source_ids jsonb := '{}'::jsonb;
  declared_member_ids jsonb := '{}'::jsonb;
  master_auto_name_counts jsonb := '{}'::jsonb;
  jwb_auto_name_entries jsonb := '{}'::jsonb;
  preserve_existing_aggregate boolean;
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$  if master_jwb_member_id_error is not null then
    raise exception using errcode = '22023', message = master_jwb_member_id_error;
  end if;
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_initialization_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$  if master_jwb_member_id_error is not null then
    raise exception using errcode = '22023', message = master_jwb_member_id_error;
  end if;

  -- All inputs used below already passed the base shape/key/link validation.
  -- Use first source ordinality where the old SELECT INTO implicitly chose a
  -- source row, preserving source-array ordering deterministically.
  select coalesce(jsonb_object_agg(
    internal.student_import_source_key(link -> 'masterSourceRow'), link
  ), '{}'::jsonb)
  into link_by_master
  from jsonb_array_elements(p_identity_links) link;

  select coalesce(jsonb_object_agg(
    internal.student_import_source_key(link -> 'jwbSourceRow'), 'true'::jsonb
  ) filter (where link ? 'jwbSourceRow'), '{}'::jsonb)
  into linked_jwb_source_ids
  from jsonb_array_elements(p_identity_links) link;

  select coalesce(jsonb_object_agg(
    internal.student_import_source_key(jwb -> 'sourceRow'), jwb
  ), '{}'::jsonb)
  into jwb_by_source
  from jsonb_array_elements(p_jwb_rows) jwb;

  with candidates as (
    select student.value as student_value,
      student.ordinality as ordinal,
      student.value ->> 'id' as candidate_id
    from jsonb_array_elements(p_current_students) with ordinality student(value, ordinality)
    where jsonb_typeof(student.value) = 'object'
      and nullif(trim(student.value ->> 'id'), '') is not null
  ), first_rows as (
    select distinct on (candidate_id) candidate_id, student_value
    from candidates
    order by candidate_id, ordinal
  )
  select coalesce(jsonb_object_agg(candidate_id, student_value), '{}'::jsonb)
  into student_by_id
  from first_rows;

  select coalesce(jsonb_object_agg(member_id, 'true'::jsonb), '{}'::jsonb)
  into declared_member_ids
  from (
    select distinct nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') as member_id
    from jsonb_array_elements(p_resolved_master_rows) master
  ) declared
  where member_id is not null;

  with candidates as (
    select internal.student_import_name_key(master ->> 'name') as auto_name_key
    from jsonb_array_elements(p_resolved_master_rows) master
    where internal.student_import_display_name(master ->> 'name') <> ''
      and nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') is null
      and not (link_by_master ? internal.student_import_source_key(master -> 'sourceRow'))
  ), grouped as (
    select auto_name_key, count(*)::integer as name_count
    from candidates
    group by auto_name_key
  )
  select coalesce(jsonb_object_agg(auto_name_key, to_jsonb(name_count)), '{}'::jsonb)
  into master_auto_name_counts
  from grouped;

  with candidates as (
    select jwb.value as candidate_row,
      jwb.ordinality as ordinal,
      internal.student_import_name_key(jwb.value ->> 'name') as auto_name_key
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinality)
    where internal.student_import_display_name(jwb.value ->> 'name') <> ''
      and not (linked_jwb_source_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))
      and not (declared_member_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))
  ), grouped as (
    select auto_name_key, count(*)::integer as name_count,
      (jsonb_agg(candidate_row order by ordinal) -> 0) as candidate_row
    from candidates
    group by auto_name_key
  )
  select coalesce(jsonb_object_agg(
    auto_name_key, jsonb_build_object('count', name_count, 'row', candidate_row)
  ), '{}'::jsonb)
  into jwb_auto_name_entries
  from grouped;
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$    if (select count(*) from jsonb_array_elements(p_resolved_master_rows) candidate
        where internal.student_import_source_key(candidate -> 'sourceRow') = raw_source_key) <> 1 then
      raise exception using errcode = '22023', message = 'duplicate_student_import_master_source_key';
    end if;
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_master_key_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$    -- The input-wide key check above already proves master source uniqueness.
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$    identity_link := null;
    select link into identity_link
    from jsonb_array_elements(p_identity_links) link
    where internal.student_import_source_key(link -> 'masterSourceRow') = raw_source_key;
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_link_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$    identity_link := link_by_master -> raw_source_key;
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$    existing_student := null;
    select student into existing_student
    from jsonb_array_elements(p_current_students) student
    where student ->> 'id' = student_id
      and (linked or (
        student ->> 'masterSourceKey' = master_key
        and student ->> 'id' = internal.student_import_student_id(p_master_source_id, row_value -> 'sourceRow')
      ));
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_student_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$    existing_student := student_by_id -> student_id;
    if not linked and (
      existing_student is null
      or existing_student ->> 'masterSourceKey' is distinct from master_key
      or existing_student ->> 'id' is distinct from internal.student_import_student_id(
        p_master_source_id, row_value -> 'sourceRow'
      )
    ) then
      existing_student := null;
    end if;
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$    master_jwb_member_id_safe := master_jwb_member_id is null or exists (
      select 1
      from jsonb_array_elements(p_jwb_rows) candidate
      where internal.student_import_source_key(candidate -> 'sourceRow') = master_jwb_member_id
        and internal.student_import_name_key(row_value ->> 'name') <> ''
        and internal.student_import_name_key(row_value ->> 'name') =
          internal.student_import_name_key(candidate ->> 'name')
    );
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_member_id_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$    master_jwb_member_id_safe := master_jwb_member_id is null or (
      jwb_by_source ? master_jwb_member_id
      and (
        (
          internal.student_import_name_key(row_value ->> 'name') <> ''
          and internal.student_import_name_key(row_value ->> 'name') =
            internal.student_import_name_key((jwb_by_source -> master_jwb_member_id) ->> 'name')
        )
        -- The wrapper keeps this labelled exception only after its set-wise
        -- source-wide v1 annotation proof; the base's global validator runs
        -- before this loop as a second fail-closed check.  A reviewed
        -- Alice→Alice(VIC) member-ID link is therefore safe, while an
        -- unreviewed or cross-name member ID remains supplemental-only.
        or (
          linked
          and identity_link ? 'jwbSourceRow'
          and internal.student_import_source_key(identity_link -> 'jwbSourceRow') =
            master_jwb_member_id
          and identity_link ->> 'matchStrategy' =
            'jwb_latin_parenthetical_annotation_v1'
        )
      )
    );
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(identity_link -> 'jwbSourceRow');
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_linked_jwb_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$      matched_jwb := jwb_by_source ->
        internal.student_import_source_key(identity_link -> 'jwbSourceRow');
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') = master_jwb_member_id;
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_member_jwb_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$      matched_jwb := jwb_by_source -> master_jwb_member_id;
$projection_maps_replacement$);

  anchor := $projection_maps_anchor$    elsif not linked and master_jwb_member_id_safe then
      select count(*) into master_name_count
      from jsonb_array_elements(p_resolved_master_rows) candidate
      where internal.student_import_display_name(candidate ->> 'name') <> ''
        and internal.student_import_name_key(candidate ->> 'name') = name_key
        and not (
          candidate ? 'jwbMemId'
          and nullif(internal.student_import_source_key(candidate -> 'jwbMemId'), '') is not null
        )
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where internal.student_import_source_key(link -> 'masterSourceRow') =
            internal.student_import_source_key(candidate -> 'sourceRow')
        );
      select count(*) into jwb_name_count
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_display_name(jwb ->> 'name') <> ''
        and internal.student_import_name_key(jwb ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where link ? 'jwbSourceRow'
            and internal.student_import_source_key(link -> 'jwbSourceRow') =
              internal.student_import_source_key(jwb -> 'sourceRow')
        )
        and not exists (
          select 1
          from jsonb_array_elements(p_resolved_master_rows) authoritative_master
          where nullif(internal.student_import_source_key(
            authoritative_master -> 'jwbMemId'
          ), '') = internal.student_import_source_key(jwb -> 'sourceRow')
        );
      if master_name_count = 1 and jwb_name_count = 1 then
        select jwb into matched_jwb
        from jsonb_array_elements(p_jwb_rows) jwb
        where internal.student_import_name_key(jwb ->> 'name') = name_key
          and not exists (
            select 1 from jsonb_array_elements(p_identity_links) link
            where link ? 'jwbSourceRow'
              and internal.student_import_source_key(link -> 'jwbSourceRow') =
                internal.student_import_source_key(jwb -> 'sourceRow')
          )
          and not exists (
            select 1
            from jsonb_array_elements(p_resolved_master_rows) authoritative_master
            where nullif(internal.student_import_source_key(
              authoritative_master -> 'jwbMemId'
            ), '') = internal.student_import_source_key(jwb -> 'sourceRow')
          );
      end if;
$projection_maps_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_projection_maps_auto_match_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_maps_replacement$    elsif not linked and master_jwb_member_id_safe then
      master_name_count := coalesce((master_auto_name_counts ->> name_key)::integer, 0);
      jwb_name_count := coalesce(
        ((jwb_auto_name_entries -> name_key) ->> 'count')::integer, 0
      );
      if master_name_count = 1 and jwb_name_count = 1 then
        matched_jwb := (jwb_auto_name_entries -> name_key) -> 'row';
      end if;
$projection_maps_replacement$);

  execute definition;
end;
$master_authoritative_projection_lookup_maps$;

revoke all on function internal.student_import_canonical_projection_170008_base(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;

-- The active student ledger is deliberately narrower than the evidence we
-- retain from JWB.  A stale or aggregate-only JWB extract is useful history,
-- but it must not remain selectable by booking/settlement merely because an
-- older import happened to place it in lessonPackages.  These helpers keep
-- that history in a separately-shaped, server-owned snapshot.
create or replace function internal.student_import_historical_jwb_facts(
  p_facts jsonb,
  p_allow_lesson_packages boolean default true
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $historical_jwb_facts$
declare
  package_item jsonb;
  result jsonb;
begin
  if p_facts is null or p_facts = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p_facts) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_facts) key
       where key not in (
         'lessonPackages', 'remainingHours', 'contractHours',
         'contractEffectiveDate', 'firstJwbHourEntryDate',
         'packageCoverage', 'jwbSourceRow'
       )
     )
     or (p_facts ? 'lessonPackages' and (
       not p_allow_lesson_packages
       or jsonb_typeof(p_facts -> 'lessonPackages') <> 'array'
     ))
     or (p_facts ? 'remainingHours' and jsonb_typeof(p_facts -> 'remainingHours') <> 'number')
     or (p_facts ? 'contractHours' and (
       jsonb_typeof(p_facts -> 'contractHours') <> 'number'
       or (p_facts ->> 'contractHours')::numeric < 0
     ))
     or (p_facts ? 'contractEffectiveDate' and (
       jsonb_typeof(p_facts -> 'contractEffectiveDate') <> 'string'
       or nullif(btrim(p_facts ->> 'contractEffectiveDate'), '') is null
       or length(btrim(p_facts ->> 'contractEffectiveDate')) > 240
     ))
     or (p_facts ? 'firstJwbHourEntryDate' and (
       jsonb_typeof(p_facts -> 'firstJwbHourEntryDate') <> 'string'
       or nullif(btrim(p_facts ->> 'firstJwbHourEntryDate'), '') is null
       or length(btrim(p_facts ->> 'firstJwbHourEntryDate')) > 240
     ))
     or (p_facts ? 'packageCoverage' and p_facts ->> 'packageCoverage' not in (
       'complete', 'partial', 'none'
     ))
     or (p_facts ? 'jwbSourceRow'
       and internal.student_import_source_key(p_facts -> 'jwbSourceRow') is null)
  then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_historical_jwb_snapshot';
  end if;

  if p_facts ? 'lessonPackages' then
    for package_item in select value from jsonb_array_elements(p_facts -> 'lessonPackages') value
    loop
      if jsonb_typeof(package_item) <> 'object'
         or coalesce(package_item ->> 'id', '') not like 'PKG-JWB-%' then
        raise exception using errcode = '22023',
          message = 'invalid_student_import_historical_jwb_package';
      end if;
    end loop;
    -- This also rejects malformed old purchase/consumption numbers before a
    -- snapshot can become durable read-only evidence.
    if jsonb_array_length(p_facts -> 'lessonPackages') > 0 then
      perform internal.student_import_package_totals(p_facts -> 'lessonPackages');
    end if;
  end if;

  result := jsonb_strip_nulls(p_facts);
  if result ? 'lessonPackages' and jsonb_array_length(result -> 'lessonPackages') = 0 then
    result := result - 'lessonPackages';
  end if;
  if result = '{}'::jsonb then
    return null;
  end if;
  return result;
end;
$historical_jwb_facts$;

create or replace function internal.student_import_historical_jwb_snapshot(
  p_snapshot jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $historical_jwb_snapshot$
declare
  retained jsonb;
  current_aggregate jsonb;
begin
  if p_snapshot is null or p_snapshot = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p_snapshot) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_snapshot) key
       where key not in ('retained', 'currentAggregate')
     ) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_historical_jwb_snapshot';
  end if;
  retained := internal.student_import_historical_jwb_facts(p_snapshot -> 'retained', true);
  current_aggregate := internal.student_import_historical_jwb_facts(
    p_snapshot -> 'currentAggregate', false
  );
  if retained is null and current_aggregate is null then
    return null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'retained', retained,
    'currentAggregate', current_aggregate
  ));
end;
$historical_jwb_snapshot$;

create or replace function internal.student_import_merge_historical_jwb_facts(
  p_prior jsonb,
  p_displaced jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $merge_historical_jwb_facts$
declare
  prior_facts jsonb;
  displaced_facts jsonb;
  result jsonb;
  merged_packages jsonb;
begin
  prior_facts := internal.student_import_historical_jwb_facts(p_prior, true);
  displaced_facts := internal.student_import_historical_jwb_facts(p_displaced, true);
  if prior_facts is null then
    return displaced_facts;
  end if;
  if displaced_facts is null then
    return prior_facts;
  end if;

  result := prior_facts || displaced_facts;
  if prior_facts ? 'lessonPackages' or displaced_facts ? 'lessonPackages' then
    with all_packages as (
      select value, ordinal::integer as sequence
      from jsonb_array_elements(coalesce(prior_facts -> 'lessonPackages', '[]'::jsonb))
        with ordinality package(value, ordinal)
      union all
      select value, 1000000 + ordinal::integer as sequence
      from jsonb_array_elements(coalesce(displaced_facts -> 'lessonPackages', '[]'::jsonb))
        with ordinality package(value, ordinal)
    ), selected as (
      select value ->> 'id' as package_id,
        (array_agg(value order by sequence desc))[1] as value,
        min(sequence) as first_sequence
      from all_packages
      group by value ->> 'id'
    )
    select coalesce(jsonb_agg(value order by first_sequence), '[]'::jsonb)
    into merged_packages
    from selected;
    if jsonb_array_length(merged_packages) > 0 then
      result := jsonb_set(result, '{lessonPackages}', merged_packages, true);
    else
      result := result - 'lessonPackages';
    end if;
  end if;
  return internal.student_import_historical_jwb_facts(result, true);
end;
$merge_historical_jwb_facts$;

-- Apply the active-ledger rules after the hardened base projection has made
-- its exact master/JWB identity decision.  The base emits every named master
-- row; this wrapper only decides which safely sourced JWB facts may remain
-- active.  Historical snapshots are never read by booking/capacity/settlement
-- code, which only consumes top-level lessonPackages and aggregates.
create or replace function internal.student_import_canonical_projection(
  p_master_source_id text,
  p_resolved_master_rows jsonb,
  p_jwb_rows jsonb,
  p_current_students jsonb,
  p_identity_links jsonb,
  p_referenced_student_ids jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $master_authoritative_projection$
declare
  base_projection jsonb;
  projection_item record;
  base_student jsonb;
  record_value jsonb;
  existing_student jsonb;
  matched_jwb jsonb;
  existing_packages jsonb;
  manual_packages jsonb;
  existing_jwb_packages jsonb;
  active_jwb_packages jsonb;
  displaced_jwb_packages jsonb;
  active_packages jsonb;
  active_totals jsonb;
  existing_snapshot jsonb;
  existing_coverage text;
  current_coverage text;
  retained_facts jsonb;
  displaced_facts jsonb;
  current_aggregate jsonb;
  snapshot jsonb;
  complete_ledger boolean;
  partial_ledger boolean;
  source_remaining numeric;
  source_contract numeric;
  safe_identity_links jsonb := '[]'::jsonb;
  result jsonb := '[]'::jsonb;
begin
  -- A reviewed master→existing identity remains useful when its optional JWB
  -- leg has gone stale.  Build that downgrade map set-wise: current source
  -- sizes are about 543 master rows, 1038 JWB rows and 341 reviewed links, so
  -- a per-link scan of all three arrays is needlessly quadratic.  The active
  -- link set is source-revision-bound and its write trigger already proved an
  -- exact/annotation strategy; the hardened base validates the retained set
  -- once.  This pass only removes a structurally valid optional JWB leg that
  -- is now stale, member-ID-conflicting, or no longer satisfies the exact / v1
  -- annotation identity proof.  Malformed link shapes remain untouched for
  -- the hardened base validators to reject fail-closed.
  with links as (
    select link.value as raw_link,
      link.ordinality as ordinal,
      internal.student_import_source_key(link.value -> 'masterSourceRow') as master_key,
      internal.student_import_source_key(link.value -> 'jwbSourceRow') as jwb_key,
      jsonb_typeof(link.value) = 'object' and link.value ? 'jwbSourceRow' as has_jwb_leg
    from jsonb_array_elements(p_identity_links) with ordinality link(value, ordinality)
  ), master_rows as (
    select internal.student_import_source_key(master.value -> 'sourceRow') as source_key,
      count(*)::integer as source_count,
      (jsonb_agg(master.value order by master.ordinality) -> 0) as row_value
    from jsonb_array_elements(p_resolved_master_rows) with ordinality master(value, ordinality)
    group by internal.student_import_source_key(master.value -> 'sourceRow')
  ), jwb_rows as (
    select internal.student_import_source_key(jwb.value -> 'sourceRow') as source_key,
      count(*)::integer as source_count,
      (jsonb_agg(jwb.value order by jwb.ordinality) -> 0) as row_value
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinality)
    group by internal.student_import_source_key(jwb.value -> 'sourceRow')
  ), master_link_counts as (
    select master_key, count(*)::integer as link_count
    from links
    where master_key is not null and master_key <> ''
    group by master_key
  ), jwb_link_counts as (
    select jwb_key, count(*)::integer as link_count
    from links
    where has_jwb_leg and jwb_key is not null
    group by jwb_key
  ), master_annotation_counts as (
    select internal.student_import_jwb_annotation_relaxed_name_key(
      master.value ->> 'name'
    ) as relaxed_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_resolved_master_rows) master(value)
    group by internal.student_import_jwb_annotation_relaxed_name_key(master.value ->> 'name')
  ), jwb_annotation_counts as (
    select internal.student_import_jwb_annotation_relaxed_name_key(
      jwb.value ->> 'name'
    ) as relaxed_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_jwb_rows) jwb(value)
    group by internal.student_import_jwb_annotation_relaxed_name_key(jwb.value ->> 'name')
  ), evaluated_links as (
    select links.*,
      master_rows.source_count as master_source_count,
      master_rows.row_value as master_row,
      jwb_rows.source_count as jwb_source_count,
      jwb_rows.row_value as jwb_row,
      master_link_counts.link_count as master_link_count,
      jwb_link_counts.link_count as jwb_link_count,
      internal.student_import_name_key(master_rows.row_value ->> 'name') as master_name_key,
      internal.student_import_name_key(jwb_rows.row_value ->> 'name') as jwb_name_key,
      internal.student_import_jwb_latin_parenthetical_annotation_key(
        jwb_rows.row_value ->> 'name'
      ) as jwb_annotation_key,
      internal.student_import_display_name(master_rows.row_value ->> 'name') as master_display_name
    from links
    left join master_rows on master_rows.source_key is not distinct from links.master_key
    left join jwb_rows on jwb_rows.source_key is not distinct from links.jwb_key
    left join master_link_counts on master_link_counts.master_key = links.master_key
    left join jwb_link_counts on jwb_link_counts.jwb_key = links.jwb_key
  ), link_safety as (
    select evaluated_links.*,
      master_annotation_counts.row_count as master_annotation_count,
      jwb_annotation_counts.row_count as jwb_annotation_count,
      -- These checks deliberately mirror the source-wide validator's
      -- structural boundary.  Once they pass, a bad optional JWB leg can be
      -- safely removed without hiding malformed reviewed-link input.
      (
        jsonb_typeof(raw_link) = 'object'
        and has_jwb_leg
        and master_key is not null and master_key <> ''
        and jwb_key is not null and jwb_key <> ''
        and master_source_count = 1
        and coalesce(master_link_count, 0) = 1
        and coalesce(jwb_source_count, 0) <= 1
        and (
          not (raw_link ? 'matchStrategy')
          or (
            jsonb_typeof(raw_link -> 'matchStrategy') = 'string'
            and raw_link ->> 'matchStrategy' =
              'jwb_latin_parenthetical_annotation_v1'
          )
        )
      ) as downgradeable
    from evaluated_links
    left join master_annotation_counts
      on master_annotation_counts.relaxed_key = evaluated_links.master_name_key
    left join jwb_annotation_counts
      on jwb_annotation_counts.relaxed_key = evaluated_links.master_name_key
  )
  select coalesce(jsonb_agg(
    case
      when downgradeable
        and coalesce(jwb_link_count, 0) = 1
        and jwb_source_count = 1
        and (
          nullif(internal.student_import_source_key(master_row -> 'jwbMemId'), '') is null
          or nullif(internal.student_import_source_key(master_row -> 'jwbMemId'), '') = jwb_key
        )
        and (
          (
            not (raw_link ? 'matchStrategy')
            and master_name_key <> ''
            and master_name_key = jwb_name_key
          )
          or (
            raw_link ->> 'matchStrategy' =
              'jwb_latin_parenthetical_annotation_v1'
            and position('(' in master_display_name) = 0
            and position(')' in master_display_name) = 0
            and master_name_key <> ''
            and master_name_key <> jwb_name_key
            and master_name_key = jwb_annotation_key
            and coalesce(master_annotation_count, 0) = 1
            and coalesce(jwb_annotation_count, 0) = 1
          )
        )
      then raw_link
      -- A JWB identity reused by multiple otherwise-valid master links is
      -- optional-enrichment ambiguity.  Strip *every* JWB leg (rather than
      -- retaining the first and letting the base one-to-one validator fail),
      -- while preserving a safe master→existing relationship.
      when downgradeable then raw_link - 'jwbSourceRow' - 'matchStrategy'
      else raw_link
    end order by ordinal
  ), '[]'::jsonb)
  into safe_identity_links
  from link_safety;

  base_projection := internal.student_import_canonical_projection_170008_base(
    p_master_source_id,
    p_resolved_master_rows,
    p_jwb_rows,
    p_current_students,
    safe_identity_links,
    p_referenced_student_ids
  );

  for projection_item in
    select value, ordinal
    from jsonb_array_elements(base_projection) with ordinality item(value, ordinal)
    order by ordinal
  loop
    base_student := projection_item.value;
    if base_student ->> 'importSource' <> 'master' then
      result := result || jsonb_build_array(base_student);
      continue;
    end if;

    existing_student := null;
    select student into existing_student
    from jsonb_array_elements(p_current_students) student
    where student ->> 'id' = base_student ->> 'id';

    matched_jwb := null;
    if base_student ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(base_student -> 'jwbSourceRow');
    end if;

    existing_packages := case
      when jsonb_typeof(existing_student -> 'lessonPackages') = 'array'
        then existing_student -> 'lessonPackages'
      else '[]'::jsonb
    end;
    select coalesce(jsonb_agg(value order by ordinal), '[]'::jsonb)
    into manual_packages
    from jsonb_array_elements(existing_packages) with ordinality package(value, ordinal)
    where coalesce(value ->> 'id', '') not like 'PKG-JWB-%';
    select coalesce(jsonb_agg(value order by ordinal), '[]'::jsonb)
    into existing_jwb_packages
    from jsonb_array_elements(existing_packages) with ordinality package(value, ordinal)
    where coalesce(value ->> 'id', '') like 'PKG-JWB-%';

    current_coverage := case
      when matched_jwb is not null and matched_jwb ->> 'packageCoverage' in ('complete', 'partial', 'none')
        then matched_jwb ->> 'packageCoverage'
      when matched_jwb is not null and matched_jwb ? 'lessonPackages'
        then 'complete'
      else null
    end;
    active_jwb_packages := case
      when matched_jwb is not null
       and matched_jwb ? 'lessonPackages'
       and current_coverage in ('complete', 'partial')
        then internal.student_import_canonical_jwb_packages(
          base_student ->> 'id', matched_jwb -> 'lessonPackages'
        )
      else '[]'::jsonb
    end;
    complete_ledger := current_coverage = 'complete'
      and matched_jwb is not null and matched_jwb ? 'lessonPackages';
    partial_ledger := current_coverage = 'partial'
      and matched_jwb is not null and matched_jwb ? 'lessonPackages';

    if complete_ledger then
      displaced_jwb_packages := '[]'::jsonb;
    elsif partial_ledger then
      select coalesce(jsonb_agg(old_package.value order by old_package.ordinal), '[]'::jsonb)
      into displaced_jwb_packages
      from jsonb_array_elements(existing_jwb_packages) with ordinality old_package(value, ordinal)
      where not exists (
        select 1
        from jsonb_array_elements(active_jwb_packages) new_package(value)
        where new_package.value ->> 'id' = old_package.value ->> 'id'
      );
    else
      displaced_jwb_packages := existing_jwb_packages;
    end if;

    existing_coverage := case when existing_student ->> 'packageCoverage' in (
      'complete', 'partial', 'none'
    ) then existing_student ->> 'packageCoverage' else null end;
    existing_snapshot := internal.student_import_historical_jwb_snapshot(
      existing_student -> 'historicalJwbSnapshot'
    );
    displaced_facts := null;
    if not complete_ledger and (
      jsonb_array_length(displaced_jwb_packages) > 0
      or jsonb_typeof(existing_student -> 'remainingHours') = 'number'
      or jsonb_typeof(existing_student -> 'contractHours') = 'number'
      or (jsonb_typeof(existing_student -> 'contractEffectiveDate') = 'string'
        and nullif(btrim(existing_student ->> 'contractEffectiveDate'), '') is not null)
      or (jsonb_typeof(existing_student -> 'firstJwbHourEntryDate') = 'string'
        and nullif(btrim(existing_student ->> 'firstJwbHourEntryDate'), '') is not null)
      or existing_coverage is not null
    ) then
      displaced_facts := internal.student_import_historical_jwb_facts(
        jsonb_strip_nulls(jsonb_build_object(
          'lessonPackages', case when jsonb_array_length(displaced_jwb_packages) > 0
            then displaced_jwb_packages else null end,
          'remainingHours', case when jsonb_typeof(existing_student -> 'remainingHours') = 'number'
            then existing_student -> 'remainingHours' else null end,
          'contractHours', case when jsonb_typeof(existing_student -> 'contractHours') = 'number'
            then existing_student -> 'contractHours' else null end,
          'contractEffectiveDate', case when jsonb_typeof(existing_student -> 'contractEffectiveDate') = 'string'
            then btrim(existing_student ->> 'contractEffectiveDate') else null end,
          'firstJwbHourEntryDate', case when jsonb_typeof(existing_student -> 'firstJwbHourEntryDate') = 'string'
            then btrim(existing_student ->> 'firstJwbHourEntryDate') else null end,
          'packageCoverage', existing_coverage,
          'jwbSourceRow', case when existing_student ? 'jwbSourceRow'
            then existing_student -> 'jwbSourceRow' else null end
        )), true
      );
    end if;
    retained_facts := internal.student_import_merge_historical_jwb_facts(
      existing_snapshot -> 'retained', displaced_facts
    );

    current_aggregate := case
      when not complete_ledger and matched_jwb is not null and (
        jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
        or jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
        or (jsonb_typeof(matched_jwb -> 'contractEffectiveDate') = 'string'
          and nullif(btrim(matched_jwb ->> 'contractEffectiveDate'), '') is not null)
        or (jsonb_typeof(matched_jwb -> 'firstJwbHourEntryDate') = 'string'
          and nullif(btrim(matched_jwb ->> 'firstJwbHourEntryDate'), '') is not null)
        or current_coverage is not null
      ) then
        internal.student_import_historical_jwb_facts(jsonb_strip_nulls(jsonb_build_object(
          'remainingHours', case when jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
            then matched_jwb -> 'remainingHours' else null end,
          'contractHours', case when jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
            then matched_jwb -> 'contractHours' else null end,
          'contractEffectiveDate', case when jsonb_typeof(matched_jwb -> 'contractEffectiveDate') = 'string'
            then btrim(matched_jwb ->> 'contractEffectiveDate') else null end,
          'firstJwbHourEntryDate', case when jsonb_typeof(matched_jwb -> 'firstJwbHourEntryDate') = 'string'
            then btrim(matched_jwb ->> 'firstJwbHourEntryDate') else null end,
          'packageCoverage', current_coverage,
          'jwbSourceRow', matched_jwb -> 'sourceRow'
        )), false)
      else existing_snapshot -> 'currentAggregate'
    end;
    snapshot := internal.student_import_historical_jwb_snapshot(jsonb_strip_nulls(jsonb_build_object(
      'retained', retained_facts,
      'currentAggregate', current_aggregate
    )));

    -- Start from the hardened identity/default projection, but remove every
    -- JWB-owned active field before reintroducing only safe current ledgers.
    record_value := base_student
      - 'lessonPackages' - 'packageCoverage' - 'remainingHours' - 'contractHours'
      - 'contractEffectiveDate' - 'firstJwbHourEntryDate' - 'jwbSourceRow'
      - 'historicalJwbSnapshot' - 'studentNumberJwbDateCandidate';
    active_packages := manual_packages || active_jwb_packages;
    if jsonb_array_length(active_packages) > 0 then
      record_value := record_value || jsonb_build_object('lessonPackages', active_packages);
    end if;

    if complete_ledger or partial_ledger then
      record_value := record_value || jsonb_build_object(
        'jwbSourceRow', matched_jwb -> 'sourceRow',
        'packageCoverage', current_coverage
      );
      active_totals := case when jsonb_array_length(active_jwb_packages) > 0
        then internal.student_import_package_totals(active_jwb_packages) else null end;
      source_remaining := case when jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
        then (matched_jwb ->> 'remainingHours')::numeric else null end;
      source_contract := case when jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
        then (matched_jwb ->> 'contractHours')::numeric else null end;
      if complete_ledger and source_remaining is not null then
        record_value := record_value || jsonb_build_object('remainingHours', source_remaining);
      elsif active_totals is not null then
        record_value := record_value || jsonb_build_object(
          'remainingHours', (active_totals ->> 'remainingHours')::numeric
        );
      end if;
      if complete_ledger and source_contract is not null then
        record_value := record_value || jsonb_build_object('contractHours', source_contract);
      elsif active_totals is not null then
        record_value := record_value || jsonb_build_object(
          'contractHours', (active_totals ->> 'contractHours')::numeric
        );
      end if;
      if jsonb_typeof(matched_jwb -> 'contractEffectiveDate') = 'string'
         and nullif(btrim(matched_jwb ->> 'contractEffectiveDate'), '') is not null then
        record_value := record_value || jsonb_build_object(
          'contractEffectiveDate', btrim(matched_jwb ->> 'contractEffectiveDate')
        );
      end if;
      if jsonb_typeof(matched_jwb -> 'firstJwbHourEntryDate') = 'string'
         and nullif(btrim(matched_jwb ->> 'firstJwbHourEntryDate'), '') is not null then
        record_value := record_value || jsonb_build_object(
          'firstJwbHourEntryDate', btrim(matched_jwb ->> 'firstJwbHourEntryDate')
        );
      end if;
    end if;
    -- Allocation may use a safely matched JWB first-positive-contract date
    -- even when the current source is aggregate-only.  The allocator strips
    -- this transient field before canonical equality/persistence.
    if matched_jwb is not null
       and jsonb_typeof(matched_jwb -> 'firstJwbHourEntryDate') = 'string'
       and nullif(btrim(matched_jwb ->> 'firstJwbHourEntryDate'), '') is not null then
      record_value := record_value || jsonb_build_object(
        'studentNumberJwbDateCandidate', btrim(matched_jwb ->> 'firstJwbHourEntryDate')
      );
    end if;
    if snapshot is not null then
      record_value := record_value || jsonb_build_object('historicalJwbSnapshot', snapshot);
    end if;
    result := result || jsonb_build_array(record_value);
  end loop;
  return result;
end;
$master_authoritative_projection$;

revoke all on function internal.student_import_historical_jwb_facts(jsonb, boolean)
  from public, anon, authenticated;
revoke all on function internal.student_import_historical_jwb_snapshot(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_merge_historical_jwb_facts(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_canonical_projection(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;

-- The formal date is evidence, not a UI convenience: it is part of the
-- fingerprinted request and is stored with the idempotency row so a replay
-- cannot accidentally turn a midnight-crossing import into a new day.
alter table internal.student_import_commits
  add column if not exists formal_import_date text;

alter table internal.student_import_commits
  add constraint student_import_commits_formal_import_date_check
  check (
    formal_import_date is null
    or (
      formal_import_date ~ '^\d{4}-\d{2}-\d{2}$'
      and to_char(to_date(formal_import_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
        formal_import_date
    )
  );

-- Patch the current final-write contract rather than copying its large body.
-- Every mutation is anchor-counted so a later security migration cannot make
-- this migration silently apply to a different implementation.
do $master_authoritative_commit_patch$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_missing';
  end if;

  anchor := $commit_anchor$  replaying_prior boolean := false;
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$  replaying_prior boolean := false;
  formal_import_date text;
$commit_replacement$);

  anchor := $commit_anchor$     or p_source_revisions - 'master' - 'jwb' - 'identityLinks'
          - 'masterDuplicateResolutions' - 'fuAttachments' - 'bookingsVersion' <> '{}'::jsonb
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_source_fields_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$     or p_source_revisions - 'master' - 'jwb' - 'identityLinks'
          - 'masterDuplicateResolutions' - 'fuAttachments' - 'bookingsVersion'
          - 'formalImportDate' <> '{}'::jsonb
$commit_replacement$);

  anchor := $commit_anchor$     or (p_source_revisions ->> 'bookingsVersion')::numeric > 9007199254740991
     or jsonb_typeof(p_students) <> 'array'
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_formal_date_validation_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$     or (p_source_revisions ->> 'bookingsVersion')::numeric > 9007199254740991
     or jsonb_typeof(p_source_revisions -> 'formalImportDate') <> 'string'
     or p_source_revisions ->> 'formalImportDate' !~ '^\d{4}-\d{2}-\d{2}$'
     or to_char(to_date(p_source_revisions ->> 'formalImportDate', 'YYYY-MM-DD'), 'YYYY-MM-DD') <>
       p_source_revisions ->> 'formalImportDate'
     or jsonb_typeof(p_students) <> 'array'
$commit_replacement$);

  anchor := $commit_anchor$  expected_bookings_version := (p_source_revisions ->> 'bookingsVersion')::bigint;
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_formal_date_assignment_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$  expected_bookings_version := (p_source_revisions ->> 'bookingsVersion')::bigint;
  formal_import_date := p_source_revisions ->> 'formalImportDate';
$commit_replacement$);

  anchor := $commit_anchor$       or prior.bookings_version_before <> expected_bookings_version then
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_replay_date_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$       or prior.bookings_version_before <> expected_bookings_version
       or prior.formal_import_date is distinct from formal_import_date then
$commit_replacement$);

  anchor := $commit_anchor$    replaying_prior := true;
  end if;

  -- Stable lock order:$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_stale_date_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$    replaying_prior := true;
  elsif formal_import_date <> to_char(
    clock_timestamp() at time zone 'Australia/Melbourne', 'YYYY-MM-DD'
  ) then
    raise exception using errcode = '40001', message = 'student_import_formal_date_stale';
  end if;

  -- Stable lock order:$commit_replacement$);

  anchor := $commit_anchor$  expected_students := internal.student_import_assign_student_numbers(expected_students);

$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_number_allocator_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$  expected_students := internal.student_import_assign_student_numbers(
    expected_students, formal_import_date
  );

$commit_replacement$);

  anchor := $commit_anchor$  if exists (
    select 1
    from jsonb_array_elements(expected_students) projected_student
    where projected_student ->> 'jwbMatchStatus' = 'ambiguous'
  ) then
    raise exception using errcode = '23503', message = 'student_import_ambiguous_projection';
  end if;
  if not internal.student_import_identity_coverage_ready(expected_students) then
    raise exception using errcode = '23503', message = 'student_import_identity_coverage_required';
  end if;
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_optional_jwb_gate_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$  -- JWB ambiguity/coverage is diagnostic-only. Master duplicate and
  -- existing-identity checks above remain authoritative commit blockers.
$commit_replacement$);

  anchor := $commit_anchor$    where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 3 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_inactive_roster_anchor_mismatch';
  end if;
  definition := replace(definition, anchor,
    $commit_replacement$    where internal.student_import_display_name(eligible_master_row ->> 'name') <> ''
$commit_replacement$);

  anchor := $commit_anchor$           and source_row ->> 'status' <> '不活跃 + 无课时'
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_link_master_anchor_mismatch';
  end if;
  definition := replace(definition, anchor,
    $commit_replacement$           and internal.student_import_display_name(source_row ->> 'name') <> ''
$commit_replacement$);

  -- A stale reviewed JWB row is optional evidence. Keep the master→existing
  -- link validated, but do not make the vanished JWB leg a formal-import
  -- blocker; the canonical wrapper drops it before enrichment.
  anchor := $commit_anchor$       or (link ? 'jwbSourceRow' and not exists (
         select 1 from jsonb_array_elements(jwb.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'jwbSourceRow'
       ))
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_link_jwb_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '');

  anchor := $commit_anchor$    plan_fingerprint, master_source_id, master_revision, jwb_source_id, jwb_revision,
    master_rows_sha256, jwb_rows_sha256,
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_insert_columns_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$    plan_fingerprint, master_source_id, master_revision, jwb_source_id, jwb_revision,
    master_rows_sha256, jwb_rows_sha256, formal_import_date,
$commit_replacement$);

  anchor := $commit_anchor$    p_plan_fingerprint, master.source_id, master.revision, jwb.source_id, jwb.revision,
    master.rows_sha256, jwb.rows_sha256,
$commit_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_commit_insert_values_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $commit_replacement$    p_plan_fingerprint, master.source_id, master.revision, jwb.source_id, jwb.revision,
    master.rows_sha256, jwb.rows_sha256, formal_import_date,
$commit_replacement$);

  execute definition;
end;
$master_authoritative_commit_patch$;

-- Lost-response replay must reconstruct the same numbered projection with the
-- date committed above. It must never consult today's date or repeat optional
-- JWB coverage gates that a fresh master-authoritative commit no longer has.
do $master_authoritative_replay_patch$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_student_import_commit_replay_result(text,text,bigint,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'master_authoritative_replay_missing';
  end if;

  anchor := $replay_anchor$     or prior.jwb_rows_sha256 is null then
$replay_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_replay_formal_date_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $replay_replacement$     or prior.jwb_rows_sha256 is null
     or prior.formal_import_date is null then
$replay_replacement$);

  anchor := $replay_anchor$  expected_students := internal.student_import_assign_student_numbers(expected_students);

$replay_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_replay_number_allocator_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $replay_replacement$  expected_students := internal.student_import_assign_student_numbers(
    expected_students, prior.formal_import_date
  );

$replay_replacement$);

  anchor := $replay_anchor$  if expected_students is distinct from students_state.payload
     or exists (
       select 1 from jsonb_array_elements(expected_students) projected_student
       where projected_student ->> 'jwbMatchStatus' = 'ambiguous'
     )
     or not internal.student_import_identity_coverage_ready(expected_students) then
$replay_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_replay_optional_jwb_gate_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $replay_replacement$  if expected_students is distinct from students_state.payload then
$replay_replacement$);

  execute definition;
end;
$master_authoritative_replay_patch$;

-- Source refresh must use the same master-row eligibility policy as formal
-- commit. In particular an inactive named row can close a blank status. JWB
-- link validation lives in the revision-bound identity-link write contract,
-- not in this source-row writer, so optional JWB disappearance is handled by
-- the canonical wrapper at preview/commit time.
do $master_authoritative_source_patch$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'master_authoritative_source_write_missing';
  end if;

  anchor := $source_anchor$          and trim(coalesce(sibling ->> 'status', '')) <> '不活跃 + 无课时'
$source_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'master_authoritative_source_blank_status_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '');

  execute definition;
end;
$master_authoritative_source_patch$;

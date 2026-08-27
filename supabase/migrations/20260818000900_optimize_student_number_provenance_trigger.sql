-- The provenance trigger follows the generic student-number trigger on every
-- students payload write. The original repeatedly scanned the old JSONB
-- payload and reservation table, then rebuilt a JSONB array one item at a
-- time. Materialize read-only lookup maps once, preserve per-item validation
-- and post-insert proof ordering, and only build an ordered output buffer when
-- provenance actually changes an item.

set local lock_timeout = '1s';

do $student_import_number_provenance_set_based$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.enforce_student_number_date_provenance()'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_trigger_missing';
  end if;

  anchor := $provenance_declaration_anchor$  reserved_source text;
  next_payload jsonb := '[]'::jsonb;
begin
$provenance_declaration_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $provenance_declaration_replacement$  reserved_source text;
  old_by_id jsonb := '{}'::jsonb;
  reservation_by_student_id jsonb := '{}'::jsonb;
  reservation_by_number jsonb := '{}'::jsonb;
  student_reservation jsonb;
  number_reservation jsonb;
  selected_reservation jsonb;
  pending_reservation_student_ids text[] := array[]::text[];
  pending_reservation_numbers text[] := array[]::text[];
  pending_reservation_student_values jsonb[] := array[]::jsonb[];
  pending_reservation_number_values jsonb[] := array[]::jsonb[];
  student_pending_index integer;
  number_pending_index integer;
  output_items jsonb[] := array[]::jsonb[];
  output_started boolean := false;
begin
$provenance_declaration_replacement$);

  anchor := $provenance_map_anchor$  if jsonb_typeof(new.payload) is distinct from 'array'
     or (tg_op = 'UPDATE' and jsonb_typeof(old.payload) is distinct from 'array') then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
  end if;

  for student_item in
$provenance_map_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_map_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $provenance_map_replacement$  if jsonb_typeof(new.payload) is distinct from 'array'
     or (tg_op = 'UPDATE' and jsonb_typeof(old.payload) is distinct from 'array') then
    raise exception using errcode = '22023', message = 'students_payload_must_be_array';
  end if;

  -- The preceding generic trigger has already serialized reservation writes.
  -- Keep raw ->> text semantics and the original first-array-ordinal lookup;
  -- do not add validation for old payload items or unrelated reservations.
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(old_rows.student_id, old_rows.student_value), '{}'::jsonb)
    into old_by_id
    from (
      select distinct on (old_student.value ->> 'id')
        old_student.value ->> 'id' as student_id,
        old_student.value as student_value
      from jsonb_array_elements(old.payload) with ordinality old_student(value, ordinal)
      where old_student.value ->> 'id' is not null
      order by old_student.value ->> 'id', old_student.ordinal
    ) old_rows;
  end if;

  select coalesce(jsonb_object_agg(
    reservation.student_id,
    jsonb_build_object(
      'studentNumber', reservation.student_number,
      'studentId', reservation.student_id,
      'studentNumberDateSource', reservation.student_number_date_source
    )
  ), '{}'::jsonb), coalesce(jsonb_object_agg(
    reservation.student_number,
    jsonb_build_object(
      'studentNumber', reservation.student_number,
      'studentId', reservation.student_id,
      'studentNumberDateSource', reservation.student_number_date_source
    )
  ), '{}'::jsonb)
  into reservation_by_student_id, reservation_by_number
  from internal.student_number_reservations reservation;

  for student_item in
$provenance_map_replacement$);

  anchor := $provenance_old_lookup_anchor$    next_item := student_item.value;
    old_item := null;
    if tg_op = 'UPDATE' then
      select candidate.value into old_item
      from jsonb_array_elements(old.payload) candidate(value)
      where candidate.value ->> 'id' = next_item ->> 'id';
    end if;
    current_number := next_item ->> 'studentNumber';
$provenance_old_lookup_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_old_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $provenance_old_lookup_replacement$    next_item := student_item.value;
    old_item := old_by_id -> (next_item ->> 'id');
    current_number := next_item ->> 'studentNumber';
$provenance_old_lookup_replacement$);

  anchor := $provenance_reservation_lookup_anchor$      select reservation.student_number, reservation.student_id,
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
$provenance_reservation_lookup_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_reservation_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $provenance_reservation_lookup_replacement$      -- Preserve ID-preferred source semantics while proving both registry
      -- directions. Pending rows cover a later input from an alternate writer
      -- without repeatedly rebuilding large JSONB maps.
      student_pending_index := array_position(
        pending_reservation_student_ids, next_item ->> 'id'
      );
      student_reservation := case when student_pending_index is not null
        then pending_reservation_student_values[student_pending_index]
        else reservation_by_student_id -> (next_item ->> 'id') end;
      number_pending_index := array_position(
        pending_reservation_numbers, current_number
      );
      number_reservation := case when number_pending_index is not null
        then pending_reservation_number_values[number_pending_index]
        else reservation_by_number -> current_number end;
      -- The source and selected row retain the original ID-preferred
      -- `WHERE id OR number ORDER BY id-first` semantics; the independent
      -- checks below still prove both registry directions.
      selected_reservation := case when student_reservation is not null
        then student_reservation else number_reservation end;
      reserved_number := selected_reservation ->> 'studentNumber';
      reserved_student_id := selected_reservation ->> 'studentId';
      reserved_source := selected_reservation ->> 'studentNumberDateSource';
      if (student_reservation is not null and reserved_number <> current_number)
         or (number_reservation is not null and reserved_student_id <> next_item ->> 'id')
         or (reserved_source is not null and current_source is not null
             and reserved_source <> current_source) then
$provenance_reservation_lookup_replacement$);

  anchor := $provenance_post_insert_anchor$      select reservation.student_number, reservation.student_id,
        reservation.student_number_date_source
      into reserved_number, reserved_student_id, reserved_source
      from internal.student_number_reservations reservation
      where reservation.student_number = current_number;
      if reserved_number is distinct from current_number
         or reserved_student_id is distinct from next_item ->> 'id'
         or (current_source is not null and reserved_source is distinct from current_source) then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
$provenance_post_insert_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_post_insert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $provenance_post_insert_replacement$      select reservation.student_number, reservation.student_id,
        reservation.student_number_date_source
      into reserved_number, reserved_student_id, reserved_source
      from internal.student_number_reservations reservation
      where reservation.student_number = current_number;
      if reserved_number is distinct from current_number
         or reserved_student_id is distinct from next_item ->> 'id'
         or (current_source is not null and reserved_source is distinct from current_source) then
        raise exception using errcode = '23505', message = 'student_number_reservation_conflict';
      end if;
      student_reservation := jsonb_build_object(
        'studentNumber', reserved_number,
        'studentId', reserved_student_id,
        'studentNumberDateSource', reserved_source
      );
      student_pending_index := array_position(
        pending_reservation_student_ids, reserved_student_id
      );
      if student_pending_index is null then
        pending_reservation_student_ids := array_append(
          pending_reservation_student_ids, reserved_student_id
        );
        pending_reservation_student_values := array_append(
          pending_reservation_student_values, student_reservation
        );
      else
        pending_reservation_student_values[student_pending_index] := student_reservation;
      end if;
      number_pending_index := array_position(
        pending_reservation_numbers, reserved_number
      );
      if number_pending_index is null then
        pending_reservation_numbers := array_append(
          pending_reservation_numbers, reserved_number
        );
        pending_reservation_number_values := array_append(
          pending_reservation_number_values, student_reservation
        );
      else
        pending_reservation_number_values[number_pending_index] := student_reservation;
      end if;
$provenance_post_insert_replacement$);

  anchor := $provenance_output_anchor$    next_payload := next_payload || jsonb_build_array(next_item);
  end loop;
  new.payload := next_payload;
  return new;
$provenance_output_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_output_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $provenance_output_replacement$    if next_item is distinct from student_item.value and not output_started then
      select coalesce(array_agg(prefix.value order by prefix.ordinal), array[]::jsonb[])
      into output_items
      from jsonb_array_elements(new.payload) with ordinality prefix(value, ordinal)
      where prefix.ordinal < student_item.ordinal;
      output_started := true;
    end if;
    if output_started then
      output_items := array_append(output_items, next_item);
    end if;
  end loop;
  if output_started then
    new.payload := coalesce(to_jsonb(output_items), '[]'::jsonb);
  end if;
  return new;
$provenance_output_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.enforce_student_number_date_provenance()'::regprocedure
  ) into definition;
  if position('old_by_id jsonb := ''{}''::jsonb' in definition) = 0
     or position('reservation_by_student_id jsonb := ''{}''::jsonb' in definition) = 0
     or position('reservation_by_number jsonb := ''{}''::jsonb' in definition) = 0
     or position('pending_reservation_student_ids text[]' in definition) = 0
     or position('pending_reservation_student_values jsonb[]' in definition) = 0
     or position('selected_reservation := case when student_reservation is not null' in definition) = 0
     or position('output_started boolean := false' in definition) = 0
     or position('with ordinality old_student(value, ordinal)' in definition) = 0
     or position('student_reservation := case when student_pending_index is not null' in definition) = 0
     or position('number_reservation := case when number_pending_index is not null' in definition) = 0
     or position('next_payload := next_payload ||' in definition) <> 0 then
    raise exception using errcode = 'P0001',
      message = 'student_number_provenance_patch_verification_failed';
  end if;
end;
$student_import_number_provenance_set_based$;

create or replace function internal.jiaowubao_direct_schedule_mapping_teacher_catalog(
  p_teachers jsonb
)
returns table (
  teacher_id text,
  teacher_name text,
  subject_ids text[],
  target_basis_sha256 text
)
language plpgsql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_teacher_catalog$
declare
  max_teachers constant integer := 512;
  max_subjects_per_teacher constant integer := 1024;
  teacher_value jsonb;
  subject_value jsonb;
  subject_count integer;
  distinct_subject_count integer;
  canonical_subjects text[];
begin
  if jsonb_typeof(p_teachers) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_unavailable';
  end if;
  if jsonb_array_length(p_teachers) > max_teachers then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teacher_catalog_too_large';
  end if;

  for teacher_value in
    select item.value
    from jsonb_array_elements(p_teachers) item(value)
  loop
    if jsonb_typeof(teacher_value) <> 'object'
       or nullif(btrim(teacher_value ->> 'id'), '') is null
       or teacher_value ->> 'id' <> btrim(teacher_value ->> 'id')
       or char_length(teacher_value ->> 'id') > 240
       or nullif(btrim(teacher_value ->> 'name'), '') is null
       or teacher_value ->> 'name' <> btrim(teacher_value ->> 'name')
       or char_length(teacher_value ->> 'name') > 240
       or jsonb_typeof(teacher_value -> 'subjects') <> 'array' then
      raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
    end if;
    if jsonb_array_length(teacher_value -> 'subjects') > max_subjects_per_teacher then
      raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teacher_subject_catalog_too_large';
    end if;

    for subject_value in
      select item.value
      from jsonb_array_elements(teacher_value -> 'subjects') item(value)
    loop
      if jsonb_typeof(subject_value) <> 'string'
         or nullif(btrim(subject_value #>> '{}'), '') is null
         or subject_value #>> '{}' <> btrim(subject_value #>> '{}')
         or char_length(subject_value #>> '{}') > 240 then
        raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
      end if;
    end loop;

    select
      coalesce(array_agg(item.value #>> '{}' order by item.value #>> '{}'), ARRAY[]::text[]),
      count(*)::integer,
      count(distinct item.value #>> '{}')::integer
    into canonical_subjects, subject_count, distinct_subject_count
    from jsonb_array_elements(teacher_value -> 'subjects') item(value);

    if subject_count <> distinct_subject_count then
      raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
    end if;

    teacher_id := teacher_value ->> 'id';
    teacher_name := teacher_value ->> 'name';
    subject_ids := canonical_subjects;
    target_basis_sha256 := encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-mapping-target-v1' || chr(31)
        || teacher_id || chr(31)
        || teacher_name || chr(31)
        || array_to_string(subject_ids, chr(31)),
      'UTF8'
    ), 'sha256'), 'hex');
    return next;
  end loop;
end;
$jiaowubao_direct_schedule_mapping_teacher_catalog$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb)
  from public, anon, authenticated;

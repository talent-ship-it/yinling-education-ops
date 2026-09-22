-- Refresh only the candidate list from locked authoritative state. The final
-- replacement RPC retains its saved-list, occurrence, OCC and payload guards.
create or replace function public.refresh_teacher_departure_candidates_atomic(
  p_secret text, p_operation_id text, p_expected_versions jsonb, p_actor text
) returns setof public.ops_state language plpgsql security definer set search_path = '' as $function$
declare b public.ops_state; o public.ops_state; s public.ops_state; t public.ops_state;
  operation jsonb; student jsonb; projection jsonb; subjects jsonb; candidates jsonb; next_operation jsonb; next_payload jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if coalesce(p_operation_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    or nullif(trim(p_actor), '') is null or length(p_actor) > 120
    or jsonb_typeof(p_expected_versions) is distinct from 'object'
    or p_expected_versions - 'bookings' - 'operations' - 'students' - 'teachers' <> '{}'::jsonb
    or exists (select 1 from unnest(array['bookings','operations','students','teachers']) entity
      where jsonb_typeof(p_expected_versions -> entity) is distinct from 'number'
        or coalesce(p_expected_versions ->> entity, '') !~ '^[1-9][0-9]*$') then
    raise exception using errcode = '22023', message = 'invalid_departure_candidate_refresh';
  end if;
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into o from public.ops_state where entity = 'operations' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into t from public.ops_state where entity = 'teachers' for update;
  if b.version is distinct from (p_expected_versions ->> 'bookings')::bigint
    or o.version is distinct from (p_expected_versions ->> 'operations')::bigint
    or s.version is distinct from (p_expected_versions ->> 'students')::bigint
    or t.version is distinct from (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if (select count(*) from jsonb_array_elements(o.payload) item where item ->> 'id' = p_operation_id) <> 1 then
    raise exception using errcode = '22023', message = 'departure_candidate_operation_not_found';
  end if;
  select item into operation from jsonb_array_elements(o.payload) item where item ->> 'id' = p_operation_id;
  select item into student from jsonb_array_elements(s.payload) item where item ->> 'id' = operation ->> 'studentId';
  if student is null or student ->> 'importArchived' = 'true' or operation ->> 'type' is distinct from '老师离职'
    or operation ->> 'status' is distinct from '待处理'
    or not exists (select 1 from internal.teacher_departure_creation_commands c
      cross join lateral jsonb_array_elements(c.affected_groups) g
      where c.command_key = operation ->> 'creationCommandKey'
        and c.source_teacher_id = operation ->> 'teacherId'
        and c.effective_date::text = operation ->> 'eventEnd'
        and g ->> 'operationId' = p_operation_id and g ->> 'studentId' = operation ->> 'studentId'
        and g -> 'affectedOccurrenceIds' = operation -> 'affectedOccurrenceIds') then
    raise exception using errcode = '22023', message = 'departure_candidate_operation_mismatch';
  end if;
  projection := internal.permanent_teacher_replacement_occurrence_projection(b.payload, operation ->> 'studentId', operation ->> 'teacherId', operation ->> 'eventEnd', true);
  if projection ->> 'unbounded' = 'true' or projection -> 'occurrenceIds' is distinct from operation -> 'affectedOccurrenceIds' then
    raise exception using errcode = '40001', message = 'departure_candidate_occurrence_changed';
  end if;
  select jsonb_agg(distinct booking -> 'teacherSubjectId') into subjects
  from jsonb_array_elements_text(projection -> 'occurrenceIds') occurrence_id
  join jsonb_array_elements(b.payload) booking on booking ->> 'id' = left(occurrence_id, length(occurrence_id) - 11);
  if subjects is null or subjects @> '[null]'::jsonb or subjects @> '[""]'::jsonb then
    raise exception using errcode = '22023', message = 'departure_candidate_subject_missing';
  end if;
  candidates := internal.teacher_absence_candidate_ids(b.payload, t.payload, operation ->> 'teacherId', jsonb_build_object(
    'studentId', operation ->> 'studentId', 'subjects', subjects, 'affectedOccurrenceIds', projection -> 'occurrenceIds'));
  next_operation := jsonb_set(operation, '{recommendedTeacherIds}', candidates);
  if operation ? 'chosenTeacherId' and not candidates @> jsonb_build_array(operation ->> 'chosenTeacherId') then next_operation := next_operation - 'chosenTeacherId'; end if;
  if next_operation = operation then return next o; return; end if;
  select jsonb_agg(case when item ->> 'id' = p_operation_id then next_operation else item end order by position) into next_payload
  from jsonb_array_elements(o.payload) with ordinality items(item, position);
  update public.ops_state set payload = next_payload, version = version + 1, updated_at = now(), updated_by = trim(p_actor) where entity = 'operations' returning * into o;
  insert into public.ops_mutation_log(entity,version,actor) values ('operations',o.version,trim(p_actor));
  perform internal.append_operational_contract_audit('operation.departure_candidates_refreshed',trim(p_actor),'operation',p_operation_id,jsonb_build_object('candidateCount',jsonb_array_length(candidates)));
  return next o;
end;
$function$;
revoke all on function public.refresh_teacher_departure_candidates_atomic(text,text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.refresh_teacher_departure_candidates_atomic(text,text,jsonb,text) to anon, authenticated;

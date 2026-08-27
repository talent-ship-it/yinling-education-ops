-- Forward-only classroom binding repair.
--
-- Classroom metadata is an occurrence-scoped projection concern. It shares
-- the booking projection's five-row transaction and actor-bound ledger, but
-- is never accepted as update_occurrence (which owns schedule edits). This
-- migration patches the deployed wrapper only after checking its reviewed
-- anchors; a drifted wrapper fails closed instead of being silently replaced.

do $bind_classroom_projection_wrapper$
declare
  target_oid oid;
  source_definition text;
  patched_definition text;
begin
  target_oid := to_regprocedure(
    'public.mutate_booking_projection_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text,text)'
  );
  if target_oid is null then
    raise exception using errcode = '55000', message = 'bind_classroom_projection_wrapper_missing';
  end if;

  select pg_get_functiondef(target_oid) into source_definition;
  if position('create or replace function public.mutate_booking_projection_atomic' in lower(source_definition)) = 0
     or position('internal.booking_projection_commands' in source_definition) = 0
     or position('public.mutate_booking_capacity_atomic' in source_definition) = 0
     or position('select * into b from public.ops_state where entity = ''bookings'' for update' in source_definition) = 0
     or position('select * into s from public.ops_state where entity = ''students'' for update' in source_definition) = 0
     or position('select * into l from public.ops_state where entity = ''lpItems'' for update' in source_definition) = 0
     or position('select * into t from public.ops_state where entity = ''tasks'' for update' in source_definition) = 0
     or position('select * into h from public.ops_state where entity = ''teachers'' for update' in source_definition) = 0
     or position('p_command_intent ->> ''action'' = ''update_occurrence'' and p_action = ''update''' in source_definition) = 0 then
    raise exception using errcode = '55000', message = 'bind_classroom_projection_wrapper_drift';
  end if;

  -- Keep the core's parent booking identity separate from the occurrence's
  -- effective teacher/student identities recorded in the projection ledger.
  patched_definition := replace(
    source_definition,
    $anchor$  previous_teacher text;
  core_intent jsonb;
  subcommand_key text;$anchor$,
    $replacement$  previous_teacher text;
  ledger_previous_student text;
  ledger_previous_teacher text;
  core_student_id text;
  core_teacher_id text;
  core_intent jsonb;
  subcommand_key text;$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$     or p_command_intent - 'action' - 'bookingId' - 'booking' - 'occurrenceId' - 'occurrence' <> '{}'::jsonb
     or not (
       (p_command_intent ->> 'action' = 'upsert' and p_action in ('create', 'update'))
       or (p_command_intent ->> 'action' = 'delete' and p_action = 'delete')
       or (p_command_intent ->> 'action' = 'cancel_occurrence' and p_action = 'update')
       or (p_command_intent ->> 'action' = 'update_occurrence' and p_action = 'update')
     )$anchor$,
    $replacement$     or p_command_intent - 'action' - 'bookingId' - 'booking' - 'occurrenceId' - 'occurrence' - 'classroom' <> '{}'::jsonb
     or not (
       (p_command_intent ->> 'action' = 'upsert' and p_action in ('create', 'update'))
       or (p_command_intent ->> 'action' = 'delete' and p_action = 'delete')
       or (p_command_intent ->> 'action' = 'cancel_occurrence' and p_action = 'update')
       or (p_command_intent ->> 'action' = 'update_occurrence' and p_action = 'update')
       or (p_command_intent ->> 'action' = 'bind_classroom' and p_action = 'update')
     )$replacement$
  );

  -- Add an exact bind validator immediately before version parsing. The
  -- existing update_occurrence validator remains untouched and therefore
  -- cannot accidentally accept classroom metadata as a schedule edit.
  patched_definition := replace(
    patched_definition,
    $anchor$  begin
    expected_b := (p_expected_versions ->> 'bookings')::bigint;$anchor$,
    $replacement$  if p_command_intent ->> 'action' = 'bind_classroom' and (
       p_command_intent - 'action' - 'bookingId' - 'occurrenceId' - 'classroom' <> '{}'::jsonb
       or p_command_intent ->> 'occurrenceId' <> p_booking_id || ':' || pg_catalog.right(p_command_intent ->> 'occurrenceId', 10)
       or pg_catalog.right(p_command_intent ->> 'occurrenceId', 10) !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(p_command_intent -> 'classroom') <> 'object'
       or (p_command_intent -> 'classroom') - 'meetingId' - 'status' <> '{}'::jsonb
       or jsonb_typeof(p_command_intent #> '{classroom,meetingId}') <> 'string'
       or p_command_intent #>> '{classroom,meetingId}' !~ '^yinling-occ-[0-9a-f]{48}$'
       or jsonb_typeof(p_command_intent #> '{classroom,status}') <> 'string'
       or p_command_intent #>> '{classroom,status}' not in ('ready', 'running', 'ended')
       or p_command_intent #>> '{classroom,meetingId}' is distinct from
         'yinling-occ-' || pg_catalog.left(encode(extensions.digest(p_command_intent ->> 'occurrenceId', 'sha256'), 'hex'), 48)
     ) then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_command';
  end if;
  begin
    expected_b := (p_expected_versions ->> 'bookings')::bigint;$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$  previous_student := coalesce(current_booking ->> 'studentId', p_student_id);
  previous_teacher := coalesce(current_booking ->> 'teacherId', p_teacher_id);$anchor$,
    $replacement$  core_student_id := coalesce(current_booking ->> 'studentId', p_student_id);
  core_teacher_id := coalesce(current_booking ->> 'teacherId', p_teacher_id);
  previous_student := core_student_id;
  previous_teacher := core_teacher_id;
  ledger_previous_student := previous_student;
  ledger_previous_teacher := previous_teacher;
  if p_command_intent ->> 'action' = 'bind_classroom' then
    ledger_previous_student := p_student_id;
    ledger_previous_teacher := p_teacher_id;
  end if;$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$  core_intent := case when p_command_intent ->> 'action' in ('cancel_occurrence', 'update_occurrence')$anchor$,
    $replacement$  core_intent := case when p_command_intent ->> 'action' in ('cancel_occurrence', 'update_occurrence', 'bind_classroom')$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$    p_changed_teacher_ids,
    p_student_id,
    p_teacher_id,
    p_actor$anchor$,
    $replacement$    p_changed_teacher_ids,
    core_student_id,
    core_teacher_id,
    p_actor$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$       or committed_booking ->> 'studentId' is distinct from p_student_id
       or committed_booking ->> 'teacherId' is distinct from p_teacher_id$anchor$,
    $replacement$       or committed_booking ->> 'studentId' is distinct from core_student_id
       or committed_booking ->> 'teacherId' is distinct from core_teacher_id$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$  select value into target_student from jsonb_array_elements(s.payload) value
  where value ->> 'id' = p_student_id limit 1;
  select value into target_teacher from jsonb_array_elements(saved_h.payload) value
  where value ->> 'id' = p_teacher_id limit 1;$anchor$,
    $replacement$  select value into target_student from jsonb_array_elements(s.payload) value
  where value ->> 'id' = core_student_id limit 1;
  select value into target_teacher from jsonb_array_elements(saved_h.payload) value
  where value ->> 'id' = core_teacher_id limit 1;$replacement$
  );

  -- Both the ledger insert and returned receipt carry the occurrence-effective
  -- identities for bind_classroom. Other actions retain their existing values.
  patched_definition := replace(
    patched_definition,
    $anchor$    p_student_id, previous_student, p_teacher_id, previous_teacher,$anchor$,
    $replacement$    p_student_id, ledger_previous_student, p_teacher_id, ledger_previous_teacher,$replacement$
  );

  if patched_definition = source_definition
     or position('bind_classroom' in patched_definition) = 0
     or position('p_command_intent ->> ''action'' = ''bind_classroom'' and p_action = ''update''' in patched_definition) = 0
     or position('core_student_id' in patched_definition) = 0
     or position('core_intent := case when p_command_intent ->> ''action'' in (''cancel_occurrence'', ''update_occurrence'', ''bind_classroom'')' in patched_definition) = 0
     or position('where value ->> ''id'' = core_student_id limit 1' in patched_definition) = 0
     or position('where value ->> ''id'' = core_teacher_id limit 1' in patched_definition) = 0
     or position('ledger_previous_student' in patched_definition) = 0
     or position('ledger_previous_teacher' in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'bind_classroom_projection_wrapper_patch_failed';
  end if;

  -- `patched_definition` is the forward CREATE OR REPLACE definition of the
  -- existing wrapper; execute it only after every drift anchor above matched.
  execute patched_definition;
end;
$bind_classroom_projection_wrapper$;

revoke all on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) to anon, authenticated;

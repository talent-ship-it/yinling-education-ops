-- Temporary classroom saga boundary.
--
-- The provider is intentionally called before this command.  This forward
-- patch makes the resulting Booking + occurrence classroom projection one
-- projection transaction, with the same actor-bound ledger/OCC/replay rules
-- as the existing booking projection wrapper.  A drifted deployed wrapper
-- fails closed rather than being replaced.

do $temporary_classroom_projection_wrapper$
declare
  target_oid oid;
  source_definition text;
  patched_definition text;
begin
  target_oid := to_regprocedure(
    'public.mutate_booking_projection_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text,text)'
  );
  if target_oid is null then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_wrapper_missing';
  end if;

  select pg_get_functiondef(target_oid) into source_definition;
  if position('create or replace function public.mutate_booking_projection_atomic' in lower(source_definition)) = 0
     or position('internal.booking_projection_commands' in source_definition) = 0
     or position('p_command_intent ->> ''action'' = ''bind_classroom'' and p_action = ''update''' in source_definition) = 0
     or position('core_intent := case when p_command_intent ->> ''action'' in (''cancel_occurrence'', ''update_occurrence'', ''bind_classroom'')' in source_definition) = 0
     or position('p_command_intent - ''action'' - ''bookingId'' - ''occurrenceId'' - ''classroom'' <> ''{}''::jsonb' in source_definition) = 0 then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_wrapper_drift';
  end if;

  -- Permit exactly one additional semantic action, while retaining bind's
  -- separate action and never broadening update_occurrence.
  patched_definition := replace(
    source_definition,
    $anchor$       or (p_command_intent ->> 'action' = 'bind_classroom' and p_action = 'update')$anchor$,
    $replacement$       or (p_command_intent ->> 'action' = 'bind_classroom' and p_action = 'update')
       or (p_command_intent ->> 'action' = 'upsert_bind_classroom' and p_action in ('create', 'update'))$replacement$
  );

  -- Validate the combined command's narrow top-level envelope and derive the
  -- expected occurrence meeting ID from the same deterministic source used by
  -- the application.  The Booking payload passed to the core contains the
  -- classroom override; no second database command is needed.
  patched_definition := replace(
    patched_definition,
    $anchor$  if p_command_intent ->> 'action' = 'bind_classroom' and ($anchor$,
    $replacement$  if p_command_intent ->> 'action' = 'upsert_bind_classroom' and (
       p_command_intent - 'action' - 'bookingId' - 'occurrenceId' - 'booking' - 'classroom' <> '{}'::jsonb
       or p_command_intent ->> 'occurrenceId' <> p_booking_id || ':' || pg_catalog.right(p_command_intent ->> 'occurrenceId', 10)
       or pg_catalog.right(p_command_intent ->> 'occurrenceId', 10) !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(p_command_intent -> 'booking') <> 'object'
       or jsonb_typeof(p_command_intent -> 'classroom') <> 'object'
       or (p_command_intent -> 'classroom') - 'meetingId' - 'status' <> '{}'::jsonb
       or jsonb_typeof(p_command_intent #> '{classroom,meetingId}') <> 'string'
       or p_command_intent #>> '{classroom,meetingId}' !~ '^yinling-occ-[0-9a-f]{48}$'
       or p_command_intent #>> '{classroom,meetingId}' is distinct from
         'yinling-occ-' || pg_catalog.left(encode(extensions.digest(p_command_intent ->> 'occurrenceId', 'sha256'), 'hex'), 48)
       or jsonb_typeof(p_command_intent #> '{classroom,status}') <> 'string'
       or p_command_intent #>> '{classroom,status}' not in ('ready', 'running', 'ended')
     ) then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_command';
  end if;
  if p_command_intent ->> 'action' = 'bind_classroom' and ($replacement$
  );

  -- The combined command is an upsert from the core's perspective. Its
  -- `core_intent` deliberately excludes the wrapper-only classroom action;
  -- the prepared p_bookings payload still carries the validated classroom
  -- override and is written by the same core transaction.
  patched_definition := replace(
    patched_definition,
    $anchor$  core_intent := case when p_command_intent ->> 'action' in ('cancel_occurrence', 'update_occurrence', 'bind_classroom')$anchor$,
    $replacement$  core_intent := case when p_command_intent ->> 'action' in ('cancel_occurrence', 'update_occurrence', 'bind_classroom', 'upsert_bind_classroom')$replacement$
  );

  patched_definition := replace(
    patched_definition,
    $anchor$  if p_action <> 'delete' and ($anchor$,
    $replacement$  if p_command_intent ->> 'action' = 'upsert_bind_classroom' and (
       committed_booking is null
       or jsonb_typeof(committed_booking -> 'occurrenceOverrides') <> 'array'
       or not exists (
         select 1 from jsonb_array_elements(committed_booking -> 'occurrenceOverrides') item(value)
         where item.value ->> 'occurrenceId' = p_command_intent ->> 'occurrenceId'
           and item.value #>> '{classroom,meetingId}' = p_command_intent #>> '{classroom,meetingId}'
           and item.value #>> '{classroom,status}' = p_command_intent #>> '{classroom,status}'
       )
     ) then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_missing';
  end if;
  if p_action <> 'delete' and ($replacement$
  );

  if patched_definition = source_definition
     or position('upsert_bind_classroom' in patched_definition) = 0
     or position('core_intent := case when p_command_intent ->> ''action'' in (''cancel_occurrence'', ''update_occurrence'', ''bind_classroom'', ''upsert_bind_classroom'')' in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_wrapper_patch_failed';
  end if;

  execute patched_definition;
end;
$temporary_classroom_projection_wrapper$;

revoke all on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) to anon, authenticated;

set local lock_timeout = '1s';

create or replace function internal.stamp_ops_task_note_dates()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  previous_tasks jsonb := '{}'::jsonb;
  saved_at text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if new.entity <> 'tasks' then return new; end if;
  if tg_op = 'UPDATE' and old.entity = 'tasks' then
    select coalesce(jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb)
      into previous_tasks
    from jsonb_array_elements(old.payload) item(value);
  end if;

  select coalesce(jsonb_agg(
    case
      when task.value ? 'legacyEvidence' then task.value
      else (task.value - 'completionNoteUpdatedAt') || case
        when jsonb_typeof(task.value -> 'completionNote') = 'string'
          and length(btrim(task.value ->> 'completionNote')) > 0
          and previous_tasks ? (task.value ->> 'id')
        then case
          when task.value -> 'completionNote' is distinct from previous.value -> 'completionNote'
            then jsonb_build_object('completionNoteUpdatedAt', saved_at)
          when internal.task_due_at_is_canonical(previous.value ->> 'completionNoteUpdatedAt')
            then jsonb_build_object('completionNoteUpdatedAt', previous.value ->> 'completionNoteUpdatedAt')
          else '{}'::jsonb
        end
        else '{}'::jsonb
      end
    end order by task.ordinality
  ), '[]'::jsonb) into new.payload
  from jsonb_array_elements(new.payload) with ordinality task(value, ordinality)
  cross join lateral (select previous_tasks -> (task.value ->> 'id') as value) previous;
  return new;
end;
$function$;

revoke all on function internal.stamp_ops_task_note_dates() from public, anon, authenticated, service_role;

create or replace trigger ops_state_stamp_task_note_dates
before insert or update of payload on public.ops_state
for each row execute function internal.stamp_ops_task_note_dates();

do $audit_saved_payload$
declare
  definition text;
  original text := $original$'payloadSha256', encode(extensions.digest(p_payload::text, 'sha256'), 'hex')$original$;
  replacement text := $replacement$'payloadSha256', encode(extensions.digest(saved.payload::text, 'sha256'), 'hex')$replacement$;
begin
  definition := pg_get_functiondef('public.put_scoped_ops_state(text,text,jsonb,bigint,text,jsonb)'::regprocedure);
  if position(replacement in definition) > 0 then return; end if;
  if position(original in definition) = 0
    or length(definition) - length(replace(definition, original, '')) <> length(original) then
    raise exception using errcode = '55000', message = 'ops_state_audit_payload_shape_changed';
  end if;
  execute replace(definition, original, replacement);
end;
$audit_saved_payload$;


create or replace function internal.preserve_rebuilt_task_notes(p_next jsonb, p_previous jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $preserve_notes$
  with notes as materialized (
    select coalesce(jsonb_object_agg(prior.value ->> 'id', jsonb_strip_nulls(jsonb_build_object(
      'completionNote', prior.value -> 'completionNote',
      'completionNoteUpdatedAt', prior.value -> 'completionNoteUpdatedAt'
    ))), '{}'::jsonb) as by_id
    from jsonb_array_elements(p_previous) prior(value)
    where prior.value ->> 'id' is not null
      and nullif(prior.value ->> 'completionNote', '') is not null
  )
  select coalesce(jsonb_agg(task.value || coalesce(notes.by_id -> (task.value ->> 'id'), '{}'::jsonb)
    order by task.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_next) with ordinality task(value, ordinality)
  cross join notes
$preserve_notes$;

revoke all on function internal.preserve_rebuilt_task_notes(jsonb, jsonb)
  from public, anon, authenticated, service_role;

do $preserve_rebuilt_notes$
declare
  target record;
  definition text;
begin
  for target in select * from (values
    ('internal.rebuild_booking_trial_tasks_base_191019(jsonb,jsonb,jsonb,jsonb,text,timestamptz)',
      'return working;', 'return internal.preserve_rebuilt_task_notes(working, p_tasks);', 5),
    ('internal.exam_submission_reconcile_tasks(jsonb,jsonb,text,text)',
      'return prepared;', 'return internal.preserve_rebuilt_task_notes(prepared, p_tasks);', 1)
  ) as targets(signature, original, replacement, occurrences)
  loop
    definition := pg_get_functiondef(target.signature::regprocedure);
    if position(target.replacement in definition) > 0 then continue; end if;
    if length(definition) - length(replace(definition, target.original, ''))
        <> length(target.original) * target.occurrences then
      raise exception using errcode = '55000', message = 'task_note_projection_shape_changed';
    end if;
    execute replace(definition, target.original, target.replacement);
  end loop;
end;
$preserve_rebuilt_notes$;

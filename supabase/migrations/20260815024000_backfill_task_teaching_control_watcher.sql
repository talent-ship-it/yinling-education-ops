-- Backfill the teaching-control watcher on every persisted task.  This is a
-- deliberately one-entity migration: it locks and updates only the `tasks`
-- ops_state row, preserves task order and every field except `watchers`, and
-- becomes a true no-op after the first successful run.

do $task_watcher_backfill$
declare
  teaching_control_watcher constant text := 'Ops Admin';
  migration_actor constant text := 'system:migration:task-watchers-20260815';
  current_state public.ops_state%rowtype;
  prior_version bigint;
  next_payload jsonb := '[]'::jsonb;
  task_item jsonb;
  next_task jsonb;
  normalized_watchers jsonb;
  task_count integer;
  distinct_id_count integer;
  changed_task_count integer := 0;
  changed_task_ids jsonb := '[]'::jsonb;
begin
  select *
  into current_state
  from public.ops_state state_row
  where state_row.entity = 'tasks'
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'tasks_ops_state_missing';
  end if;

  if jsonb_typeof(current_state.payload) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'tasks_payload_must_be_array';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(current_state.payload) as task(value)
    where jsonb_typeof(task.value) is distinct from 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'tasks_payload_item_must_be_object';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(current_state.payload) as task(value)
    where jsonb_typeof(task.value -> 'id') is distinct from 'string'
       or nullif(btrim(task.value ->> 'id'), '') is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'task_id_must_be_nonempty_string';
  end if;

  select count(*), count(distinct task.value ->> 'id')
  into task_count, distinct_id_count
  from jsonb_array_elements(current_state.payload) as task(value);

  if task_count <> distinct_id_count then
    raise exception using
      errcode = '23505',
      message = 'duplicate_task_id';
  end if;

  -- Append tasks in their original ordinality.  For each task, retain the
  -- first occurrence of every legal watcher after trimming and
  -- case-insensitive deduplication.  The canonical watcher is removed from
  -- that legacy set and appended once with its exact account spelling so the
  -- result already satisfies the application transition contract.
  for task_item in
    select task.value
    from jsonb_array_elements(current_state.payload) with ordinality as task(value, ordinal)
    order by task.ordinal
  loop
    select coalesce(
      jsonb_agg(to_jsonb(deduped.watcher) order by deduped.first_ordinal),
      '[]'::jsonb
    )
    into normalized_watchers
    from (
      select
        (array_agg(extracted.watcher order by watcher_element.ordinal))[1] as watcher,
        min(watcher_element.ordinal) as first_ordinal
      from jsonb_array_elements(
        case
          when jsonb_typeof(task_item -> 'watchers') = 'array'
            then task_item -> 'watchers'
          else '[]'::jsonb
        end
      ) with ordinality as watcher_element(value, ordinal)
      cross join lateral (
        select btrim(watcher_element.value #>> '{}') as watcher
      ) as extracted
      where jsonb_typeof(watcher_element.value) = 'string'
        and nullif(extracted.watcher, '') is not null
        -- A 120-byte ceiling is conservative relative to the application's
        -- 120 UTF-16-code-unit ceiling and therefore cannot emit an invalid
        -- watcher even when the source contains supplementary Unicode.
        and octet_length(extracted.watcher) <= 120
        and lower(extracted.watcher) <> lower(teaching_control_watcher)
      group by lower(extracted.watcher)
    ) as deduped;

    normalized_watchers := normalized_watchers || jsonb_build_array(teaching_control_watcher);

    next_task := jsonb_set(task_item, '{watchers}', normalized_watchers, true);
    if next_task is distinct from task_item then
      changed_task_count := changed_task_count + 1;
      changed_task_ids := changed_task_ids || jsonb_build_array(task_item ->> 'id');
    end if;
    next_payload := next_payload || jsonb_build_array(next_task);
  end loop;

  -- A replay over an already-normalized payload has no version, mutation-log
  -- or operational-audit side effects.
  if next_payload is not distinct from current_state.payload then
    return;
  end if;

  prior_version := current_state.version;
  update public.ops_state state_row
  set payload = next_payload,
      version = state_row.version + 1,
      updated_at = now(),
      updated_by = left(migration_actor, 80)
  where state_row.entity = 'tasks'
  returning state_row.* into current_state;

  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', current_state.version, current_state.updated_by);

  perform internal.append_operational_contract_audit(
    'tasks.teaching_control_watcher_backfilled',
    migration_actor,
    'ops_state',
    'tasks',
    jsonb_build_object(
      'watcher', teaching_control_watcher,
      'taskCount', task_count,
      'changedTaskCount', changed_task_count,
      'changedTaskIds', changed_task_ids,
      'beforeVersion', prior_version,
      'afterVersion', current_state.version
    )
  );
end;
$task_watcher_backfill$;

-- Forward repair: route management work to the existing teaching-control queue,
-- retain historical identities, and reject new assignments to disabled staff.
do $routing$
declare target record; definition text;
begin
  for target in select * from (values
    ('public.create_teacher_absence_atomic(text,text,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text)',
     'when rule = ''candidate-confirm'' then ''思佳''', 'when rule = ''candidate-confirm'' then ''Ops Admin'''),
    ('internal.teacher_departure_creation_tasks_v2(text,text,text,text,text,jsonb,date,timestamp with time zone)',
     '"owner":"思佳"', '"owner":"Ops Admin"')
  ) as targets(signature, old_owner, new_owner) loop
    definition := pg_get_functiondef(target.signature::regprocedure);
    -- Match complete owner expressions, not a bare name also used by watchers.
    -- An existing new expression must never hide a remaining old assignment.
    if position(target.old_owner in definition) = 0 then
      if position(target.new_owner in definition) = 0 then
        raise exception 'staff_routing_definition_drift: %', target.signature;
      end if;
      continue;
    end if;
    if (length(definition) - length(replace(definition, target.old_owner, ''))) / length(target.old_owner) <> 1 then
      raise exception 'staff_routing_definition_drift: %', target.signature;
    end if;
    execute replace(definition, target.old_owner, target.new_owner);
  end loop;
end;
$routing$;

-- Only active records create current responsibilities. Completed/frozen tasks
-- and archived students retain their original attribution for history.
create or replace function internal.current_staff_assignments(p_entity text, p_payload jsonb)
returns table(record_id text, field text, account_name text)
language sql immutable set search_path = '' as $function$
  select item ->> 'id', assignment.field, lower(btrim(assignment.name))
  from jsonb_array_elements(p_payload) item
  cross join lateral (
    select key as field, value #>> '{}' as name
    from jsonb_each(item)
    where key in ('owner', 'planner') and jsonb_typeof(value) = 'string'
    union all
    select key, member #>> '{}'
    from jsonb_each(item)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(value) = 'array' then value else '[]'::jsonb end) member
    where key in ('assignees', 'watchers') and jsonb_typeof(member) = 'string'
  ) assignment
  where p_entity in ('students', 'tasks')
    and coalesce(item ->> 'importArchived', 'false') <> 'true'
    and coalesce(item ->> 'status', '') not in ('done', 'archived', '已归档')
    and coalesce(item #>> '{legacyEvidence,state}', '') <> 'frozen';
$function$;
revoke all on function internal.current_staff_assignments(text,jsonb) from public, anon, authenticated, service_role;

-- Backfill only outstanding work for the already-departed account. Preserve
-- ordering, all unrelated fields, completed history, and an audit receipt.
do $handover$
declare current_state public.ops_state%rowtype; item jsonb; repaired jsonb;
  next_payload jsonb; field_name text; changed_ids jsonb; next_members jsonb;
  migration_actor constant text := 'system:migration:departed-staff-20260914';
begin
  for current_state in select * from public.ops_state
    where entity in ('students','tasks') order by entity for update
  loop
    next_payload := '[]'; changed_ids := '[]';
    for item in select value from jsonb_array_elements(current_state.payload) loop
      repaired := item;
      if exists (select 1 from internal.current_staff_assignments(current_state.entity, jsonb_build_array(item)) where account_name = '思佳') then
        if not exists (select 1 from internal.app_accounts where account_name = 'Ops Admin' and account_role = 'limited-admin' and status = 'active') then
          raise exception 'active_teaching_control_account_required';
        end if;
        foreach field_name in array array['owner','planner'] loop
          if btrim(item ->> field_name) = '思佳' then
            repaired := jsonb_set(repaired, array[field_name], '"Ops Admin"');
          end if;
        end loop;
        foreach field_name in array array['assignees','watchers'] loop
          if jsonb_typeof(item -> field_name) = 'array' then
            select coalesce(jsonb_agg(member order by first_position),'[]') into next_members
            from (
              select case when value = '"思佳"'::jsonb then '"Ops Admin"'::jsonb else value end as member, min(ordinal) as first_position
              from jsonb_array_elements(item -> field_name) with ordinality as members(value,ordinal)
              group by 1
            ) deduped;
            repaired := jsonb_set(repaired,array[field_name],next_members);
          end if;
        end loop;
      end if;
      if repaired is distinct from item then changed_ids := changed_ids || jsonb_build_array(item ->> 'id'); end if;
      next_payload := next_payload || jsonb_build_array(repaired);
    end loop;
    if next_payload is distinct from current_state.payload then
      update public.ops_state set payload = next_payload, version = current_state.version + 1,
        updated_at = now(), updated_by = migration_actor where entity = current_state.entity;
      insert into public.ops_mutation_log(entity,version,actor) values(current_state.entity,current_state.version+1,migration_actor);
      perform internal.append_operational_contract_audit('accounts.outstanding_work_reassigned',migration_actor,'ops_state',current_state.entity,
        jsonb_build_object('from','思佳','to','Ops Admin','changedIds',changed_ids,'beforeVersion',current_state.version,'afterVersion',current_state.version+1));
    end if;
  end loop;
end;
$handover$;

create or replace function internal.prevent_inactive_staff_assignment()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare account_row internal.app_accounts%rowtype; previous_payload jsonb := '[]';
begin
  if new.entity not in ('students','tasks') then return new; end if;
  if tg_op = 'UPDATE' then previous_payload := old.payload; end if;
  -- Only newly introduced responsibilities are checked. An unrelated edit or
  -- command replay must not erase historical attribution after archiving.
  for account_row in
    with added as materialized (
      select * from internal.current_staff_assignments(new.entity,new.payload)
      except
      select * from internal.current_staff_assignments(new.entity,previous_payload)
    )
    select account.* from internal.app_accounts account
    where account.account_role in ('admin','limited-admin','staff')
      and exists (select 1 from added where added.account_name = lower(btrim(account.account_name)))
    order by account.account_id for share of account
  loop
    -- Lock before checking status so a concurrent archive cannot leave a new
    -- assignment using a status read before its account update committed.
    if account_row.status <> 'active' then
      raise exception using errcode = '42501', message = 'inactive_staff_assignment', detail = account_row.account_name;
    end if;
  end loop;
  return new;
end;
$function$;
revoke all on function internal.prevent_inactive_staff_assignment() from public, anon, authenticated, service_role;
drop trigger if exists prevent_inactive_staff_assignment on public.ops_state;
create trigger prevent_inactive_staff_assignment before insert or update of payload on public.ops_state
for each row execute function internal.prevent_inactive_staff_assignment();

create or replace function internal.trial_lp_finalize_tasks(
  p_tasks jsonb, p_lp jsonb, p_finalized boolean, p_now timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(case
    when task ->> 'requestAnchorBookingId' = p_lp ->> 'id'
      and task ->> 'studentId' = p_lp ->> 'studentId'
      and task ->> 'anchorBookingId' = 'JWB:' || (p_lp #>> '{trialSchedule,eventId}')
      and task ->> 'ruleKey' in ('trial.jiaowubao.lp-finalize-tomorrow-n3','trial.jiaowubao.lp-materials-n2')
      and not (task ? 'legacyEvidence')
      and not exists (select 1 from internal.legacy_task_deadline_freezes frozen where frozen.task_id = task ->> 'id')
      and coalesce(task ->> 'dueAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    then case
      when p_finalized and task ->> 'status' <> 'done' then task || jsonb_build_object(
        'status','done','tone','green','completionOutcome','done','result','试听台账已确认LP定稿',
        'closedAt',to_char(p_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      when not p_finalized and task ->> 'status' = 'done'
        and task ->> 'result' = '试听台账已确认LP定稿'
        and coalesce(p_lp ->> 'stage','') <> '完成'
        and coalesce(p_lp ->> 'resultStatus','') not in ('已取消','被家长取消')
        and (task ->> 'ruleKey' <> 'trial.jiaowubao.lp-finalize-tomorrow-n3'
          or p_lp #>> '{trialIntake,requestSentAt}' is null
          or ((p_lp #>> '{trialSchedule,startsAt}')::timestamptz at time zone 'Australia/Melbourne')::date
            - ((p_lp #>> '{trialIntake,requestSentAt}')::timestamptz at time zone 'Australia/Melbourne')::date >= 3)
      then (task - 'closedAt' - 'completionOutcome' - 'result') || jsonb_build_object(
        'status',case when (task ->> 'dueAt')::timestamptz < p_now then 'overdue'
          when ((task ->> 'dueAt')::timestamptz at time zone 'Asia/Shanghai')::date = (p_now at time zone 'Asia/Shanghai')::date then 'today' else 'upcoming' end,
        'tone',case when (task ->> 'dueAt')::timestamptz < p_now then 'red'
          when ((task ->> 'dueAt')::timestamptz at time zone 'Asia/Shanghai')::date = (p_now at time zone 'Asia/Shanghai')::date then 'amber' else 'blue' end)
      else task end
    else task end order by ordinality),'[]'::jsonb)
  from jsonb_array_elements(p_tasks) with ordinality source(task,ordinality)
$$;
revoke all on function internal.trial_lp_finalize_tasks(jsonb,jsonb,boolean,timestamptz)
  from public,anon,authenticated,service_role;

create or replace function internal.trial_terminal_tasks(p_tasks jsonb,p_lp jsonb,p_now timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(case when task ->> 'studentId' = p_lp ->> 'studentId'
    and coalesce(task ->> 'status','') <> 'done' and not (task ? 'legacyEvidence')
    and not exists (select 1 from internal.legacy_task_deadline_freezes frozen where frozen.task_id = task ->> 'id')
    and ((task ->> 'anchorBookingId' = p_lp ->> 'id' and (task ->> 'ruleKey' = 'trial.scheduling' or task ->> 'ruleKey' like 'trial.manual-request.%'))
      or (task ->> 'requestAnchorBookingId' = p_lp ->> 'id' and task ->> 'ruleKey' like 'trial.jiaowubao.%'))
    then task || jsonb_build_object('status','done','tone','green','completionOutcome','done','result','关联试听已取消',
      'closedAt',to_char(p_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    else task end order by ordinality),'[]'::jsonb)
  from jsonb_array_elements(p_tasks) with ordinality source(task,ordinality)
$$;
revoke all on function internal.trial_terminal_tasks(jsonb,jsonb,timestamptz)
  from public,anon,authenticated,service_role;

create or replace function internal.trial_lp_auto_reminder_reopen_valid(
  p_before jsonb,p_after jsonb,p_matches jsonb,p_lp_items jsonb,p_next_lp_items jsonb
)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  lp jsonb; next_lp jsonb; reference jsonb; student jsonb; schedule jsonb;
  candidates integer; source_students jsonb; request_text text; request_at timestamptz;
  starts_at timestamptz; deadline timestamptz; local_deadline timestamp; lead_days integer;
  expected_title text; expected_due text; owner_value text; name_value text;
  lifecycle text[] := array['status','tone','result','closedAt','completionOutcome','dueAt','due','title','owner','assignees'];
begin
  if not coalesce(jsonb_typeof(p_before) = 'object' and jsonb_typeof(p_after) = 'object'
    and p_before ->> 'status' = 'done' and p_before ->> 'tone' = 'green'
    and p_before ->> 'completionOutcome' = 'done' and p_before ->> 'result' = '试听台账已确认LP定稿'
    and p_before ->> 'dueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and pg_catalog.pg_input_is_valid(p_before ->> 'dueAt','timestamp with time zone')
    and p_before ->> 'closedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and pg_catalog.pg_input_is_valid(p_before ->> 'closedAt','timestamp with time zone')
    and p_after ->> 'status' in ('overdue','today','upcoming','waiting') and p_after ->> 'tone' = 'blue'
    and not (p_after ?| array['result','closedAt','completionOutcome'])
    and not (p_before ? 'legacyEvidence') and not (p_after ? 'legacyEvidence')
    and p_before - lifecycle = p_after - lifecycle
    and p_before ->> 'ruleKey' in ('trial.jiaowubao.lp-finalize-tomorrow-n3','trial.jiaowubao.lp-materials-n2')
    and internal.jiaowubao_trial_sync_generated_task_valid(p_after,p_matches,p_lp_items),false)
    or exists (select 1 from internal.legacy_task_deadline_freezes frozen where frozen.task_id = p_before ->> 'id') then return false; end if;
  select count(*),jsonb_agg(current_lp)->0,jsonb_agg(after_lp)->0,jsonb_agg(match)->0
  into candidates,lp,next_lp,reference
  from jsonb_array_elements(p_matches) match
  join jsonb_array_elements(p_lp_items) current_lp on current_lp ->> 'id' = match ->> 'lpItemId'
  join jsonb_array_elements(p_next_lp_items) after_lp on after_lp ->> 'id' = current_lp ->> 'id'
  where p_before ->> 'requestAnchorBookingId' = current_lp ->> 'id'
    and p_before ->> 'studentId' = current_lp ->> 'studentId'
    and p_before ->> 'anchorBookingId' = 'JWB:' || (match ->> 'eventId');
  if candidates <> 1 or not coalesce(lp ->> 'workflowType' in ('试听 LP','换老师试听')
    and coalesce(lp ->> 'stage','') <> '完成' and coalesce(lp ->> 'resultStatus','') not in ('已取消','被家长取消')
    and (not (lp ? 'trialLpFinalized') or lp -> 'trialLpFinalized' in ('false'::jsonb,'null'::jsonb)),false) then return false; end if;
  schedule := next_lp -> 'trialSchedule';
  if not coalesce(schedule ->> 'eventId' = reference ->> 'eventId'
    and schedule ->> 'startsAt' = reference ->> 'startsAt'
    and pg_catalog.pg_input_is_valid(reference ->> 'startsAt','timestamp with time zone'),false) then return false; end if;
  starts_at := (reference ->> 'startsAt')::timestamptz;
  request_text := coalesce(lp #>> '{trialIntake,requestSentAt}',lp ->> 'requestedAt');
  if request_text is not null then
    if not pg_catalog.pg_input_is_valid(request_text,'timestamp with time zone') then return false; end if;
    request_at := request_text::timestamptz;
    lead_days := (starts_at at time zone 'Australia/Melbourne')::date - (request_at at time zone 'Australia/Melbourne')::date;
  end if;
  if p_before ->> 'ruleKey' = 'trial.jiaowubao.lp-finalize-tomorrow-n3' then
    if lead_days < 3 then return false; end if;
    deadline := (((starts_at at time zone 'Australia/Melbourne')::date - 3) + time '18:00') at time zone 'Australia/Melbourne';
    expected_title := '《教务+教统》【明日LP定稿】';
  else
    deadline := case when lead_days between 0 and 2 then least(starts_at,
      ((request_at at time zone 'Australia/Melbourne')::date + time '18:00') at time zone 'Australia/Melbourne')
      else (((starts_at at time zone 'Australia/Melbourne')::date - 2) + time '18:00') at time zone 'Australia/Melbourne' end;
    expected_title := '《教务+教统》【今日LP定稿】';
  end if;
  select payload into source_students from public.ops_state where entity = 'students';
  if jsonb_typeof(source_students) is distinct from 'array' then return false; end if;
  select count(*),jsonb_agg(value)->0 into candidates,student from jsonb_array_elements(source_students)
  where value ->> 'id' = lp ->> 'studentId' and coalesce(value ->> 'importArchived','false') <> 'true';
  if candidates <> 1 then return false; end if;
  owner_value := nullif(btrim(student ->> 'owner'),'');
  name_value := schedule ->> 'studentName';
  if nullif(btrim(name_value),'') is null then return false; end if;
  expected_title := expected_title || '<' || name_value || '> <' || (schedule ->> 'teacherName') || '>';
  local_deadline := deadline at time zone 'Asia/Shanghai';
  expected_due := extract(year from local_deadline)::integer || '年' || extract(month from local_deadline)::integer
    || '月' || extract(day from local_deadline)::integer || '日 ' || to_char(local_deadline,'HH24:MI');
  return coalesce(p_after ->> 'dueAt' = to_char(deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    and p_after ->> 'due' = expected_due and p_after ->> 'title' = expected_title
    and p_after ->> 'owner' = owner_value
    and p_after -> 'assignees' = case when owner_value = 'Ops Admin' then jsonb_build_array(owner_value)
      else jsonb_build_array(owner_value,'Ops Admin') end,false);
end;
$$;
revoke all on function internal.trial_lp_auto_reminder_reopen_valid(jsonb,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;

do $patch$
declare
  definition text;
  patched text;
begin
  definition := pg_catalog.pg_get_functiondef('internal.trial_ledger_stored_value(jsonb,text)'::regprocedure);
  if position('lpFinalized' in definition) = 0 then
    patched := replace(definition,$old$if p_field = 'trialPaid' then
    result := p_item -> 'trialPaid';$old$,$new$if p_field in ('trialPaid','lpFinalized') then
    result := p_item -> case when p_field = 'lpFinalized' then 'trialLpFinalized' else 'trialPaid' end;$new$);
    if patched = definition then raise exception 'trial_ledger_stored_value_patch_missing'; end if;
    execute patched;
  end if;

  definition := pg_catalog.pg_get_functiondef('internal.trial_ledger_value_valid(text,jsonb)'::regprocedure);
  if position('延迟待安排' in definition) = 0 then
    patched := replace(definition, $old$'被家长取消', 'NIL'$old$, $new$'被家长取消', 'NIL', '延迟待安排'$new$);
    if patched = definition then raise exception 'trial_delayed_result_validator_patch_missing'; end if;
    execute patched;
  end if;

  definition := pg_catalog.pg_get_functiondef('internal.trial_ledger_value_valid(text,jsonb)'::regprocedure);
  if position('lpFinalized' in definition) = 0 then
    patched := replace(definition,$old$'resultStatus', 'trialPaid', 'trialLedgerNote'$old$,$new$'resultStatus', 'trialPaid', 'lpFinalized', 'trialLedgerNote'$new$);
    patched := replace(patched,$old$when p_field = 'trialPaid' then jsonb_typeof(p_value) = 'boolean'$old$,$new$when p_field in ('trialPaid','lpFinalized') then jsonb_typeof(p_value) = 'boolean'$new$);
    if patched = definition or position($check$p_field in ('trialPaid','lpFinalized')$check$ in patched) = 0 then raise exception 'trial_ledger_value_valid_patch_missing'; end if;
    execute patched;
  end if;

  definition := pg_catalog.pg_get_functiondef('public.mutate_trial_ledger_field_atomic(text,text,jsonb,text,text,jsonb,jsonb,text)'::regprocedure);
  if position('trialLpFinalized' in definition) = 0 then
    patched := replace(definition,$old$      elsif p_field = 'trialLedgerNote' then$old$,$new$      elsif p_field = 'lpFinalized' then
        if next_value = 'null'::jsonb then
          next_item := next_item - 'trialLpFinalized';
        else
          next_item := jsonb_set(next_item, '{trialLpFinalized}', next_value, true);
        end if;
      elsif p_field = 'trialLedgerNote' then$new$);
    patched := replace(patched,$old$  applied_value boolean := false;$old$,$new$  applied_value boolean := false;
  task_state public.ops_state%rowtype;
  finalized_tasks jsonb;$new$);
    patched := replace(patched,$old$  audit_id_value := internal.append_operational_contract_audit($old$,$new$  if applied_value and (p_field = 'lpFinalized' or (p_field = 'resultStatus' and next_value #>> '{}' in ('已取消','被家长取消'))) then
    select * into task_state from public.ops_state where entity = 'tasks' for update;
    if task_state.entity is null or jsonb_typeof(task_state.payload) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'trial_ledger_task_state_missing';
    end if;
    finalized_tasks := case when p_field = 'lpFinalized' then internal.trial_lp_finalize_tasks(task_state.payload,next_item,next_value = 'true'::jsonb,occurred_at)
      else internal.trial_terminal_tasks(task_state.payload,next_item,occurred_at) end;
    if finalized_tasks is distinct from task_state.payload then
      update public.ops_state set payload = finalized_tasks, version = task_state.version + 1,
        updated_at = occurred_at, updated_by = btrim(p_actor) where entity = 'tasks';
      insert into public.ops_mutation_log(entity,version,actor) values('tasks',task_state.version + 1,btrim(p_actor));
    end if;
  end if;

  audit_id_value := internal.append_operational_contract_audit($new$);
    if patched = definition or position('trial_ledger_task_state_missing' in patched) = 0 or position('task_state public.ops_state%rowtype' in patched) = 0 then raise exception 'trial_ledger_lp_finalized_patch_missing'; end if;
    execute patched;
  end if;

  definition := pg_catalog.pg_get_functiondef('internal.jiaowubao_trial_sync_generated_task_valid(jsonb,jsonb,jsonb)'::regprocedure);
  if position('trial.jiaowubao.request-follow-up-n3' in definition) = 0 then
    patched := replace(definition,$old$'trial.jiaowubao.lp-finalize-tomorrow-n3',$old$,$new$'trial.jiaowubao.request-follow-up-n3',
      'trial.jiaowubao.lp-finalize-tomorrow-n3',$new$);
    patched := replace(patched,$old$and p_task ->> 'studentId' = lp ->> 'studentId'$old$,$new$and p_task ->> 'studentId' = lp ->> 'studentId'
        and (p_task ->> 'ruleKey' <> 'trial.jiaowubao.request-follow-up-n3' or (
          lp #>> '{fields,specifiedContentStatus}' in ('需教务跟进','需要跟进')
          or coalesce(lp #> '{fields,writingRequired}',lp #> '{trialIntake,writingRequired}') = 'true'::jsonb
          or coalesce(lp #> '{fields,paperRequired}',lp #> '{trialIntake,paperRequired}') = 'true'::jsonb
        ))$new$);
    if patched = definition or position('fields,specifiedContentStatus' in patched) = 0 then raise exception 'trial_request_follow_up_validator_patch_missing'; end if;
    execute patched;
  end if;
  definition := pg_catalog.pg_get_functiondef('internal.jiaowubao_trial_sync_generated_task_valid(jsonb,jsonb,jsonb)'::regprocedure);
  if position('trialLedgerOverrides,planner' in definition) = 0 then
    patched := replace(definition,$old$nullif(btrim(lp #>> '{trialIntake,planner}'), '')$old$,
      $new$nullif(btrim(lp #>> '{trialLedgerOverrides,planner}'), ''), nullif(btrim(lp #>> '{trialIntake,planner}'), '')$new$);
    if patched = definition then raise exception 'trial_planner_override_validator_patch_missing'; end if;
    execute patched;
  end if;

  definition := pg_catalog.pg_get_functiondef('public.mutate_trial_payment_task_lifecycle_tx(text,text,jsonb,text,text,jsonb,text,text)'::regprocedure);
  if position('trialLedgerOverrides,planner' in definition) = 0 then
    patched := replace(definition,$old$    planner_value := case lower(coalesce(
      nullif(btrim(lp_item #>> '{trialIntake,planner}'), ''),
      nullif(btrim(lp_item #>> '{fields,planner}'), ''),
      nullif(btrim(student_item ->> 'planner'), '')
    ))
      when 'tara' then 'Tara'
      when 'eileen' then 'Eileen'
      when 'abby' then 'Abby'
      else null
    end;
$old$,$new$    planner_value := coalesce(
      case lower(nullif(btrim(lp_item #>> '{trialLedgerOverrides,planner}'), ''))
        when 'tara' then 'Tara'
        when 'eileen' then 'Eileen'
        when 'abby' then 'Abby'
        else null
      end,
      case lower(coalesce(
        nullif(btrim(lp_item #>> '{trialIntake,planner}'), ''),
        nullif(btrim(lp_item #>> '{fields,planner}'), ''),
        nullif(btrim(student_item ->> 'planner'), '')
      ))
        when 'tara' then 'Tara'
        when 'eileen' then 'Eileen'
        when 'abby' then 'Abby'
        else null
      end
    );
$new$);
    if patched = definition then raise exception 'trial_payment_planner_override_patch_missing'; end if;
    execute patched;
  end if;

  definition := pg_catalog.pg_get_functiondef('public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure);
  if position('internal.trial_lp_auto_reminder_reopen_valid' in definition) = 0 then
    patched := replace(definition,$old$where new_task = old_task)$old$,
      $new$where new_task = old_task or internal.trial_lp_auto_reminder_reopen_valid(old_task,new_task,p_matches,l.payload,p_next_lp_items))$new$);
    if patched = definition then raise exception 'trial_lp_auto_reminder_reopen_guard_patch_missing'; end if;
    execute patched;
  end if;
end;
$patch$;

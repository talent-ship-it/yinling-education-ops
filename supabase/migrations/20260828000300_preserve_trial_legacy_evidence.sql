-- Preserve frozen historical task evidence while replacing only the legacy
-- tasks generated for the newly-created trial LP. SQL NOT propagates NULL,
-- so missing legacy anchor/rule fields must be normalized before filtering;
-- the immutable freeze ledger is also an explicit keep-list.

create or replace function public.mutate_lp_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_operation text,
  p_student_id text,
  p_provisional_intake jsonb,
  p_lp_item_id text,
  p_workflow_type text,
  p_fields jsonb,
  p_revision_note text,
  p_authorized_assignment jsonb,
  p_expected_versions jsonb,
  p_actor text
)
returns table(command_key text, operation text, applied boolean, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state, tasks_row public.ops_state,
  files_row public.ops_state, audit_entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  delegated record;
  full_prior internal.trial_lp_atomic_intents%rowtype;
  delegated_fields jsonb := p_fields;
  delegated_intent jsonb := p_command_intent;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  saved_l public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  lp_item jsonb;
  student jsonb;
  existing_task jsonb;
  full_fields jsonb;
  trial_intake jsonb;
  next_l jsonb;
  next_t jsonb;
  revisions jsonb;
  generated jsonb;
  manual_rules text[] := array[]::text[];
  rule text;
  owner_value text;
  student_name text;
  task_id_value text;
  request_at timestamptz;
  task_due timestamptz;
  finalized_at timestamptz;
  due_text text;
  due_at_text text;
  task_status text;
  final_audit_id_value uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  if p_operation = 'create' and p_workflow_type = '试听 LP' then
    if jsonb_typeof(p_fields) is distinct from 'object'
       or p_command_intent -> 'fields' is distinct from p_fields
       or jsonb_typeof(p_fields -> 'planner') is distinct from 'string'
       or p_fields ->> 'planner' not in ('Tara','Eileen','Abby')
       or jsonb_typeof(p_fields -> 'requestSentAt') is distinct from 'string'
       or jsonb_typeof(p_fields -> 'contactParents') is distinct from 'boolean'
       or jsonb_typeof(p_fields -> 'contactStudent') is distinct from 'boolean'
       or not ((p_fields ->> 'contactParents')::boolean or (p_fields ->> 'contactStudent')::boolean)
       or jsonb_typeof(p_fields -> 'writingRequired') is distinct from 'boolean'
       or jsonb_typeof(p_fields -> 'paperRequired') is distinct from 'boolean'
       or jsonb_typeof(p_fields -> 'trialDurationMinutes') is distinct from 'number'
       or p_fields ->> 'trialDurationMinutes' not in ('45','60')
       or exists (
         select 1 from jsonb_each(p_fields) field
         where field.key in ('contactNote','writingNote','paperNote','preparationNote','studentName','trialDurationNote')
           and jsonb_typeof(field.value) is distinct from 'string'
       )
       or exists (
         select 1 from jsonb_each_text(p_fields) field
         where field.key in ('contactNote','writingNote','paperNote','preparationNote','trialDurationNote')
           and length(field.value) > 2000
       )
       or length(coalesce(p_fields ->> 'studentName', '')) > 240 then
      raise exception using errcode = '22023', message = 'invalid_trial_manual_fields';
    end if;
    begin
      request_at := (p_fields ->> 'requestSentAt')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_trial_request_instant';
    end;
    delegated_fields := (
      p_fields - array[
        'planner','requestSentAt','contactParents','contactStudent','contactNote',
        'writingRequired','writingNote','paperRequired','paperNote','preparationNote',
        'studentName','trialDurationMinutes','trialDurationNote'
      ]::text[]
    ) || case when p_fields ->> 'specifiedContentStatus' = '需教务跟进'
      then jsonb_build_object('specifiedContentStatus', '需要跟进')
      else '{}'::jsonb
    end;
    delegated_intent := p_command_intent || jsonb_build_object('fields', delegated_fields);
    select * into full_prior
    from internal.trial_lp_atomic_intents
    where command_uuid = lower(trim(p_command_uuid));
    if full_prior.command_uuid is not null
       and (full_prior.command_intent is distinct from p_command_intent or full_prior.actor <> trim(p_actor)) then
      raise exception using errcode = '23505', message = 'lp_idempotency_conflict';
    end if;
  end if;

  select * into delegated
  from public.mutate_lp_atomic_before_trial_manual_tasks(
    p_secret,
    p_command_uuid,
    delegated_intent,
    p_operation,
    p_student_id,
    p_provisional_intake,
    p_lp_item_id,
    p_workflow_type,
    delegated_fields,
    p_revision_note,
    p_authorized_assignment,
    p_expected_versions,
    p_actor
  );
  if delegated.command_key is null then
    raise exception using errcode = '55000', message = 'lp_atomic_result_missing';
  end if;

  if p_operation <> 'create' or p_workflow_type <> '试听 LP' then
    return query select delegated.command_key, delegated.operation, delegated.applied,
      delegated.student_id, delegated.lp_item_id, delegated.students_row,
      delegated.lp_items_row, delegated.tasks_row, delegated.files_row,
      delegated.audit_entry_id;
    return;
  end if;

  -- A committed full-intent row proves that this exact command was already
  -- finalized. The inner replay returns the current authoritative rows.
  select * into full_prior
  from internal.trial_lp_atomic_intents
  where command_uuid = lower(trim(p_command_uuid));
  if full_prior.command_uuid is not null then
    if full_prior.command_intent is distinct from p_command_intent or full_prior.actor <> trim(p_actor) then
      raise exception using errcode = '23505', message = 'lp_idempotency_conflict';
    end if;
    return query select delegated.command_key, delegated.operation, delegated.applied,
      delegated.student_id, delegated.lp_item_id, delegated.students_row,
      delegated.lp_items_row, delegated.tasks_row, delegated.files_row,
      full_prior.final_audit_id;
    return;
  end if;

  -- The inner LP writer still holds files -> students -> lpItems -> tasks.
  -- Re-locking the last two rows is safe and keeps the final projection in the
  -- same transaction without exposing an intermediate legacy state.
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_manual_state_missing';
  end if;
  select value into lp_item
  from jsonb_array_elements(l.payload)
  where value ->> 'id' = delegated.lp_item_id
  limit 1;
  if lp_item is null then
    raise exception using errcode = '55000', message = 'trial_manual_lp_missing';
  end if;
  select value into student
  from jsonb_array_elements((delegated.students_row).payload)
  where value ->> 'id' = delegated.student_id
  limit 1;

  finalized_at := clock_timestamp();
  owner_value := lp_item ->> 'owner';
  student_name := coalesce(
    nullif(trim(p_fields ->> 'studentName'), ''),
    nullif(trim(student ->> 'name'), ''),
    '试听学员（姓名未提到）'
  );
  full_fields := p_fields || jsonb_build_object(
    'responsibleOperations', lp_item -> 'fields' ->> 'responsibleOperations'
  );
  trial_intake := jsonb_build_object(
    'planner', p_fields ->> 'planner',
    'requestSentAt', to_char(request_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'contactParents', (p_fields ->> 'contactParents')::boolean,
    'contactStudent', (p_fields ->> 'contactStudent')::boolean,
    'writingRequired', (p_fields ->> 'writingRequired')::boolean,
    'paperRequired', (p_fields ->> 'paperRequired')::boolean,
    'trialDurationMinutes', (p_fields ->> 'trialDurationMinutes')::integer
  );
  for rule in select field_key from unnest(array[
    'contactNote','writingNote','paperNote','preparationNote','studentName','trialDurationNote'
  ]) field_key loop
    if nullif(trim(p_fields ->> rule), '') is not null then
      trial_intake := trial_intake || jsonb_build_object(rule, trim(p_fields ->> rule));
    end if;
  end loop;

  revisions := (
    select coalesce(jsonb_agg(
      case when revision.ordinality = 1
        then revision.value || jsonb_build_object('after', full_fields)
        else revision.value
      end order by revision.ordinality
    ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(lp_item -> 'revisions', '[]'::jsonb))
      with ordinality revision(value, ordinality)
  );
  lp_item := lp_item || jsonb_build_object(
    'fields', full_fields,
    'requestedAt', to_char(request_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'trialIntake', trial_intake,
    'revisions', revisions
  );
  next_l := (
    select coalesce(jsonb_agg(
      case when item.value ->> 'id' = delegated.lp_item_id then lp_item else item.value end
      order by item.ordinality
    ), '[]'::jsonb)
    from jsonb_array_elements(l.payload) with ordinality item(value, ordinality)
  );

  -- Remove only open legacy tasks. Completed evidence remains immutable for a
  -- historical replay, while every new LP has no completed tasks at this point.
  next_t := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
    where not (
      not exists (
        select 1
        from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
      and coalesce(task.value ->> 'anchorBookingId', '') = delegated.lp_item_id
      and coalesce(task.value ->> 'status', '') <> 'done'
      and (
        coalesce(task.value ->> 'ruleKey', '') in (
          'trial.parent-follow-up','trial.scheduling','trial.parent-no-reply-follow-up',
          'trial.teaching-control-escalation','trial.parent-progress-sync.1'
        )
        or coalesce(task.value ->> 'ruleKey', '') like 'trial.manual-request.%'
      )
    )
  );

  if p_fields ->> 'specifiedContentStatus' in ('需要跟进', '需教务跟进') then
    manual_rules := array_append(manual_rules, 'trial.manual-request.specified-content');
  end if;
  if (p_fields ->> 'writingRequired')::boolean then
    manual_rules := array_append(manual_rules, 'trial.manual-request.writing');
  end if;
  if (p_fields ->> 'paperRequired')::boolean then
    manual_rules := array_append(manual_rules, 'trial.manual-request.paper-send');
    manual_rules := array_append(manual_rules, 'trial.manual-request.paper-receive');
  end if;
  manual_rules := manual_rules || array[
    'trial.manual-request.parent-progress-24h',
    'trial.manual-request.scheduling-alert-36h',
    'trial.manual-request.parent-progress-48h'
  ];

  foreach rule in array manual_rules loop
    task_due := case rule
      when 'trial.manual-request.specified-content' then
        ((request_at at time zone 'Asia/Shanghai')::date + time '18:00') at time zone 'Asia/Shanghai'
      when 'trial.manual-request.writing' then
        ((request_at at time zone 'Asia/Shanghai')::date + time '18:00') at time zone 'Asia/Shanghai'
      when 'trial.manual-request.paper-send' then
        ((request_at at time zone 'Asia/Shanghai')::date + time '18:00') at time zone 'Asia/Shanghai'
      when 'trial.manual-request.paper-receive' then request_at + interval '24 hours'
      when 'trial.manual-request.parent-progress-24h' then request_at + interval '24 hours'
      when 'trial.manual-request.scheduling-alert-36h' then request_at + interval '36 hours'
      else request_at + interval '48 hours'
    end;
    task_due := greatest(task_due, finalized_at);
    task_id_value := internal.trial_manual_task_id(delegated.lp_item_id, rule);
    select value into existing_task
    from jsonb_array_elements(t.payload)
    where value ->> 'id' = task_id_value and value ->> 'status' = 'done'
    limit 1;
    if existing_task is not null then continue; end if;

    due_text := to_char(task_due at time zone 'Asia/Shanghai', 'YYYY"年"MM"月"DD"日" HH24:MI');
    due_at_text := to_char(task_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    task_status := case
      when (task_due at time zone 'Australia/Melbourne')::date < (finalized_at at time zone 'Australia/Melbourne')::date then 'overdue'
      when (task_due at time zone 'Australia/Melbourne')::date = (finalized_at at time zone 'Australia/Melbourne')::date then 'today'
      else 'upcoming'
    end;
    generated := jsonb_build_object(
      'id', task_id_value,
      'title', case rule
        when 'trial.manual-request.specified-content' then '《教务+教统》【指定试听内容】<' || student_name || '>'
        when 'trial.manual-request.writing' then '《教务+教统》【完成试听写作要求】<' || student_name || '>'
        when 'trial.manual-request.paper-send' then '《教务+教统》【发送试听试卷】<' || student_name || '>'
        when 'trial.manual-request.paper-receive' then '《教务+教统》【收回试听试卷】<' || student_name || '>'
        when 'trial.manual-request.parent-progress-24h' then '《教务+教统》【向家长同步试听安排进度】<首次 · ' || student_name || '>'
        when 'trial.manual-request.scheduling-alert-36h' then '《教务+教统》【试听排课异常提醒】<教务宝仍未匹配 · ' || student_name || '>'
        else '《教务+教统》【向家长同步试听安排进度】<第二次 · ' || student_name || '>'
      end,
      'owner', owner_value,
      'assignees', jsonb_build_array(owner_value, 'Ops Admin'),
      'watchers', jsonb_build_array('Ops Admin'),
      'studentId', delegated.student_id,
      'due', due_text,
      'dueAt', due_at_text,
      'status', task_status,
      'tone', case when rule = 'trial.manual-request.scheduling-alert-36h' then 'red' else 'blue' end,
      'category', case
        when rule = 'trial.manual-request.scheduling-alert-36h' then '排课'
        when rule in (
          'trial.manual-request.specified-content','trial.manual-request.writing',
          'trial.manual-request.paper-send','trial.manual-request.paper-receive'
        ) then 'LP'
        else '试听'
      end,
      'trigger', '试听 LP 信息交接后按手册自动生成',
      'ruleKey', rule,
      'anchorBookingId', delegated.lp_item_id
    );
    next_t := next_t || jsonb_build_array(generated);
  end loop;

  if next_l is distinct from l.payload then
    update public.ops_state
    set payload = next_l, version = l.version + 1, updated_at = now(), updated_by = trim(p_actor)
    where entity = 'lpItems'
    returning * into saved_l;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('lpItems', saved_l.version, saved_l.updated_by);
  else
    saved_l := l;
  end if;
  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t, version = t.version + 1, updated_at = now(), updated_by = trim(p_actor)
    where entity = 'tasks'
    returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_t.version, saved_t.updated_by);
  else
    saved_t := t;
  end if;

  final_audit_id_value := internal.append_operational_contract_audit(
    'lp.atomic.trial-manual-finalize',
    trim(p_actor),
    'student',
    delegated.student_id,
    jsonb_build_object(
      'commandUuid', lower(trim(p_command_uuid)),
      'lpItemId', delegated.lp_item_id,
      'commandIntentSha256', encode(extensions.digest(p_command_intent::text, 'sha256'), 'hex'),
      'manualTaskCount', cardinality(manual_rules),
      'lpItemsVersion', saved_l.version,
      'tasksVersion', saved_t.version
    )
  );
  insert into internal.trial_lp_atomic_intents(
    command_uuid, command_intent, actor, final_audit_id
  ) values (
    lower(trim(p_command_uuid)), p_command_intent, trim(p_actor), final_audit_id_value
  );

  return query select delegated.command_key, delegated.operation, true,
    delegated.student_id, delegated.lp_item_id, delegated.students_row,
    saved_l, saved_t, delegated.files_row, final_audit_id_value;
end;
$$;
revoke all on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  to anon, authenticated;

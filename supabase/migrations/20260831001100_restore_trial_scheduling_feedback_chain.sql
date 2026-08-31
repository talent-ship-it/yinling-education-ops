-- Restore the exact trial-scheduling feedback chain confirmed in the Tencent
-- handbook: 24h first parent update, 48h second update, and a 72h anomaly.
-- The teacher-reply 4h/8h branch remains disabled because the same handbook
-- explicitly marks it as pending confirmation.

create or replace function internal.trial_handbook_manual_task_title(
  p_rule_key text,
  p_student_name text,
  p_guardian_wechat text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_rule_key
    when 'trial.manual-request.specified-content' then '《教务+教统》【要指定内容】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.writing' then '《教务+教统》【要写作】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.paper-send' then '《教务+教统》【发试卷】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.paper-receive' then '《教务+教统》【收试卷】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.parent-progress-24h' then '《教务+教统》【向家长交待排课进度】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.parent-progress-48h' then '《教务+教统》【二次向家长交待排课进度】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.scheduling-anomaly-72h' then '《教务+教统》【试听排课进度反常】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.scheduling-alert-36h' then '《教务+教统》【试听排课进度反常】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    else null
  end
$$;
revoke all on function internal.trial_handbook_manual_task_title(text, text, text)
  from public, anon, authenticated, service_role;

create or replace function internal.trial_scheduling_policy_tasks(
  p_tasks jsonb,
  p_lp_item_id text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  projected jsonb;
  template jsonb;
  generated jsonb;
  base_due_at timestamptz;
  task_due timestamptz;
  rule text;
  main_title text;
  task_title text;
  task_tone text;
  task_category text;
begin
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or nullif(btrim(p_lp_item_id), '') is null then
    raise exception using errcode = '22023', message = 'trial_scheduling_policy_input_invalid';
  end if;

  -- The superseded 36h anomaly is operational state, not a valid current
  -- reminder. Completed and frozen rows remain immutable history.
  projected := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(p_tasks) with ordinality task(value, ordinality)
    where not (
      task.value ->> 'anchorBookingId' = p_lp_item_id
      and task.value ->> 'ruleKey' = 'trial.manual-request.scheduling-alert-36h'
      and coalesce(task.value ->> 'status', '') <> 'done'
      and not (task.value ? 'legacyEvidence')
      and not exists (
        select 1
        from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
    )
  );

  select task.value into template
  from jsonb_array_elements(projected) task(value)
  where task.value ->> 'anchorBookingId' = p_lp_item_id
    and task.value ->> 'ruleKey' in (
      'trial.manual-request.parent-progress-24h',
      'trial.scheduling'
    )
    and coalesce(task.value ->> 'dueAt', '')
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and not (task.value ? 'legacyEvidence')
    and not exists (
      select 1
      from internal.legacy_task_deadline_freezes evidence
      where evidence.task_id = task.value ->> 'id'
    )
  order by case when task.value ->> 'ruleKey' = 'trial.manual-request.parent-progress-24h' then 0 else 1 end
  limit 1;

  if template is null then return projected; end if;
  begin
    base_due_at := (template ->> 'dueAt')::timestamptz;
  exception when others then
    return projected;
  end;

  foreach rule in array array[
    'trial.scheduling',
    'trial.manual-request.parent-progress-24h',
    'trial.manual-request.parent-progress-48h',
    'trial.manual-request.scheduling-anomaly-72h'
  ]::text[] loop
    if exists (
      select 1
      from jsonb_array_elements(projected) task(value)
      where task.value ->> 'anchorBookingId' = p_lp_item_id
        and task.value ->> 'ruleKey' = rule
    ) then continue; end if;

    task_due := case rule
      when 'trial.manual-request.parent-progress-48h' then base_due_at + interval '24 hours'
      when 'trial.manual-request.scheduling-anomaly-72h' then base_due_at + interval '48 hours'
      else base_due_at
    end;
    main_title := case rule
      when 'trial.scheduling' then '试听待排课'
      when 'trial.manual-request.parent-progress-24h' then '向家长交待排课进度'
      when 'trial.manual-request.parent-progress-48h' then '二次向家长交待排课进度'
      else '试听排课进度反常'
    end;
    task_title := regexp_replace(
      coalesce(template ->> 'title', ''),
      '【[^】]*】',
      '【' || main_title || '】'
    );
    if task_title = coalesce(template ->> 'title', '') then
      task_title := '《教务+教统》【' || main_title || '】';
    end if;
    task_tone := case when rule in (
      'trial.scheduling', 'trial.manual-request.scheduling-anomaly-72h'
    ) then 'red' else 'blue' end;
    task_category := case when rule in (
      'trial.scheduling', 'trial.manual-request.scheduling-anomaly-72h'
    ) then '排课' else '试听' end;

    generated := (template
      - 'completionOutcome'
      - 'completionNote'
      - 'result'
      - 'closedAt'
      - 'note') || jsonb_build_object(
        'id', internal.trial_manual_task_id(p_lp_item_id, rule),
        'title', task_title,
        'due', to_char(task_due at time zone 'Asia/Shanghai', 'YYYY"年"MM"月"DD"日" HH24:MI'),
        'dueAt', to_char(task_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'status', case
          when (task_due at time zone 'Australia/Melbourne')::date
            < (now() at time zone 'Australia/Melbourne')::date then 'overdue'
          when (task_due at time zone 'Australia/Melbourne')::date
            = (now() at time zone 'Australia/Melbourne')::date then 'today'
          else 'upcoming'
        end,
        'tone', task_tone,
        'category', task_category,
        'trigger', case rule
          when 'trial.scheduling' then '试听 LP 信息交接后立即生成，排课后由教务宝自动完成'
          when 'trial.manual-request.parent-progress-24h' then '试听需求发出后 24 小时且教务宝未排课'
          when 'trial.manual-request.parent-progress-48h' then '试听需求发出后 48 小时且教务宝未排课'
          else '试听需求发出后 72 小时且教务宝未排课'
        end,
        'ruleKey', rule,
        'anchorBookingId', p_lp_item_id
      );
    projected := projected || jsonb_build_array(generated);
  end loop;

  return projected;
end;
$$;
revoke all on function internal.trial_scheduling_policy_tasks(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_trial_sync_manual_completion_valid(
  p_before jsonb,
  p_after jsonb,
  p_matches jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_typeof(p_before) = 'object'
    and jsonb_typeof(p_after) = 'object'
    and p_before ->> 'id' = p_after ->> 'id'
    and p_before ->> 'ruleKey' in (
      'trial.scheduling',
      'trial.manual-request.parent-progress-24h',
      'trial.manual-request.parent-progress-48h',
      'trial.manual-request.scheduling-anomaly-72h'
    )
    and (p_before - 'status' - 'tone' - 'completionOutcome' - 'result' - 'closedAt')
      = (p_after - 'status' - 'tone' - 'completionOutcome' - 'result' - 'closedAt')
    and p_after ->> 'status' = 'done'
    and p_after ->> 'tone' = 'green'
    and p_after ->> 'completionOutcome' = 'done'
    and p_after ->> 'closedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and exists (
      select 1 from jsonb_array_elements(p_matches) match
      where match ->> 'lpItemId' = p_after ->> 'anchorBookingId'
        and p_after ->> 'result' = '教务宝真实排课已匹配：' || (match ->> 'eventId')
    )
$$;
revoke all on function internal.jiaowubao_trial_sync_manual_completion_valid(jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Add the missing feedback tasks to current, still-unscheduled trials. This is
-- intentionally idempotent and never alters completed or frozen evidence.
do $migration$
declare
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  next_t jsonb;
  lp jsonb;
  saved public.ops_state%rowtype;
begin
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_scheduling_feedback_backfill_state_missing';
  end if;

  next_t := t.payload;
  for lp in
    select item.value
    from jsonb_array_elements(l.payload) item(value)
    where item.value ->> 'workflowType' = '试听 LP'
      and coalesce(item.value ->> 'stage', '') <> '完成'
      and nullif(btrim(item.value #>> '{trialSchedule,eventId}'), '') is null
  loop
    next_t := internal.trial_scheduling_policy_tasks(next_t, lp ->> 'id');
  end loop;

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t,
        version = t.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-scheduling-feedback-chain'
    where entity = 'tasks'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved.version, saved.updated_by);
  end if;
end;
$migration$;

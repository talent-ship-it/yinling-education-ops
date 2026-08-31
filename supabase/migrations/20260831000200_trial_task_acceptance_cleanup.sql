-- Remove the still-open trial tasks rejected during the 2026-08-31 acceptance
-- review. Completed and frozen rows remain immutable operational evidence.

do $migration$
declare
  t public.ops_state%rowtype;
  next_t jsonb;
  saved public.ops_state%rowtype;
begin
  select * into t from public.ops_state where entity = 'tasks' for update;
  if t.entity is null or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_task_acceptance_state_missing';
  end if;

  next_t := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
    where not (
      coalesce(task.value ->> 'status', '') <> 'done'
      and not (task.value ? 'legacyEvidence')
      and not exists (
        select 1
        from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
      and (
        task.value ->> 'ruleKey' in (
          'trial.parent-follow-up',
          'trial.parent-no-reply-follow-up',
          'trial.teaching-control-escalation',
          'trial.lp-review',
          'trial.prep',
          'trial.minimum',
          'trial.short-notice-prep',
          'trial.manual-request.scheduling-alert-36h',
          'trial.manual-request.parent-progress-48h',
          'trial.jiaowubao.teacher-reply-4h',
          'trial.jiaowubao.teacher-reply-8h'
        )
        or coalesce(task.value ->> 'ruleKey', '') ~ '^trial[.]parent-progress-sync[.][1-9][0-9]*$'
        or btrim(coalesce(task.value ->> 'title', '')) in (
          '发送家长试听跟进请求',
          '家长未回复：再次跟进',
          '家长未回复：向负责人汇报',
          '试听 LP：核对交接信息',
          '审核试听 LP',
          '紧急审核试听 LP',
          '确认老师备课内容与资料',
          '紧急确认老师备课内容与资料',
          '完成试听前最低检查',
          '短通知备课确认'
        )
        or btrim(coalesce(task.value ->> 'title', '')) like '试听 LP：核对交接信息%'
        or btrim(coalesce(task.value ->> 'title', '')) ~ '^QA 系统验收[[:space:]]*20260827([[:space:]]|$)'
      )
    )
  );

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t,
        version = t.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-task-acceptance-cleanup'
    where entity = 'tasks'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved.version, saved.updated_by);
  end if;
end;
$migration$;

create or replace function internal.trial_ledger_value_valid(
  p_field text,
  p_value jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_field not in (
      'studentName', 'guardianWechat', 'workflowType', 'lessonMonth',
      'requestedAt', 'scheduledAt', 'operationsOwner', 'planner', 'subject', 'teacher',
      'resultStatus', 'trialPaid', 'trialLedgerNote'
    ) then false
    when p_value = 'null'::jsonb then true
    when p_field = 'trialPaid' then jsonb_typeof(p_value) = 'boolean'
    when jsonb_typeof(p_value) <> 'string' then false
    when nullif(btrim(p_value #>> '{}'), '') is null then false
    when p_field in ('studentName', 'guardianWechat', 'subject', 'teacher')
      then length(p_value #>> '{}') <= 240 and p_value #>> '{}' = btrim(p_value #>> '{}')
    when p_field = 'trialLedgerNote'
      then length(p_value #>> '{}') <= 2000 and p_value #>> '{}' = btrim(p_value #>> '{}')
    when p_field = 'workflowType' then p_value #>> '{}' in ('试听 LP', '换老师试听')
    when p_field = 'lessonMonth' then p_value #>> '{}' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    when p_field in ('requestedAt', 'scheduledAt')
      then p_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    when p_field = 'operationsOwner'
      then p_value #>> '{}' in ('Tiffany', 'Ella', 'Abby', 'Molly', 'Thea', 'Erin')
    when p_field = 'planner' then p_value #>> '{}' in ('Tara', 'Eileen', 'Abby')
    when p_field = 'resultStatus'
      then p_value #>> '{}' in (
        '试听成功', '试听失败', '有希望报名', '试听未进行', '在读试听成功', '在读试听失败',
        '被家长取消', 'NIL'
      )
    else false
  end
$$;
revoke all on function internal.trial_ledger_value_valid(text, jsonb)
  from public, anon, authenticated, service_role;

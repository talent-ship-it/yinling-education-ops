-- Field-level, idempotent edits for the 13-column trial review ledger. Manual
-- corrections are stored separately from immutable Jiaowubao source evidence.

create table if not exists internal.trial_ledger_commands (
  command_key uuid primary key,
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  lp_item_id text not null check (length(lp_item_id) between 1 and 160),
  student_id text not null check (length(student_id) between 1 and 120),
  field text not null,
  lp_items_version bigint not null check (lp_items_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied boolean not null,
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict
);
alter table internal.trial_ledger_commands enable row level security;
revoke all on table internal.trial_ledger_commands from public, anon, authenticated, service_role;

create or replace function internal.trial_ledger_stored_value(
  p_item jsonb,
  p_field text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
  text_value text;
begin
  if p_field in (
    'studentName', 'guardianWechat', 'workflowType', 'lessonMonth',
    'requestedAt', 'scheduledAt', 'operationsOwner', 'planner', 'subject', 'teacher'
  ) then
    result := p_item -> 'trialLedgerOverrides' -> p_field;
    if jsonb_typeof(result) = 'string' and nullif(btrim(result #>> '{}'), '') is not null then
      return to_jsonb(btrim(result #>> '{}'));
    end if;
    return 'null'::jsonb;
  end if;
  if p_field = 'resultStatus' then
    text_value := nullif(btrim(p_item ->> 'resultStatus'), '');
    return coalesce(to_jsonb(text_value), 'null'::jsonb);
  end if;
  if p_field = 'trialPaid' then
    result := p_item -> 'trialPaid';
    return case when jsonb_typeof(result) = 'boolean' then result else 'null'::jsonb end;
  end if;
  if p_field = 'trialLedgerNote' then
    text_value := nullif(btrim(p_item ->> 'trialLedgerNote'), '');
    return coalesce(to_jsonb(text_value), 'null'::jsonb);
  end if;
  return null;
end;
$$;
revoke all on function internal.trial_ledger_stored_value(jsonb, text)
  from public, anon, authenticated, service_role;

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
        '试听成功', '试听失败', '有希望报名', '试听未进行', '在读试听成功', '在读试听失败'
      )
    else false
  end
$$;
revoke all on function internal.trial_ledger_value_valid(text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.get_trial_ledger_command_result(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_actor text
)
returns table(
  command_key text,
  lp_item_id text,
  student_id text,
  field text,
  lp_items_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  prior internal.trial_ledger_commands%rowtype;
  l public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_command_uuid)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_trial_ledger_replay_lookup';
  end if;

  select * into prior
  from internal.trial_ledger_commands ledger
  where ledger.command_key = lower(btrim(p_command_uuid))::uuid;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
    raise exception using errcode = '23505', message = 'trial_ledger_idempotency_conflict';
  end if;
  select * into l from public.ops_state where entity = 'lpItems' for share;
  if l.entity is null or l.version < prior.lp_items_version then
    raise exception using errcode = '55000', message = 'trial_ledger_replay_version_regressed';
  end if;
  return query select prior.command_key::text, prior.lp_item_id, prior.student_id,
    prior.field, l, prior.audit_id;
end;
$$;
revoke all on function public.get_trial_ledger_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_trial_ledger_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.mutate_trial_ledger_field_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_lp_item_id text,
  p_field text,
  p_expected_value jsonb,
  p_value jsonb,
  p_actor text
)
returns table(
  command_key text,
  applied boolean,
  lp_item_id text,
  student_id text,
  field text,
  lp_items_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  command_uuid uuid;
  command_hash_value text;
  expected_value jsonb := coalesce(p_expected_value, 'null'::jsonb);
  next_value jsonb := coalesce(p_value, 'null'::jsonb);
  prior internal.trial_ledger_commands%rowtype;
  l public.ops_state%rowtype;
  saved_l public.ops_state%rowtype;
  item jsonb;
  next_item jsonb;
  next_payload jsonb;
  overrides jsonb;
  current_value jsonb;
  student_id_value text;
  occurred_at timestamptz := clock_timestamp();
  occurred_at_text text;
  field_audit jsonb;
  audit_id_value uuid;
  applied_value boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_command_uuid)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or coalesce(btrim(p_lp_item_id), '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120
     or not internal.trial_ledger_value_valid(p_field, expected_value)
     or not internal.trial_ledger_value_valid(p_field, next_value)
     or p_command_intent is distinct from jsonb_build_object(
       'lpItemId', btrim(p_lp_item_id),
       'field', p_field,
       'expectedValue', expected_value,
       'value', next_value
     ) then
    raise exception using errcode = '22023', message = 'invalid_trial_ledger_request';
  end if;
  command_uuid := lower(btrim(p_command_uuid))::uuid;
  command_hash_value := encode(extensions.digest(convert_to(p_command_intent::text, 'UTF8'), 'sha256'), 'hex');

  select * into prior
  from internal.trial_ledger_commands ledger
  where ledger.command_key = command_uuid;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
      raise exception using errcode = '23505', message = 'trial_ledger_idempotency_conflict';
    end if;
    select * into l from public.ops_state where entity = 'lpItems' for share;
    if l.entity is null or l.version < prior.lp_items_version then
      raise exception using errcode = '55000', message = 'trial_ledger_replay_version_regressed';
    end if;
    return query select prior.command_key::text, false, prior.lp_item_id,
      prior.student_id, prior.field, l, prior.audit_id;
    return;
  end if;

  select * into l from public.ops_state where entity = 'lpItems' for update;
  if l.entity is null or jsonb_typeof(l.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_ledger_state_missing';
  end if;
  -- A concurrent request with the same key may have committed while this
  -- transaction waited for the state lock. Recheck before field OCC.
  select * into prior
  from internal.trial_ledger_commands ledger
  where ledger.command_key = command_uuid;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
      raise exception using errcode = '23505', message = 'trial_ledger_idempotency_conflict';
    end if;
    return query select prior.command_key::text, false, prior.lp_item_id,
      prior.student_id, prior.field, l, prior.audit_id;
    return;
  end if;

  select source.value into item
  from jsonb_array_elements(l.payload) source(value)
  where source.value ->> 'id' = btrim(p_lp_item_id);
  if item is null then
    raise exception using errcode = 'P0002', message = 'trial_ledger_lp_not_found';
  end if;
  if item ->> 'workflowType' not in ('试听 LP', '换老师试听') then
    raise exception using errcode = '22023', message = 'trial_ledger_workflow_forbidden';
  end if;
  student_id_value := nullif(btrim(item ->> 'studentId'), '');
  if student_id_value is null or length(student_id_value) > 120 then
    raise exception using errcode = '55000', message = 'trial_ledger_student_missing';
  end if;
  current_value := internal.trial_ledger_stored_value(item, p_field);
  if current_value is null then
    raise exception using errcode = '22023', message = 'invalid_trial_ledger_field';
  end if;
  if current_value is distinct from expected_value then
    raise exception using errcode = '40001', message = 'trial_ledger_field_conflict';
  end if;

  next_item := item;
  occurred_at_text := to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  if current_value is distinct from next_value then
    applied_value := true;
    if p_field = 'resultStatus' then
      if next_item ? 'resultAudit' and jsonb_typeof(next_item -> 'resultAudit') <> 'array' then
        raise exception using errcode = '55000', message = 'trial_ledger_result_audit_invalid';
      end if;
      if next_value = 'null'::jsonb then
        next_item := next_item - 'resultStatus';
      else
        next_item := jsonb_set(next_item, '{resultStatus}', next_value, true);
      end if;
      field_audit := jsonb_strip_nulls(jsonb_build_object(
        'id', 'LPR-AUD-' || command_uuid::text,
        'workflowId', btrim(p_lp_item_id),
        'action', 'result_status_changed',
        'occurredAt', occurred_at_text,
        'actor', btrim(p_actor),
        'fromResultStatus', case when current_value = 'null'::jsonb then null else current_value end,
        'toResultStatus', case when next_value = 'null'::jsonb then null else next_value end
      ));
      next_item := jsonb_set(
        next_item,
        '{resultAudit}',
        coalesce(next_item -> 'resultAudit', '[]'::jsonb) || jsonb_build_array(field_audit),
        true
      );
    else
      if p_field in (
        'studentName', 'guardianWechat', 'workflowType', 'lessonMonth',
        'requestedAt', 'scheduledAt', 'operationsOwner', 'planner', 'subject', 'teacher'
      ) then
        if next_item ? 'trialLedgerOverrides'
           and jsonb_typeof(next_item -> 'trialLedgerOverrides') <> 'object' then
          raise exception using errcode = '55000', message = 'trial_ledger_overrides_invalid';
        end if;
        overrides := case when jsonb_typeof(next_item -> 'trialLedgerOverrides') = 'object'
          then next_item -> 'trialLedgerOverrides' else '{}'::jsonb end;
        if next_value = 'null'::jsonb then
          overrides := overrides - p_field;
        else
          overrides := jsonb_set(overrides, array[p_field], next_value, true);
        end if;
        if overrides = '{}'::jsonb then
          next_item := next_item - 'trialLedgerOverrides';
        else
          next_item := jsonb_set(next_item, '{trialLedgerOverrides}', overrides, true);
        end if;
      elsif p_field = 'trialPaid' then
        if next_value = 'null'::jsonb then
          next_item := next_item - 'trialPaid';
        else
          next_item := jsonb_set(next_item, '{trialPaid}', next_value, true);
        end if;
      elsif p_field = 'trialLedgerNote' then
        if next_value = 'null'::jsonb then
          next_item := next_item - 'trialLedgerNote';
        else
          next_item := jsonb_set(next_item, '{trialLedgerNote}', next_value, true);
        end if;
      end if;
      if next_item ? 'trialLedgerAudit' and jsonb_typeof(next_item -> 'trialLedgerAudit') <> 'array' then
        raise exception using errcode = '55000', message = 'trial_ledger_audit_invalid';
      end if;
      field_audit := jsonb_strip_nulls(jsonb_build_object(
        'id', 'TLG-AUD-' || command_uuid::text,
        'workflowId', btrim(p_lp_item_id),
        'action', 'trial_ledger_field_changed',
        'occurredAt', occurred_at_text,
        'actor', btrim(p_actor),
        'field', p_field,
        'fromValue', case when current_value = 'null'::jsonb then null else current_value end,
        'toValue', case when next_value = 'null'::jsonb then null else next_value end
      ));
      next_item := jsonb_set(
        next_item,
        '{trialLedgerAudit}',
        coalesce(next_item -> 'trialLedgerAudit', '[]'::jsonb) || jsonb_build_array(field_audit),
        true
      );
    end if;

    select coalesce(jsonb_agg(
      case when value ->> 'id' = btrim(p_lp_item_id) then next_item else value end
      order by ordinality
    ), '[]'::jsonb) into next_payload
    from jsonb_array_elements(l.payload) with ordinality source(value, ordinality);
    update public.ops_state
    set payload = next_payload,
        version = l.version + 1,
        updated_at = occurred_at,
        updated_by = btrim(p_actor)
    where entity = 'lpItems'
    returning * into saved_l;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('lpItems', saved_l.version, saved_l.updated_by);
  else
    saved_l := l;
  end if;

  audit_id_value := internal.append_operational_contract_audit(
    case when applied_value then 'trial.ledger.field_changed' else 'trial.ledger.noop' end,
    btrim(p_actor),
    'lpItem',
    btrim(p_lp_item_id),
    jsonb_build_object(
      'commandUuid', command_uuid::text,
      'studentId', student_id_value,
      'field', p_field,
      'fromValue', current_value,
      'toValue', next_value,
      'lpItemsVersionBefore', l.version,
      'lpItemsVersionAfter', saved_l.version
    )
  );
  insert into internal.trial_ledger_commands(
    command_key, command_intent, command_hash, lp_item_id, student_id,
    field, lp_items_version, actor, applied, audit_id
  ) values (
    command_uuid, p_command_intent, command_hash_value, btrim(p_lp_item_id), student_id_value,
    p_field, saved_l.version, btrim(p_actor), applied_value, audit_id_value
  );

  return query select command_uuid::text, applied_value, btrim(p_lp_item_id),
    student_id_value, p_field, saved_l, audit_id_value;
end;
$$;
revoke all on function public.mutate_trial_ledger_field_atomic(text, text, jsonb, text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_trial_ledger_field_atomic(text, text, jsonb, text, text, jsonb, jsonb, text)
  to anon, authenticated;

-- LP stage transitions are an audited compare-and-swap mutation. The LP row,
-- append-only revision event and global audit entry commit in one transaction.
create or replace function public.mutate_lp_revision(
  p_secret text,
  p_item_id text,
  p_expected_student_id text,
  p_expected_stage text,
  p_expected_revision_id text,
  p_to_stage text,
  p_action text,
  p_note text,
  p_actor text,
  p_scope_versions jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  scope_row public.ops_state%rowtype;
  lp_row public.ops_state%rowtype;
  audit_row public.ops_state%rowtype;
  saved_lp_row public.ops_state%rowtype;
  saved_audit_row public.ops_state%rowtype;
  current_item jsonb;
  next_item jsonb;
  current_history jsonb;
  latest_entry jsonb;
  revision_entry jsonb;
  audit_entry jsonb;
  item_position bigint;
  history_length integer;
  current_revision integer;
  next_revision integer;
  current_tail_id text;
  changed_at timestamptz;
  changed_at_iso text;
  revision_id text;
  audit_action text;
  audit_tone text;
  audit_detail text;
  display_actor text;
  clean_note text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception 'invalid_ops_secret';
  end if;

  if coalesce(btrim(p_item_id), '') = ''
    or coalesce(btrim(p_expected_student_id), '') = ''
    or coalesce(btrim(p_actor), '') = '' then
    raise exception using errcode = '22023', message = 'invalid_lp_revision_request';
  end if;

  if p_expected_stage is null
    or p_to_stage is null
    or p_action is null
    or p_expected_stage not in ('待资料', '写作中', '待审核', '需修改', '已发老师', '待备课确认', '完成')
    or p_to_stage not in ('待资料', '写作中', '待审核', '需修改', '已发老师', '待备课确认', '完成')
    or p_action not in ('stage-change', 'revision-request', 'revision-resubmit', 'undo') then
    raise exception using errcode = '22023', message = 'invalid_lp_revision_transition';
  end if;

  clean_note := nullif(btrim(coalesce(p_note, '')), '');
  if length(coalesce(clean_note, '')) > 800 then
    raise exception using errcode = '22023', message = 'lp_revision_note_too_long';
  end if;
  if p_action in ('revision-request', 'revision-resubmit') and length(coalesce(clean_note, '')) < 3 then
    raise exception using errcode = '22023', message = 'lp_revision_note_required';
  end if;

  -- Lock the scope rows in the same stable order as other scoped writes.
  if p_actor not in ('Nixon', 'Ops Admin') then
    if jsonb_typeof(p_scope_versions) is distinct from 'object' then
      raise exception using errcode = '40001', message = 'access_scope_changed';
    end if;

    for scope_row in
      select state.*
      from public.ops_state as state
      where state.entity in ('bookings', 'students', 'teachers')
      order by state.entity
      for update
    loop
      if coalesce((p_scope_versions ->> scope_row.entity)::bigint, -1) <> scope_row.version then
        raise exception using errcode = '40001', message = 'access_scope_changed';
      end if;
    end loop;
  end if;

  select state.* into lp_row
  from public.ops_state as state
  where state.entity = 'lpItems'
  for update;

  select state.* into audit_row
  from public.ops_state as state
  where state.entity = 'audit'
  for update;

  if lp_row.entity is null or audit_row.entity is null
    or jsonb_typeof(lp_row.payload) is distinct from 'array'
    or jsonb_typeof(audit_row.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'ops_state_not_initialized';
  end if;

  select item.value, item.ordinality
  into current_item, item_position
  from jsonb_array_elements(lp_row.payload) with ordinality as item(value, ordinality)
  where item.value ->> 'id' = p_item_id
  limit 1;

  if current_item is null then
    raise exception using errcode = 'P0002', message = 'lp_item_not_found';
  end if;

  if current_item ->> 'studentId' is distinct from p_expected_student_id then
    raise exception using errcode = '40001', message = 'access_scope_changed';
  end if;

  current_history := coalesce(current_item -> 'revisionHistory', '[]'::jsonb);
  if jsonb_typeof(current_history) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_lp_revision_history';
  end if;
  history_length := jsonb_array_length(current_history);
  latest_entry := case when history_length > 0 then current_history -> (history_length - 1) else null end;
  current_tail_id := latest_entry ->> 'id';

  if current_item ->> 'stage' is distinct from p_expected_stage
    or current_tail_id is distinct from p_expected_revision_id then
    raise exception using errcode = '40001', message = 'lp_revision_conflict';
  end if;

  if (p_action = 'revision-request' and not (p_expected_stage = '待审核' and p_to_stage = '需修改'))
    or (p_action = 'revision-resubmit' and not (p_expected_stage = '需修改' and p_to_stage = '待审核'))
    or (p_action = 'stage-change' and (p_expected_stage = '需修改' or p_to_stage = '需修改' or p_expected_stage = p_to_stage))
    or (p_action = 'undo' and (
      latest_entry is null
      or latest_entry ->> 'toStage' is distinct from p_expected_stage
      or latest_entry ->> 'fromStage' is distinct from p_to_stage
    )) then
    raise exception using errcode = '22023', message = 'invalid_lp_revision_transition';
  end if;

  select coalesce(max(
    case when entry.value ->> 'revisionNumber' ~ '^[0-9]+$'
      then (entry.value ->> 'revisionNumber')::integer
      else 0
    end
  ), 0)
  into current_revision
  from jsonb_array_elements(current_history) as entry(value);

  next_revision := current_revision + case when p_action = 'revision-request' then 1 else 0 end;
  changed_at := clock_timestamp();
  changed_at_iso := to_char(changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  display_actor := case when p_actor = 'Nixon' then 'Admin' else p_actor end;
  revision_id := format(
    'LPREV-%s-%s-%s-%s',
    p_item_id,
    to_char(changed_at at time zone 'UTC', 'YYYYMMDDHH24MISSMS'),
    history_length + 1,
    p_action
  );

  revision_entry := jsonb_strip_nulls(jsonb_build_object(
    'id', revision_id,
    'action', p_action,
    'revisionNumber', next_revision,
    'fromStage', p_expected_stage,
    'toStage', p_to_stage,
    'actor', display_actor,
    'changedAt', changed_at_iso,
    'note', clean_note
  ));
  next_item := current_item || jsonb_build_object(
    'stage', p_to_stage,
    'revisionHistory', current_history || jsonb_build_array(revision_entry)
  );

  lp_row.payload := jsonb_set(
    lp_row.payload,
    array[(item_position - 1)::text],
    next_item,
    false
  );

  update public.ops_state as state
  set payload = lp_row.payload,
      version = state.version + 1,
      updated_at = changed_at,
      updated_by = p_actor
  where state.entity = 'lpItems'
  returning state.* into saved_lp_row;

  audit_action := case p_action
    when 'revision-request' then '要求修改 LP'
    when 'revision-resubmit' then '重新提交 LP'
    when 'undo' then '撤销 LP 操作'
    else '调整 LP 阶段'
  end;
  audit_tone := case p_action
    when 'revision-request' then 'red'
    when 'undo' then 'amber'
    when 'stage-change' then case when p_to_stage = '完成' then 'green' else 'blue' end
    else 'blue'
  end;
  audit_detail := left(
    format(
      '%s [%s] · %s → %s%s%s',
      coalesce(current_item ->> 'title', 'LP'),
      p_item_id,
      p_expected_stage,
      p_to_stage,
      case when next_revision > 0 then format(' · 第 %s 轮', next_revision) else '' end,
      case when clean_note is not null then ' · ' || clean_note else '' end
    ),
    1200
  );
  audit_entry := jsonb_build_object(
    'id', 'AUD-' || revision_id,
    'time', changed_at_iso,
    'actor', display_actor,
    'action', audit_action,
    'detail', audit_detail,
    'tone', audit_tone
  );

  update public.ops_state as state
  set payload = jsonb_build_array(audit_entry) || audit_row.payload,
      version = state.version + 1,
      updated_at = changed_at,
      updated_by = p_actor
  where state.entity = 'audit'
  returning state.* into saved_audit_row;

  return jsonb_build_object(
    'row', to_jsonb(saved_lp_row),
    'auditRow', to_jsonb(saved_audit_row),
    'revision', revision_entry
  );
end;
$$;

revoke all on function public.mutate_lp_revision(text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mutate_lp_revision(text, text, text, text, text, text, text, text, text, jsonb) to anon;
;

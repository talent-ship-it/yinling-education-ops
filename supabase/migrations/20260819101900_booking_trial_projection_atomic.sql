-- Forward-only booking projection contract.  The already-deployed booking
-- capacity RPC remains the reviewed owner of booking/capacity validation
-- (including Jiaowubao and recurrence guards).  This wrapper acquires the
-- wider canonical lock set first, then commits trial tasks and the legacy
-- student projection in the very same PostgreSQL transaction.

set local lock_timeout = '1s';

create table if not exists internal.booking_projection_commands (
  command_key text primary key check (command_key ~ '^booking-capacity:[a-f0-9]{64}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('create', 'update', 'delete')),
  booking_id text not null check (length(booking_id) between 1 and 120),
  student_id text not null check (length(student_id) between 1 and 240),
  previous_student_id text not null check (length(previous_student_id) between 1 and 240),
  teacher_id text not null check (length(teacher_id) between 1 and 240),
  previous_teacher_id text not null check (length(previous_teacher_id) between 1 and 240),
  booking_version bigint not null check (booking_version > 0),
  student_version bigint not null check (student_version > 0),
  lp_item_version bigint not null check (lp_item_version > 0),
  task_version bigint not null check (task_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor_role text not null check (actor_role in ('admin', 'limited-admin', 'staff', 'teacher')),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.booking_projection_commands enable row level security;
revoke all on table internal.booking_projection_commands from public, anon, authenticated, service_role;

create or replace function internal.booking_projection_iso(p_value timestamptz)
returns text
language sql
immutable
set search_path = ''
as $function$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$function$;

create or replace function internal.booking_projection_task_status(
  p_due_at timestamptz,
  p_now timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when (p_due_at at time zone 'Australia/Melbourne')::date
       < (p_now at time zone 'Australia/Melbourne')::date then 'overdue'
    when (p_due_at at time zone 'Australia/Melbourne')::date
       = (p_now at time zone 'Australia/Melbourne')::date then 'today'
    else 'upcoming'
  end
$function$;

create or replace function internal.booking_projection_trial_task(
  p_booking_id text,
  p_student_id text,
  p_owner text,
  p_rule text,
  p_due_at timestamptz,
  p_now timestamptz
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  title_value text;
  tone_value text;
  category_value text;
  trigger_value text;
begin
  case p_rule
    when 'trial.parent-follow-up' then
      title_value := '发送家长试听跟进请求'; tone_value := 'blue'; category_value := '试听';
      trigger_value := '试听需求进入后当天跟进家长';
    when 'trial.scheduling' then
      title_value := '完成试听排课'; tone_value := 'red'; category_value := '排课';
      trigger_value := '试听需求进入后 24 小时内完成排课';
    when 'trial.lp-review' then
      title_value := '审核试听 LP'; tone_value := 'blue'; category_value := 'LP';
      trigger_value := '试听前 N-3 审核 LP';
    when 'trial.prep' then
      title_value := '确认老师备课内容与资料'; tone_value := 'amber'; category_value := 'LP';
      trigger_value := '试听前 N-2 完成备课交接';
    when 'trial.minimum' then
      title_value := '完成试听前最低检查'; tone_value := 'red'; category_value := '试听';
      trigger_value := '试听前 N-1 最低检查';
    else
      raise exception using errcode = '22023', message = 'invalid_booking_trial_task_rule';
  end case;

  -- The two immediate short-notice rules retain their stable rule identities,
  -- while their visible copy matches the established browser workflow.
  if p_rule = 'trial.lp-review' and p_due_at = p_now then
    title_value := '紧急审核试听 LP'; tone_value := 'red';
    trigger_value := '试听距开课不足 72 小时，按 N-1 最低时效立即审核 LP';
  elsif p_rule = 'trial.prep' and p_due_at = p_now then
    title_value := '紧急确认老师备课内容与资料'; tone_value := 'red';
    trigger_value := '试听距开课不足 72 小时，按 N-1 最低时效立即确认备课';
  end if;

  return jsonb_build_object(
    'id', 'TSK-BOOKING-' || left(encode(extensions.digest(
      p_booking_id || chr(31) || p_student_id || chr(31) || p_rule, 'sha256'
    ), 'hex'), 24),
    'title', title_value,
    'owner', p_owner,
    'assignees', jsonb_build_array(p_owner),
    'watchers', jsonb_build_array('Ops Admin'),
    'studentId', p_student_id,
    'due', to_char(p_due_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI'),
    'dueAt', internal.booking_projection_iso(p_due_at),
    'status', internal.booking_projection_task_status(p_due_at, p_now),
    'tone', tone_value,
    'category', category_value,
    'trigger', trigger_value,
    'ruleKey', p_rule,
    'anchorBookingId', p_booking_id
  );
end;
$function$;

revoke all on function internal.booking_projection_iso(timestamptz) from public, anon, authenticated, service_role;
revoke all on function internal.booking_projection_task_status(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function internal.booking_projection_trial_task(text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- A relationship exists only while at least one concrete non-leave lesson in
-- the series is active. This is shared by capacity and student projections so
-- cancelling the middle of a series does not free a teacher, while cancelling
-- its last active occurrence does.
create or replace function internal.booking_projection_has_active_relationship(
  p_booking jsonb,
  p_student_id text,
  p_teacher_id text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  source_date date;
  source_end date;
  interval_days integer;
  source_occurrence date;
  occurrence_id text;
  override_value jsonb;
begin
  if jsonb_typeof(p_booking) <> 'object'
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_teacher_id), '') is null
     or p_booking ->> 'kind' = '代课' then
    return false;
  end if;
  source_date := (p_booking ->> 'date')::date;
  interval_days := case when p_booking ->> 'recurring' = 'true'
    then internal.booking_recurrence_interval_days(p_booking) else 1 end;
  source_end := internal.booking_recurrence_source_end_date(p_booking);
  -- A finite list of overrides cannot extinguish an unbounded legacy series.
  if p_booking ->> 'recurring' = 'true' and source_end is null then
    return p_booking ->> 'studentId' = p_student_id
      and p_booking ->> 'teacherId' = p_teacher_id;
  end if;
  source_end := coalesce(source_end, source_date);
  if ((source_end - source_date) / interval_days) + 1 > 366 then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_recurrence';
  end if;
  for source_occurrence in
    select day::date from pg_catalog.generate_series(
      source_date, source_end, pg_catalog.make_interval(days => interval_days)
    ) day
  loop
    occurrence_id := p_booking ->> 'id' || ':' || pg_catalog.to_char(source_occurrence, 'YYYY-MM-DD');
    select item.value into override_value
    from jsonb_array_elements(case when jsonb_typeof(p_booking -> 'occurrenceOverrides') = 'array'
      then p_booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
    where item.value ->> 'occurrenceId' = occurrence_id
    limit 1;
    if coalesce(override_value ->> 'status', 'confirmed') not in ('cancelled', 'leave')
       and coalesce(nullif(trim(override_value ->> 'studentId'), ''), p_booking ->> 'studentId') = p_student_id
       and coalesce(nullif(trim(override_value ->> 'teacherId'), ''), p_booking ->> 'teacherId') = p_teacher_id then
      return true;
    end if;
  end loop;
  return false;
exception when others then
  raise exception using errcode = '22023', message = 'invalid_booking_projection_recurrence';
end;
$function$;

revoke all on function internal.booking_projection_has_active_relationship(jsonb, text, text)
  from public, anon, authenticated, service_role;

-- Forward-replace the imported-schedule guard so it resolves each persisted
-- occurrence override. A cancellation is a removal from the occupied surface,
-- therefore an already-conflicting imported block must not prevent it.
create or replace function internal.assert_jiaowubao_direct_booking_interval_available(
  p_student_id text,
  p_teacher_id text,
  p_booking jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_date date;
  source_end_date date;
  interval_days integer;
  occurrence_count integer;
  occurrence_index integer;
  occurrence_source_date date;
  occurrence_date date;
  occurrence_start time;
  occurrence_duration integer;
  occurrence_student_id text;
  occurrence_teacher_id text;
  occurrence_override jsonb;
  occurrence_id text;
  source_timezone text;
  source_local_start timestamp;
  candidate_count integer;
  end_date_occurrence_limit constant integer := 366;
begin
  if jsonb_typeof(p_booking) <> 'object'
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_teacher_id), '') is null
     or jsonb_typeof(p_booking -> 'date') <> 'string'
     or jsonb_typeof(p_booking -> 'start') <> 'string'
     or jsonb_typeof(p_booking -> 'timezone') <> 'string'
     or jsonb_typeof(p_booking -> 'duration') <> 'number'
     or jsonb_typeof(p_booking -> 'recurring') <> 'boolean'
     or nullif(trim(p_booking ->> 'id'), '') is null then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end if;
  begin
    source_date := (p_booking ->> 'date')::date;
    source_timezone := p_booking ->> 'timezone';
    occurrence_start := (p_booking ->> 'start')::time;
    occurrence_duration := (p_booking ->> 'duration')::integer;
    interval_days := case when p_booking ->> 'recurring' = 'true'
      then internal.booking_recurrence_interval_days(p_booking) else 1 end;
    source_end_date := internal.booking_recurrence_source_end_date(p_booking);
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end;
  if pg_catalog.to_char(source_date, 'YYYY-MM-DD') <> p_booking ->> 'date'
     or p_booking ->> 'start' !~ '^([01]\d|2[0-3]):[0-5]\d$'
     or occurrence_duration not in (60, 90, 120)
     or not exists (
       select 1 from pg_catalog.pg_timezone_names timezone_name
       where timezone_name.name = source_timezone
     ) then
    raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
  end if;
  if p_booking ->> 'recurring' = 'true' then
    if not (p_booking ? 'repeatCount') and source_end_date is null and interval_days <> 7 then
      raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_required';
    end if;
    if source_end_date is not null then
      occurrence_count := internal.booking_recurrence_occurrence_count(p_booking);
      if occurrence_count is null or occurrence_count < 1 or occurrence_count > end_date_occurrence_limit then
        raise exception using errcode = '22023', message = 'booking_recurrence_end_date_too_far';
      end if;
    elsif p_booking ? 'repeatCount' then
      occurrence_count := internal.booking_recurrence_occurrence_count(p_booking);
      if occurrence_count is null or occurrence_count not between 1 and 104 then
        raise exception using errcode = '22023', message = 'booking_recurrence_repeat_count_out_of_range';
      end if;
    else
      occurrence_count := 104;
    end if;
  else
    occurrence_count := 1;
  end if;

  perform pg_catalog.set_config('lock_timeout', '1s', true);
  lock table internal.jiaowubao_direct_import_runs in share mode;

  for occurrence_index in 0..(occurrence_count - 1)
  loop
    occurrence_source_date := source_date + occurrence_index * interval_days;
    if source_end_date is not null and occurrence_source_date > source_end_date then exit; end if;
    occurrence_id := p_booking ->> 'id' || ':' || pg_catalog.to_char(occurrence_source_date, 'YYYY-MM-DD');
    select item.value into occurrence_override
    from jsonb_array_elements(case when jsonb_typeof(p_booking -> 'occurrenceOverrides') = 'array'
      then p_booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
    where item.value ->> 'occurrenceId' = occurrence_id
    limit 1;
    if coalesce(occurrence_override ->> 'status', 'confirmed') in ('cancelled', 'leave') then
      continue;
    end if;
    begin
      occurrence_date := coalesce((occurrence_override ->> 'date')::date, occurrence_source_date);
      occurrence_start := coalesce((occurrence_override ->> 'start')::time, (p_booking ->> 'start')::time);
      occurrence_duration := coalesce((occurrence_override ->> 'durationMinutes')::integer, (p_booking ->> 'duration')::integer);
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end;
    occurrence_student_id := coalesce(nullif(trim(occurrence_override ->> 'studentId'), ''), p_student_id);
    occurrence_teacher_id := coalesce(nullif(trim(occurrence_override ->> 'teacherId'), ''), p_teacher_id);
    if occurrence_duration not in (60, 90, 120) then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end if;
    source_local_start := occurrence_date + occurrence_start;
    select count(*) into candidate_count
    from (
      select ((source_local_start - pg_catalog.make_interval(mins => offset_grid.offset_minutes))
        at time zone 'UTC') as instant
      from pg_catalog.generate_series(-720, 840, 15) offset_grid(offset_minutes)
    ) candidate
    where candidate.instant at time zone source_timezone = source_local_start;
    if candidate_count < 1 then
      raise exception using errcode = '22023', message = 'invalid_booking_schedule_interval';
    end if;
    if exists (
      select 1
      from (
        select ((source_local_start - pg_catalog.make_interval(mins => offset_grid.offset_minutes))
          at time zone 'UTC') as starts_at
        from pg_catalog.generate_series(-720, 840, 15) offset_grid(offset_minutes)
      ) candidate
      join internal.jiaowubao_direct_current_schedule_blocks imported_block
        on imported_block.occupied_range && tstzrange(
          candidate.starts_at,
          candidate.starts_at + pg_catalog.make_interval(mins => occurrence_duration),
          '[)'
        )
      where candidate.starts_at at time zone source_timezone = source_local_start
        and (imported_block.teacher_id = occurrence_teacher_id
          or occurrence_student_id = any(imported_block.student_ids))
    ) then
      raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_schedule_conflict';
    end if;
  end loop;
end;
$function$;

revoke all on function internal.assert_jiaowubao_direct_booking_interval_available(text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.rebuild_booking_trial_tasks(
  p_tasks jsonb,
  p_lp_items jsonb,
  p_booking jsonb,
  p_previous_booking jsonb,
  p_action text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  working jsonb := p_tasks;
  booking_id text := coalesce(p_booking ->> 'id', p_previous_booking ->> 'id');
  student_id text := p_booking ->> 'studentId';
  previous_student_id text := p_previous_booking ->> 'studentId';
  owner_value text;
  request_anchor text;
  previous_request_anchor text;
  booking_active boolean := false;
  requested_at timestamptz;
  trial_starts_at timestamptz;
  request_same_day timestamptz;
  request_24h timestamptz;
  due_at_value timestamptz;
  generated_due timestamptz;
  existing_due timestamptz;
  previous_open_due timestamptz := p_now;
  active_rules text[];
  managed_rules constant text[] := array[
    'trial.parent-follow-up', 'trial.scheduling', 'trial.lp-review',
    'trial.prep', 'trial.minimum', 'trial.short-notice-prep'
  ];
  request_rules constant text[] := array['trial.parent-follow-up', 'trial.scheduling'];
  rule text;
  incoming jsonb;
  request_task jsonb;
  existing_task jsonb;
  completed_task jsonb;
  merged_task jsonb;
  closed_at_text text := internal.booking_projection_iso(p_now);
begin
  if jsonb_typeof(p_tasks) <> 'array' or jsonb_typeof(p_lp_items) <> 'array'
     or p_action not in ('create', 'update', 'delete')
     or nullif(booking_id, '') is null then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_task_state';
  end if;

  if p_previous_booking is not null and p_previous_booking ->> 'kind' = '试听' then
    select lp.value ->> 'id' into previous_request_anchor
    from jsonb_array_elements(p_lp_items) with ordinality lp(value, ordinality)
    where lp.value ->> 'studentId' = previous_student_id
      and lp.value ->> 'workflowType' in ('试听 LP', '换老师试听')
      and (
        exists (
          select 1 from jsonb_array_elements(working) task(value)
          where task.value ->> 'anchorBookingId' = lp.value ->> 'id'
        )
        or exists (
          select 1 from jsonb_array_elements(working) task(value)
          where task.value ->> 'anchorBookingId' = booking_id
            and task.value ->> 'studentId' = previous_student_id
            and task.value ->> 'ruleKey' = any(request_rules)
            and coalesce(nullif(task.value ->> 'requestAnchorBookingId', ''), lp.value ->> 'id') = lp.value ->> 'id'
        )
      )
    order by case when exists (
      select 1 from jsonb_array_elements(working) task(value)
      where task.value ->> 'requestAnchorBookingId' = lp.value ->> 'id'
    ) then 0 when exists (
      select 1 from jsonb_array_elements(working) task(value)
      where task.value ->> 'anchorBookingId' = lp.value ->> 'id'
    ) then 1 else 2 end, lp.ordinality
    limit 1;
  end if;

  if p_action = 'delete' then
    if p_previous_booking ->> 'kind' <> '试听' then return working; end if;
    select coalesce(jsonb_agg(
      case when (
            item.value ->> 'anchorBookingId' = booking_id
            or (previous_request_anchor is not null
              and item.value ->> 'anchorBookingId' = previous_request_anchor
              and (
                item.value ->> 'ruleKey' = any(request_rules)
                or item.value ->> 'ruleKey' in ('trial.parent-no-reply-follow-up', 'trial.teaching-control-escalation')
                or item.value ->> 'ruleKey' ~ '^trial\.parent-progress-sync\.[1-9][0-9]*$'
              ))
          )
                  and item.value ->> 'studentId' = previous_student_id
                  and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green', 'result', '试听排课已删除', 'closedAt', closed_at_text
        )
        else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
    return working;
  end if;

  if p_previous_booking is not null and p_previous_booking ->> 'kind' = '试听'
     and (p_booking ->> 'kind' <> '试听' or previous_student_id is distinct from student_id) then
    select coalesce(jsonb_agg(
      case when (
          (item.value ->> 'anchorBookingId' = booking_id
            and item.value ->> 'studentId' = previous_student_id)
          or (previous_request_anchor is not null
            and item.value ->> 'anchorBookingId' = previous_request_anchor
            and item.value ->> 'studentId' = previous_student_id
            and (
              item.value ->> 'ruleKey' = any(request_rules)
              or item.value ->> 'ruleKey' in ('trial.parent-no-reply-follow-up', 'trial.teaching-control-escalation')
              or item.value ->> 'ruleKey' ~ '^trial\.parent-progress-sync\.[1-9][0-9]*$'
            ))
        ) then
        (case when item.value ->> 'status' <> 'done'
          then item.value || jsonb_build_object(
            'status', 'done', 'tone', 'green',
            'result', '试听已改为其他课程类型', 'closedAt', closed_at_text
          ) else item.value end)
        || case when previous_student_id is distinct from student_id
                  and item.value ->> 'anchorBookingId' = booking_id
             then jsonb_build_object('anchorBookingId', booking_id || ':retired:' || previous_student_id)
             else '{}'::jsonb end
      else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
  end if;
  if p_booking ->> 'kind' <> '试听' then return working; end if;

  booking_active := exists (
    select 1 from (
      select p_booking ->> 'teacherId' as teacher_id
      union
      select override_item.value ->> 'teacherId'
      from jsonb_array_elements(case when jsonb_typeof(p_booking -> 'occurrenceOverrides') = 'array'
        then p_booking -> 'occurrenceOverrides' else '[]'::jsonb end) override_item(value)
      where nullif(trim(override_item.value ->> 'teacherId'), '') is not null
    ) candidate
    where internal.booking_projection_has_active_relationship(
      p_booking, student_id, candidate.teacher_id
    )
  );

  select lp.value ->> 'id' into request_anchor
  from jsonb_array_elements(p_lp_items) with ordinality lp(value, ordinality)
  where lp.value ->> 'studentId' = student_id
    and lp.value ->> 'workflowType' in ('试听 LP', '换老师试听')
    and (
      exists (
        select 1 from jsonb_array_elements(working) task(value)
        where task.value ->> 'anchorBookingId' = lp.value ->> 'id'
      )
      or exists (
        select 1 from jsonb_array_elements(working) task(value)
        where task.value ->> 'anchorBookingId' = booking_id
          and task.value ->> 'studentId' = student_id
          and task.value ->> 'ruleKey' = any(request_rules)
          and coalesce(nullif(task.value ->> 'requestAnchorBookingId', ''), lp.value ->> 'id') = lp.value ->> 'id'
      )
    )
  order by case when exists (
    select 1 from jsonb_array_elements(working) task(value)
    where task.value ->> 'requestAnchorBookingId' = lp.value ->> 'id'
  ) then 0 when exists (
    select 1 from jsonb_array_elements(working) task(value)
    where task.value ->> 'anchorBookingId' = lp.value ->> 'id'
  ) then 1 else 2 end, lp.ordinality
  limit 1;

  if not booking_active then
    select coalesce(jsonb_agg(
      case when (
            item.value ->> 'anchorBookingId' = booking_id
            or (request_anchor is not null
              and item.value ->> 'anchorBookingId' = request_anchor
              and (
                item.value ->> 'ruleKey' = any(request_rules)
                or item.value ->> 'ruleKey' in ('trial.parent-no-reply-follow-up', 'trial.teaching-control-escalation')
                or item.value ->> 'ruleKey' ~ '^trial\.parent-progress-sync\.[1-9][0-9]*$'
              ))
          )
          and item.value ->> 'studentId' = student_id
          and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green', 'result', '试听课次已全部取消', 'closedAt', closed_at_text
        )
        else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
    return working;
  end if;

  if nullif(student_id, '') is null then
    raise exception using errcode = '22023', message = 'booking_projection_student_missing';
  end if;
  select item.value ->> 'owner' into owner_value
  from jsonb_array_elements((select payload from public.ops_state where entity = 'students')) item(value)
  where item.value ->> 'id' = student_id limit 1;
  if nullif(owner_value, '') is null then
    raise exception using errcode = '22023', message = 'booking_projection_owner_missing';
  end if;

  begin
    requested_at := (p_booking ->> 'requestedAt')::timestamptz;
    trial_starts_at := (
      ((p_booking ->> 'date')::date + (p_booking ->> 'start')::time)
      at time zone (p_booking ->> 'timezone')
    );
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_trial_clock';
  end;
  if requested_at is null or trial_starts_at is null or trial_starts_at <= p_now then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_trial_clock';
  end if;

  request_same_day := (
    ((requested_at at time zone 'Australia/Melbourne')::date + time '18:00')
    at time zone 'Australia/Melbourne'
  );
  request_24h := requested_at + interval '24 hours';
  request_same_day := case
    when request_same_day <= p_now or request_same_day < trial_starts_at then request_same_day
    else p_now end;
  request_24h := case
    when request_24h <= p_now or request_24h < trial_starts_at then request_24h
    else p_now end;

  if trial_starts_at - p_now < interval '72 hours' then
    active_rules := array['trial.parent-follow-up', 'trial.scheduling', 'trial.lp-review', 'trial.prep'];
  else
    active_rules := array['trial.parent-follow-up', 'trial.scheduling', 'trial.lp-review', 'trial.prep', 'trial.minimum'];
  end if;

  -- Any rule that ceased to apply is closed, but a human completion remains
  -- immutable. Re-entry later reopens only the automatic closure below.
  select coalesce(jsonb_agg(
    case when item.value ->> 'anchorBookingId' = booking_id
              and item.value ->> 'studentId' = student_id
              and item.value ->> 'ruleKey' = any(managed_rules)
              and not (item.value ->> 'ruleKey' = any(active_rules))
              and item.value ->> 'status' <> 'done'
      then item.value || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', '试听时距规则已切换，任务自动关闭', 'closedAt', closed_at_text
      )
      when item.value ->> 'anchorBookingId' = booking_id
              and item.value ->> 'studentId' = student_id
              and item.value ->> 'ruleKey' = any(active_rules)
              and item.value ->> 'status' = 'done'
              and item.value ->> 'result' = '试听时距规则已切换，任务自动关闭'
      then (item.value - 'result' - 'closedAt') || jsonb_build_object('status', 'waiting')
      else item.value end order by item.ordinality
  ), '[]'::jsonb) into working
  from jsonb_array_elements(working) with ordinality item(value, ordinality);

  if request_anchor is not null then
    select coalesce(jsonb_agg(
      case when item.value ->> 'anchorBookingId' = request_anchor
                  and item.value ->> 'studentId' = student_id
                  and (item.value ->> 'ruleKey' in (
                    'trial.parent-no-reply-follow-up', 'trial.teaching-control-escalation'
                  ) or item.value ->> 'ruleKey' ~ '^trial\.parent-progress-sync\.[1-9][0-9]*$')
                  and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green',
          'result', '试听已完成排课，升级任务自动关闭', 'closedAt', closed_at_text
        )
        else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
  end if;

  foreach rule in array active_rules loop
    due_at_value := case rule
      when 'trial.parent-follow-up' then request_same_day
      when 'trial.scheduling' then request_24h
      when 'trial.lp-review' then case when trial_starts_at - p_now < interval '72 hours' then p_now else (
        ((trial_starts_at at time zone 'Australia/Melbourne')::date - 3 + time '18:00')
        at time zone 'Australia/Melbourne') end
      when 'trial.prep' then case when trial_starts_at - p_now < interval '72 hours' then p_now else (
        ((trial_starts_at at time zone 'Australia/Melbourne')::date - 2 + time '18:00')
        at time zone 'Australia/Melbourne') end
      else (((trial_starts_at at time zone 'Australia/Melbourne')::date - 1 + time '18:00')
        at time zone 'Australia/Melbourne')
    end;
    incoming := internal.booking_projection_trial_task(
      booking_id, student_id, owner_value, rule, due_at_value, p_now
    );
    generated_due := due_at_value;
    request_task := null;
    existing_task := null;
    completed_task := null;

    if request_anchor is not null and rule = any(request_rules) then
      select item.value into request_task
      from jsonb_array_elements(working) with ordinality item(value, ordinality)
      where item.value ->> 'studentId' = student_id
        and item.value ->> 'anchorBookingId' = request_anchor
        and item.value ->> 'ruleKey' = rule
      order by case when item.value ->> 'status' = 'done' then 0 else 1 end, item.ordinality
      limit 1;
    end if;
    select item.value into existing_task
    from jsonb_array_elements(working) with ordinality item(value, ordinality)
    where item.value ->> 'studentId' = student_id
      and item.value ->> 'anchorBookingId' = booking_id
      and item.value ->> 'ruleKey' = rule
    order by case
      when item.value ->> 'status' = 'done'
       and coalesce(item.value ->> 'result', '') <> '试听时距规则已切换，任务自动关闭' then 0
      else 1 end, item.ordinality
    limit 1;
    completed_task := case
      when request_task ->> 'status' = 'done' then request_task
      when existing_task ->> 'status' = 'done'
       and coalesce(existing_task ->> 'result', '') <> '试听时距规则已切换，任务自动关闭' then existing_task
      else null end;

    merged_task := incoming;
    if request_task is not null then
      merged_task := jsonb_set(merged_task, '{id}', to_jsonb(request_task ->> 'id'))
        || jsonb_build_object('requestAnchorBookingId', request_anchor);
      begin existing_due := (request_task ->> 'dueAt')::timestamptz;
      exception when others then existing_due := null; end;
      if existing_due is not null and (
        existing_due <= p_now
        or (existing_due > previous_open_due and existing_due <= generated_due)
      ) then
        merged_task := merged_task || jsonb_build_object(
          'due', request_task ->> 'due', 'dueAt', request_task ->> 'dueAt',
          'status', request_task ->> 'status', 'tone', request_task ->> 'tone'
        );
      end if;
    elsif existing_task is not null then
      merged_task := jsonb_set(merged_task, '{id}', to_jsonb(existing_task ->> 'id'));
      if rule = any(request_rules) and request_anchor is not null then
        merged_task := merged_task || jsonb_build_object('requestAnchorBookingId', request_anchor);
      end if;
    end if;
    if completed_task is not null then
      merged_task := merged_task || jsonb_build_object(
        'status', 'done', 'tone', completed_task ->> 'tone'
      );
      if completed_task ? 'result' then merged_task := merged_task || jsonb_build_object('result', completed_task -> 'result'); end if;
      if completed_task ? 'closedAt' then merged_task := merged_task || jsonb_build_object('closedAt', completed_task -> 'closedAt'); end if;
    end if;

    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality)
    where not (
      item.value ->> 'studentId' = student_id
      and item.value ->> 'ruleKey' = rule
      and (
        item.value ->> 'anchorBookingId' = booking_id
        or (request_anchor is not null and rule = any(request_rules)
          and item.value ->> 'anchorBookingId' = request_anchor)
      )
    );
    working := working || jsonb_build_array(merged_task);
    if completed_task is null and generated_due > previous_open_due then
      previous_open_due := generated_due;
    end if;
  end loop;

  -- Match sortTasksByDueAt without ever parsing untrusted legacy due strings.
  select coalesce(jsonb_agg(item.value order by
    case when coalesce(item.value ->> 'dueAt', '') ~
      '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      then item.value ->> 'dueAt' else '9999-12-31T23:59:59.999Z' end,
    item.ordinality
  ), '[]'::jsonb) into working
  from jsonb_array_elements(working) with ordinality item(value, ordinality);
  return working;
end;
$function$;

revoke all on function internal.rebuild_booking_trial_tasks(jsonb, jsonb, jsonb, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.get_booking_projection_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  action text,
  booking_id text,
  student_id text,
  previous_student_id text,
  teacher_id text,
  previous_teacher_id text,
  actor_role text,
  booking_version bigint,
  student_version bigint,
  lp_item_version bigint,
  task_version bigint,
  teacher_version bigint,
  bookings_row public.ops_state,
  students_row public.ops_state,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  prior internal.booking_projection_commands%rowtype;
  b public.ops_state%rowtype;
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  h public.ops_state%rowtype;
  receipt_rows public.ops_state[];
  locked_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^booking-capacity:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) <> 'object'
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_replay_lookup';
  end if;
  select * into prior from internal.booking_projection_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> left(trim(p_actor), 120) then
    raise exception using errcode = '23505', message = 'booking_projection_idempotency_conflict';
  end if;
  -- One SQL statement owns both the statement-level snapshot and every row
  -- lock.  Five separate SELECTs are unsafe at READ COMMITTED because each can
  -- observe a different commit.  The locking CTE sorts before LockRows so the
  -- physical lock order stays bookings -> students -> lpItems -> tasks ->
  -- teachers; the separate non-locking CTE deliberately returns the single
  -- statement snapshot rather than any EvalPlanQual row version encountered
  -- while a lock wait is resolved.
  with desired(entity, lock_order) as (
    values
      ('bookings'::text, 1),
      ('students'::text, 2),
      ('lpItems'::text, 3),
      ('tasks'::text, 4),
      ('teachers'::text, 5)
  ),
  ordered_locks as materialized (
    select state.ctid as locked_ctid, desired.lock_order
    from desired
    join public.ops_state state on state.entity = desired.entity
    order by desired.lock_order
    for share of state
  ),
  stable_snapshot as materialized (
    select array_agg(state order by desired.lock_order) as rows
    from desired
    join public.ops_state state on state.entity = desired.entity
  )
  select stable_snapshot.rows, (select count(*)::integer from ordered_locks)
  into receipt_rows, locked_count
  from stable_snapshot;
  if locked_count <> 5 or cardinality(receipt_rows) <> 5 then
    raise exception using errcode = '55000', message = 'booking_projection_state_missing';
  end if;
  b := receipt_rows[1];
  s := receipt_rows[2];
  l := receipt_rows[3];
  t := receipt_rows[4];
  h := receipt_rows[5];
  if b.entity is null or s.entity is null or l.entity is null or t.entity is null or h.entity is null then
    raise exception using errcode = '55000', message = 'booking_projection_state_missing';
  end if;
  select * into prior from internal.booking_projection_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null
     or prior.command_intent is distinct from p_command_intent
     or prior.actor <> left(trim(p_actor), 120) then
    raise exception using errcode = '23505', message = 'booking_projection_idempotency_conflict';
  end if;
  if b.version < prior.booking_version or s.version < prior.student_version
     or l.version < prior.lp_item_version or t.version < prior.task_version
     or h.version < prior.teacher_version then
    raise exception using errcode = '55000', message = 'booking_projection_replay_version_regressed';
  end if;
  return query select prior.command_key, prior.action, prior.booking_id,
    prior.student_id, prior.previous_student_id, prior.teacher_id,
    prior.previous_teacher_id, prior.actor_role, prior.booking_version,
    prior.student_version, prior.lp_item_version, prior.task_version,
    prior.teacher_version, b, s, l, t, h, prior.audit_id;
end;
$function$;

revoke all on function public.get_booking_projection_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_booking_projection_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.mutate_booking_projection_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_action text,
  p_booking_id text,
  p_expected_versions jsonb,
  p_bookings jsonb,
  p_teachers jsonb,
  p_changed_teacher_ids jsonb,
  p_student_id text,
  p_teacher_id text,
  p_actor_role text,
  p_actor text
)
returns table (
  command_key text,
  action text,
  applied boolean,
  booking_id text,
  student_id text,
  previous_student_id text,
  teacher_id text,
  previous_teacher_id text,
  bookings_row public.ops_state,
  students_row public.ops_state,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  b public.ops_state%rowtype;
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  h public.ops_state%rowtype;
  saved_b public.ops_state%rowtype;
  saved_s public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  saved_h public.ops_state%rowtype;
  prior internal.booking_projection_commands%rowtype;
  core record;
  expected_b bigint;
  expected_s bigint;
  expected_l bigint;
  expected_t bigint;
  expected_h bigint;
  current_booking jsonb;
  committed_booking jsonb;
  target_student jsonb;
  target_teacher jsonb;
  next_students jsonb;
  next_tasks jsonb;
  affected_student_id text;
  projected_student jsonb;
  projected_teacher_id text;
  projected_teacher_name text;
  projected_has_trial boolean;
  previous_student text;
  previous_teacher text;
  core_intent jsonb;
  subcommand_key text;
  payload_hash text;
  applied_at timestamptz := clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^booking-capacity:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) <> 'object'
     or p_command_intent - 'action' - 'bookingId' - 'booking' - 'occurrenceId' - 'occurrence' <> '{}'::jsonb
     or not (
       (p_command_intent ->> 'action' = 'upsert' and p_action in ('create', 'update'))
       or (p_command_intent ->> 'action' = 'delete' and p_action = 'delete')
       or (p_command_intent ->> 'action' = 'cancel_occurrence' and p_action = 'update')
       or (p_command_intent ->> 'action' = 'update_occurrence' and p_action = 'update')
     )
     or p_command_intent ->> 'bookingId' is distinct from p_booking_id
     or p_action not in ('create', 'update', 'delete')
     or p_actor_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or nullif(trim(p_booking_id), '') is null
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_teacher_id), '') is null
     or nullif(trim(p_actor), '') is null
     or jsonb_typeof(p_expected_versions) <> 'object'
     or p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'students') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'lpItems') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') <> 'number'
     or jsonb_typeof(p_bookings) <> 'array'
     or jsonb_typeof(p_teachers) <> 'array'
     or jsonb_typeof(p_changed_teacher_ids) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_command';
  end if;
  if p_command_intent ->> 'action' = 'upsert' and (
       p_command_intent - 'action' - 'bookingId' - 'booking' <> '{}'::jsonb
       or jsonb_typeof(p_command_intent -> 'booking') <> 'object'
     )
     or p_command_intent ->> 'action' = 'delete' and p_command_intent <> jsonb_build_object(
       'action', 'delete', 'bookingId', p_booking_id
     )
     or p_command_intent ->> 'action' = 'cancel_occurrence' and (
       p_command_intent - 'action' - 'bookingId' - 'occurrenceId' <> '{}'::jsonb
       or p_command_intent ->> 'occurrenceId' <> p_booking_id || ':' || pg_catalog.right(p_command_intent ->> 'occurrenceId', 10)
       or pg_catalog.right(p_command_intent ->> 'occurrenceId', 10) !~ '^\d{4}-\d{2}-\d{2}$'
     )
     or p_command_intent ->> 'action' = 'update_occurrence' and (
       p_command_intent - 'action' - 'bookingId' - 'occurrenceId' - 'occurrence' <> '{}'::jsonb
       or p_command_intent ->> 'occurrenceId' <> p_booking_id || ':' || pg_catalog.right(p_command_intent ->> 'occurrenceId', 10)
       or pg_catalog.right(p_command_intent ->> 'occurrenceId', 10) !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(p_command_intent -> 'occurrence') <> 'object'
       or (p_command_intent -> 'occurrence') - 'date' - 'start' - 'duration' - 'status' <> '{}'::jsonb
       or jsonb_typeof(p_command_intent #> '{occurrence,date}') <> 'string'
       or p_command_intent #>> '{occurrence,date}' !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(p_command_intent #> '{occurrence,start}') <> 'string'
       or p_command_intent #>> '{occurrence,start}' !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or jsonb_typeof(p_command_intent #> '{occurrence,duration}') <> 'number'
       or p_command_intent #>> '{occurrence,duration}' not in ('60', '90', '120')
       or p_command_intent #>> '{occurrence,status}' <> 'confirmed'
     ) then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_command';
  end if;
  begin
    expected_b := (p_expected_versions ->> 'bookings')::bigint;
    expected_s := (p_expected_versions ->> 'students')::bigint;
    expected_l := (p_expected_versions ->> 'lpItems')::bigint;
    expected_t := (p_expected_versions ->> 'tasks')::bigint;
    expected_h := (p_expected_versions ->> 'teachers')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_versions';
  end;
  if least(expected_b, expected_s, expected_l, expected_t, expected_h) < 1 then
    raise exception using errcode = '22023', message = 'invalid_booking_projection_versions';
  end if;

  -- Global writer order: files (not touched) -> bookings -> students ->
  -- lpItems -> tasks -> teachers.  Relative order for every overlapping row is
  -- compatible with LP attachments and booking/operation writers.
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  if b.entity is null or s.entity is null or l.entity is null or t.entity is null or h.entity is null then
    raise exception using errcode = '55000', message = 'booking_projection_state_missing';
  end if;

  select * into prior from internal.booking_projection_commands c
  where c.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> left(trim(p_actor), 120)
       or prior.actor_role <> p_actor_role
       or prior.action <> p_action
       or prior.booking_id <> p_booking_id then
      raise exception using errcode = '23505', message = 'booking_projection_idempotency_conflict';
    end if;
    return query select prior.command_key, prior.action, false, prior.booking_id,
      prior.student_id, prior.previous_student_id, prior.teacher_id,
      prior.previous_teacher_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;

  if b.version is distinct from expected_b or s.version is distinct from expected_s
     or l.version is distinct from expected_l or t.version is distinct from expected_t
     or h.version is distinct from expected_h then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  select value into current_booking from jsonb_array_elements(b.payload) value
  where value ->> 'id' = p_booking_id limit 1;
  previous_student := coalesce(current_booking ->> 'studentId', p_student_id);
  previous_teacher := coalesce(current_booking ->> 'teacherId', p_teacher_id);
  if p_action = 'create' and current_booking is not null
     or p_action in ('update', 'delete') and current_booking is null
     or p_action in ('update', 'delete') and current_booking ->> 'studentId' is distinct from previous_student then
    raise exception using errcode = '22023', message = 'booking_projection_action_mismatch';
  end if;
  if p_action = 'delete' and p_student_id is distinct from previous_student then
    raise exception using errcode = '22023', message = 'booking_projection_student_mismatch';
  end if;

  -- A private deterministic sub-command lets the deployed booking core keep
  -- owning every exact booking/capacity/Jiaowubao validation. Its ledger row
  -- rolls back with this wrapper if any later projection check fails.
  subcommand_key := 'booking-capacity:' || encode(extensions.digest(
    p_command_key || chr(31) || 'projection-core-v1', 'sha256'
  ), 'hex');
  core_intent := case when p_command_intent ->> 'action' in ('cancel_occurrence', 'update_occurrence')
    then jsonb_build_object(
      'action', 'upsert', 'bookingId', p_booking_id, 'booking', coalesce((
        select value from jsonb_array_elements(p_bookings) value
        where value ->> 'id' = p_booking_id limit 1
      ), '{}'::jsonb)
    ) else p_command_intent end;
  select * into core from public.mutate_booking_capacity_atomic(
    p_secret,
    subcommand_key,
    core_intent,
    p_action,
    p_booking_id,
    jsonb_build_object('bookings', expected_b, 'students', expected_s, 'teachers', expected_h),
    p_bookings,
    p_teachers,
    p_changed_teacher_ids,
    p_student_id,
    p_teacher_id,
    p_actor
  );
  if core.command_key is null or core.applied is distinct from true then
    raise exception using errcode = '55000', message = 'booking_projection_core_result_invalid';
  end if;
  saved_b := core.bookings_row;
  saved_h := core.teachers_row;

  select value into committed_booking from jsonb_array_elements(saved_b.payload) value
  where value ->> 'id' = p_booking_id limit 1;
  if p_action <> 'delete' and (
       committed_booking is null
       or committed_booking ->> 'studentId' is distinct from p_student_id
       or committed_booking ->> 'teacherId' is distinct from p_teacher_id
     ) then
    raise exception using errcode = '22023', message = 'booking_projection_core_identity_mismatch';
  end if;

  select value into target_student from jsonb_array_elements(s.payload) value
  where value ->> 'id' = p_student_id limit 1;
  select value into target_teacher from jsonb_array_elements(saved_h.payload) value
  where value ->> 'id' = p_teacher_id limit 1;
  if target_student is null or target_teacher is null
     or nullif(target_teacher ->> 'name', '') is null then
    raise exception using errcode = '22023', message = 'booking_projection_identity_missing';
  end if;

  next_students := s.payload;
  if p_actor_role <> 'teacher' then
    for affected_student_id in
      select distinct value from unnest(array[previous_student, p_student_id]) value
      where nullif(trim(value), '') is not null order by value
    loop
      select item.value into projected_student
      from jsonb_array_elements(next_students) item(value)
      where item.value ->> 'id' = affected_student_id limit 1;
      if projected_student is null then
        raise exception using errcode = '22023', message = 'booking_projection_identity_missing';
      end if;
      select candidate.teacher_id into projected_teacher_id
      from jsonb_array_elements(saved_b.payload) with ordinality booking(value, ordinality)
      cross join lateral (
        select booking.value ->> 'teacherId' as teacher_id, 0 as priority
        union
        select override_item.value ->> 'teacherId', 1
        from jsonb_array_elements(case when jsonb_typeof(booking.value -> 'occurrenceOverrides') = 'array'
          then booking.value -> 'occurrenceOverrides' else '[]'::jsonb end) override_item(value)
        where nullif(trim(override_item.value ->> 'teacherId'), '') is not null
      ) candidate
      where booking.value ->> 'kind' <> '代课'
        and internal.booking_projection_has_active_relationship(
          booking.value, affected_student_id, candidate.teacher_id
        )
      order by booking.ordinality, candidate.priority
      limit 1;
      projected_has_trial := exists (
        select 1 from jsonb_array_elements(saved_b.payload) booking(value)
        cross join lateral (
          select booking.value ->> 'teacherId' as teacher_id
          union
          select override_item.value ->> 'teacherId'
          from jsonb_array_elements(case when jsonb_typeof(booking.value -> 'occurrenceOverrides') = 'array'
            then booking.value -> 'occurrenceOverrides' else '[]'::jsonb end) override_item(value)
          where nullif(trim(override_item.value ->> 'teacherId'), '') is not null
        ) candidate
        where booking.value ->> 'kind' = '试听'
          and internal.booking_projection_has_active_relationship(
            booking.value, affected_student_id, candidate.teacher_id
          )
      );
      if projected_teacher_id is not null then
        select teacher.value ->> 'name' into projected_teacher_name
        from jsonb_array_elements(saved_h.payload) teacher(value)
        where teacher.value ->> 'id' = projected_teacher_id limit 1;
        if nullif(projected_teacher_name, '') is null then
          raise exception using errcode = '22023', message = 'booking_projection_identity_missing';
        end if;
      else
        projected_teacher_name := '待匹配';
      end if;
      select coalesce(jsonb_agg(
        case when item.value ->> 'id' = affected_student_id then
          item.value || jsonb_build_object(
            'teacher', projected_teacher_name,
            'status', case when projected_has_trial then '活跃 + 无课时'
              else item.value ->> 'status' end,
            'next', case when projected_teacher_id is not null
              then '完成 LP 与 N-2 检查' else '确认首次排课' end,
            'nextTone', case when projected_teacher_id is not null then 'amber' else 'blue' end
          )
        else item.value end order by item.ordinality
      ), '[]'::jsonb) into next_students
      from jsonb_array_elements(next_students) with ordinality item(value, ordinality);
    end loop;
  end if;

  next_tasks := internal.rebuild_booking_trial_tasks(
    t.payload, l.payload, committed_booking, current_booking, p_action, applied_at
  );
  if jsonb_typeof(next_students) <> 'array' or jsonb_typeof(next_tasks) <> 'array' then
    raise exception using errcode = '55000', message = 'booking_projection_rebuild_invalid';
  end if;

  if next_students is distinct from s.payload then
    update public.ops_state set payload = next_students, version = s.version + 1,
      updated_at = now(), updated_by = left(trim(p_actor), 120)
    where entity = 'students' returning * into saved_s;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('students', saved_s.version, saved_s.updated_by);
  else saved_s := s; end if;

  if next_tasks is distinct from t.payload then
    update public.ops_state set payload = next_tasks, version = t.version + 1,
      updated_at = now(), updated_by = left(trim(p_actor), 120)
    where entity = 'tasks' returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_t.version, saved_t.updated_by);
  else saved_t := t; end if;

  payload_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent,
    'bookingsVersion', saved_b.version,
    'studentsVersion', saved_s.version,
    'lpItemsVersion', l.version,
    'tasksVersion', saved_t.version,
    'teachersVersion', saved_h.version
  )::text, 'sha256'), 'hex');
  insert into internal.booking_projection_commands(
    command_key, command_intent, command_hash, action, booking_id,
    student_id, previous_student_id, teacher_id, previous_teacher_id,
    booking_version, student_version,
    lp_item_version, task_version, teacher_version, actor_role, actor, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, p_action, p_booking_id,
    p_student_id, previous_student, p_teacher_id, previous_teacher,
    saved_b.version, saved_s.version,
    l.version, saved_t.version, saved_h.version, p_actor_role,
    left(trim(p_actor), 120), core.audit_entry_id
  );

  return query select p_command_key, p_action, true, p_booking_id,
    p_student_id, previous_student, p_teacher_id, previous_teacher,
    saved_b, saved_s, l, saved_t, saved_h,
    core.audit_entry_id::uuid;
end;
$function$;

revoke all on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) to anon, authenticated;

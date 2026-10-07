create index if not exists jiaowubao_completed_lesson_member_latest
  on internal.jiaowubao_completed_lesson_member_runs(period_month, started_at desc, id desc);
create index if not exists jiaowubao_completed_lesson_member_published
  on internal.jiaowubao_completed_lesson_member_runs(period_month, published_at desc) where state = 'published';

alter table internal.jiaowubao_completed_lesson_member_runs
  add column data_through date check (data_through >= period_month and data_through < period_month + interval '1 month');

create or replace function public.begin_jiaowubao_completed_lesson_member_collection_window(
  p_secret text,
  p_month text,
  p_data_through text,
  p_run_key text,
  p_schedule_revision text,
  p_schedule_member_ids jsonb,
  p_schedule_member_set_sha256 text,
  p_expected_current_revision text,
  p_force boolean,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  month_value date;
  run_id uuid := gen_random_uuid();
  saved_id uuid;
  latest_id uuid;
  latest_state text;
  catalog jsonb;
  catalog_ids bigint[];
  catalog_count integer;
  catalog_revision_sha text;
  candidate_ids bigint[];
  schedule_ids bigint[];
  candidate_count integer;
  schedule_count integer;
  candidate_sha text;
  schedule_sha text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin'
     or coalesce(p_month, '') !~ '^\d{4}-\d{2}$'
     or coalesce(p_schedule_revision, '') !~ '^sha256:[a-f0-9]{64}$'
     or coalesce(p_schedule_member_set_sha256, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_force is null
     or (p_expected_current_revision is not null and p_expected_current_revision !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_member_collection_forbidden';
  end if;
  month_value := to_date(p_month || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  if coalesce(p_data_through, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
  end if;
  if to_char(p_data_through::date, 'YYYY-MM-DD') <> p_data_through
     or p_data_through::date < month_value
     or p_data_through::date >= month_value + interval '1 month'
     or p_data_through::date >= timezone('Australia/Melbourne', clock_timestamp())::date then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lesson-members:' || month_value::text, 0));
  select run_row.id, run_row.state into latest_id, latest_state
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value
  order by run_row.started_at desc
  limit 1
  for update;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(month_value, p_run_key);
  if latest_id is not null and latest_state = 'blocked' then
    return internal.jiaowubao_completed_lesson_member_status(latest_id);
  end if;
  if p_schedule_member_ids is null or jsonb_typeof(p_schedule_member_ids) is distinct from 'array'
     or jsonb_array_length(p_schedule_member_ids) > 6000
     or exists (
       select 1 from jsonb_array_elements(p_schedule_member_ids) item(value)
       where jsonb_typeof(item.value) is distinct from 'number'
          or item.value::text !~ '^[1-9][0-9]{0,15}$'
          or (item.value::text)::numeric > 9007199254740991
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_schedule_member_ids_invalid';
  end if;
  catalog := internal.jiaowubao_completed_lesson_member_catalog();
  select array_agg((item.value::text)::bigint order by (item.value::text)::bigint)
    into catalog_ids from jsonb_array_elements(catalog -> 'memberIds') item(value);
  catalog_count := (catalog ->> 'memberCount')::integer;
  catalog_revision_sha := catalog ->> 'revisionSha256';
  select coalesce(array_agg(distinct (item.value::text)::bigint order by (item.value::text)::bigint), '{}'::bigint[])
    into schedule_ids from jsonb_array_elements(p_schedule_member_ids) item(value);
  schedule_count := cardinality(schedule_ids);
  schedule_sha := 'sha256:' || encode(extensions.digest(coalesce(array_to_string(schedule_ids, E'\n'), ''), 'sha256'), 'hex');
  if schedule_sha is distinct from p_schedule_member_set_sha256 then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_schedule_member_set_conflict';
  end if;
  select array_agg(member_id order by member_id) into candidate_ids
  from (
    select unnest(catalog_ids) as member_id
    union
    select unnest(schedule_ids)
  ) candidates;
  candidate_count := cardinality(candidate_ids);
  if candidate_count not between 1 and 6000 then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid'; end if;
  candidate_sha := 'sha256:' || encode(extensions.digest(coalesce(array_to_string(candidate_ids, E'\n'), ''), 'sha256'), 'hex');

  select run_row.id into saved_id
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value and run_row.state in ('collecting', 'ready')
  order by run_row.started_at desc limit 1 for update;
  if saved_id is not null then
    if exists (
      select 1 from internal.jiaowubao_completed_lesson_member_runs run_row
      where run_row.id = saved_id
        and coalesce(run_row.data_through, (month_value + interval '1 month - 1 day')::date) = p_data_through::date
        and run_row.schedule_revision = p_schedule_revision
        and run_row.schedule_member_set_sha256 = schedule_sha
        and run_row.member_set_sha256 = candidate_sha
        and run_row.expected_current_revision is not distinct from p_expected_current_revision
    ) then return internal.jiaowubao_completed_lesson_member_status(saved_id); end if;
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_collection_conflict';
  end if;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_completed_lesson_member_collection.started', p_actor,
    'jiaowubao_completed_lesson_member_run', run_id::text,
    jsonb_build_object('month', p_month, 'memberCount', candidate_count,
      'memberSetSha256', candidate_sha, 'scheduleMemberCount', schedule_count,
      'scheduleMemberSetSha256', schedule_sha, 'scheduleRevision', p_schedule_revision,
      'catalogMemberCount', catalog_count, 'catalogRevisionSha256', catalog_revision_sha)
  );
  insert into internal.jiaowubao_completed_lesson_member_runs(
    id, period_month, data_through, state, schedule_revision, schedule_member_set_sha256,
    schedule_member_count, catalog_revision_sha256, catalog_member_count,
    member_set_sha256, member_count,
    expected_current_revision, started_by, begin_audit_id
  ) values (
    run_id, month_value, p_data_through::date, 'collecting', p_schedule_revision, schedule_sha,
    schedule_count, catalog_revision_sha, catalog_count,
    candidate_sha, candidate_count,
    p_expected_current_revision, p_actor, audit_id
  );
  insert into internal.jiaowubao_completed_lesson_member_targets(run_id, ordinal, member_id)
  select run_id, member.ordinality::integer - 1, member.member_id
  from unnest(candidate_ids) with ordinality member(member_id, ordinality);
  return internal.jiaowubao_completed_lesson_member_status(run_id);
end;
$$;
revoke all on function public.begin_jiaowubao_completed_lesson_member_collection_window(text,text,text,text,text,jsonb,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.begin_jiaowubao_completed_lesson_member_collection_window(text,text,text,text,text,jsonb,text,text,boolean,text) to anon, authenticated;


do $patch$
declare definition text; needle text := $needle$     or new.period_month is distinct from old.period_month$needle$; replacement text := $replacement$     or new.period_month is distinct from old.period_month
     or new.data_through is distinct from old.data_through$replacement$;
begin
  definition := pg_get_functiondef('internal.guard_jiaowubao_completed_lesson_member_run_identity()'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: internal.guard_jiaowubao_completed_lesson_member_run_identity()';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$    'month', to_char(run_row.period_month, 'YYYY-MM'),$needle$; replacement text := $replacement$    'month', to_char(run_row.period_month, 'YYYY-MM'),
    'dataThrough', to_char(coalesce(run_row.data_through, (run_row.period_month + interval '1 month - 1 day')::date), 'YYYY-MM-DD'),
    'publishedAt', run_row.published_at,$replacement$;
begin
  definition := pg_get_functiondef('internal.jiaowubao_completed_lesson_member_status(uuid)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: internal.jiaowubao_completed_lesson_member_status(uuid)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$  month_end := (month_start + interval '1 month - 1 day')::date;$needle$; replacement text := $replacement$  if coalesce(p_envelope #>> '{query,lessons,end}', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
  end if;
  month_end := (p_envelope #>> '{query,lessons,end}')::date;
  if to_char(month_end, 'YYYY-MM-DD') <> p_envelope #>> '{query,lessons,end}'
     or month_end < month_start or month_end >= month_start + interval '1 month'
     or month_end >= timezone('Australia/Melbourne', clock_timestamp())::date then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
  end if;$replacement$;
begin
  definition := pg_get_functiondef('internal.assert_jiaowubao_completed_lesson_snapshot_envelope(jsonb)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: internal.assert_jiaowubao_completed_lesson_snapshot_envelope(jsonb)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$    perform internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows, run_state.period_month);$needle$; replacement text := $replacement$    perform internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows, run_state.period_month);
    if exists (select 1 from jsonb_array_elements(p_rows) wrapper
      where wrapper -> 'record' ->> 'lessonDate' > to_char(coalesce(run_state.data_through, (run_state.period_month + interval '1 month - 1 day')::date), 'YYYY-MM-DD')) then
      raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
    end if;$replacement$;
begin
  definition := pg_get_functiondef('public.stage_jiaowubao_completed_lesson_member_page(text,uuid,text,bigint,integer,bigint,integer,jsonb,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: public.stage_jiaowubao_completed_lesson_member_page(text,uuid,text,bigint,integer,bigint,integer,jsonb,text)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$  perform internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope);$needle$; replacement text := $replacement$  perform internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope);
  if (p_envelope #>> '{query,lessons,end}')::date < ((p_envelope ->> 'month' || '-01')::date + interval '1 month - 1 day')::date
     and not exists (select 1 from internal.jiaowubao_completed_lesson_member_runs member_run
       where member_run.period_month = (p_envelope ->> 'month' || '-01')::date
         and member_run.state in ('ready','published')
         and member_run.final_revision = p_envelope ->> 'revision'
         and member_run.data_through = (p_envelope #>> '{query,lessons,end}')::date
         and member_run.completed_member_count = member_run.member_count) then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_cutoff_unverified';
  end if;$replacement$;
begin
  definition := pg_get_functiondef('public.begin_jiaowubao_completed_lesson_snapshot_ingest(text,jsonb,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: public.begin_jiaowubao_completed_lesson_snapshot_ingest(text,jsonb,text)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$  perform internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows, run_state.period_month);$needle$; replacement text := $replacement$  perform internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows, run_state.period_month);
  if exists (select 1 from jsonb_array_elements(p_rows) wrapper
    where wrapper -> 'record' ->> 'lessonDate' > run_state.query #>> '{lessons,end}') then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
  end if;$replacement$;
begin
  definition := pg_get_functiondef('public.stage_jiaowubao_completed_lesson_snapshot_page(text,uuid,integer,jsonb,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: public.stage_jiaowubao_completed_lesson_snapshot_page(text,uuid,integer,jsonb,text)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$  perform internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(p_rows,run_state.period_month);$needle$; replacement text := $replacement$  perform internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(p_rows,run_state.period_month);
  if exists (select 1 from jsonb_array_elements(p_rows) wrapper
    where wrapper -> 'record' ->> 'lessonDate' > run_state.query #>> '{schedules,end}') then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_cutoff_invalid';
  end if;$replacement$;
begin
  definition := pg_get_functiondef('public.stage_jiaowubao_completed_lesson_snapshot_schedule_page(text,uuid,integer,jsonb,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: public.stage_jiaowubao_completed_lesson_snapshot_schedule_page(text,uuid,integer,jsonb,text)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$'publishedAt',current_row.published_at$needle$; replacement text := $replacement$'dataThrough',(select snapshot_run.query #>> '{lessons,end}' from internal.jiaowubao_completed_lesson_snapshot_runs snapshot_run where snapshot_run.id = current_row.run_id),
      'provisional',(select (snapshot_run.query #>> '{lessons,end}')::date < (snapshot_run.period_month + interval '1 month - 1 day')::date from internal.jiaowubao_completed_lesson_snapshot_runs snapshot_run where snapshot_run.id = current_row.run_id),
      'publishedAt',current_row.published_at$replacement$;
begin
  definition := pg_get_functiondef('public.get_jiaowubao_completed_lesson_snapshot_page(text,text,integer,text,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> 2 * length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: public.get_jiaowubao_completed_lesson_snapshot_page(text,text,integer,text,text)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$'publishedAt',current_row.published_at$needle$; replacement text := $replacement$'dataThrough',(select snapshot_run.query #>> '{lessons,end}' from internal.jiaowubao_completed_lesson_snapshot_runs snapshot_run where snapshot_run.id = current_row.run_id),
      'provisional',(select (snapshot_run.query #>> '{lessons,end}')::date < (snapshot_run.period_month + interval '1 month - 1 day')::date from internal.jiaowubao_completed_lesson_snapshot_runs snapshot_run where snapshot_run.id = current_row.run_id),
      'publishedAt',current_row.published_at$replacement$;
begin
  definition := pg_get_functiondef('public.get_jiaowubao_completed_lesson_snapshot_schedule_page(text,text,integer,text,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> 2 * length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: public.get_jiaowubao_completed_lesson_snapshot_schedule_page(text,text,integer,text,text)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

do $patch$
declare definition text; needle text := $needle$  select profile.value into teacher_profile$needle$; replacement text := $replacement$  if month_value >= date_trunc('month', timezone('Australia/Melbourne', clock_timestamp()))::date
     or not exists (select 1 from internal.jiaowubao_completed_lesson_snapshot_runs source_run
       where source_run.id = current_pointer.run_id
         and source_run.query #>> '{lessons,end}' = to_char((month_value + interval '1 month - 1 day')::date, 'YYYY-MM-DD')
         and source_run.query #>> '{schedules,end}' = to_char((month_value + interval '1 month - 1 day')::date, 'YYYY-MM-DD')) then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_month_provisional';
  end if;
  select profile.value into teacher_profile$replacement$;
begin
  definition := pg_get_functiondef('internal.assert_jiaowubao_payroll_source_summary(jsonb,jsonb,jsonb)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'monthly_hours_migration_anchor_missing: internal.assert_jiaowubao_payroll_source_summary(jsonb,jsonb,jsonb)';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;

create or replace function public.get_jiaowubao_completed_lesson_pending_month(p_secret text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare selected_month date; today date := timezone('Australia/Melbourne', clock_timestamp())::date;
  current_month date := date_trunc('month', today)::date;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_pending_month_forbidden'; end if;
  with latest as materialized (
    select distinct on (period_month) period_month, state, abort_reason, started_at
    from internal.jiaowubao_completed_lesson_member_runs
    order by period_month, started_at desc, id desc
  ), checked as (
    select period_month, max(published_at) as checked_at
    from internal.jiaowubao_completed_lesson_member_runs where state = 'published'
    group by period_month
  ), months as (
    select (current_month - interval '1 month')::date as period_month
    union select current_month where today > current_month
    union select period_month from internal.jiaowubao_completed_lesson_snapshot_current
    union select period_month from latest where state in ('collecting','ready','aborted')
  ), due as (
    select months.period_month, latest.state, latest.started_at,
      case when latest.state in ('collecting','ready') then '-infinity'::timestamptz
        when pointer.run_id is null then '-infinity'::timestamptz
        when (source_run.query #>> '{lessons,end}')::date < least((months.period_month + interval '1 month - 1 day')::date, today - 1)
          then coalesce(checked.checked_at, pointer.published_at)
        else coalesce(checked.checked_at, pointer.published_at) +
          case when months.period_month >= current_month - interval '1 month' then interval '1 day' else interval '7 days' end
      end as due_at
    from months left join latest using (period_month) left join checked using (period_month)
    left join internal.jiaowubao_completed_lesson_snapshot_current pointer using (period_month)
    left join internal.jiaowubao_completed_lesson_snapshot_runs source_run on source_run.id = pointer.run_id
    where months.period_month < today and coalesce(latest.state, '') <> 'blocked'
  )
  select period_month into selected_month from due
  where due_at <= clock_timestamp()
  order by case when state in ('collecting','ready') then 0 else 1 end,
    due_at, coalesce(started_at, '-infinity'::timestamptz), period_month
  limit 1;
  return jsonb_build_object('month', case when selected_month is null then null else to_char(selected_month, 'YYYY-MM') end);
end;
$function$;
revoke all on function public.get_jiaowubao_completed_lesson_pending_month(text,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_pending_month(text,text) to anon, authenticated;

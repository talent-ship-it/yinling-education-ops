-- The live query_lesson_list gateway requires an additional selector. Freeze
-- a private ID-only roster, collect each member page durably, and keep the
-- existing immutable monthly snapshot pointer untouched until every member is
-- complete. The queue stores only the existing allowlisted lesson DTO (which
-- includes display names needed by payroll reconciliation), never a raw
-- supplier response, credential, cookie, token, or browser payload.

create table if not exists internal.jiaowubao_completed_lesson_member_runs (
  id uuid primary key default gen_random_uuid(),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  state text not null check (state in ('collecting', 'ready', 'published', 'aborted', 'blocked')),
  schedule_revision text not null check (schedule_revision ~ '^sha256:[a-f0-9]{64}$'),
  schedule_member_set_sha256 text not null check (schedule_member_set_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  schedule_member_count integer not null check (schedule_member_count between 0 and 6000),
  catalog_revision_sha256 text not null check (catalog_revision_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  catalog_member_count integer not null check (catalog_member_count between 1 and 6000),
  member_set_sha256 text not null check (member_set_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  member_count integer not null check (member_count between 1 and 6000),
  completed_member_count integer not null default 0 check (completed_member_count >= 0),
  row_count integer not null default 0 check (row_count between 0 and 6000),
  expected_current_revision text check (expected_current_revision is null or expected_current_revision ~ '^sha256:[a-f0-9]{64}$'),
  final_revision text check (final_revision is null or final_revision ~ '^sha256:[a-f0-9]{64}$'),
  started_by text not null check (started_by = 'Ops Admin'),
  started_at timestamptz not null default clock_timestamp(),
  ready_at timestamptz,
  published_at timestamptz,
  aborted_at timestamptz,
  abort_reason text check (abort_reason is null or abort_reason in ('schedule_changed', 'source_conflict', 'caller_failure', 'catalog_changed')),
  begin_audit_id uuid not null references internal.operational_contract_audit(id),
  ready_audit_id uuid references internal.operational_contract_audit(id),
  publish_audit_id uuid references internal.operational_contract_audit(id),
  abort_audit_id uuid references internal.operational_contract_audit(id),
  check (completed_member_count <= member_count),
  check ((state = 'collecting' and ready_at is null and published_at is null and aborted_at is null
      and abort_reason is null and abort_audit_id is null)
    or (state = 'ready' and ready_at is not null and published_at is null and aborted_at is null
      and abort_reason is null and abort_audit_id is null)
    or (state = 'published' and ready_at is not null and published_at is not null and aborted_at is null
      and final_revision is not null and abort_reason is null and abort_audit_id is null)
    or (state = 'aborted' and published_at is null and aborted_at is not null and abort_audit_id is not null
      and abort_reason is not null and abort_reason <> 'caller_failure' and final_revision is null)
    or (state = 'blocked' and ready_at is null and published_at is null and aborted_at is not null
      and abort_audit_id is not null and abort_reason = 'caller_failure' and final_revision is null))
);

create unique index if not exists jiaowubao_completed_lesson_member_one_active_month
  on internal.jiaowubao_completed_lesson_member_runs(period_month)
  where state in ('collecting', 'ready');
alter table internal.jiaowubao_completed_lesson_member_runs enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_member_runs from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_member_run_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     or new.id is distinct from old.id
     or new.period_month is distinct from old.period_month
     or new.schedule_revision is distinct from old.schedule_revision
     or new.schedule_member_set_sha256 is distinct from old.schedule_member_set_sha256
     or new.schedule_member_count is distinct from old.schedule_member_count
     or new.catalog_revision_sha256 is distinct from old.catalog_revision_sha256
     or new.catalog_member_count is distinct from old.catalog_member_count
     or new.member_set_sha256 is distinct from old.member_set_sha256
     or new.member_count is distinct from old.member_count
     or new.expected_current_revision is distinct from old.expected_current_revision
     or new.started_by is distinct from old.started_by
     or new.started_at is distinct from old.started_at
     or new.begin_audit_id is distinct from old.begin_audit_id then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_run_identity_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_member_run_identity on internal.jiaowubao_completed_lesson_member_runs;
create trigger guard_jiaowubao_completed_lesson_member_run_identity before update or delete
  on internal.jiaowubao_completed_lesson_member_runs for each row
  execute function internal.guard_jiaowubao_completed_lesson_member_run_identity();
revoke all on function internal.guard_jiaowubao_completed_lesson_member_run_identity() from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_member_targets (
  run_id uuid not null references internal.jiaowubao_completed_lesson_member_runs(id) on delete restrict,
  ordinal integer not null check (ordinal between 0 and 5999),
  member_id bigint not null check (member_id between 1 and 9007199254740991),
  next_page integer not null default 1 check (next_page between 1 and 61),
  expected_total integer check (expected_total is null or expected_total between 0 and 6000),
  collected_count integer not null default 0 check (collected_count between 0 and 6000),
  complete boolean not null default false,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (run_id, ordinal),
  unique (run_id, member_id),
  check ((complete and expected_total is not null and collected_count = expected_total)
    or (not complete and collected_count <= coalesce(expected_total, 6000)))
);

create index if not exists jiaowubao_completed_lesson_member_targets_pending
  on internal.jiaowubao_completed_lesson_member_targets(run_id, ordinal)
  where not complete;
alter table internal.jiaowubao_completed_lesson_member_targets enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_member_targets from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_member_target_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     or new.run_id is distinct from old.run_id
     or new.ordinal is distinct from old.ordinal
     or new.member_id is distinct from old.member_id then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_target_identity_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_member_target_identity on internal.jiaowubao_completed_lesson_member_targets;
create trigger guard_jiaowubao_completed_lesson_member_target_identity before update or delete
  on internal.jiaowubao_completed_lesson_member_targets for each row
  execute function internal.guard_jiaowubao_completed_lesson_member_target_identity();
revoke all on function internal.guard_jiaowubao_completed_lesson_member_target_identity() from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_member_pages (
  run_id uuid not null,
  member_id bigint not null,
  page integer not null check (page between 1 and 60),
  source_total integer not null check (source_total between 0 and 6000),
  row_count integer not null check (row_count between 0 and 100),
  page_sha256 text not null check (page_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  captured_at timestamptz not null default clock_timestamp(),
  primary key (run_id, member_id, page),
  foreign key (run_id, member_id)
    references internal.jiaowubao_completed_lesson_member_targets(run_id, member_id) on delete restrict,
  check (jsonb_array_length(rows) = row_count),
  check (octet_length(rows::text) <= 2097152)
);
alter table internal.jiaowubao_completed_lesson_member_pages enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_member_pages from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_member_items (
  run_id uuid not null,
  member_id bigint not null,
  source_key text not null check (source_key ~ '^jwb-open-api:lesson:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  canonical_json text not null,
  item_sha256 text not null check (item_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  item jsonb not null check (jsonb_typeof(item) = 'object'),
  primary key (run_id, member_id, source_key),
  unique (run_id, source_key),
  foreign key (run_id, member_id)
    references internal.jiaowubao_completed_lesson_member_targets(run_id, member_id) on delete restrict
);
alter table internal.jiaowubao_completed_lesson_member_items enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_member_items from public, anon, authenticated;

create table if not exists internal.jiaowubao_open_api_rate_gate (
  tool text primary key check (tool in ('query_lesson_list', 'query_schedule_list')),
  next_allowed_at timestamptz not null
);
alter table internal.jiaowubao_open_api_rate_gate enable row level security;
revoke all on table internal.jiaowubao_open_api_rate_gate from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_member_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_evidence_immutable';
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_member_pages on internal.jiaowubao_completed_lesson_member_pages;
create trigger guard_jiaowubao_completed_lesson_member_pages before update or delete
  on internal.jiaowubao_completed_lesson_member_pages for each row
  execute function internal.guard_jiaowubao_completed_lesson_member_immutable();
drop trigger if exists guard_jiaowubao_completed_lesson_member_items on internal.jiaowubao_completed_lesson_member_items;
create trigger guard_jiaowubao_completed_lesson_member_items before update or delete
  on internal.jiaowubao_completed_lesson_member_items for each row
  execute function internal.guard_jiaowubao_completed_lesson_member_immutable();
revoke all on function internal.guard_jiaowubao_completed_lesson_member_immutable() from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_completed_lesson_worker_lease(
  p_month date,
  p_run_key text
)
returns void language plpgsql set search_path = '' as $$
declare saved internal.jiaowubao_completed_lesson_sync_leases%rowtype;
begin
  if p_month is null or coalesce(p_run_key, '') !~ '^jwb-completed-lessons-sync:[0-9]{10,16}:[0-9]{4}-[0-9]{2}$' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_worker_lease_invalid';
  end if;
  select * into saved
  from internal.jiaowubao_completed_lesson_sync_leases lease_row
  where lease_row.period_month = p_month
  for update;
  if not found or saved.run_key is distinct from p_run_key or saved.lease_expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_worker_lease_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_completed_lesson_worker_lease(date,text) from public, anon, authenticated;

create or replace function internal.jiaowubao_completed_lesson_member_status(p_run_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'state', run_row.state,
    'runId', run_row.id,
    'month', to_char(run_row.period_month, 'YYYY-MM'),
    'scheduleRevision', run_row.schedule_revision,
    'scheduleMemberSetSha256', run_row.schedule_member_set_sha256,
    'scheduleMemberCount', run_row.schedule_member_count,
    'catalogRevisionSha256', run_row.catalog_revision_sha256,
    'catalogMemberCount', run_row.catalog_member_count,
    'memberSetSha256', run_row.member_set_sha256,
    'memberCount', run_row.member_count,
    'completedMemberCount', run_row.completed_member_count,
    'rowCount', run_row.row_count,
    'expectedCurrentRevision', run_row.expected_current_revision,
    'finalRevision', run_row.final_revision,
    'abortReason', run_row.abort_reason,
    'nextMemberId', next_target.member_id,
    'nextPage', next_target.next_page,
    'expectedTotal', next_target.expected_total,
    'targetVersion', next_target.version
  )
  from internal.jiaowubao_completed_lesson_member_runs run_row
  left join lateral (
    select target.member_id, target.next_page, target.expected_total, target.version
    from internal.jiaowubao_completed_lesson_member_targets target
    where target.run_id = run_row.id and not target.complete and run_row.state = 'collecting'
    order by target.ordinal
    limit 1
  ) next_target on true
  where run_row.id = p_run_id
$$;
revoke all on function internal.jiaowubao_completed_lesson_member_status(uuid) from public, anon, authenticated;

create or replace function internal.jiaowubao_completed_lesson_member_catalog()
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  jwb_source internal.student_import_source_rows%rowtype;
  master_source internal.student_import_source_rows%rowtype;
  link_state internal.student_import_identity_link_sets%rowtype;
  students_state public.ops_state%rowtype;
  master_found boolean := false;
  links_found boolean := false;
  students_found boolean := false;
  ops_member_ids bigint[];
  ops_member_ids_sha text;
  member_ids bigint[];
  revision_payload jsonb;
  revision_sha text;
begin
  select * into jwb_source from internal.student_import_source_rows source where source.source_kind = 'jwb';
  if not found or jsonb_typeof(jwb_source.rows) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid';
  end if;
  if jwb_source.row_count is distinct from jsonb_array_length(jwb_source.rows)
     or jwb_source.rows_sha256 is distinct from encode(extensions.digest(jwb_source.rows::text, 'sha256'), 'hex')
     or jwb_source.row_count < 1
     or exists (
       select 1 from jsonb_array_elements(jwb_source.rows) source_row(value)
       where coalesce(source_row.value ->> 'sourceRow', '') !~ '^[1-9][0-9]{0,15}$'
          or (source_row.value ->> 'sourceRow')::numeric > 9007199254740991
     ) then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid';
  end if;

  select * into master_source from internal.student_import_source_rows source where source.source_kind = 'master';
  master_found := found;
  if master_found and (jsonb_typeof(master_source.rows) is distinct from 'array'
     or master_source.row_count is distinct from jsonb_array_length(master_source.rows)
     or master_source.rows_sha256 is distinct from encode(extensions.digest(master_source.rows::text, 'sha256'), 'hex')) then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid';
  end if;
  select * into link_state from internal.student_import_identity_link_sets where singleton limit 1;
  links_found := found;
  if links_found and (jsonb_typeof(link_state.links) is distinct from 'array'
     or link_state.link_count is distinct from jsonb_array_length(link_state.links)
     or coalesce(link_state.link_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid';
  end if;

  select * into students_state from public.ops_state state_row where state_row.entity = 'students';
  students_found := found;
  if students_found and jsonb_typeof(students_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid';
  end if;
  select coalesce(array_agg(distinct source_id::bigint order by source_id::bigint), '{}'::bigint[])
    into ops_member_ids
  from (
    select internal.student_import_source_key(candidate.value) as source_id
    from jsonb_array_elements(case when students_found then students_state.payload else '[]'::jsonb end) student_row(value)
    cross join lateral (
      values
        (student_row.value -> 'jwbSourceRow'),
        (student_row.value #> '{historicalJwbSnapshot,currentAggregate,jwbSourceRow}'),
        (student_row.value #> '{historicalJwbSnapshot,retained,jwbSourceRow}')
    ) candidate(value)
  ) ops_ids
  where coalesce(source_id, '') ~ '^[1-9][0-9]{0,15}$'
    and source_id::numeric <= 9007199254740991;
  ops_member_ids_sha := 'sha256:' || encode(
    extensions.digest(coalesce(array_to_string(ops_member_ids, E'\n'), ''), 'sha256'),
    'hex'
  );

  select array_agg(member_id order by member_id) into member_ids
  from (
    select distinct (source_row.value ->> 'sourceRow')::bigint as member_id
    from jsonb_array_elements(jwb_source.rows) source_row(value)
    union
    select (master_row.value ->> 'jwbMemId')::bigint
    from jsonb_array_elements(case when master_found then master_source.rows else '[]'::jsonb end) master_row(value)
    where coalesce(master_row.value ->> 'jwbMemId', '') ~ '^[1-9][0-9]{0,15}$'
      and (master_row.value ->> 'jwbMemId')::numeric <= 9007199254740991
    union
    select (link_row.value ->> 'jwbSourceRow')::bigint
    from jsonb_array_elements(case when links_found then link_state.links else '[]'::jsonb end) link_row(value)
    where coalesce(link_row.value ->> 'jwbSourceRow', '') ~ '^[1-9][0-9]{0,15}$'
      and (link_row.value ->> 'jwbSourceRow')::numeric <= 9007199254740991
    union
    select unnest(ops_member_ids)
  ) catalog_members;
  if cardinality(member_ids) not between 1 and 6000 then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_catalog_invalid';
  end if;
  revision_payload := jsonb_build_object(
    'jwbSourceId', jwb_source.source_id,
    'jwbRevision', jwb_source.revision,
    'jwbRowsSha256', jwb_source.rows_sha256,
    'jwbRowCount', jwb_source.row_count,
    'masterSourceId', case when master_found then master_source.source_id end,
    'masterRevision', case when master_found then master_source.revision end,
    'masterRowsSha256', case when master_found then master_source.rows_sha256 end,
    'masterRowCount', case when master_found then master_source.row_count end,
    'linkFingerprint', case when links_found then link_state.link_fingerprint end,
    'linkCount', case when links_found then link_state.link_count end,
    'opsStudentJwbMemberIdsSha256', ops_member_ids_sha,
    'opsStudentJwbMemberIdCount', cardinality(ops_member_ids)
  );
  revision_sha := 'sha256:' || encode(extensions.digest(revision_payload::text, 'sha256'), 'hex');
  return jsonb_build_object(
    'memberIds', to_jsonb(member_ids),
    'memberCount', cardinality(member_ids),
    'revisionSha256', revision_sha
  );
end;
$$;
revoke all on function internal.jiaowubao_completed_lesson_member_catalog() from public, anon, authenticated;

create or replace function public.get_jiaowubao_completed_lesson_member_collection(
  p_secret text,
  p_month text,
  p_run_key text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; run_id uuid; run_state text; run_reason text;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month, '') !~ '^\d{4}-\d{2}$' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_member_collection_forbidden';
  end if;
  month_value := to_date(p_month || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(month_value, p_run_key);
  select run_row.id, run_row.state, run_row.abort_reason into run_id, run_state, run_reason
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value
  order by run_row.started_at desc limit 1;
  if run_id is null then
    return jsonb_build_object('state', 'absent', 'month', p_month);
  end if;
  if run_state = 'aborted' and run_reason = 'source_conflict' then
    -- A losing pointer race must not make the cron rebuild a month forever
    -- when an older member run proves the new immutable current pointer.
    -- Schedule/catalog drift is recoverable and deliberately returns absent
    -- below so the frozen source set is captured again.
    select published_run.id into run_id
    from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
    join internal.jiaowubao_completed_lesson_member_runs published_run
      on published_run.period_month = current_pointer.period_month
     and published_run.state = 'published'
     and published_run.final_revision = current_pointer.revision
    where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
      and current_pointer.period_month = month_value
    order by published_run.published_at desc
    limit 1;
    if run_id is null then
      return jsonb_build_object('state', 'absent', 'month', p_month);
    end if;
  elsif run_state = 'aborted' then
    return jsonb_build_object('state', 'absent', 'month', p_month);
  end if;
  return internal.jiaowubao_completed_lesson_member_status(run_id);
end;
$$;
revoke all on function public.get_jiaowubao_completed_lesson_member_collection(text,text,text,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_member_collection(text,text,text,text) to anon, authenticated;

create or replace function public.get_jiaowubao_completed_lesson_pending_month(
  p_secret text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_pending_month_forbidden';
  end if;
  select latest.period_month into month_value
  from (
    select distinct on (run_row.period_month)
      run_row.period_month, run_row.state, run_row.abort_reason, run_row.started_at
    from internal.jiaowubao_completed_lesson_member_runs run_row
    order by run_row.period_month, run_row.started_at desc
  ) latest
  where latest.period_month < date_trunc('month', timezone('Australia/Melbourne', clock_timestamp()))::date
    and (
      latest.state in ('collecting', 'ready')
      or (
        latest.state = 'aborted'
        and (
          latest.abort_reason in ('schedule_changed', 'catalog_changed')
          or not exists (
          select 1
          from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
          join internal.jiaowubao_completed_lesson_member_runs published_run
            on published_run.period_month = current_pointer.period_month
           and published_run.state = 'published'
           and published_run.final_revision = current_pointer.revision
          where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
            and current_pointer.period_month = latest.period_month
          )
        )
      )
    )
  order by latest.started_at, latest.period_month
  limit 1;
  return jsonb_build_object('month', case when month_value is null then null else to_char(month_value, 'YYYY-MM') end);
end;
$$;
revoke all on function public.get_jiaowubao_completed_lesson_pending_month(text,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_pending_month(text,text) to anon, authenticated;

create or replace function public.begin_jiaowubao_completed_lesson_member_collection(
  p_secret text,
  p_month text,
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
  if month_value >= date_trunc('month', timezone('Australia/Melbourne', clock_timestamp()))::date then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_not_closed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lesson-members:' || month_value::text, 0));
  select run_row.id, run_row.state into latest_id, latest_state
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value
  order by run_row.started_at desc
  limit 1
  for update;
  -- All mutating worker RPCs take the run row before the lease row. Keep the
  -- same lock order here so a force refresh cannot deadlock a page stage.
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(month_value, p_run_key);
  if latest_id is not null and latest_state = 'blocked' and not p_force then
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
    id, period_month, state, schedule_revision, schedule_member_set_sha256,
    schedule_member_count, catalog_revision_sha256, catalog_member_count,
    member_set_sha256, member_count,
    expected_current_revision, started_by, begin_audit_id
  ) values (
    run_id, month_value, 'collecting', p_schedule_revision, schedule_sha,
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
revoke all on function public.begin_jiaowubao_completed_lesson_member_collection(text,text,text,text,jsonb,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.begin_jiaowubao_completed_lesson_member_collection(text,text,text,text,jsonb,text,text,boolean,text) to anon, authenticated;

create or replace function public.reserve_jiaowubao_completed_lesson_api_request(
  p_secret text,
  p_month text,
  p_run_key text,
  p_tool text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; now_at timestamptz; slot_at timestamptz; saved internal.jiaowubao_open_api_rate_gate%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_tool is distinct from 'query_lesson_list' or coalesce(p_month, '') !~ '^\d{4}-\d{2}$' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_rate_gate_forbidden';
  end if;
  month_value := to_date(p_month || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(month_value, p_run_key);
  now_at := clock_timestamp();
  insert into internal.jiaowubao_open_api_rate_gate(tool, next_allowed_at)
    values(p_tool, now_at) on conflict(tool) do nothing;
  select * into saved from internal.jiaowubao_open_api_rate_gate gate where gate.tool = p_tool for update;
  -- Re-read the clock after any row-lock wait. Otherwise a queued caller could
  -- reserve a slot in the past and start less than 3.2 seconds after its peer.
  now_at := clock_timestamp();
  slot_at := greatest(now_at, saved.next_allowed_at);
  update internal.jiaowubao_open_api_rate_gate set next_allowed_at = slot_at + interval '3.2 seconds' where tool = p_tool;
  return jsonb_build_object('tool', p_tool, 'notBefore', to_char(slot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;
revoke all on function public.reserve_jiaowubao_completed_lesson_api_request(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.reserve_jiaowubao_completed_lesson_api_request(text,text,text,text,text) to anon, authenticated;

create or replace function public.reserve_jiaowubao_open_api_schedule_request(
  p_secret text,
  p_tool text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare now_at timestamptz; slot_at timestamptz; saved internal.jiaowubao_open_api_rate_gate%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_tool is distinct from 'query_schedule_list' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_rate_gate_forbidden';
  end if;
  now_at := clock_timestamp();
  insert into internal.jiaowubao_open_api_rate_gate(tool, next_allowed_at)
    values(p_tool, now_at) on conflict(tool) do nothing;
  select * into saved from internal.jiaowubao_open_api_rate_gate gate where gate.tool = p_tool for update;
  now_at := clock_timestamp();
  slot_at := greatest(now_at, saved.next_allowed_at);
  update internal.jiaowubao_open_api_rate_gate
    set next_allowed_at = slot_at + interval '3.2 seconds'
    where tool = p_tool;
  return jsonb_build_object('tool', p_tool, 'notBefore', to_char(slot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;
revoke all on function public.reserve_jiaowubao_open_api_schedule_request(text,text,text) from public, anon, authenticated;
grant execute on function public.reserve_jiaowubao_open_api_schedule_request(text,text,text) to anon, authenticated;

create or replace function public.stage_jiaowubao_completed_lesson_member_page(
  p_secret text,
  p_run_id uuid,
  p_run_key text,
  p_member_id bigint,
  p_page integer,
  p_expected_target_version bigint,
  p_source_total integer,
  p_rows jsonb,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  run_state internal.jiaowubao_completed_lesson_member_runs%rowtype;
  target_state internal.jiaowubao_completed_lesson_member_targets%rowtype;
  saved_page internal.jiaowubao_completed_lesson_member_pages%rowtype;
  row_count_value integer;
  expected_rows integer;
  page_hash text;
  is_complete boolean;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_run_id is null or p_member_id is null
     or p_member_id not between 1 and 9007199254740991
     or p_page not between 1 and 60 or p_expected_target_version is null or p_expected_target_version < 0
     or p_source_total not between 0 and 6000
     or p_rows is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 100 or octet_length(p_rows::text) > 2097152 then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_page_invalid';
  end if;
  select * into run_state from internal.jiaowubao_completed_lesson_member_runs run_row where run_row.id = p_run_id for update;
  if not found or run_state.state is distinct from 'collecting' then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_run_not_collecting'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(run_state.period_month, p_run_key);
  row_count_value := jsonb_array_length(p_rows);
  page_hash := 'sha256:' || encode(extensions.digest(p_rows::text, 'sha256'), 'hex');
  select * into saved_page from internal.jiaowubao_completed_lesson_member_pages page_row
    where page_row.run_id = p_run_id and page_row.member_id = p_member_id and page_row.page = p_page;
  if found then
    if saved_page.source_total is distinct from p_source_total or saved_page.rows is distinct from p_rows then
      raise exception using errcode = '23505', message = 'jiaowubao_completed_lesson_member_page_conflict';
    end if;
    return internal.jiaowubao_completed_lesson_member_status(p_run_id);
  end if;
  select * into target_state from internal.jiaowubao_completed_lesson_member_targets target
    where target.run_id = p_run_id and target.member_id = p_member_id for update;
  if not found or target_state.complete or target_state.next_page is distinct from p_page
     or target_state.version is distinct from p_expected_target_version
     or (target_state.expected_total is not null and target_state.expected_total is distinct from p_source_total) then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_cursor_conflict';
  end if;
  if (p_source_total = 0 and p_page <> 1)
     or (p_source_total > 0 and p_page > ceil(p_source_total::numeric / 100)::integer) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_page_invalid';
  end if;
  expected_rows := case when p_source_total = 0 then 0 else least(100, p_source_total - ((p_page - 1) * 100)) end;
  if row_count_value is distinct from expected_rows then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_page_count_conflict'; end if;
  if row_count_value > 0 then
    perform internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows, run_state.period_month);
    if exists (
      select 1 from jsonb_array_elements(p_rows) wrapper
      where wrapper -> 'record' ->> 'memberId' is distinct from p_member_id::text
    ) then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_page_identity_conflict'; end if;
  end if;
  if run_state.row_count + row_count_value > 6000 then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_rows_oversize'; end if;

  insert into internal.jiaowubao_completed_lesson_member_pages(run_id, member_id, page, source_total, row_count, page_sha256, rows)
    values(p_run_id, p_member_id, p_page, p_source_total, row_count_value, page_hash, p_rows);
  insert into internal.jiaowubao_completed_lesson_member_items(run_id, member_id, source_key, canonical_json, item_sha256, item)
  select p_run_id, p_member_id, wrapper ->> 'sourceKey', (wrapper -> 'record')::text,
    'sha256:' || encode(extensions.digest((wrapper -> 'record')::text, 'sha256'), 'hex'), wrapper -> 'record'
  from jsonb_array_elements(p_rows) wrapper;

  is_complete := target_state.collected_count + row_count_value = p_source_total;
  update internal.jiaowubao_completed_lesson_member_targets
  set expected_total = p_source_total,
      collected_count = collected_count + row_count_value,
      next_page = next_page + 1,
      complete = is_complete,
      version = version + 1,
      updated_at = clock_timestamp()
  where run_id = p_run_id and member_id = p_member_id;
  update internal.jiaowubao_completed_lesson_member_runs
  set row_count = row_count + row_count_value,
      completed_member_count = completed_member_count + case when is_complete then 1 else 0 end
  where id = p_run_id;

  if is_complete and run_state.completed_member_count + 1 = run_state.member_count then
    audit_id := internal.append_operational_contract_audit(
      'jiaowubao_completed_lesson_member_collection.ready', p_actor,
      'jiaowubao_completed_lesson_member_run', p_run_id::text,
      jsonb_build_object('month', to_char(run_state.period_month, 'YYYY-MM'),
        'memberCount', run_state.member_count, 'rowCount', run_state.row_count + row_count_value,
        'memberSetSha256', run_state.member_set_sha256)
    );
    update internal.jiaowubao_completed_lesson_member_runs
      set state = 'ready', ready_at = clock_timestamp(), ready_audit_id = audit_id
      where id = p_run_id;
  end if;
  return internal.jiaowubao_completed_lesson_member_status(p_run_id);
end;
$$;
revoke all on function public.stage_jiaowubao_completed_lesson_member_page(text,uuid,text,bigint,integer,bigint,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.stage_jiaowubao_completed_lesson_member_page(text,uuid,text,bigint,integer,bigint,integer,jsonb,text) to anon, authenticated;

create or replace function public.get_jiaowubao_completed_lesson_member_items_page(
  p_secret text,
  p_run_id uuid,
  p_run_key text,
  p_page_index integer,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_member_runs%rowtype; page_count integer; items jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_run_id is null or p_page_index not between 0 and 59 then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_items_page_invalid';
  end if;
  select * into run_state from internal.jiaowubao_completed_lesson_member_runs run_row where run_row.id = p_run_id;
  if not found or run_state.state not in ('ready', 'published') then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_run_not_ready'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(run_state.period_month, p_run_key);
  page_count := case when run_state.row_count = 0 then 0 else ceil(run_state.row_count::numeric / 100)::integer end;
  if (page_count = 0 and p_page_index <> 0) or (page_count > 0 and p_page_index >= page_count) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_member_items_page_invalid';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('sourceKey', item_row.source_key, 'record', item_row.item) order by item_row.source_key), '[]'::jsonb)
    into items
  from (
    select source_key, item from internal.jiaowubao_completed_lesson_member_items
    where run_id = p_run_id order by source_key limit 100 offset p_page_index * 100
  ) item_row;
  return jsonb_build_object('state', run_state.state, 'runId', p_run_id, 'month', to_char(run_state.period_month, 'YYYY-MM'),
    'rowCount', run_state.row_count, 'pageIndex', p_page_index, 'pageCount', page_count, 'items', items);
end;
$$;
revoke all on function public.get_jiaowubao_completed_lesson_member_items_page(text,uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_member_items_page(text,uuid,text,integer,text) to anon, authenticated;

create or replace function public.prepare_jiaowubao_completed_lesson_member_publication(
  p_secret text,
  p_run_id uuid,
  p_run_key text,
  p_revision text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_member_runs%rowtype; catalog jsonb; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_run_id is null or coalesce(p_revision, '') !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_member_publication_forbidden';
  end if;
  select * into run_state from internal.jiaowubao_completed_lesson_member_runs run_row where run_row.id = p_run_id for update;
  if not found or run_state.state is distinct from 'ready' then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_run_not_ready'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(run_state.period_month, p_run_key);
  catalog := internal.jiaowubao_completed_lesson_member_catalog();
  if catalog ->> 'revisionSha256' is distinct from run_state.catalog_revision_sha256
     or (catalog ->> 'memberCount')::integer is distinct from run_state.catalog_member_count then
    audit_id := internal.append_operational_contract_audit(
      'jiaowubao_completed_lesson_member_collection.aborted', p_actor,
      'jiaowubao_completed_lesson_member_run', p_run_id::text,
      jsonb_build_object('month', to_char(run_state.period_month, 'YYYY-MM'),
        'reason', 'catalog_changed', 'completedMemberCount', run_state.completed_member_count,
        'memberCount', run_state.member_count, 'rowCount', run_state.row_count)
    );
    update internal.jiaowubao_completed_lesson_member_runs
      set state = 'aborted', final_revision = null, aborted_at = clock_timestamp(),
          abort_reason = 'catalog_changed', abort_audit_id = audit_id
      where id = p_run_id;
    return internal.jiaowubao_completed_lesson_member_status(p_run_id);
  end if;
  if run_state.final_revision is not null and run_state.final_revision is distinct from p_revision then
    raise exception using errcode = '23505', message = 'jiaowubao_completed_lesson_member_publication_conflict';
  end if;
  update internal.jiaowubao_completed_lesson_member_runs set final_revision = p_revision where id = p_run_id;
  return internal.jiaowubao_completed_lesson_member_status(p_run_id);
end;
$$;
revoke all on function public.prepare_jiaowubao_completed_lesson_member_publication(text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.prepare_jiaowubao_completed_lesson_member_publication(text,uuid,text,text,text) to anon, authenticated;

create or replace function public.complete_jiaowubao_completed_lesson_member_publication(
  p_secret text,
  p_run_id uuid,
  p_run_key text,
  p_revision text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_member_runs%rowtype; current_revision text; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_run_id is null or coalesce(p_revision, '') !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_member_publication_forbidden';
  end if;
  select * into run_state from internal.jiaowubao_completed_lesson_member_runs run_row where run_row.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_member_run_not_found'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(run_state.period_month, p_run_key);
  if run_state.state = 'published' and run_state.final_revision = p_revision then return internal.jiaowubao_completed_lesson_member_status(p_run_id); end if;
  if run_state.state is distinct from 'ready' or run_state.final_revision is distinct from p_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_run_not_ready';
  end if;
  select pointer.revision into current_revision from internal.jiaowubao_completed_lesson_snapshot_current pointer
    where pointer.api_source_key = 'jwb-open-api-completed-lessons' and pointer.period_month = run_state.period_month for update;
  if current_revision is distinct from p_revision then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_publication_pointer_conflict'; end if;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_completed_lesson_member_collection.published', p_actor,
    'jiaowubao_completed_lesson_member_run', p_run_id::text,
    jsonb_build_object('month', to_char(run_state.period_month, 'YYYY-MM'), 'revision', p_revision,
      'memberCount', run_state.member_count, 'rowCount', run_state.row_count)
  );
  update internal.jiaowubao_completed_lesson_member_runs
    set state = 'published', published_at = clock_timestamp(), publish_audit_id = audit_id
    where id = p_run_id;
  return internal.jiaowubao_completed_lesson_member_status(p_run_id);
end;
$$;
revoke all on function public.complete_jiaowubao_completed_lesson_member_publication(text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.complete_jiaowubao_completed_lesson_member_publication(text,uuid,text,text,text) to anon, authenticated;

create or replace function public.abort_jiaowubao_completed_lesson_member_collection(
  p_secret text,
  p_run_id uuid,
  p_run_key text,
  p_reason text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_member_runs%rowtype; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_run_id is null
     or coalesce(p_reason, '') not in ('schedule_changed', 'source_conflict', 'caller_failure', 'catalog_changed') then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_member_abort_forbidden';
  end if;
  select * into run_state from internal.jiaowubao_completed_lesson_member_runs run_row where run_row.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_member_run_not_found'; end if;
  perform internal.assert_jiaowubao_completed_lesson_worker_lease(run_state.period_month, p_run_key);
  if run_state.state in ('aborted', 'blocked') then
    if run_state.abort_reason is not distinct from p_reason
       and run_state.state = (case when p_reason = 'caller_failure' then 'blocked' else 'aborted' end) then
      return internal.jiaowubao_completed_lesson_member_status(p_run_id);
    end if;
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_abort_conflict';
  end if;
  if run_state.state not in ('collecting', 'ready') then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_abort_forbidden'; end if;
  if p_reason = 'caller_failure' and run_state.state is distinct from 'collecting' then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_member_abort_forbidden';
  end if;
  audit_id := internal.append_operational_contract_audit(
    case when p_reason = 'caller_failure'
      then 'jiaowubao_completed_lesson_member_collection.blocked'
      else 'jiaowubao_completed_lesson_member_collection.aborted'
    end, p_actor,
    'jiaowubao_completed_lesson_member_run', p_run_id::text,
    jsonb_build_object('month', to_char(run_state.period_month, 'YYYY-MM'), 'reason', p_reason,
      'completedMemberCount', run_state.completed_member_count, 'memberCount', run_state.member_count,
      'rowCount', run_state.row_count)
  );
  update internal.jiaowubao_completed_lesson_member_runs
    set state = case when p_reason = 'caller_failure' then 'blocked' else 'aborted' end,
        final_revision = null, aborted_at = clock_timestamp(), abort_reason = p_reason, abort_audit_id = audit_id
    where id = p_run_id;
  return internal.jiaowubao_completed_lesson_member_status(p_run_id);
end;
$$;
revoke all on function public.abort_jiaowubao_completed_lesson_member_collection(text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.abort_jiaowubao_completed_lesson_member_collection(text,uuid,text,text,text) to anon, authenticated;

comment on table internal.jiaowubao_completed_lesson_member_runs is
  'Private resumable query_lesson_list(over=1) collection state. Deterministic supplier rejection blocks automatic retry until an explicit manual force refresh; no blocked run changes ops_state or a published month pointer.';
comment on table internal.jiaowubao_completed_lesson_member_targets is
  'Frozen ID-only JWB member roster: current imports, durable native/historical IDs, and completed-month schedule participants.';
comment on table internal.jiaowubao_completed_lesson_member_items is
  'Private allowlisted lesson DTOs, including reconciliation display names. Raw responses and credentials are never stored; browser reads use only the published snapshot projection.';

-- Admin-confirmed Jiaowubao schedule-label mappings.
--
-- Imported Jiaowubao schedule events are immutable source evidence.  This
-- migration deliberately keeps every subsequent teacher/course decision in a
-- separate append-only ledger, keyed to one completed import run plus the
-- complete deterministic digest of the source label pair.  A decision is a
-- readiness overlay only: it never updates an imported event, changes
-- availability_effect, feeds the current_schedule_blocks view, or creates a
-- booking, task, package, operation, settlement, or classroom.

set local lock_timeout = '1s';

-- Keep label matching narrow and deterministic.  The existing normalizer is
-- NFKC + invisible-character removal + whitespace collapse + ASCII case fold;
-- it does not invent course synonyms or fuzzy teacher identities.
create or replace function internal.jiaowubao_direct_schedule_mapping_label_key(p_label text)
returns text
language sql
immutable
strict
set search_path = ''
as $jiaowubao_direct_schedule_mapping_label_key$
  select internal.student_import_name_key(p_label)
$jiaowubao_direct_schedule_mapping_label_key$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_label_key(text)
  from public, anon, authenticated;

-- One candidate represents every source event sharing this exact normalized
-- teacher/course pair in one immutable completed run.  The source evidence
-- hash incorporates the run, revision, labels, count and sorted record hashes
-- so a browser can only reference an opaque, database-recomputed candidate.
create or replace function internal.jiaowubao_direct_schedule_mapping_candidates(
  p_run_id uuid
)
returns table (
  mapping_key text,
  source_revision text,
  source_evidence_sha256 text,
  teacher_label_key text,
  course_label_key text,
  teacher_label text,
  course_label text,
  event_count integer
)
language sql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_candidates$
  with completed_run as materialized (
    select run_state.id, run_state.revision
    from internal.jiaowubao_direct_import_runs run_state
    where run_state.id = p_run_id
      and run_state.state = 'complete'
  ), source_rows as materialized (
    select
      completed_run.id as run_id,
      completed_run.revision as source_revision,
      internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.teacher_display_name) as teacher_label_key,
      internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.course_name) as course_label_key,
      schedule_event.teacher_display_name as teacher_label,
      schedule_event.course_name as course_label,
      schedule_event.record_sha256
    from completed_run
    join internal.jiaowubao_direct_schedule_events schedule_event
      on schedule_event.run_id = completed_run.id
    where internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.teacher_display_name) <> ''
      and internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.course_name) <> ''
  ), grouped as materialized (
    select
      source_rows.run_id,
      source_rows.source_revision,
      source_rows.teacher_label_key,
      source_rows.course_label_key,
      min(source_rows.teacher_label) as teacher_label,
      min(source_rows.course_label) as course_label,
      count(*)::integer as event_count,
      string_agg(source_rows.record_sha256, ',' order by source_rows.record_sha256) as source_hash_material
    from source_rows
    group by
      source_rows.run_id,
      source_rows.source_revision,
      source_rows.teacher_label_key,
      source_rows.course_label_key
  ), evidenced as materialized (
    select
      grouped.*,
      encode(extensions.digest(convert_to(
        'jiaowubao-direct-schedule-label-pair-v1' || chr(31)
          || grouped.run_id::text || chr(31)
          || grouped.source_revision || chr(31)
          || grouped.teacher_label_key || chr(31)
          || grouped.course_label_key || chr(31)
          || grouped.event_count::text || chr(31)
          || grouped.source_hash_material,
        'UTF8'
      ), 'sha256'), 'hex') as source_evidence_sha256
    from grouped
  )
  select
    'sha256:' || encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-label-mapping-candidate-v1' || chr(31)
        || evidenced.run_id::text || chr(31)
        || evidenced.source_revision || chr(31)
        || evidenced.teacher_label_key || chr(31)
        || evidenced.course_label_key || chr(31)
        || evidenced.source_evidence_sha256,
      'UTF8'
    ), 'sha256'), 'hex') as mapping_key,
    evidenced.source_revision,
    evidenced.source_evidence_sha256,
    evidenced.teacher_label_key,
    evidenced.course_label_key,
    evidenced.teacher_label,
    evidenced.course_label,
    evidenced.event_count
  from evidenced
$jiaowubao_direct_schedule_mapping_candidates$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_candidates(uuid)
  from public, anon, authenticated;

-- The reviewed target catalog has a deliberately small shape.  A malformed
-- teacher record, blank/duplicate subject or non-array subjects value fails
-- the mapping read/confirmation closed instead of silently weakening subject
-- validation.
create or replace function internal.jiaowubao_direct_schedule_mapping_teacher_catalog(
  p_teachers jsonb
)
returns table (
  teacher_id text,
  teacher_name text,
  subject_ids text[],
  target_basis_sha256 text
)
language plpgsql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_teacher_catalog$
declare
  -- Keep the server DTO within the independently fail-closed browser parser
  -- limits. A teacher import permits a larger authority document, but that
  -- must not turn this focused mapping reader into an unbounded catalog API.
  max_teachers constant integer := 512;
  max_subjects_per_teacher constant integer := 120;
  teacher_value jsonb;
  subject_value jsonb;
  subject_count integer;
  distinct_subject_count integer;
  canonical_subjects text[];
begin
  if jsonb_typeof(p_teachers) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_unavailable';
  end if;
  if jsonb_array_length(p_teachers) > max_teachers then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teacher_catalog_too_large';
  end if;

  for teacher_value in
    select item.value
    from jsonb_array_elements(p_teachers) item(value)
  loop
    if jsonb_typeof(teacher_value) <> 'object'
       or nullif(btrim(teacher_value ->> 'id'), '') is null
       or teacher_value ->> 'id' <> btrim(teacher_value ->> 'id')
       or char_length(teacher_value ->> 'id') > 240
       or nullif(btrim(teacher_value ->> 'name'), '') is null
       or teacher_value ->> 'name' <> btrim(teacher_value ->> 'name')
       or char_length(teacher_value ->> 'name') > 240
       or jsonb_typeof(teacher_value -> 'subjects') <> 'array' then
      raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
    end if;
    if jsonb_array_length(teacher_value -> 'subjects') > max_subjects_per_teacher then
      raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teacher_subject_catalog_too_large';
    end if;

    for subject_value in
      select item.value
      from jsonb_array_elements(teacher_value -> 'subjects') item(value)
    loop
      if jsonb_typeof(subject_value) <> 'string'
         or nullif(btrim(subject_value #>> '{}'), '') is null
         or subject_value #>> '{}' <> btrim(subject_value #>> '{}')
         or char_length(subject_value #>> '{}') > 240 then
        raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
      end if;
    end loop;

    select
      coalesce(array_agg(item.value #>> '{}' order by item.value #>> '{}'), ARRAY[]::text[]),
      count(*)::integer,
      count(distinct item.value #>> '{}')::integer
    into canonical_subjects, subject_count, distinct_subject_count
    from jsonb_array_elements(teacher_value -> 'subjects') item(value);

    if subject_count <> distinct_subject_count then
      raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
    end if;

    teacher_id := teacher_value ->> 'id';
    teacher_name := teacher_value ->> 'name';
    subject_ids := canonical_subjects;
    target_basis_sha256 := encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-mapping-target-v1' || chr(31)
        || teacher_id || chr(31)
        || teacher_name || chr(31)
        || array_to_string(subject_ids, chr(31)),
      'UTF8'
    ), 'sha256'), 'hex');
    return next;
  end loop;
end;
$jiaowubao_direct_schedule_mapping_teacher_catalog$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb)
  from public, anon, authenticated;

create table if not exists internal.jiaowubao_direct_schedule_label_mapping_decisions (
  id uuid primary key default gen_random_uuid(),
  -- `now()` is transaction-scoped in PostgreSQL, so it cannot safely order
  -- several append-only commands executed in one transaction (as in the
  -- rollback fixture). Keep a durable insertion order separate from audit
  -- time; it is never exposed to the browser.
  decision_sequence bigint generated always as identity unique,
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  mapping_key text not null check (mapping_key ~ '^sha256:[a-f0-9]{64}$'),
  source_revision text not null check (
    source_revision = btrim(source_revision) and char_length(source_revision) between 1 and 240
  ),
  source_evidence_sha256 text not null check (source_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  teacher_label_key text not null check (
    teacher_label_key = btrim(teacher_label_key) and char_length(teacher_label_key) between 1 and 500
  ),
  course_label_key text not null check (
    course_label_key = btrim(course_label_key) and char_length(course_label_key) between 1 and 500
  ),
  source_event_count integer not null check (source_event_count between 1 and 200000),
  decision text not null check (decision in ('confirmed', 'revoked')),
  target_teacher_id text,
  target_subject_id text,
  teachers_version bigint not null check (teachers_version >= 0),
  target_basis_sha256 text,
  supersedes_decision_id uuid references internal.jiaowubao_direct_schedule_label_mapping_decisions(id) on delete restrict,
  command_key uuid not null unique,
  decided_by text not null check (decided_by = btrim(decided_by) and char_length(decided_by) between 1 and 120),
  decided_at timestamptz not null default now(),
  audit_id uuid not null unique references internal.operational_contract_audit(id),
  check (
    (decision = 'confirmed'
      and target_teacher_id is not null and target_teacher_id = btrim(target_teacher_id)
      and char_length(target_teacher_id) between 1 and 240
      and target_subject_id is not null and target_subject_id = btrim(target_subject_id)
      and char_length(target_subject_id) between 1 and 240
      and target_basis_sha256 ~ '^[a-f0-9]{64}$')
    or (decision = 'revoked'
      and target_teacher_id is null and target_subject_id is null and target_basis_sha256 is null)
  )
);

alter table internal.jiaowubao_direct_schedule_label_mapping_decisions enable row level security;
revoke all on table internal.jiaowubao_direct_schedule_label_mapping_decisions from public, anon, authenticated;

create index if not exists jiaowubao_direct_schedule_mapping_decisions_latest_idx
  on internal.jiaowubao_direct_schedule_label_mapping_decisions (run_id, mapping_key, decision_sequence desc);

-- The ledger is append-only.  The source group must still recompute exactly
-- from one completed immutable run, and any supersession must stay within the
-- same provenance group.  This makes direct SQL writes fail closed too.
create or replace function internal.jiaowubao_direct_schedule_mapping_decision_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_decision_guard$
declare
  prior internal.jiaowubao_direct_schedule_label_mapping_decisions%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_decisions_append_only';
  end if;

  if not exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_candidates(new.run_id) candidate
    where candidate.mapping_key = new.mapping_key
      and candidate.source_revision = new.source_revision
      and candidate.source_evidence_sha256 = new.source_evidence_sha256
      and candidate.teacher_label_key = new.teacher_label_key
      and candidate.course_label_key = new.course_label_key
      and candidate.event_count = new.source_event_count
  ) then
    raise exception using errcode = '23503', message = 'jiaowubao_schedule_mapping_candidate_unavailable';
  end if;

  if new.supersedes_decision_id is not null then
    select * into prior
    from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
    where decision_row.id = new.supersedes_decision_id
    for key share;
    if not found
       or prior.run_id <> new.run_id
       or prior.mapping_key <> new.mapping_key
       or prior.source_evidence_sha256 <> new.source_evidence_sha256 then
      raise exception using errcode = '23503', message = 'jiaowubao_schedule_mapping_supersession_invalid';
    end if;
  end if;

  return new;
end;
$jiaowubao_direct_schedule_mapping_decision_guard$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_decision_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_schedule_mapping_decision_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_label_mapping_decisions
for each row execute function internal.jiaowubao_direct_schedule_mapping_decision_guard();

-- Admin-only candidate reader. It exposes only an opaque candidate key and
-- the minimally necessary source labels/counts; no event UUID, source row,
-- workbook coordinate, record hash, raw payload, student identity or phone is
-- returned. The cursor is a previously-issued opaque candidate key.
create or replace function public.get_jiaowubao_direct_schedule_mapping_review(
  p_secret text,
  p_limit integer default 80,
  p_after_mapping_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_direct_schedule_mapping_review$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  teachers_state public.ops_state%rowtype;
  teacher_count integer;
  distinct_teacher_count integer;
  total_count integer := 0;
  unmapped_count integer := 0;
  confirmed_count integer := 0;
  revoked_count integer := 0;
  authority_changed_count integer := 0;
  candidates jsonb := '[]'::jsonb;
  teacher_catalog jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor text := null;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_limit is null or p_limit not between 1 and 120
     or (p_after_mapping_key is not null and p_after_mapping_key !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_schedule_mapping_review';
  end if;

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;

  if saved_run.id is null then
    return jsonb_build_object(
      'state', 'absent',
      'runToken', null,
      'teachersVersion', null,
      'teachers', '[]'::jsonb,
      'summary', jsonb_build_object(
        'total', 0, 'unmapped', 0, 'confirmed', 0, 'revoked', 0, 'authorityChanged', 0
      ),
      'candidates', '[]'::jsonb,
      'nextCursor', null
    );
  end if;

  select * into teachers_state
  from public.ops_state state_row
  where state_row.entity = 'teachers';
  if teachers_state.entity is null
     or teachers_state.version < 0
     or jsonb_typeof(teachers_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_unavailable';
  end if;

  select count(*), count(distinct catalog.teacher_id)
  into teacher_count, distinct_teacher_count
  from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload) catalog;
  if teacher_count <> distinct_teacher_count then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', catalog.teacher_id,
    'name', catalog.teacher_name,
    'subjectIds', to_jsonb(catalog.subject_ids)
  ) order by catalog.teacher_name collate "C", catalog.teacher_id), '[]'::jsonb)
  into teacher_catalog
  from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload) catalog;

  if p_after_mapping_key is not null and not exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_candidates(saved_run.id) candidate
    where candidate.mapping_key = p_after_mapping_key
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_mapping_cursor_invalid';
  end if;

  with source_candidates as materialized (
    select *
    from internal.jiaowubao_direct_schedule_mapping_candidates(saved_run.id)
  ), teacher_catalog_current as materialized (
    select *
    from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload)
  ), latest_decisions as materialized (
    select distinct on (decision_row.mapping_key)
      decision_row.*
    from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
    where decision_row.run_id = saved_run.id
    order by decision_row.mapping_key, decision_row.decision_sequence desc
  ), classified as materialized (
    select
      candidate.*,
      decision_row.id as decision_id,
      decision_row.decision,
      decision_row.target_teacher_id,
      decision_row.target_subject_id,
      decision_row.decided_at,
      target_catalog.teacher_name as target_teacher_name,
      case
        when decision_row.id is null then 'unmapped'
        when decision_row.decision = 'revoked' then 'revoked'
        when target_catalog.teacher_id is not null
          and decision_row.target_subject_id = any(target_catalog.subject_ids)
          and decision_row.target_basis_sha256 = target_catalog.target_basis_sha256
          then 'confirmed'
        else 'authority_changed'
      end as mapping_status
    from source_candidates candidate
    left join latest_decisions decision_row
      on decision_row.mapping_key = candidate.mapping_key
      and decision_row.source_evidence_sha256 = candidate.source_evidence_sha256
      and decision_row.source_revision = candidate.source_revision
    left join teacher_catalog_current target_catalog
      on target_catalog.teacher_id = decision_row.target_teacher_id
  ), page_plus_one as materialized (
    select *
    from classified
    where p_after_mapping_key is null or mapping_key > p_after_mapping_key
    order by mapping_key
    limit p_limit + 1
  ), page as materialized (
    select * from page_plus_one limit p_limit
  )
  select
    (select count(*)::integer from classified),
    (select count(*) filter (where mapping_status = 'unmapped')::integer from classified),
    (select count(*) filter (where mapping_status = 'confirmed')::integer from classified),
    (select count(*) filter (where mapping_status = 'revoked')::integer from classified),
    (select count(*) filter (where mapping_status = 'authority_changed')::integer from classified),
    coalesce(jsonb_agg(jsonb_build_object(
      'mappingKey', page.mapping_key,
      'teacherLabel', page.teacher_label,
      'courseLabel', page.course_label,
      'eventCount', page.event_count,
      'status', page.mapping_status,
      'targetTeacherId', page.target_teacher_id,
      'targetTeacherName', page.target_teacher_name,
      'targetSubjectId', page.target_subject_id,
      'decidedAt', case when page.decision_id is null then null
        else to_char(page.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
    ) order by page.mapping_key), '[]'::jsonb),
    (select count(*) > p_limit from page_plus_one),
    (select case when count(*) > p_limit then max(mapping_key) filter (where row_number <= p_limit) end
      from (
        select mapping_key, row_number() over (order by mapping_key) as row_number
        from page_plus_one
      ) cursor_rows)
  into
    total_count,
    unmapped_count,
    confirmed_count,
    revoked_count,
    authority_changed_count,
    candidates,
    has_more,
    next_cursor
  from page;

  return jsonb_build_object(
    'state', 'complete',
    'runToken', saved_run.id::text,
    'teachersVersion', teachers_state.version,
    'teachers', teacher_catalog,
    'summary', jsonb_build_object(
      'total', total_count,
      'unmapped', unmapped_count,
      'confirmed', confirmed_count,
      'revoked', revoked_count,
      'authorityChanged', authority_changed_count
    ),
    'candidates', candidates,
    'nextCursor', case when has_more then next_cursor else null end
  );
end;
$get_jiaowubao_direct_schedule_mapping_review$;

-- One atomic, replay-safe admin decision. The browser can submit only the
-- opaque candidate key, a UUID command key, action and exact current target
-- IDs. The database recomputes the source candidate and locks the current
-- teacher authority before it writes an append-only confirmation/revocation.
create or replace function public.put_jiaowubao_direct_schedule_label_mapping(
  p_secret text,
  p_mapping_key text,
  p_command_key uuid,
  p_action text,
  p_target_teacher_id text,
  p_target_subject_id text,
  p_expected_teachers_version bigint,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $put_jiaowubao_direct_schedule_label_mapping$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  teachers_state public.ops_state%rowtype;
  candidate record;
  prior_command internal.jiaowubao_direct_schedule_label_mapping_decisions%rowtype;
  prior_decision internal.jiaowubao_direct_schedule_label_mapping_decisions%rowtype;
  target_catalog record;
  matching_teacher_count integer;
  audit_entry_id uuid;
  next_decision_id uuid;
  logical_unchanged boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_mapping_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_command_key is null
     or p_action not in ('confirm', 'revoke')
     or p_expected_teachers_version is null or p_expected_teachers_version < 0
     or p_actor not in ('Nixon', 'Ops Admin')
     or (p_action = 'confirm' and (
       nullif(btrim(p_target_teacher_id), '') is null
       or p_target_teacher_id <> btrim(p_target_teacher_id)
       or char_length(p_target_teacher_id) > 240
       or nullif(btrim(p_target_subject_id), '') is null
       or p_target_subject_id <> btrim(p_target_subject_id)
       or char_length(p_target_subject_id) > 240
     ))
     or (p_action = 'revoke' and (p_target_teacher_id is not null or p_target_subject_id is not null)) then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_schedule_mapping_command';
  end if;

  -- This short lock makes "latest completed run" stable through the decision;
  -- it never touches source rows and conflicts only with a concurrent import
  -- stage that must itself wait rather than mixing source authority.
  lock table internal.jiaowubao_direct_import_runs in share mode;
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;
  if saved_run.id is null then
    raise exception using errcode = '23503', message = 'jiaowubao_schedule_mapping_run_unavailable';
  end if;

  select * into candidate
  from internal.jiaowubao_direct_schedule_mapping_candidates(saved_run.id) candidate_row
  where candidate_row.mapping_key = p_mapping_key;
  if not found then
    raise exception using errcode = '23503', message = 'jiaowubao_schedule_mapping_candidate_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao_direct_schedule_mapping:' || p_mapping_key, 0)
  );

  select * into prior_command
  from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
  where decision_row.command_key = p_command_key
  for update;
  if found then
    if prior_command.mapping_key <> p_mapping_key
       or prior_command.decision <> (case when p_action = 'confirm' then 'confirmed' else 'revoked' end)
       or prior_command.target_teacher_id is distinct from p_target_teacher_id
       or prior_command.target_subject_id is distinct from p_target_subject_id
       or prior_command.teachers_version <> p_expected_teachers_version
       or prior_command.run_id <> saved_run.id then
      raise exception using errcode = '23505', message = 'jiaowubao_schedule_mapping_command_conflict';
    end if;
    return jsonb_build_object(
      'mappingKey', prior_command.mapping_key,
      'action', case prior_command.decision when 'confirmed' then 'confirm' else 'revoke' end,
      'targetTeacherId', prior_command.target_teacher_id,
      'targetSubjectId', prior_command.target_subject_id,
      'teachersVersion', prior_command.teachers_version,
      'unchanged', true
    );
  end if;

  select * into teachers_state
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for update;
  if teachers_state.entity is null
     or teachers_state.version < 0
     or jsonb_typeof(teachers_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_unavailable';
  end if;
  if teachers_state.version <> p_expected_teachers_version then
    raise exception using errcode = '40001', message = 'jiaowubao_schedule_mapping_teachers_authority_changed';
  end if;

  select count(*) into matching_teacher_count
  from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload) catalog
  where catalog.teacher_id = p_target_teacher_id;
  if p_action = 'confirm' and matching_teacher_count <> 1 then
    raise exception using errcode = '23503', message = 'jiaowubao_schedule_mapping_target_teacher_unavailable';
  end if;
  if p_action = 'confirm' then
    select * into target_catalog
    from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload) catalog
    where catalog.teacher_id = p_target_teacher_id
      and p_target_subject_id = any(catalog.subject_ids);
    if not found then
      raise exception using errcode = '23503', message = 'jiaowubao_schedule_mapping_target_subject_unavailable';
    end if;
  end if;

  select * into prior_decision
  from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
  where decision_row.run_id = saved_run.id
    and decision_row.mapping_key = p_mapping_key
  order by decision_row.decision_sequence desc
  limit 1
  for update;

  -- Every first-seen command key receives an append-only receipt, including a
  -- logical no-op. Otherwise a lost successful response could leave a UUID
  -- reusable for a later, different state. The unique command_key then makes
  -- retries replay-safe without mutating the source evidence or authority.
  logical_unchanged := (p_action = 'revoke'
    and (prior_decision.id is null or prior_decision.decision = 'revoked'))
    or (p_action = 'confirm'
      and prior_decision.id is not null
      and prior_decision.decision = 'confirmed'
      and prior_decision.target_teacher_id = p_target_teacher_id
      and prior_decision.target_subject_id = p_target_subject_id
      and prior_decision.target_basis_sha256 = target_catalog.target_basis_sha256);

  audit_entry_id := internal.append_operational_contract_audit(
    case when p_action = 'confirm'
      then 'jiaowubao.schedule_label_mapping_confirmed'
      else 'jiaowubao.schedule_label_mapping_revoked'
    end,
    left(trim(p_actor), 120),
    'jiaowubao_direct_schedule_label_mapping',
    p_mapping_key,
    jsonb_build_object(
      'mappingKey', p_mapping_key,
      'runIdSha256', encode(extensions.digest(convert_to(saved_run.id::text, 'UTF8'), 'sha256'), 'hex'),
      'sourceRevisionSha256', encode(extensions.digest(convert_to(candidate.source_revision, 'UTF8'), 'sha256'), 'hex'),
      'sourceEvidenceSha256', candidate.source_evidence_sha256,
      'sourceEventCount', candidate.event_count,
      'action', p_action,
      'targetTeacherId', case when p_action = 'confirm' then p_target_teacher_id else null end,
      'targetSubjectId', case when p_action = 'confirm' then p_target_subject_id else null end,
      'teachersVersion', teachers_state.version,
      'targetBasisSha256', case when p_action = 'confirm' then target_catalog.target_basis_sha256 else null end,
      'stateUnchanged', logical_unchanged
    )
  );

  insert into internal.jiaowubao_direct_schedule_label_mapping_decisions (
    run_id, mapping_key, source_revision, source_evidence_sha256,
    teacher_label_key, course_label_key, source_event_count,
    decision, target_teacher_id, target_subject_id, teachers_version, target_basis_sha256,
    supersedes_decision_id, command_key, decided_by, audit_id
  ) values (
    saved_run.id, p_mapping_key, candidate.source_revision, candidate.source_evidence_sha256,
    candidate.teacher_label_key, candidate.course_label_key, candidate.event_count,
    case when p_action = 'confirm' then 'confirmed' else 'revoked' end,
    case when p_action = 'confirm' then p_target_teacher_id else null end,
    case when p_action = 'confirm' then p_target_subject_id else null end,
    teachers_state.version,
    case when p_action = 'confirm' then target_catalog.target_basis_sha256 else null end,
    prior_decision.id,
    p_command_key,
    left(trim(p_actor), 120),
    audit_entry_id
  ) returning id into next_decision_id;

  return jsonb_build_object(
    'mappingKey', p_mapping_key,
    'action', p_action,
    'targetTeacherId', case when p_action = 'confirm' then p_target_teacher_id else null end,
    'targetSubjectId', case when p_action = 'confirm' then p_target_subject_id else null end,
    'teachersVersion', teachers_state.version,
    'unchanged', logical_unchanged
  );
end;
$put_jiaowubao_direct_schedule_label_mapping$;

revoke all on function public.get_jiaowubao_direct_schedule_mapping_review(text, integer, text)
  from public, anon, authenticated;
revoke all on function public.put_jiaowubao_direct_schedule_label_mapping(text, text, uuid, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_direct_schedule_mapping_review(text, integer, text)
  to anon, authenticated;
grant execute on function public.put_jiaowubao_direct_schedule_label_mapping(text, text, uuid, text, text, text, bigint, text)
  to anon, authenticated;

-- Candidate grouping is always run-scoped and label-pair based.  It is not an
-- AVA/booking index and no existing source or capacity view is altered.
create index if not exists jiaowubao_direct_schedule_mapping_candidate_idx
  on internal.jiaowubao_direct_schedule_events (
    run_id,
    internal.jiaowubao_direct_schedule_mapping_label_key(teacher_display_name),
    internal.jiaowubao_direct_schedule_mapping_label_key(course_name)
  )
  where teacher_display_name is not null and course_name is not null;

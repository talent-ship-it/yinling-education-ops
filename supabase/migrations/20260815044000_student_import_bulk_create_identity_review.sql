-- Atomically confirm the complete current set of exact, unique-Han matches
-- that require a new deterministic formal identity. This contract is
-- create-only: it excludes every key with a current same-name student and
-- never accepts names, source rows, student IDs or decisions from a client.

create or replace function internal.student_import_identity_bulk_create_candidates(
  p_master_source_id text,
  p_master_revision text,
  p_master_rows jsonb,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_jwb_rows jsonb,
  p_students_version bigint,
  p_review_epoch bigint,
  p_students jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  create_candidates jsonb;
begin
  if nullif(trim(p_master_source_id), '') is null
     or length(p_master_source_id) > 160
     or nullif(trim(p_master_revision), '') is null
     or length(p_master_revision) > 240
     or nullif(trim(p_jwb_source_id), '') is null
     or length(p_jwb_source_id) > 160
     or nullif(trim(p_jwb_revision), '') is null
     or length(p_jwb_revision) > 240
     or p_students_version is null
     or p_students_version < 0
     or p_students_version > 9007199254740991
     or p_review_epoch is null
     or p_review_epoch < 0
     or p_review_epoch > 9007199254740991
     or jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_students) <> 'array'
     or jsonb_array_length(p_master_rows) > 10000
     or jsonb_array_length(p_jwb_rows) > 10000
     or jsonb_array_length(p_students) > 10000 then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_create_candidate_input';
  end if;

  if exists (
      select 1 from jsonb_array_elements(p_master_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_master_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_master_rows) item(value))
    or exists (
      select 1 from jsonb_array_elements(p_jwb_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_jwb_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_jwb_rows) item(value))
    or exists (
      select 1 from jsonb_array_elements(p_students) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or jsonb_typeof(item.value -> 'id') <> 'string'
        or nullif(item.value ->> 'id', '') is null
        or item.value ->> 'id' <> trim(item.value ->> 'id')
        or length(item.value ->> 'id') > 240
    )
    or (select count(*) from jsonb_array_elements(p_students)) <>
      (select count(distinct item.value ->> 'id')
       from jsonb_array_elements(p_students) item(value)) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_create_candidate_rows';
  end if;

  -- Every normalised key and every deterministic identity is computed once.
  -- Master uniqueness is global across resolved rows; ownership is global
  -- across every current non-archived master status, including the one status
  -- that does not itself require a JWB identity link.
  with master_raw as materialized (
    select item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_master_review_name_key(item.value ->> 'name') as review_key,
      trim(coalesce(item.value ->> 'status', '')) as status
    from jsonb_array_elements(p_master_rows) item(value)
  ), master_basis as materialized (
    select master_raw.*,
      count(*) over (partition by review_key) as review_key_count
    from master_raw
  ), active_master as materialized (
    select master_basis.*,
      internal.student_import_student_id(
        p_master_source_id, master_basis.source_row
      ) as derived_student_id
    from master_basis
    where status in (
      '在读', '活跃 + 无课时', '活跃 + 有课时',
      '不活跃 + 有课时', '在读 + 加课待排'
    )
  ), owner_basis as materialized (
    select active_master.*,
      count(*) over (partition by derived_student_id) as derived_owner_count
    from active_master
  ), required_master as materialized (
    select * from owner_basis
    where review_key <> ''
      and review_key_count = 1
      and status in (
        '在读', '活跃 + 有课时', '不活跃 + 有课时', '在读 + 加课待排'
      )
      and derived_owner_count = 1
      and nullif(derived_student_id, '') is not null
      and length(derived_student_id) <= 240
  ), jwb_raw as materialized (
    select item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_master_review_name_key(item.value ->> 'name') as review_key
    from jsonb_array_elements(p_jwb_rows) item(value)
  ), jwb_basis as materialized (
    select jwb_raw.*,
      count(*) over (partition by review_key) as review_key_count
    from jwb_raw
  ), unique_jwb as materialized (
    select * from jwb_basis
    where review_key <> '' and review_key_count = 1
  ), student_raw as materialized (
    select item.value ->> 'id' as student_id,
      internal.student_import_master_review_name_key(item.value ->> 'name') as review_key
    from jsonb_array_elements(p_students) item(value)
  ), student_review_counts as materialized (
    select review_key, count(*)::integer as existing_key_count
    from student_raw
    where review_key <> ''
    group by review_key
  ), student_ids as materialized (
    select student_id from student_raw
  ), paired as materialized (
    select master.source_row as master_source_row,
      master.source_key as master_source_key,
      master.review_key,
      master.derived_student_id,
      jwb.source_row as jwb_source_row,
      jwb.source_key as jwb_source_key,
      coalesce(existing.existing_key_count, 0) as existing_key_count
    from required_master master
    join unique_jwb jwb using (review_key)
    left join student_review_counts existing using (review_key)
  ), safe_creates as materialized (
    select paired.*
    from paired
    where paired.existing_key_count = 0
      and not exists (
        select 1 from student_ids current_student
        where current_student.student_id = paired.derived_student_id
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'masterSourceRow', safe_creates.master_source_row,
    'jwbSourceRow', safe_creates.jwb_source_row,
    'studentId', safe_creates.derived_student_id
  ) order by
    internal.student_import_utf16_sort_key(safe_creates.master_source_key),
    internal.student_import_utf16_sort_key(safe_creates.jwb_source_key),
    internal.student_import_utf16_sort_key(safe_creates.derived_student_id)
  ), '[]'::jsonb)
  into create_candidates
  from safe_creates;

  if jsonb_array_length(create_candidates) <>
       (select count(distinct internal.student_import_source_key(
          item.value -> 'masterSourceRow'))
        from jsonb_array_elements(create_candidates) item(value))
     or jsonb_array_length(create_candidates) <>
       (select count(distinct internal.student_import_source_key(
          item.value -> 'jwbSourceRow'))
        from jsonb_array_elements(create_candidates) item(value))
     or jsonb_array_length(create_candidates) <>
       (select count(distinct trim(item.value ->> 'studentId'))
        from jsonb_array_elements(create_candidates) item(value)) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_bulk_create_review_candidate_conflict';
  end if;

  return create_candidates;
end;
$$;

revoke all on function internal.student_import_identity_bulk_create_candidates(
  text, text, jsonb, text, text, jsonb, bigint, bigint, jsonb
) from public, anon, authenticated;

-- The 430 migration's triple planner is intentionally decision-agnostic: it
-- canonicalises full master/JWB/student triples, preserves exact replays, and
-- rejects any partial reuse. Wrap it so this workflow has independent count
-- names and a create-specific plan fingerprint.
create or replace function internal.student_import_identity_bulk_create_plan(
  p_create_candidates jsonb,
  p_active_links jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  triple_plan jsonb;
  create_plan_fingerprint text;
begin
  triple_plan := internal.student_import_identity_bulk_merge_plan(
    p_create_candidates, p_active_links
  );
  create_plan_fingerprint := 'sha256:' || encode(extensions.digest(
    jsonb_build_object(
      'contract', 'student-import-identity-bulk-create-plan-v1',
      'triplePlanFingerprint', triple_plan ->> 'planFingerprint'
    )::text,
    'sha256'
  ), 'hex');

  return jsonb_build_object(
    'createCandidateCount', (triple_plan ->> 'mergeCandidateCount')::integer,
    'pendingCreateCount', (triple_plan ->> 'pendingMergeCount')::integer,
    'alreadyLinkedCreateCount',
      (triple_plan ->> 'alreadyLinkedMergeCount')::integer,
    'currentLinkCount', (triple_plan ->> 'currentLinkCount')::integer,
    'resultingLinkCount', (triple_plan ->> 'resultingLinkCount')::integer,
    'combinedLinks', triple_plan -> 'combinedLinks',
    'planFingerprint', create_plan_fingerprint
  );
end;
$$;

create or replace function internal.student_import_identity_bulk_create_review_key(
  p_master_source_id text,
  p_master_revision text,
  p_master_rows_sha256 text,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_jwb_rows_sha256 text,
  p_students_version bigint,
  p_review_epoch bigint,
  p_active_link_fingerprint text,
  p_duplicate_resolution_fingerprint text,
  p_plan_fingerprint text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'contract', 'student-import-identity-bulk-create-review-v1',
    'master', jsonb_build_object(
      'sourceId', p_master_source_id,
      'revision', p_master_revision,
      'rowsSha256', p_master_rows_sha256
    ),
    'jwb', jsonb_build_object(
      'sourceId', p_jwb_source_id,
      'revision', p_jwb_revision,
      'rowsSha256', p_jwb_rows_sha256
    ),
    'studentsVersion', p_students_version,
    'reviewEpoch', p_review_epoch,
    'activeLinkFingerprint', p_active_link_fingerprint,
    'duplicateResolutionFingerprint', p_duplicate_resolution_fingerprint,
    'planFingerprint', p_plan_fingerprint
  )::text, 'sha256'), 'hex')
$$;

revoke all on function internal.student_import_identity_bulk_create_plan(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_identity_bulk_create_review_key(
  text, text, text, text, text, text, bigint, bigint, text, text, text
) from public, anon, authenticated;

create or replace function public.get_student_import_identity_bulk_create_review_preview(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  create_candidates jsonb;
  create_plan jsonb;
  confirmation_key text;
  review_epoch bigint;
  saved_matches_current boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into jwb from internal.student_import_source_rows source_state
    where source_state.source_kind = 'jwb';
  select * into master from internal.student_import_source_rows source_state
    where source_state.source_kind = 'master';
  select * into saved from internal.student_import_identity_link_sets identity_state
    where identity_state.singleton;
  select * into students_state from public.ops_state state_row
    where state_row.entity = 'students';

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or students_state.version < 0
     or students_state.version > 9007199254740991 then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;

  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_create_review_linkset_invalid';
  end if;

  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  create_candidates := internal.student_import_identity_bulk_create_candidates(
    master.source_id, master.revision, resolved_master_rows,
    jwb.source_id, jwb.revision, jwb.rows,
    students_state.version, review_epoch, students_state.payload
  );
  create_plan := internal.student_import_identity_bulk_create_plan(
    create_candidates, active_links
  );
  confirmation_key := internal.student_import_identity_bulk_create_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', create_plan ->> 'planFingerprint'
  );

  return jsonb_build_object(
    'confirmationKey', confirmation_key,
    'createCandidateCount', (create_plan ->> 'createCandidateCount')::integer,
    'pendingCreateCount', (create_plan ->> 'pendingCreateCount')::integer,
    'alreadyLinkedCreateCount',
      (create_plan ->> 'alreadyLinkedCreateCount')::integer,
    'currentLinkCount', (create_plan ->> 'currentLinkCount')::integer,
    'resultingLinkCount', (create_plan ->> 'resultingLinkCount')::integer,
    'canSubmit', (create_plan ->> 'pendingCreateCount')::integer > 0
  );
end;
$$;

revoke all on function public.get_student_import_identity_bulk_create_review_preview(text)
  from public, anon, authenticated;
grant execute on function public.get_student_import_identity_bulk_create_review_preview(text)
  to anon, authenticated;

-- Immutable replay evidence makes a lost HTTP response recoverable without a
-- second audit and prevents an old create key from being accepted after drift.
create table if not exists internal.student_import_identity_bulk_create_review_commands (
  confirmation_key text primary key
    check (confirmation_key ~ '^sha256:[a-f0-9]{64}$'),
  master_source_id text not null check (length(master_source_id) between 1 and 160),
  master_revision text not null check (length(master_revision) between 1 and 240),
  master_rows_sha256 text not null check (master_rows_sha256 ~ '^[a-f0-9]{64}$'),
  jwb_source_id text not null check (length(jwb_source_id) between 1 and 160),
  jwb_revision text not null check (length(jwb_revision) between 1 and 240),
  jwb_rows_sha256 text not null check (jwb_rows_sha256 ~ '^[a-f0-9]{64}$'),
  students_version bigint not null
    check (students_version between 0 and 9007199254740991),
  review_epoch bigint not null
    check (review_epoch between 0 and 9007199254740991),
  duplicate_resolution_fingerprint text not null
    check (duplicate_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  plan_fingerprint text not null
    check (plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  before_link_fingerprint text not null
    check (before_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  after_link_fingerprint text not null
    check (after_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  before_link_count integer not null check (before_link_count between 0 and 10000),
  requested_count integer not null check (requested_count > 0 and requested_count <= 10000),
  newly_applied_count integer not null check (newly_applied_count > 0),
  already_applied_count integer not null check (already_applied_count >= 0),
  final_count integer not null check (final_count > 0 and final_count <= 10000),
  confirmed_by text not null check (length(confirmed_by) between 1 and 120),
  confirmed_at timestamptz not null default now(),
  audit_id uuid not null unique references internal.operational_contract_audit(id),
  check (requested_count = newly_applied_count + already_applied_count),
  check (final_count = before_link_count + newly_applied_count)
);

alter table internal.student_import_identity_bulk_create_review_commands
  enable row level security;
revoke all on table internal.student_import_identity_bulk_create_review_commands
  from public, anon, authenticated;

create or replace function internal.reject_student_import_identity_bulk_create_command_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = 'student_import_identity_bulk_create_review_command_immutable';
end;
$$;

drop trigger if exists reject_student_import_identity_bulk_create_command_mutation
  on internal.student_import_identity_bulk_create_review_commands;
create trigger reject_student_import_identity_bulk_create_command_mutation
before update or delete on internal.student_import_identity_bulk_create_review_commands
for each row execute function
  internal.reject_student_import_identity_bulk_create_command_mutation();

revoke all on function internal.reject_student_import_identity_bulk_create_command_mutation()
  from public, anon, authenticated;

create or replace function public.put_student_import_identity_bulk_create_review(
  p_secret text,
  p_confirmation_key text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  prior_command internal.student_import_identity_bulk_create_review_commands%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  create_candidates jsonb;
  create_plan jsonb;
  expected_key text;
  after_fingerprint text;
  audit_entry_id uuid;
  review_epoch bigint;
  saved_matches_current boolean := false;
  before_link_count integer;
  requested_count integer;
  newly_applied_count integer;
  already_applied_count integer;
  final_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_confirmation_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_create_review_request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_identity_link_set:singleton', 0
  ));
  select * into jwb from internal.student_import_source_rows source_state
    where source_state.source_kind = 'jwb' for update;
  select * into master from internal.student_import_source_rows source_state
    where source_state.source_kind = 'master' for update;
  select * into saved from internal.student_import_identity_link_sets identity_state
    where identity_state.singleton for update;
  select * into students_state from public.ops_state state_row
    where state_row.entity = 'students' for update;

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or students_state.version < 0
     or students_state.version > 9007199254740991 then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;
  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_create_review_linkset_invalid';
  end if;

  -- This snapshot is computed once and is both part of the CAS evidence and
  -- the sole basis for resolving duplicate master rows below.
  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );

  select * into prior_command
  from internal.student_import_identity_bulk_create_review_commands command
  where command.confirmation_key = p_confirmation_key
  for update;
  if found then
    if prior_command.master_source_id <> master.source_id
       or prior_command.master_revision <> master.revision
       or prior_command.master_rows_sha256 <> master.rows_sha256
       or prior_command.jwb_source_id <> jwb.source_id
       or prior_command.jwb_revision <> jwb.revision
       or prior_command.jwb_rows_sha256 <> jwb.rows_sha256
       or prior_command.students_version <> students_state.version
       or prior_command.review_epoch <> review_epoch
       or prior_command.duplicate_resolution_fingerprint <>
          duplicate_snapshot ->> 'fingerprint'
       or not saved_matches_current
       or saved.link_fingerprint <> prior_command.after_link_fingerprint
       or saved.link_count <> prior_command.final_count
       or saved.audit_id <> prior_command.audit_id then
      raise exception using errcode = '40001',
        message = 'student_import_identity_bulk_create_review_replay_conflict';
    end if;
    return jsonb_build_object(
      'confirmationKey', prior_command.confirmation_key,
      'fingerprint', prior_command.after_link_fingerprint,
      'count', prior_command.final_count,
      'requestedCount', prior_command.requested_count,
      'newlyAppliedCount', prior_command.newly_applied_count,
      'alreadyAppliedCount', prior_command.already_applied_count,
      'finalCount', prior_command.final_count,
      'unchanged', true
    );
  end if;

  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  -- Recompute the complete closed create set exactly once while all source,
  -- student and link-set rows are locked. The client key cannot race or add a
  -- candidate that was not independently derived by this transaction.
  create_candidates := internal.student_import_identity_bulk_create_candidates(
    master.source_id, master.revision, resolved_master_rows,
    jwb.source_id, jwb.revision, jwb.rows,
    students_state.version, review_epoch, students_state.payload
  );
  create_plan := internal.student_import_identity_bulk_create_plan(
    create_candidates, active_links
  );
  expected_key := internal.student_import_identity_bulk_create_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', create_plan ->> 'planFingerprint'
  );
  if expected_key <> p_confirmation_key then
    raise exception using errcode = '23503',
      message = 'student_import_identity_bulk_create_review_unavailable';
  end if;

  requested_count := (create_plan ->> 'createCandidateCount')::integer;
  newly_applied_count := (create_plan ->> 'pendingCreateCount')::integer;
  already_applied_count :=
    (create_plan ->> 'alreadyLinkedCreateCount')::integer;
  before_link_count := (create_plan ->> 'currentLinkCount')::integer;
  final_count := (create_plan ->> 'resultingLinkCount')::integer;
  if requested_count <= 0 or newly_applied_count <= 0
     or requested_count <> newly_applied_count + already_applied_count
     or final_count <> before_link_count + newly_applied_count
     or final_count <> jsonb_array_length(create_plan -> 'combinedLinks') then
    raise exception using errcode = '23503',
      message = 'student_import_identity_bulk_create_review_empty';
  end if;

  after_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', create_plan -> 'combinedLinks'
  )::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_bulk_create_review_confirmed', p_actor,
    'student_import_identity_bulk_create_review', p_confirmation_key,
    jsonb_build_object(
      'confirmationKey', p_confirmation_key,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'masterRowsSha256', master.rows_sha256,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'jwbRowsSha256', jwb.rows_sha256,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'duplicateResolutionFingerprint', duplicate_snapshot ->> 'fingerprint',
      'planFingerprint', create_plan ->> 'planFingerprint',
      'beforeLinkFingerprint', active_fingerprint,
      'afterLinkFingerprint', after_fingerprint,
      'beforeLinkCount', before_link_count,
      'requestedCount', requested_count,
      'newlyAppliedCount', newly_applied_count,
      'alreadyAppliedCount', already_applied_count,
      'finalCount', final_count
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, review_epoch,
    create_plan -> 'combinedLinks', final_count, after_fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    review_epoch = excluded.review_epoch,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;

  insert into internal.student_import_identity_bulk_create_review_commands (
    confirmation_key,
    master_source_id, master_revision, master_rows_sha256,
    jwb_source_id, jwb_revision, jwb_rows_sha256,
    students_version, review_epoch,
    duplicate_resolution_fingerprint, plan_fingerprint,
    before_link_fingerprint, after_link_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    confirmed_by, confirmed_at, audit_id
  ) values (
    p_confirmation_key,
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch,
    duplicate_snapshot ->> 'fingerprint', create_plan ->> 'planFingerprint',
    active_fingerprint, after_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    left(trim(p_actor), 120), now(), audit_entry_id
  );

  return jsonb_build_object(
    'confirmationKey', p_confirmation_key,
    'fingerprint', after_fingerprint,
    'count', final_count,
    'requestedCount', requested_count,
    'newlyAppliedCount', newly_applied_count,
    'alreadyAppliedCount', already_applied_count,
    'finalCount', final_count,
    'unchanged', false
  );
end;
$$;

revoke all on function public.put_student_import_identity_bulk_create_review(
  text, text, text
) from public, anon, authenticated;
grant execute on function public.put_student_import_identity_bulk_create_review(
  text, text, text
) to anon, authenticated;

-- Fail the migration if either narrow public entry point loses the explicitly
-- approved temporary timeout. No global or role timeout is changed.
do $$
declare
  preview_config text[];
  mutation_config text[];
begin
  select proconfig into preview_config
  from pg_catalog.pg_proc
  where oid =
    'public.get_student_import_identity_bulk_create_review_preview(text)'::regprocedure;
  select proconfig into mutation_config
  from pg_catalog.pg_proc
  where oid =
    'public.put_student_import_identity_bulk_create_review(text,text,text)'::regprocedure;
  if not coalesce('statement_timeout=8s' = any(preview_config), false)
     or not coalesce('statement_timeout=8s' = any(mutation_config), false) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_create_review_timeout_guard_missing';
  end if;
end;
$$;

-- Transactional semantic fixture: the create set is a closed zero-existing
-- set, required-status-only, and remains safe under ambiguity, deterministic
-- identity occupancy, owner duplication, exact replay and every CAS drift.
do $$
declare
  one_master jsonb :=
    '[{"sourceRow":1,"name":"Alice 张三","status":"在读"}]'::jsonb;
  one_jwb jsonb :=
    '[{"sourceRow":11,"name":"Student 张三"}]'::jsonb;
  candidate_set jsonb;
  plan_value jsonb;
  exact_links jsonb;
  derived_student_id text;
  key_base text;
begin
  derived_student_id := internal.student_import_student_id(
    'fixture-master', '1'::jsonb
  );
  candidate_set := internal.student_import_identity_bulk_create_candidates(
    'fixture-master', 'm1', one_master,
    'fixture-jwb', 'j1', one_jwb,
    7, 2, '[]'::jsonb
  );
  if jsonb_array_length(candidate_set) <> 1
     or candidate_set -> 0 ->> 'studentId' <> derived_student_id then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_zero_existing_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_bulk_create_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, '[{"id":"STU-EXISTING","name":"张三"}]'::jsonb
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_bulk_create_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1', one_jwb,
       7, 2,
       '[{"id":"STU-A","name":"张三"},{"id":"STU-B","name":"张三"}]'::jsonb
     )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_existing_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_bulk_create_candidates(
       'fixture-master', 'm1',
       '[{"sourceRow":1,"name":"Alice 张三","status":"在读"},
         {"sourceRow":2,"name":"Other 张三","status":"不活跃 + 无课时"}]'::jsonb,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, '[]'::jsonb
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_bulk_create_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1',
       '[{"sourceRow":11,"name":"Student 张三"},
         {"sourceRow":12,"name":"Other 张三"}]'::jsonb,
       7, 2, '[]'::jsonb
     )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_ambiguity_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_bulk_create_candidates(
       'fixture-master', 'm1',
       '[{"sourceRow":1,"name":"Alice 张三","status":"活跃 + 无课时"}]'::jsonb,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, '[]'::jsonb
     )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_required_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_bulk_create_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, jsonb_build_array(jsonb_build_object(
         'id', derived_student_id, 'name', 'Unrelated Existing'
       ))
     )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_occupied_fixture_mismatch';
  end if;

  -- Two current rows cannot own one deterministic identity. Duplicate source
  -- evidence is rejected before candidate construction, which is stronger than
  -- silently dropping just the colliding row.
  begin
    perform internal.student_import_identity_bulk_create_candidates(
      'fixture-master', 'm1',
      '[{"sourceRow":1,"name":"Alice 张三","status":"在读"},
        {"sourceRow":1,"name":"Other 李四","status":"活跃 + 有课时"}]'::jsonb,
      'fixture-jwb', 'j1', one_jwb,
      7, 2, '[]'::jsonb
    );
    raise exception using errcode = 'P0001',
      message = 'student_import_identity_bulk_create_review_owner_fixture_missing';
  exception when invalid_parameter_value then
    null;
  end;

  plan_value := internal.student_import_identity_bulk_create_plan(
    candidate_set, '[]'::jsonb
  );
  if plan_value ->> 'createCandidateCount' <> '1'
     or plan_value ->> 'pendingCreateCount' <> '1'
     or plan_value ->> 'alreadyLinkedCreateCount' <> '0'
     or plan_value ->> 'currentLinkCount' <> '0'
     or plan_value ->> 'resultingLinkCount' <> '1' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_pending_fixture_mismatch';
  end if;
  exact_links := plan_value -> 'combinedLinks';

  plan_value := internal.student_import_identity_bulk_create_plan(
    candidate_set,
    '[{"masterSourceRow":99,"jwbSourceRow":199,"studentId":"STU-OTHER"}]'::jsonb
  );
  if plan_value ->> 'pendingCreateCount' <> '1'
     or plan_value ->> 'currentLinkCount' <> '1'
     or plan_value ->> 'resultingLinkCount' <> '2'
     or not (plan_value -> 'combinedLinks') @>
       '[{"masterSourceRow":99,"jwbSourceRow":199,"studentId":"STU-OTHER"}]'::jsonb then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_preserve_fixture_mismatch';
  end if;

  plan_value := internal.student_import_identity_bulk_create_plan(
    candidate_set, exact_links
  );
  if plan_value ->> 'pendingCreateCount' <> '0'
     or plan_value ->> 'alreadyLinkedCreateCount' <> '1'
     or plan_value ->> 'resultingLinkCount' <> '1' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_exact_fixture_mismatch';
  end if;

  begin
    perform internal.student_import_identity_bulk_create_plan(
      candidate_set,
      '[{"masterSourceRow":1,"jwbSourceRow":99,"studentId":"STU-OTHER"}]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_conflict_fixture_missing';
  exception when unique_violation then
    null;
  end;

  key_base := internal.student_import_identity_bulk_create_review_key(
    'fixture-master', 'm1', repeat('a', 64),
    'fixture-jwb', 'j1', repeat('b', 64),
    7, 2, 'sha256:' || repeat('c', 64),
    'sha256:' || repeat('d', 64), 'sha256:' || repeat('e', 64)
  );
  if exists (
    select 1
    from (values
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master-2', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm2', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('f', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb-2', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j2', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('f', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 8, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 3,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('f', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('f', 64),
        'sha256:' || repeat('e', 64)
      )),
      (internal.student_import_identity_bulk_create_review_key(
        'fixture-master', 'm1', repeat('a', 64),
        'fixture-jwb', 'j1', repeat('b', 64), 7, 2,
        'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
        'sha256:' || repeat('f', 64)
      ))
    ) drifted(value)
    where drifted.value = key_base
  ) then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_create_review_key_fixture_mismatch';
  end if;
end;
$$;

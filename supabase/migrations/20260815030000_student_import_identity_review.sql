-- Enable one-at-a-time, server-recomputed student identity review decisions.
-- The public mutation accepts only an opaque option key, its decision and the
-- authenticated actor. Raw names, source rows, revisions and target IDs are
-- always recovered again from rows locked in this transaction.

-- Older commit evidence retained only revisions. Persist both locked source
-- identities for new commits so a same-revision source replacement can never
-- be mistaken for an idempotent replay. Nullable preserves forward migration
-- compatibility; legacy rows intentionally cannot use the new replay RPC.
alter table internal.student_import_commits
  add column if not exists master_source_id text
    check (master_source_id is null or length(master_source_id) between 1 and 160),
  add column if not exists jwb_source_id text
    check (jwb_source_id is null or length(jwb_source_id) between 1 and 160),
  add column if not exists master_rows_sha256 text
    check (master_rows_sha256 is null or master_rows_sha256 ~ '^[a-f0-9]{64}$'),
  add column if not exists jwb_rows_sha256 text
    check (jwb_rows_sha256 is null or jwb_rows_sha256 ~ '^[a-f0-9]{64}$');

-- Explicit clearing is a revocation boundary, including an already-empty
-- clear. Opaque review options bind this monotonic generation so a delayed
-- pre-clear request can never recreate a link after the administrator clears.
alter table internal.student_import_identity_link_sets
  add column if not exists review_epoch bigint not null default 0
    check (review_epoch >= 0),
  add column if not exists last_clear_key text
    check (last_clear_key is null or last_clear_key ~ '^sha256:[a-f0-9]{64}$');

-- A revision is permanent evidence, not merely the label on the current row.
-- This ledger prevents R -> S -> R from resurrecting stale identity decisions
-- with different source content under the old opaque keys.
create table if not exists internal.student_import_source_revision_evidence (
  source_kind text not null check (source_kind in ('master', 'jwb')),
  revision text not null check (length(revision) between 1 and 240),
  source_id text not null check (length(source_id) between 1 and 160),
  rows_sha256 text not null check (rows_sha256 ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz not null default now(),
  primary key (source_kind, revision)
);

alter table internal.student_import_source_revision_evidence enable row level security;
revoke all on table internal.student_import_source_revision_evidence
  from public, anon, authenticated;

-- Hold both existing ingest mutexes through history scan, backfill and trigger
-- installation so no revision can slip into the gap. Match the import-wide
-- source lock order (JWB before master).
do $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_source:jwb', 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_source:master', 0
  ));
end;
$$;

-- Audit history is the authoritative record of revisions no longer current.
-- Fail the whole migration if any historical revision was already reused with
-- different evidence; do not silently pick one side of an unsafe conflict.
do $$
begin
  if exists (
    select 1
    from internal.operational_contract_audit audit_entry
    where audit_entry.action = 'student_import.source_ingested'
      and audit_entry.target_type = 'student_import_source'
      and (
        audit_entry.target_id not in ('master', 'jwb')
        or jsonb_typeof(audit_entry.metadata -> 'sourceId') <> 'string'
        or nullif(trim(audit_entry.metadata ->> 'sourceId'), '') is null
        or length(audit_entry.metadata ->> 'sourceId') > 160
        or jsonb_typeof(audit_entry.metadata -> 'revision') <> 'string'
        or nullif(trim(audit_entry.metadata ->> 'revision'), '') is null
        or length(audit_entry.metadata ->> 'revision') > 240
        or jsonb_typeof(audit_entry.metadata -> 'rowsSha256') <> 'string'
        or (audit_entry.metadata ->> 'rowsSha256') !~ '^[a-f0-9]{64}$'
      )
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_revision_history_invalid';
  end if;

  if exists (
    with historical_evidence as (
      select audit_entry.target_id as source_kind,
        audit_entry.metadata ->> 'revision' as revision,
        audit_entry.metadata ->> 'sourceId' as source_id,
        audit_entry.metadata ->> 'rowsSha256' as rows_sha256
      from internal.operational_contract_audit audit_entry
      where audit_entry.action = 'student_import.source_ingested'
        and audit_entry.target_type = 'student_import_source'
      union all
      select current_source.source_kind, current_source.revision,
        current_source.source_id, current_source.rows_sha256
      from internal.student_import_source_rows current_source
      union all
      select saved_evidence.source_kind, saved_evidence.revision,
        saved_evidence.source_id, saved_evidence.rows_sha256
      from internal.student_import_source_revision_evidence saved_evidence
    )
    select 1
    from historical_evidence evidence
    group by evidence.source_kind, evidence.revision
    having count(distinct (evidence.source_id, evidence.rows_sha256)) > 1
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_revision_history_conflict';
  end if;
end;
$$;

insert into internal.student_import_source_revision_evidence (
  source_kind, revision, source_id, rows_sha256, first_seen_at
)
select distinct on (evidence.source_kind, evidence.revision)
  evidence.source_kind, evidence.revision, evidence.source_id,
  evidence.rows_sha256, evidence.first_seen_at
from (
  select audit_entry.target_id as source_kind,
    audit_entry.metadata ->> 'revision' as revision,
    audit_entry.metadata ->> 'sourceId' as source_id,
    audit_entry.metadata ->> 'rowsSha256' as rows_sha256,
    audit_entry.created_at as first_seen_at
  from internal.operational_contract_audit audit_entry
  where audit_entry.action = 'student_import.source_ingested'
    and audit_entry.target_type = 'student_import_source'
  union all
  select current_source.source_kind, current_source.revision,
    current_source.source_id, current_source.rows_sha256,
    current_source.ingested_at
  from internal.student_import_source_rows current_source
) evidence
order by evidence.source_kind, evidence.revision, evidence.first_seen_at
on conflict (source_kind, revision) do update set
  source_id = excluded.source_id,
  rows_sha256 = excluded.rows_sha256,
  first_seen_at = least(
    internal.student_import_source_revision_evidence.first_seen_at,
    excluded.first_seen_at
  )
where internal.student_import_source_revision_evidence.source_id = excluded.source_id
  and internal.student_import_source_revision_evidence.rows_sha256 = excluded.rows_sha256;

create or replace function internal.enforce_student_import_source_revision_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  historical internal.student_import_source_revision_evidence%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_source_revision:' || new.source_kind || ':' || new.revision, 0
  ));
  select * into historical
  from internal.student_import_source_revision_evidence evidence
  where evidence.source_kind = new.source_kind
    and evidence.revision = new.revision
  for update;
  if found then
    if historical.source_id <> new.source_id
       or historical.rows_sha256 <> new.rows_sha256 then
      raise exception using errcode = '23505',
        message = 'student_import_revision_conflict';
    end if;
    return new;
  end if;

  insert into internal.student_import_source_revision_evidence (
    source_kind, revision, source_id, rows_sha256, first_seen_at
  ) values (
    new.source_kind, new.revision, new.source_id, new.rows_sha256,
    coalesce(new.ingested_at, now())
  );
  return new;
end;
$$;

drop trigger if exists enforce_student_import_source_revision_evidence
  on internal.student_import_source_rows;
create trigger enforce_student_import_source_revision_evidence
before insert or update of source_id, revision, rows_sha256
on internal.student_import_source_rows
for each row execute function internal.enforce_student_import_source_revision_evidence();

revoke all on function internal.enforce_student_import_source_revision_evidence()
  from public, anon, authenticated;

create or replace function internal.student_import_master_review_name_key(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  display_name text := internal.student_import_display_name(p_name);
  character_value text;
  code_point integer;
  character_position integer;
  current_run text := '';
  qualifying_runs text[] := array[]::text[];
begin
  if display_name = '' then
    return '';
  end if;

  for character_position in 1..pg_catalog.char_length(display_name) loop
    character_value := pg_catalog.substr(display_name, character_position, 1);
    code_point := pg_catalog.ascii(character_value);
    if (code_point between 13312 and 19903)
       or (code_point between 19968 and 40959)
       or (code_point between 63744 and 64255)
       or (code_point between 131072 and 195103)
       or (code_point between 196608 and 201551) then
      current_run := current_run || character_value;
    else
      if pg_catalog.char_length(current_run) >= 2 then
        qualifying_runs := array_append(qualifying_runs, current_run);
      end if;
      current_run := '';
    end if;
  end loop;
  if pg_catalog.char_length(current_run) >= 2 then
    qualifying_runs := array_append(qualifying_runs, current_run);
  end if;

  return case when cardinality(qualifying_runs) = 1 then qualifying_runs[1] else '' end;
end;
$$;

create or replace function internal.student_import_identity_review_key(
  p_contract text,
  p_master_source_id text,
  p_master_revision text,
  p_master_source_row jsonb,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_jwb_source_row jsonb,
  p_students_version bigint,
  p_review_epoch bigint,
  p_decision text default null,
  p_student_id text default null
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  evidence jsonb;
begin
  evidence := jsonb_build_object(
    'contract', p_contract,
    'master', jsonb_build_object(
      'sourceId', p_master_source_id,
      'revision', p_master_revision,
      'sourceRow', p_master_source_row
    ),
    'jwb', jsonb_build_object(
      'sourceId', p_jwb_source_id,
      'revision', p_jwb_revision,
      'sourceRow', p_jwb_source_row
    ),
    'studentsVersion', p_students_version,
    'reviewEpoch', p_review_epoch
  );
  if p_decision is not null then
    evidence := evidence || jsonb_build_object(
      'decision', p_decision,
      'studentId', p_student_id
    );
  end if;
  return 'sha256:' || encode(extensions.digest(
    internal.student_import_stable_value(evidence), 'sha256'
  ), 'hex');
end;
$$;

create or replace function internal.student_import_identity_clear_key(
  p_master_source_id text,
  p_master_revision text,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_students_version bigint,
  p_review_epoch bigint,
  p_identity_link_fingerprint text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'sha256:' || encode(extensions.digest(
    internal.student_import_stable_value(jsonb_build_object(
      'contract', 'student-import-identity-review-clear-v1',
      'master', jsonb_build_object(
        'sourceId', p_master_source_id,
        'revision', p_master_revision
      ),
      'jwb', jsonb_build_object(
        'sourceId', p_jwb_source_id,
        'revision', p_jwb_revision
      ),
      'studentsVersion', p_students_version,
      'reviewEpoch', p_review_epoch,
      'identityLinkFingerprint', p_identity_link_fingerprint
    )), 'sha256'
  ), 'hex')
$$;

create or replace function internal.student_import_identity_manual_token(
  p_kind text,
  p_token_secret text,
  p_master_source_id text,
  p_master_revision text,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_students_version bigint,
  p_review_epoch bigint,
  p_source_row jsonb default null,
  p_student_id text default null
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  evidence jsonb;
begin
  evidence := jsonb_build_object(
    'contract', 'student-import-identity-review-manual-token-v2-hmac',
    'kind', p_kind,
    'master', jsonb_build_object(
      'sourceId', p_master_source_id,
      'revision', p_master_revision
    ),
    'jwb', jsonb_build_object(
      'sourceId', p_jwb_source_id,
      'revision', p_jwb_revision
    ),
    'studentsVersion', p_students_version,
    'reviewEpoch', p_review_epoch
  );
  if p_source_row is not null then
    evidence := evidence || jsonb_build_object('sourceRow', p_source_row);
  end if;
  if p_student_id is not null then
    evidence := evidence || jsonb_build_object('studentId', p_student_id);
  end if;
  return 'sha256:' || encode(extensions.hmac(
    internal.student_import_stable_value(evidence), p_token_secret, 'sha256'
  ), 'hex');
end;
$$;

create or replace function internal.student_import_identity_review_candidates(
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
language sql
stable
set search_path = ''
as $$
  with master_keys as (
    select master_row.value as row_value,
      master_row.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(master_row.value -> 'sourceRow') as source_key,
      internal.student_import_master_review_name_key(master_row.value ->> 'name') as review_key,
      trim(coalesce(master_row.value ->> 'status', '')) as status
    from jsonb_array_elements(p_master_rows) master_row(value)
  ), unique_master as (
    select candidate.*
    from master_keys candidate
    where candidate.review_key <> ''
      and candidate.status in (
        '在读', '活跃 + 无课时', '活跃 + 有课时',
        '不活跃 + 有课时', '在读 + 加课待排'
      )
      and (
        select count(*) from master_keys sibling
        where sibling.review_key = candidate.review_key
      ) = 1
  ), jwb_keys as (
    select jwb_row.value as row_value,
      jwb_row.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(jwb_row.value -> 'sourceRow') as source_key,
      -- The review workflow may bridge one mixed-script display name only
      -- after an administrator confirms the opaque option. Reuse the exact
      -- one-contiguous-Han-run evidence contract on both source sides; this is
      -- intentionally broader than the automatic Chinese-only name fallback.
      internal.student_import_master_review_name_key(jwb_row.value ->> 'name') as review_key
    from jsonb_array_elements(p_jwb_rows) jwb_row(value)
  ), unique_jwb as (
    select candidate.*
    from jwb_keys candidate
    where candidate.review_key <> ''
      and (
        select count(*) from jwb_keys sibling
        where sibling.review_key = candidate.review_key
      ) = 1
  ), paired as (
    select master.row_value as master_row,
      master.source_row as master_source_row,
      master.source_key as master_source_key,
      master.review_key,
      jwb.row_value as jwb_row,
      jwb.source_row as jwb_source_row,
      jwb.source_key as jwb_source_key,
      internal.student_import_student_id(p_master_source_id, master.source_row) as derived_student_id
    from unique_master master
    join unique_jwb jwb using (review_key)
  ), resolved as (
    select pair.*,
      existing.match_count,
      existing.student_id as existing_student_id,
      not exists (
        select 1 from jsonb_array_elements(p_students) current_student
        where current_student ->> 'id' = pair.derived_student_id
      ) as derived_identity_available
    from paired pair
    cross join lateral (
      select count(*)::integer as match_count,
        (jsonb_agg(current_student ->> 'id'
          order by internal.student_import_utf16_sort_key(current_student ->> 'id')) ->> 0) as student_id
      from jsonb_array_elements(p_students) current_student
      where internal.student_import_master_review_name_key(current_student ->> 'name') = pair.review_key
    ) existing
  ), candidate_options as (
    select resolved.*,
      option_value.decision,
      option_value.student_id,
      internal.student_import_identity_review_key(
        'student-import-identity-review-candidate-v1',
        p_master_source_id, p_master_revision, resolved.master_source_row,
        p_jwb_source_id, p_jwb_revision, resolved.jwb_source_row,
        p_students_version, p_review_epoch
      ) as candidate_key,
      internal.student_import_identity_review_key(
        'student-import-identity-review-v1',
        p_master_source_id, p_master_revision, resolved.master_source_row,
        p_jwb_source_id, p_jwb_revision, resolved.jwb_source_row,
        p_students_version, p_review_epoch,
        option_value.decision, option_value.student_id
      ) as resolution_key
    from resolved
    cross join lateral (
      select 'merge'::text as decision, resolved.existing_student_id as student_id
      where resolved.match_count = 1
        and not exists (
          select 1 from jsonb_array_elements(p_master_rows) owner_row
          where trim(coalesce(owner_row ->> 'status', '')) in (
              '在读', '活跃 + 无课时', '活跃 + 有课时',
              '不活跃 + 有课时', '在读 + 加课待排'
            )
            and internal.student_import_student_id(
              p_master_source_id, owner_row -> 'sourceRow'
            ) = resolved.existing_student_id
            and internal.student_import_source_key(owner_row -> 'sourceRow') <>
              resolved.master_source_key
        )
      union all
      select 'create'::text, resolved.derived_student_id
      where resolved.derived_identity_available
        and (
          select count(*) from jsonb_array_elements(p_master_rows) owner_row
          where trim(coalesce(owner_row ->> 'status', '')) in (
              '在读', '活跃 + 无课时', '活跃 + 有课时',
              '不活跃 + 有课时', '在读 + 加课待排'
            )
            and internal.student_import_student_id(
              p_master_source_id, owner_row -> 'sourceRow'
            ) = resolved.derived_student_id
            and internal.student_import_source_key(owner_row -> 'sourceRow') =
              resolved.master_source_key
        ) = 1
        and not exists (
          select 1 from jsonb_array_elements(p_master_rows) owner_row
          where trim(coalesce(owner_row ->> 'status', '')) in (
              '在读', '活跃 + 无课时', '活跃 + 有课时',
              '不活跃 + 有课时', '在读 + 加课待排'
            )
            and internal.student_import_student_id(
              p_master_source_id, owner_row -> 'sourceRow'
            ) = resolved.derived_student_id
            and internal.student_import_source_key(owner_row -> 'sourceRow') <>
              resolved.master_source_key
        )
    ) option_value
    where option_value.student_id is not null
      and length(option_value.student_id) between 1 and 240
      and (
        option_value.decision <> 'merge'
        or (
          select count(*) from jsonb_array_elements(p_students) current_student
          where current_student ->> 'id' = option_value.student_id
            and internal.student_import_master_review_name_key(current_student ->> 'name') =
              resolved.review_key
        ) = 1
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateKey', candidate_key,
    'resolutionKey', resolution_key,
    'reviewKey', review_key,
    'decision', decision,
    'studentId', student_id,
    'masterSourceRow', master_source_row,
    'jwbSourceRow', jwb_source_row
  ) order by internal.student_import_utf16_sort_key(candidate_key)), '[]'::jsonb)
  from candidate_options
$$;

create or replace function public.put_student_import_identity_review_decision(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  candidates jsonb;
  candidate jsonb;
  next_link jsonb;
  canonical_links jsonb;
  fingerprint text;
  audit_entry_id uuid;
  review_epoch bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('merge', 'create')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_review_request';
  end if;

  -- The advisory lock also serialises the first ever singleton insert with
  -- the legacy clear RPC, where SELECT FOR UPDATE has no row to lock yet.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_identity_link_set:singleton', 0
  ));
  -- Use the same stable row-lock order as the other student import mutations.
  select * into jwb
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'jwb'
  for update;
  select * into master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for update;
  select * into saved
  from internal.student_import_identity_link_sets identity_state
  where identity_state.singleton
  for update;
  select * into students_state
  from public.ops_state state_row
  where state_row.entity = 'students'
  for update;

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  review_epoch := coalesce(saved.review_epoch, 0);

  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  select coalesce(jsonb_agg(resolved_row
    order by internal.student_import_utf16_sort_key(resolved_row ->> 'sourceRow')), '[]'::jsonb)
  into resolved_master_rows
  from (
    select case
      when matched.duplicate_decision ->> 'decision' = 'select'
       and master_row ->> 'sourceRow' = matched.duplicate_decision ->> 'selectedSourceRow'
       and nullif(matched.duplicate_decision ->> 'selectedStatus', '') is not null
      then jsonb_set(
        master_row, '{status}',
        to_jsonb(matched.duplicate_decision ->> 'selectedStatus'), true
      )
      else master_row end as resolved_row
    from jsonb_array_elements(master.rows) master_row
    left join lateral (
      select saved_decision.value as duplicate_decision
      from jsonb_array_elements(duplicate_snapshot -> 'decisions') saved_decision(value)
      where exists (
        select 1
        from jsonb_array_elements_text(saved_decision.value -> 'sourceRows') source_row
        where source_row = master_row ->> 'sourceRow'
      )
      limit 1
    ) matched on true
    where (
      matched.duplicate_decision is null
       or (
         matched.duplicate_decision ->> 'decision' = 'select'
         and master_row ->> 'sourceRow' =
           matched.duplicate_decision ->> 'selectedSourceRow'
       )
    )
    and not exists (
      select 1
      from jsonb_array_elements(duplicate_snapshot -> 'candidates') pending_candidate
      where exists (
        select 1 from jsonb_array_elements(pending_candidate -> 'sourceRows') pending_row
        where internal.student_import_source_key(pending_row) =
          internal.student_import_source_key(master_row -> 'sourceRow')
      )
      and not exists (
        select 1 from jsonb_array_elements(duplicate_snapshot -> 'decisions') saved_decision
        where saved_decision -> 'sourceRows' = pending_candidate -> 'sourceRows'
      )
    )
  ) resolved;

  candidates := internal.student_import_identity_review_candidates(
    master.source_id, master.revision, resolved_master_rows,
    jwb.source_id, jwb.revision, jwb.rows,
    students_state.version, review_epoch, students_state.payload
  );
  select option_value.value into candidate
  from jsonb_array_elements(candidates) option_value(value)
  where option_value.value ->> 'resolutionKey' = p_resolution_key
    and option_value.value ->> 'decision' = p_decision
  limit 1;
  if candidate is null then
    raise exception using errcode = '23503', message = 'student_import_identity_review_unavailable';
  end if;

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    active_links := saved.links;
  end if;

  next_link := jsonb_build_object(
    'masterSourceRow', candidate -> 'masterSourceRow',
    'jwbSourceRow', candidate -> 'jwbSourceRow',
    'studentId', candidate ->> 'studentId'
  );

  if exists (
    select 1 from jsonb_array_elements(active_links) existing_link
    where internal.student_import_source_key(existing_link -> 'masterSourceRow') =
            internal.student_import_source_key(next_link -> 'masterSourceRow')
      and internal.student_import_source_key(existing_link -> 'jwbSourceRow') =
            internal.student_import_source_key(next_link -> 'jwbSourceRow')
      and trim(existing_link ->> 'studentId') = trim(next_link ->> 'studentId')
  ) then
    return jsonb_build_object(
      'resolutionKey', p_resolution_key,
      'decision', p_decision,
      'fingerprint', saved.link_fingerprint,
      'count', saved.link_count,
      'unchanged', true
    );
  end if;

  if exists (
    select 1 from jsonb_array_elements(active_links) existing_link
    where internal.student_import_source_key(existing_link -> 'masterSourceRow') =
            internal.student_import_source_key(next_link -> 'masterSourceRow')
       or internal.student_import_source_key(existing_link -> 'jwbSourceRow') =
            internal.student_import_source_key(next_link -> 'jwbSourceRow')
       or trim(existing_link ->> 'studentId') = trim(next_link ->> 'studentId')
  ) then
    raise exception using errcode = '23505', message = 'student_import_identity_review_conflict';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'masterSourceRow', link -> 'masterSourceRow',
    'studentId', trim(link ->> 'studentId'),
    'jwbSourceRow', case
      when link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
      then link -> 'jwbSourceRow' else null end
  )) order by internal.student_import_utf16_sort_key(
    internal.student_import_source_key(link -> 'masterSourceRow')
  )), '[]'::jsonb)
  into canonical_links
  from jsonb_array_elements(active_links || jsonb_build_array(next_link)) link;

  if jsonb_array_length(canonical_links) < 1
     or jsonb_array_length(canonical_links) > 10000
     or jsonb_array_length(canonical_links) <>
       (select count(distinct internal.student_import_source_key(link -> 'masterSourceRow'))
        from jsonb_array_elements(canonical_links) link)
     or (select count(*) from jsonb_array_elements(canonical_links) link
         where link ? 'jwbSourceRow') <>
       (select count(distinct internal.student_import_source_key(link -> 'jwbSourceRow'))
        from jsonb_array_elements(canonical_links) link where link ? 'jwbSourceRow')
     or jsonb_array_length(canonical_links) <>
       (select count(distinct trim(link ->> 'studentId'))
        from jsonb_array_elements(canonical_links) link) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_links';
  end if;

  fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', canonical_links
  )::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_review_confirmed', p_actor,
    'student_import_identity_review', p_resolution_key,
    jsonb_build_object(
      'resolutionKey', p_resolution_key,
      'candidateKey', candidate ->> 'candidateKey',
      'decision', p_decision,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'linkCount', jsonb_array_length(canonical_links),
      'linkFingerprint', fingerprint
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, review_epoch,
    canonical_links, jsonb_array_length(canonical_links), fingerprint,
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

  return jsonb_build_object(
    'resolutionKey', p_resolution_key,
    'decision', p_decision,
    'fingerprint', fingerprint,
    'count', jsonb_array_length(canonical_links),
    'unchanged', false
  );
end;
$$;

-- Covers the identities outside the narrow name-evidence suggestion set. The
-- browser supplies only opaque row tokens and a closed merge/create decision;
-- every row, version, ownership rule and target ID is recovered under locks.
drop function if exists public.put_student_import_identity_review_pair(
  text, text, text, text, text, text
);
create or replace function public.put_student_import_identity_review_pair(
  p_secret text,
  p_token_secret text,
  p_master_token text,
  p_jwb_token text,
  p_decision text,
  p_existing_token text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  selected_master jsonb;
  selected_jwb jsonb;
  selected_existing jsonb;
  master_match_count integer;
  jwb_match_count integer;
  existing_match_count integer;
  target_student_id text;
  next_link jsonb;
  canonical_links jsonb;
  fingerprint text;
  resolution_key text;
  candidate_key text;
  audit_entry_id uuid;
  review_epoch bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_master_token, '') !~ '^sha256:[a-f0-9]{64}$'
     or coalesce(p_jwb_token, '') !~ '^sha256:[a-f0-9]{64}$'
     or coalesce(p_token_secret, '') !~ '^[a-f0-9]{64}$'
     or p_decision not in ('merge', 'create')
     or (p_decision = 'merge'
       and coalesce(p_existing_token, '') !~ '^sha256:[a-f0-9]{64}$')
     or (p_decision = 'create' and p_existing_token is not null)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_review_pair_request';
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
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  review_epoch := coalesce(saved.review_epoch, 0);

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    active_links := saved.links;
  end if;

  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  select coalesce(jsonb_agg(resolved_row
    order by internal.student_import_utf16_sort_key(resolved_row ->> 'sourceRow')), '[]'::jsonb)
  into resolved_master_rows
  from (
    select case
      when matched.duplicate_decision ->> 'decision' = 'select'
       and master_row ->> 'sourceRow' = matched.duplicate_decision ->> 'selectedSourceRow'
       and nullif(matched.duplicate_decision ->> 'selectedStatus', '') is not null
      then jsonb_set(
        master_row, '{status}',
        to_jsonb(matched.duplicate_decision ->> 'selectedStatus'), true
      )
      else master_row end as resolved_row
    from jsonb_array_elements(master.rows) master_row
    left join lateral (
      select saved_decision.value as duplicate_decision
      from jsonb_array_elements(duplicate_snapshot -> 'decisions') saved_decision(value)
      where exists (
        select 1
        from jsonb_array_elements_text(saved_decision.value -> 'sourceRows') source_row
        where source_row = master_row ->> 'sourceRow'
      )
      limit 1
    ) matched on true
    where (
      matched.duplicate_decision is null
      or (
        matched.duplicate_decision ->> 'decision' = 'select'
        and master_row ->> 'sourceRow' =
          matched.duplicate_decision ->> 'selectedSourceRow'
      )
    )
    and not exists (
      select 1
      from jsonb_array_elements(duplicate_snapshot -> 'candidates') pending_candidate
      where exists (
        select 1 from jsonb_array_elements(pending_candidate -> 'sourceRows') pending_row
        where internal.student_import_source_key(pending_row) =
          internal.student_import_source_key(master_row -> 'sourceRow')
      )
      and not exists (
        select 1 from jsonb_array_elements(duplicate_snapshot -> 'decisions') saved_decision
        where saved_decision -> 'sourceRows' = pending_candidate -> 'sourceRows'
      )
    )
  ) resolved;

  select count(*)::integer,
    (jsonb_agg(master_row.value
      order by internal.student_import_utf16_sort_key(master_row.value ->> 'sourceRow')) -> 0)
  into master_match_count, selected_master
  from jsonb_array_elements(resolved_master_rows) master_row(value)
  where trim(coalesce(master_row.value ->> 'status', '')) in (
      '在读', '活跃 + 有课时', '不活跃 + 有课时', '在读 + 加课待排'
    )
    and internal.student_import_identity_manual_token(
      'master', p_token_secret, master.source_id, master.revision,
      jwb.source_id, jwb.revision,
      students_state.version, review_epoch,
      master_row.value -> 'sourceRow', null
    ) = p_master_token;
  if master_match_count <> 1 or selected_master is null then
    raise exception using errcode = '23503',
      message = 'student_import_identity_review_unavailable';
  end if;

  select count(*)::integer,
    (jsonb_agg(jwb_row.value
      order by internal.student_import_utf16_sort_key(jwb_row.value ->> 'sourceRow')) -> 0)
  into jwb_match_count, selected_jwb
  from jsonb_array_elements(jwb.rows) jwb_row(value)
  where internal.student_import_identity_manual_token(
      'jwb', p_token_secret, master.source_id, master.revision,
      jwb.source_id, jwb.revision,
      students_state.version, review_epoch,
      jwb_row.value -> 'sourceRow', null
    ) = p_jwb_token;
  if jwb_match_count <> 1 or selected_jwb is null then
    raise exception using errcode = '23503',
      message = 'student_import_identity_review_unavailable';
  end if;

  if p_decision = 'merge' then
    select count(*)::integer,
      (jsonb_agg(current_student.value
        order by internal.student_import_utf16_sort_key(current_student.value ->> 'id')) -> 0)
    into existing_match_count, selected_existing
    from jsonb_array_elements(students_state.payload) current_student(value)
    where internal.student_import_identity_manual_token(
        'existing', p_token_secret, master.source_id, master.revision,
        jwb.source_id, jwb.revision,
        students_state.version, review_epoch,
        null, current_student.value ->> 'id'
      ) = p_existing_token;
    if existing_match_count <> 1 or selected_existing is null then
      raise exception using errcode = '23503',
        message = 'student_import_identity_review_unavailable';
    end if;
    target_student_id := selected_existing ->> 'id';
  else
    target_student_id := internal.student_import_student_id(
      master.source_id, selected_master -> 'sourceRow'
    );
    if exists (
      select 1 from jsonb_array_elements(students_state.payload) current_student
      where current_student ->> 'id' = target_student_id
    ) then
      raise exception using errcode = '23505',
        message = 'student_import_identity_review_conflict';
    end if;
  end if;

  if length(coalesce(target_student_id, '')) not between 1 and 240 then
    raise exception using errcode = '23503',
      message = 'student_import_identity_review_unavailable';
  end if;

  -- A current deterministic identity is implicitly owned by its own eligible
  -- master row even before a review link exists. Never let another row merge
  -- into it, and reject even a theoretical deterministic-ID collision.
  if (
    select count(*)
    from jsonb_array_elements(resolved_master_rows) owner_row
    where trim(coalesce(owner_row ->> 'status', '')) in (
        '在读', '活跃 + 无课时', '活跃 + 有课时',
        '不活跃 + 有课时', '在读 + 加课待排'
      )
      and internal.student_import_student_id(
        master.source_id, owner_row -> 'sourceRow'
      ) = target_student_id
      and internal.student_import_source_key(owner_row -> 'sourceRow') <>
        internal.student_import_source_key(selected_master -> 'sourceRow')
  ) > 0 then
    raise exception using errcode = '23505',
      message = 'student_import_identity_review_conflict';
  end if;
  if p_decision = 'create' and (
    select count(*)
    from jsonb_array_elements(resolved_master_rows) owner_row
    where trim(coalesce(owner_row ->> 'status', '')) in (
        '在读', '活跃 + 无课时', '活跃 + 有课时',
        '不活跃 + 有课时', '在读 + 加课待排'
      )
      and internal.student_import_student_id(
        master.source_id, owner_row -> 'sourceRow'
      ) = target_student_id
      and internal.student_import_source_key(owner_row -> 'sourceRow') =
        internal.student_import_source_key(selected_master -> 'sourceRow')
  ) <> 1 then
    raise exception using errcode = '23505',
      message = 'student_import_identity_review_conflict';
  end if;

  next_link := jsonb_build_object(
    'masterSourceRow', selected_master -> 'sourceRow',
    'jwbSourceRow', selected_jwb -> 'sourceRow',
    'studentId', target_student_id
  );
  resolution_key := internal.student_import_identity_review_key(
    'student-import-identity-review-v1',
    master.source_id, master.revision, selected_master -> 'sourceRow',
    jwb.source_id, jwb.revision, selected_jwb -> 'sourceRow',
    students_state.version, review_epoch, p_decision, target_student_id
  );
  candidate_key := internal.student_import_identity_review_key(
    'student-import-identity-review-candidate-v1',
    master.source_id, master.revision, selected_master -> 'sourceRow',
    jwb.source_id, jwb.revision, selected_jwb -> 'sourceRow',
    students_state.version, review_epoch
  );

  if exists (
    select 1 from jsonb_array_elements(active_links) existing_link
    where internal.student_import_source_key(existing_link -> 'masterSourceRow') =
            internal.student_import_source_key(next_link -> 'masterSourceRow')
      and internal.student_import_source_key(existing_link -> 'jwbSourceRow') =
            internal.student_import_source_key(next_link -> 'jwbSourceRow')
      and trim(existing_link ->> 'studentId') = target_student_id
  ) then
    return jsonb_build_object(
      'resolutionKey', resolution_key,
      'decision', p_decision,
      'fingerprint', saved.link_fingerprint,
      'count', saved.link_count,
      'unchanged', true
    );
  end if;

  if exists (
    select 1 from jsonb_array_elements(active_links) existing_link
    where internal.student_import_source_key(existing_link -> 'masterSourceRow') =
            internal.student_import_source_key(next_link -> 'masterSourceRow')
       or internal.student_import_source_key(existing_link -> 'jwbSourceRow') =
            internal.student_import_source_key(next_link -> 'jwbSourceRow')
       or trim(existing_link ->> 'studentId') = target_student_id
  ) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_review_conflict';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'masterSourceRow', link -> 'masterSourceRow',
    'studentId', trim(link ->> 'studentId'),
    'jwbSourceRow', case
      when link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
      then link -> 'jwbSourceRow' else null end
  )) order by internal.student_import_utf16_sort_key(
    internal.student_import_source_key(link -> 'masterSourceRow')
  )), '[]'::jsonb)
  into canonical_links
  from jsonb_array_elements(active_links || jsonb_build_array(next_link)) link;

  if jsonb_array_length(canonical_links) < 1
     or jsonb_array_length(canonical_links) > 10000
     or jsonb_array_length(canonical_links) <>
       (select count(distinct internal.student_import_source_key(link -> 'masterSourceRow'))
        from jsonb_array_elements(canonical_links) link)
     or (select count(*) from jsonb_array_elements(canonical_links) link
         where link ? 'jwbSourceRow') <>
       (select count(distinct internal.student_import_source_key(link -> 'jwbSourceRow'))
        from jsonb_array_elements(canonical_links) link where link ? 'jwbSourceRow')
     or jsonb_array_length(canonical_links) <>
       (select count(distinct trim(link ->> 'studentId'))
        from jsonb_array_elements(canonical_links) link) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_links';
  end if;

  fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', canonical_links
  )::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_manual_pair_confirmed', p_actor,
    'student_import_identity_review', resolution_key,
    jsonb_build_object(
      'resolutionKey', resolution_key,
      'candidateKey', candidate_key,
      'decision', p_decision,
      'masterToken', p_master_token,
      'jwbToken', p_jwb_token,
      'existingToken', p_existing_token,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'linkCount', jsonb_array_length(canonical_links),
      'linkFingerprint', fingerprint
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, review_epoch,
    canonical_links, jsonb_array_length(canonical_links), fingerprint,
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

  return jsonb_build_object(
    'resolutionKey', resolution_key,
    'decision', p_decision,
    'fingerprint', fingerprint,
    'count', jsonb_array_length(canonical_links),
    'unchanged', false
  );
end;
$$;

create or replace function internal.student_import_selected_duplicate_identity_matches(
  p_links jsonb,
  p_selected_source_row jsonb,
  p_selected_student_id text,
  p_jwb_rows jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_links) = 'array'
    and jsonb_typeof(p_jwb_rows) = 'array'
    and (
      select count(*)
      from jsonb_array_elements(p_links) reviewed_link
      where internal.student_import_source_key(reviewed_link -> 'masterSourceRow') =
          internal.student_import_source_key(p_selected_source_row)
        and trim(reviewed_link ->> 'studentId') = trim(p_selected_student_id)
        and (
          not (reviewed_link ? 'jwbSourceRow')
          or exists (
            select 1 from jsonb_array_elements(p_jwb_rows) jwb_row
            where internal.student_import_source_key(jwb_row -> 'sourceRow') =
              internal.student_import_source_key(reviewed_link -> 'jwbSourceRow')
          )
        )
    ) = 1
$$;

create or replace function internal.student_import_master_duplicate_snapshot(
  p_master internal.student_import_source_rows,
  p_students public.ops_state
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  candidates jsonb := internal.student_import_master_duplicate_candidates(p_master, p_students);
  jwb internal.student_import_source_rows%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  decisions jsonb;
  fingerprint text;
begin
  select * into jwb
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'jwb';
  select * into link_set
  from internal.student_import_identity_link_sets identity_state
  where identity_state.singleton;
  if jwb.source_kind is not null
     and link_set.singleton
     and link_set.master_source_id = p_master.source_id
     and link_set.master_revision = p_master.revision
     and link_set.jwb_source_id = jwb.source_id
     and link_set.jwb_revision = jwb.revision
     and link_set.students_version = p_students.version then
    active_links := link_set.links;
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'decision', resolution.decision,
    'sourceRows', resolution.source_rows,
    'selectedSourceRow', resolution.selected_source_row,
    'selectedStatus', resolution.selected_status,
    'selectedStudentId', resolution.selected_student_id
  )) order by resolution.resolution_group_key), '[]'::jsonb)
  into decisions
  from internal.student_import_master_duplicate_resolutions resolution
  where resolution.master_source_id = p_master.source_id
    and resolution.master_revision = p_master.revision
    and resolution.students_version = p_students.version
    and (
      resolution.selected_student_id is null
      or (
        resolution.decision = 'select'
        and resolution.selected_source_row is not null
        and internal.student_import_selected_duplicate_identity_matches(
          active_links,
          resolution.selected_source_row,
          resolution.selected_student_id,
          jwb.rows
        )
      )
    )
    and exists (
      select 1 from jsonb_array_elements(candidates) candidate
      where candidate ->> 'resolutionGroupKey' = resolution.resolution_group_key
        and exists (
          select 1 from jsonb_array_elements(candidate -> 'options') option_value
          where option_value ->> 'resolutionKey' = resolution.resolution_key
            and option_value ->> 'decision' = resolution.decision
        )
    );

  fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', p_master.source_id,
    'masterRevision', p_master.revision,
    'studentsVersion', p_students.version,
    'decisions', decisions
  )::text, 'sha256'), 'hex');
  return jsonb_build_object(
    'decisions', decisions,
    'fingerprint', fingerprint,
    'candidates', candidates
  );
end;
$$;

-- Current-revision nonempty reviewed links are now first-class import evidence.
create or replace function public.get_latest_student_import_source_rows(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  students_state public.ops_state%rowtype;
  duplicate_snapshot jsonb;
  fu_attachment_snapshot jsonb;
  missing_sources text[] := array[]::text[];
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into master from internal.student_import_source_rows s where s.source_kind = 'master';
  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb';
  select * into link_set from internal.student_import_identity_link_sets l where l.singleton;
  select * into students_state from public.ops_state s where s.entity = 'students';
  if master.source_kind is null then
    missing_sources := array_append(missing_sources, 'master');
  end if;
  if jwb.source_kind is null then
    missing_sources := array_append(missing_sources, 'jwb');
  end if;
  if cardinality(missing_sources) > 0 then
    raise exception using
      errcode = 'P0002',
      message = 'student_import_source_rows_unavailable',
      detail = 'missing_sources=' || array_to_string(missing_sources, ',');
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(master, students_state);
  fu_attachment_snapshot := internal.student_fu_attachment_reference_snapshot();

  return jsonb_build_object(
    'master', jsonb_build_object(
      'sourceId', master.source_id,
      'revision', master.revision,
      'rows', master.rows
    ),
    'jwb', jsonb_build_object(
      'sourceId', jwb.source_id,
      'revision', jwb.revision,
      'rows', jwb.rows
    ),
    'identityLinks', case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = students_state.version
      then link_set.links else '[]'::jsonb end,
    'identityLinkFingerprint', case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = students_state.version
      then link_set.link_fingerprint else 'sha256:' || repeat('0', 64) end,
    'identityReviewEpoch', coalesce(link_set.review_epoch, 0),
    'masterDuplicateResolutions', duplicate_snapshot -> 'decisions',
    'masterDuplicateResolutionFingerprint', duplicate_snapshot ->> 'fingerprint',
    'fuAttachmentReferences', fu_attachment_snapshot
  );
end;
$$;

revoke all on function public.get_latest_student_import_source_rows(text)
  from public, anon, authenticated;
grant execute on function public.get_latest_student_import_source_rows(text)
  to anon, authenticated;

-- Duplicate-row decisions may consume an already reviewed identity link.
create or replace function public.put_student_import_master_duplicate_resolution(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  candidate jsonb;
  option_value jsonb;
  existing internal.student_import_master_duplicate_resolutions%rowtype;
  group_existing internal.student_import_master_duplicate_resolutions%rowtype;
  source_rows jsonb;
  selected_source_row jsonb;
  selected_status text;
  selected_student_id text;
  group_link jsonb;
  group_link_count integer := 0;
  snapshot jsonb;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('select', 'ignore')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_student_master_duplicate_resolution_request';
  end if;
  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb' for update;
  select * into master from internal.student_import_source_rows s where s.source_kind = 'master' for update;
  select * into link_set from internal.student_import_identity_link_sets l where l.singleton for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  if link_set.singleton
     and link_set.master_source_id = master.source_id
     and link_set.master_revision = master.revision
     and link_set.jwb_source_id = jwb.source_id
     and link_set.jwb_revision = jwb.revision
     and link_set.students_version = students_state.version then
    active_links := link_set.links;
  end if;
  select candidate_item.value, option_item.value
  into candidate, option_value
  from jsonb_array_elements(internal.student_import_master_duplicate_candidates(master, students_state)) candidate_item(value)
  cross join lateral jsonb_array_elements(candidate_item.value -> 'options') option_item(value)
  where option_item.value ->> 'resolutionKey' = p_resolution_key
    and option_item.value ->> 'decision' = p_decision
  limit 1;
  if candidate is null then
    raise exception using errcode = '23503', message = 'student_master_duplicate_resolution_unavailable';
  end if;
  source_rows := candidate -> 'sourceRows';
  selected_source_row := option_value -> 'selectedSourceRow';
  selected_status := option_value ->> 'selectedStatus';
  select count(*)::integer,
    (jsonb_agg(link.value order by internal.student_import_utf16_sort_key(
      internal.student_import_source_key(link.value -> 'masterSourceRow')
    )) -> 0)
  into group_link_count, group_link
  from jsonb_array_elements(active_links) link(value)
  where exists (
    select 1 from jsonb_array_elements(source_rows) group_source_row
    where internal.student_import_source_key(group_source_row) =
      internal.student_import_source_key(link.value -> 'masterSourceRow')
  );
  if group_link_count > 1 then
    raise exception using errcode = '23505',
      message = 'student_master_duplicate_identity_unavailable';
  end if;
  if group_link_count = 1 and (
    p_decision <> 'select'
    or internal.student_import_source_key(selected_source_row) <>
      internal.student_import_source_key(group_link -> 'masterSourceRow')
  ) then
    raise exception using errcode = '23505',
      message = 'student_master_duplicate_resolution_conflict';
  end if;
  if p_decision = 'select' and group_link_count = 1 then
    selected_student_id := group_link ->> 'studentId';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_master_duplicate:' || (candidate ->> 'resolutionGroupKey'), 0
  ));
  select * into existing from internal.student_import_master_duplicate_resolutions r
  where r.resolution_key = p_resolution_key for update;
  if found then
    if existing.decision <> p_decision or existing.master_revision <> master.revision
       or existing.students_version <> students_state.version then
      raise exception using errcode = '23505', message = 'student_master_duplicate_resolution_conflict';
    end if;
    snapshot := internal.student_import_master_duplicate_snapshot(master, students_state);
    return jsonb_build_object('resolutionKey', existing.resolution_key, 'decision', existing.decision,
      'fingerprint', snapshot ->> 'fingerprint', 'unchanged', true);
  end if;
  select * into group_existing from internal.student_import_master_duplicate_resolutions r
  where r.resolution_group_key = candidate ->> 'resolutionGroupKey' for update;
  if found then
    raise exception using errcode = '23505', message = 'student_master_duplicate_resolution_conflict';
  end if;
  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.master_duplicate_resolution_confirmed', p_actor,
    'student_import_master_duplicate_resolution', p_resolution_key,
    jsonb_build_object('resolutionKey', p_resolution_key,
      'resolutionGroupKey', candidate ->> 'resolutionGroupKey', 'decision', p_decision,
      'masterSourceId', master.source_id, 'masterRevision', master.revision,
      'studentsVersion', students_state.version, 'sourceRows', source_rows,
      'selectedSourceRow', selected_source_row, 'selectedStatus', selected_status,
      'selectedStudentId', selected_student_id)
  );
  insert into internal.student_import_master_duplicate_resolutions (
    resolution_key, resolution_group_key, master_source_id, master_revision,
    students_version, decision, source_rows, selected_source_row, selected_status,
    selected_student_id, confirmed_by, confirmed_at, audit_id
  ) values (
    p_resolution_key, candidate ->> 'resolutionGroupKey', master.source_id, master.revision,
    students_state.version, p_decision, source_rows, selected_source_row, selected_status,
    selected_student_id, left(trim(p_actor), 120), now(), audit_entry_id
  );
  snapshot := internal.student_import_master_duplicate_snapshot(master, students_state);
  return jsonb_build_object('resolutionKey', p_resolution_key, 'decision', p_decision,
    'fingerprint', snapshot ->> 'fingerprint', 'unchanged', false);
end;
$$;


-- Keep the clear-only compatibility RPC in the same singleton mutex.
create or replace function public.put_student_import_identity_links(
  p_secret text,
  p_source_revisions jsonb,
  p_links jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  canonical_links jsonb;
  fingerprint text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or p_source_revisions - 'master' - 'jwb' <> '{}'::jsonb
     or jsonb_typeof(p_source_revisions -> 'master') <> 'string'
     or nullif(trim(p_source_revisions ->> 'master'), '') is null
     or length(trim(p_source_revisions ->> 'master')) > 240
     or jsonb_typeof(p_source_revisions -> 'jwb') <> 'string'
     or nullif(trim(p_source_revisions ->> 'jwb'), '') is null
     or length(trim(p_source_revisions ->> 'jwb')) > 240
     or jsonb_typeof(p_links) <> 'array'
     or jsonb_array_length(p_links) <> 0
     or exists (
       select 1 from jsonb_array_elements(p_links) link
       where jsonb_typeof(link) <> 'object'
          or link - 'masterSourceRow' - 'jwbSourceRow' - 'studentId' <> '{}'::jsonb
          or jsonb_typeof(link -> 'masterSourceRow') not in ('string', 'number')
          or nullif(trim(link ->> 'masterSourceRow'), '') is null
          or length(trim(link ->> 'masterSourceRow')) > 240
          or (jsonb_typeof(link -> 'masterSourceRow') = 'number'
            and (
              (link ->> 'masterSourceRow')::numeric <> trunc((link ->> 'masterSourceRow')::numeric)
              or abs((link ->> 'masterSourceRow')::numeric) > 9007199254740991
            ))
          or jsonb_typeof(link -> 'studentId') <> 'string'
          or nullif(trim(link ->> 'studentId'), '') is null
          or length(trim(link ->> 'studentId')) > 240
          or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') not in ('string', 'number', 'null'))
          or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
            and nullif(trim(link ->> 'jwbSourceRow'), '') is null)
          or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
            and length(trim(link ->> 'jwbSourceRow')) > 240)
          or (jsonb_typeof(link -> 'jwbSourceRow') = 'number'
            and (
              (link ->> 'jwbSourceRow')::numeric <> trunc((link ->> 'jwbSourceRow')::numeric)
              or abs((link ->> 'jwbSourceRow')::numeric) > 9007199254740991
            ))
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_links';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_identity_link_set:singleton', 0
  ));

  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb' for update;
  select * into master from internal.student_import_source_rows s where s.source_kind = 'master' for update;
  select * into saved from internal.student_import_identity_link_sets l where l.singleton for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if master.revision <> p_source_revisions ->> 'master'
     or jwb.revision <> p_source_revisions ->> 'jwb' then
    raise exception using errcode = '40001', message = 'student_import_source_changed';
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  if (select count(*) from jsonb_array_elements(p_links)) <>
       (select count(distinct link ->> 'masterSourceRow') from jsonb_array_elements(p_links) link)
     or (select count(*) from jsonb_array_elements(p_links)
         where value ? 'jwbSourceRow' and jsonb_typeof(value -> 'jwbSourceRow') <> 'null') <>
       (select count(distinct link ->> 'jwbSourceRow') from jsonb_array_elements(p_links) link
        where link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null')
     or (select count(*) from jsonb_array_elements(p_links)) <>
       (select count(distinct link ->> 'studentId') from jsonb_array_elements(p_links) link)
     or exists (
       select 1 from jsonb_array_elements(p_links) link
       where not exists (
         select 1 from jsonb_array_elements(master.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'masterSourceRow'
           and source_row ->> 'status' <> '不活跃 + 无课时'
       )
       or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null' and not exists (
         select 1 from jsonb_array_elements(jwb.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'jwbSourceRow'
       ))
       or not exists (
         select 1 from jsonb_array_elements(students_state.payload) student
         where student ->> 'id' = link ->> 'studentId'
       )
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_link_reference';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'masterSourceRow', link -> 'masterSourceRow',
    'studentId', trim(link ->> 'studentId'),
    'jwbSourceRow', case
      when link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
      then link -> 'jwbSourceRow' else null end
  )) order by link ->> 'masterSourceRow'), '[]'::jsonb)
  into canonical_links
  from jsonb_array_elements(p_links) link;
  fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', canonical_links
  )::text, 'sha256'), 'hex');
  if saved.singleton
     and saved.link_fingerprint = fingerprint
     and saved.students_version = students_state.version then
    return jsonb_build_object('fingerprint', fingerprint, 'count', saved.link_count, 'unchanged', true);
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_links_replaced', p_actor, 'student_import_identity_links',
    fingerprint, jsonb_build_object('linkCount', jsonb_array_length(canonical_links))
  );
  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, links, link_count, link_fingerprint, updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, canonical_links, jsonb_array_length(canonical_links), fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;
  return jsonb_build_object('fingerprint', fingerprint, 'count', jsonb_array_length(canonical_links), 'unchanged', false);
end;
$$;

revoke all on function public.put_student_import_identity_links(text, jsonb, jsonb, text)
  from public, anon, authenticated;

-- Deliberately do not grant the legacy clear-only RPC. Rolling old server
-- instances must fail closed because their revision-only request is not a
-- revocation-safe compare-and-swap and does not advance review_epoch.

create or replace function public.clear_student_import_identity_links(
  p_secret text,
  p_resolution_key text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text := 'sha256:' || repeat('0', 64);
  empty_fingerprint text;
  expected_key text;
  current_epoch bigint;
  next_epoch bigint;
  audit_entry_id uuid;
  was_empty boolean;
  unbound_duplicate_count integer := 0;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_clear_request';
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
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;

  current_epoch := coalesce(saved.review_epoch, 0);
  if current_epoch < 0 or current_epoch >= 9007199254740991 then
    raise exception using errcode = '54000',
      message = 'student_import_identity_review_epoch_exhausted';
  end if;
  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    active_links := saved.links;
    active_fingerprint := saved.link_fingerprint;
  end if;

  -- A lost response may retry the exact clear. It is safe to acknowledge only
  -- while the same current set is still empty; any intervening add makes this
  -- branch false, so an old clear can never delete later work.
  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version
     and saved.link_count = 0
     and saved.last_clear_key = p_resolution_key then
    return jsonb_build_object(
      'fingerprint', saved.link_fingerprint,
      'count', 0,
      'unchanged', true,
      'reviewEpoch', saved.review_epoch
    );
  end if;

  expected_key := internal.student_import_identity_clear_key(
    master.source_id, master.revision,
    jwb.source_id, jwb.revision,
    students_state.version, current_epoch, active_fingerprint
  );
  if expected_key <> p_resolution_key then
    raise exception using errcode = '23503',
      message = 'student_import_identity_review_unavailable';
  end if;

  was_empty := jsonb_array_length(active_links) = 0;
  next_epoch := current_epoch + 1;
  empty_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', '[]'::jsonb
  )::text, 'sha256'), 'hex');

  -- Duplicate-row decisions keep the chosen source row, but a selected target
  -- identity is link-derived evidence. Unbind it atomically with clear so the
  -- chosen row immediately becomes eligible for a fresh identity review.
  update internal.student_import_master_duplicate_resolutions resolution set
    selected_student_id = null
  where resolution.master_source_id = master.source_id
    and resolution.master_revision = master.revision
    and resolution.students_version = students_state.version
    and resolution.selected_student_id is not null;
  get diagnostics unbound_duplicate_count = row_count;

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_links_cleared', p_actor,
    'student_import_identity_links', p_resolution_key,
    jsonb_build_object(
      'clearKey', p_resolution_key,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'studentsVersion', students_state.version,
      'previousLinkCount', jsonb_array_length(active_links),
      'previousLinkFingerprint', active_fingerprint,
      'linkFingerprint', empty_fingerprint,
      'reviewEpochBefore', current_epoch,
      'reviewEpochAfter', next_epoch,
      'unboundDuplicateDecisionCount', unbound_duplicate_count
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, last_clear_key,
    links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, next_epoch, p_resolution_key,
    '[]'::jsonb, 0, empty_fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    review_epoch = excluded.review_epoch,
    last_clear_key = excluded.last_clear_key,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;

  return jsonb_build_object(
    'fingerprint', empty_fingerprint,
    'count', 0,
    'unchanged', was_empty,
    'reviewEpoch', next_epoch
  );
end;
$$;

revoke all on function public.clear_student_import_identity_links(text, text, text)
  from public, anon, authenticated;
grant execute on function public.clear_student_import_identity_links(text, text, text)
  to anon, authenticated;

revoke all on function public.put_student_import_identity_review_decision(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.put_student_import_identity_review_decision(text, text, text, text)
  to anon, authenticated;

revoke all on function public.put_student_import_identity_review_pair(
  text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.put_student_import_identity_review_pair(
  text, text, text, text, text, text, text
) to anon, authenticated;

-- Read-only capability probe used by GET before it displays any review UI.
-- Because migrations are atomic, this function exists only with the complete
-- clear + automatic decision + HMAC manual-pair contract above.
create or replace function public.get_student_import_identity_review_contract(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  return jsonb_build_object(
    'contractVersion', 2,
    'manualTokens', 'hmac-sha256',
    'clearCas', true
  );
end;
$$;

revoke all on function public.get_student_import_identity_review_contract(text)
  from public, anon, authenticated;
grant execute on function public.get_student_import_identity_review_contract(text)
  to anon, authenticated;

-- A reviewed create option may introduce only the exact deterministic master ID.
create or replace function internal.student_import_canonical_projection(
  p_master_source_id text,
  p_resolved_master_rows jsonb,
  p_jwb_rows jsonb,
  p_current_students jsonb,
  p_identity_links jsonb,
  p_referenced_student_ids jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  master_item record;
  row_value jsonb;
  raw_source_key text;
  master_key text;
  student_id text;
  clean_name text;
  name_key text;
  existing_student jsonb;
  matched_jwb jsonb;
  identity_link jsonb;
  formal_students jsonb := '[]'::jsonb;
  manual_trials jsonb := '[]'::jsonb;
  referenced_archives jsonb := '[]'::jsonb;
  used_student_ids text[] := array[]::text[];
  defaults_input jsonb;
  record_value jsonb;
  existing_packages jsonb;
  manual_packages jsonb;
  existing_jwb_packages jsonb;
  authoritative_packages jsonb;
  jwb_packages jsonb;
  lesson_packages jsonb;
  package_coverage text;
  totals jsonb;
  source_remaining numeric;
  source_contract numeric;
  master_name_count integer;
  jwb_name_count integer;
  linked boolean;
  preserve_existing_aggregate boolean;
begin
  -- These are the complete DB-owned fields stripped from every unmanaged
  -- overlay: 'id', 'name', 'status', 'sourceRow', 'masterSourceKey',
  -- 'importSource', 'jwbMatchStatus', 'jwbSourceRow', 'remainingHours',
  -- 'contractHours', 'contractEffectiveDate', 'lessonPackages',
  -- 'packageCoverage', 'importArchived', 'importArchivedReason'. Master
  -- attributes overlay location, year, owner and planner after existing/JWB
  -- unmanaged values. formal sourceRow order is followed by manual_trial
  -- order by student_id, then referenced_history order by student_id.
  -- Authoritative lessonPackages are delegated to the fail-closed helper,
  -- which derives every student_import_package_id and student_import_purchase_id;
  -- within purchaseRecords it uses WITH ORDINALITY (purchase_position) and
  -- retains the source_position instead of sorting either nested ledger;
  -- each purchaseRecords ledger is paired with the package consumedHours.
  if nullif(trim(p_master_source_id), '') is null
     or jsonb_typeof(p_resolved_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_current_students) <> 'array'
     or jsonb_typeof(p_identity_links) <> 'array'
     or jsonb_typeof(p_referenced_student_ids) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_student_import_projection_input';
  end if;

  if (select count(*) from jsonb_array_elements(p_resolved_master_rows)) <>
     (select count(distinct internal.student_import_source_key(row -> 'sourceRow'))
      from jsonb_array_elements(p_resolved_master_rows) row)
     or (select count(*) from jsonb_array_elements(p_jwb_rows)) <>
     (select count(distinct internal.student_import_source_key(row -> 'sourceRow'))
      from jsonb_array_elements(p_jwb_rows) row)
     or exists (
       select 1 from jsonb_array_elements(p_referenced_student_ids) reference
       where jsonb_typeof(reference) <> 'string' or nullif(trim(reference #>> '{}'), '') is null
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_projection_keys';
  end if;

  -- Validate every locked JWB package ledger, including unmatched rows. A
  -- malformed nested row can therefore never hide outside the master roster.
  perform internal.student_import_canonical_jwb_packages(
    'STU-JWB-VALIDATION', jwb -> 'lessonPackages'
  )
  from jsonb_array_elements(p_jwb_rows) jwb
  where jwb ? 'lessonPackages';

  if exists (
    select 1 from jsonb_array_elements(p_identity_links) link
    where jsonb_typeof(link) <> 'object'
       or link - 'masterSourceRow' - 'studentId' - 'jwbSourceRow' <> '{}'::jsonb
       or internal.student_import_source_key(link -> 'masterSourceRow') is null
       or jsonb_typeof(link -> 'studentId') <> 'string'
       or nullif(trim(link ->> 'studentId'), '') is null
       or (link ? 'jwbSourceRow' and internal.student_import_source_key(link -> 'jwbSourceRow') is null)
  ) or (
    select count(*) from jsonb_array_elements(p_identity_links)
  ) <> (
    select count(distinct internal.student_import_source_key(link -> 'masterSourceRow'))
    from jsonb_array_elements(p_identity_links) link
  ) or (
    select count(*) from jsonb_array_elements(p_identity_links)
  ) <> (
    select count(distinct trim(link ->> 'studentId'))
    from jsonb_array_elements(p_identity_links) link
  ) or (
    select count(*) from jsonb_array_elements(p_identity_links) link where link ? 'jwbSourceRow'
  ) <> (
    select count(distinct internal.student_import_source_key(link -> 'jwbSourceRow'))
    from jsonb_array_elements(p_identity_links) link where link ? 'jwbSourceRow'
  ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_links';
  end if;

  for master_item in
    select item.value, item.position,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key
    from jsonb_array_elements(p_resolved_master_rows) with ordinality item(value, position)
    order by internal.student_import_utf16_sort_key(
      internal.student_import_source_key(item.value -> 'sourceRow')
    )
  loop
    row_value := master_item.value;
    raw_source_key := master_item.source_key;
    clean_name := internal.student_import_display_name(row_value ->> 'name');
    if jsonb_typeof(row_value) <> 'object'
       or raw_source_key is null or length(raw_source_key) not between 1 and 240
       or row_value ->> 'status' not in (
         '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
         '不活跃 + 有课时', '在读 + 加课待排'
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_master_projection_row';
    end if;
    if clean_name = '' or row_value ->> 'status' = '不活跃 + 无课时' then
      continue;
    end if;
    if (select count(*) from jsonb_array_elements(p_resolved_master_rows) candidate
        where internal.student_import_source_key(candidate -> 'sourceRow') = raw_source_key) <> 1 then
      raise exception using errcode = '22023', message = 'duplicate_student_import_master_source_key';
    end if;

    master_key := internal.student_import_master_source_key(p_master_source_id, row_value -> 'sourceRow');
    student_id := internal.student_import_student_id(p_master_source_id, row_value -> 'sourceRow');
    identity_link := null;
    select link into identity_link
    from jsonb_array_elements(p_identity_links) link
    where internal.student_import_source_key(link -> 'masterSourceRow') = raw_source_key;
    linked := identity_link is not null;
    if linked then
      student_id := trim(identity_link ->> 'studentId');
    end if;

    existing_student := null;
    select student into existing_student
    from jsonb_array_elements(p_current_students) student
    where student ->> 'id' = student_id
      and (linked or (
        student ->> 'masterSourceKey' = master_key
        and student ->> 'id' = internal.student_import_student_id(p_master_source_id, row_value -> 'sourceRow')
      ));
    if linked and existing_student is null
       and student_id <> internal.student_import_student_id(
         p_master_source_id, row_value -> 'sourceRow'
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_linked_identity';
    end if;

    name_key := internal.student_import_name_key(clean_name);
    matched_jwb := null;
    if linked and identity_link ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(identity_link -> 'jwbSourceRow');
      if matched_jwb is null then
        raise exception using errcode = '22023', message = 'invalid_student_import_linked_jwb';
      end if;
    elsif not linked then
      select count(*) into master_name_count
      from jsonb_array_elements(p_resolved_master_rows) candidate
      where internal.student_import_display_name(candidate ->> 'name') <> ''
        and candidate ->> 'status' <> '不活跃 + 无课时'
        and internal.student_import_name_key(candidate ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where internal.student_import_source_key(link -> 'masterSourceRow') =
            internal.student_import_source_key(candidate -> 'sourceRow')
        );
      select count(*) into jwb_name_count
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_display_name(jwb ->> 'name') <> ''
        and internal.student_import_name_key(jwb ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where link ? 'jwbSourceRow'
            and internal.student_import_source_key(link -> 'jwbSourceRow') =
              internal.student_import_source_key(jwb -> 'sourceRow')
        );
      if master_name_count = 1 and jwb_name_count = 1 then
        select jwb into matched_jwb
        from jsonb_array_elements(p_jwb_rows) jwb
        where internal.student_import_name_key(jwb ->> 'name') = name_key
          and not exists (
            select 1 from jsonb_array_elements(p_identity_links) link
            where link ? 'jwbSourceRow'
              and internal.student_import_source_key(link -> 'jwbSourceRow') =
                internal.student_import_source_key(jwb -> 'sourceRow')
          );
      end if;
    else
      master_name_count := 1;
      jwb_name_count := 0;
    end if;

    existing_packages := case when jsonb_typeof(existing_student -> 'lessonPackages') = 'array'
      then existing_student -> 'lessonPackages' else '[]'::jsonb end;
    select coalesce(jsonb_agg(value order by position), '[]'::jsonb) into manual_packages
    from jsonb_array_elements(existing_packages) with ordinality package(value, position)
    where coalesce(value ->> 'id', '') not like 'PKG-JWB-%';
    select coalesce(jsonb_agg(value order by position), '[]'::jsonb) into existing_jwb_packages
    from jsonb_array_elements(existing_packages) with ordinality package(value, position)
    where coalesce(value ->> 'id', '') like 'PKG-JWB-%';

    authoritative_packages := null;
    if matched_jwb is not null and matched_jwb ? 'lessonPackages' then
      authoritative_packages := internal.student_import_canonical_jwb_packages(
        student_id, matched_jwb -> 'lessonPackages'
      );
    end if;
    if matched_jwb is not null and matched_jwb ? 'packageCoverage' then
      package_coverage := matched_jwb ->> 'packageCoverage';
    elsif authoritative_packages is not null and jsonb_array_length(authoritative_packages) > 0 then
      package_coverage := 'complete';
    elsif jsonb_array_length(existing_jwb_packages) > 0 then
      package_coverage := case when existing_student ->> 'packageCoverage' in ('complete', 'partial', 'none')
        then existing_student ->> 'packageCoverage' else 'partial' end;
    elsif existing_student ->> 'packageCoverage' in ('complete', 'partial', 'none') then
      package_coverage := existing_student ->> 'packageCoverage';
    else
      package_coverage := 'none';
    end if;
    preserve_existing_aggregate := matched_jwb is null
      and existing_student ->> 'packageCoverage' in ('partial', 'none');
    if matched_jwb is not null
       and jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
       and (matched_jwb ->> 'remainingHours')::numeric < 0
       and package_coverage <> 'none' then
      raise exception using errcode = '22023', message = 'student_import_package_balance_mismatch';
    end if;
    if authoritative_packages is not null then
      jwb_packages := authoritative_packages;
    elsif matched_jwb is not null
          and (matched_jwb ? 'packageCoverage' or matched_jwb ? 'lessonPackages') then
      jwb_packages := '[]'::jsonb;
    else
      jwb_packages := existing_jwb_packages;
    end if;
    lesson_packages := manual_packages || jwb_packages;
    -- remainingHours/contractHours are Jiaowubao aggregates. Preserve manual
    -- packages in the visible ledger without adding them to that source total.
    totals := case when jsonb_array_length(jwb_packages) > 0
      then internal.student_import_package_totals(jwb_packages) else null end;
    if authoritative_packages is not null and jsonb_array_length(authoritative_packages) > 0 then
      if package_coverage = 'complete'
         and jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
         and floor((matched_jwb ->> 'remainingHours')::numeric * 1000000 + 0.5) / 1000000 <>
           (internal.student_import_package_totals(authoritative_packages) ->> 'remainingHours')::numeric then
        raise exception using errcode = '22023', message = 'student_import_package_balance_mismatch';
      end if;
      if package_coverage = 'complete'
         and jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
         and floor((matched_jwb ->> 'contractHours')::numeric * 1000000 + 0.5) / 1000000 <>
           (internal.student_import_package_totals(authoritative_packages) ->> 'contractHours')::numeric then
        raise exception using errcode = '22023', message = 'student_import_package_balance_mismatch';
      end if;
    end if;

    defaults_input := jsonb_build_object('name', clean_name)
      || coalesce(row_value -> 'attributes', '{}'::jsonb);
    record_value := internal.student_import_defaults(defaults_input)
      || internal.student_import_copy_unmanaged(existing_student)
      || internal.student_import_copy_unmanaged(matched_jwb -> 'attributes')
      || internal.student_import_copy_unmanaged(row_value -> 'attributes')
      || jsonb_build_object(
        'id', student_id,
        'name', clean_name,
        'status', row_value ->> 'status',
        'sourceRow', row_value -> 'sourceRow',
        'masterSourceKey', master_key,
        'importSource', 'master',
        'jwbMatchStatus', case
          when not linked and (master_name_count > 1 or jwb_name_count > 1) then 'ambiguous'
          when matched_jwb is not null then 'matched'
          else 'unmatched'
        end
      );
    if matched_jwb is not null then
      record_value := record_value || jsonb_build_object('jwbSourceRow', matched_jwb -> 'sourceRow');
    end if;
    if (matched_jwb is not null and matched_jwb ? 'packageCoverage')
       or jsonb_array_length(jwb_packages) > 0
       or existing_student ->> 'packageCoverage' in ('complete', 'partial', 'none') then
      record_value := record_value || jsonb_build_object('packageCoverage', package_coverage);
    end if;
    source_remaining := case when jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
      then (matched_jwb ->> 'remainingHours')::numeric
      when preserve_existing_aggregate and jsonb_typeof(existing_student -> 'remainingHours') = 'number'
      then (existing_student ->> 'remainingHours')::numeric
      else null end;
    source_contract := case when jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
      then (matched_jwb ->> 'contractHours')::numeric
      when preserve_existing_aggregate and jsonb_typeof(existing_student -> 'contractHours') = 'number'
      then (existing_student ->> 'contractHours')::numeric
      else null end;
    if source_remaining is not null then
      record_value := record_value || jsonb_build_object('remainingHours', source_remaining);
    elsif totals is not null then
      record_value := record_value || jsonb_build_object('remainingHours', (totals ->> 'remainingHours')::numeric);
    end if;
    if source_contract is not null then
      record_value := record_value || jsonb_build_object('contractHours', source_contract);
    elsif totals is not null then
      record_value := record_value || jsonb_build_object('contractHours', (totals ->> 'contractHours')::numeric);
    end if;
    if matched_jwb is not null
       and jsonb_typeof(matched_jwb -> 'contractEffectiveDate') = 'string'
       and trim(matched_jwb ->> 'contractEffectiveDate') <> '' then
      record_value := record_value || jsonb_build_object(
        'contractEffectiveDate', trim(matched_jwb ->> 'contractEffectiveDate')
      );
    end if;
    if jsonb_array_length(lesson_packages) > 0 then
      record_value := record_value || jsonb_build_object('lessonPackages', lesson_packages);
    end if;
    formal_students := formal_students || jsonb_build_array(record_value);
    used_student_ids := array_append(used_student_ids, student_id);
  end loop;

  select coalesce(jsonb_agg(internal.student_import_canonical_manual_trial(student)
    order by internal.student_import_utf16_sort_key(student ->> 'id')), '[]'::jsonb)
  into manual_trials
  from jsonb_array_elements(p_current_students) student
  where internal.student_import_is_manual_trial(student)
    and not (student ->> 'id' = any(used_student_ids));

  select coalesce(jsonb_agg(internal.student_import_canonical_archive(student)
    order by internal.student_import_utf16_sort_key(student ->> 'id')), '[]'::jsonb)
  into referenced_archives
  from jsonb_array_elements(p_current_students) student
  where student ->> 'id' in (
      select value #>> '{}' from jsonb_array_elements(p_referenced_student_ids) value
    )
    and not (student ->> 'id' = any(used_student_ids))
    and not internal.student_import_is_manual_trial(student);

  record_value := formal_students || manual_trials || referenced_archives;
  if jsonb_array_length(record_value) <>
     (select count(distinct student ->> 'id') from jsonb_array_elements(record_value) student) then
    raise exception using errcode = '22023', message = 'duplicate_student_import_projection_id';
  end if;
  return record_value;
end;
$$;

revoke all on function internal.student_import_canonical_projection(text, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

create or replace function internal.student_import_identity_coverage_ready(p_students jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_students) = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(p_students) imported_student
      where imported_student ->> 'importSource' = 'master'
        and coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
        and imported_student ->> 'status' in (
          '在读', '活跃 + 有课时', '不活跃 + 有课时', '在读 + 加课待排'
        )
        and coalesce(imported_student ->> 'jwbMatchStatus', '') <> 'matched'
    )
$$;

-- The final write boundary consumes the same nonempty, version-bound link set.
create or replace function public.commit_student_import_plan_atomic(
  p_secret text,
  p_plan_fingerprint text,
  p_expected_student_version bigint,
  p_source_revisions jsonb,
  p_students jsonb,
  p_actor text
)
returns table (
  entity text,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state public.ops_state%rowtype;
  duplicate_decision_state public.ops_state%rowtype;
  booking_state public.ops_state%rowtype;
  locked_state public.ops_state%rowtype;
  prior internal.student_import_commits%rowtype;
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  duplicate_snapshot jsonb;
  carried_duplicate_snapshot jsonb;
  replayed_duplicate_decisions jsonb;
  replayed_duplicate_candidates jsonb;
  next_duplicate_candidates jsonb;
  carried_decision jsonb;
  next_duplicate_candidate jsonb;
  next_duplicate_option jsonb;
  prior_duplicate_resolution internal.student_import_master_duplicate_resolutions%rowtype;
  fu_attachment_snapshot jsonb;
  resolved_master_rows jsonb;
  referenced_student_ids jsonb;
  expected_students jsonb;
  reference_entities constant text[] := array[
    'bookings', 'files', 'lpItems', 'messages', 'operations',
    'payroll', 'renewals', 'students', 'tasks'
  ];
  locked_state_count integer := 0;
  referenced_removed_student_id text;
  referenced_removed_package_reference_id text;
  student_item jsonb;
  lesson_package_item jsonb;
  purchase_item jsonb;
  package_total numeric;
  package_consumed numeric;
  booking_item jsonb;
  next_booking jsonb;
  override_item jsonb;
  next_overrides jsonb;
  next_bookings jsonb := '[]'::jsonb;
  matching_package_ids text[];
  override_matching_package_ids text[];
  booking_subject text;
  override_student_id text;
  override_subject text;
  override_effective_date text;
  override_changes_assignment boolean;
  override_is_eligible boolean;
  booking_changed boolean;
  booking_backfilled boolean;
  parent_package_backfilled boolean;
  backfilled_booking_ids jsonb := '[]'::jsonb;
  unresolved_booking_ids jsonb := '[]'::jsonb;
  students_hash text;
  bookings_hash text;
  expected_bookings_version bigint;
  audit_entry_id uuid;
  replaying_prior boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_student_version is null or p_expected_student_version < 1
     or p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or p_source_revisions - 'master' - 'jwb' - 'identityLinks'
          - 'masterDuplicateResolutions' - 'fuAttachments' - 'bookingsVersion' <> '{}'::jsonb
     or jsonb_typeof(p_source_revisions -> 'master') <> 'string'
     or nullif(p_source_revisions ->> 'master', '') is null
     or length(trim(p_source_revisions ->> 'master')) > 240
     or jsonb_typeof(p_source_revisions -> 'jwb') <> 'string'
     or nullif(p_source_revisions ->> 'jwb', '') is null
     or length(trim(p_source_revisions ->> 'jwb')) > 240
     or jsonb_typeof(p_source_revisions -> 'identityLinks') <> 'string'
     or coalesce(p_source_revisions ->> 'identityLinks', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_source_revisions -> 'masterDuplicateResolutions') <> 'string'
     or coalesce(p_source_revisions ->> 'masterDuplicateResolutions', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_source_revisions -> 'fuAttachments') <> 'string'
     or coalesce(p_source_revisions ->> 'fuAttachments', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_source_revisions -> 'bookingsVersion') <> 'number'
     or (p_source_revisions ->> 'bookingsVersion')::numeric < 0
     or (p_source_revisions ->> 'bookingsVersion')::numeric <>
       trunc((p_source_revisions ->> 'bookingsVersion')::numeric)
     or (p_source_revisions ->> 'bookingsVersion')::numeric > 9007199254740991
     or jsonb_typeof(p_students) <> 'array'
     or jsonb_array_length(p_students) < 1
     or jsonb_array_length(p_students) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_students) s
       where jsonb_typeof(s) <> 'object'
          or jsonb_typeof(s -> 'id') <> 'string'
          or nullif(trim(s ->> 'id'), '') is null
          or length(trim(s ->> 'id')) > 240
          or jsonb_typeof(s -> 'name') <> 'string'
          or nullif(trim(s ->> 'name'), '') is null
          or length(trim(s ->> 'name')) > 240
          or jsonb_typeof(s -> 'initials') <> 'string'
          or nullif(trim(s ->> 'initials'), '') is null
          or length(trim(s ->> 'initials')) > 24
          or jsonb_typeof(s -> 'owner') <> 'string'
          or nullif(trim(s ->> 'owner'), '') is null
          or length(trim(s ->> 'owner')) > 120
          or jsonb_typeof(s -> 'course') <> 'string'
          or nullif(trim(s ->> 'course'), '') is null
          or length(trim(s ->> 'course')) > 240
          or jsonb_typeof(s -> 'timezone') <> 'string'
          or nullif(trim(s ->> 'timezone'), '') is null
          or length(trim(s ->> 'timezone')) > 120
          or jsonb_typeof(s -> 'teacher') <> 'string'
          or nullif(trim(s ->> 'teacher'), '') is null
          or length(trim(s ->> 'teacher')) > 240
          or jsonb_typeof(s -> 'next') <> 'string'
          or nullif(trim(s ->> 'next'), '') is null
          or length(trim(s ->> 'next')) > 500
          or coalesce(s ->> 'nextTone', '') not in (
            'neutral', 'blue', 'green', 'amber', 'red', 'purple'
          )
          or not (s ? 'files')
          or jsonb_typeof(s -> 'files') <> 'number'
          or (s ->> 'files')::numeric <> trunc((s ->> 'files')::numeric)
          or (s ->> 'files')::numeric < 0
          or (s ->> 'files')::numeric > 1000000
          or (
            coalesce(s ->> 'importSource', '') <> 'manual_trial'
            and coalesce(s ->> 'status', '') not in (
              '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
              '不活跃 + 有课时', '在读 + 加课待排'
            )
          )
          or (
            s ? 'importArchived'
            and (
              jsonb_typeof(s -> 'importArchived') <> 'boolean'
              or (s ->> 'importArchived')::boolean is not true
              or s ->> 'importArchivedReason' <> 'referenced_history'
              or s ->> 'status' <> '不活跃 + 无课时'
            )
          )
          or (not (s ? 'importArchived') and s ? 'importArchivedReason')
     )
     or (select count(*) from jsonb_array_elements(p_students)) <>
        (select count(distinct s ->> 'id') from jsonb_array_elements(p_students) s)
     or exists (
       select 1
       from jsonb_array_elements(p_students) s
       where (s ? 'remainingHours' and jsonb_typeof(s -> 'remainingHours') <> 'number')
          or (s ? 'remainingHours' and s ? 'packageCoverage'
            and not internal.student_import_has_microhour_precision(s -> 'remainingHours'))
          or (s ? 'contractHours' and jsonb_typeof(s -> 'contractHours') <> 'number')
          or (s ? 'contractHours' and s ? 'packageCoverage'
            and not internal.student_import_has_microhour_precision(s -> 'contractHours'))
          or (s ? 'contractHours' and (s ->> 'contractHours')::numeric < 0)
          or (s ? 'packageCoverage'
            and coalesce(s ->> 'packageCoverage', '') not in ('complete', 'partial', 'none'))
          or (s ? 'lessonPackages' and jsonb_typeof(s -> 'lessonPackages') <> 'array')
          or (not (s ? 'packageCoverage') and exists (
            select 1
            from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
            where covered_package ->> 'id' like 'PKG-JWB-%'
          ))
          or (s ->> 'packageCoverage' in ('complete', 'partial') and not exists (
            select 1
            from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
            where covered_package ->> 'id' like 'PKG-JWB-%'
          ))
          or (s ->> 'packageCoverage' = 'none' and exists (
            select 1
            from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
            where covered_package ->> 'id' like 'PKG-JWB-%'
          ))
          or (
            s ? 'remainingHours'
            and (s ->> 'remainingHours')::numeric < 0
            and (
              coalesce(s ->> 'packageCoverage', '') <> 'none'
              or exists (
                select 1
                from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
                where covered_package ->> 'id' like 'PKG-JWB-%'
              )
            )
          )
  ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_commit';
  end if;
  expected_bookings_version := (p_source_revisions ->> 'bookingsVersion')::bigint;

  -- Revalidate the complete package ledger at the final database boundary.
  -- The API plan is server-owned, but a bad deploy or forged service request
  -- still must not be able to persist malformed balances or identities.
  for student_item in select value from jsonb_array_elements(p_students)
  loop
    if (select count(*) from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb))) <>
       (select count(distinct lesson_package ->> 'id')
        from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) lesson_package) then
      raise exception using errcode = '22023', message = 'invalid_student_import_package_ids';
    end if;
    for lesson_package_item in
      select value from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb))
    loop
      if jsonb_typeof(lesson_package_item) <> 'object'
         or lesson_package_item - 'id' - 'name' - 'subjectIds' - 'purchaseRecords' - 'consumedHours' <> '{}'::jsonb
         or jsonb_typeof(lesson_package_item -> 'id') <> 'string'
         or nullif(trim(lesson_package_item ->> 'id'), '') is null
         or length(trim(lesson_package_item ->> 'id')) > 240
         or jsonb_typeof(lesson_package_item -> 'name') <> 'string'
         or nullif(trim(lesson_package_item ->> 'name'), '') is null
         or length(trim(lesson_package_item ->> 'name')) > 240
         or jsonb_typeof(lesson_package_item -> 'subjectIds') <> 'array'
         or jsonb_array_length(lesson_package_item -> 'subjectIds') < 1
         or jsonb_array_length(lesson_package_item -> 'subjectIds') > 100
         or exists (
           select 1 from jsonb_array_elements(lesson_package_item -> 'subjectIds') subject
           where jsonb_typeof(subject) <> 'string'
              or nullif(trim(subject #>> '{}'), '') is null
              or length(trim(subject #>> '{}')) > 240
         )
         or (select count(*) from jsonb_array_elements(lesson_package_item -> 'subjectIds')) <>
            (select count(distinct trim(subject #>> '{}'))
             from jsonb_array_elements(lesson_package_item -> 'subjectIds') subject)
         or jsonb_typeof(lesson_package_item -> 'purchaseRecords') <> 'array'
         or jsonb_array_length(lesson_package_item -> 'purchaseRecords') < 1
         or jsonb_array_length(lesson_package_item -> 'purchaseRecords') > 1000
         or jsonb_typeof(lesson_package_item -> 'consumedHours') <> 'number'
         or (lesson_package_item ->> 'id' like 'PKG-JWB-%'
           and not internal.student_import_has_microhour_precision(lesson_package_item -> 'consumedHours'))
         or (lesson_package_item ->> 'consumedHours')::numeric < 0 then
        raise exception using errcode = '22023', message = 'invalid_student_import_package';
      end if;
      if (select count(*) from jsonb_array_elements(lesson_package_item -> 'purchaseRecords')) <>
         (select count(distinct purchase ->> 'id')
          from jsonb_array_elements(lesson_package_item -> 'purchaseRecords') purchase) then
        raise exception using errcode = '22023', message = 'invalid_student_import_purchase_ids';
      end if;
      package_total := 0;
      for purchase_item in select value from jsonb_array_elements(lesson_package_item -> 'purchaseRecords')
      loop
        if jsonb_typeof(purchase_item) <> 'object'
           or purchase_item - 'id' - 'purchasedAt' - 'hours' - 'note' <> '{}'::jsonb
           or jsonb_typeof(purchase_item -> 'id') <> 'string'
           or nullif(trim(purchase_item ->> 'id'), '') is null
           or length(trim(purchase_item ->> 'id')) > 240
           or jsonb_typeof(purchase_item -> 'purchasedAt') <> 'string'
           or nullif(trim(purchase_item ->> 'purchasedAt'), '') is null
           or trim(purchase_item ->> 'purchasedAt') !~
             '^(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T[0-2]\d:[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-][0-2]\d:[0-5]\d))$'
           or trim(purchase_item ->> 'purchasedAt')::timestamptz is null
           or jsonb_typeof(purchase_item -> 'hours') <> 'number'
           or (lesson_package_item ->> 'id' like 'PKG-JWB-%'
             and not internal.student_import_has_microhour_precision(purchase_item -> 'hours'))
           or (purchase_item ->> 'hours')::numeric <= 0
           or (purchase_item ? 'note' and jsonb_typeof(purchase_item -> 'note') <> 'string')
           or (purchase_item ? 'note' and length(purchase_item ->> 'note') > 1000) then
          raise exception using errcode = '22023', message = 'invalid_student_import_purchase';
        end if;
        package_total := package_total + (purchase_item ->> 'hours')::numeric;
      end loop;
      package_consumed := (lesson_package_item ->> 'consumedHours')::numeric;
    end loop;
    if student_item ->> 'packageCoverage' = 'complete'
       and coalesce((student_item ->> 'importArchived')::boolean, false) is false then
      select
        coalesce(sum((purchase ->> 'hours')::numeric), 0)
      into package_total
      from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) lesson_package
      cross join lateral jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
      where lesson_package ->> 'id' like 'PKG-JWB-%';
      select coalesce(sum((lesson_package ->> 'consumedHours')::numeric), 0)
      into package_consumed
      from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) lesson_package
      where lesson_package ->> 'id' like 'PKG-JWB-%';
      if not (student_item ? 'contractHours')
         or not (student_item ? 'remainingHours')
         or package_total <> (student_item ->> 'contractHours')::numeric
         or package_total - package_consumed <> (student_item ->> 'remainingHours')::numeric then
        raise exception using errcode = '22023', message = 'invalid_student_import_complete_package_balance';
      end if;
    end if;
  end loop;

  -- The attachment table is locked before the idempotency shortcut so even a
  -- replay must prove it was planned against the current distinct student IDs.
  lock table internal.student_fu_attachments in share mode;
  fu_attachment_snapshot := internal.student_fu_attachment_reference_snapshot();
  if fu_attachment_snapshot ->> 'fingerprint' <> p_source_revisions ->> 'fuAttachments' then
    raise exception using errcode = '40001', message = 'student_import_fu_attachments_changed';
  end if;

  -- SELECT FOR UPDATE cannot lock an absent idempotency row. Serialise the
  -- first insert and any lost-response replay for this exact plan fingerprint.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_commit:' || p_plan_fingerprint, 0
  ));
  select * into prior
  from internal.student_import_commits c
  where c.plan_fingerprint = p_plan_fingerprint
  for update;
  if found then
    if prior.master_revision <> p_source_revisions ->> 'master'
       or prior.jwb_revision <> p_source_revisions ->> 'jwb'
       or prior.identity_link_fingerprint <> p_source_revisions ->> 'identityLinks'
       or prior.master_duplicate_resolution_fingerprint <>
          p_source_revisions ->> 'masterDuplicateResolutions'
       or prior.fu_attachment_fingerprint <> p_source_revisions ->> 'fuAttachments'
       or prior.bookings_version_before <> expected_bookings_version then
      raise exception using errcode = '23505', message = 'student_import_fingerprint_conflict';
    end if;
    -- A matching request is only idempotent after the locked source and
    -- identity evidence below is revalidated. In particular, the reviewed
    -- link set remains bound to the pre-commit student version; a
    -- same-fingerprint row from another student snapshot is never reusable.
    replaying_prior := true;
  end if;

  -- Stable lock order: attachment table, idempotency row, both source rows,
  -- then every canonical state that can
  -- retain a studentId.  Locking the reference rows makes the orphan check
  -- below part of the same transaction as the students replacement.
  select * into jwb
  from internal.student_import_source_rows s
  where s.source_kind = 'jwb'
  for update;
  select * into master
  from internal.student_import_source_rows s
  where s.source_kind = 'master'
  for update;
  select * into link_set
  from internal.student_import_identity_link_sets l
  where l.singleton
  for update;
  for locked_state in
    select s.*
    from public.ops_state s
    where s.entity = any(reference_entities)
    order by array_position(reference_entities, s.entity)
    for update
  loop
    locked_state_count := locked_state_count + 1;
    if jsonb_typeof(locked_state.payload) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'student_reference_state_unavailable';
    end if;
    if locked_state.entity = 'students' then
      current_state := locked_state;
    elsif locked_state.entity = 'bookings' then
      booking_state := locked_state;
    end if;
  end loop;

  if locked_state_count <> cardinality(reference_entities) then
    raise exception using errcode = '55000',
      message = 'student_reference_state_unavailable';
  end if;

  if jwb.source_kind is null or master.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if master.revision <> p_source_revisions ->> 'master'
     or jwb.revision <> p_source_revisions ->> 'jwb' then
    raise exception using errcode = '40001', message = 'student_import_source_changed';
  end if;
  if replaying_prior
     and (
       prior.master_source_id is null
       or prior.jwb_source_id is null
       or prior.master_rows_sha256 is null
       or prior.jwb_rows_sha256 is null
       or prior.master_source_id <> master.source_id
       or prior.jwb_source_id <> jwb.source_id
       or prior.master_rows_sha256 <> master.rows_sha256
       or prior.jwb_rows_sha256 <> jwb.rows_sha256
     ) then
    raise exception using errcode = '40001', message = 'student_import_source_changed';
  end if;
  if current_state.entity is null or jsonb_typeof(current_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  if booking_state.entity is null or jsonb_typeof(booking_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'bookings_state_unavailable';
  end if;
  if (case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and (
         link_set.students_version = current_state.version
         or (
           replaying_prior
           and link_set.students_version = p_expected_student_version
         )
       )
        then link_set.link_fingerprint
        else 'sha256:' || repeat('0', 64)
      end) <> p_source_revisions ->> 'identityLinks' then
    raise exception using errcode = '40001', message = 'student_import_identity_links_changed';
  end if;
  if replaying_prior then
    if current_state.version <> prior.students_version
       or p_expected_student_version + 1 <> prior.students_version
       or encode(extensions.digest(current_state.payload::text, 'sha256'), 'hex') <>
          prior.students_sha256
       or p_students is distinct from current_state.payload
       or booking_state.version <> prior.bookings_version
       or encode(extensions.digest(booking_state.payload::text, 'sha256'), 'hex') <>
          prior.bookings_sha256 then
      raise exception using errcode = '40001', message = 'student_import_idempotent_state_changed';
    end if;
  elsif current_state.version <> p_expected_student_version
     or booking_state.version <> expected_bookings_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  -- Duplicate decisions are intentionally bound to the pre-commit students
  -- version. On a replay, reconstruct that exact decision-evidence version
  -- while retaining the locked post-commit payload for the canonical result
  -- proof below.
  duplicate_decision_state := current_state;
  if replaying_prior then
    duplicate_decision_state.version := p_expected_student_version;
    carried_duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
      master, current_state
    );
    replayed_duplicate_candidates := internal.student_import_master_duplicate_candidates(
      master, duplicate_decision_state
    );
    -- Resolution-group hashes include studentsVersion, so their lexical order
    -- may change after carry-forward. Reorder the carried decisions by the
    -- exact pre-commit group keys before reconstructing the old fingerprint.
    select coalesce(jsonb_agg(carried_decision_item.value
      order by old_candidate.value ->> 'resolutionGroupKey'), '[]'::jsonb)
    into replayed_duplicate_decisions
    from jsonb_array_elements(carried_duplicate_snapshot -> 'decisions')
      carried_decision_item(value)
    join jsonb_array_elements(replayed_duplicate_candidates)
      old_candidate(value)
      on old_candidate.value -> 'sourceRows' = carried_decision_item.value -> 'sourceRows';
    if jsonb_array_length(replayed_duplicate_decisions) <>
       jsonb_array_length(carried_duplicate_snapshot -> 'decisions') then
      raise exception using errcode = '55000',
        message = 'student_import_duplicate_replay_mapping_mismatch';
    end if;
    duplicate_snapshot := jsonb_build_object(
      'decisions', replayed_duplicate_decisions,
      'fingerprint', 'sha256:' || encode(extensions.digest(jsonb_build_object(
        'masterSourceId', master.source_id,
        'masterRevision', master.revision,
        'studentsVersion', p_expected_student_version,
        'decisions', replayed_duplicate_decisions
      )::text, 'sha256'), 'hex'),
      'candidates', replayed_duplicate_candidates
    );
  else
    duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
      master, duplicate_decision_state
    );
  end if;
  if duplicate_snapshot ->> 'fingerprint' <>
     p_source_revisions ->> 'masterDuplicateResolutions' then
    raise exception using errcode = '40001', message = 'student_import_master_duplicate_resolutions_changed';
  end if;
  if exists (
    select 1 from jsonb_array_elements(duplicate_snapshot -> 'candidates') candidate
    where not exists (
      select 1 from jsonb_array_elements(duplicate_snapshot -> 'decisions') decision
      where decision -> 'sourceRows' = candidate -> 'sourceRows'
    )
  ) then
    raise exception using errcode = '23503', message = 'student_import_master_duplicate_resolution_required';
  end if;
  select coalesce(jsonb_agg(resolved_row order by resolved_row ->> 'sourceRow'), '[]'::jsonb)
  into resolved_master_rows
  from (
    select case
      when decision ->> 'decision' = 'select'
       and row_value ->> 'sourceRow' = decision ->> 'selectedSourceRow'
       and nullif(decision ->> 'selectedStatus', '') is not null
      then jsonb_set(row_value, '{status}', to_jsonb(decision ->> 'selectedStatus'), true)
      else row_value end as resolved_row
    from jsonb_array_elements(master.rows) row_value
    left join lateral (
      select d.value as decision
      from jsonb_array_elements(duplicate_snapshot -> 'decisions') d(value)
      where exists (
        select 1 from jsonb_array_elements_text(d.value -> 'sourceRows') source_row
        where source_row = row_value ->> 'sourceRow'
      )
      limit 1
    ) matched on true
    where matched.decision is null
       or (matched.decision ->> 'decision' = 'select'
           and row_value ->> 'sourceRow' = matched.decision ->> 'selectedSourceRow')
  ) resolved;

  -- Build the archive preservation input exclusively from rows locked above.
  -- Booking occurrence overrides may carry a different student from the
  -- parent series, so both identities are independently retained.
  -- Canonical shape: jsonb_array_elements(bookings.occurrenceOverrides)
  -- exposes each override.studentId (implemented below with a guarded CASE).
  select coalesce(jsonb_agg(to_jsonb(reference.student_id)
    order by reference.student_id collate "C"), '[]'::jsonb)
  into referenced_student_ids
  from (
    select distinct referenced.student_id
    from (
      select trim(reference_item ->> 'studentId') as student_id
      from public.ops_state reference_state
      cross join lateral jsonb_array_elements(reference_state.payload) reference_item
      where reference_state.entity = any(reference_entities)
        and reference_state.entity <> 'students'

      union

      select trim(occurrence_override ->> 'studentId') as student_id
      from jsonb_array_elements(booking_state.payload) booking
      cross join lateral jsonb_array_elements(case
        when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
          then booking -> 'occurrenceOverrides'
        else '[]'::jsonb
      end) occurrence_override

      union

      select trim(attachment.student_id) as student_id
      from internal.student_fu_attachments attachment
    ) referenced
    where nullif(referenced.student_id, '') is not null
  ) reference;

  expected_students := internal.student_import_canonical_projection(
    master.source_id,
    resolved_master_rows,
    jwb.rows,
    current_state.payload,
    case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and (
         link_set.students_version = current_state.version
         or (
           replaying_prior
           and link_set.students_version = p_expected_student_version
         )
       )
      then link_set.links else '[]'::jsonb end,
    referenced_student_ids
  );
  if p_students is distinct from expected_students then
    raise exception using errcode = '23503', message = 'student_import_canonical_projection_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(expected_students) projected_student
    where projected_student ->> 'jwbMatchStatus' = 'ambiguous'
  ) then
    raise exception using errcode = '23503', message = 'student_import_ambiguous_projection';
  end if;
  if not internal.student_import_identity_coverage_ready(expected_students) then
    raise exception using errcode = '23503', message = 'student_import_identity_coverage_required';
  end if;
  students_hash := encode(extensions.digest(expected_students::text, 'sha256'), 'hex');
  if replaying_prior then
    return query select
      'students'::text,
      prior.students_version,
      prior.committed_at,
      prior.committed_by;
    return;
  end if;

  -- The commit boundary independently proves the authoritative formal roster.
  -- Every resolved eligible master row must map to exactly one active formal
  -- student and every active formal student must map back to exactly one row.
  -- Current reviewed links are the only exception to the namespaced derived ID;
  -- a reviewed create still proves the exact deterministic derived ID.
  if exists (
    select 1
    from jsonb_array_elements(resolved_master_rows) eligible_master_row
    where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
      and (
        select count(*)
        from jsonb_array_elements(expected_students) imported_student
        where coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
          and imported_student ->> 'importSource' = 'master'
          and imported_student ->> 'sourceRow' = eligible_master_row ->> 'sourceRow'
          and imported_student ->> 'name' =
            internal.student_import_display_name(eligible_master_row ->> 'name')
          and imported_student ->> 'status' = eligible_master_row ->> 'status'
          and imported_student ->> 'masterSourceKey' =
            internal.student_import_master_source_key(master.source_id, eligible_master_row -> 'sourceRow')
          and (
            imported_student ->> 'id' =
              internal.student_import_student_id(master.source_id, eligible_master_row -> 'sourceRow')
            or exists (
              select 1
              from jsonb_array_elements(case
                when link_set.singleton
                 and link_set.master_source_id = master.source_id
                 and link_set.master_revision = master.revision
                 and link_set.jwb_source_id = jwb.source_id
                 and link_set.jwb_revision = jwb.revision
                 and link_set.students_version = current_state.version
                then link_set.links else '[]'::jsonb end
              ) link
              where link ->> 'masterSourceRow' = eligible_master_row ->> 'sourceRow'
                and link ->> 'studentId' = imported_student ->> 'id'
            )
          )
      ) <> 1
  ) or exists (
    select 1
    from jsonb_array_elements(expected_students) imported_student
    where coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
      and imported_student ->> 'importSource' = 'master'
      and (
        select count(*)
        from jsonb_array_elements(resolved_master_rows) eligible_master_row
        where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
          and imported_student ->> 'sourceRow' = eligible_master_row ->> 'sourceRow'
          and imported_student ->> 'name' =
            internal.student_import_display_name(eligible_master_row ->> 'name')
          and imported_student ->> 'status' = eligible_master_row ->> 'status'
          and imported_student ->> 'masterSourceKey' =
            internal.student_import_master_source_key(master.source_id, eligible_master_row -> 'sourceRow')
          and (
            imported_student ->> 'id' =
              internal.student_import_student_id(master.source_id, eligible_master_row -> 'sourceRow')
            or exists (
              select 1
              from jsonb_array_elements(case
                when link_set.singleton
                 and link_set.master_source_id = master.source_id
                 and link_set.master_revision = master.revision
                 and link_set.jwb_source_id = jwb.source_id
                 and link_set.jwb_revision = jwb.revision
                 and link_set.students_version = current_state.version
                then link_set.links else '[]'::jsonb end
              ) link
              where link ->> 'masterSourceRow' = eligible_master_row ->> 'sourceRow'
                and link ->> 'studentId' = imported_student ->> 'id'
            )
          )
      ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'student_import_formal_identity_mismatch';
  end if;

  -- Manual trials are server-owned current-state records, not an import input.
  -- The formal plan may only preserve their exact canonical projection.  The
  -- omission cases mirror the domain: an exact current namespaced master ID or
  -- an active reviewed merge consumes that same ID and makes it the formal row.
  if exists (
    select 1
    from jsonb_array_elements(expected_students) imported_student
    where coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
      and coalesce(imported_student ->> 'importSource', '') <> 'master'
      and (
        coalesce(imported_student ->> 'importSource', '') <> 'manual_trial'
        or (
          select count(*)
          from jsonb_array_elements(current_state.payload) old_student
          where old_student ->> 'id' = imported_student ->> 'id'
            and internal.student_import_is_manual_trial(old_student)
            and imported_student = internal.student_import_canonical_manual_trial(old_student)
        ) <> 1
      )
  ) or exists (
    select 1
    from jsonb_array_elements(current_state.payload) old_student
    where internal.student_import_is_manual_trial(old_student)
      and (
        select count(*)
        from jsonb_array_elements(expected_students) imported_student
        where imported_student ->> 'id' = old_student ->> 'id'
          and coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
          and (
            (
              imported_student ->> 'importSource' = 'manual_trial'
              and imported_student = internal.student_import_canonical_manual_trial(old_student)
            )
            or (
              imported_student ->> 'importSource' = 'master'
              and (
                nullif(old_student ->> 'masterSourceKey', '') =
                  imported_student ->> 'masterSourceKey'
                or exists (
                  select 1
                  from jsonb_array_elements(case
                    when link_set.singleton
                     and link_set.master_source_id = master.source_id
                     and link_set.master_revision = master.revision
                     and link_set.jwb_source_id = jwb.source_id
                     and link_set.jwb_revision = jwb.revision
                     and link_set.students_version = current_state.version
                    then link_set.links else '[]'::jsonb end
                  ) reviewed_link
                  where reviewed_link ->> 'studentId' = old_student ->> 'id'
                    and reviewed_link ->> 'masterSourceRow' =
                      imported_student ->> 'sourceRow'
                )
              )
            )
          )
      ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'student_import_manual_trial_mismatch';
  end if;

  -- Archive markers are a narrow preservation mechanism for an excluded
  -- student whose stable ID is still retained by operational history.  They
  -- cannot be used to hide a new row, an active row, an unreferenced row, or
  -- an import-eligible master identity that the current plan must retain.
  if exists (
    select 1
    from jsonb_array_elements(expected_students) archived_student
    where archived_student ->> 'importArchived' = 'true'
      and (
        not exists (
          select 1 from jsonb_array_elements(current_state.payload) old_student
          where old_student ->> 'id' = archived_student ->> 'id'
        )
        or exists (
          select 1 from jsonb_array_elements(current_state.payload) old_student
          where old_student ->> 'id' = archived_student ->> 'id'
            and (
              internal.student_import_is_manual_trial(old_student)
              or archived_student <>
                internal.student_import_canonical_archive(old_student)
            )
        )
        or not exists (
          select 1
          from jsonb_array_elements_text(referenced_student_ids) referenced_student_id
          where referenced_student_id = archived_student ->> 'id'
        )
        or exists (
          select 1
          from jsonb_array_elements(resolved_master_rows) eligible_master_row
          where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
            and (
              -- A reviewed current identity link is the authoritative mapping
              -- for an existing canonical ID, including legacy/non-derived IDs.
              exists (
                select 1
                from jsonb_array_elements(case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = current_state.version
                  then link_set.links else '[]'::jsonb end
                ) link
                where link ->> 'studentId' = archived_student ->> 'id'
                  and link ->> 'masterSourceRow' = eligible_master_row ->> 'sourceRow'
              )
            )
        )
      )
  ) then
    raise exception using errcode = '23503', message = 'student_import_invalid_archive';
  end if;
  if link_set.singleton
     and link_set.master_source_id = master.source_id
     and link_set.master_revision = master.revision
     and link_set.jwb_source_id = jwb.source_id
     and link_set.jwb_revision = jwb.revision
     and link_set.students_version = current_state.version
     and exists (
       select 1
       from jsonb_array_elements(link_set.links) link
       where not exists (
         select 1 from jsonb_array_elements(master.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'masterSourceRow'
           and source_row ->> 'status' <> '不活跃 + 无课时'
       )
       or (link ? 'jwbSourceRow' and not exists (
         select 1 from jsonb_array_elements(jwb.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'jwbSourceRow'
       ))
       or (
         not exists (
           select 1 from jsonb_array_elements(current_state.payload) student
           where student ->> 'id' = link ->> 'studentId'
         )
         and link ->> 'studentId' <> internal.student_import_student_id(
           master.source_id, link -> 'masterSourceRow'
         )
       )
     ) then
    raise exception using errcode = '40001', message = 'student_import_identity_links_changed';
  end if;

  -- An import may update a student's attributes, but it must not make a
  -- currently referenced canonical student ID disappear.  Existing unrelated
  -- legacy orphans do not block the import because only IDs present in the
  -- locked pre-import students payload are considered here.
  select old_student ->> 'id'
  into referenced_removed_student_id
  from jsonb_array_elements(current_state.payload) old_student
  where nullif(trim(old_student ->> 'id'), '') is not null
    and not exists (
      select 1
      from jsonb_array_elements(expected_students) new_student
      where new_student ->> 'id' = old_student ->> 'id'
    )
    and exists (
      select 1
      from jsonb_array_elements_text(referenced_student_ids) referenced_student_id
      where referenced_student_id = old_student ->> 'id'
    )
  limit 1;
  if referenced_removed_student_id is not null then
    raise exception using errcode = '23503', message = 'student_import_referenced_student_removed';
  end if;

  -- Do not replace an existing package ledger while any series or occurrence
  -- still points at a package that the imported student currently owns. This
  -- guard only considers valid pre-import references, so unrelated legacy
  -- package orphans do not suddenly block an otherwise safe import.
  select referenced_id
  into referenced_removed_package_reference_id
  from (
    select 'booking:' || coalesce(booking ->> 'id', '') as referenced_id,
      booking ->> 'studentId' as referenced_student_id,
      booking ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(booking_state.payload) booking
    where nullif(trim(booking ->> 'packageId'), '') is not null

    union all

    select 'booking_override:' || coalesce(occurrence_override ->> 'occurrenceId', booking ->> 'id', '') as referenced_id,
      coalesce(
        nullif(trim(occurrence_override ->> 'studentId'), ''),
        booking ->> 'studentId'
      ) as referenced_student_id,
      occurrence_override ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(booking_state.payload) booking
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
          then booking -> 'occurrenceOverrides'
        else '[]'::jsonb
      end
    ) occurrence_override
    where nullif(trim(occurrence_override ->> 'packageId'), '') is not null

    union all

    select 'renewal:' || coalesce(reference_item ->> 'id', '') as referenced_id,
      reference_item ->> 'studentId' as referenced_student_id,
      reference_item ->> 'packageId' as referenced_package_id
    from public.ops_state reference_state
    cross join lateral jsonb_array_elements(reference_state.payload) reference_item
    where reference_state.entity = 'renewals'
      and nullif(trim(reference_item ->> 'packageId'), '') is not null

    union all

    select 'payroll:' || coalesce(reference_item ->> 'id', '') as referenced_id,
      reference_item ->> 'studentId' as referenced_student_id,
      reference_item ->> 'packageId' as referenced_package_id
    from public.ops_state reference_state
    cross join lateral jsonb_array_elements(reference_state.payload) reference_item
    where reference_state.entity = 'payroll'
      and nullif(trim(reference_item ->> 'packageId'), '') is not null

    union all

    select 'student_ledger:' || coalesce(ledger_item ->> 'id', '') as referenced_id,
      old_student ->> 'id' as referenced_student_id,
      ledger_item ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(current_state.payload) old_student
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(old_student -> 'lessonLedger') = 'array'
        then old_student -> 'lessonLedger' else '[]'::jsonb end
    ) ledger_item
    where nullif(trim(ledger_item ->> 'packageId'), '') is not null

    union all

    -- Renewal task anchors encode both identities. Decode the exact anchor
    -- components; other task rules are deliberately not treated as package refs.
    select 'task:' || coalesce(reference_item ->> 'id', '') as referenced_id,
      reference_item ->> 'studentId' as referenced_student_id,
      split_part(reference_item ->> 'anchorBookingId', ':', 3) as referenced_package_id
    from public.ops_state reference_state
    cross join lateral jsonb_array_elements(reference_state.payload) reference_item
    where reference_state.entity = 'tasks'
      and reference_item ->> 'ruleKey' = 'renewal.package-depletion'
      and reference_item ->> 'anchorBookingId' ~ '^renewal:[^:]+:[^:]+$'
      and split_part(reference_item ->> 'anchorBookingId', ':', 3) not like '%\%%'
  ) package_reference
  where exists (
    select 1
    from jsonb_array_elements(current_state.payload) old_student
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(old_student -> 'lessonPackages') = 'array'
          then old_student -> 'lessonPackages'
        else '[]'::jsonb
      end
    ) old_package
    where old_student ->> 'id' = package_reference.referenced_student_id
      and old_package ->> 'id' = package_reference.referenced_package_id
  )
  and not exists (
    select 1
    from jsonb_array_elements(expected_students) new_student
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(new_student -> 'lessonPackages') = 'array'
          then new_student -> 'lessonPackages'
        else '[]'::jsonb
      end
    ) new_package
    where new_student ->> 'id' = package_reference.referenced_student_id
      and new_package ->> 'id' = package_reference.referenced_package_id
  )
  limit 1;
  if referenced_removed_package_reference_id is not null then
    raise exception using errcode = '23503', message = 'student_import_referenced_package_removed';
  end if;

  -- Package activation is deliberately fail-closed. Parent series and future
  -- occurrence overrides are resolved independently: an override can change
  -- both student and subject, so copying the parent's package would cross the
  -- student ledger boundary. Existing explicit override package choices,
  -- including an explicit null, are never overwritten.
  for booking_item in
    select item
    from jsonb_array_elements(booking_state.payload) with ordinality as booking(item, position)
    order by position
  loop
    next_booking := booking_item;
    booking_changed := false;
    booking_backfilled := false;
    parent_package_backfilled := false;
    booking_subject := case
      when booking_item ? 'subjectId'
       and jsonb_typeof(booking_item -> 'subjectId') = 'string'
        then nullif(trim(booking_item ->> 'subjectId'), '')
      else nullif(trim(booking_item ->> 'course'), '')
    end;
    if jsonb_typeof(booking_item) = 'object'
       and nullif(trim(booking_item ->> 'id'), '') is not null
       and nullif(trim(booking_item ->> 'studentId'), '') is not null
       and coalesce(booking_item ->> 'kind', '') <> '试听'
       and (
         coalesce(booking_item ->> 'recurring', 'false') <> 'true'
         or not (booking_item ? 'repeatCount')
         or (
           jsonb_typeof(booking_item -> 'repeatCount') = 'number'
           and (booking_item ->> 'repeatCount')::numeric = trunc((booking_item ->> 'repeatCount')::numeric)
           and (booking_item ->> 'repeatCount')::numeric between 1 and 1000
         )
       ) then
      if nullif(trim(booking_item ->> 'packageId'), '') is null
         and booking_subject is not null
         and (
           coalesce(booking_item ->> 'recurring', 'false') = 'true'
           or (
             coalesce(booking_item ->> 'status', '') not in (
               '已完成', 'completed', 'cancelled', '已取消', 'leave', '请假'
             )
             and coalesce(booking_item ->> 'sourceTiming', '') <> '已结束'
           )
         )
         and coalesce(booking_item ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
         and (booking_item ->> 'date')::date >=
           (current_timestamp at time zone 'Australia/Melbourne')::date then
        select coalesce(array_agg(candidate.package_id order by candidate.package_id), array[]::text[])
        into matching_package_ids
        from (
          select lesson_package ->> 'id' as package_id
          from jsonb_array_elements(expected_students) imported_student
          cross join lateral jsonb_array_elements(
            case
              when jsonb_typeof(imported_student -> 'lessonPackages') = 'array'
                then imported_student -> 'lessonPackages'
              else '[]'::jsonb
            end
          ) lesson_package
          cross join lateral jsonb_array_elements_text(
            case
              when jsonb_typeof(lesson_package -> 'subjectIds') = 'array'
                then lesson_package -> 'subjectIds'
              else '[]'::jsonb
            end
          ) subject(subject_id)
          where imported_student ->> 'id' = booking_item ->> 'studentId'
            and coalesce((imported_student ->> 'importArchived')::boolean, false) is false
            and nullif(trim(lesson_package ->> 'id'), '') is not null
            and subject.subject_id = booking_subject
            and (
              select coalesce(sum((purchase ->> 'hours')::numeric), 0)
              from jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
            ) - (lesson_package ->> 'consumedHours')::numeric > 0
          group by lesson_package ->> 'id'
        ) candidate;

        if cardinality(matching_package_ids) = 1 then
          next_booking := jsonb_set(
            next_booking,
            '{packageId}',
            to_jsonb(matching_package_ids[1]),
            true
          );
          booking_changed := true;
          booking_backfilled := true;
          parent_package_backfilled := true;
        elsif not unresolved_booking_ids @> jsonb_build_array(booking_item ->> 'id') then
          unresolved_booking_ids := unresolved_booking_ids ||
            jsonb_build_array(booking_item ->> 'id');
        end if;
      elsif nullif(trim(booking_item ->> 'packageId'), '') is null
         and booking_subject is not null
         and coalesce(booking_item ->> 'recurring', 'false') = 'true'
         and coalesce(booking_item ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
         and (booking_item ->> 'date')::date <
           (current_timestamp at time zone 'Australia/Melbourne')::date
         and (
           not (booking_item ? 'repeatCount')
           or (booking_item ->> 'date')::date +
             (((booking_item ->> 'repeatCount')::integer - 1) * 7) >=
               (current_timestamp at time zone 'Australia/Melbourne')::date
         )
         and not unresolved_booking_ids @> jsonb_build_array(booking_item ->> 'id') then
        -- Adding a package to an already-started parent would retroactively
        -- relabel historical occurrences that inherit the parent fields.
        unresolved_booking_ids := unresolved_booking_ids ||
          jsonb_build_array(booking_item ->> 'id');
      end if;

      if jsonb_typeof(booking_item -> 'occurrenceOverrides') = 'array' then
        next_overrides := '[]'::jsonb;
        for override_item in
          select item
          from jsonb_array_elements(booking_item -> 'occurrenceOverrides')
            with ordinality as occurrence_override(item, position)
          order by position
        loop
          override_effective_date := case
            when override_item ? 'date'
             and jsonb_typeof(override_item -> 'date') = 'string'
              then nullif(trim(override_item ->> 'date'), '')
            else right(coalesce(override_item ->> 'occurrenceId', ''), 10)
          end;
          override_student_id := case
            when override_item ? 'studentId'
              then nullif(trim(override_item ->> 'studentId'), '')
            else nullif(trim(booking_item ->> 'studentId'), '')
          end;
          override_subject := case
            when override_item ? 'subjectId'
              then nullif(trim(override_item ->> 'subjectId'), '')
            else booking_subject
          end;
          override_changes_assignment :=
            (override_item ? 'studentId' and coalesce(override_student_id, '') <>
              coalesce(nullif(trim(booking_item ->> 'studentId'), ''), ''))
            or (override_item ? 'subjectId' and coalesce(override_subject, '') <>
              coalesce(booking_subject, ''));
          override_is_eligible := jsonb_typeof(override_item) = 'object'
            and not (override_item ? 'packageId')
            and nullif(trim(override_item ->> 'settledAt'), '') is null
            and coalesce(override_item ->> 'status', '') not in (
              'completed', 'cancelled', 'abnormal', 'leave'
            )
            and case
              when override_effective_date ~ '^\d{4}-\d{2}-\d{2}$'
                then override_effective_date::date >=
                  (current_timestamp at time zone 'Australia/Melbourne')::date
              else false
            end;
          if parent_package_backfilled
             and jsonb_typeof(override_item) = 'object'
             and not (override_item ? 'packageId')
             and not override_is_eligible then
            -- Before this import the override inherited a missing parent
            -- package. Preserve that historical/terminal/settled meaning.
            override_item := jsonb_set(override_item, '{packageId}', 'null'::jsonb, true);
            booking_changed := true;
          elsif override_is_eligible
             and (
               nullif(trim(next_booking ->> 'packageId'), '') is null
               or override_changes_assignment
             ) then
            select coalesce(array_agg(candidate.package_id order by candidate.package_id), array[]::text[])
            into override_matching_package_ids
            from (
              select lesson_package ->> 'id' as package_id
              from jsonb_array_elements(expected_students) imported_student
              cross join lateral jsonb_array_elements(
                case
                  when jsonb_typeof(imported_student -> 'lessonPackages') = 'array'
                    then imported_student -> 'lessonPackages'
                  else '[]'::jsonb
                end
              ) lesson_package
              cross join lateral jsonb_array_elements_text(
                case
                  when jsonb_typeof(lesson_package -> 'subjectIds') = 'array'
                    then lesson_package -> 'subjectIds'
                  else '[]'::jsonb
                end
              ) subject(subject_id)
              where imported_student ->> 'id' = override_student_id
                and coalesce((imported_student ->> 'importArchived')::boolean, false) is false
                and override_subject is not null
                and nullif(trim(lesson_package ->> 'id'), '') is not null
                and subject.subject_id = override_subject
                and (
                  select coalesce(sum((purchase ->> 'hours')::numeric), 0)
                  from jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
                ) - (lesson_package ->> 'consumedHours')::numeric > 0
              group by lesson_package ->> 'id'
            ) candidate;

            if cardinality(override_matching_package_ids) = 1 then
              override_item := jsonb_set(
                override_item,
                '{packageId}',
                to_jsonb(override_matching_package_ids[1]),
                true
              );
              booking_changed := true;
              booking_backfilled := true;
            else
              -- If the override changes ownership/subject and the parent now
              -- has a package, make the missing override explicit so runtime
              -- expansion cannot inherit the wrong student's package.
              if nullif(trim(next_booking ->> 'packageId'), '') is not null
                 and override_changes_assignment then
                override_item := jsonb_set(override_item, '{packageId}', 'null'::jsonb, true);
                booking_changed := true;
              end if;
              if not unresolved_booking_ids @> jsonb_build_array(override_item ->> 'occurrenceId') then
                unresolved_booking_ids := unresolved_booking_ids ||
                  jsonb_build_array(override_item ->> 'occurrenceId');
              end if;
            end if;
          end if;
          next_overrides := next_overrides || jsonb_build_array(override_item);
        end loop;
        if next_overrides is distinct from booking_item -> 'occurrenceOverrides' then
          next_booking := jsonb_set(next_booking, '{occurrenceOverrides}', next_overrides, true);
          booking_changed := true;
        end if;
      end if;
    end if;
    next_bookings := next_bookings || jsonb_build_array(next_booking);
    if booking_changed and booking_backfilled then
      backfilled_booking_ids := backfilled_booking_ids ||
        jsonb_build_array(booking_item ->> 'id');
    end if;
  end loop;

  update public.ops_state s set
    payload = expected_students,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'students'
  returning s.* into current_state;

  insert into public.ops_mutation_log(entity, version, actor)
  values ('students', current_state.version, current_state.updated_by);

  if next_bookings is distinct from booking_state.payload then
    update public.ops_state s set
      payload = next_bookings,
      version = s.version + 1,
      updated_at = current_state.updated_at,
      updated_by = current_state.updated_by
    where s.entity = 'bookings'
    returning s.* into booking_state;

    insert into public.ops_mutation_log(entity, version, actor)
    values ('bookings', booking_state.version, booking_state.updated_by);
  end if;
  bookings_hash := encode(extensions.digest(booking_state.payload::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.committed',
    p_actor,
    'ops_state',
    'students',
    jsonb_build_object(
      'planFingerprint', p_plan_fingerprint,
      'masterRevision', master.revision,
      'jwbRevision', jwb.revision,
      'identityLinkFingerprint', p_source_revisions ->> 'identityLinks',
      'masterDuplicateResolutionFingerprint', p_source_revisions ->> 'masterDuplicateResolutions',
      'fuAttachmentFingerprint', p_source_revisions ->> 'fuAttachments',
      'beforeVersion', p_expected_student_version,
      'afterVersion', current_state.version,
      'bookingsVersionBefore', expected_bookings_version,
      'studentCount', jsonb_array_length(expected_students),
      'studentsSha256', students_hash,
      'bookingsVersion', booking_state.version,
      'bookingsSha256', bookings_hash,
      'bookingPackageBackfilledCount', jsonb_array_length(backfilled_booking_ids),
      'bookingPackageBackfilledIds', backfilled_booking_ids,
      'bookingPackageUnresolvedCount', jsonb_array_length(unresolved_booking_ids),
      'bookingPackageUnresolvedIds', unresolved_booking_ids
    )
  );

  -- Carry current, locked review evidence to the newly committed student
  -- version. The singleton fingerprint is unchanged; only its CAS version and
  -- audit pointer advance. Replays accept either the pre-commit or carried row.
  if link_set.singleton
     and link_set.master_source_id = master.source_id
     and link_set.master_revision = master.revision
     and link_set.jwb_source_id = jwb.source_id
     and link_set.jwb_revision = jwb.revision
     and link_set.students_version = p_expected_student_version
     and link_set.link_fingerprint = p_source_revisions ->> 'identityLinks' then
    update internal.student_import_identity_link_sets identity_state set
      students_version = current_state.version,
      updated_by = left(trim(p_actor), 120),
      updated_at = current_state.updated_at,
      audit_id = audit_entry_id
    where identity_state.singleton;
  end if;

  -- Duplicate decisions also bind the student version into their opaque keys.
  -- Clone, rather than move, the accepted rows so an exact commit replay can
  -- still reconstruct its pre-commit evidence after a lost response.
  next_duplicate_candidates := internal.student_import_master_duplicate_candidates(
    master, current_state
  );
  for carried_decision in
    select decision_item.value
    from jsonb_array_elements(duplicate_snapshot -> 'decisions') decision_item(value)
  loop
    prior_duplicate_resolution := null;
    select resolution.* into prior_duplicate_resolution
    from internal.student_import_master_duplicate_resolutions resolution
    where resolution.master_source_id = master.source_id
      and resolution.master_revision = master.revision
      and resolution.students_version = p_expected_student_version
      and resolution.decision = carried_decision ->> 'decision'
      and resolution.source_rows = carried_decision -> 'sourceRows'
      and resolution.selected_source_row is not distinct from
        carried_decision -> 'selectedSourceRow'
      and resolution.selected_status is not distinct from
        carried_decision ->> 'selectedStatus'
      and resolution.selected_student_id is not distinct from
        carried_decision ->> 'selectedStudentId'
    limit 1;
    if prior_duplicate_resolution.resolution_key is null then
      raise exception using errcode = '55000',
        message = 'student_import_duplicate_carry_source_unavailable';
    end if;

    next_duplicate_candidate := null;
    select candidate_item.value into next_duplicate_candidate
    from jsonb_array_elements(next_duplicate_candidates) candidate_item(value)
    where candidate_item.value -> 'sourceRows' = carried_decision -> 'sourceRows'
    limit 1;
    if next_duplicate_candidate is null then
      raise exception using errcode = '55000',
        message = 'student_import_duplicate_carry_candidate_unavailable';
    end if;

    next_duplicate_option := null;
    select option_item.value into next_duplicate_option
    from jsonb_array_elements(next_duplicate_candidate -> 'options') option_item(value)
    where option_item.value ->> 'decision' = carried_decision ->> 'decision'
      and option_item.value -> 'selectedSourceRow' is not distinct from
        carried_decision -> 'selectedSourceRow'
      and option_item.value ->> 'selectedStatus' is not distinct from
        carried_decision ->> 'selectedStatus'
    limit 1;
    if next_duplicate_option is null then
      raise exception using errcode = '55000',
        message = 'student_import_duplicate_carry_option_unavailable';
    end if;

    insert into internal.student_import_master_duplicate_resolutions (
      resolution_key, resolution_group_key, master_source_id, master_revision,
      students_version, decision, source_rows, selected_source_row,
      selected_status, selected_student_id, confirmed_by, confirmed_at, audit_id
    ) values (
      next_duplicate_option ->> 'resolutionKey',
      next_duplicate_candidate ->> 'resolutionGroupKey',
      master.source_id, master.revision, current_state.version,
      prior_duplicate_resolution.decision,
      prior_duplicate_resolution.source_rows,
      prior_duplicate_resolution.selected_source_row,
      prior_duplicate_resolution.selected_status,
      prior_duplicate_resolution.selected_student_id,
      prior_duplicate_resolution.confirmed_by,
      prior_duplicate_resolution.confirmed_at,
      audit_entry_id
    );
  end loop;

  carried_duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, current_state
  );
  if jsonb_array_length(carried_duplicate_snapshot -> 'decisions') <>
       jsonb_array_length(duplicate_snapshot -> 'decisions')
     or not (
       (carried_duplicate_snapshot -> 'decisions') @>
         (duplicate_snapshot -> 'decisions')
       and (duplicate_snapshot -> 'decisions') @>
         (carried_duplicate_snapshot -> 'decisions')
     ) then
    raise exception using errcode = '55000',
      message = 'student_import_duplicate_carry_mismatch';
  end if;

  insert into internal.student_import_commits (
    plan_fingerprint, master_source_id, master_revision, jwb_source_id, jwb_revision,
    master_rows_sha256, jwb_rows_sha256,
    identity_link_fingerprint,
    master_duplicate_resolution_fingerprint, fu_attachment_fingerprint, students_version,
    students_sha256, bookings_version_before, bookings_version, bookings_sha256,
    committed_by, committed_at, audit_id
  ) values (
    p_plan_fingerprint, master.source_id, master.revision, jwb.source_id, jwb.revision,
    master.rows_sha256, jwb.rows_sha256,
    p_source_revisions ->> 'identityLinks', p_source_revisions ->> 'masterDuplicateResolutions',
    p_source_revisions ->> 'fuAttachments',
    current_state.version,
    students_hash, expected_bookings_version, booking_state.version, bookings_hash,
    left(trim(p_actor), 120), current_state.updated_at, audit_entry_id
  );

  return query select
    current_state.entity,
    current_state.version,
    current_state.updated_at,
    current_state.updated_by;
end;
$$;

revoke all on function public.commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  to anon, authenticated;

-- Recover the result of an already committed plan after an HTTP response is
-- lost. The caller supplies no source rows, revisions, links or student data:
-- every replay proof is recovered again from locked server-owned state.
create or replace function public.get_student_import_commit_replay_result(
  p_secret text,
  p_plan_fingerprint text,
  p_expected_student_version bigint,
  p_actor text
)
returns table (
  entity text,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior internal.student_import_commits%rowtype;
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  students_state public.ops_state%rowtype;
  booking_state public.ops_state%rowtype;
  locked_state public.ops_state%rowtype;
  reference_entities constant text[] := array[
    'bookings', 'files', 'lpItems', 'messages', 'operations',
    'payroll', 'renewals', 'students', 'tasks'
  ];
  locked_state_count integer := 0;
  duplicate_decision_state public.ops_state%rowtype;
  carried_duplicate_snapshot jsonb;
  replayed_duplicate_candidates jsonb;
  replayed_duplicate_decisions jsonb;
  replayed_duplicate_fingerprint text;
  fu_attachment_snapshot jsonb;
  identity_link_fingerprint text;
  resolved_master_rows jsonb;
  referenced_student_ids jsonb;
  expected_students jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_student_version is null
     or p_expected_student_version < 1
     or p_expected_student_version >= 9007199254740991
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_commit_replay_request';
  end if;

  -- Match the commit lock order so an in-flight first commit completes before
  -- this lookup reads its idempotency row and post-commit evidence.
  lock table internal.student_fu_attachments in share mode;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_commit:' || p_plan_fingerprint, 0
  ));
  select * into prior
  from internal.student_import_commits committed
  where committed.plan_fingerprint = p_plan_fingerprint
  for update;
  if not found
     or p_expected_student_version + 1 <> prior.students_version
     or prior.master_source_id is null
     or prior.jwb_source_id is null
     or prior.master_rows_sha256 is null
     or prior.jwb_rows_sha256 is null then
    raise exception using errcode = '23503',
      message = 'student_import_commit_replay_unavailable';
  end if;

  select * into jwb
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'jwb'
  for update;
  select * into master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for update;
  select * into link_set
  from internal.student_import_identity_link_sets identity_state
  where identity_state.singleton
  for update;
  for locked_state in
    select state_row.*
    from public.ops_state state_row
    where state_row.entity = any(reference_entities)
    order by array_position(reference_entities, state_row.entity)
    for update
  loop
    locked_state_count := locked_state_count + 1;
    if jsonb_typeof(locked_state.payload) is distinct from 'array' then
      raise exception using errcode = '40001',
        message = 'student_import_commit_replay_state_changed';
    end if;
    if locked_state.entity = 'bookings' then
      booking_state := locked_state;
    elsif locked_state.entity = 'students' then
      students_state := locked_state;
    end if;
  end loop;


  if locked_state_count <> cardinality(reference_entities) then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_state_changed';
  end if;

  if master.source_kind is null or jwb.source_kind is null
     or master.source_id <> prior.master_source_id
     or jwb.source_id <> prior.jwb_source_id
     or master.rows_sha256 <> prior.master_rows_sha256
     or jwb.rows_sha256 <> prior.jwb_rows_sha256
     or master.revision <> prior.master_revision
     or jwb.revision <> prior.jwb_revision then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_source_changed';
  end if;
  if students_state.entity is null
     or booking_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or jsonb_typeof(booking_state.payload) <> 'array'
     or students_state.version <> prior.students_version
     or encode(extensions.digest(students_state.payload::text, 'sha256'), 'hex') <>
       prior.students_sha256
     or booking_state.version <> prior.bookings_version
     or encode(extensions.digest(booking_state.payload::text, 'sha256'), 'hex') <>
       prior.bookings_sha256 then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_state_changed';
  end if;

  fu_attachment_snapshot := internal.student_fu_attachment_reference_snapshot();
  if fu_attachment_snapshot ->> 'fingerprint' <> prior.fu_attachment_fingerprint then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_evidence_changed';
  end if;
  identity_link_fingerprint := case
    when link_set.singleton
     and link_set.master_source_id = master.source_id
     and link_set.master_revision = master.revision
     and link_set.jwb_source_id = jwb.source_id
     and link_set.jwb_revision = jwb.revision
     and link_set.students_version = students_state.version
    then link_set.link_fingerprint
    else 'sha256:' || repeat('0', 64)
  end;
  if identity_link_fingerprint <> prior.identity_link_fingerprint then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_evidence_changed';
  end if;

  -- Duplicate decisions were carried to the post-commit student version. Join
  -- them back to the old-version candidates and restore the exact old group-key
  -- ordering before comparing the original opaque evidence fingerprint.
  duplicate_decision_state := students_state;
  duplicate_decision_state.version := p_expected_student_version;
  carried_duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  replayed_duplicate_candidates := internal.student_import_master_duplicate_candidates(
    master, duplicate_decision_state
  );
  select coalesce(jsonb_agg(carried_decision_item.value
    order by old_candidate.value ->> 'resolutionGroupKey'), '[]'::jsonb)
  into replayed_duplicate_decisions
  from jsonb_array_elements(carried_duplicate_snapshot -> 'decisions')
    carried_decision_item(value)
  join jsonb_array_elements(replayed_duplicate_candidates)
    old_candidate(value)
    on old_candidate.value -> 'sourceRows' = carried_decision_item.value -> 'sourceRows';
  if jsonb_array_length(replayed_duplicate_decisions) <>
       jsonb_array_length(carried_duplicate_snapshot -> 'decisions')
     or exists (
       select 1
       from jsonb_array_elements(replayed_duplicate_candidates) old_candidate
       where not exists (
         select 1
         from jsonb_array_elements(replayed_duplicate_decisions) replayed_decision
         where replayed_decision -> 'sourceRows' = old_candidate -> 'sourceRows'
       )
     ) then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_evidence_changed';
  end if;
  replayed_duplicate_fingerprint := 'sha256:' || encode(extensions.digest(
    jsonb_build_object(
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'studentsVersion', p_expected_student_version,
      'decisions', replayed_duplicate_decisions
    )::text,
    'sha256'
  ), 'hex');
  if replayed_duplicate_fingerprint <>
     prior.master_duplicate_resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_evidence_changed';
  end if;

  select coalesce(jsonb_agg(resolved_row
    order by internal.student_import_utf16_sort_key(resolved_row ->> 'sourceRow')), '[]'::jsonb)
  into resolved_master_rows
  from (
    select case
      when matched.duplicate_decision ->> 'decision' = 'select'
       and master_row ->> 'sourceRow' =
         matched.duplicate_decision ->> 'selectedSourceRow'
       and nullif(matched.duplicate_decision ->> 'selectedStatus', '') is not null
      then jsonb_set(
        master_row, '{status}',
        to_jsonb(matched.duplicate_decision ->> 'selectedStatus'), true
      )
      else master_row end as resolved_row
    from jsonb_array_elements(master.rows) master_row
    left join lateral (
      select replayed_decision.value as duplicate_decision
      from jsonb_array_elements(replayed_duplicate_decisions) replayed_decision(value)
      where exists (
        select 1
        from jsonb_array_elements_text(replayed_decision.value -> 'sourceRows') source_row
        where source_row = master_row ->> 'sourceRow'
      )
      limit 1
    ) matched on true
    where matched.duplicate_decision is null
       or (
         matched.duplicate_decision ->> 'decision' = 'select'
         and master_row ->> 'sourceRow' =
           matched.duplicate_decision ->> 'selectedSourceRow'
       )
  ) resolved;

  -- Rebuild the same canonical reference closure as the original commit. A
  -- changed message/task/etc. reference may add or remove a retained archive
  -- even when the students payload itself has not yet been edited.
  select coalesce(jsonb_agg(to_jsonb(reference.student_id)
    order by reference.student_id collate "C"), '[]'::jsonb)
  into referenced_student_ids
  from (
    select distinct referenced.student_id
    from (
      select trim(reference_item ->> 'studentId') as student_id
      from public.ops_state reference_state
      cross join lateral jsonb_array_elements(reference_state.payload) reference_item
      where reference_state.entity = any(reference_entities)
        and reference_state.entity <> 'students'

      union

      select trim(occurrence_override ->> 'studentId') as student_id
      from jsonb_array_elements(booking_state.payload) booking
      cross join lateral jsonb_array_elements(case
        when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
          then booking -> 'occurrenceOverrides'
        else '[]'::jsonb
      end) occurrence_override

      union

      select trim(attachment.student_id) as student_id
      from internal.student_fu_attachments attachment
    ) referenced
    where nullif(referenced.student_id, '') is not null
  ) reference;

  expected_students := internal.student_import_canonical_projection(
    master.source_id,
    resolved_master_rows,
    jwb.rows,
    students_state.payload,
    case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = students_state.version
      then link_set.links else '[]'::jsonb end,
    referenced_student_ids
  );
  if expected_students is distinct from students_state.payload
     or exists (
       select 1 from jsonb_array_elements(expected_students) projected_student
       where projected_student ->> 'jwbMatchStatus' = 'ambiguous'
     )
     or not internal.student_import_identity_coverage_ready(expected_students) then
    raise exception using errcode = '40001',
      message = 'student_import_commit_replay_evidence_changed';
  end if;

  return query select
    'students'::text,
    prior.students_version,
    prior.committed_at,
    prior.committed_by;
end;
$$;

revoke all on function public.get_student_import_commit_replay_result(text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.get_student_import_commit_replay_result(text, text, bigint, text)
  to anon, authenticated;

revoke all on function internal.student_import_master_review_name_key(text)
  from public, anon, authenticated;
revoke all on function internal.student_import_identity_review_key(
  text, text, text, jsonb, text, text, jsonb, bigint, bigint, text, text
) from public, anon, authenticated;
revoke all on function internal.student_import_identity_clear_key(
  text, text, text, text, bigint, bigint, text
) from public, anon, authenticated;
revoke all on function internal.student_import_identity_manual_token(
  text, text, text, text, text, text, bigint, bigint, jsonb, text
) from public, anon, authenticated;
revoke all on function internal.student_import_identity_review_candidates(
  text, text, jsonb, text, text, jsonb, bigint, bigint, jsonb
) from public, anon, authenticated;
revoke all on function internal.student_import_selected_duplicate_identity_matches(
  jsonb, jsonb, text, jsonb
) from public, anon, authenticated;
revoke all on function internal.student_import_master_duplicate_snapshot(
  internal.student_import_source_rows, public.ops_state
) from public, anon, authenticated;
revoke all on function internal.student_import_identity_coverage_ready(jsonb)
  from public, anon, authenticated;

-- Migration-time executable fixtures prove the cross-runtime hash, the
-- fail-closed uniqueness rules and the only allowed create-link projection.
do $$
declare
  derived_student_id text := internal.student_import_student_id(
    'master-source', to_jsonb('M-1'::text)
  );
  candidates jsonb;
  projection jsonb;
begin
  if internal.student_import_master_review_name_key('Alice 张三 王') <> '张三'
     or internal.student_import_master_review_name_key('Alice 张 王四') <> '王四'
     or internal.student_import_master_review_name_key('Alice 张三 / 王四') <> ''
     or internal.student_import_master_review_name_key('Alice 张') <> ''
     or internal.student_import_cjk_name_key('Alice 张三') <> ''
     or internal.student_import_cjk_name_key('张（三）') <> '张三' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_name_key_fixture_mismatch';
  end if;

  if derived_student_id <> 'STU-M-17JDNBJ054M4GR'
     or internal.student_import_identity_review_key(
       'student-import-identity-review-v1',
       'master-source', 'master-rev', to_jsonb('M-1'::text),
       'jwb-source', 'jwb-rev', to_jsonb('J-1'::text),
       7, 0, 'create', derived_student_id
     ) <> 'sha256:9c56038e54a68c9fa0cce5e225c46f5904fbc1d295aff320bcb03b742134e968'
     or internal.student_import_identity_review_key(
       'student-import-identity-review-candidate-v1',
       'master-source', 'master-rev', to_jsonb('M-1'::text),
       'jwb-source', 'jwb-rev', to_jsonb('J-1'::text),
       7, 0
     ) <> 'sha256:f9c42a080e0148d0aaa207989729d86d106fa61e4a80717f3e2634f305524503'
     or internal.student_import_identity_clear_key(
       'master-source', 'master-rev', 'jwb-source', 'jwb-rev', 7, 0,
       'sha256:' || repeat('0', 64)
     ) <> 'sha256:96dffec9502997b03c0e3f4f60c86b176222d79b28386e26f936036e640375a0'
     or internal.student_import_identity_manual_token(
       'master', repeat('a', 64), 'master-source', 'master-rev', 'jwb-source', 'jwb-rev',
       7, 0, to_jsonb('M-1'::text), null
     ) <> 'sha256:90af7adb260955bebf707c5206d6cb0f489f8ccbe488b386ccc51bc3dfb8f151'
     or internal.student_import_identity_manual_token(
       'jwb', repeat('a', 64), 'master-source', 'master-rev', 'jwb-source', 'jwb-rev',
       7, 0, to_jsonb('J-1'::text), null
     ) <> 'sha256:e891b84dd3beeb50291c2f8dd0e372861f67e81775ae8a0508323889afea8945'
     or internal.student_import_identity_manual_token(
       'existing', repeat('a', 64), 'master-source', 'master-rev', 'jwb-source', 'jwb-rev',
       7, 0, null, 'LEGACY-1'
     ) <> 'sha256:6f07b6683a84b495167654bc8db9ac762b9d66c8d338ddb5029db6703f3d12fa'
     or internal.student_import_identity_manual_token(
       'master', repeat('a', 64), 'master-source', 'master-rev', 'jwb-source', 'jwb-rev',
       7, 1, to_jsonb('M-1'::text), null
     ) = 'sha256:90af7adb260955bebf707c5206d6cb0f489f8ccbe488b386ccc51bc3dfb8f151' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_hash_fixture_mismatch';
  end if;

  if internal.student_import_student_id('master-source', to_jsonb(42)) <>
       'STU-M-1DP0LNI04WMC8C'
     or internal.student_import_identity_review_key(
       'student-import-identity-review-v1',
       'master-source', 'master-rev', to_jsonb(42),
       'jwb-source', 'jwb-rev', to_jsonb(7),
       7, 0, 'create', 'STU-M-1DP0LNI04WMC8C'
     ) <> 'sha256:8b4ed81781e0b8b878b76c487f7f53cc3dae4eecee960d1742cea00fb9b4a4d7'
     or internal.student_import_identity_review_key(
       'student-import-identity-review-candidate-v1',
       'master-source', 'master-rev', to_jsonb(42),
       'jwb-source', 'jwb-rev', to_jsonb(7),
       7, 0
     ) <> 'sha256:4a6f16107902a56e738fe4fb1562154fe6c8bdbcb6a6e95fa79d7d24483ad23d' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_numeric_hash_fixture_mismatch';
  end if;

  candidates := internal.student_import_identity_review_candidates(
    'master-source', 'master-rev',
    '[{"sourceRow":"M-1","name":"Alice 张三 王","status":"在读"}]'::jsonb,
    'jwb-source', 'jwb-rev',
    '[{"sourceRow":"J-1","name":"JWB 张三 Account"}]'::jsonb,
    7, 0, '[]'::jsonb
  );
  if jsonb_array_length(candidates) <> 1
     or candidates #>> '{0,decision}' <> 'create'
     or candidates #>> '{0,studentId}' <> derived_student_id
     or candidates #>> '{0,resolutionKey}' <>
       'sha256:9c56038e54a68c9fa0cce5e225c46f5904fbc1d295aff320bcb03b742134e968' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_create_candidate_fixture_mismatch';
  end if;

  candidates := internal.student_import_identity_review_candidates(
    'master-source', 'master-rev',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
    'jwb-source', 'jwb-rev',
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    7, 0, '[{"id":"LEGACY-1","name":"Legacy 张三"}]'::jsonb
  );
  if jsonb_array_length(candidates) <> 2
     or not exists (
       select 1 from jsonb_array_elements(candidates) option_value
       where option_value ->> 'decision' = 'merge'
         and option_value ->> 'studentId' = 'LEGACY-1'
     )
     or not exists (
       select 1 from jsonb_array_elements(candidates) option_value
       where option_value ->> 'decision' = 'create'
         and option_value ->> 'studentId' = derived_student_id
     ) then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_merge_candidate_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_review_candidates(
    'master-source', 'master-rev',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"},{"sourceRow":"M-2","name":"Bob 张三","status":"在读"}]'::jsonb,
    'jwb-source', 'jwb-rev',
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    7, 0, '[]'::jsonb
  )) <> 0
     or jsonb_array_length(internal.student_import_identity_review_candidates(
       'master-source', 'master-rev',
       '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"},{"sourceRow":"M-2","name":"Bob 张三","status":"不活跃 + 无课时"}]'::jsonb,
       'jwb-source', 'jwb-rev',
       '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
       7, 0, '[]'::jsonb
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_review_candidates(
       'master-source', 'master-rev',
       '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
       'jwb-source', 'jwb-rev',
       '[{"sourceRow":"J-1","name":"JWB 张三"},{"sourceRow":"J-2","name":"张三 Account"}]'::jsonb,
       7, 0, '[]'::jsonb
     )) <> 0
     then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_uniqueness_fixture_mismatch';
  end if;

  candidates := internal.student_import_identity_review_candidates(
    'master-source', 'master-rev',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
    'jwb-source', 'jwb-rev',
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    7, 0, '[{"id":"LEGACY-1","name":"张三"},{"id":"LEGACY-2","name":"Other 张三"}]'::jsonb
  );
  if jsonb_array_length(candidates) <> 1
     or candidates #>> '{0,decision}' <> 'create'
     or candidates #>> '{0,studentId}' <> derived_student_id then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_ambiguous_existing_create_fixture_mismatch';
  end if;

  candidates := internal.student_import_identity_review_candidates(
    'master-source', 'master-rev',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
    'jwb-source', 'jwb-rev',
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    7, 0, '[]'::jsonb
  );
  if jsonb_array_length(candidates) <> 1 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_duplicate_resolved_fixture_mismatch';
  end if;

  if not internal.student_import_selected_duplicate_identity_matches(
       '[{"masterSourceRow":"M-1","jwbSourceRow":"J-1","studentId":"S-1"}]'::jsonb,
       to_jsonb('M-1'::text), 'S-1',
       '[{"sourceRow":"J-1"}]'::jsonb
     )
     or internal.student_import_selected_duplicate_identity_matches(
       '[{"masterSourceRow":"M-1","jwbSourceRow":"J-MISSING","studentId":"S-1"}]'::jsonb,
       to_jsonb('M-1'::text), 'S-1',
       '[{"sourceRow":"J-1"}]'::jsonb
     ) then
    raise exception using errcode = '22023',
      message = 'student_import_duplicate_selected_identity_fixture_mismatch';
  end if;

  if not internal.student_import_identity_coverage_ready(
       '[{"importSource":"master","status":"活跃 + 无课时","jwbMatchStatus":"unmatched"}]'::jsonb
     )
     or internal.student_import_identity_coverage_ready(
       '[{"importSource":"master","status":"在读","jwbMatchStatus":"unmatched"}]'::jsonb
     )
     or not internal.student_import_identity_coverage_ready(
       '[{"importSource":"master","status":"在读","jwbMatchStatus":"matched"}]'::jsonb
     ) then
    raise exception using errcode = '22023',
      message = 'student_import_identity_coverage_fixture_mismatch';
  end if;

  projection := internal.student_import_canonical_projection(
    'master-source',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-1',
      'jwbSourceRow', 'J-1',
      'studentId', derived_student_id
    )),
    '[]'::jsonb
  );
  if projection #>> '{0,id}' <> derived_student_id
     or projection #>> '{0,jwbMatchStatus}' <> 'matched'
     or projection #>> '{0,jwbSourceRow}' <> 'J-1' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_create_projection_fixture_mismatch';
  end if;

  projection := internal.student_import_canonical_projection(
    'master-source',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    '[{"id":"LEGACY-TRIAL","name":"Trial 张三","segment":"试听"}]'::jsonb,
    '[{"masterSourceRow":"M-1","jwbSourceRow":"J-1","studentId":"LEGACY-TRIAL"}]'::jsonb,
    '[]'::jsonb
  );
  if jsonb_array_length(projection) <> 1
     or projection #>> '{0,id}' <> 'LEGACY-TRIAL'
     or projection #>> '{0,importSource}' <> 'master'
     or projection #>> '{0,jwbMatchStatus}' <> 'matched' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_manual_trial_merge_fixture_mismatch';
  end if;

  projection := internal.student_import_canonical_projection(
    'master-source',
    '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
    '[{"id":"LEGACY-ARCHIVE","name":"Archive 张三","status":"不活跃 + 无课时","importArchived":true,"importArchivedReason":"referenced_history"}]'::jsonb,
    '[{"masterSourceRow":"M-1","jwbSourceRow":"J-1","studentId":"LEGACY-ARCHIVE"}]'::jsonb,
    '["LEGACY-ARCHIVE"]'::jsonb
  );
  if jsonb_array_length(projection) <> 1
     or projection #>> '{0,id}' <> 'LEGACY-ARCHIVE'
     or projection #>> '{0,importSource}' <> 'master'
     or (projection -> 0) ? 'importArchived' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_review_archive_merge_fixture_mismatch';
  end if;

  begin
    perform internal.student_import_canonical_projection(
      'master-source',
      '[{"sourceRow":"M-1","name":"Alice 张三","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-1","name":"张三"}]'::jsonb,
      '[]'::jsonb,
      '[{"masterSourceRow":"M-1","jwbSourceRow":"J-1","studentId":"NOT-DERIVED"}]'::jsonb,
      '[]'::jsonb
    );
    raise exception 'student_import_identity_review_non_derived_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'invalid_student_import_linked_identity' then
      raise;
    end if;
  end;
end;
$$;

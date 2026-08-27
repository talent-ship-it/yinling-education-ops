-- Resumable, server-validated staging for the normalized JWB student source.
--
-- This protocol deliberately stages raw normalized source rows in private
-- internal tables.  Existing readers continue to use only
-- internal.student_import_source_rows, so a partial run is invisible.  The
-- only publication side effect is the current JWB source row at completion;
-- no students, packages, bookings, tasks, attendance, or identity links are
-- touched here.
-- Stage accepts the planner's verified closures, not bare rows. Completion
-- extracts their normalized rows only after verifying the run-wide closure
-- digest, then passes those rows to the established source RPC.
-- Master revision drift is intentionally out of scope for this source-only
-- ledger. Callers preserve any master source evidence in sourceMetadata for
-- the later identity-review gate; completion never reads or changes master.
--
-- Contract (all public RPCs are server-only by shared secret + actor):
--   get_jiaowubao_student_source_ingest_preflight(text,text)
--   begin_jiaowubao_student_source_ingest(text,jsonb,text)
--   stage_jiaowubao_student_source_chunk(text,uuid,integer,jsonb,text)
--   get_jiaowubao_student_source_ingest_status(text,uuid,text)
--   complete_jiaowubao_student_source_ingest(text,uuid,text)
--   abort_jiaowubao_student_source_ingest(text,uuid,text)
--
-- The client sends the exact envelope below to begin. `candidateArtifactSha256`
-- pins the local raw export and `normalizedRowsSha256` pins the deterministic
-- normalized closure sequence. PostgreSQL validates every closure's canonical
-- bytes and recomputes the latter at completion; it also records a separate
-- server payload hash for the JSONB rows it publishes. sourceMetadata is
-- preserved as server-only evidence and is intentionally never returned by
-- status or audit responses:
-- {
--   "sourceId": "...", "revision": "...",
--   "candidateArtifactSha256": "sha256:<64 lowercase hex>",
--   "sourceRevisions": { "students": "sha256:...", ... },
--   "normalizedRowsSha256": "sha256:<64 lowercase hex>",
--   "expectedPublishedJwb": {
--     "sourceId": "...", "revision": "...",
--     "rowsSha256": "<64 lowercase hex>", "rowCount": 1043
--   },
--   "expectedRowCount": 1043, "expectedChunkCount": 2,
--   "sourceMetadata": { ... }
-- }

-- PostgreSQL has jsonb_object_keys but no jsonb_object_length. Keep the
-- count in an immutable helper so both table constraints and RPC validation
-- use the same supported object-cardinality contract.
create or replace function internal.jiaowubao_student_source_jsonb_object_size(
  p_value jsonb
)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select count(*)::integer
  from pg_catalog.jsonb_object_keys(p_value)
$$;

revoke all on function internal.jiaowubao_student_source_jsonb_object_size(jsonb)
  from public, anon, authenticated;

create table if not exists internal.jiaowubao_student_source_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null check (length(source_id) between 1 and 160),
  revision text not null check (length(revision) between 1 and 240),
  candidate_artifact_sha256 text not null
    check (candidate_artifact_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  source_revisions jsonb not null check (
    jsonb_typeof(source_revisions) = 'object'
    and internal.jiaowubao_student_source_jsonb_object_size(source_revisions) between 1 and 32
  ),
  normalized_rows_sha256 text not null
    check (normalized_rows_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  expected_published_source_id text not null check (length(expected_published_source_id) between 1 and 160),
  expected_published_revision text not null check (length(expected_published_revision) between 1 and 240),
  expected_published_rows_sha256 text not null
    check (expected_published_rows_sha256 ~ '^[a-f0-9]{64}$'),
  expected_published_row_count integer not null check (expected_published_row_count between 1 and 10000),
  expected_row_count integer not null check (expected_row_count between 1 and 10000),
  expected_chunk_count integer not null check (expected_chunk_count between 1 and 512),
  source_metadata jsonb not null check (
    jsonb_typeof(source_metadata) = 'object'
    and octet_length(source_metadata::text) between 2 and 32768
  ),
  state text not null default 'staging'
    check (state in ('staging', 'complete', 'aborted')),
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  staged_by text not null check (staged_by = btrim(staged_by) and length(staged_by) between 1 and 120),
  staged_at timestamptz not null default now(),
  staging_audit_id uuid not null references internal.operational_contract_audit(id),
  completed_at timestamptz,
  completion_audit_id uuid references internal.operational_contract_audit(id),
  aborted_at timestamptz,
  abort_audit_id uuid references internal.operational_contract_audit(id),
  check (
    (state = 'staging'
      and payload_sha256 is null and completed_at is null and completion_audit_id is null
      and aborted_at is null and abort_audit_id is null)
    or (state = 'complete'
      and payload_sha256 is not null and completed_at is not null and completion_audit_id is not null
      and aborted_at is null and abort_audit_id is null)
    or (state = 'aborted'
      and payload_sha256 is null and completed_at is null and completion_audit_id is null
      and aborted_at is not null and abort_audit_id is not null)
  )
);

alter table internal.jiaowubao_student_source_ingest_runs enable row level security;
revoke all on table internal.jiaowubao_student_source_ingest_runs from public, anon, authenticated;

create unique index if not exists jwb_student_source_ingest_active_revision_idx
  on internal.jiaowubao_student_source_ingest_runs (source_id, revision)
  where state in ('staging', 'complete');

create or replace function internal.guard_jiaowubao_student_source_ingest_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.state in ('complete', 'aborted') then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_run_immutable';
  end if;
  if new.id is distinct from old.id
     or new.source_id is distinct from old.source_id
     or new.revision is distinct from old.revision
     or new.candidate_artifact_sha256 is distinct from old.candidate_artifact_sha256
     or new.source_revisions is distinct from old.source_revisions
     or new.normalized_rows_sha256 is distinct from old.normalized_rows_sha256
     or new.expected_published_source_id is distinct from old.expected_published_source_id
     or new.expected_published_revision is distinct from old.expected_published_revision
     or new.expected_published_rows_sha256 is distinct from old.expected_published_rows_sha256
     or new.expected_published_row_count is distinct from old.expected_published_row_count
     or new.expected_row_count is distinct from old.expected_row_count
     or new.expected_chunk_count is distinct from old.expected_chunk_count
     or new.source_metadata is distinct from old.source_metadata
     or new.staged_by is distinct from old.staged_by
     or new.staged_at is distinct from old.staged_at
     or new.staging_audit_id is distinct from old.staging_audit_id then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_run_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_jiaowubao_student_source_ingest_run
  on internal.jiaowubao_student_source_ingest_runs;
create trigger guard_jiaowubao_student_source_ingest_run
before update or delete on internal.jiaowubao_student_source_ingest_runs
for each row execute function internal.guard_jiaowubao_student_source_ingest_run();

revoke all on function internal.guard_jiaowubao_student_source_ingest_run()
  from public, anon, authenticated;

create table if not exists internal.jiaowubao_student_source_ingest_chunks (
  run_id uuid not null references internal.jiaowubao_student_source_ingest_runs(id) on delete restrict,
  chunk_index integer not null check (chunk_index between 0 and 511),
  chunk_sha256 text not null check (chunk_sha256 ~ '^[a-f0-9]{64}$'),
  closures jsonb not null check (jsonb_typeof(closures) = 'array'),
  source_row_count integer not null check (source_row_count between 1 and 10000),
  content_bytes integer not null check (content_bytes between 1 and 2097152),
  staged_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  primary key (run_id, chunk_index),
  check (jsonb_array_length(closures) = source_row_count)
);

alter table internal.jiaowubao_student_source_ingest_chunks enable row level security;
revoke all on table internal.jiaowubao_student_source_ingest_chunks from public, anon, authenticated;

-- A chunk is immutable once committed.  Abort is the only cleanup path, and
-- it is enabled by a transaction-local setting set only by the abort RPC.
create or replace function internal.guard_jiaowubao_student_source_ingest_chunk()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_chunk_immutable';
  end if;
  if tg_op = 'DELETE'
     and current_setting('internal.jiaowubao_student_source_abort_run_id', true)
       is distinct from old.run_id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_chunk_delete_forbidden';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_jiaowubao_student_source_ingest_chunk
  on internal.jiaowubao_student_source_ingest_chunks;
create trigger guard_jiaowubao_student_source_ingest_chunk
before update or delete on internal.jiaowubao_student_source_ingest_chunks
for each row execute function internal.guard_jiaowubao_student_source_ingest_chunk();

revoke all on function internal.guard_jiaowubao_student_source_ingest_chunk()
  from public, anon, authenticated;

-- Legacy whole-array JWB ingest is fail-closed.  Completion sets this
-- transaction-local run marker immediately before calling the established
-- source RPC; master ingest is unaffected by this guard.
create or replace function internal.guard_legacy_jiaowubao_student_source_ingest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op in ('INSERT', 'UPDATE') and new.source_kind = 'jwb')
     or (tg_op in ('UPDATE', 'DELETE') and old.source_kind = 'jwb') then
    if current_setting('internal.jiaowubao_student_source_publish_run_id', true) is null
       or current_setting('internal.jiaowubao_student_source_publish_run_id', true) = '' then
      raise exception using errcode = '55000',
        message = 'jiaowubao_student_source_chunked_ingest_required';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_legacy_jiaowubao_student_source_ingest
  on internal.student_import_source_rows;
create trigger guard_legacy_jiaowubao_student_source_ingest
before insert or update or delete on internal.student_import_source_rows
for each row execute function internal.guard_legacy_jiaowubao_student_source_ingest();

revoke all on function internal.guard_legacy_jiaowubao_student_source_ingest()
  from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_student_source_envelope(
  p_envelope jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_envelope is null
     or jsonb_typeof(p_envelope) <> 'object'
     or p_envelope - ARRAY[
       'sourceId', 'revision', 'candidateArtifactSha256',
       'sourceRevisions', 'normalizedRowsSha256',
       'expectedPublishedJwb',
       'expectedRowCount', 'expectedChunkCount', 'sourceMetadata'
     ]::text[] <> '{}'::jsonb
     or jsonb_typeof(p_envelope -> 'sourceId') <> 'string'
     or nullif(btrim(p_envelope ->> 'sourceId'), '') is null
     or p_envelope ->> 'sourceId' <> btrim(p_envelope ->> 'sourceId')
     or length(p_envelope ->> 'sourceId') > 160
     or jsonb_typeof(p_envelope -> 'revision') <> 'string'
     or nullif(btrim(p_envelope ->> 'revision'), '') is null
     or p_envelope ->> 'revision' <> btrim(p_envelope ->> 'revision')
     or length(p_envelope ->> 'revision') > 240
     or jsonb_typeof(p_envelope -> 'candidateArtifactSha256') <> 'string'
     or (p_envelope ->> 'candidateArtifactSha256') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceRevisions') <> 'object'
     or internal.jiaowubao_student_source_jsonb_object_size(p_envelope -> 'sourceRevisions') not between 1 and 32
     or exists (
       select 1
       from jsonb_each(p_envelope -> 'sourceRevisions') source_revision(key, value)
       where nullif(btrim(source_revision.key), '') is null
          or length(source_revision.key) > 80
          or jsonb_typeof(source_revision.value) <> 'string'
          or nullif(btrim(source_revision.value #>> '{}'), '') is null
          or length(source_revision.value #>> '{}') > 240
     )
     or jsonb_typeof(p_envelope -> 'normalizedRowsSha256') <> 'string'
     or (p_envelope ->> 'normalizedRowsSha256') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb') <> 'object'
     or p_envelope -> 'expectedPublishedJwb' - ARRAY[
       'sourceId', 'revision', 'rowsSha256', 'rowCount'
     ]::text[] <> '{}'::jsonb
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'sourceId') <> 'string'
     or nullif(btrim(p_envelope -> 'expectedPublishedJwb' ->> 'sourceId'), '') is null
     or p_envelope -> 'expectedPublishedJwb' ->> 'sourceId'
       <> btrim(p_envelope -> 'expectedPublishedJwb' ->> 'sourceId')
     or length(p_envelope -> 'expectedPublishedJwb' ->> 'sourceId') > 160
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'revision') <> 'string'
     or nullif(btrim(p_envelope -> 'expectedPublishedJwb' ->> 'revision'), '') is null
     or p_envelope -> 'expectedPublishedJwb' ->> 'revision'
       <> btrim(p_envelope -> 'expectedPublishedJwb' ->> 'revision')
     or length(p_envelope -> 'expectedPublishedJwb' ->> 'revision') > 240
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'rowsSha256') <> 'string'
     or (p_envelope -> 'expectedPublishedJwb' ->> 'rowsSha256') !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'rowCount') <> 'number'
     or (p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::numeric
       <> trunc((p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::numeric)
     or (p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::integer not between 1 and 10000
     or jsonb_typeof(p_envelope -> 'expectedRowCount') <> 'number'
     or (p_envelope ->> 'expectedRowCount')::numeric <> trunc((p_envelope ->> 'expectedRowCount')::numeric)
     or (p_envelope ->> 'expectedRowCount')::integer not between 1 and 10000
     or jsonb_typeof(p_envelope -> 'expectedChunkCount') <> 'number'
     or (p_envelope ->> 'expectedChunkCount')::numeric <> trunc((p_envelope ->> 'expectedChunkCount')::numeric)
     or (p_envelope ->> 'expectedChunkCount')::integer not between 1 and 512
     or jsonb_typeof(p_envelope -> 'sourceMetadata') <> 'object'
     or octet_length((p_envelope -> 'sourceMetadata')::text) not between 2 and 32768 then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_envelope_invalid';
  end if;
end;
$$;

revoke all on function internal.assert_jiaowubao_student_source_envelope(jsonb)
  from public, anon, authenticated;

-- PostgreSQL cannot derive the raw-export digest (the raw API snapshot is
-- intentionally never uploaded), but it can verify the exact canonical
-- closure bytes emitted by the local planner.  This parser is deliberately
-- narrow so a malformed canonical string fails before a staging write.
create or replace function internal.parse_jiaowubao_student_source_canonical_json(
  p_value text
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or octet_length(p_value) < 2 or octet_length(p_value) > 2097152 then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_student_source_closure';
  end if;
  return p_value::jsonb;
exception when invalid_text_representation then
  raise exception using errcode = '22023', message = 'invalid_jiaowubao_student_source_closure';
end;
$$;

revoke all on function internal.parse_jiaowubao_student_source_canonical_json(text)
  from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_student_source_chunk(
  p_closures jsonb,
  p_source_id text,
  p_revision text,
  p_source_revisions jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_closures is null
     or jsonb_typeof(p_closures) <> 'array'
     or jsonb_array_length(p_closures) < 1
     or jsonb_array_length(p_closures) > 10000
     or octet_length(p_closures::text) > 2097152
     or exists (
       select 1
       from jsonb_array_elements(p_closures) closure_value
       where jsonb_typeof(closure_value) <> 'object'
          or closure_value - ARRAY[
            'sourceRow', 'row', 'rowCanonicalJson', 'rowSha256',
            'closureCanonicalJson', 'closureSha256'
          ]::text[] <> '{}'::jsonb
          or jsonb_typeof(closure_value -> 'sourceRow') <> 'string'
          or nullif(closure_value ->> 'sourceRow', '') is null
          or length(closure_value ->> 'sourceRow') > 240
          or jsonb_typeof(closure_value -> 'row') <> 'object'
          or not (closure_value -> 'row' ? 'sourceRow')
          or internal.student_import_source_key(closure_value -> 'row' -> 'sourceRow')
             <> closure_value ->> 'sourceRow'
          or jsonb_typeof(closure_value -> 'rowCanonicalJson') <> 'string'
          or internal.parse_jiaowubao_student_source_canonical_json(
               closure_value ->> 'rowCanonicalJson'
             ) is distinct from closure_value -> 'row'
          or jsonb_typeof(closure_value -> 'rowSha256') <> 'string'
          or closure_value ->> 'rowSha256' <> 'sha256:' || encode(
               extensions.digest(closure_value ->> 'rowCanonicalJson', 'sha256'), 'hex'
             )
          or jsonb_typeof(closure_value -> 'closureCanonicalJson') <> 'string'
          or internal.parse_jiaowubao_student_source_canonical_json(
               closure_value ->> 'closureCanonicalJson'
             ) is distinct from jsonb_build_object(
               'format', 'jiaowubao-student-source-staging-v1',
               'sourceId', p_source_id,
               'revision', p_revision,
               'sourceRevisions', p_source_revisions,
               'sourceRow', closure_value ->> 'sourceRow',
               'rowSha256', closure_value ->> 'rowSha256'
             )
          or jsonb_typeof(closure_value -> 'closureSha256') <> 'string'
          or closure_value ->> 'closureSha256' <> 'sha256:' || encode(
               extensions.digest(closure_value ->> 'closureCanonicalJson', 'sha256'), 'hex'
             )
     )
     or exists (
       select 1
       from jsonb_array_elements(p_closures) closure_value
       group by closure_value ->> 'sourceRow'
       having count(*) > 1
     ) then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_student_source_chunk';
  end if;
end;
$$;

revoke all on function internal.assert_jiaowubao_student_source_chunk(jsonb, text, text, jsonb)
  from public, anon, authenticated;

-- This deliberately returns only the active source pointer, never its raw
-- rows. The operator binds the pointer into begin and completion locks it in
-- the same order as the established source writer before publication.
create or replace function public.get_jiaowubao_student_source_ingest_preflight(
  p_secret text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.student_import_source_rows%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_forbidden';
  end if;
  select * into saved
  from internal.student_import_source_rows source_row
  where source_row.source_kind = 'jwb';
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_student_source_pointer_unavailable';
  end if;
  return jsonb_build_object('currentJwb', jsonb_build_object(
    'sourceId', saved.source_id,
    'revision', saved.revision,
    'rowsSha256', saved.rows_sha256,
    'rowCount', saved.row_count
  ));
end;
$$;

revoke all on function public.get_jiaowubao_student_source_ingest_preflight(text, text)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_student_source_ingest_preflight(text, text)
  to anon, authenticated;

create or replace function public.begin_jiaowubao_student_source_ingest(
  p_secret text,
  p_envelope jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.jiaowubao_student_source_ingest_runs%rowtype;
  audit_id uuid;
  run_id uuid := gen_random_uuid();
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_forbidden';
  end if;
  perform internal.assert_jiaowubao_student_source_envelope(p_envelope);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-student-source:' || (p_envelope ->> 'sourceId') || ':' || (p_envelope ->> 'revision'), 0
  ));

  select * into saved
  from internal.jiaowubao_student_source_ingest_runs run_state
  where run_state.source_id = p_envelope ->> 'sourceId'
    and run_state.revision = p_envelope ->> 'revision'
    and run_state.state in ('staging', 'complete')
  for update;
  if found then
    if saved.candidate_artifact_sha256 <> p_envelope ->> 'candidateArtifactSha256'
       or saved.source_revisions is distinct from p_envelope -> 'sourceRevisions'
       or saved.normalized_rows_sha256 <> p_envelope ->> 'normalizedRowsSha256'
       or saved.expected_published_source_id <> p_envelope -> 'expectedPublishedJwb' ->> 'sourceId'
       or saved.expected_published_revision <> p_envelope -> 'expectedPublishedJwb' ->> 'revision'
       or saved.expected_published_rows_sha256 <> p_envelope -> 'expectedPublishedJwb' ->> 'rowsSha256'
       or saved.expected_published_row_count <> (p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::integer
       or saved.expected_row_count <> (p_envelope ->> 'expectedRowCount')::integer
       or saved.expected_chunk_count <> (p_envelope ->> 'expectedChunkCount')::integer
       or saved.source_metadata is distinct from p_envelope -> 'sourceMetadata'
       or saved.staged_by <> p_actor then
      raise exception using errcode = '23505', message = 'jiaowubao_student_source_envelope_conflict';
    end if;
    return jsonb_build_object(
      'runId', saved.id, 'sourceId', saved.source_id, 'revision', saved.revision,
      'state', saved.state, 'expectedRowCount', saved.expected_row_count,
      'expectedChunkCount', saved.expected_chunk_count,
      'candidateArtifactSha256', saved.candidate_artifact_sha256,
      'normalizedRowsSha256', saved.normalized_rows_sha256,
      'expectedPublishedJwb', jsonb_build_object(
        'sourceId', saved.expected_published_source_id,
        'revision', saved.expected_published_revision,
        'rowsSha256', saved.expected_published_rows_sha256,
        'rowCount', saved.expected_published_row_count
      ),
      'replayed', true
    );
  end if;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_student_source_ingest.started', p_actor,
    'jiaowubao_student_source_ingest_run', run_id::text,
    jsonb_build_object(
      'sourceId', p_envelope ->> 'sourceId', 'revision', p_envelope ->> 'revision',
      'candidateArtifactSha256', p_envelope ->> 'candidateArtifactSha256',
      'sourceRevisions', p_envelope -> 'sourceRevisions',
      'normalizedRowsSha256', p_envelope ->> 'normalizedRowsSha256',
      'expectedPublishedJwb', p_envelope -> 'expectedPublishedJwb',
      'expectedRowCount', (p_envelope ->> 'expectedRowCount')::integer,
      'expectedChunkCount', (p_envelope ->> 'expectedChunkCount')::integer
    )
  );
  insert into internal.jiaowubao_student_source_ingest_runs (
    id, source_id, revision, candidate_artifact_sha256, source_revisions, normalized_rows_sha256,
    expected_published_source_id, expected_published_revision,
    expected_published_rows_sha256, expected_published_row_count,
    expected_row_count, expected_chunk_count, source_metadata,
    staged_by, staging_audit_id
  ) values (
    run_id, p_envelope ->> 'sourceId', p_envelope ->> 'revision',
    p_envelope ->> 'candidateArtifactSha256',
    p_envelope -> 'sourceRevisions', p_envelope ->> 'normalizedRowsSha256',
    p_envelope -> 'expectedPublishedJwb' ->> 'sourceId',
    p_envelope -> 'expectedPublishedJwb' ->> 'revision',
    p_envelope -> 'expectedPublishedJwb' ->> 'rowsSha256',
    (p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::integer,
    (p_envelope ->> 'expectedRowCount')::integer,
    (p_envelope ->> 'expectedChunkCount')::integer,
    p_envelope -> 'sourceMetadata', p_actor, audit_id
  );
  return jsonb_build_object(
    'runId', run_id, 'sourceId', p_envelope ->> 'sourceId',
    'revision', p_envelope ->> 'revision', 'state', 'staging',
    'expectedRowCount', (p_envelope ->> 'expectedRowCount')::integer,
    'expectedChunkCount', (p_envelope ->> 'expectedChunkCount')::integer,
    'candidateArtifactSha256', p_envelope ->> 'candidateArtifactSha256',
    'normalizedRowsSha256', p_envelope ->> 'normalizedRowsSha256',
    'expectedPublishedJwb', p_envelope -> 'expectedPublishedJwb',
    'replayed', false
  );
end;
$$;

revoke all on function public.begin_jiaowubao_student_source_ingest(text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.begin_jiaowubao_student_source_ingest(text, jsonb, text)
  to anon, authenticated;

create or replace function public.stage_jiaowubao_student_source_chunk(
  p_secret text,
  p_run_id uuid,
  p_chunk_index integer,
  p_closures jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_run internal.jiaowubao_student_source_ingest_runs%rowtype;
  saved_chunk internal.jiaowubao_student_source_ingest_chunks%rowtype;
  chunk_hash text;
  chunk_bytes integer;
  row_count integer;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_forbidden';
  end if;
  select * into saved_run
  from internal.jiaowubao_student_source_ingest_runs run_state
  where run_state.id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_student_source_run_not_found';
  end if;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_mismatch';
  end if;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_run_not_staging';
  end if;
  perform internal.assert_jiaowubao_student_source_chunk(
    p_closures, saved_run.source_id, saved_run.revision, saved_run.source_revisions
  );
  chunk_bytes := octet_length(p_closures::text);
  row_count := jsonb_array_length(p_closures);
  if p_chunk_index is null or p_chunk_index < 0 or p_chunk_index >= saved_run.expected_chunk_count then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_chunk_index_invalid';
  end if;
  chunk_hash := encode(extensions.digest(p_closures::text, 'sha256'), 'hex');

  select * into saved_chunk
  from internal.jiaowubao_student_source_ingest_chunks chunk
  where chunk.run_id = p_run_id and chunk.chunk_index = p_chunk_index for update;
  if found then
    if saved_chunk.chunk_sha256 <> chunk_hash
       or saved_chunk.source_row_count <> row_count
       or saved_chunk.content_bytes <> chunk_bytes then
      raise exception using errcode = '23505', message = 'jiaowubao_student_source_chunk_conflict';
    end if;
    return jsonb_build_object(
      'runId', p_run_id, 'chunkIndex', p_chunk_index, 'state', 'staging',
      'sourceRowCount', row_count, 'contentBytes', chunk_bytes, 'replayed', true
    );
  end if;
  if p_chunk_index > 0 and (
    select count(*) from internal.jiaowubao_student_source_ingest_chunks prior_chunk
    where prior_chunk.run_id = p_run_id and prior_chunk.chunk_index between 0 and p_chunk_index - 1
  ) <> p_chunk_index then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_chunk_sequence_gap';
  end if;
  if coalesce((select sum(chunk.source_row_count) from internal.jiaowubao_student_source_ingest_chunks chunk
               where chunk.run_id = p_run_id), 0) + row_count > saved_run.expected_row_count then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_row_count_exceeded';
  end if;
  if exists (
    with incoming as (
      select internal.student_import_source_key(row_value -> 'sourceRow') as source_key
      from jsonb_array_elements(p_closures) row_value
    ), persisted as (
      select row_value ->> 'sourceRow' as source_key
      from internal.jiaowubao_student_source_ingest_chunks chunk
      cross join lateral jsonb_array_elements(chunk.closures) row_value
      where chunk.run_id = p_run_id
    )
    select 1 from incoming join persisted using (source_key)
  ) then
    raise exception using errcode = '23505', message = 'jiaowubao_student_source_source_row_conflict';
  end if;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_student_source_ingest.chunk_staged', p_actor,
    'jiaowubao_student_source_ingest_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id, 'revision', saved_run.revision,
      'chunkIndex', p_chunk_index, 'chunkSha256', chunk_hash,
      'sourceRowCount', row_count, 'contentBytes', chunk_bytes
    )
  );
  insert into internal.jiaowubao_student_source_ingest_chunks (
    run_id, chunk_index, chunk_sha256, closures, source_row_count, content_bytes, audit_id
  ) values (p_run_id, p_chunk_index, chunk_hash, p_closures, row_count, chunk_bytes, audit_id);
  return jsonb_build_object(
    'runId', p_run_id, 'chunkIndex', p_chunk_index, 'state', 'staging',
    'sourceRowCount', row_count, 'contentBytes', chunk_bytes, 'replayed', false
  );
end;
$$;

revoke all on function public.stage_jiaowubao_student_source_chunk(text, uuid, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.stage_jiaowubao_student_source_chunk(text, uuid, integer, jsonb, text)
  to anon, authenticated;

create or replace function public.get_jiaowubao_student_source_ingest_status(
  p_secret text,
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  saved_run internal.jiaowubao_student_source_ingest_runs%rowtype;
  staged_chunk_count integer;
  staged_row_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_forbidden';
  end if;
  select * into saved_run from internal.jiaowubao_student_source_ingest_runs run_state
  where run_state.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_student_source_run_not_found';
  end if;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_mismatch';
  end if;
  select count(*), coalesce(sum(chunk.source_row_count), 0)::integer
  into staged_chunk_count, staged_row_count
  from internal.jiaowubao_student_source_ingest_chunks chunk
  where chunk.run_id = p_run_id;
  return jsonb_build_object(
    'runId', saved_run.id, 'sourceId', saved_run.source_id, 'revision', saved_run.revision,
    'state', saved_run.state, 'candidateArtifactSha256', saved_run.candidate_artifact_sha256,
    'normalizedRowsSha256', saved_run.normalized_rows_sha256,
    'expectedRowCount', saved_run.expected_row_count, 'expectedChunkCount', saved_run.expected_chunk_count,
    'stagedChunkCount', staged_chunk_count, 'stagedRowCount', staged_row_count,
    'payloadSha256', saved_run.payload_sha256,
    'completedAt', saved_run.completed_at, 'abortedAt', saved_run.aborted_at
  );
end;
$$;

revoke all on function public.get_jiaowubao_student_source_ingest_status(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_student_source_ingest_status(text, uuid, text)
  to anon, authenticated;

create or replace function public.complete_jiaowubao_student_source_ingest(
  p_secret text,
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_run internal.jiaowubao_student_source_ingest_runs%rowtype;
  current_published internal.student_import_source_rows%rowtype;
  final_rows jsonb;
  normalized_closures_json text;
  rows_hash text;
  source_result jsonb;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_forbidden';
  end if;
  select * into saved_run from internal.jiaowubao_student_source_ingest_runs run_state
  where run_state.id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_student_source_run_not_found';
  end if;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_mismatch';
  end if;
  if saved_run.state = 'complete' then
    return jsonb_build_object('runId', p_run_id, 'state', 'complete', 'replayed', true);
  end if;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_run_not_staging';
  end if;
  -- Match the lock order used by put_student_import_source_rows: its source
  -- advisory lock first, then the published JWB row. This makes an old
  -- candidate fail closed instead of replacing a source pointer published
  -- after begin, without introducing a lock-order cycle with that writer.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student_import_source:jwb', 0)
  );
  select * into current_published
  from internal.student_import_source_rows source_row
  where source_row.source_kind = 'jwb'
  for update;
  if not found
     or current_published.source_id <> saved_run.expected_published_source_id
     or current_published.revision <> saved_run.expected_published_revision
     or current_published.rows_sha256 <> saved_run.expected_published_rows_sha256
     or current_published.row_count <> saved_run.expected_published_row_count then
    raise exception using errcode = '40001',
      message = 'jiaowubao_student_source_publication_pointer_changed';
  end if;
  if (select count(*) from internal.jiaowubao_student_source_ingest_chunks chunk
      where chunk.run_id = p_run_id) <> saved_run.expected_chunk_count
     or (select coalesce(sum(chunk.source_row_count), 0) from internal.jiaowubao_student_source_ingest_chunks chunk
         where chunk.run_id = p_run_id) <> saved_run.expected_row_count
     or exists (
       select 1 from generate_series(0, saved_run.expected_chunk_count - 1) expected(index)
       where not exists (
         select 1 from internal.jiaowubao_student_source_ingest_chunks chunk
         where chunk.run_id = p_run_id and chunk.chunk_index = expected.index
       )
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_incomplete';
  end if;
  select jsonb_agg(row_value order by chunk.chunk_index, ordinal_position)
  into final_rows
  from internal.jiaowubao_student_source_ingest_chunks chunk
  cross join lateral jsonb_array_elements(chunk.closures) with ordinality row_values(closure_value, ordinal_position)
  cross join lateral (select closure_value -> 'row' as row_value) normalized_row
  where chunk.run_id = p_run_id;
  select '[' || string_agg(
    closure_value ->> 'closureCanonicalJson', ',' order by chunk.chunk_index, ordinal_position
  ) || ']'
  into normalized_closures_json
  from internal.jiaowubao_student_source_ingest_chunks chunk
  cross join lateral jsonb_array_elements(chunk.closures) with ordinality row_values(closure_value, ordinal_position)
  where chunk.run_id = p_run_id;
  if 'sha256:' || encode(extensions.digest(normalized_closures_json, 'sha256'), 'hex')
       <> saved_run.normalized_rows_sha256 then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_normalized_rows_conflict';
  end if;
  rows_hash := 'sha256:' || encode(extensions.digest(final_rows::text, 'sha256'), 'hex');

  -- This is the sole publication boundary. The legacy RPC still performs the
  -- complete normalized-row validation and revision evidence write; the
  -- trigger marker is transaction-local and cannot be supplied by callers.
  perform pg_catalog.set_config(
    'internal.jiaowubao_student_source_publish_run_id', p_run_id::text, true
  );
  source_result := public.put_student_import_source_rows(
    p_secret, 'jwb', saved_run.source_id, saved_run.revision, final_rows, p_actor
  );
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_student_source_ingest.completed', p_actor,
    'jiaowubao_student_source_ingest_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id, 'revision', saved_run.revision,
      'candidateArtifactSha256', saved_run.candidate_artifact_sha256,
      'normalizedRowsSha256', saved_run.normalized_rows_sha256,
      'expectedRowCount', saved_run.expected_row_count,
      'expectedChunkCount', saved_run.expected_chunk_count,
      'payloadSha256', rows_hash
    )
  );
  update internal.jiaowubao_student_source_ingest_runs run_state
  set state = 'complete', payload_sha256 = rows_hash, completed_at = now(), completion_audit_id = audit_id
  where run_state.id = p_run_id;
  return jsonb_build_object(
    'runId', p_run_id, 'state', 'complete', 'sourceId', saved_run.source_id,
    'revision', saved_run.revision, 'rowCount', saved_run.expected_row_count,
    'chunkCount', saved_run.expected_chunk_count, 'payloadSha256', rows_hash,
    'normalizedRowsSha256', saved_run.normalized_rows_sha256,
    'sourceResult', jsonb_build_object(
      'sourceKind', source_result -> 'sourceKind', 'rowCount', source_result -> 'rowCount',
      'unchanged', source_result -> 'unchanged'
    ), 'replayed', false
  );
end;
$$;

revoke all on function public.complete_jiaowubao_student_source_ingest(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_jiaowubao_student_source_ingest(text, uuid, text)
  to anon, authenticated;

create or replace function public.abort_jiaowubao_student_source_ingest(
  p_secret text,
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_run internal.jiaowubao_student_source_ingest_runs%rowtype;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_forbidden';
  end if;
  select * into saved_run from internal.jiaowubao_student_source_ingest_runs run_state
  where run_state.id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_student_source_run_not_found';
  end if;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_student_source_actor_mismatch';
  end if;
  if saved_run.state = 'complete' then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_abort_complete_forbidden';
  end if;
  if saved_run.state = 'aborted' then
    return jsonb_build_object('runId', p_run_id, 'state', 'aborted', 'replayed', true);
  end if;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_student_source_ingest.aborted', p_actor,
    'jiaowubao_student_source_ingest_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id, 'revision', saved_run.revision,
      'candidateArtifactSha256', saved_run.candidate_artifact_sha256
    )
  );
  perform pg_catalog.set_config(
    'internal.jiaowubao_student_source_abort_run_id', p_run_id::text, true
  );
  delete from internal.jiaowubao_student_source_ingest_chunks chunk where chunk.run_id = p_run_id;
  update internal.jiaowubao_student_source_ingest_runs run_state
  set state = 'aborted', aborted_at = now(), abort_audit_id = audit_id
  where run_state.id = p_run_id;
  return jsonb_build_object('runId', p_run_id, 'state', 'aborted', 'replayed', false);
end;
$$;

revoke all on function public.abort_jiaowubao_student_source_ingest(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.abort_jiaowubao_student_source_ingest(text, uuid, text)
  to anon, authenticated;

-- Static migration-time fixture: source staging tables are private and the
-- publication trigger must remain in place. This catches accidental edits to
-- the safety boundary without creating a source or business-state row.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'internal.student_import_source_rows'::regclass
      and trigger_row.tgname = 'guard_legacy_jiaowubao_student_source_ingest'
      and not trigger_row.tgisinternal
  ) then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_legacy_guard_missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class relation_row
    where relation_row.oid = 'internal.jiaowubao_student_source_ingest_chunks'::regclass
      and relation_row.relrowsecurity
  ) then
    raise exception using errcode = '55000', message = 'jiaowubao_student_source_chunk_rls_missing';
  end if;
end;
$$;

-- Management API bridge for the private Jiaowubao Open API schedule snapshot.
--
-- The public RPCs in 20260821220000 intentionally require OPS_API_SECRET and
-- have no public/anon/authenticated grants.  Supabase `db query` already runs
-- as the database postgres session, so this bridge provides the same protocol
-- without copying that secret or a database URL to a workstation.  These
-- functions are SECURITY INVOKER, require both session_user and current_user
-- to be exactly postgres, and live in internal with no client grants.
--
-- This is deliberately a narrow management-only copy of the existing RPC
-- validation and write protocol.  It does not alter the deployed public RPCs.

create or replace function internal.jiaowubao_open_api_schedule_management_session()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_session$
begin
  if session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_management_session_required';
  end if;
end;
$jiaowubao_open_api_schedule_management_session$;
revoke all on function internal.jiaowubao_open_api_schedule_management_session() from public, anon, authenticated;

create or replace function internal.jiaowubao_open_api_schedule_management_begin(p_envelope jsonb, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_begin$
declare
  saved internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  audit_id uuid;
  run_id uuid := gen_random_uuid();
begin
  perform internal.jiaowubao_open_api_schedule_management_session();
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden';
  end if;
  perform internal.assert_jiaowubao_open_api_schedule_snapshot_envelope(p_envelope);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || p_envelope ->> 'apiSourceKey', 0)
  );
  select * into saved
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
  where r.api_source_key = p_envelope ->> 'apiSourceKey'
    and r.revision = p_envelope ->> 'revision'
    and r.state in ('staging', 'complete')
  for update;
  if found then
    if saved.query is distinct from p_envelope -> 'query'
       or saved.expected_page_count <> (p_envelope ->> 'expectedPageCount')::integer
       or saved.expected_row_count <> (p_envelope ->> 'expectedRowCount')::integer
       or saved.expected_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision'
       or saved.external_manifest_sha256 <> p_envelope ->> 'externalManifestSha256'
       or saved.source_metadata is distinct from p_envelope -> 'sourceMetadata'
       or saved.staged_by <> p_actor then
      raise exception using errcode = '23505', message = 'jiaowubao_open_api_schedule_snapshot_envelope_conflict';
    end if;
    return jsonb_build_object(
      'runId', saved.id, 'apiSourceKey', saved.api_source_key, 'revision', saved.revision,
      'state', saved.state, 'expectedPageCount', saved.expected_page_count,
      'expectedRowCount', saved.expected_row_count, 'expectedCurrentRevision', saved.expected_current_revision,
      'externalManifestSha256', saved.external_manifest_sha256,
      'canonicalRowsSha256', saved.canonical_rows_sha256, 'replayed', true
    );
  end if;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_open_api_schedule_snapshot_ingest.started', p_actor,
    'jiaowubao_open_api_schedule_snapshot_ingest_run', run_id::text,
    jsonb_build_object(
      'apiSourceKey', p_envelope ->> 'apiSourceKey', 'revision', p_envelope ->> 'revision',
      'expectedPageCount', (p_envelope ->> 'expectedPageCount')::integer,
      'expectedRowCount', (p_envelope ->> 'expectedRowCount')::integer,
      'expectedCurrentRevision', p_envelope ->> 'expectedCurrentRevision',
      'externalManifestSha256', p_envelope ->> 'externalManifestSha256'
    )
  );
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(
    id, api_source_key, revision, query, expected_page_count, expected_row_count,
    expected_current_revision, external_manifest_sha256, source_metadata, staged_by, staging_audit_id
  ) values (
    run_id, p_envelope ->> 'apiSourceKey', p_envelope ->> 'revision', p_envelope -> 'query',
    (p_envelope ->> 'expectedPageCount')::integer, (p_envelope ->> 'expectedRowCount')::integer,
    p_envelope ->> 'expectedCurrentRevision', p_envelope ->> 'externalManifestSha256',
    p_envelope -> 'sourceMetadata', p_actor, audit_id
  );
  return jsonb_build_object(
    'runId', run_id, 'apiSourceKey', p_envelope ->> 'apiSourceKey', 'revision', p_envelope ->> 'revision',
    'state', 'staging', 'expectedPageCount', (p_envelope ->> 'expectedPageCount')::integer,
    'expectedRowCount', (p_envelope ->> 'expectedRowCount')::integer,
    'expectedCurrentRevision', p_envelope ->> 'expectedCurrentRevision',
    'externalManifestSha256', p_envelope ->> 'externalManifestSha256', 'replayed', false
  );
end;
$jiaowubao_open_api_schedule_management_begin$;
revoke all on function internal.jiaowubao_open_api_schedule_management_begin(jsonb, text) from public, anon, authenticated;

create or replace function internal.jiaowubao_open_api_schedule_management_stage(
  p_run_id uuid, p_page_index integer, p_rows jsonb, p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_stage$
declare
  run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  existing_page internal.jiaowubao_open_api_schedule_snapshot_ingest_pages%rowtype;
  page_hash text;
  bytes integer;
  rows_count integer;
  audit_id uuid;
  item_value jsonb;
  item_pos integer := 0;
begin
  perform internal.jiaowubao_open_api_schedule_management_session();
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden';
  end if;
  select * into run_state
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
  where r.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found';
  end if;
  if run_state.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch';
  end if;
  if run_state.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging';
  end if;
  if p_page_index is null or p_page_index < 0 or p_page_index >= run_state.expected_page_count then
    raise exception using errcode = '22023', message = 'jiaowubao_open_api_schedule_snapshot_page_index_invalid';
  end if;
  perform internal.assert_jiaowubao_open_api_schedule_snapshot_page(p_rows);
  rows_count := jsonb_array_length(p_rows);
  bytes := octet_length(p_rows::text);
  page_hash := 'sha256:' || encode(extensions.digest(p_rows::text, 'sha256'), 'hex');
  select * into existing_page
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p
  where p.run_id = p_run_id and p.page_index = p_page_index
  for update;
  if found then
    if existing_page.page_sha256 <> page_hash
       or existing_page.row_count <> rows_count
       or existing_page.content_bytes <> bytes then
      raise exception using errcode = '23505', message = 'jiaowubao_open_api_schedule_snapshot_page_conflict';
    end if;
    return jsonb_build_object(
      'runId', p_run_id, 'pageIndex', p_page_index, 'pageSha256', page_hash,
      'rowCount', rows_count, 'replayed', true
    );
  end if;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_open_api_schedule_snapshot_ingest.page_staged', p_actor,
    'jiaowubao_open_api_schedule_snapshot_ingest_run', p_run_id::text,
    jsonb_build_object('pageIndex', p_page_index, 'pageSha256', page_hash, 'rowCount', rows_count, 'contentBytes', bytes)
  );
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_pages(
    run_id, page_index, page_sha256, rows, row_count, content_bytes, audit_id
  ) values (p_run_id, p_page_index, page_hash, p_rows, rows_count, bytes, audit_id);
  for item_value in select value from jsonb_array_elements(p_rows) loop
    insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(
      run_id, page_index, item_index, source_key, canonical_json, item_sha256, item
    ) values (
      p_run_id, p_page_index, item_pos, item_value ->> 'sourceKey', (item_value)::text,
      'sha256:' || encode(extensions.digest((item_value)::text, 'sha256'), 'hex'), item_value
    );
    item_pos := item_pos + 1;
  end loop;
  return jsonb_build_object(
    'runId', p_run_id, 'pageIndex', p_page_index, 'pageSha256', page_hash,
    'rowCount', rows_count, 'replayed', false
  );
end;
$jiaowubao_open_api_schedule_management_stage$;
revoke all on function internal.jiaowubao_open_api_schedule_management_stage(uuid, integer, jsonb, text) from public, anon, authenticated;

create or replace function internal.jiaowubao_open_api_schedule_management_status(p_run_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_status$
declare
  run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  pages_count integer;
  rows_count integer;
begin
  perform internal.jiaowubao_open_api_schedule_management_session();
  select * into run_state
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
  where r.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found';
  end if;
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden';
  end if;
  if run_state.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch';
  end if;
  select count(*)::integer, coalesce(sum(p.row_count), 0)::integer
    into pages_count, rows_count
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p
  where p.run_id = p_run_id;
  return jsonb_build_object(
    'runId', run_state.id, 'apiSourceKey', run_state.api_source_key, 'revision', run_state.revision,
    'state', run_state.state, 'expectedPageCount', run_state.expected_page_count,
    'expectedRowCount', run_state.expected_row_count, 'pagesCommitted', pages_count,
    'rowsCommitted', rows_count, 'externalManifestSha256', run_state.external_manifest_sha256,
    'canonicalRowsSha256', run_state.canonical_rows_sha256, 'payloadSha256', run_state.payload_sha256
  );
end;
$jiaowubao_open_api_schedule_management_status$;
revoke all on function internal.jiaowubao_open_api_schedule_management_status(uuid, text) from public, anon, authenticated;

create or replace function internal.jiaowubao_open_api_schedule_management_preflight(p_api_source_key text, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_preflight$
declare
  current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
begin
  perform internal.jiaowubao_open_api_schedule_management_session();
  if p_api_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
     or nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_preflight_forbidden';
  end if;
  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current c
  where c.api_source_key = p_api_source_key;
  if not found then
    return jsonb_build_object('apiSourceKey', p_api_source_key, 'current', null);
  end if;
  return jsonb_build_object(
    'apiSourceKey', current_row.api_source_key,
    'current', jsonb_build_object(
      'runId', current_row.run_id, 'revision', current_row.revision, 'rowCount', current_row.row_count,
      'rowsSha256', current_row.rows_sha256, 'payloadSha256', current_row.payload_sha256,
      'publishedAt', current_row.published_at
    )
  );
end;
$jiaowubao_open_api_schedule_management_preflight$;
revoke all on function internal.jiaowubao_open_api_schedule_management_preflight(text, text) from public, anon, authenticated;

create or replace function internal.jiaowubao_open_api_schedule_management_complete(p_run_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_complete$
declare
  run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  observed_current_revision text;
  page_count integer;
  row_count integer;
  rows_hash text;
  payload_hash text;
  audit_id uuid;
begin
  perform internal.jiaowubao_open_api_schedule_management_session();
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden';
  end if;
  select * into run_state
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
  where r.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found';
  end if;
  if run_state.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch';
  end if;
  if run_state.state = 'complete' then
    return jsonb_build_object(
      'runId', run_state.id, 'apiSourceKey', run_state.api_source_key, 'revision', run_state.revision,
      'state', 'complete', 'rowCount', run_state.expected_row_count,
      'rowsSha256', run_state.canonical_rows_sha256, 'payloadSha256', run_state.payload_sha256, 'replayed', true
    );
  end if;
  if run_state.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || run_state.api_source_key, 0)
  );
  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current c
  where c.api_source_key = run_state.api_source_key
  for update;
  observed_current_revision := case when found then current_row.revision else null end;
  if observed_current_revision is distinct from run_state.expected_current_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_current_pointer_conflict';
  end if;
  select count(*)::integer, coalesce(sum(p.row_count), 0)::integer
    into page_count, row_count
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p
  where p.run_id = p_run_id;
  if page_count <> run_state.expected_page_count
     or row_count <> run_state.expected_row_count
     or exists (
       select 1 from generate_series(0, run_state.expected_page_count - 1) n
       where not exists (
         select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p
         where p.run_id = p_run_id and p.page_index = n
       )
     ) then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_pages_incomplete';
  end if;
  select 'sha256:' || encode(
    extensions.digest(coalesce(string_agg(i.canonical_json, '' order by i.page_index, i.item_index), ''), 'sha256'),
    'hex'
  ) into rows_hash
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i
  where i.run_id = p_run_id;
  select 'sha256:' || encode(
    extensions.digest(coalesce(string_agg(p.page_sha256, '' order by p.page_index), ''), 'sha256'),
    'hex'
  ) into payload_hash
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p
  where p.run_id = p_run_id;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_open_api_schedule_snapshot_ingest.completed', p_actor,
    'jiaowubao_open_api_schedule_snapshot_ingest_run', p_run_id::text,
    jsonb_build_object(
      'apiSourceKey', run_state.api_source_key, 'revision', run_state.revision,
      'pageCount', page_count, 'rowCount', row_count, 'rowsSha256', rows_hash, 'payloadSha256', payload_hash
    )
  );
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
  set state = 'complete', canonical_rows_sha256 = rows_hash, payload_sha256 = payload_hash,
      completed_at = now(), completion_audit_id = audit_id
  where id = p_run_id;
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(
    api_source_key, run_id, revision, row_count, rows_sha256, payload_sha256, audit_id
  ) values (
    run_state.api_source_key, p_run_id, run_state.revision, row_count, rows_hash, payload_hash, audit_id
  ) on conflict (api_source_key) do update set
    run_id = excluded.run_id, revision = excluded.revision, row_count = excluded.row_count,
    rows_sha256 = excluded.rows_sha256, payload_sha256 = excluded.payload_sha256,
    published_at = now(), audit_id = excluded.audit_id;
  return jsonb_build_object(
    'runId', p_run_id, 'apiSourceKey', run_state.api_source_key, 'revision', run_state.revision,
    'state', 'complete', 'pageCount', page_count, 'rowCount', row_count,
    'rowsSha256', rows_hash, 'payloadSha256', payload_hash, 'replayed', false
  );
end;
$jiaowubao_open_api_schedule_management_complete$;
revoke all on function internal.jiaowubao_open_api_schedule_management_complete(uuid, text) from public, anon, authenticated;

create or replace function internal.jiaowubao_open_api_schedule_management_abort(p_run_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_open_api_schedule_management_abort$
declare
  run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  audit_id uuid;
begin
  perform internal.jiaowubao_open_api_schedule_management_session();
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden';
  end if;
  select * into run_state
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r
  where r.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found';
  end if;
  if run_state.staged_by <> p_actor then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch';
  end if;
  if run_state.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging';
  end if;
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_open_api_schedule_snapshot_ingest.aborted', p_actor,
    'jiaowubao_open_api_schedule_snapshot_ingest_run', p_run_id::text,
    jsonb_build_object('apiSourceKey', run_state.api_source_key, 'revision', run_state.revision)
  );
  perform pg_catalog.set_config('internal.jiaowubao_open_api_schedule_snapshot_abort_run_id', p_run_id::text, true);
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id = p_run_id;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages where run_id = p_run_id;
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
  set state = 'aborted', aborted_at = now(), abort_audit_id = audit_id
  where id = p_run_id;
  return jsonb_build_object(
    'runId', p_run_id, 'apiSourceKey', run_state.api_source_key,
    'revision', run_state.revision, 'state', 'aborted'
  );
end;
$jiaowubao_open_api_schedule_management_abort$;
revoke all on function internal.jiaowubao_open_api_schedule_management_abort(uuid, text) from public, anon, authenticated;

comment on function internal.jiaowubao_open_api_schedule_management_begin(jsonb, text)
  is 'Postgres Management API-only begin for the private JWB schedule snapshot protocol.';
comment on function internal.jiaowubao_open_api_schedule_management_stage(uuid, integer, jsonb, text)
  is 'Postgres Management API-only independently committed page stage for the private JWB schedule snapshot protocol.';
comment on function internal.jiaowubao_open_api_schedule_management_complete(uuid, text)
  is 'Postgres Management API-only short publish transaction for the private JWB schedule snapshot protocol.';

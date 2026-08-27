-- Fix JSON extraction precedence in the management-only snapshot begin path.
--
-- Without the parentheses PostgreSQL evaluates the concatenation before
-- `->>`, attempts to cast the concatenated source-key text to jsonb, and
-- rejects every otherwise-valid begin call before any run is committed.

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
    pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || (p_envelope ->> 'apiSourceKey'), 0)
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

alter function internal.jiaowubao_open_api_schedule_management_begin(jsonb, text) owner to postgres;
revoke all on function internal.jiaowubao_open_api_schedule_management_begin(jsonb, text)
  from public, anon, authenticated;

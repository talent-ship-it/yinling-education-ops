-- Keep the original server-only OPS-secret begin RPC usable as well as the
-- Management API bridge. This is the same JSON extraction precedence fix as
-- 20260821220002 and changes no data or grants by itself.

create or replace function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
  p_secret text,
  p_envelope jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $begin_jiaowubao_open_api_schedule_snapshot_ingest$
declare
  saved internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  audit_id uuid;
  run_id uuid := gen_random_uuid();
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
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
$begin_jiaowubao_open_api_schedule_snapshot_ingest$;

alter function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(text, jsonb, text) owner to postgres;
revoke all on function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(text, jsonb, text)
  from public, anon, authenticated;

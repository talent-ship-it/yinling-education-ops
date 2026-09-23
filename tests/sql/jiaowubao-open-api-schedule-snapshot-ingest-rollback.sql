\ir assert-disposable-database.sql
-- Local disposable-Postgres fixture. Run after applying the migration in a
-- transaction; every write below is rolled back, including the abort cleanup.
begin;

-- Minimal disposable fixture hooks. The real migration uses the repository's
-- existing secret verifier and append-only audit writer; these definitions are
-- replaced only inside this transaction and are rolled back at the end.
create or replace function internal.verify_ops_secret(p_secret text)
returns boolean language sql stable set search_path = '' as $$
  select p_secret = 'jiaowubao-snapshot-fixture-secret'
$$;

create or replace function internal.append_operational_contract_audit(
  p_action text, p_actor text, p_target_type text, p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare saved_id uuid;
begin
  insert into internal.operational_contract_audit(action, actor, target_type, target_id, metadata)
  values (left(trim(p_action), 120), left(trim(p_actor), 120), left(trim(p_target_type), 80), left(trim(p_target_id), 240), coalesce(p_metadata, '{}'::jsonb))
  returning id into saved_id;
  return saved_id;
end;
$$;

create or replace function pg_temp.finish_schedule_projection_fixture()
returns void language plpgsql set search_path = '' as $$
begin
  if pg_catalog.to_regclass('internal.jiaowubao_open_api_schedule_projection_jobs') is not null then
    execute $update_projection$
      update internal.jiaowubao_open_api_schedule_projection_jobs
      set state = 'complete',
        authority_completed_at = coalesce(authority_completed_at, pg_catalog.clock_timestamp()),
        completed_at = coalesce(completed_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
      where api_source_key = 'jwb-open-api-schedule'
    $update_projection$;
  end if;
end;
$$;

do $$
declare
  run_id uuid;
  replacement_run_id uuid;
  stale_run_id uuid;
  empty_run_id uuid;
  abort_run_id uuid;
  begin_result jsonb;
  stage_result jsonb;
  complete_result jsonb;
  identity_result jsonb;
  envelope jsonb := jsonb_build_object(
    'apiSourceKey', 'jwb-open-api-schedule',
    'revision', 'sha256:' || repeat('0', 64),
    'query', jsonb_build_object('start', '2026-08-21', 'end', '2026-08-21', 'limit', 100, 'order', 'asc'),
    'expectedPageCount', 1,
    'expectedRowCount', 1,
    'expectedCurrentRevision', null,
    'externalManifestSha256', 'sha256:' || repeat('0', 64),
    'sourceMetadata', jsonb_build_object(
      'exportFormat', 'jiaowubao-schedule-export/v1',
      'manifestSha256', 'sha256:' || repeat('0', 64),
      'recordsSha256', 'sha256:' || repeat('1', 64)
    )
  );
begin
  -- This fixture intentionally uses the repository's disposable test secret.
  -- It must never be copied into production or committed to an environment.
  begin
    perform public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
      'jiaowubao-snapshot-fixture-secret', envelope - 'expectedCurrentRevision', 'Ops Admin'
    );
    raise exception 'snapshot_missing_required_envelope_key_was_accepted';
  exception when sqlstate '22023' then
    null;
  end;
  begin_result := public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
    'jiaowubao-snapshot-fixture-secret', envelope, 'Ops Admin'
  );
  run_id := (begin_result ->> 'runId')::uuid;
  begin
    perform public.stage_jiaowubao_open_api_schedule_snapshot_page(
      'jiaowubao-snapshot-fixture-secret', run_id, 0,
      '[{"sourceKey":"jwb-open-api:schedule:bad","record":{}}]'::jsonb,
      'Ops Admin'
    );
    raise exception 'snapshot_missing_required_record_key_was_accepted';
  exception when sqlstate '22023' then
    null;
  end;
  stage_result := public.stage_jiaowubao_open_api_schedule_snapshot_page(
    'jiaowubao-snapshot-fixture-secret', run_id, 0,
    '[{"sourceKey":"jwb-open-api:schedule:cal-1","record":{"cal_id":"cal-1","dated":"2026-08-21"}}]'::jsonb,
    'Ops Admin'
  );
  if stage_result ->> 'replayed' <> 'false' then
    raise exception 'snapshot_initial_stage_not_new';
  end if;
  stage_result := public.stage_jiaowubao_open_api_schedule_snapshot_page(
    'jiaowubao-snapshot-fixture-secret', run_id, 0,
    '[{"sourceKey":"jwb-open-api:schedule:cal-1","record":{"cal_id":"cal-1","dated":"2026-08-21"}}]'::jsonb,
    'Ops Admin'
  );
  if stage_result ->> 'replayed' <> 'true' then
    raise exception 'snapshot_stage_replay_not_idempotent';
  end if;
  complete_result := public.complete_jiaowubao_open_api_schedule_snapshot_ingest(
    'jiaowubao-snapshot-fixture-secret', run_id, 'Ops Admin'
  );
  if complete_result ->> 'state' <> 'complete'
     or complete_result ->> 'rowsSha256' !~ '^sha256:[a-f0-9]{64}$'
     or complete_result ->> 'payloadSha256' !~ '^sha256:[a-f0-9]{64}$' then
    raise exception 'snapshot_completion_hash_receipt_invalid';
  end if;
  complete_result := public.complete_jiaowubao_open_api_schedule_snapshot_ingest(
    'jiaowubao-snapshot-fixture-secret', run_id, 'Ops Admin'
  );
  if complete_result ->> 'replayed' <> 'true' then
    raise exception 'snapshot_completion_replay_not_idempotent';
  end if;
  identity_result := public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
    'jiaowubao-snapshot-fixture-secret', 'jwb-open-api-schedule',
    'sha256:' || repeat('0', 64), 500, null
  );
  if identity_result ->> 'state' <> 'complete'
     or (identity_result ->> 'rowCount')::integer <> 1
     or identity_result -> 'items' -> 0 ->> 'sourceKey' <> 'jwb-open-api:schedule:cal-1'
     or identity_result -> 'items' -> 0 ->> 'sourceDate' <> '2026-08-21'
     or (identity_result ->> 'hasMore')::boolean
     or identity_result -> 'nextCursor' <> 'null'::jsonb then
    raise exception 'snapshot_identity_page_invalid';
  end if;
  identity_result := public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
    'jiaowubao-snapshot-fixture-secret', 'jwb-open-api-schedule',
    'sha256:' || repeat('9', 64), 500, null
  );
  if identity_result ->> 'state' <> 'reset' then
    raise exception 'snapshot_identity_revision_reset_missing';
  end if;
  perform pg_temp.finish_schedule_projection_fixture();

  -- A run captures the pointer it observed at begin. Another explicit
  -- replacement may win, but the stale run must then refuse to publish.
  stale_run_id := (
    public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
      'jiaowubao-snapshot-fixture-secret',
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(envelope, '{revision}', to_jsonb(('sha256:' || repeat('5', 64))::text)), '{externalManifestSha256}', to_jsonb(('sha256:' || repeat('5', 64))::text)), '{sourceMetadata,manifestSha256}', to_jsonb(('sha256:' || repeat('5', 64))::text)), '{expectedCurrentRevision}', to_jsonb(('sha256:' || repeat('0', 64))::text)),
      'Ops Admin'
    ) ->> 'runId'
  )::uuid;
  perform public.stage_jiaowubao_open_api_schedule_snapshot_page(
    'jiaowubao-snapshot-fixture-secret', stale_run_id, 0,
    '[{"sourceKey":"jwb-open-api:schedule:cal-stale","record":{"cal_id":"cal-stale"}}]'::jsonb,
    'Ops Admin'
  );
  replacement_run_id := (
    public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
      'jiaowubao-snapshot-fixture-secret',
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(envelope, '{revision}', to_jsonb(('sha256:' || repeat('2', 64))::text)), '{externalManifestSha256}', to_jsonb(('sha256:' || repeat('2', 64))::text)), '{sourceMetadata,manifestSha256}', to_jsonb(('sha256:' || repeat('2', 64))::text)), '{expectedCurrentRevision}', to_jsonb(('sha256:' || repeat('0', 64))::text)),
      'Ops Admin'
    ) ->> 'runId'
  )::uuid;
  perform public.stage_jiaowubao_open_api_schedule_snapshot_page(
    'jiaowubao-snapshot-fixture-secret', replacement_run_id, 0,
    '[{"sourceKey":"jwb-open-api:schedule:cal-replacement","record":{"cal_id":"cal-replacement"}}]'::jsonb,
    'Ops Admin'
  );
  perform public.complete_jiaowubao_open_api_schedule_snapshot_ingest(
    'jiaowubao-snapshot-fixture-secret', replacement_run_id, 'Ops Admin'
  );
  perform pg_temp.finish_schedule_projection_fixture();
  begin
    perform public.complete_jiaowubao_open_api_schedule_snapshot_ingest(
      'jiaowubao-snapshot-fixture-secret', stale_run_id, 'Ops Admin'
    );
    raise exception 'snapshot_stale_pointer_replacement_was_accepted';
  exception when sqlstate '55000' then
    null;
  end;
  if (select revision from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key = 'jwb-open-api-schedule') <> ('sha256:' || repeat('2', 64)) then
    raise exception 'snapshot_current_pointer_changed_after_stale_completion';
  end if;

  empty_run_id := (
    public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
      'jiaowubao-snapshot-fixture-secret',
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(envelope, '{revision}', to_jsonb(('sha256:' || repeat('3', 64))::text)), '{externalManifestSha256}', to_jsonb(('sha256:' || repeat('3', 64))::text)), '{sourceMetadata,manifestSha256}', to_jsonb(('sha256:' || repeat('3', 64))::text)), '{expectedCurrentRevision}', to_jsonb(('sha256:' || repeat('2', 64))::text)), '{expectedPageCount}', '0') || jsonb_build_object('expectedRowCount', 0),
      'Ops Admin'
    ) ->> 'runId'
  )::uuid;
  if (public.complete_jiaowubao_open_api_schedule_snapshot_ingest(
    'jiaowubao-snapshot-fixture-secret', empty_run_id, 'Ops Admin'
  ) ->> 'state') <> 'complete' then
    raise exception 'snapshot_empty_completion_failed';
  end if;

  abort_run_id := (
    public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
      'jiaowubao-snapshot-fixture-secret',
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(envelope, '{revision}', to_jsonb(('sha256:' || repeat('4', 64))::text)), '{externalManifestSha256}', to_jsonb(('sha256:' || repeat('4', 64))::text)), '{sourceMetadata,manifestSha256}', to_jsonb(('sha256:' || repeat('4', 64))::text)), '{expectedCurrentRevision}', to_jsonb(('sha256:' || repeat('2', 64))::text)), '{expectedPageCount}', '1'),
      'Ops Admin'
    ) ->> 'runId'
  )::uuid;
  perform public.abort_jiaowubao_open_api_schedule_snapshot_ingest(
    'jiaowubao-snapshot-fixture-secret', abort_run_id, 'Ops Admin'
  );
  if exists (select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id = abort_run_id) then
    raise exception 'snapshot_abort_did_not_cleanup_pages';
  end if;
  if exists (select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id = abort_run_id) then
    raise exception 'snapshot_abort_did_not_cleanup_items';
  end if;
end;
$$;

rollback;

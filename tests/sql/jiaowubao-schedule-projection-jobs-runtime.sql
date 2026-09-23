\ir assert-disposable-database.sql
begin;

do $fixture$
declare
  revision_a text := 'sha256:' || repeat('a', 64);
  revision_b text := 'sha256:' || repeat('b', 64);
  revision_c text := 'sha256:' || repeat('c', 64);
  revision_d text := 'sha256:' || repeat('d', 64);
  revision_e text := 'sha256:' || repeat('e', 64);
  target jsonb;
  transition jsonb;
  lease_receipt jsonb;
  lease_key_a text := 'jwb-open-api-schedule-sync:1790123400000:10000000-0000-4000-8000-00000000000a';
  lease_key_b text := 'jwb-open-api-schedule-sync:1790123400000:20000000-0000-4000-8000-00000000000b';
  before_updated_at timestamptz;
  authority_settings text[];
  bounded_function regprocedure;
begin
  target := public.get_jiaowubao_open_api_schedule_projection_target(
    'projection-job-fixture-secret', 'Ops Admin'
  );
  assert target ->> 'state' = 'ready';
  assert target ->> 'revision' = revision_a;
  assert target ->> 'projectionState' = 'pending';
  assert (target ->> 'rowCount')::integer = 12;
  assert target #>> '{window,start}' = '2026-09-23';
  assert target #>> '{window,end}' = '2026-12-24';

  assert not has_table_privilege(
    'anon', 'internal.jiaowubao_open_api_schedule_projection_jobs', 'SELECT'
  );
  assert not has_table_privilege(
    'authenticated', 'internal.jiaowubao_open_api_schedule_projection_jobs', 'SELECT'
  );
  assert has_function_privilege(
    'anon', 'public.get_jiaowubao_open_api_schedule_projection_target(text,text)', 'EXECUTE'
  );
  assert not has_function_privilege(
    'anon', 'internal.jiaowubao_schedule_projection_allows_stale_trial(text,text)', 'EXECUTE'
  );

  assert not internal.jiaowubao_schedule_projection_allows_stale_trial(revision_a, 'Ops Admin');
  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'pending', 'authority_done', 'Ops Admin'
  );
  assert transition ->> 'state' = 'authority_done';
  assert not (transition ->> 'replayed')::boolean;
  assert internal.jiaowubao_schedule_projection_allows_stale_trial(revision_a, 'Ops Admin');
  assert not internal.jiaowubao_schedule_projection_allows_stale_trial(revision_a, 'Nixon');
  assert not internal.jiaowubao_schedule_projection_allows_stale_trial(revision_a, null);

  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'pending', 'authority_done', 'Ops Admin'
  );
  assert transition ->> 'state' = 'authority_done';
  assert (transition ->> 'replayed')::boolean;

  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'authority_done', 'complete', 'Ops Admin'
  );
  assert transition ->> 'state' = 'complete';
  assert not (transition ->> 'replayed')::boolean;
  assert not internal.jiaowubao_schedule_projection_allows_stale_trial(revision_a, 'Ops Admin');

  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'authority_done', 'complete', 'Ops Admin'
  );
  assert transition ->> 'state' = 'complete';
  assert (transition ->> 'replayed')::boolean;

  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'complete', 'pending', 'Ops Admin'
  );
  assert transition ->> 'state' = 'pending';
  assert not (transition ->> 'replayed')::boolean;
  assert (select authority_completed_at is null and completed_at is null
    from internal.jiaowubao_open_api_schedule_projection_jobs
    where api_source_key = 'jwb-open-api-schedule');
  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'complete', 'pending', 'Ops Admin'
  );
  assert transition ->> 'state' = 'pending';
  assert (transition ->> 'replayed')::boolean;
  perform public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'pending', 'authority_done', 'Ops Admin'
  );
  perform public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'authority_done', 'complete', 'Ops Admin'
  );

  select updated_at into before_updated_at
  from internal.jiaowubao_open_api_schedule_projection_jobs
  where api_source_key = 'jwb-open-api-schedule';
  update internal.jiaowubao_open_api_schedule_snapshot_current
  set published_at = '2026-09-23T01:00:00Z'
  where api_source_key = 'jwb-open-api-schedule';
  assert (select state = 'complete' and updated_at = before_updated_at
    from internal.jiaowubao_open_api_schedule_projection_jobs
    where api_source_key = 'jwb-open-api-schedule');
  update internal.jiaowubao_open_api_schedule_snapshot_current
  set revision = revision, published_at = '2026-09-23T02:00:00Z'
  where api_source_key = 'jwb-open-api-schedule';
  assert (select state = 'complete' and updated_at = before_updated_at
    from internal.jiaowubao_open_api_schedule_projection_jobs
    where api_source_key = 'jwb-open-api-schedule');

  insert into internal.operational_contract_audit(
    id, action, actor, target_type, target_id, detail
  ) values (
    'a0000000-0000-4000-8000-000000000002',
    'fixture.seed', 'Ops Admin', 'fixture', 'seed-b', '{}'
  );
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(
    id, api_source_key, revision, state, query
  ) values (
    '10000000-0000-4000-8000-000000000002',
    'jwb-open-api-schedule', revision_b, 'complete',
    '{"start":"2026-09-24","end":"2026-12-25"}'
  );
  update internal.jiaowubao_open_api_schedule_snapshot_current
  set run_id = '10000000-0000-4000-8000-000000000002',
    revision = revision_b, row_count = 15,
    published_at = '2026-09-24T00:00:00Z',
    audit_id = 'a0000000-0000-4000-8000-000000000002'
  where api_source_key = 'jwb-open-api-schedule';
  assert (select state = 'pending' and revision = revision_b
    from internal.jiaowubao_open_api_schedule_projection_jobs
    where api_source_key = 'jwb-open-api-schedule');

  transition := public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_a, 'authority_done', 'complete', 'Ops Admin'
  );
  assert transition ->> 'state' = 'reset';
  assert transition ->> 'revision' = revision_b;

  insert into internal.operational_contract_audit(
    id, action, actor, target_type, target_id, detail
  ) values (
    'a0000000-0000-4000-8000-000000000003',
    'fixture.seed', 'Ops Admin', 'fixture', 'seed-c', '{}'
  );
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(
    id, api_source_key, revision, state, query
  ) values (
    '10000000-0000-4000-8000-000000000003',
    'jwb-open-api-schedule', revision_c, 'complete',
    '{"start":"2026-09-25","end":"2026-12-26"}'
  );
  begin
    update internal.jiaowubao_open_api_schedule_snapshot_current
    set run_id = '10000000-0000-4000-8000-000000000003',
      revision = revision_c, row_count = 16,
      published_at = '2026-09-25T00:00:00Z',
      audit_id = 'a0000000-0000-4000-8000-000000000003'
    where api_source_key = 'jwb-open-api-schedule';
    raise exception 'pending projection was overwritten';
  exception when sqlstate '55000' then
    null;
  end;
  assert (select revision = revision_b
    from internal.jiaowubao_open_api_schedule_snapshot_current
    where api_source_key = 'jwb-open-api-schedule');
  assert (select revision = revision_b and state = 'pending'
    from internal.jiaowubao_open_api_schedule_projection_jobs
    where api_source_key = 'jwb-open-api-schedule');

  begin
    perform public.advance_jiaowubao_open_api_schedule_projection(
      'projection-job-fixture-secret', revision_b, 'pending', 'complete', 'Ops Admin'
    );
    raise exception 'projection transition skipped a state';
  exception when invalid_parameter_value then
    null;
  end;
  begin
    perform public.get_jiaowubao_open_api_schedule_projection_target(
      'wrong-secret', 'Ops Admin'
    );
    raise exception 'wrong secret accepted';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.get_jiaowubao_open_api_schedule_projection_target(
      'projection-job-fixture-secret', null
    );
    raise exception 'null actor accepted';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.advance_jiaowubao_open_api_schedule_projection(
      'projection-job-fixture-secret', revision_b, 'pending', 'authority_done', null
    );
    raise exception 'null transition actor accepted';
  exception when invalid_parameter_value then
    null;
  end;

  perform public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_b, 'pending', 'authority_done', 'Ops Admin'
  );
  perform public.advance_jiaowubao_open_api_schedule_projection(
    'projection-job-fixture-secret', revision_b, 'authority_done', 'complete', 'Ops Admin'
  );

  insert into internal.operational_contract_audit(
    id, action, actor, target_type, target_id, detail
  ) values (
    'a0000000-0000-4000-8000-000000000004',
    'fixture.seed', 'Ops Admin', 'fixture', 'seed-d', '{}'
  );
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(
    id, api_source_key, revision, state, query
  ) values (
    '10000000-0000-4000-8000-000000000004',
    'jwb-open-api-schedule', revision_d, 'complete',
    '{"start":"2026-09-26","end":"2027-01-10"}'
  );
  begin
    update internal.jiaowubao_open_api_schedule_snapshot_current
    set run_id = '10000000-0000-4000-8000-000000000004',
      revision = revision_d, row_count = 17,
      published_at = '2026-09-26T00:00:00Z',
      audit_id = 'a0000000-0000-4000-8000-000000000004'
    where api_source_key = 'jwb-open-api-schedule';
    raise exception 'invalid source window was published';
  exception when invalid_parameter_value then
    null;
  end;
  assert (select revision = revision_b
    from internal.jiaowubao_open_api_schedule_snapshot_current
    where api_source_key = 'jwb-open-api-schedule');
  assert (select revision = revision_b and state = 'complete'
    from internal.jiaowubao_open_api_schedule_projection_jobs
    where api_source_key = 'jwb-open-api-schedule');

  insert into internal.operational_contract_audit(
    id, action, actor, target_type, target_id, detail
  ) values (
    'a0000000-0000-4000-8000-000000000005',
    'fixture.seed', 'Ops Admin', 'fixture', 'seed-e', '{}'
  );
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(
    id, api_source_key, revision, state, query
  ) values (
    '10000000-0000-4000-8000-000000000005',
    'jwb-open-api-schedule', revision_e, 'complete',
    '{"start":"2026-02-31","end":"2026-03-10"}'
  );
  begin
    update internal.jiaowubao_open_api_schedule_snapshot_current
    set run_id = '10000000-0000-4000-8000-000000000005',
      revision = revision_e, row_count = 18,
      published_at = '2026-09-27T00:00:00Z',
      audit_id = 'a0000000-0000-4000-8000-000000000005'
    where api_source_key = 'jwb-open-api-schedule';
    raise exception 'invalid source date was published';
  exception when invalid_parameter_value then
    null;
  end;
  assert (select revision = revision_b
    from internal.jiaowubao_open_api_schedule_snapshot_current
    where api_source_key = 'jwb-open-api-schedule');

  lease_receipt := public.claim_jiaowubao_open_api_schedule_sync_lease_v2(
    'projection-job-fixture-secret', 'jwb-open-api-schedule', lease_key_a, 'Ops Admin'
  );
  assert (lease_receipt ->> 'acquired')::boolean;
  assert lease_receipt ->> 'runKey' = lease_key_a;
  update internal.jiaowubao_open_api_schedule_sync_leases
  set lease_expires_at = clock_timestamp() - interval '1 second'
  where api_source_key = 'jwb-open-api-schedule';
  lease_receipt := public.claim_jiaowubao_open_api_schedule_sync_lease_v2(
    'projection-job-fixture-secret', 'jwb-open-api-schedule', lease_key_b, 'Ops Admin'
  );
  assert (lease_receipt ->> 'acquired')::boolean;
  assert lease_receipt ->> 'runKey' = lease_key_b;
  lease_receipt := public.release_jiaowubao_open_api_schedule_sync_lease_v2(
    'projection-job-fixture-secret', 'jwb-open-api-schedule', lease_key_a, 'Ops Admin'
  );
  assert not (lease_receipt ->> 'released')::boolean;
  assert (select run_key = lease_key_b and lease_expires_at > clock_timestamp()
    from internal.jiaowubao_open_api_schedule_sync_leases
    where api_source_key = 'jwb-open-api-schedule');
  lease_receipt := public.release_jiaowubao_open_api_schedule_sync_lease_v2(
    'projection-job-fixture-secret', 'jwb-open-api-schedule', lease_key_b, 'Ops Admin'
  );
  assert (lease_receipt ->> 'released')::boolean;

  assert pg_catalog.pg_get_functiondef(
    'public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure
  ) like '%jiaowubao_schedule_projection_allows_stale_trial(p_snapshot_revision,p_actor)%';
  select proconfig into authority_settings
  from pg_catalog.pg_proc
  where oid = 'public.project_jiaowubao_open_api_authority(text,text,text)'::regprocedure;
  assert authority_settings @> array['statement_timeout=110s'];
  foreach bounded_function in array array[
    'public.begin_jiaowubao_open_api_schedule_snapshot_ingest(text,jsonb,text)'::regprocedure,
    'public.stage_jiaowubao_open_api_schedule_snapshot_page(text,uuid,integer,jsonb,text)'::regprocedure,
    'public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text)'::regprocedure,
    'public.confirm_jiaowubao_open_api_schedule_snapshot_current(text,text,text,text)'::regprocedure,
    'public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure,
    'public.advance_jiaowubao_open_api_schedule_projection(text,text,text,text,text)'::regprocedure
  ] loop
    select proconfig into authority_settings
    from pg_catalog.pg_proc
    where oid = bounded_function;
    assert authority_settings @> array['statement_timeout=110s'];
  end loop;
end;
$fixture$;

rollback;

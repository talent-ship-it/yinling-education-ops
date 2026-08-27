-- Corrects the v1 completion function's page-manifest hash calculation. The
-- original assignment referenced the page alias outside a SELECT scope, which
-- left completed source runs safely in staging. This replacement preserves the
-- same lock, pointer-CAS, audit, and immutable publication contract.

create or replace function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(p_secret text,p_run_id uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype; observed_current_revision text; page_count integer; row_count integer; rows_hash text; payload_hash text; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden'; end if;
  select * into run_state from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found'; end if;
  if run_state.staged_by <> p_actor then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch'; end if;
  if run_state.state = 'complete' then return jsonb_build_object('runId',run_state.id,'apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'state','complete','rowCount',run_state.expected_row_count,'rowsSha256',run_state.canonical_rows_sha256,'payloadSha256',run_state.payload_sha256,'replayed',true); end if;
  if run_state.state <> 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || run_state.api_source_key, 0));
  select * into current_row from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key = run_state.api_source_key for update;
  observed_current_revision := case when found then current_row.revision else null end;
  if observed_current_revision is distinct from run_state.expected_current_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_current_pointer_conflict';
  end if;
  select count(*)::integer, coalesce(sum(p.row_count),0)::integer into page_count,row_count from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id = p_run_id;
  if page_count <> run_state.expected_page_count or row_count <> run_state.expected_row_count or exists(select 1 from generate_series(0,run_state.expected_page_count-1) n where not exists(select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id=p_run_id and p.page_index=n)) then raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_pages_incomplete'; end if;
  select 'sha256:' || encode(extensions.digest(coalesce(string_agg(i.canonical_json, '' order by i.page_index,i.item_index),''),'sha256'),'hex') into rows_hash from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id = p_run_id;
  select 'sha256:' || encode(extensions.digest(coalesce(string_agg(p.page_sha256, '' order by p.page_index),''),'sha256'),'hex') into payload_hash from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id = p_run_id;
  audit_id := internal.append_operational_contract_audit('jiaowubao_open_api_schedule_snapshot_ingest.completed',p_actor,'jiaowubao_open_api_schedule_snapshot_ingest_run',p_run_id::text,jsonb_build_object('apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'pageCount',page_count,'rowCount',row_count,'rowsSha256',rows_hash,'payloadSha256',payload_hash));
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='complete',canonical_rows_sha256=rows_hash,payload_sha256=payload_hash,completed_at=now(),completion_audit_id=audit_id where id=p_run_id;
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id) values(run_state.api_source_key,p_run_id,run_state.revision,row_count,rows_hash,payload_hash,audit_id) on conflict(api_source_key) do update set run_id=excluded.run_id,revision=excluded.revision,row_count=excluded.row_count,rows_sha256=excluded.rows_sha256,payload_sha256=excluded.payload_sha256,published_at=now(),audit_id=excluded.audit_id;
  return jsonb_build_object('runId',p_run_id,'apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'state','complete','pageCount',page_count,'rowCount',row_count,'rowsSha256',rows_hash,'payloadSha256',payload_hash,'replayed',false);
end;
$$;

-- Re-state the explicitly approved server grant after replacement. The other
-- snapshot commands remain ungranted to browser roles.
grant execute on function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text) to anon, authenticated;

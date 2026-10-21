\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-history-retained-runtime.sql

create temporary table fixture_algorithm_before as
  select public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']) as input,
    public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null) as pending,
    public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) as visible,
    (select revision from internal.wecom_handover_schedule_epoch where singleton) as epoch,
    (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) as state,
    (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) as sources,
    (select jsonb_agg(to_jsonb(c) order by id) from internal.wecom_trial_handover_cases c) as cases,
    (select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c) as confirmations,
    (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) as evidence;

\ir ../../supabase/migrations/20261021094454_version_wecom_handover_schedule_evidence.sql

do $algorithm_recomputes_current_evidence$
declare before_row fixture_algorithm_before%rowtype; input jsonb; source jsonb; entry jsonb; receipt jsonb; epoch bigint;
begin
  select * into before_row from fixture_algorithm_before;
  select revision into epoch from internal.wecom_handover_schedule_epoch where singleton;
  if jsonb_array_length(before_row.visible) <> 1
      or before_row.pending->'targetSourceMessageIds' ? 'bot:lp-draft:one'
      or epoch <> before_row.epoch + 1 then
    raise exception 'algorithm_fixture_or_exact_increment_failed';
  end if;
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]'
      or not(public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null)
        ->'targetSourceMessageIds' ? 'bot:lp-draft:one') then
    raise exception 'algorithm_did_not_invalidate_and_reselect';
  end if;
  if (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) is distinct from before_row.evidence then
    raise exception 'algorithm_rewrote_stored_evidence';
  end if;
  update internal.wecom_handover_schedule_evidence set input_revision=epoch::text where source_message_id='bot:lp-draft:one';
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]'
      or not(public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null)
        ->'targetSourceMessageIds' ? 'bot:lp-draft:one') then
    raise exception 'algorithm_old_version_same_epoch_became_current';
  end if;
  select value into source from jsonb_array_elements(before_row.input->'sources') where value->>'sourceMessageId'='bot:lp-draft:one';
  entry := jsonb_build_object('sourceMessageId','bot:lp-draft:one','sourceRevision',source->>'sourceRevision',
    'snapshotRevision','retained-current','checkedAt',now(),'status','needs_identity','matchedStudentId',null,'candidates','[]'::jsonb,'algorithmVersion','2');
  begin
    perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',before_row.input->>'inputRevision',jsonb_build_array(entry));
    raise exception 'algorithm_accepted_old_projection';
  exception when serialization_failure then
    if sqlerrm <> 'wecom_schedule_input_changed' then raise; end if;
  end;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']);
  if input->>'inputRevision' <> epoch::text
      or (input - 'inputRevision') is distinct from (before_row.input - 'inputRevision') then
    raise exception 'algorithm_changed_projection_input';
  end if;
  receipt := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if receipt <> '{"checkedCount":1,"matchedCount":0,"candidateCount":0}'::jsonb
      or jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true)) <> 1
      or public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null)
        ->'targetSourceMessageIds' ? 'bot:lp-draft:one' then
    raise exception 'algorithm_current_save_did_not_restore';
  end if;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_row.state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_row.sources
      or (select jsonb_agg(to_jsonb(c) order by id) from internal.wecom_trial_handover_cases c) is distinct from before_row.cases
      or (select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c) is distinct from before_row.confirmations then
    raise exception 'algorithm_modified_business_identity';
  end if;
  begin
    update public.ops_state set payload = payload || '[{"id":"STU-REFRESH-COMPETITOR","name":"Synthetic Refresh Competitor","owner":"Ella"}]'::jsonb
      where entity='students';
    if (select revision from internal.wecom_handover_schedule_epoch where singleton) <= epoch
        or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]' then
      raise exception 'algorithm_disabled_native_invalidation';
    end if;
    raise exception using errcode='P0002',message='synthetic_refresh_rollback';
  exception when no_data_found then null; end;
  if internal.wecom_handover_schedule_algorithm_version() <> '2'
      or has_function_privilege('public','internal.wecom_handover_schedule_algorithm_version()','execute')
      or has_function_privilege('anon','internal.wecom_handover_schedule_algorithm_version()','execute')
      or has_function_privilege('authenticated','internal.wecom_handover_schedule_algorithm_version()','execute')
      or has_function_privilege('service_role','internal.wecom_handover_schedule_algorithm_version()','execute')
      or has_table_privilege('anon','internal.wecom_handover_schedule_evidence','select')
      or has_table_privilege('service_role','internal.wecom_handover_schedule_epoch','update')
      or not (select proconfig @> array['search_path=""','statement_timeout=12s','work_mem=32MB','enable_indexscan=off']
        from pg_proc where oid='public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure)
      or not (select proconfig @> array['search_path=""','statement_timeout=13s','work_mem=32MB']
        from pg_proc where oid='public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)'::regprocedure) then
    raise exception 'algorithm_privileges_or_runtime_settings_changed';
  end if;
  if (select revision from internal.wecom_handover_schedule_epoch where singleton) <> epoch
      or jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true)) <> 1 then
    raise exception 'algorithm_native_rollback_changed_cache';
  end if;
end;
$algorithm_recomputes_current_evidence$;

begin;
create or replace function public.read_wecom_handover_schedule_input(
  p_secret text,p_snapshot_revision text,p_source_message_ids text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $expensive_reader_sentinel$
begin
  raise exception using errcode='P0001',message='algorithm_called_expensive_reader';
end;
$expensive_reader_sentinel$;
do $old_workers_reject_before_reconstitution$
declare entry jsonb; before_evidence jsonb; epoch text; variant text; bad jsonb;
begin
  select evidence into entry from internal.wecom_handover_schedule_evidence where source_message_id='bot:lp-draft:one';
  select revision::text into epoch from internal.wecom_handover_schedule_epoch where singleton;
  select jsonb_agg(to_jsonb(e) order by source_message_id) into before_evidence from internal.wecom_handover_schedule_evidence e;
  foreach variant in array array['missing','old','numeric','null','future'] loop
    bad := entry - 'algorithmVersion';
    if variant='old' then bad := bad || '{"algorithmVersion":"1"}';
    elsif variant='numeric' then bad := bad || '{"algorithmVersion":2}';
    elsif variant='null' then bad := bad || '{"algorithmVersion":null}';
    elsif variant='future' then bad := bad || '{"algorithmVersion":"3"}';
    end if;
    begin
      perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',epoch,jsonb_build_array(entry,bad));
      raise exception 'algorithm_old_worker_was_accepted_%',variant;
    exception when serialization_failure then
      if sqlerrm <> 'wecom_schedule_algorithm_changed' then raise; end if;
    end;
    update internal.wecom_handover_schedule_evidence set evidence=bad,input_revision=epoch
      where source_message_id='bot:lp-draft:one';
    if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true) <> '[]' then
      raise exception 'algorithm_wrong_version_cache_was_visible_%',variant;
    end if;
    update internal.wecom_handover_schedule_evidence set evidence=entry where source_message_id='bot:lp-draft:one';
  end loop;
  if (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) is distinct from before_evidence then
    raise exception 'algorithm_old_worker_changed_cached_batch';
  end if;
end;
$old_workers_reject_before_reconstitution$;
rollback;

do $algorithm_exact_keys_and_current_restore$
declare entry jsonb; epoch text; input jsonb; source jsonb;
begin
  select evidence into entry from internal.wecom_handover_schedule_evidence where source_message_id='bot:lp-draft:one';
  select revision::text into epoch from internal.wecom_handover_schedule_epoch where singleton;
  begin
    perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',epoch,
      jsonb_build_array(entry||'{"unexpectedAlgorithmField":"unsafe"}'));
    raise exception 'algorithm_version_weakened_exact_key_whitelist';
  exception when invalid_parameter_value then
    if sqlerrm <> 'invalid_wecom_schedule_evidence' then raise; end if;
  end;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']);
  if jsonb_array_length(input->'events')=0
      or jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true))<>1 then
    raise exception 'algorithm_sentinel_rollback_did_not_restore_reader';
  end if;
end;
$algorithm_exact_keys_and_current_restore$;

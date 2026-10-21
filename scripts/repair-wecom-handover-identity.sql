create or replace function pg_temp.repair_wecom_handover_identity(
  p_case_id uuid,
  p_expected_revision text,
  p_actor text,
  p_apply boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $repair$
declare
  legacy internal.wecom_trial_handover_cases%rowtype;
  message internal.wecom_archive_messages%rowtype;
  source_revision text;
  source_evidence jsonb;
  total_messages integer;
  repairable_messages integer;
  result jsonb;
  summary jsonb;
  receipt jsonb;
begin
  if p_case_id is null or p_apply is null or nullif(btrim(p_actor), '') is null
     or length(p_actor) > 120
     or (p_apply and coalesce(p_expected_revision, '') !~ '^[a-f0-9]{64}$') then
    raise exception 'wecom_identity_repair_invalid_arguments';
  end if;
  if to_regprocedure('internal.wecom_guardian_identity_label(text)') is null
     or position('canonical_wechat := internal.wecom_guardian_identity_label(archive.guardian_wechat_hint);'
       in pg_get_functiondef('internal.upsert_wecom_trial_handover_case(text,text)'::regprocedure)) = 0 then
    raise exception 'wecom_identity_repair_safe_matching_required';
  end if;
  if p_apply then
    perform set_config('lock_timeout', '5s', true);
    lock table internal.wecom_archive_messages in share row exclusive mode;
  end if;
  select * into legacy from internal.wecom_trial_handover_cases where id = p_case_id;
  if not found then raise exception 'wecom_identity_repair_case_not_found'; end if;
  if p_apply then
    perform pg_advisory_xact_lock(hashtextextended(legacy.chat_id, 0));
    select * into legacy from internal.wecom_trial_handover_cases where id = p_case_id for update;
    select metadata into receipt from internal.operational_contract_audit
    where action = 'wecom.bot.trial_handover_identity_repair'
      and target_type = 'wecom_trial_handover' and target_id = p_case_id::text
      and metadata ->> 'sourceRevision' = p_expected_revision
    order by created_at desc limit 1;
    if found then return receipt || jsonb_build_object('applied', false, 'replayed', true); end if;
  end if;
  if legacy.status <> 'identity_conflict'
     or internal.wecom_guardian_identity_label(legacy.wechat_name) is not null then
    raise exception 'wecom_identity_repair_case_not_eligible';
  end if;
  if exists (select 1 from internal.wecom_lp_confirmations where case_id = p_case_id)
     or exists (
       select 1 from internal.wecom_archive_messages m
       where m.trial_handover_id = p_case_id and (
         m.student_id is not null or m.match_status <> 'pending'
         or m.projected_message_id is not null or m.projected_at is not null
         or m.ingested_by <> 'WeCom Bot Receiver' or m.message_type <> 'text'
         or m.classification <> 'handover'
         or exists (select 1 from internal.wecom_lp_confirmations cf where cf.source_message_id = m.message_id)
         or exists (select 1 from internal.wecom_archive_media a where a.message_id = m.message_id
           and (a.student_id is not null or a.projected_file_id is not null))
       )
     ) then
    raise exception 'wecom_identity_repair_protected_records';
  end if;
  select count(*), count(*) filter (where internal.wecom_guardian_identity_label(m.guardian_wechat_hint) is not null),
    jsonb_agg(to_jsonb(m) - 'trial_handover_id' - 'updated_at' order by m.message_id)
  into total_messages, repairable_messages, source_evidence
  from internal.wecom_archive_messages m where m.trial_handover_id = p_case_id;
  select encode(extensions.digest(jsonb_build_object(
    'case', to_jsonb(legacy), 'messages', source_evidence,
    'destinations', (select jsonb_agg(to_jsonb(c) order by c.id)
      from internal.wecom_trial_handover_cases c where c.chat_id = legacy.chat_id and c.id <> p_case_id)
  )::text, 'sha256'), 'hex') into source_revision;
  summary := jsonb_build_object('caseId', p_case_id, 'sourceRevision', source_revision,
    'totalMessages', total_messages, 'repairableMessages', repairable_messages,
    'retainedMessages', total_messages - repairable_messages, 'applied', false);
  if not p_apply then return summary; end if;
  if source_revision is distinct from p_expected_revision then
    raise exception 'wecom_identity_repair_revision_changed';
  end if;
  for message in select * from internal.wecom_archive_messages m
    where m.trial_handover_id = p_case_id
      and internal.wecom_guardian_identity_label(m.guardian_wechat_hint) is not null
    order by m.sent_at, m.message_id
  loop
    update internal.wecom_archive_messages set trial_handover_id = null where message_id = message.message_id;
    result := internal.upsert_wecom_trial_handover_case(message.message_id, p_actor);
    if result ->> 'caseId' is null or result ->> 'caseId' = p_case_id::text
       or result ->> 'status' not in ('awaiting_student_name', 'identified', 'identity_conflict') then
      raise exception 'wecom_identity_repair_match_not_unique';
    end if;
    if exists (select 1 from internal.wecom_lp_confirmations where case_id = (result ->> 'caseId')::uuid) then
      raise exception 'wecom_identity_repair_protected_destination';
    end if;
    perform internal.append_operational_contract_audit(
      'wecom.bot.trial_handover_identity_repair_message', p_actor, 'wecom_archive_message', message.message_id,
      jsonb_build_object('sourceCaseId', p_case_id, 'targetCaseId', result ->> 'caseId', 'sourceRevision', source_revision)
    );
  end loop;
  if source_evidence is distinct from (
    select jsonb_agg(to_jsonb(m) - 'trial_handover_id' - 'updated_at' order by m.message_id)
    from internal.wecom_archive_messages m where m.message_id in (
      select item ->> 'message_id' from jsonb_array_elements(source_evidence) item
    )
  ) then raise exception 'wecom_identity_repair_source_changed'; end if;
  summary := summary || jsonb_build_object('applied', true);
  perform internal.append_operational_contract_audit(
    'wecom.bot.trial_handover_identity_repair', p_actor, 'wecom_trial_handover', p_case_id::text, summary
  );
  return summary;
end;
$repair$;

revoke all on function pg_temp.repair_wecom_handover_identity(uuid,text,text,boolean) from public, anon, authenticated, service_role;

\ir assert-disposable-database.sql

begin;
create temporary table identity_checks (name text primary key);

insert into internal.wecom_trial_handover_cases (
  chat_id, wechat_name, wechat_name_key, status
) values ('safe-legacy-room', '-@教务AI助手', '-@教务ai助手', 'identity_conflict');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, guardian_wechat_hint, match_status, ingested_by
) values (
  'safe-parent-a', repeat('a', 64), 'safe-legacy-room', 'fixture-sales', now(), 'text',
  E'信息交接表\n微信名:Aster@教务AI助手',
  'handover', 'Aster@教务AI助手', 'pending', 'WeCom Bot Receiver'
);

do $$
begin
  if exists (
    select 1 from internal.wecom_archive_messages archive
    join internal.wecom_trial_handover_cases handover on handover.id = archive.trial_handover_id
    where archive.message_id = 'safe-parent-a' and handover.wechat_name = '-@教务AI助手'
  ) then
    raise exception 'bot_only_legacy_case_absorbed_parent';
  end if;
  if not exists (
    select 1 from internal.wecom_archive_messages archive
    join internal.wecom_trial_handover_cases handover on handover.id = archive.trial_handover_id
    where archive.message_id = 'safe-parent-a'
      and handover.wechat_name = 'Aster'
      and handover.status = 'awaiting_student_name'
      and handover.student_name is null
      and archive.guardian_wechat_hint = 'Aster@教务AI助手'
      and archive.body = E'信息交接表\n微信名:Aster@教务AI助手'
      and archive.student_id is null
  ) then
    raise exception 'safe_parent_identity_or_raw_evidence_not_preserved';
  end if;
end;
$$;
insert into identity_checks values ('bot_only_legacy_isolation');

do $$
declare
  hint text;
  result jsonb;
  before_count bigint;
  index integer := 0;
begin
  select count(*) into before_count from internal.wecom_trial_handover_cases;
  foreach hint in array array[
    null, '', E' \t ', '-', '——', '【】。。。', '@教务AI助手', '-@教务AI助手',
    '＠教务AI助手', '教务AI助手', '待补充', '待确认', '待填写', '暂无', '未知',
    '无', '未提供', 'N/A', 'none', 'null', 'unknown', 'TBD'
  ] loop
    index := index + 1;
    insert into internal.wecom_archive_messages (
      message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
      classification, guardian_wechat_hint, match_status, ingested_by
    ) values (
      'safe-invalid-' || index, repeat('b', 64), 'safe-invalid-room', 'fixture-sales', now(), 'text',
      'handover', hint, 'pending', 'WeCom Bot Receiver'
    );
    result := internal.upsert_wecom_trial_handover_case('safe-invalid-' || index, 'fixture');
    if result ->> 'status' <> 'not_eligible'
       or result ->> 'changed' <> 'false'
       or exists (select 1 from internal.wecom_archive_messages
         where message_id = 'safe-invalid-' || index and trial_handover_id is not null) then
      raise exception 'invalid_guardian_identity_accepted_at_vector_%', index;
    end if;
  end loop;
  if (select count(*) from internal.wecom_trial_handover_cases) <> before_count then
    raise exception 'invalid_guardian_identity_created_case';
  end if;
end;
$$;
insert into identity_checks values ('empty_punctuation_placeholder_bot_rejection');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-substring-short', repeat('c', 64), 'safe-substring-room', 'fixture', now(), 'text',
    'handover', 'Aster', 'pending', 'WeCom Bot Receiver'),
  ('safe-substring-long', repeat('d', 64), 'safe-substring-room', 'fixture', now(), 'text',
    'handover', 'Aster Rose', 'pending', 'WeCom Bot Receiver');

do $$
begin
  if (select count(distinct trial_handover_id) from internal.wecom_archive_messages
      where message_id in ('safe-substring-short', 'safe-substring-long')) <> 2 then
    raise exception 'arbitrary_substring_merged_distinct_parents';
  end if;
end;
$$;
insert into identity_checks values ('arbitrary_substring_rejected');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, student_name_hint, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-format-initial', repeat('e', 64), 'safe-format-room', 'fixture', now(), 'text',
    'handover', null, 'Melbourne Parent', 'pending', 'WeCom Bot Receiver'),
  ('safe-format-confirm', repeat('f', 64), 'safe-format-room', 'fixture', now(), 'text',
    'handover', 'Fixture Student', 'Melbourne-Parent（妈妈）', 'pending', 'WeCom Bot Receiver');

do $$
begin
  if (select count(distinct trial_handover_id) from internal.wecom_archive_messages
      where message_id in ('safe-format-initial', 'safe-format-confirm')) <> 1
     or not exists (select 1 from internal.wecom_trial_handover_cases
       where chat_id = 'safe-format-room' and status = 'identified' and student_name = 'Fixture Student') then
    raise exception 'safe_format_and_explicit_parent_suffix_broken';
  end if;
end;
$$;
insert into identity_checks values ('unique_format_parent_suffix_preserved');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-email-at', repeat('1', 64), 'safe-email-room', 'fixture', now(), 'text',
    'handover', 'aster@example.test', 'pending', 'WeCom Bot Receiver'),
  ('safe-email-no-at', repeat('2', 64), 'safe-email-room', 'fixture', now(), 'text',
    'handover', 'asterexample.test', 'pending', 'WeCom Bot Receiver'),
  ('safe-parent-b', repeat('3', 64), 'safe-legacy-room', 'fixture', now(), 'text',
    'handover', 'Birch@教务AI助手', 'pending', 'WeCom Bot Receiver');

do $$
begin
  if (select count(distinct trial_handover_id) from internal.wecom_archive_messages
      where message_id in ('safe-email-at', 'safe-email-no-at')) <> 2
     or internal.wecom_identity_key('parent@legit') <> 'parent@legit'
     or internal.wecom_identity_key('parent@教务AI助手.example') <> 'parent@教务ai助手.example' then
    raise exception 'legitimate_at_identity_erased';
  end if;
  if (select count(distinct trial_handover_id) from internal.wecom_archive_messages
      where message_id in ('safe-parent-a', 'safe-parent-b')) <> 2 then
    raise exception 'shared_bot_mention_merged_different_parents';
  end if;
end;
$$;
insert into identity_checks values ('legitimate_at_and_distinct_bot_parents_preserved');

insert into internal.wecom_trial_handover_cases (chat_id, wechat_name, wechat_name_key, status) values
  ('safe-ambiguous-room', 'Cedar Parent', 'cedarparent', 'awaiting_student_name'),
  ('safe-ambiguous-room', 'Cedar-Parent', 'cedar-parent', 'awaiting_student_name');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, student_name_hint, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-ambiguous-tolerant', repeat('4', 64), 'safe-ambiguous-room', 'fixture', now(), 'text',
    'handover', 'Do Not Assign', 'Cedar.Parent', 'pending', 'WeCom Bot Receiver'),
  ('safe-ambiguous-exact', repeat('5', 64), 'safe-ambiguous-room', 'fixture', now(), 'text',
    'handover', 'Do Not Assign', 'Cedar Parent', 'pending', 'WeCom Bot Receiver');

do $$
declare result jsonb;
begin
  if exists (select 1 from internal.wecom_archive_messages
      where message_id in ('safe-ambiguous-tolerant', 'safe-ambiguous-exact')
        and (trial_handover_id is not null or student_id is not null))
     or (select count(*) from internal.wecom_trial_handover_cases where chat_id = 'safe-ambiguous-room') <> 2
     or exists (select 1 from internal.wecom_trial_handover_cases
       where chat_id = 'safe-ambiguous-room' and student_name is not null) then
    raise exception 'ambiguous_strong_candidates_must_remain_unassociated';
  end if;
  result := internal.upsert_wecom_trial_handover_case('safe-ambiguous-exact', 'fixture');
  if result ->> 'status' <> 'identity_ambiguous'
     or result ->> 'matchMode' <> 'ambiguous'
     or (result ->> 'tolerantCandidateCount')::integer <> 2
     or result ->> 'changed' <> 'false' then
    raise exception 'ambiguous_identity_result_not_fail_closed';
  end if;
end;
$$;
insert into identity_checks values ('all_strong_candidates_unique_or_unassociated');

insert into internal.ops_secrets (key, sha256_hex)
values ('workspace_api', encode(extensions.digest('wecom-fixture-secret', 'sha256'), 'hex'));
insert into public.ops_state (entity, payload) values
  ('students', '[{"id":"fixture-bot-only","name":"Bot-only Roster","guardianWechat":"-@教务AI助手","files":0},{"id":"fixture-active","name":"Exact Student","guardianWechat":"Aster","files":0}]'),
  ('files', '[]'), ('messages', '[]'), ('lpItems', '[]'), ('bookings', '[]'), ('payments', '[]');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, guardian_wechat_hint, match_status, ingested_by
) values (
  'safe-active-invalid', repeat('6', 64), 'safe-active-room', 'fixture', now(), 'text',
  'handover', '-@教务AI助手', 'pending', 'fixture-source'
);

do $$
declare
  result jsonb;
  before_state jsonb;
begin
  select jsonb_agg(to_jsonb(state) order by entity) into before_state from public.ops_state state;
  result := internal.auto_match_wecom_archive_message('safe-active-invalid', 'fixture');
  if result ->> 'status' <> 'pending' or exists (
    select 1 from internal.wecom_archive_messages
    where message_id = 'safe-active-invalid' and (student_id is not null or projected_at is not null)
  ) then
    raise exception 'active_matcher_accepted_bot_only_guardian';
  end if;
  begin
    perform internal.project_wecom_archive_message('safe-active-invalid', 'fixture-bot-only', 'fixture', true);
    raise exception 'projection_recheck_accepted_bot_only_guardian';
  exception when serialization_failure then null;
  end;
  if before_state is distinct from (select jsonb_agg(to_jsonb(state) order by entity) from public.ops_state state) then
    raise exception 'invalid_guardian_projection_mutated_business_state';
  end if;
end;
$$;
insert into identity_checks values ('active_matcher_and_projection_recheck_reject_bot_only');

do $$
declare
  result jsonb;
  payload jsonb := jsonb_build_array(jsonb_build_object(
    'messageId', 'safe-full-archive-invalid', 'chatId', 'safe-active-room', 'senderId', 'fixture',
    'sentAt', now(), 'messageType', 'text', 'text', '信息交接表', 'classification', 'handover',
    'guardianWechatHint', '-@教务AI助手', 'media', '[]'::jsonb
  ));
begin
  set local role anon;
  result := public.ingest_wecom_archive_batch('wecom-fixture-secret', payload, '2026-01-01T00:00:00Z', 'fixture');
  reset role;
  if result ->> 'linked' <> '0' or result ->> 'pending' <> '1' or exists (
    select 1 from internal.wecom_archive_messages
    where message_id = 'safe-full-archive-invalid' and (student_id is not null or projected_at is not null)
  ) then
    raise exception 'full_archive_ingest_accepted_bot_only_guardian';
  end if;
end;
$$;
insert into identity_checks values ('full_archive_ingest_rejects_bot_only');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-email-dot', repeat('7', 64), 'safe-email-dot-room', 'fixture', now(), 'text',
    'handover', 'aster.name@example.test', 'pending', 'WeCom Bot Receiver'),
  ('safe-email-without-dot', repeat('8', 64), 'safe-email-dot-room', 'fixture', now(), 'text',
    'handover', 'astername@example.test', 'pending', 'WeCom Bot Receiver');

do $$
begin
  if internal.wecom_identity_key('@unknown') is distinct from '@unknown'
     or internal.wecom_identity_key('N/A@example.test') is distinct from 'n/a@example.test'
     or (select count(distinct trial_handover_id) from internal.wecom_archive_messages
       where message_id in ('safe-email-dot', 'safe-email-without-dot')) <> 2 then
    raise exception 'legitimate_at_handle_or_email_punctuation_collapsed';
  end if;
end;
$$;
insert into identity_checks values ('at_handles_and_email_punctuation_are_identity');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-at-role-literal', repeat('9', 64), 'safe-at-role-room', 'fixture', now(), 'text',
    'handover', 'aster@example妈妈', 'pending', 'WeCom Bot Receiver'),
  ('safe-at-role-other', repeat('0', 64), 'safe-at-role-room', 'fixture', now(), 'text',
    'handover', 'aster@example', 'pending', 'WeCom Bot Receiver');

do $$
begin
  if (select count(distinct trial_handover_id) from internal.wecom_archive_messages
      where message_id in ('safe-at-role-literal', 'safe-at-role-other')) <> 2 then
    raise exception 'literal_at_handle_treated_as_parent_role_suffix';
  end if;
end;
$$;
insert into identity_checks values ('at_handle_role_suffix_is_literal');

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
  classification, guardian_wechat_hint, match_status, ingested_by
) values
  ('safe-other-group', repeat('a', 64), 'safe-other-room', 'fixture', now(), 'text',
    'handover', 'Aster@教务AI助手', 'pending', 'WeCom Bot Receiver'),
  ('safe-short-exact-a', repeat('b', 64), 'safe-short-room', 'fixture', now(), 'text',
    'handover', '安安', 'pending', 'WeCom Bot Receiver'),
  ('safe-short-exact-b', repeat('c', 64), 'safe-short-room', 'fixture', now(), 'text',
    'handover', '安安@教务AI助手', 'pending', 'WeCom Bot Receiver'),
  ('safe-distinct-mother', repeat('d', 64), 'safe-parent-role-room', 'fixture', now(), 'text',
    'handover', 'Aster妈妈', 'pending', 'WeCom Bot Receiver'),
  ('safe-distinct-father', repeat('e', 64), 'safe-parent-role-room', 'fixture', now(), 'text',
    'handover', 'Aster爸爸', 'pending', 'WeCom Bot Receiver');

do $$
begin
  if (select trial_handover_id from internal.wecom_archive_messages where message_id = 'safe-other-group')
       = (select trial_handover_id from internal.wecom_archive_messages where message_id = 'safe-parent-a')
     or (select count(distinct trial_handover_id) from internal.wecom_archive_messages
       where message_id in ('safe-short-exact-a', 'safe-short-exact-b')) <> 1
     or (select count(distinct trial_handover_id) from internal.wecom_archive_messages
       where message_id in ('safe-distinct-mother', 'safe-distinct-father')) <> 2 then
    raise exception 'group_short_exact_or_distinct_parent_roles_broken';
  end if;
end;
$$;
insert into identity_checks values ('group_isolation_short_exact_and_distinct_roles');

do $$
declare
  result jsonb;
  original_row jsonb;
  original_case jsonb;
  original_audits bigint;
  original_students jsonb;
  payload jsonb := jsonb_build_array(jsonb_build_object(
    'messageId', 'bot:' || repeat('a', 64), 'chatId', 'safe-rpc-room', 'senderId', 'fixture',
    'sentAt', now(), 'messageType', 'text', 'text', E'信息交接表\n微信名:Aster@教务AI助手',
    'classification', 'handover', 'studentNameHint', 'Exact Student', 'guardianWechatHint', 'Aster@教务AI助手'
  ));
begin
  select state.payload into original_students from public.ops_state state where entity = 'students';
  set local role anon;
  result := public.ingest_wecom_bot_batch('wecom-fixture-secret', payload, '2026-01-01T00:00:00Z', 'WeCom Bot Receiver');
  reset role;
  if result ->> 'inserted' <> '1' or result ->> 'linked' <> '1' then
    raise exception 'unique_valid_normalized_guardian_not_linked_through_real_rpc';
  end if;
  select to_jsonb(archive) into original_row from internal.wecom_archive_messages archive
    where message_id = 'bot:' || repeat('a', 64);
  select to_jsonb(handover) into original_case from internal.wecom_trial_handover_cases handover
    where id = (original_row ->> 'trial_handover_id')::uuid;
  select count(*) into original_audits from internal.operational_contract_audit;
  set local role anon;
  result := public.ingest_wecom_bot_batch('wecom-fixture-secret', payload, '2026-01-01T00:00:00Z', 'WeCom Bot Receiver');
  reset role;
  if result ->> 'duplicates' <> '1' or result ->> 'inserted' <> '0'
     or original_row is distinct from (select to_jsonb(archive) from internal.wecom_archive_messages archive
       where message_id = 'bot:' || repeat('a', 64))
     or original_case is distinct from (select to_jsonb(handover) from internal.wecom_trial_handover_cases handover
       where id = (original_row ->> 'trial_handover_id')::uuid)
     or original_audits <> (select count(*) from internal.operational_contract_audit)
     or original_row ->> 'guardian_wechat_hint' <> 'Aster@教务AI助手'
     or original_row ->> 'body' <> E'信息交接表\n微信名:Aster@教务AI助手'
     or original_students is distinct from (select state.payload from public.ops_state state where entity = 'students') then
    raise exception 'exact_replay_raw_evidence_hash_or_student_state_changed';
  end if;
  begin
    set local role anon;
    perform public.ingest_wecom_bot_batch('wecom-fixture-secret',
      jsonb_set(payload, '{0,guardianWechatHint}', '"Aster"'), '2026-01-01T00:00:00Z', 'WeCom Bot Receiver');
    reset role;
    raise exception 'raw_hint_change_did_not_retain_idempotency_conflict';
  exception when unique_violation then reset role;
  end;
end;
$$;
insert into identity_checks values ('real_anon_rpc_normalized_positive_raw_hash_replay_contract');

do $$
declare
  role_name text;
  signature text;
  secret text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    foreach signature in array array[
      'internal.wecom_guardian_identity_label(text)', 'internal.wecom_identity_key(text)',
      'internal.wecom_trial_identity_core_key(text)', 'internal.upsert_wecom_trial_handover_case(text,text)'
    ] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'internal_identity_execute_privilege_widened';
      end if;
    end loop;
    execute format('set local role %I', role_name);
    begin
      perform internal.wecom_guardian_identity_label('Aster');
      raise exception 'private_identity_helper_exposed';
    exception when insufficient_privilege then null;
    end;
    begin
      perform 1 from internal.wecom_trial_handover_cases;
      raise exception 'private_identity_table_exposed';
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
  foreach secret in array array[null, '', 'wrong-fixture-secret'] loop
    begin
      set local role anon;
      perform public.ingest_wecom_bot_batch(secret, '[]', now(), 'fixture');
      reset role;
      raise exception 'invalid_secret_accepted';
    exception when insufficient_privilege then reset role;
    end;
  end loop;
  if exists (
    select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'internal' and procedure.proname in (
      'wecom_guardian_identity_label', 'wecom_identity_key', 'wecom_trial_identity_core_key'
    ) and (procedure.provolatile <> 'i' or not procedure.proisstrict or procedure.prosecdef
      or procedure.proconfig is distinct from array['search_path=""'])
  ) then
    raise exception 'identity_helper_attributes_not_least_privilege';
  end if;
end;
$$;
insert into identity_checks values ('real_roles_secret_denials_and_helper_permissions');

do $$
declare original_row jsonb;
begin
  select to_jsonb(archive) into original_row from internal.wecom_archive_messages archive
    where message_id = 'safe-active-invalid';
  update internal.wecom_archive_messages set student_id = 'fixture-active', match_status = 'linked',
    projected_message_id = 'manual-fixture', projected_at = now()
    where message_id = 'safe-active-invalid';
  select to_jsonb(archive) into original_row from internal.wecom_archive_messages archive
    where message_id = 'safe-active-invalid';
  perform internal.auto_match_wecom_archive_message('safe-active-invalid', 'fixture');
  if original_row is distinct from (select to_jsonb(archive) from internal.wecom_archive_messages archive
      where message_id = 'safe-active-invalid')
     or exists (select 1 from public.ops_state where entity in ('lpItems', 'bookings', 'payments')
       and (payload <> '[]' or version <> 1)) then
    raise exception 'manual_link_or_formal_business_state_changed';
  end if;
end;
$$;
insert into identity_checks values ('manual_link_and_formal_business_state_preserved');

select jsonb_build_object(
  'result', 'wecom_trial_handover_safe_identity_runtime_ok',
  'checks', (select jsonb_agg(name order by name) from identity_checks),
  'count', (select count(*) from identity_checks)
);
rollback;

insert into public.ops_state(entity,payload) values ('students','[]') on conflict(entity) do nothing;

begin;
insert into public.ops_state(entity,payload) values ('files','[]'),('messages','[]') on conflict(entity) do nothing;
update public.ops_state set payload='[{"id":"moved-fixture","name":"Moved Fixture","guardianWechat":"-@教务AI助手","files":0},{"id":"correct-fixture","name":"Correct Fixture","guardianWechat":"Aster","files":0}]'::jsonb where entity='students';
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,guardian_wechat_hint,match_status,ingested_by)
values('ind-null-key-recheck',repeat('a',64),'ind-null-room','fixture',now(),'text','synthetic evidence','handover','Aster','pending','independent fixture');
DO $$ BEGIN
 BEGIN
  PERFORM internal.project_wecom_archive_message('ind-null-key-recheck','moved-fixture','independent fixture',true);
  RAISE EXCEPTION 'independent_projection_recheck_null_key_bypassed';
 EXCEPTION WHEN serialization_failure THEN NULL;
 END;
END $$;
select 'invalid_target_denied_ok';
rollback;

begin;
insert into public.ops_state(entity,payload) values ('files','[]'),('messages','[]') on conflict(entity) do nothing;
update public.ops_state set payload='[{"id":"moved-name-fixture","name":null,"files":0},{"id":"correct-name-fixture","name":"Exact Student","files":0}]'::jsonb where entity='students';
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,student_name_hint,match_status,ingested_by)
values('ind-null-name-recheck',repeat('b',64),'ind-null-name-room','fixture',now(),'text','synthetic evidence','handover','Exact Student','pending','independent fixture');
DO $$ BEGIN
 BEGIN
  PERFORM internal.project_wecom_archive_message('ind-null-name-recheck','moved-name-fixture','independent fixture',true);
  RAISE EXCEPTION 'independent_projection_recheck_null_name_bypassed';
 EXCEPTION WHEN serialization_failure THEN NULL;
 END;
END $$;
select 'invalid_name_target_denied_ok';
rollback;

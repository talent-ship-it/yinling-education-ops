\ir wecom-trial-handover-identity-runtime.sql
\ir ../../supabase/migrations/20260915000400_wecom_trial_handover_tolerant_identity.sql

-- A role suffix and punctuation change are safe only because this group has
-- exactly one obvious case. The later student name must attach to the initial
-- record rather than make a duplicate case.
insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:tolerant-identity-initial', repeat('d', 64), 'fixture-tolerant-room', 'fixture-sales', now(), 'text',
  '【微信名】：Melbourne Parent' || E'\n' || '【教务】：Thea' || E'\n' || '【课程规划老师】：Elaine',
  'handover', null, 'Melbourne Parent', null, 'pending', 'WeCom Bot Receiver'
);

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:tolerant-identity-name', repeat('e', 64), 'fixture-tolerant-room', 'fixture-sales', now(), 'text',
  '【微信名】：Melbourne-Parent（妈妈）' || E'\n' || '【学生姓名】：Mia Tolerant米娅',
  'handover', 'Mia Tolerant米娅', 'Melbourne-Parent（妈妈）', null, 'pending', 'WeCom Bot Receiver'
);

do $$
declare handover_case internal.wecom_trial_handover_cases%rowtype;
begin
  select * into handover_case
  from internal.wecom_trial_handover_cases
  where chat_id = 'fixture-tolerant-room';
  if not found
     or handover_case.status <> 'identified'
     or handover_case.student_name <> 'Mia Tolerant米娅' then
    raise exception 'tolerant_trial_identity_not_confirmed';
  end if;
  if (select count(*) from internal.wecom_archive_messages
      where trial_handover_id = handover_case.id) <> 2 then
    raise exception 'tolerant_trial_identity_not_grouped';
  end if;
  if not exists (
    select 1 from internal.operational_contract_audit
    where action = 'wecom.bot.trial_handover_identity'
      and metadata ->> 'identityMatchMode' = 'tolerant_unique'
  ) then
    raise exception 'tolerant_trial_identity_not_audited';
  end if;
end;
$$;

-- A short name that could refer to two cases must not associate with either.
insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:tolerant-ambiguous-alpha', repeat('f', 64), 'fixture-ambiguous-room', 'fixture-sales', now(), 'text',
  '【微信名】：Alice Alpha', 'handover', null, 'Alice Alpha', null, 'pending', 'WeCom Bot Receiver'
);

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:tolerant-ambiguous-beta', repeat('0', 64), 'fixture-ambiguous-room', 'fixture-sales', now(), 'text',
  '【微信名】：Alice Beta', 'handover', null, 'Alice Beta', null, 'pending', 'WeCom Bot Receiver'
);

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:tolerant-ambiguous-name', repeat('1', 64), 'fixture-ambiguous-room', 'fixture-sales', now(), 'text',
  '【微信名】：Alice' || E'\n' || '【学生姓名】：Mia Ambiguous米娅',
  'handover', 'Mia Ambiguous米娅', 'Alice', null, 'pending', 'WeCom Bot Receiver'
);

do $$
declare ambiguous_case internal.wecom_trial_handover_cases%rowtype;
begin
  select handover_case.* into ambiguous_case
  from internal.wecom_archive_messages archive
  join internal.wecom_trial_handover_cases handover_case on handover_case.id = archive.trial_handover_id
  where archive.message_id = 'bot:tolerant-ambiguous-name';
  if not found
     or ambiguous_case.status <> 'identity_ambiguous'
     or ambiguous_case.wechat_name <> 'Alice'
     or ambiguous_case.student_name <> 'Mia Ambiguous米娅' then
    raise exception 'tolerant_trial_identity_ambiguity_not_held';
  end if;
  if exists (select 1 from public.ops_state) then
    raise exception 'tolerant_trial_identity_created_business_state';
  end if;
end;
$$;

select 'wecom_trial_handover_tolerant_identity_runtime_ok' as result;

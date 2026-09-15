\ir assert-disposable-database.sql

drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_state cascade;

create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null,
  updated_at timestamptz default now(),
  updated_by text
);

create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text,
  actor text,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz default now()
);

create function internal.verify_ops_secret(p_secret text)
returns boolean language sql as $$ select p_secret = 'wecom-fixture-secret' $$;

create function internal.append_operational_contract_audit(
  p_action text, p_actor text, p_target_type text, p_target_id text, p_metadata jsonb default '{}'
)
returns uuid
language plpgsql
as $$
declare receipt uuid;
begin
  insert into internal.operational_contract_audit(action, actor, target_type, target_id, metadata)
  values (p_action, p_actor, p_target_type, p_target_id, p_metadata)
  returning id into receipt;
  return receipt;
end;
$$;

create table internal.wecom_archive_messages (
  message_id text primary key,
  content_sha256 text not null,
  chat_id text not null,
  sender_id text not null,
  sent_at timestamptz not null,
  message_type text not null check (message_type in ('text', 'image', 'file', 'mixed', 'other')),
  body text,
  classification text not null check (classification in ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')),
  student_name_hint text,
  guardian_wechat_hint text,
  student_id text,
  match_status text not null check (match_status in ('pending', 'ambiguous', 'linked')),
  projected_message_id text,
  projected_at timestamptz,
  ingested_by text not null,
  ingested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table internal.wecom_archive_media (
  id uuid primary key default extensions.gen_random_uuid(),
  message_id text not null references internal.wecom_archive_messages(message_id),
  media_key text,
  file_name text,
  content_type text,
  byte_size integer,
  content_sha256 text,
  content bytea,
  student_id text,
  projected_file_id text,
  created_at timestamptz default now()
);

create function internal.wecom_name_key(p_value text)
returns text
language sql
immutable
strict
as $$ select lower(regexp_replace(btrim(p_value), '[[:space:]]+', '', 'g')) $$;

-- These stub definitions intentionally carry the exact pre-migration
-- fragments. The migration's guarded replacement must find and compile both
-- contracts before the real identity-trigger paths are exercised below.
create function public.ingest_wecom_bot_batch(p_secret text, p_records jsonb, p_started_at timestamptz, p_actor text)
returns jsonb
language plpgsql
as $$
begin
/*
  canonical_guardian_hint text;
  auto_result jsonb;
         - 'classification' - 'studentNameHint' - 'guardianWechatHint' <> '{}'::jsonb
       or (source ? 'guardianWechatHint' and source -> 'guardianWechatHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'guardianWechatHint') <> 'string')
       or pg_catalog.length(coalesce(source ->> 'text', '')) > 12000
       or pg_catalog.length(coalesce(source ->> 'studentNameHint', '')) > 240
       or pg_catalog.length(coalesce(source ->> 'guardianWechatHint', '')) > 240 then
    canonical_guardian_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    if message_type <> 'text' and (
      canonical_classification <> 'other'
      or canonical_student_hint is not null
      or canonical_guardian_hint is not null
    ) then
      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint
    ));
         and existing.student_name_hint is null
         and existing.guardian_wechat_hint is null
         and existing.message_type = message_type
            student_name_hint = canonical_student_hint,
            guardian_wechat_hint = canonical_guardian_hint,
            updated_at = pg_catalog.now()
      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by
      canonical_classification, canonical_student_hint, canonical_guardian_hint,
      null, 'pending', canonical_actor
*/
  return '{}'::jsonb;
end;
$$;

create function public.ingest_wecom_archive_batch(p_secret text, p_records jsonb, p_started_at timestamptz, p_actor text)
returns jsonb
language plpgsql
as $$
begin
/*
  canonical_guardian_hint text;
  canonical_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'WeCom Archive Worker'), 120);
         - 'text' - 'classification' - 'studentNameHint' - 'guardianWechatHint' - 'media' <> '{}'::jsonb
       or source ->> 'classification' not in ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')
       or jsonb_typeof(source -> 'media') <> 'array'
    canonical_guardian_hint := nullif(btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    if length(coalesce(canonical_body, '')) > 12000
       or length(coalesce(canonical_student_hint, '')) > 240
       or length(coalesce(canonical_guardian_hint, '')) > 240 then
      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint,
      'media', canonical_media_items
      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by
      source ->> 'classification', canonical_student_hint, canonical_guardian_hint,
      linked_student_id, match_status, canonical_actor
*/
  return '{}'::jsonb;
end;
$$;

\ir ../../supabase/migrations/20260915000300_wecom_trial_handover_identity.sql

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:trial-identity-initial', repeat('a', 64), 'fixture-room', 'fixture-sales', now(), 'text',
  '[Rose]试听LP 信息交接[Rose]' || E'\n' || '【微信名】：Parent Fixture' || E'\n' || '【教务】：Thea' || E'\n' || '【课程规划老师】：Elaine',
  'handover', null, 'Parent Fixture', null, 'pending', 'WeCom Bot Receiver'
);

do $$
declare handover_case internal.wecom_trial_handover_cases%rowtype;
begin
  select * into handover_case from internal.wecom_trial_handover_cases;
  if handover_case.status <> 'awaiting_student_name'
     or handover_case.operations_owner <> 'Thea'
     or handover_case.course_planner <> 'Elaine' then
    raise exception 'initial_trial_identity_case_not_recorded';
  end if;
  if not exists (
    select 1 from internal.wecom_archive_messages
    where message_id = 'bot:trial-identity-initial'
      and trial_handover_id = handover_case.id
      and student_id is null
  ) then
    raise exception 'initial_trial_message_not_attached';
  end if;
end;
$$;

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:trial-identity-name', repeat('b', 64), 'fixture-room', 'fixture-sales', now(), 'text',
  '【微信名】：Parent Fixture' || E'\n' || '【学生姓名】：Mia Fixture米娅',
  'handover', 'Mia Fixture米娅', 'Parent Fixture', null, 'pending', 'WeCom Bot Receiver'
);

do $$
declare handover_case internal.wecom_trial_handover_cases%rowtype;
declare inbox_row record;
begin
  select * into handover_case from internal.wecom_trial_handover_cases;
  if handover_case.status <> 'identified' or handover_case.student_name <> 'Mia Fixture米娅' then
    raise exception 'trial_identity_name_not_confirmed';
  end if;
  if (select count(*) from internal.wecom_archive_messages where trial_handover_id = handover_case.id) <> 2 then
    raise exception 'trial_identity_messages_not_grouped';
  end if;
  select * into inbox_row from public.read_wecom_archive_inbox('wecom-fixture-secret', 10)
  where message_id = 'bot:trial-identity-name';
  if inbox_row.trial_identity_status <> 'identified'
     or inbox_row.trial_identity_student_name <> 'Mia Fixture米娅' then
    raise exception 'trial_identity_not_exposed_to_admin_inbox';
  end if;
  if exists (select 1 from public.ops_state) then
    raise exception 'trial_identity_created_business_state';
  end if;
end;
$$;

insert into internal.wecom_archive_messages (
  message_id, content_sha256, chat_id, sender_id, sent_at, message_type, body,
  classification, student_name_hint, guardian_wechat_hint, student_id, match_status, ingested_by
) values (
  'bot:trial-identity-conflict', repeat('c', 64), 'fixture-room', 'fixture-sales', now(), 'text',
  '【微信名】：Parent Fixture' || E'\n' || '【学生姓名】：Different Student',
  'handover', 'Different Student', 'Parent Fixture', null, 'pending', 'WeCom Bot Receiver'
);

do $$
begin
  if not exists (
    select 1 from internal.wecom_trial_handover_cases where status = 'identity_conflict'
  ) then
    raise exception 'trial_identity_conflict_not_held';
  end if;
end;
$$;

select 'wecom_trial_handover_identity_runtime_ok' as result;

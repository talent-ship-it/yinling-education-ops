\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

begin;

-- Disposable local PostgreSQL fixture only.  Run against a fresh local
-- database; the final rollback leaves no state behind and no production
-- connection or secret is used.
do $roles$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$roles$;

drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_state cascade;
create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);
create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable set search_path = ''
as $$ select p_secret = 'renewal-create-if-missing-fixture-secret' $$;
create function internal.append_operational_contract_audit(
  p_action text, p_actor text, p_target_type text, p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql set search_path = '' as $$
declare saved_id uuid;
begin
  insert into internal.operational_contract_audit(action, actor, target_type, target_id, metadata)
  values (p_action, p_actor, p_target_type, p_target_id, p_metadata)
  returning id into saved_id;
  return saved_id;
end;
$$;
create table internal.student_fu_attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  student_id text not null,
  file_name text not null,
  content_type text not null,
  byte_size integer not null,
  content bytea not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);

\ir ../../supabase/migrations/20260824000400_renewal_follow_up_atomic.sql
\ir ../../supabase/migrations/20260824000600_renewal_follow_up_create_if_missing_atomic.sql

insert into public.ops_state(entity, payload, version, updated_by) values
  ('files', '[]', 1, 'fixture'),
  ('renewals', '[]', 1, 'fixture'),
  ('students', '[
    {"id":"STU-1","name":"Fixture Student","owner":"Abby","status":"在读",
     "lessonPackages":[{"id":"PKG-1","name":"English 20h","subjectIds":["English"],
       "purchaseRecords":[{"id":"BUY-1","purchasedAt":"2026-01-01T00:00:00.000Z","hours":20}],
       "consumedHours":18}],"followUpHistory":[]}
  ]', 1, 'fixture'),
  ('tasks', '[
    {"id":"TASK-1","studentId":"STU-1","owner":"Abby","assignees":["Abby"],
     "watchers":["Ops Admin"],"ruleKey":"renewal.package-depletion",
     "anchorBookingId":"renewal:STU-1:PKG-1","status":"upcoming","tone":"amber",
     "category":"续课","title":"Fixture renewal"}
  ]', 1, 'fixture');

do $runtime$
declare
  intent jsonb := jsonb_build_object(
    'renewalId','REN-AUTO:renewal:STU-1:PKG-1',
    'studentId','STU-1', 'packageId','PKG-1',
    'businessStatus','renewed', 'result','已跟进',
    'attemptedAt','2026-08-24T01:02:03.000Z',
    'note','已联系家长', 'renewalDateNote','',
    'hasAttachment',false
  );
  receipt record;
  replay record;
  caught_state text;
  before_renewals bigint;
begin
  select * into receipt from public.put_renewal_follow_up_create_if_missing_atomic(
    'renewal-create-if-missing-fixture-secret',
    'renewal-follow-up:123e4567-e89b-42d3-a456-426614174000',
    intent, 'REN-AUTO:renewal:STU-1:PKG-1', 'STU-1', 'PKG-1',
    'renewed', '已跟进', '2026-08-24T01:02:03.000Z',
    '已联系家长', '', null, null, null, null, null,
    '{"files":1,"renewals":1,"students":1,"tasks":1}', 'Ops Admin'
  );
  if not receipt.applied
     or (receipt.renewals_row).version <> 3
     or (receipt.students_row).version <> 2
     or (receipt.tasks_row).version <> 2
     or (select (value ->> 'owner') from jsonb_array_elements((receipt.renewals_row).payload) value
         where value ->> 'id' = 'REN-AUTO:renewal:STU-1:PKG-1') <> 'Abby'
     or (select (value ->> 'packageName') from jsonb_array_elements((receipt.renewals_row).payload) value
         where value ->> 'id' = 'REN-AUTO:renewal:STU-1:PKG-1') <> 'English 20h'
     or (select (value ->> 'remaining')::numeric from jsonb_array_elements((receipt.renewals_row).payload) value
         where value ->> 'id' = 'REN-AUTO:renewal:STU-1:PKG-1') <> 2
     or not exists (select 1 from jsonb_array_elements((receipt.students_row).payload) value
         where value ->> 'id' = 'STU-1' and jsonb_array_length(value -> 'followUpHistory') = 1)
     or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) value
         where value ->> 'id' = 'TASK-1' and value ->> 'status' = 'done') then
    raise exception 'renewal_create_if_missing_first_commit_failed';
  end if;

  select * into replay from public.put_renewal_follow_up_create_if_missing_atomic(
    'renewal-create-if-missing-fixture-secret',
    'renewal-follow-up:123e4567-e89b-42d3-a456-426614174000',
    intent, 'REN-AUTO:renewal:STU-1:PKG-1', 'STU-1', 'PKG-1',
    'renewed', '已跟进', '2026-08-24T01:02:03.000Z',
    '已联系家长', '', null, null, null, null, null,
    '{"files":1,"renewals":1,"students":1,"tasks":1}', 'Ops Admin'
  );
  if replay.applied or (replay.renewals_row).version <> 3
     or (select count(*) from jsonb_array_elements((replay.students_row).payload) value
         where value ->> 'id' = 'STU-1' and jsonb_array_length(value -> 'followUpHistory') = 1) <> 1 then
    raise exception 'renewal_create_if_missing_replay_failed';
  end if;

  select version into before_renewals from public.ops_state where entity = 'renewals';
  begin
    perform * from public.put_renewal_follow_up_create_if_missing_atomic(
      'renewal-create-if-missing-fixture-secret',
      'renewal-follow-up:123e4567-e89b-42d3-a456-426614174001',
      intent || jsonb_build_object('owner','forged'),
      'REN-AUTO:renewal:STU-1:PKG-1', 'STU-1', 'PKG-1',
      'renewed', '已跟进', '2026-08-24T01:02:03.000Z',
      '已联系家长', '', null, null, null, null, null,
      '{"files":1,"renewals":3,"students":2,"tasks":2}', 'Ops Admin'
    );
    raise exception 'renewal_create_if_missing_forged_intent_accepted';
  exception when sqlstate '22023' then
    get stacked diagnostics caught_state = returned_sqlstate;
    if caught_state <> '22023' then raise; end if;
  end;
  if (select version from public.ops_state where entity = 'renewals') <> before_renewals then
    raise exception 'renewal_create_if_missing_forged_intent_mutated_state';
  end if;

  update public.ops_state set payload = jsonb_set(payload, '{0,status}', '"不活跃 + 有课时"')
  where entity = 'students';
  begin
    perform * from public.put_renewal_follow_up_create_if_missing_atomic(
      'renewal-create-if-missing-fixture-secret',
      'renewal-follow-up:123e4567-e89b-42d3-a456-426614174002', intent,
      'REN-AUTO:renewal:STU-1:PKG-1', 'STU-1', 'PKG-1', 'renewed', '已跟进',
      '2026-08-24T01:02:03.000Z', '已联系家长', '', null, null, null, null, null,
      '{"files":1,"renewals":3,"students":2,"tasks":2}', 'Ops Admin'
    );
    raise exception 'renewal_create_if_missing_inactive_accepted';
  exception when sqlstate '42501' then null;
  end;
end;
$runtime$;
rollback;

\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
create schema internal;
create schema storage;
do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table public.ops_state(entity text primary key, payload jsonb not null, version bigint not null default 1, updated_at timestamptz not null default now(), updated_by text not null default 'fixture');
create table internal.operational_contract_audit(id uuid primary key default gen_random_uuid(), action text, actor text, target_type text, target_id text, metadata jsonb);
create function internal.verify_ops_secret(p_secret text) returns boolean language sql immutable as $$ select p_secret = 'materials-fixture-secret' $$;
create function internal.append_operational_contract_audit(p_action text, p_actor text, p_target_type text, p_target_id text, p_metadata jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$ declare saved uuid; begin
  insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata) values(p_action,p_actor,p_target_type,p_target_id,p_metadata) returning id into saved;
  return saved;
end $$;
create table if not exists internal.app_accounts (
  account_id uuid primary key default gen_random_uuid(),
  identity_key text not null unique check (identity_key ~ '^[a-f0-9]{64}$'),
  account_name text not null check (length(trim(account_name)) between 1 and 160),
  account_role text not null check (account_role in ('admin', 'limited-admin', 'staff', 'teacher')),
  status text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  super_admin boolean not null default false,
  access_version bigint not null default 1 check (access_version > 0),
  role_version bigint not null default 1 check (role_version > 0),
  scope_version bigint not null default 1 check (scope_version > 0),
  legacy_session_allowed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null check (length(trim(created_by)) between 1 and 160),
  updated_by text not null check (length(trim(updated_by)) between 1 and 160),
  check (not super_admin or (account_role = 'admin' and lower(trim(account_name)) = 'nixon'))
);

create unique index if not exists app_accounts_normalized_name_role_key
  on internal.app_accounts (lower(trim(account_name)), account_role);
create unique index if not exists app_accounts_single_super_admin_key
  on internal.app_accounts (super_admin) where super_admin;

create table if not exists internal.app_account_permission_overrides (
  account_id uuid not null references internal.app_accounts(account_id) on delete restrict,
  permission text not null check (permission ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  updated_by text not null check (length(trim(updated_by)) between 1 and 160),
  primary key (account_id, permission)
);

create table if not exists internal.app_account_scope_members (
  account_id uuid not null references internal.app_accounts(account_id) on delete restrict,
  scope_kind text not null check (scope_kind in ('student', 'teacher', 'entity')),
  scope_key text not null check (length(trim(scope_key)) between 1 and 240),
  updated_at timestamptz not null default now(),
  updated_by text not null check (length(trim(updated_by)) between 1 and 160),
  primary key (account_id, scope_kind, scope_key)
);
